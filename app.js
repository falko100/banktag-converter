/* UI for the RuneLite -> OSRS Mobile bank tag converter. */
(function () {
	'use strict';

	var EXAMPLE = 'banktags,1,hydra rl,952,layout,1,23075,4,27281';
	var ICON_URL = 'https://static.runelite.net/cache/item/icon/';
	var COLUMNS = window.BankTagConverter.BANK_COLUMNS;
	var MAX_PREVIEW_ROWS = 40;

	var input = document.getElementById('input');
	var outputPanel = document.getElementById('output-panel');
	var results = document.getElementById('results');
	var copyAll = document.getElementById('copy-all');

	var lastOutputs = [];

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	}

	/*
	 * Item icons come from a CDN, so they may be slow, blocked or missing for a
	 * given id. Every image starts hidden and is only revealed once it actually
	 * loads, which keeps the page useful with no network at all.
	 */
	function itemImage(itemId, host) {
		var img = el('img');
		img.alt = '';
		img.addEventListener('load', function () {
			host.classList.add('is-loaded');
		});
		img.src = ICON_URL + itemId + '.png';
		return img;
	}

	/* A bank slot showing the item id, upgraded to the item's icon when it loads. */
	function itemSlot(itemId) {
		var slot = el('div', 'slot');
		slot.appendChild(el('span', 'fallback', String(itemId)));
		slot.appendChild(itemImage(itemId, slot));
		return slot;
	}

	function copyText(text, button) {
		var done = function () {
			var original = button.dataset.label || button.textContent;
			button.dataset.label = original;
			button.textContent = 'Copied';
			setTimeout(function () {
				button.textContent = original;
			}, 1400);
		};

		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(done, function () {
				button.textContent = 'Copy failed';
			});
			return;
		}

		// file:// and older browsers do not always expose the async clipboard.
		var scratch = el('textarea');
		scratch.value = text;
		scratch.setAttribute('readonly', 'readonly');
		scratch.style.position = 'fixed';
		scratch.style.opacity = '0';
		document.body.appendChild(scratch);
		scratch.select();
		try {
			document.execCommand('copy');
			done();
		} catch (err) {
			button.textContent = 'Copy failed';
		}
		document.body.removeChild(scratch);
	}

	function buildGrid(parsed) {
		var byPosition = {};
		var maxPosition = 0;

		parsed.entries.forEach(function (entry) {
			byPosition[entry.position] = entry.itemId;
			maxPosition = Math.max(maxPosition, entry.position);
		});

		var rows = Math.min(Math.floor(maxPosition / COLUMNS) + 1, MAX_PREVIEW_ROWS);
		var grid = el('div', 'grid');

		for (var position = 0; position < rows * COLUMNS; position++) {
			var itemId = byPosition[position];
			var slot = itemId === undefined ? el('div', 'slot empty') : itemSlot(itemId);
			slot.title = 'Position ' + position + ' — column ' + (position % COLUMNS) +
				', row ' + Math.floor(position / COLUMNS) + (itemId === undefined ? '' : ' — item ' + itemId);
			grid.appendChild(slot);
		}

		return { grid: grid, truncated: Math.floor(maxPosition / COLUMNS) + 1 > rows };
	}

	function renderSuccess(result, showLineNumber, isFirstSuccess) {
		var parsed = result.parsed;
		var block = el('div', 'result');

		var head = el('div', 'result-head');
		if (parsed.iconId) {
			var iconHost = el('span', 'tag-icon');
			iconHost.appendChild(itemImage(parsed.iconId, iconHost));
			head.appendChild(iconHost);
		}
		head.appendChild(el('span', 'tag-name', parsed.name || '(unnamed tag)'));

		var meta = [parsed.entries.length + (parsed.entries.length === 1 ? ' item' : ' items')];
		if (parsed.iconId) {
			meta.push('icon ' + parsed.iconId);
		}
		if (showLineNumber) {
			meta.push('line ' + result.lineNumber);
		}
		head.appendChild(el('span', 'meta', meta.join(' · ')));
		block.appendChild(head);

		var line = el('div', 'out-line');
		var code = el('code', null, result.output);
		var copy = el('button', null, 'Copy');
		copy.type = 'button';
		copy.addEventListener('click', function () {
			copyText(result.output, copy);
		});
		line.appendChild(code);
		line.appendChild(copy);
		block.appendChild(line);

		var preview = buildGrid(parsed);
		block.appendChild(preview.grid);

		var notes = [];
		if (!parsed.hasExplicitLayout) {
			notes.push('No layout section in this export, so the tagged items were placed in order from the top-left.');
		}
		if (parsed.duplicatePositions) {
			notes.push(parsed.duplicatePositions + ' item(s) shared a position with another; the later one was kept.');
		}
		if (preview.truncated) {
			notes.push('Preview truncated to the first ' + MAX_PREVIEW_ROWS + ' rows. The output string is complete.');
		}
		if (isFirstSuccess && (parsed.name || parsed.iconId)) {
			notes.push('The name and icon are not part of the layout string — set them in game when you create the tab.');
		}

		notes.forEach(function (text) {
			block.appendChild(el('p', 'note', text));
		});

		return block;
	}

	function renderFailure(result, showLineNumber) {
		var block = el('div', 'result');
		var head = el('div', 'result-head');
		head.appendChild(el('span', 'tag-name', showLineNumber ? 'Line ' + result.lineNumber : 'Could not convert'));
		block.appendChild(head);
		block.appendChild(el('p', 'note error', result.error));
		return block;
	}

	function render() {
		var converted = window.BankTagConverter.convertAll(input.value);

		results.textContent = '';
		lastOutputs = [];

		if (!converted.length) {
			outputPanel.hidden = true;
			return;
		}

		outputPanel.hidden = false;
		var showLineNumber = converted.length > 1;

		converted.forEach(function (result) {
			if (result.ok) {
				results.appendChild(renderSuccess(result, showLineNumber, lastOutputs.length === 0));
				lastOutputs.push(result.output);
			} else {
				results.appendChild(renderFailure(result, showLineNumber));
			}
		});

		copyAll.disabled = lastOutputs.length === 0;
		copyAll.textContent = lastOutputs.length > 1 ? 'Copy all' : 'Copy';
	}

	input.addEventListener('input', render);

	document.getElementById('example').addEventListener('click', function () {
		input.value = EXAMPLE;
		render();
		input.focus();
	});

	document.getElementById('clear').addEventListener('click', function () {
		input.value = '';
		render();
		input.focus();
	});

	copyAll.addEventListener('click', function () {
		if (lastOutputs.length) {
			copyText(lastOutputs.join('\n'), copyAll);
		}
	});

	render();
}());
