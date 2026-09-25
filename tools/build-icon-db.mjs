/*
 * Builds the item signature database used by the screenshot reader.
 *
 * Usage:
 *   node tools/fetch-icons.mjs      # downloads ~21k item icons into tools/icons/
 *   node tools/build-icon-db.mjs    # writes data/items.json + data/icons.bin
 *
 * Each icon is 36x32 RGBA. A signature is a CELLS_X by CELLS_Y grid where every
 * cell holds the alpha-weighted mean colour plus the mean alpha (the shape). The
 * alpha channel is what makes matching work at all: an item is drawn over
 * whatever happens to be behind it, so only the opaque pixels are comparable,
 * and the shape is what stops a mostly-transparent icon matching everything.
 *
 * 7x6 was picked by measuring: it keeps ~99% recall in the top 25 candidates
 * while staying small enough to ship. Finer grids overfit to resampling noise
 * and actually score worse.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { PNG } from 'pngjs';

const ICON_W = 36, ICON_H = 32;
const CELLS_X = 7, CELLS_Y = 6;
const BYTES_PER_ICON = CELLS_X * CELLS_Y * 4;
const MIN_OPAQUE_PIXELS = 40;   // below this an icon is a placeholder, not an item

const root = path.resolve(import.meta.dirname, '..');
const iconDir = path.join(import.meta.dirname, 'icons');
const namesFile = path.join(import.meta.dirname, 'names.json');

if (!fs.existsSync(iconDir)) {
	console.error('Missing ' + iconDir + ' - run tools/fetch-icons.mjs first.');
	process.exit(1);
}

const names = JSON.parse(fs.readFileSync(namesFile, 'utf8'));

export function signature(rgba, width, height) {
	const sig = new Uint8Array(CELLS_X * CELLS_Y * 4);
	const cellW = width / CELLS_X, cellH = height / CELLS_Y;

	for (let cy = 0; cy < CELLS_Y; cy++) {
		for (let cx = 0; cx < CELLS_X; cx++) {
			let r = 0, g = 0, b = 0, alpha = 0, count = 0;
			const x0 = Math.floor(cx * cellW), x1 = Math.floor((cx + 1) * cellW);
			const y0 = Math.floor(cy * cellH), y1 = Math.floor((cy + 1) * cellH);

			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const i = (y * width + x) * 4;
					const a = rgba[i + 3] / 255;
					r += rgba[i] * a; g += rgba[i + 1] * a; b += rgba[i + 2] * a;
					alpha += a; count++;
				}
			}

			const k = (cy * CELLS_X + cx) * 4;
			const weight = Math.max(alpha, 1e-6);
			sig[k] = Math.round(r / weight);
			sig[k + 1] = Math.round(g / weight);
			sig[k + 2] = Math.round(b / weight);
			sig[k + 3] = Math.round(255 * alpha / Math.max(count, 1));
		}
	}
	return sig;
}

const byPixels = new Map();     // identical icons collapse onto their lowest id
let skippedEmpty = 0;

for (const file of fs.readdirSync(iconDir)) {
	if (!file.endsWith('.png')) continue;
	const id = Number(file.slice(0, -4));
	if (!Number.isInteger(id) || !names[id]) continue;

	const png = PNG.sync.read(fs.readFileSync(path.join(iconDir, file)));
	if (png.width !== ICON_W || png.height !== ICON_H) continue;

	let opaque = 0;
	for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 8) opaque++;
	if (opaque < MIN_OPAQUE_PIXELS) { skippedEmpty++; continue; }

	const hash = crypto.createHash('sha1').update(png.data).digest('hex');
	const existing = byPixels.get(hash);
	if (existing) {
		existing.ids.push(id);
		if (id < existing.id) existing.id = id;
	} else {
		byPixels.set(hash, { id, ids: [id], data: png.data });
	}
}

const entries = [...byPixels.values()].sort((a, b) => a.id - b.id);
const items = [];
const blob = Buffer.alloc(entries.length * BYTES_PER_ICON);

entries.forEach((entry, index) => {
	blob.set(signature(entry.data, ICON_W, ICON_H), index * BYTES_PER_ICON);
	items.push([entry.id, names[entry.id]]);
});

const meta = { cellsX: CELLS_X, cellsY: CELLS_Y, iconW: ICON_W, iconH: ICON_H, count: items.length, items };
fs.writeFileSync(path.join(root, 'data', 'items.json'), JSON.stringify(meta));
fs.writeFileSync(path.join(root, 'data', 'icons.bin'), blob);

const gz = zlib.gzipSync(blob).length, br = zlib.brotliCompressSync(blob).length;
console.log(`icons kept:      ${items.length} (skipped ${skippedEmpty} near-empty)`);
console.log(`icons.bin:       ${(blob.length / 1e6).toFixed(2)} MB raw, ${(gz / 1e6).toFixed(2)} MB gzip, ${(br / 1e6).toFixed(2)} MB brotli`);
console.log(`items.json:      ${(fs.statSync(path.join(root, 'data', 'items.json')).size / 1e6).toFixed(2)} MB raw`);
