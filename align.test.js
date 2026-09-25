'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const align = require('./align.js');
const gear = require('./gear.js');

const ICON_W = 36, ICON_H = 32;

const ICONS = fs.readdirSync(path.join(__dirname, 'test', 'fixtures', 'icons'))
	.filter((f) => f.endsWith('.png'))
	.map((f) => PNG.sync.read(fs.readFileSync(path.join(__dirname, 'test', 'fixtures', 'icons', f))).data);

function rng(seed) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/*
 * A stand-in for the 3D world behind the panel: large smooth shapes with a
 * little grain. Deliberately NOT periodic at a small pitch - a backdrop built
 * from fixed-size blocks is itself a grid, and detection would rightly lock on
 * to it instead.
 */
function paintBackdrop(data, width, height, random) {
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const wave =
				Math.sin(x / 130 + y / 190) * 26 +
				Math.sin(x / 57 - y / 240) * 16 +
				Math.sin((x + y) / 310) * 20;
			const base = 78 + wave;
			const i = (y * width + x) * 4;
			data[i] = Math.max(0, Math.min(255, base + random() * 7));
			data[i + 1] = Math.max(0, Math.min(255, base * 0.92 + random() * 7));
			data[i + 2] = Math.max(0, Math.min(255, base * 0.8 + random() * 7));
			data[i + 3] = 255;
		}
	}
}

/*
 * Builds a screenshot-like image: a busy background with a grid of item icons
 * drawn onto it, so detection has to find the grid rather than the busiest part.
 */
function screenshot({ width, height, box, columns, rows, iconScale = 0.84, seed = 4, skip = [] }) {
	const random = rng(seed);
	const data = Buffer.alloc(width * height * 4);

	paintBackdrop(data, width, height, random);

	const pitchX = box.w / columns, pitchY = box.h / rows;
	let n = 0;
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < columns; c++) {
			const index = r * columns + c;
			if (skip.includes(index)) { n++; continue; }
			const icon = ICONS[n++ % ICONS.length];
			const dw = pitchX * iconScale, dh = pitchY * iconScale;
			const ox = box.x + c * pitchX + (pitchX - dw) / 2;
			const oy = box.y + r * pitchY + (pitchY - dh) / 2;

			for (let y = 0; y < Math.round(dh); y++) {
				for (let x = 0; x < Math.round(dw); x++) {
					const sx = Math.min(ICON_W - 1, Math.floor(x * ICON_W / dw));
					const sy = Math.min(ICON_H - 1, Math.floor(y * ICON_H / dh));
					const si = (sy * ICON_W + sx) * 4;
					const px = Math.round(ox + x), py = Math.round(oy + y);
					if (px < 0 || py < 0 || px >= width || py >= height) { continue; }
					const di = (py * width + px) * 4;
					const a = icon[si + 3] / 255;
					for (let ch = 0; ch < 3; ch++) {
						data[di + ch] = icon[si + ch] * a + data[di + ch] * (1 - a);
					}
				}
			}
		}
	}
	return { data, width, height };
}

function closeTo(actual, expected, tolerance, what) {
	assert.ok(Math.abs(actual - expected) <= tolerance,
		`${what}: got ${actual.toFixed(1)}, expected ${expected} (±${tolerance})`);
}

test('detectGrid finds a 4x7 grid with no hint', () => {
	const box = { x: 420, y: 90, w: 360, h: 574 };
	const shot = screenshot({ width: 900, height: 720, box, columns: 4, rows: 7 });
	const found = align.detectGrid(shot.data, shot.width, shot.height, 4, 7);

	assert.ok(found, 'detectGrid returned nothing');
	closeTo(found.x, box.x, 8, 'x');
	closeTo(found.y, box.y, 8, 'y');
	closeTo(found.w / 4, box.w / 4, 3, 'column pitch');
	closeTo(found.h / 7, box.h / 7, 3, 'row pitch');
});

test('detectGrid finds the grid wherever it sits', () => {
	const box = { x: 40, y: 300, w: 320, h: 511 };
	const shot = screenshot({ width: 900, height: 900, box, columns: 4, rows: 7, seed: 9 });
	const found = align.detectGrid(shot.data, shot.width, shot.height, 4, 7);

	assert.ok(found);
	closeTo(found.x, box.x, 10, 'x');
	closeTo(found.y, box.y, 10, 'y');
});

test('detectGrid tolerates empty slots', () => {
	const box = { x: 300, y: 120, w: 360, h: 574 };
	const shot = screenshot({ width: 800, height: 760, box, columns: 4, rows: 7, skip: [20, 21, 25, 26, 27] });
	const found = align.detectGrid(shot.data, shot.width, shot.height, 4, 7);

	assert.ok(found);
	closeTo(found.x, box.x, 10, 'x');
	closeTo(found.y, box.y, 12, 'y');
});

test('refineGrid corrects a box that is off by a few pixels', () => {
	const box = { x: 420, y: 90, w: 360, h: 574 };
	const shot = screenshot({ width: 900, height: 720, box, columns: 4, rows: 7 });
	const nudged = { x: box.x + 9, y: box.y - 7, w: box.w - 11, h: box.h + 9 };
	const fixed = align.refineGrid(shot.data, shot.width, shot.height, nudged, 4, 7);

	assert.ok(Math.abs(fixed.x - box.x) < Math.abs(nudged.x - box.x), 'x should improve');
	assert.ok(Math.abs(fixed.y - box.y) < Math.abs(nudged.y - box.y), 'y should improve');
});

test('refineGrid never slips a whole cell', () => {
	// The gradient profile is periodic, so an unanchored search happily lands a
	// row out. The offset must stay within half a cell of the box it was given.
	const box = { x: 420, y: 90, w: 360, h: 574 };
	const shot = screenshot({ width: 900, height: 720, box, columns: 4, rows: 7 });
	const pitchY = box.h / 7;
	const fixed = align.refineGrid(shot.data, shot.width, shot.height, box, 4, 7);

	assert.ok(Math.abs(fixed.y - box.y) < pitchY * 0.6,
		`moved ${(fixed.y - box.y).toFixed(1)}px against a ${pitchY.toFixed(1)}px pitch`);
});

test('detectSlotBox finds the equipment panel, holes and all', () => {
	// Draw the real equipment arrangement: eleven slots filled, four holes empty.
	const box = { x: 500, y: 150, w: 347, h: 463 };
	const width = 1000, height = 760;
	const random = rng(3);
	const data = Buffer.alloc(width * height * 4);
	paintBackdrop(data, width, height, random);
	gear.EQUIPMENT_SLOTS.forEach((slot, n) => {
		const rect = gear.equipmentSlotRect(box, slot);
		const icon = ICONS[n % ICONS.length];
		for (let y = 0; y < Math.round(rect.h); y++) {
			for (let x = 0; x < Math.round(rect.w); x++) {
				const sx = Math.min(ICON_W - 1, Math.floor(x * ICON_W / rect.w));
				const sy = Math.min(ICON_H - 1, Math.floor(y * ICON_H / rect.h));
				const si = (sy * ICON_W + sx) * 4;
				const px = Math.round(rect.x + x), py = Math.round(rect.y + y);
				if (px < 0 || py < 0 || px >= width || py >= height) { continue; }
				const di = (py * width + px) * 4;
				const a = icon[si + 3] / 255;
				for (let ch = 0; ch < 3; ch++) {
					data[di + ch] = icon[si + ch] * a + data[di + ch] * (1 - a);
				}
			}
		}
	});

	const probes = (b) => ({
		slots: gear.EQUIPMENT_SLOTS.map((s) => gear.equipmentSlotRect(b, s)),
		gaps: gear.EQUIPMENT_GAPS.map((g) => gear.equipmentSlotRect(b, g))
	});
	const found = align.detectSlotBox(data, width, height, probes, 347 / 463, null);

	assert.ok(found, 'detectSlotBox returned nothing');
	closeTo(found.x, box.x, 20, 'x');
	closeTo(found.y, box.y, 20, 'y');
	closeTo(found.w, box.w, 30, 'width');
});

test('the equipment holes sit where nothing is ever drawn', () => {
	const box = { x: 0, y: 0, w: 347, h: 463 };
	const slots = gear.EQUIPMENT_SLOTS.map((s) => gear.equipmentSlotRect(box, s));
	for (const gap of gear.EQUIPMENT_GAPS) {
		const g = gear.equipmentSlotRect(box, gap);
		for (const s of slots) {
			const overlap = g.x < s.x + s.w && s.x < g.x + g.w && g.y < s.y + s.h && s.y < g.y + g.h;
			assert.ok(!overlap, `${gap.key} overlaps a real slot`);
		}
	}
	assert.strictEqual(gear.EQUIPMENT_GAPS.length, 4);
});
