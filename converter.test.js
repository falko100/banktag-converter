'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { convert, convertAll, parse, positionToCell } = require('./converter.js');

test('converts the documented example', () => {
	assert.strictEqual(
		convert('banktags,1,hydra rl,952,layout,1,23075,4,27281'),
		'1,2,23075,1,0,27281,4,0'
	);
});

test('wraps positions onto rows of eight', () => {
	// Positions 0, 7, 8 and 17 -> (0,0), (7,0), (0,1) and (1,2).
	assert.strictEqual(
		convert('banktags,1,rows,952,layout,0,100,7,101,8,102,17,103'),
		'1,4,100,0,0,101,7,0,102,0,1,103,1,2'
	);
});

test('lays tagged items out in order when there is no layout section', () => {
	assert.strictEqual(
		convert('banktags,1,mining,1265,1265,1267,1269'),
		'1,3,1265,0,0,1267,1,0,1269,2,0'
	);
});

test('drops duplicate items when laying out an unlaid tag', () => {
	assert.strictEqual(
		convert('banktags,1,dupes,1265,1265,1267,1265'),
		'1,2,1265,0,0,1267,1,0'
	);
});

test('maps negative (variant) item ids onto their positive id', () => {
	assert.strictEqual(
		convert('banktags,1,variants,952,layout,0,-23075'),
		'1,1,23075,0,0'
	);
});

test('skips empty-slot markers in a layout', () => {
	assert.strictEqual(
		convert('banktags,1,gaps,952,layout,0,23075,1,-1,2,0,3,27281'),
		'1,2,23075,0,0,27281,3,0'
	);
});

test('keeps the last item written to a repeated position', () => {
	assert.strictEqual(convert('banktags,1,clash,952,layout,0,100,0,101'), '1,1,101,0,0');
});

test('tolerates whitespace around tokens and the whole string', () => {
	assert.strictEqual(
		convert('  banktags, 1, hydra rl, 952, layout, 1, 23075, 4, 27281  '),
		'1,2,23075,1,0,27281,4,0'
	);
});

test('reads a tag literally named "layout"', () => {
	const parsed = parse('banktags,1,layout,952,layout,0,23075');
	assert.strictEqual(parsed.name, 'layout');
	assert.deepStrictEqual(parsed.entries, [{ position: 0, itemId: 23075 }]);
});

test('exposes the tag name and icon, which the output cannot carry', () => {
	const parsed = parse('banktags,1,hydra rl,952,layout,1,23075,4,27281');
	assert.strictEqual(parsed.name, 'hydra rl');
	assert.strictEqual(parsed.iconId, 952);
	assert.strictEqual(parsed.hasExplicitLayout, true);
});

test('converts a Bank Tag Layouts plugin export', () => {
	assert.strictEqual(
		convert('banktaglayoutsplugin:hydra,23075:1,27281:4,banktag:hydra,952,23075,27281'),
		'1,2,23075,1,0,27281,4,0'
	);
});

test('reads the icon from a Bank Tag Layouts export tail', () => {
	const parsed = parse('banktaglayoutsplugin:hydra,23075:1,banktag:hydra,952,23075');
	assert.strictEqual(parsed.name, 'hydra');
	assert.strictEqual(parsed.iconId, 952);
});

test('positionToCell splits a position into column and row', () => {
	assert.deepStrictEqual(positionToCell(0), { column: 0, row: 0 });
	assert.deepStrictEqual(positionToCell(9), { column: 1, row: 1 });
});

test('rejects input that is already in mobile format', () => {
	assert.throws(() => convert('1,2,23075,1,0,27281,4,0'), /already an OSRS Mobile layout/);
});

test('rejects an unrecognised string', () => {
	assert.throws(() => convert('hello,world'), /Unrecognised export/);
});

test('rejects an odd number of layout values', () => {
	assert.throws(() => convert('banktags,1,odd,952,layout,0,100,7'), /position\/item pairs/);
});

test('rejects a non-numeric item id', () => {
	assert.throws(() => convert('banktags,1,bad,952,layout,0,apple'), /Expected a number/);
});

test('rejects an empty tag', () => {
	assert.throws(() => convert('banktags,1,empty,952'), /no items to place/);
});

test('rejects empty input', () => {
	assert.throws(() => convert('   '), /Paste a RuneLite bank tag export/);
});

test('convertAll handles several tags and reports per-line failures', () => {
	const results = convertAll(
		'banktags,1,a,952,layout,0,100\n\n  \nnonsense\nbanktags,1,b,952,layout,1,200'
	);

	assert.strictEqual(results.length, 3);
	assert.deepStrictEqual(
		results.map((r) => [r.lineNumber, r.ok]),
		[[1, true], [4, false], [5, true]]
	);
	assert.strictEqual(results[0].output, '1,1,100,0,0');
	assert.match(results[1].error, /Unrecognised export/);
	assert.strictEqual(results[2].output, '1,1,200,1,0');
});
