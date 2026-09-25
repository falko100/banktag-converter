/*
 * Reads a gear setup off two screenshots and turns it into a bank tag.
 *
 * Slot geometry is not guessed from the screenshot. Phones differ in
 * resolution, aspect and UI scale, and the official client keeps changing, so
 * instead the person drags a box around the item grid and the crops are shown
 * back to them before anything is matched. Lining up a box is quick; silently
 * reading the wrong pixels is not.
 */
(function () {
	'use strict';

	var ICON_W = 36, ICON_H = 32;
	var ICON_URL = 'https://static.runelite.net/cache/item/icon/';
	var SHORTLIST = 25;      // candidates kept from the signature pass
	var REFINE = 25;         // of those, how many get re-scored at full resolution
	var HANDLE = 14;         // px grab radius for a box corner

	/*
	 * A cell is bigger than the icon drawn in it. Measured off a real phone
	 * screenshot: a potion 51x69px sat in a cell of 98.5x84.5, against a
	 * reference icon whose own artwork is 22x31 inside a 36x32 frame - so the
	 * icon frame covers about 84% of the cell across and 88% down. Cropping the
	 * whole cell instead would shrink the item and pad it, which matching does
	 * not survive.
	 */
	var ICON_INSET_X = 0.84;
	var ICON_INSET_Y = 0.88;

	/*
	 * The inventory is a plain 4x7 grid, so its box snaps to the grid measured
	 * from the image. Worn equipment is not a grid at all - its rows are spread
	 * to different widths - so it uses the measured slot positions in gear.js and
	 * is positioned by hand.
	 */
	var REGIONS = {
		equipment: { label: 'Worn equipment', kind: 'slots', aspect: 347 / 463 },
		inventory: { label: 'Inventory', kind: 'grid', columns: 4, rows: 7 }
	};

	var db = null;
	var itemName = null;         // Map id -> name
	var iconCache = {};          // id -> Uint8ClampedArray | null
	var state = {
		equipment: { image: null, box: null, pixels: null },
		inventory: { image: null, box: null, pixels: null },
		picking: null
	};

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className) { node.className = className; }
		if (text !== undefined) { node.textContent = text; }
		return node;
	}

	function byId(id) { return document.getElementById(id); }

	// ---------------------------------------------------------------- database

	function loadDatabase() {
		if (db) { return Promise.resolve(db); }
		return Promise.all([
			fetch('data/items.json').then(function (r) { return r.json(); }),
			fetch('data/icons.bin').then(function (r) { return r.arrayBuffer(); })
		]).then(function (parts) {
			db = { meta: parts[0], blob: new Uint8Array(parts[1]) };
			itemName = new Map(db.meta.items);
			return db;
		});
	}

	/* Item icon pixels, for the full-resolution re-scoring pass. */
	function iconPixels(id) {
		if (Object.prototype.hasOwnProperty.call(iconCache, id)) {
			return Promise.resolve(iconCache[id]);
		}
		return new Promise(function (resolve) {
			var img = new Image();
			img.crossOrigin = 'anonymous';   // needed to read the pixels back out
			img.onload = function () {
				var canvas = document.createElement('canvas');
				canvas.width = ICON_W;
				canvas.height = ICON_H;
				var ctx = canvas.getContext('2d', { willReadFrequently: true });
				ctx.drawImage(img, 0, 0, ICON_W, ICON_H);
				try {
					iconCache[id] = ctx.getImageData(0, 0, ICON_W, ICON_H).data;
				} catch (err) {
					iconCache[id] = null;    // tainted canvas, skip refinement for this one
				}
				resolve(iconCache[id]);
			};
			img.onerror = function () { iconCache[id] = null; resolve(null); };
			img.src = ICON_URL + id + '.png';
		});
	}

	// ------------------------------------------------------------------ images

	function defaultBox(image, region) {
		// Start from a centred box of roughly the right shape.
		var height = image.naturalHeight * 0.6;
		var width = region.kind === 'slots'
			? height * region.aspect
			: height * (region.columns * ICON_W) / (region.rows * ICON_H);
		if (width > image.naturalWidth * 0.9) {
			width = image.naturalWidth * 0.9;
			height = region.kind === 'slots'
				? width / region.aspect
				: width * (region.rows * ICON_H) / (region.columns * ICON_W);
		}
		return {
			x: (image.naturalWidth - width) / 2,
			y: (image.naturalHeight - height) / 2,
			w: width,
			h: height
		};
	}

	function loadImage(key, file) {
		var url = URL.createObjectURL(file);
		var img = new Image();
		img.onload = function () {
			URL.revokeObjectURL(url);
			state[key].image = img;
			state[key].pixels = readPixels(img);
			state[key].box = defaultBox(img, REGIONS[key]);
			snapToGrid(key);
			byId('stage-' + key).hidden = false;
			byId('hint-' + key).textContent = 'Drag the box over the item grid.';
			drawStage(key);
			refreshCrops();
		};
		img.onerror = function () {
			URL.revokeObjectURL(url);
			byId('hint-' + key).textContent = 'That file could not be read as an image.';
		};
		img.src = url;
	}

	/* Full-resolution pixels, needed by the grid aligner. */
	function readPixels(image) {
		var canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		var ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(image, 0, 0);
		try {
			return ctx.getImageData(0, 0, canvas.width, canvas.height);
		} catch (err) {
			return null;
		}
	}

	function snapToGrid(key) {
		var region = REGIONS[key];
		var pixels = state[key].pixels;
		if (!pixels || !state[key].box) {
			return;
		}

		if (region.kind === 'slots') {
			state[key].box = BankTagAlign.refineSlotBox(
				pixels.data, pixels.width, pixels.height, state[key].box,
				function (box) {
					return BankTagGear.EQUIPMENT_SLOTS.map(function (slot) {
						return BankTagGear.equipmentSlotRect(box, slot);
					});
				}
			);
			return;
		}

		state[key].box = BankTagAlign.refineGrid(
			pixels.data, pixels.width, pixels.height,
			state[key].box, region.columns, region.rows
		);
	}

	function stageScale(key) {
		var canvas = byId('canvas-' + key);
		return state[key].image ? canvas.width / state[key].image.naturalWidth : 1;
	}

	function drawStage(key) {
		var image = state[key].image;
		if (!image) { return; }

		var canvas = byId('canvas-' + key);
		var maxWidth = canvas.parentNode.clientWidth || 360;
		canvas.width = Math.min(maxWidth, image.naturalWidth);
		canvas.height = Math.round(canvas.width * image.naturalHeight / image.naturalWidth);

		var ctx = canvas.getContext('2d');
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

		var scale = canvas.width / image.naturalWidth;
		var box = state[key].box;
		var region = REGIONS[key];
		var x = box.x * scale, y = box.y * scale, w = box.w * scale, h = box.h * scale;

		ctx.save();
		ctx.strokeStyle = '#e0b453';
		ctx.lineWidth = 2;
		ctx.strokeRect(x, y, w, h);

		ctx.strokeStyle = 'rgba(224, 180, 83, 0.55)';
		ctx.lineWidth = 1;

		if (region.kind === 'slots') {
			// Show each slot where it will actually be read from.
			cellsOf(key).forEach(function (cell) {
				var rect = cellRect(key, cell);
				ctx.strokeRect(rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale);
			});
		} else {
			for (var c = 1; c < region.columns; c++) {
				ctx.beginPath();
				ctx.moveTo(x + w * c / region.columns, y);
				ctx.lineTo(x + w * c / region.columns, y + h);
				ctx.stroke();
			}
			for (var r = 1; r < region.rows; r++) {
				ctx.beginPath();
				ctx.moveTo(x, y + h * r / region.rows);
				ctx.lineTo(x + w, y + h * r / region.rows);
				ctx.stroke();
			}
		}

		ctx.fillStyle = '#e0b453';
		[[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(function (p) {
			ctx.fillRect(p[0] - 4, p[1] - 4, 8, 8);
		});
		ctx.restore();
	}

	/* The image-space rectangle a cell reads from. */
	function cellRect(key, cell) {
		var box = state[key].box;
		if (REGIONS[key].kind === 'slots') {
			return BankTagGear.equipmentSlotRect(box, cell.slot);
		}

		var region = REGIONS[key];
		var cellW = box.w / region.columns;
		var cellH = box.h / region.rows;
		var iconW = cellW * ICON_INSET_X;
		var iconH = cellH * ICON_INSET_Y;
		return {
			x: box.x + cell.column * cellW + (cellW - iconW) / 2,
			y: box.y + cell.row * cellH + (cellH - iconH) / 2,
			w: iconW,
			h: iconH
		};
	}

	/* Crops one cell to icon size and returns its pixels. */
	function cropCell(key, cell) {
		var rect = cellRect(key, cell);
		var canvas = document.createElement('canvas');
		canvas.width = ICON_W;
		canvas.height = ICON_H;
		var ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(state[key].image, rect.x, rect.y, rect.w, rect.h, 0, 0, ICON_W, ICON_H);
		return ctx.getImageData(0, 0, ICON_W, ICON_H);
	}

	function cellsOf(key) {
		var region = REGIONS[key];
		if (region.kind === 'slots') {
			return BankTagGear.EQUIPMENT_SLOTS.map(function (slot, index) {
				return { slot: slot, key: slot.key, index: index };
			});
		}

		var cells = [];
		for (var row = 0; row < region.rows; row++) {
			for (var column = 0; column < region.columns; column++) {
				cells.push({ column: column, row: row, index: row * region.columns + column });
			}
		}
		return cells;
	}

	// --------------------------------------------------------- box interaction

	function attachBoxEditing(key) {
		var canvas = byId('canvas-' + key);
		var drag = null;

		function toImage(event) {
			var rect = canvas.getBoundingClientRect();
			var scale = state[key].image.naturalWidth / rect.width;
			return {
				x: (event.clientX - rect.left) * scale,
				y: (event.clientY - rect.top) * scale
			};
		}

		canvas.addEventListener('pointerdown', function (event) {
			if (!state[key].image) { return; }
			canvas.setPointerCapture(event.pointerId);

			var p = toImage(event);
			var box = state[key].box;
			var grab = HANDLE / stageScale(key);
			var corners = {
				nw: { x: box.x, y: box.y },
				ne: { x: box.x + box.w, y: box.y },
				sw: { x: box.x, y: box.y + box.h },
				se: { x: box.x + box.w, y: box.y + box.h }
			};

			for (var name in corners) {
				if (Math.abs(p.x - corners[name].x) < grab && Math.abs(p.y - corners[name].y) < grab) {
					drag = { mode: 'resize', corner: name, start: p, box: Object.assign({}, box) };
					return;
				}
			}

			var inside = p.x > box.x && p.x < box.x + box.w && p.y > box.y && p.y < box.y + box.h;
			drag = inside
				? { mode: 'move', start: p, box: Object.assign({}, box) }
				: { mode: 'draw', start: p };
		});

		canvas.addEventListener('pointermove', function (event) {
			if (!drag) { return; }
			var p = toImage(event);
			var box = state[key].box;

			if (drag.mode === 'move') {
				box.x = drag.box.x + (p.x - drag.start.x);
				box.y = drag.box.y + (p.y - drag.start.y);
			} else if (drag.mode === 'draw') {
				box.x = Math.min(drag.start.x, p.x);
				box.y = Math.min(drag.start.y, p.y);
				box.w = Math.abs(p.x - drag.start.x);
				box.h = Math.abs(p.y - drag.start.y);
			} else {
				var left = drag.corner === 'nw' || drag.corner === 'sw';
				var top = drag.corner === 'nw' || drag.corner === 'ne';
				var x1 = left ? drag.box.x + drag.box.w : drag.box.x;
				var y1 = top ? drag.box.y + drag.box.h : drag.box.y;
				box.x = Math.min(x1, p.x);
				box.y = Math.min(y1, p.y);
				box.w = Math.abs(p.x - x1);
				box.h = Math.abs(p.y - y1);
			}

			box.w = Math.max(box.w, 16);
			box.h = Math.max(box.h, 16);
			drawStage(key);
		});

		function endDrag(event) {
			if (!drag) { return; }
			drag = null;
			if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
				canvas.releasePointerCapture(event.pointerId);
			}
			snapToGrid(key);
			drawStage(key);
			refreshCrops();
		}
		canvas.addEventListener('pointerup', endDrag);
		canvas.addEventListener('pointercancel', endDrag);
	}

	// ------------------------------------------------------------ crop preview

	function refreshCrops() {
		var ready = state.equipment.image || state.inventory.image;
		byId('crops-panel').hidden = !ready;
		if (!ready) { return; }

		var host = byId('crops');
		host.textContent = '';

		Object.keys(REGIONS).forEach(function (key) {
			if (!state[key].image) { return; }

			var block = el('div', 'crop-block');
			block.appendChild(el('h3', null, REGIONS[key].label));

			var region = REGIONS[key];
			var columns = region.kind === 'slots' ? 3 : region.columns;
			var strip = el('div', 'crop-strip');
			strip.style.gridTemplateColumns = 'repeat(' + columns + ', 1fr)';

			// Equipment slots sit in a 3x5 arrangement with gaps; the bank grid
			// coordinates on each slot happen to describe exactly that shape.
			var placed = {};
			cellsOf(key).forEach(function (cell) {
				var column = region.kind === 'slots' ? cell.slot.column : cell.column;
				var row = region.kind === 'slots' ? cell.slot.row : cell.row;
				placed[column + ',' + row] = cell;
			});

			var rows = region.kind === 'slots' ? 5 : region.rows;
			for (var row = 0; row < rows; row++) {
				for (var column = 0; column < columns; column++) {
					var cell = placed[column + ',' + row];
					if (!cell) {
						strip.appendChild(el('div', 'crop-cell blank'));
						continue;
					}
					var holder = el('div', 'crop-cell');
					var canvas = el('canvas');
					canvas.width = ICON_W;
					canvas.height = ICON_H;
					canvas.getContext('2d').putImageData(cropCell(key, cell), 0, 0);
					holder.appendChild(canvas);
					strip.appendChild(holder);
				}
			}

			block.appendChild(strip);
			host.appendChild(block);
		});

		byId('read').disabled = !(state.equipment.image || state.inventory.image);
	}

	// ------------------------------------------------------------- recognition

	function identifyCell(key, cell) {
		var imageData = cropCell(key, cell);
		var described = BankTagMatcher.describe(
			imageData.data, ICON_W, ICON_H, db.meta.cellsX, db.meta.cellsY
		);
		// For worn equipment, only items that go in that slot are candidates.
		var options = cell.slot ? { slot: cell.slot.key } : null;
		var ranked = BankTagMatcher.rank(db, described, SHORTLIST, options);
		return { described: described, ranked: ranked, imageData: imageData };
	}

	function refineCell(result) {
		var top = result.ranked.slice(0, REFINE);
		return Promise.all(top.map(function (c) { return iconPixels(c.id); }))
			.then(function (pixels) {
				var available = {};
				top.forEach(function (c, i) { if (pixels[i]) { available[c.id] = pixels[i]; } });
				if (!Object.keys(available).length) { return result.ranked; }

				var refined = BankTagMatcher.preferCanonicalName(BankTagMatcher.refine(
					top, result.imageData.data, ICON_W, ICON_H,
					result.described.background, available, ICON_W, ICON_H
				));
				// Keep the rest of the shortlist behind the re-scored head of it.
				return refined.concat(result.ranked.slice(REFINE));
			});
	}

	function readItems() {
		var status = byId('read-status');
		status.textContent = 'Loading item database…';
		byId('read').disabled = true;

		loadDatabase().then(function () {
			var jobs = [];
			Object.keys(REGIONS).forEach(function (key) {
				if (!state[key].image) { return; }
				cellsOf(key).forEach(function (cell) { jobs.push({ key: key, cell: cell }); });
			});

			var matched = { equipment: {}, inventory: [] };
			var done = 0;

			function step() {
				if (!jobs.length) {
					state.matched = matched;
					status.textContent = '';
					byId('read').disabled = false;
					renderResults();
					return;
				}

				var job = jobs.shift();
				var result = identifyCell(job.key, job.cell);
				var empty = BankTagMatcher.looksEmpty(result.described);

				var finish = function (ranked) {
					var entry = {
						key: job.key,
						cell: job.cell,
						candidates: ranked,
						chosenId: empty ? null : ranked[0].id,
						empty: empty,
						review: !empty && BankTagMatcher.needsReview(result.described, ranked)
					};
					if (job.key === 'equipment') {
						matched.equipment[job.cell.key] = entry;
					} else {
						matched.inventory[job.cell.index] = entry;
					}
					done++;
					status.textContent = 'Matching… ' + done + ' slots read';
					setTimeout(step, 0);   // yield so the status can paint
				};

				if (empty) { finish(result.ranked); } else { refineCell(result).then(finish); }
			}

			step();
		}).catch(function (err) {
			status.textContent = 'Could not load the item database: ' + err.message;
			byId('read').disabled = false;
		});
	}

	// ----------------------------------------------------------------- results

	function itemThumb(id, size) {
		var host = el('span', 'thumb');
		var img = el('img');
		img.alt = '';
		img.addEventListener('load', function () { host.classList.add('is-loaded'); });
		img.src = ICON_URL + id + '.png';
		host.appendChild(el('span', 'thumb-id', String(id)));
		host.appendChild(img);
		host.style.setProperty('--thumb', (size || 32) + 'px');
		return host;
	}

	function slotButton(entry, label) {
		var button = el('button', 'slot-pick');
		button.type = 'button';
		if (entry && entry.chosenId) {
			button.appendChild(itemThumb(entry.chosenId));
			button.title = (itemName.get(entry.chosenId) || entry.chosenId) +
				(label ? ' — ' + label : '');
			if (entry.review) { button.classList.add('unsure'); }
		} else {
			button.classList.add('empty');
			button.title = (label || 'Empty') + ' — click to choose an item';
		}
		if (entry) {
			button.addEventListener('click', function () { openPicker(entry); });
		}
		return button;
	}

	function renderResults() {
		var host = byId('results');
		host.textContent = '';
		byId('results-panel').hidden = false;

		if (state.equipment.image) {
			var eq = el('div', 'result-block');
			eq.appendChild(el('h3', null, 'Worn equipment'));
			var eqGrid = el('div', 'gear-grid');
			var bySlot = {};
			BankTagGear.EQUIPMENT_SLOTS.forEach(function (slot) {
				bySlot[slot.column + ',' + slot.row] = slot;
			});
			for (var row = 0; row < 5; row++) {
				for (var column = 0; column < 3; column++) {
					var slot = bySlot[column + ',' + row];
					if (!slot) { eqGrid.appendChild(el('div', 'gear-blank')); continue; }
					eqGrid.appendChild(slotButton(state.matched.equipment[slot.key], slot.label));
				}
			}
			eq.appendChild(eqGrid);
			host.appendChild(eq);
		}

		if (state.inventory.image) {
			var inv = el('div', 'result-block');
			inv.appendChild(el('h3', null, 'Inventory'));
			var invGrid = el('div', 'inv-grid');
			for (var i = 0; i < 28; i++) {
				invGrid.appendChild(slotButton(state.matched.inventory[i], 'Slot ' + (i + 1)));
			}
			inv.appendChild(invGrid);
			host.appendChild(inv);
		}

		renderOutput();
	}

	// ------------------------------------------------------------------ picker

	function renderPickerList(query) {
		var list = byId('picker-list');
		list.textContent = '';
		var entry = state.picking;
		if (!entry) { return; }

		var rows = [];
		if (query) {
			var needle = query.toLowerCase();
			for (var i = 0; i < db.meta.items.length && rows.length < 60; i++) {
				if (db.meta.items[i][1].toLowerCase().indexOf(needle) !== -1) {
					rows.push({ id: db.meta.items[i][0], name: db.meta.items[i][1] });
				}
			}
		} else {
			rows = entry.candidates.slice(0, 12).map(function (c) {
				return { id: c.id, name: c.name };
			});
		}

		var clear = el('button', 'picker-row');
		clear.type = 'button';
		clear.appendChild(el('span', 'picker-name', 'Leave this slot empty'));
		clear.addEventListener('click', function () { choose(null); });
		list.appendChild(clear);

		rows.forEach(function (row) {
			var button = el('button', 'picker-row');
			button.type = 'button';
			button.appendChild(itemThumb(row.id, 28));
			button.appendChild(el('span', 'picker-name', row.name));
			button.appendChild(el('span', 'meta', String(row.id)));
			if (entry.chosenId === row.id) { button.classList.add('chosen'); }
			button.addEventListener('click', function () { choose(row.id); });
			list.appendChild(button);
		});

		if (!rows.length) {
			list.appendChild(el('p', 'hint', 'No item names match that.'));
		}
	}

	function choose(id) {
		if (state.picking) {
			state.picking.chosenId = id;
			state.picking.empty = id === null;
			state.picking.review = false;
		}
		closePicker();
		renderResults();
	}

	function openPicker(entry) {
		state.picking = entry;
		byId('picker-title').textContent = entry.key === 'equipment'
			? 'Choose the equipped item'
			: 'Choose the item for this slot';
		byId('picker-search').value = '';
		byId('picker').hidden = false;
		renderPickerList('');
		byId('picker-search').focus();
	}

	function closePicker() {
		state.picking = null;
		byId('picker').hidden = true;
	}

	// ------------------------------------------------------------------ output

	function currentSetup() {
		var equipment = {};
		Object.keys(state.matched ? state.matched.equipment : {}).forEach(function (key) {
			var entry = state.matched.equipment[key];
			if (entry && entry.chosenId) { equipment[key] = entry.chosenId; }
		});

		var inventory = [];
		for (var i = 0; i < 28; i++) {
			var entry = state.matched && state.matched.inventory[i];
			inventory.push(entry && entry.chosenId ? entry.chosenId : null);
		}

		return { equipment: equipment, inventory: inventory };
	}

	function copyButton(text) {
		var button = el('button', null, 'Copy');
		button.type = 'button';
		button.addEventListener('click', function () {
			navigator.clipboard.writeText(text).then(function () {
				button.textContent = 'Copied';
				setTimeout(function () { button.textContent = 'Copy'; }, 1400);
			}, function () { button.textContent = 'Copy failed'; });
		});
		return button;
	}

	function outputLine(label, value) {
		var block = el('div', 'out-block');
		block.appendChild(el('h3', null, label));
		var line = el('div', 'out-line');
		line.appendChild(el('code', null, value));
		line.appendChild(copyButton(value));
		block.appendChild(line);
		return block;
	}

	function renderOutput() {
		var host = byId('output');
		host.textContent = '';

		var setup = currentSetup();
		var entries = BankTagGear.toLayout(setup);
		byId('output-panel').hidden = false;

		if (!entries.length) {
			host.appendChild(el('p', 'note', 'No items chosen yet.'));
			return;
		}

		var name = 'setup';
		host.appendChild(outputLine(
			'OSRS Mobile / official client',
			BankTagConverter.format({ entries: entries })
		));
		host.appendChild(outputLine(
			'RuneLite import',
			BankTagGear.toRuneLiteExport(setup, { name: name, iconId: entries[0].itemId })
		));

		var preview = el('div', 'grid');
		var byPosition = {};
		entries.forEach(function (entry) { byPosition[entry.position] = entry.itemId; });
		for (var position = 0; position < 56; position++) {
			var id = byPosition[position];
			var cell = el('div', 'slot' + (id === undefined ? ' empty' : ''));
			if (id !== undefined) {
				cell.appendChild(el('span', 'fallback', String(id)));
				var img = el('img');
				img.alt = '';
				(function (cellRef) {
					img.addEventListener('load', function () { cellRef.classList.add('is-loaded'); });
				}(cell));
				img.src = ICON_URL + id + '.png';
				cell.appendChild(img);
				cell.title = (itemName ? itemName.get(id) || id : id) + ' — position ' + position;
			}
			preview.appendChild(cell);
		}
		host.appendChild(preview);
		host.appendChild(el('p', 'note', entries.length + ' items placed. The tag name and icon are set in game.'));
	}

	// ------------------------------------------------------------------- setup

	Object.keys(REGIONS).forEach(function (key) {
		byId('file-' + key).addEventListener('change', function (event) {
			if (event.target.files && event.target.files[0]) {
				loadImage(key, event.target.files[0]);
			}
		});
		attachBoxEditing(key);
	});

	byId('read').addEventListener('click', readItems);
	byId('snap').addEventListener('click', function () {
		Object.keys(REGIONS).forEach(function (key) {
			if (state[key].image) {
				snapToGrid(key);
				drawStage(key);
			}
		});
		refreshCrops();
	});
	byId('picker-close').addEventListener('click', closePicker);
	byId('picker-search').addEventListener('input', function (event) {
		renderPickerList(event.target.value.trim());
	});
	byId('picker').addEventListener('click', function (event) {
		if (event.target === byId('picker')) { closePicker(); }
	});
	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape') { closePicker(); }
	});
	window.addEventListener('resize', function () {
		Object.keys(REGIONS).forEach(function (key) {
			if (state[key].image) { drawStage(key); }
		});
	});
}());
