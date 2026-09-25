/*
 * Turns a recognised gear setup (worn equipment + inventory) into bank tag
 * layout positions.
 *
 * The bank grid is 8 columns wide, which happens to fit both halves side by
 * side with nothing to spare: the equipment arrangement is 3 wide, the
 * inventory is 4 wide, and one empty column separates them.
 *
 *     0      1      2     3    4    5    6    7
 *  0         head              inv  inv  inv  inv
 *  1  cape   neck   ammo       inv  inv  inv  inv
 *  2  weapon body   shield     inv  inv  inv  inv
 *  3         legs              inv  inv  inv  inv
 *  4  hands  feet   ring       inv  inv  inv  inv
 *  5                           inv  inv  inv  inv
 *  6                           inv  inv  inv  inv
 */
;(function (root, factory) {
	'use strict';
	var api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.BankTagGear = api;
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	var BANK_COLUMNS = 8;
	var INVENTORY_COLUMNS = 4;
	var INVENTORY_SLOTS = 28;
	var INVENTORY_ORIGIN_COLUMN = 4;

	/*
	 * Worn equipment. `column`/`row` place the item in the bank grid; `fx`/`fy`
	 * say where the slot sits in a screenshot of the equipment interface, as a
	 * fraction of the span between the outermost slot centres.
	 *
	 * That interface is NOT a uniform grid, which is easy to get wrong: the
	 * weapon/body/shield and hands/feet/ring rows are spread wider (measured
	 * pitch 130px) than the cape/neck/ammo row (94px). Rows are evenly spaced.
	 */
	var EQUIPMENT_SLOTS = [
		{ key: 'head', label: 'Head', column: 1, row: 0, fx: 0.5, fy: 0 },
		{ key: 'cape', label: 'Cape', column: 0, row: 1, fx: 0.1385, fy: 0.25 },
		{ key: 'neck', label: 'Neck', column: 1, row: 1, fx: 0.5, fy: 0.25 },
		{ key: 'ammo', label: 'Ammo', column: 2, row: 1, fx: 0.8615, fy: 0.25 },
		{ key: 'weapon', label: 'Weapon', column: 0, row: 2, fx: 0, fy: 0.5 },
		{ key: 'body', label: 'Body', column: 1, row: 2, fx: 0.5, fy: 0.5 },
		{ key: 'shield', label: 'Shield', column: 2, row: 2, fx: 1, fy: 0.5 },
		{ key: 'legs', label: 'Legs', column: 1, row: 3, fx: 0.5, fy: 0.75 },
		{ key: 'hands', label: 'Hands', column: 0, row: 4, fx: 0, fy: 1 },
		{ key: 'feet', label: 'Feet', column: 1, row: 4, fx: 0.5, fy: 1 },
		{ key: 'ring', label: 'Ring', column: 2, row: 4, fx: 1, fy: 1 }
	];

	/*
	 * A slot square's size as a fraction of the box bounding all of them, and how
	 * much of that square the item's own icon frame covers. Measured from a real
	 * screenshot: 87x85px squares in a 347x463 box, with an ~83px icon frame.
	 */
	/*
	 * Where the equipment panel sits relative to the inventory grid, measured in
	 * inventory cell pitches.
	 *
	 * Switching tabs does not move the panel: both are drawn into the same area at
	 * the same UI scale, so the inventory grid - which detects reliably - gives the
	 * equipment box outright. That beats searching for it. Searching gets the
	 * region right but leaves the vertical placement 12-24px out, a quarter of a
	 * slot, because the row of buttons below the equipment slots drags every
	 * scoring function downwards. Derived this way it lands within ~1.5px.
	 */
	var EQUIPMENT_FROM_INVENTORY = {
		offsetX: 0.2048,
		offsetY: -0.1611,
		width: 3.4752,
		height: 5.5147
	};

	function equipmentBoxFromInventory(inventoryBox, columns, rows) {
		var pitchX = inventoryBox.w / columns;
		var pitchY = inventoryBox.h / rows;
		return {
			x: inventoryBox.x + EQUIPMENT_FROM_INVENTORY.offsetX * pitchX,
			y: inventoryBox.y + EQUIPMENT_FROM_INVENTORY.offsetY * pitchY,
			w: EQUIPMENT_FROM_INVENTORY.width * pitchX,
			h: EQUIPMENT_FROM_INVENTORY.height * pitchY
		};
	}

	var EQUIPMENT_SLOT_WIDTH = 87 / 347;
	var EQUIPMENT_SLOT_HEIGHT = 85 / 463;
	var EQUIPMENT_ICON_INSET = 0.95;

	/*
	 * The four holes in the 3x5 arrangement - beside the head slot and beside the
	 * legs slot. Nothing is ever drawn there, which is what makes the equipment
	 * panel recognisable: finding it means finding a position where all eleven
	 * slots hold something and these four hold nothing.
	 */
	var EQUIPMENT_GAPS = [
		{ key: 'gap-top-left', fx: 0.1385, fy: 0 },
		{ key: 'gap-top-right', fx: 0.8615, fy: 0 },
		{ key: 'gap-low-left', fx: 0.1385, fy: 0.75 },
		{ key: 'gap-low-right', fx: 0.8615, fy: 0.75 }
	];

	/* Where a slot's icon sits inside a drawn equipment box, in image pixels. */
	function equipmentSlotRect(box, slot) {
		var slotW = box.w * EQUIPMENT_SLOT_WIDTH;
		var slotH = box.h * EQUIPMENT_SLOT_HEIGHT;
		var cx = box.x + slotW / 2 + slot.fx * (box.w - slotW);
		var cy = box.y + slotH / 2 + slot.fy * (box.h - slotH);
		var w = slotW * EQUIPMENT_ICON_INSET;
		var h = slotH * EQUIPMENT_ICON_INSET;
		return { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
	}

	function equipmentPosition(key) {
		for (var i = 0; i < EQUIPMENT_SLOTS.length; i++) {
			if (EQUIPMENT_SLOTS[i].key === key) {
				return EQUIPMENT_SLOTS[i].row * BANK_COLUMNS + EQUIPMENT_SLOTS[i].column;
			}
		}
		return -1;
	}

	function inventoryPosition(index) {
		var row = Math.floor(index / INVENTORY_COLUMNS);
		var column = INVENTORY_ORIGIN_COLUMN + (index % INVENTORY_COLUMNS);
		return row * BANK_COLUMNS + column;
	}

	/*
	 * equipment: { head: itemId, cape: itemId, ... } - missing or falsy is empty
	 * inventory: array of up to 28 item ids, null/0 for an empty slot
	 *
	 * The same item can legitimately appear more than once (a stack of food sits
	 * in several inventory slots), and each occupies its own bank position.
	 */
	function toLayout(setup) {
		var equipment = (setup && setup.equipment) || {};
		var inventory = (setup && setup.inventory) || [];
		var entries = [];

		EQUIPMENT_SLOTS.forEach(function (slot) {
			var itemId = equipment[slot.key];
			if (itemId) {
				entries.push({ position: equipmentPosition(slot.key), itemId: itemId, source: slot.key });
			}
		});

		for (var i = 0; i < Math.min(inventory.length, INVENTORY_SLOTS); i++) {
			if (inventory[i]) {
				entries.push({ position: inventoryPosition(i), itemId: inventory[i], source: 'inventory' });
			}
		}

		entries.sort(function (a, b) { return a.position - b.position; });
		return entries;
	}

	/*
	 * A RuneLite "banktags" export, so a setup read off a phone can be imported
	 * back into RuneLite as well as into the official client.
	 */
	function toRuneLiteExport(setup, options) {
		var opts = options || {};
		var entries = toLayout(setup);
		var name = (opts.name || 'setup').replace(/,/g, ' ');
		var icon = opts.iconId || (entries.length ? entries[0].itemId : 0);

		var unique = [];
		var seen = {};
		entries.forEach(function (entry) {
			if (!seen[entry.itemId]) {
				seen[entry.itemId] = true;
				unique.push(entry.itemId);
			}
		});

		var parts = ['banktags', 1, name, icon].concat(unique, ['layout']);
		entries.forEach(function (entry) {
			parts.push(entry.position, entry.itemId);
		});

		return parts.join(',');
	}

	return {
		BANK_COLUMNS: BANK_COLUMNS,
		INVENTORY_SLOTS: INVENTORY_SLOTS,
		INVENTORY_COLUMNS: INVENTORY_COLUMNS,
		EQUIPMENT_SLOTS: EQUIPMENT_SLOTS,
		EQUIPMENT_GAPS: EQUIPMENT_GAPS,
		EQUIPMENT_FROM_INVENTORY: EQUIPMENT_FROM_INVENTORY,
		equipmentBoxFromInventory: equipmentBoxFromInventory,
		EQUIPMENT_ICON_INSET: EQUIPMENT_ICON_INSET,
		EQUIPMENT_SLOT_WIDTH: EQUIPMENT_SLOT_WIDTH,
		EQUIPMENT_SLOT_HEIGHT: EQUIPMENT_SLOT_HEIGHT,
		equipmentSlotRect: equipmentSlotRect,
		equipmentPosition: equipmentPosition,
		inventoryPosition: inventoryPosition,
		toLayout: toLayout,
		toRuneLiteExport: toRuneLiteExport
	};
}));
