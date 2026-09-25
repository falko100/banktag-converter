'use strict';

const test = require('node:test');
const assert = require('node:assert');
const gear = require('./gear.js');
const { format } = require('./converter.js');

test('equipment slots sit where the game arranges them', () => {
	// head above neck, cape left of neck, ammo right of neck
	assert.strictEqual(gear.equipmentPosition('head'), 1);
	assert.strictEqual(gear.equipmentPosition('cape'), 8);
	assert.strictEqual(gear.equipmentPosition('neck'), 9);
	assert.strictEqual(gear.equipmentPosition('ammo'), 10);
	assert.strictEqual(gear.equipmentPosition('weapon'), 16);
	assert.strictEqual(gear.equipmentPosition('ring'), 34);
});

test('equipment never collides with the inventory block', () => {
	const equipment = gear.EQUIPMENT_SLOTS.map((s) => gear.equipmentPosition(s.key));
	const inventory = Array.from({ length: 28 }, (_, i) => gear.inventoryPosition(i));
	const overlap = equipment.filter((p) => inventory.includes(p));
	assert.deepStrictEqual(overlap, []);
	assert.strictEqual(new Set(equipment.concat(inventory)).size, 39);
});

test('the inventory keeps its 4-wide shape', () => {
	assert.strictEqual(gear.inventoryPosition(0), 4);
	assert.strictEqual(gear.inventoryPosition(3), 7);
	assert.strictEqual(gear.inventoryPosition(4), 12);   // next row
	assert.strictEqual(gear.inventoryPosition(27), 55);  // last slot, row 6
	const columns = new Set(Array.from({ length: 28 }, (_, i) => gear.inventoryPosition(i) % 8));
	assert.deepStrictEqual([...columns].sort(), [4, 5, 6, 7]);
});

test('builds a layout from equipment and inventory', () => {
	const entries = gear.toLayout({
		equipment: { head: 10828, weapon: 4151, body: 11832 },
		inventory: [385, 385, 2434]
	});

	assert.deepStrictEqual(entries, [
		{ position: 1, itemId: 10828, source: 'head' },
		{ position: 4, itemId: 385, source: 'inventory' },
		{ position: 5, itemId: 385, source: 'inventory' },
		{ position: 6, itemId: 2434, source: 'inventory' },
		{ position: 16, itemId: 4151, source: 'weapon' },
		{ position: 17, itemId: 11832, source: 'body' }
	]);
});

test('skips empty equipment and inventory slots', () => {
	const entries = gear.toLayout({
		equipment: { head: 0, weapon: 4151, cape: null },
		inventory: [null, 385, 0, undefined, 2434]
	});
	// inventory slot 1 -> position 5, slot 4 -> position 12, weapon -> position 16
	assert.deepStrictEqual(entries.map((e) => e.position), [5, 12, 16]);
	assert.deepStrictEqual(entries.map((e) => e.itemId), [385, 2434, 4151]);
});

test('the same item may repeat across inventory slots', () => {
	const entries = gear.toLayout({ inventory: [385, 385, 385] });
	assert.strictEqual(entries.length, 3);
	assert.deepStrictEqual(entries.map((e) => e.position), [4, 5, 6]);
});

test('a built layout converts straight to the mobile format', () => {
	const entries = gear.toLayout({ equipment: { weapon: 4151 }, inventory: [385] });
	// weapon at position 16 -> column 0 row 2; inventory slot 0 -> column 4 row 0
	assert.strictEqual(format({ entries }), '1,2,385,4,0,4151,0,2');
});

test('produces a RuneLite export that round-trips', () => {
	const { parse } = require('./converter.js');
	const setup = { equipment: { weapon: 4151, body: 11832 }, inventory: [385, 385] };
	const exported = gear.toRuneLiteExport(setup, { name: 'hydra', iconId: 4151 });

	assert.match(exported, /^banktags,1,hydra,4151,/);
	const parsed = parse(exported);
	assert.strictEqual(parsed.name, 'hydra');
	assert.deepStrictEqual(parsed.entries, gear.toLayout(setup).map((e) => ({ position: e.position, itemId: e.itemId })));
});

test('strips commas from a tag name so the export stays parseable', () => {
	const exported = gear.toRuneLiteExport({ inventory: [385] }, { name: 'a,b' });
	assert.match(exported, /^banktags,1,a b,/);
});

test('the equipment interface is not a uniform grid', () => {
	// The weapon/shield row is spread wider than the cape/ammo row. Getting this
	// wrong crops the outer columns off their items.
	const slots = Object.fromEntries(gear.EQUIPMENT_SLOTS.map((s) => [s.key, s]));
	assert.strictEqual(slots.weapon.fx, 0);
	assert.strictEqual(slots.shield.fx, 1);
	assert.ok(slots.cape.fx > slots.weapon.fx, 'cape sits inside weapon');
	assert.ok(slots.ammo.fx < slots.shield.fx, 'ammo sits inside shield');
	assert.ok(Math.abs((slots.ammo.fx - slots.neck.fx) - (slots.neck.fx - slots.cape.fx)) < 1e-9,
		'the narrow row should stay symmetric');
});

test('equipment rows are evenly spaced', () => {
	const rows = [...new Set(gear.EQUIPMENT_SLOTS.map((s) => s.fy))].sort((a, b) => a - b);
	assert.deepStrictEqual(rows, [0, 0.25, 0.5, 0.75, 1]);
});

test('equipmentSlotRect keeps every slot inside the drawn box', () => {
	const box = { x: 100, y: 200, w: 347, h: 463 };
	for (const slot of gear.EQUIPMENT_SLOTS) {
		const rect = gear.equipmentSlotRect(box, slot);
		assert.ok(rect.x >= box.x - 0.001, `${slot.key} starts left of the box`);
		assert.ok(rect.y >= box.y - 0.001, `${slot.key} starts above the box`);
		assert.ok(rect.x + rect.w <= box.x + box.w + 0.001, `${slot.key} runs past the right edge`);
		assert.ok(rect.y + rect.h <= box.y + box.h + 0.001, `${slot.key} runs past the bottom`);
		assert.ok(rect.w > 0 && rect.h > 0);
	}
});

test('equipmentSlotRect scales with the box', () => {
	const small = gear.equipmentSlotRect({ x: 0, y: 0, w: 347, h: 463 }, gear.EQUIPMENT_SLOTS[0]);
	const large = gear.equipmentSlotRect({ x: 0, y: 0, w: 694, h: 926 }, gear.EQUIPMENT_SLOTS[0]);
	assert.ok(Math.abs(large.w / small.w - 2) < 1e-9);
	assert.ok(Math.abs(large.x / small.x - 2) < 1e-9);
});

test('slot rectangles do not overlap each other', () => {
	const box = { x: 0, y: 0, w: 347, h: 463 };
	const rects = gear.EQUIPMENT_SLOTS.map((s) => ({ key: s.key, r: gear.equipmentSlotRect(box, s) }));
	for (let i = 0; i < rects.length; i++) {
		for (let j = i + 1; j < rects.length; j++) {
			const a = rects[i].r, b = rects[j].r;
			const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
			assert.ok(!overlap, `${rects[i].key} overlaps ${rects[j].key}`);
		}
	}
});
