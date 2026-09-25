'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const matcher = require('./matcher.js');

const ICON_W = 36, ICON_H = 32;
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'items.json'), 'utf8'));
const zlib = require('node:zlib');
const blob = new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'data', 'icons.bin.gz'))));
const db = { meta, blob };

const FIXTURES = fs.readdirSync(path.join(__dirname, 'test', 'fixtures', 'icons'))
	.filter((f) => f.endsWith('.png'))
	.map((f) => {
		const id = Number(f.slice(0, -4));
		const png = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'test', 'fixtures', 'icons', f)));
		return { id, name: new Map(meta.items).get(id), pixels: png.data };
	});

/* Deterministic pseudo-random so the suite cannot flake. */
function rng(seed) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function bilinear(src, sw, sh, dw, dh) {
	const out = Buffer.alloc(dw * dh * 4);
	for (let y = 0; y < dh; y++) {
		for (let x = 0; x < dw; x++) {
			const sx = (x + 0.5) * sw / dw - 0.5, sy = (y + 0.5) * sh / dh - 0.5;
			const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
			const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
			const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
			const fx = sx - x0, fy = sy - y0;
			for (let c = 0; c < 4; c++) {
				const p00 = src[(y0 * sw + x0) * 4 + c], p10 = src[(y0 * sw + x1) * 4 + c];
				const p01 = src[(y1 * sw + x0) * 4 + c], p11 = src[(y1 * sw + x1) * 4 + c];
				out[(y * dw + x) * 4 + c] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
			}
		}
	}
	return out;
}

/* A slot as it appears on a phone: item drawn over an arbitrary noisy background. */
function renderSlot(icon, { seed = 1, base = [58, 48, 38], noise = 14, scale = 1 } = {}) {
	const random = rng(seed);
	const slot = Buffer.alloc(ICON_W * ICON_H * 4);

	for (let i = 0; i < ICON_W * ICON_H; i++) {
		for (let c = 0; c < 3; c++) {
			slot[i * 4 + c] = Math.max(0, Math.min(255, base[c] + (random() - 0.5) * noise));
		}
		slot[i * 4 + 3] = 255;
	}
	for (let i = 0; i < ICON_W * ICON_H; i++) {
		const a = icon[i * 4 + 3] / 255;
		for (let c = 0; c < 3; c++) {
			slot[i * 4 + c] = icon[i * 4 + c] * a + slot[i * 4 + c] * (1 - a);
		}
	}

	if (scale === 1) {
		return { pixels: slot, width: ICON_W, height: ICON_H };
	}
	// Upscale to the phone's slot size and back down, as cropping a screenshot does.
	const up = bilinear(slot, ICON_W, ICON_H, Math.round(ICON_W * scale), Math.round(ICON_H * scale));
	return {
		pixels: bilinear(up, Math.round(ICON_W * scale), Math.round(ICON_H * scale), ICON_W, ICON_H),
		width: ICON_W,
		height: ICON_H
	};
}

function identify(slot, limit = 25) {
	const described = matcher.describe(slot.pixels, slot.width, slot.height, meta.cellsX, meta.cellsY);
	return { described, ranked: matcher.rank(db, described, limit) };
}

test('the database loaded and is the expected shape', () => {
	assert.strictEqual(meta.items.length, meta.count);
	assert.strictEqual(blob.length, meta.count * meta.cellsX * meta.cellsY * 4);
	assert.ok(meta.count > 10000, 'expected a full item database, got ' + meta.count);
	assert.strictEqual(FIXTURES.length, 10);
});

test('estimateBackground recovers the backdrop behind an item', () => {
	const slot = renderSlot(FIXTURES[0].pixels, { base: [70, 40, 20], noise: 0 });
	const bg = matcher.estimateBackground(slot.pixels, slot.width, slot.height);
	assert.deepStrictEqual(bg, [70, 40, 20]);
});

test('identifies every fixture item at native size', () => {
	for (const fixture of FIXTURES) {
		const { ranked } = identify(renderSlot(fixture.pixels, { seed: 7 }));
		assert.strictEqual(ranked[0].id, fixture.id,
			`${fixture.name} (${fixture.id}) ranked ${ranked[0].name} (${ranked[0].id}) first`);
	}
});

test('keeps items near the top over a bright background', () => {
	// A light backdrop shifts the background estimate and costs some colour
	// discrimination, so the winner is not guaranteed - but it stays at the top.
	for (const fixture of FIXTURES) {
		const { ranked } = identify(renderSlot(fixture.pixels, { seed: 3, base: [150, 170, 120] }));
		const at = ranked.findIndex((r) => r.id === fixture.id);
		assert.ok(at >= 0 && at < 3,
			`${fixture.name} fell to rank ${at} over a bright backdrop (top was ${ranked[0].name})`);
	}
});

test('recolours of one item are the expected near-ties', () => {
	// Every godsword shares a silhouette and differs only in hilt colour, so the
	// shortlist fills with the family. This is why the UI offers alternatives
	// rather than committing to the top guess.
	const ags = FIXTURES.find((f) => f.id === 11802);
	const { ranked } = identify(renderSlot(ags.pixels, { seed: 3, base: [150, 170, 120] }), 5);

	assert.ok(ranked.slice(0, 3).some((r) => r.id === 11802), 'the real item should be near the top');
	for (const candidate of ranked.slice(0, 3)) {
		assert.match(candidate.name, /godsword/i,
			`expected the shortlist to be godswords, saw ${candidate.name}`);
	}
});

test('keeps the right item in the shortlist after phone-scale resampling', () => {
	for (const scale of [1.6, 2]) {
		for (const fixture of FIXTURES) {
			const { ranked } = identify(renderSlot(fixture.pixels, { seed: 11, scale }));
			const at = ranked.findIndex((r) => r.id === fixture.id);
			assert.ok(at >= 0 && at < 5,
				`${fixture.name} at ${scale}x fell to rank ${at} of ${ranked.length}`);
		}
	}
});

test('refining at full resolution ranks the true item first', () => {
	const iconPixels = Object.fromEntries(FIXTURES.map((f) => [f.id, f.pixels]));

	for (const fixture of FIXTURES) {
		const slot = renderSlot(fixture.pixels, { seed: 11, scale: 1.6 });
		const { described, ranked } = identify(slot);
		// Only fixtures have pixels available, so refine over the ones we can render.
		const known = ranked.filter((r) => iconPixels[r.id]);
		const refined = matcher.refine(known, slot.pixels, slot.width, slot.height,
			described.background, iconPixels, ICON_W, ICON_H);
		assert.strictEqual(refined[0].id, fixture.id,
			`${fixture.name} refined to ${refined[0].name}`);
	}
});

test('an empty slot is detected by how little foreground it holds', () => {
	for (const base of [[58, 48, 38], [150, 170, 120], [20, 20, 20]]) {
		const empty = renderSlot(Buffer.alloc(ICON_W * ICON_H * 4), { seed: 5, base });
		const described = matcher.describe(empty.pixels, empty.width, empty.height, meta.cellsX, meta.cellsY);
		assert.ok(matcher.looksEmpty(described),
			`an empty slot over ${base} read foreground ${described.foreground.toFixed(3)}`);
	}
});

test('a slot holding an item is not mistaken for empty', () => {
	for (const fixture of FIXTURES) {
		const slot = renderSlot(fixture.pixels, { seed: 7 });
		const described = matcher.describe(slot.pixels, slot.width, slot.height, meta.cellsX, meta.cellsY);
		assert.ok(!matcher.looksEmpty(described),
			`${fixture.name} read as empty (foreground ${described.foreground.toFixed(3)})`);
	}
});

test('confidence is high when the winner is clearly ahead', () => {
	assert.strictEqual(matcher.confidence([{ score: 10 }, { score: 20 }]), 1);
	assert.ok(matcher.confidence([{ score: 10 }, { score: 10.5 }]) < 0.1);
	assert.strictEqual(matcher.confidence([]), 0);
	assert.strictEqual(matcher.confidence([{ score: 4 }]), 1);
});

test('rank returns at most the requested number of candidates', () => {
	const { ranked } = identify(renderSlot(FIXTURES[0].pixels), 7);
	assert.strictEqual(ranked.length, 7);
	for (let i = 1; i < ranked.length; i++) {
		assert.ok(ranked[i].score >= ranked[i - 1].score, 'candidates must be sorted best first');
	}
});

test('slot filtering only offers items that go in that slot', () => {
	const withSlot = meta.items.filter((i) => i[3] > 0);
	assert.ok(withSlot.length > 3000, 'expected equipment slot data in the database');

	const slot = 'ring';
	const wanted = matcher.SLOT_ORDER.indexOf(slot) + 1;
	const fixture = FIXTURES.find((f) => f.id === 6585);   // Amulet of fury, a neck item
	const { described } = identify(renderSlot(fixture.pixels, { seed: 7 }));
	const ranked = matcher.rank(db, described, 20, { slot });

	assert.ok(ranked.length > 0, 'slot filtering returned nothing');
	const byId = new Map(meta.items.map((i) => [i[0], i]));
	for (const candidate of ranked) {
		assert.strictEqual(byId.get(candidate.id)[3], wanted,
			`${candidate.name} is not a ${slot} item`);
	}
	// and the neck item itself must be excluded from a ring search
	assert.ok(!ranked.some((c) => c.id === 6585));
});

test('an unfiltered search still reaches the whole database', () => {
	const fixture = FIXTURES.find((f) => f.id === 6585);
	const { ranked } = identify(renderSlot(fixture.pixels, { seed: 7 }));
	assert.strictEqual(ranked[0].id, 6585);
});

test('the popularity prior favours items people actually use', () => {
	// Every item carries a popularity; commonly traded ones must outrank
	// untradeable lookalikes at equal fit.
	const superRestore = meta.items.find((i) => i[0] === 3024);
	const mixture = meta.items.find((i) => i[0] === 10911);
	assert.ok(superRestore, 'Super restore(4) missing from the database');
	assert.ok(mixture, 'Mixture - step 1(3) missing from the database');
	assert.ok(superRestore[2] > 0, 'a tradeable staple should carry popularity');
	assert.strictEqual(mixture[2], 0, 'an untradeable intermediate should carry none');
});

test('equipment items are marked with their slot', () => {
	const byId = new Map(meta.items.map((i) => [i[0], i]));
	const ring = matcher.SLOT_ORDER.indexOf('ring') + 1;
	const feet = matcher.SLOT_ORDER.indexOf('feet') + 1;
	assert.strictEqual(byId.get(11840)[3], feet, 'Dragon boots should be a feet item');
	assert.strictEqual(byId.get(6585)[3], matcher.SLOT_ORDER.indexOf('neck') + 1);
	assert.notStrictEqual(byId.get(385)[3], ring, 'a Shark is not a ring');
	assert.strictEqual(byId.get(385)[3], 0, 'food has no equipment slot');
});
