/*
 * Bank tag converter: RuneLite -> OSRS Mobile (official client).
 *
 * Input formats
 * -------------
 * 1. RuneLite "Bank Tags" export:
 *      banktags,<version>,<name>,<iconId>,<taggedItemId>*[,layout(,<position>,<itemId>)*]
 *
 *    Positions are 0-based indexes into the bank grid, which is 8 columns wide.
 *    When there is no ",layout" section the tagged items are laid out in export
 *    order starting at position 0, which mimics what the tag looks like in game.
 *
 * 2. geheur's "Bank Tag Layouts" plugin export:
 *      banktaglayoutsplugin:<name>,(<itemId>:<position>)*,banktag:<name>,<iconId>,<itemId>*
 *
 *    The item:position pairs are the explicit layout; the banktag: tail repeats
 *    the plain tag, so it is ignored.
 *
 * Output format (official client / mobile)
 * ----------------------------------------
 *      1,<itemCount>(,<itemId>,<column>,<row>)*
 *
 *    where column = position % 8 and row = floor(position / 8). The tag name and
 *    icon are not part of the string - they are set in game when creating the tab.
 *
 * Format reference: the OSRS Wiki's own converter gadget,
 * https://oldschool.runescape.wiki/wiki/MediaWiki:Gadget-banktag-converter-core.js
 */
;(function (root, factory) {
	'use strict';
	var api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.BankTagConverter = api;
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	var BANK_COLUMNS = 8;
	var OUTPUT_VERSION = 1;
	var BTL_PREFIX = 'banktaglayoutsplugin:';

	function ConversionError(message) {
		var err = new Error(message);
		err.name = 'ConversionError';
		return err;
	}

	function parseInteger(token, what) {
		var trimmed = String(token == null ? '' : token).trim();
		if (!/^-?\d+$/.test(trimmed)) {
			throw ConversionError('Expected a number for ' + what + ' but found "' + trimmed + '".');
		}
		return parseInt(trimmed, 10);
	}

	/*
	 * Negative ids mark item variants (e.g. -952 means "any variant of 952"), so
	 * they map onto their positive id. -1 and 0 are RuneLite's "empty slot"
	 * markers and are dropped instead of being turned into item id 1.
	 */
	function normaliseItemId(id) {
		if (id === 0 || id === -1) {
			return null;
		}
		return Math.abs(id);
	}

	function splitTokens(input) {
		return String(input).trim().split(',').map(function (token) {
			return token.trim();
		});
	}

	/* Lays tagged items out left-to-right from position 0, skipping duplicates. */
	function layoutInOrder(itemTokens) {
		var entries = [];
		var seen = Object.create(null);
		var position = 0;

		itemTokens.forEach(function (token, index) {
			var itemId = normaliseItemId(parseInteger(token, 'tagged item ' + (index + 1)));
			if (itemId === null || seen[itemId]) {
				return;
			}
			seen[itemId] = true;
			entries.push({ position: position, itemId: itemId });
			position++;
		});

		return entries;
	}

	function parseBankTagsExport(tokens) {
		if (tokens.length < 4) {
			throw ConversionError('This looks like a "banktags" export but it is too short to hold a name and icon.');
		}

		var name = tokens[2];
		var iconId = normaliseItemId(parseInteger(tokens[3], 'the tag icon'));

		// Item ids start at index 4, so only look for the layout marker from there
		// on - it keeps a tag literally named "layout" from being misread.
		var layoutAt = tokens.indexOf('layout', 4);
		var hasLayout = layoutAt !== -1;
		var itemTokens = tokens.slice(4, hasLayout ? layoutAt : tokens.length);
		var entries;

		if (hasLayout) {
			var layoutTokens = tokens.slice(layoutAt + 1);
			if (layoutTokens.length % 2 !== 0) {
				throw ConversionError('The layout section has ' + layoutTokens.length +
					' values, but it must contain position/item pairs (an even number).');
			}
			entries = [];
			for (var i = 0; i < layoutTokens.length; i += 2) {
				var position = parseInteger(layoutTokens[i], 'a layout position');
				var itemId = normaliseItemId(parseInteger(layoutTokens[i + 1], 'a layout item id'));
				if (itemId === null) {
					continue;
				}
				if (position < 0) {
					throw ConversionError('Layout position ' + position + ' is negative.');
				}
				entries.push({ position: position, itemId: itemId });
			}
		} else {
			entries = layoutInOrder(itemTokens);
		}

		return {
			format: 'banktags',
			name: name,
			iconId: iconId,
			hasExplicitLayout: hasLayout,
			taggedItemCount: itemTokens.length,
			entries: entries
		};
	}

	function parseBankTagLayoutsExport(tokens) {
		var name = tokens[0].slice(BTL_PREFIX.length);
		var entries = [];
		var iconId = null;
		var index = 1;

		for (; index < tokens.length; index++) {
			if (tokens[index].indexOf('banktag:') === 0) {
				break;
			}
			var pair = tokens[index].split(':');
			if (pair.length !== 2) {
				throw ConversionError('Expected an "item:position" pair but found "' + tokens[index] + '".');
			}
			var itemId = normaliseItemId(parseInteger(pair[0], 'a layout item id'));
			var position = parseInteger(pair[1], 'a layout position');
			if (itemId === null) {
				continue;
			}
			if (position < 0) {
				throw ConversionError('Layout position ' + position + ' is negative.');
			}
			entries.push({ position: position, itemId: itemId });
		}

		// The tail is "banktag:<name>,<iconId>,<itemId>*" - it repeats the same tag,
		// so only the icon is worth reading off it.
		if (index < tokens.length) {
			name = name || tokens[index].slice('banktag:'.length);
			if (index + 1 < tokens.length) {
				iconId = normaliseItemId(parseInteger(tokens[index + 1], 'the tag icon'));
			}
		}

		return {
			format: 'banktaglayoutsplugin',
			name: name,
			iconId: iconId,
			hasExplicitLayout: true,
			taggedItemCount: entries.length,
			entries: entries
		};
	}

	/* True for a string that already is an official-client layout. */
	function looksLikeMobileExport(tokens) {
		if (tokens.length < 2 || tokens[0] !== String(OUTPUT_VERSION)) {
			return false;
		}
		if (!tokens.every(function (token) { return /^\d+$/.test(token); })) {
			return false;
		}
		var count = parseInt(tokens[1], 10);
		return tokens.length === 2 + count * 3;
	}

	/* Later entries win, so a repeated position behaves like the last edit. */
	function dedupePositions(entries) {
		var byPosition = Object.create(null);
		var duplicates = 0;

		entries.forEach(function (entry) {
			if (byPosition[entry.position] !== undefined) {
				duplicates++;
			}
			byPosition[entry.position] = entry;
		});

		var kept = entries.filter(function (entry) {
			return byPosition[entry.position] === entry;
		});

		return { entries: kept, duplicates: duplicates };
	}

	function parse(input) {
		var text = String(input == null ? '' : input).trim();
		if (!text) {
			throw ConversionError('Paste a RuneLite bank tag export to convert.');
		}

		var tokens = splitTokens(text);
		var parsed;

		if (tokens[0].indexOf(BTL_PREFIX) === 0) {
			parsed = parseBankTagLayoutsExport(tokens);
		} else if (tokens[0] === 'banktags') {
			parsed = parseBankTagsExport(tokens);
		} else if (looksLikeMobileExport(tokens)) {
			throw ConversionError('This is already an OSRS Mobile layout string - paste it straight into the game.');
		} else {
			throw ConversionError('Unrecognised export. It should start with "banktags," or "' + BTL_PREFIX + '".');
		}

		var deduped = dedupePositions(parsed.entries);
		parsed.entries = deduped.entries;
		parsed.duplicatePositions = deduped.duplicates;

		if (!parsed.entries.length) {
			throw ConversionError('That tag contains no items to place.');
		}

		return parsed;
	}

	function positionToCell(position) {
		return {
			column: position % BANK_COLUMNS,
			row: Math.floor(position / BANK_COLUMNS)
		};
	}

	function format(parsed) {
		var out = [OUTPUT_VERSION, parsed.entries.length];

		parsed.entries.forEach(function (entry) {
			var cell = positionToCell(entry.position);
			out.push(entry.itemId, cell.column, cell.row);
		});

		return out.join(',');
	}

	/* Converts one export string. Throws ConversionError on bad input. */
	function convert(input) {
		return format(parse(input));
	}

	/* Converts a block of text, one export per non-empty line. */
	function convertAll(text) {
		return String(text == null ? '' : text)
			.split(/\r?\n/)
			.map(function (line, index) {
				return { line: line, lineNumber: index + 1 };
			})
			.filter(function (item) {
				return item.line.trim() !== '';
			})
			.map(function (item) {
				try {
					var parsed = parse(item.line);
					return {
						lineNumber: item.lineNumber,
						input: item.line,
						ok: true,
						parsed: parsed,
						output: format(parsed)
					};
				} catch (err) {
					return {
						lineNumber: item.lineNumber,
						input: item.line,
						ok: false,
						error: err.message
					};
				}
			});
	}

	return {
		BANK_COLUMNS: BANK_COLUMNS,
		OUTPUT_VERSION: OUTPUT_VERSION,
		parse: parse,
		format: format,
		convert: convert,
		convertAll: convertAll,
		positionToCell: positionToCell
	};
}));
