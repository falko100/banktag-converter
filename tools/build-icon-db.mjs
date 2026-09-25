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
const mappingFile = path.join(import.meta.dirname, 'mapping.json');
const volumesFile = path.join(import.meta.dirname, 'volumes.json');
const slotsFile = path.join(import.meta.dirname, 'slots.json');

if (!fs.existsSync(iconDir)) {
	console.error('Missing ' + iconDir + ' - run tools/fetch-icons.mjs first.');
	process.exit(1);
}

const names = JSON.parse(fs.readFileSync(namesFile, 'utf8'));

/*
 * How likely an item is to turn up in somebody's gear setup, 0-255.
 *
 * This matters more than it sounds. Matching frequently picks an obscure
 * lookalike over the real thing by a hair - "Mixture - step 1(3)", a herblore
 * intermediate, beat Super restore(4) by 2.0; "Kuhu essence" beat Blood rune by
 * 0.7. Every one of those false winners is untradeable and every true item is
 * tradeable, so grand exchange presence, graded by trade volume, separates them
 * cleanly. Items nobody can trade score 0 and get no help.
 */
function popularityTable() {
	var table = Object.create(null);
	if (!fs.existsSync(mappingFile)) {
		console.warn('No mapping.json - building without the popularity prior.');
		return table;
	}

	const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
	const volumes = fs.existsSync(volumesFile)
		? (JSON.parse(fs.readFileSync(volumesFile, 'utf8')).data || {})
		: {};

	for (const entry of mapping) {
		const volume = Number(volumes[entry.id] || 0);
		// 0.4 for merely being tradeable, up to 1.0 at ~1M traded per day
		const score = 0.4 + 0.6 * Math.min(1, Math.log10(volume + 1) / 6);
		table[entry.id] = Math.round(score * 255);
	}
	return table;
}

const popularity = popularityTable();

/*
 * Which equipment slot an item can go in, by name. Worn equipment is read slot
 * by slot, and a head slot can only hold a helmet, so this removes ~95% of the
 * item list from consideration before matching even starts.
 */
export const SLOT_ORDER = ['head', 'cape', 'neck', 'ammo', 'weapon', 'body', 'shield', 'legs', 'hands', 'feet', 'ring'];

function slotTable() {
	if (!fs.existsSync(slotsFile)) {
		console.warn('No slots.json - building without equipment slot data.');
		return {};
	}
	const raw = JSON.parse(fs.readFileSync(slotsFile, 'utf8'));
	const byName = Object.create(null);
	for (const [name, slot] of Object.entries(raw)) {
		byName[name.toLowerCase()] = SLOT_ORDER.indexOf(slot) + 1;   // 0 means "not equipment"
	}
	return byName;
}

const slots = slotTable();
let slotted = 0;

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
	// Identical icons share one entry, so take the most popular id in the group.
	let best = 0;
	for (const id of entry.ids) {
		best = Math.max(best, popularity[id] || 0);
	}
	const slot = slots[String(names[entry.id]).toLowerCase()] || 0;
	if (slot) {
		slotted++;
	}
	items.push([entry.id, names[entry.id], best, slot]);
});

const meta = { cellsX: CELLS_X, cellsY: CELLS_Y, iconW: ICON_W, iconH: ICON_H, count: items.length, items };
/*
 * Shipped gzipped and unpacked in the browser. Hosts do not compress
 * application/octet-stream, so serving the raw blob would send 2.6MB where 1MB
 * will do - and this is a tool people use on a phone.
 */
const packed = zlib.gzipSync(blob, { level: 9 });
fs.writeFileSync(path.join(root, 'data', 'items.json'), JSON.stringify(meta));
fs.writeFileSync(path.join(root, 'data', 'icons.bin.gz'), packed);
fs.rmSync(path.join(root, 'data', 'icons.bin'), { force: true });

console.log(`icons kept:      ${items.length} (skipped ${skippedEmpty} near-empty)`);
console.log(`icons.bin.gz:    ${(packed.length / 1e6).toFixed(2)} MB (from ${(blob.length / 1e6).toFixed(2)} MB raw)`);
console.log(`items.json:      ${(fs.statSync(path.join(root, 'data', 'items.json')).size / 1e6).toFixed(2)} MB raw`);
console.log(`with popularity: ${items.filter((i) => i[2] > 0).length}`);
console.log(`with a slot:     ${slotted}`);
