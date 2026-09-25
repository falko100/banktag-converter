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

	/* Worn equipment, in the order the game's own interface lays them out. */
	var EQUIPMENT_SLOTS = [
		{ key: 'head', label: 'Head', column: 1, row: 0 },
		{ key: 'cape', label: 'Cape', column: 0, row: 1 },
		{ key: 'neck', label: 'Neck', column: 1, row: 1 },
		{ key: 'ammo', label: 'Ammo', column: 2, row: 1 },
		{ key: 'weapon', label: 'Weapon', column: 0, row: 2 },
		{ key: 'body', label: 'Body', column: 1, row: 2 },
		{ key: 'shield', label: 'Shield', column: 2, row: 2 },
		{ key: 'legs', label: 'Legs', column: 1, row: 3 },
		{ key: 'hands', label: 'Hands', column: 0, row: 4 },
		{ key: 'feet', label: 'Feet', column: 1, row: 4 },
		{ key: 'ring', label: 'Ring', column: 2, row: 4 }
	];

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
		equipmentPosition: equipmentPosition,
		inventoryPosition: inventoryPosition,
		toLayout: toLayout,
		toRuneLiteExport: toRuneLiteExport
	};
}));
