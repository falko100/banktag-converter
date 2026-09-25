/*
 * Snaps a roughly drawn box onto the actual item grid.
 *
 * This is not a nicety. Matching turns out to be very sensitive to alignment:
 * on a real phone screenshot, shifting the grid by 12px - about an eighth of a
 * cell - moved the correct item from rank 2491 to rank 1, and dropped its fit
 * error from 62 to 26. Nobody drags a box that accurately, so the box is only
 * ever treated as a hint and the real grid is measured from the pixels.
 *
 * Item sprites have crisp outlines and hard interior edges, while the backdrop
 * behind the translucent panel is comparatively smooth. Summing gradient energy
 * along each axis therefore gives a profile that peaks over items and falls away
 * in the gaps between them, and the true grid is the pitch and offset that lands
 * its cell boundaries in those gaps.
 */
;(function (root, factory) {
	'use strict';
	var api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.BankTagAlign = api;
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	var PITCH_TOLERANCE = 0.25;   // how far the pitch may move from the drawn box
	var SEARCH_MARGIN = 1.0;      // how far outside the box to look, in cells
	var BOUNDARY_HALF_WIDTH = 2;  // px either side of a boundary that count as "on" it

	/*
	 * A gradient profile is periodic, so sliding the grid a whole cell lands on a
	 * near-identical score and the search happily snaps to the wrong row. The
	 * offset is therefore kept within half a cell of where the box was drawn: far
	 * enough to fix the pixel-level error that matters, not far enough to slip a
	 * row. Ties break towards the drawn box.
	 */
	var MAX_OFFSET_SHIFT = 0.5;   // in cells
	var HINT_BIAS = 0.02;         // preference for staying near the drawn box

	/* Sum of absolute colour change to the right and below each pixel. */
	function gradientProfiles(rgba, width, height, region) {
		var columns = new Float64Array(region.w);
		var rows = new Float64Array(region.h);

		for (var y = 0; y < region.h - 1; y++) {
			for (var x = 0; x < region.w - 1; x++) {
				var px = region.x + x, py = region.y + y;
				if (px < 0 || py < 0 || px >= width - 1 || py >= height - 1) {
					continue;
				}
				var i = (py * width + px) * 4;
				var right = (py * width + px + 1) * 4;
				var down = ((py + 1) * width + px) * 4;
				var energy = 0;
				for (var c = 0; c < 3; c++) {
					energy += Math.abs(rgba[right + c] - rgba[i + c]) +
						Math.abs(rgba[down + c] - rgba[i + c]);
				}
				columns[x] += energy;
				rows[y] += energy;
			}
		}

		return { columns: columns, rows: rows };
	}

	function boundaryEnergy(profile, pitch, offset, count) {
		var total = 0, samples = 0;

		for (var k = 0; k <= count; k++) {
			var at = offset + k * pitch;
			for (var d = -BOUNDARY_HALF_WIDTH; d <= BOUNDARY_HALF_WIDTH; d++) {
				var p = Math.round(at + d);
				if (p >= 0 && p < profile.length) {
					total += profile[p];
					samples++;
				}
			}
		}

		return samples ? total / samples : Infinity;
	}

	/* Best (pitch, offset) for one axis: the one whose boundaries sit in the gaps. */
	function searchAxis(profile, count, pitchHint, offsetHint) {
		var lo = pitchHint * (1 - PITCH_TOLERANCE);
		var hi = pitchHint * (1 + PITCH_TOLERANCE);
		var pitchStep = Math.max(0.25, pitchHint / 200);
		var slack = pitchHint * MAX_OFFSET_SHIFT;
		var best = null;
		var scale = 0;

		for (var p = 0; p < profile.length; p++) {
			scale += profile[p];
		}
		scale = scale / Math.max(profile.length, 1) || 1;

		for (var pitch = lo; pitch <= hi; pitch += pitchStep) {
			var span = pitch * count;
			if (span > profile.length) {
				continue;
			}
			var from = Math.max(0, offsetHint - slack);
			var to = Math.min(profile.length - span, offsetHint + slack);

			for (var offset = from; offset <= to; offset += 0.5) {
				var energy = boundaryEnergy(profile, pitch, offset, count);
				// nudge towards the drawn box so equal-looking grids do not slip a cell
				var drift = Math.abs(offset - offsetHint) / Math.max(pitchHint, 1) +
					Math.abs(pitch - pitchHint) / Math.max(pitchHint, 1);
				energy += drift * HINT_BIAS * scale;

				if (!best || energy < best.energy) {
					best = { pitch: pitch, offset: offset, energy: energy };
				}
			}
		}

		return best;
	}

	/*
	 * rgba/width/height: the whole screenshot. box: the drawn hint, in image
	 * pixels. Returns a box snapped onto the grid, or the original if the search
	 * found nothing usable.
	 */
	function refineGrid(rgba, width, height, box, columns, rows) {
		var pitchX = box.w / columns;
		var pitchY = box.h / rows;

		var region = {
			x: Math.max(0, Math.round(box.x - pitchX * SEARCH_MARGIN)),
			y: Math.max(0, Math.round(box.y - pitchY * SEARCH_MARGIN)),
			w: 0,
			h: 0
		};
		region.w = Math.min(width - region.x, Math.round(box.w + pitchX * SEARCH_MARGIN * 2));
		region.h = Math.min(height - region.y, Math.round(box.h + pitchY * SEARCH_MARGIN * 2));

		if (region.w < columns * 4 || region.h < rows * 4) {
			return box;
		}

		var profiles = gradientProfiles(rgba, width, height, region);
		var x = searchAxis(profiles.columns, columns, pitchX, box.x - region.x);
		var y = searchAxis(profiles.rows, rows, pitchY, box.y - region.y);

		if (!x || !y) {
			return box;
		}

		return {
			x: region.x + x.offset,
			y: region.y + y.offset,
			w: x.pitch * columns,
			h: y.pitch * rows
		};
	}

	/*
	 * Nudges a box whose slots are NOT a uniform grid - worn equipment, whose rows
	 * are spread to different widths - so that each slot's contents sit centred in
	 * the region read from it.
	 *
	 * The grid search above cannot be used, because the equipment panel draws each
	 * slot on its own lighter square: its strongest edges lie ON the cell
	 * boundaries rather than in the gaps, which inverts that objective. Instead
	 * this scores an alignment by how much of each slot's detail falls in the
	 * middle of the slot rather than around its edge, which is what being
	 * correctly centred means.
	 *
	 * `rects(box)` returns the image-space rectangle of every slot for a box.
	 */
	function refineSlotBox(rgba, width, height, box, probes) {
		var OFFSETS = [];
		for (var o = -16; o <= 16; o += 2) {
			OFFSETS.push(o);
		}
		var SCALES = [];
		for (var sc = 0.90; sc <= 1.1001; sc += 0.01) {
			SCALES.push(sc);
		}

		var energy = energyMap(rgba, width, height);
		var factor = 2;
		var small = reduce(energy, width, height, factor);
		var ii = integralOf(small);
		var best = null;

		for (var si = 0; si < SCALES.length; si++) {
			for (var yi = 0; yi < OFFSETS.length; yi++) {
				for (var xi = 0; xi < OFFSETS.length; xi++) {
					var scale = SCALES[si];
					var candidate = {
						x: box.x + OFFSETS[xi] + box.w * (1 - scale) / 2,
						y: box.y + OFFSETS[yi] + box.h * (1 - scale) / 2,
						w: box.w * scale,
						h: box.h * scale
					};
					var s = slotCentringScore(ii, factor, probes(candidate).slots);
					if (!best || s > best.score) {
						best = { score: s, box: candidate };
					}
				}
			}
		}

		return best ? best.box : box;
	}

	// ---------------------------------------------------------------- detection

	/*
	 * Finding the grid with no hint at all needs a different objective from the
	 * snapper above. Minimising boundary energy works once you are already close,
	 * but it is degenerate across a whole screenshot: any blank stretch of wall
	 * has no boundary energy whatsoever and scores perfectly. A global search has
	 * to also require that something is actually THERE - detail inside the cells,
	 * quiet seams between them.
	 *
	 * The search runs coarse-to-fine over a heavily reduced copy of the image,
	 * using an integral image so each cell's mean costs four lookups, and the
	 * winner is then handed to refineGrid to polish the pitch.
	 */

	var SLOT_INTERIOR = 0.22;     // how far in from a slot's edge to measure
	var GAP_TOLERANCE = 5;        // keeps a flat region from dividing by ~nothing

	/*
	 * Scores a candidate placement of a fixed slot layout - worn equipment.
	 *
	 * The panel is the one place where EVERY slot holds something and EVERY hole
	 * between them is empty, so the quietest slot and the busiest hole decide it,
	 * not averages. Measured on a real screenshot the true panel scores its
	 * quietest slot at 22.8 against a busiest hole of 6.9, while the patch of chat
	 * text that otherwise wins manages 9.9 against 44.9 - by the averages the chat
	 * text looks better, by these it loses by a factor of thirteen.
	 */
	function slotFitScore(ii, factor, found) {
		function content(rect) {
			var x0 = rect.x / factor, y0 = rect.y / factor;
			var x1 = (rect.x + rect.w) / factor, y1 = (rect.y + rect.h) / factor;
			return meanRect(ii,
				x0 + (x1 - x0) * SLOT_INTERIOR, y0 + (y1 - y0) * SLOT_INTERIOR,
				x1 - (x1 - x0) * SLOT_INTERIOR, y1 - (y1 - y0) * SLOT_INTERIOR);
		}

		var quietestSlot = Infinity, busiestGap = 0, i;
		for (i = 0; i < found.slots.length; i++) {
			quietestSlot = Math.min(quietestSlot, content(found.slots[i]));
		}
		for (i = 0; i < found.gaps.length; i++) {
			busiestGap = Math.max(busiestGap, content(found.gaps[i]));
		}
		return isFinite(quietestSlot) ? quietestSlot / (busiestGap + GAP_TOLERANCE) : 0;
	}

	/*
	 * Fine alignment wants a different measure from detection. The quietest-slot
	 * score above is what finds the panel, but it is not smooth: it can be
	 * improved by sliding the box so slots swallow more of whatever is nearby.
	 * Centring asks the gentler question - is each slot's content in the MIDDLE of
	 * the slot rather than spilling over its edge - which has its maximum exactly
	 * where the slot really is.
	 */
	function slotCentringScore(ii, factor, slots) {
		var total = 0;

		for (var i = 0; i < slots.length; i++) {
			var r = slots[i];
			var x0 = r.x / factor, y0 = r.y / factor;
			var x1 = (r.x + r.w) / factor, y1 = (r.y + r.h) / factor;
			var inx = (x1 - x0) * SLOT_INTERIOR, iny = (y1 - y0) * SLOT_INTERIOR;

			var whole = meanRect(ii, x0, y0, x1, y1);
			var inner = meanRect(ii, x0 + inx, y0 + iny, x1 - inx, y1 - iny);
			var wholeArea = Math.max((x1 - x0) * (y1 - y0), 1e-6);
			var innerArea = Math.max((x1 - x0 - 2 * inx) * (y1 - y0 - 2 * iny), 1e-6);
			var ringArea = Math.max(wholeArea - innerArea, 1e-6);
			var ring = (whole * wholeArea - inner * innerArea) / ringArea;

			total += inner - ring;
		}

		return total;
	}

	var CELL_INTERIOR = 0.62;     // share of a cell treated as its inside
	var SEAM_WEIGHT = 1.6;
	var MIN_PITCH = 24;           // a cell smaller than this is not a bank slot
	var PITCH_SAMPLES = 44;
	var CELL_RATIOS = [1.05, 1.166, 1.28];   // icons are wider than tall

	function energyMap(rgba, width, height) {
		var map = new Float32Array(width * height);
		for (var y = 0; y < height - 1; y++) {
			for (var x = 0; x < width - 1; x++) {
				var i = (y * width + x) * 4;
				var right = (y * width + x + 1) * 4;
				var down = ((y + 1) * width + x) * 4;
				var e = 0;
				for (var c = 0; c < 3; c++) {
					e += Math.abs(rgba[right + c] - rgba[i + c]) +
						Math.abs(rgba[down + c] - rgba[i + c]);
				}
				map[y * width + x] = e;
			}
		}
		return map;
	}

	function reduce(map, width, height, factor) {
		var w = Math.floor(width / factor), h = Math.floor(height / factor);
		var out = new Float32Array(w * h);
		for (var y = 0; y < h; y++) {
			for (var x = 0; x < w; x++) {
				var sum = 0;
				for (var dy = 0; dy < factor; dy++) {
					for (var dx = 0; dx < factor; dx++) {
						sum += map[(y * factor + dy) * width + x * factor + dx];
					}
				}
				out[y * w + x] = sum / (factor * factor);
			}
		}
		return { data: out, w: w, h: h };
	}

	function integralOf(small) {
		var w = small.w, h = small.h;
		var table = new Float64Array((w + 1) * (h + 1));
		for (var y = 0; y < h; y++) {
			var run = 0;
			for (var x = 0; x < w; x++) {
				run += small.data[y * w + x];
				table[(y + 1) * (w + 1) + x + 1] = table[y * (w + 1) + x + 1] + run;
			}
		}
		return { table: table, w: w, h: h };
	}

	/* Mean energy over a rectangle, clamped to the image. */
	function meanRect(ii, x0, y0, x1, y1) {
		x0 = Math.max(0, Math.min(ii.w, Math.round(x0)));
		x1 = Math.max(0, Math.min(ii.w, Math.round(x1)));
		y0 = Math.max(0, Math.min(ii.h, Math.round(y0)));
		y1 = Math.max(0, Math.min(ii.h, Math.round(y1)));
		if (x1 <= x0 || y1 <= y0) {
			return 0;
		}
		var stride = ii.w + 1;
		var sum = ii.table[y1 * stride + x1] - ii.table[y0 * stride + x1] -
			ii.table[y1 * stride + x0] + ii.table[y0 * stride + x0];
		return sum / ((x1 - x0) * (y1 - y0));
	}

	function gridScore(ii, ox, oy, pitchX, pitchY, columns, rows) {
		var interior = 0, seam = 0, r, c;

		for (r = 0; r < rows; r++) {
			for (c = 0; c < columns; c++) {
				var cx = ox + (c + 0.5) * pitchX;
				var cy = oy + (r + 0.5) * pitchY;
				interior += meanRect(ii,
					cx - pitchX * CELL_INTERIOR / 2, cy - pitchY * CELL_INTERIOR / 2,
					cx + pitchX * CELL_INTERIOR / 2, cy + pitchY * CELL_INTERIOR / 2);
			}
		}
		for (c = 0; c <= columns; c++) {
			seam += meanRect(ii, ox + c * pitchX - 1, oy, ox + c * pitchX + 1, oy + rows * pitchY);
		}
		for (r = 0; r <= rows; r++) {
			seam += meanRect(ii, ox, oy + r * pitchY - 1, ox + columns * pitchX, oy + r * pitchY + 1);
		}

		return interior / (columns * rows) - SEAM_WEIGHT * seam / (columns + rows + 2);
	}

	function sweepGrid(ii, columns, rows, pitches, originStep, bounds) {
		var best = null;

		for (var p = 0; p < pitches.length; p++) {
			var pitchX = pitches[p].x, pitchY = pitches[p].y;
			var spanX = columns * pitchX, spanY = rows * pitchY;
			if (spanX > ii.w || spanY > ii.h) {
				continue;
			}
			var fromX = bounds ? Math.max(0, bounds.x0) : 0;
			var toX = bounds ? Math.min(ii.w, bounds.x1) : ii.w;
			var fromY = bounds ? Math.max(0, bounds.y0) : 0;
			var toY = bounds ? Math.min(ii.h, bounds.y1) : ii.h;

			for (var ox = fromX; ox + spanX <= toX; ox += originStep) {
				for (var oy = fromY; oy + spanY <= toY; oy += originStep) {
					var s = gridScore(ii, ox, oy, pitchX, pitchY, columns, rows);
					if (!best || s > best.score) {
						best = { score: s, x: ox, y: oy, pitchX: pitchX, pitchY: pitchY };
					}
				}
			}
		}

		return best;
	}

	/* Finds a columns x rows item grid anywhere in the image. */
	function detectGrid(rgba, width, height, columns, rows) {
		var energy = energyMap(rgba, width, height);
		var coarseFactor = 8;
		var coarse = reduce(energy, width, height, coarseFactor);
		var coarseII = integralOf(coarse);

		var maxPitch = Math.min(width / columns, height / rows);
		if (maxPitch < MIN_PITCH) {
			return null;
		}

		var pitches = [];
		for (var i = 0; i < PITCH_SAMPLES; i++) {
			var full = MIN_PITCH + (maxPitch - MIN_PITCH) * i / (PITCH_SAMPLES - 1);
			for (var r = 0; r < CELL_RATIOS.length; r++) {
				pitches.push({ x: full / coarseFactor, y: full / CELL_RATIOS[r] / coarseFactor });
			}
		}

		var coarseBest = sweepGrid(coarseII, columns, rows, pitches, 1, null);
		if (!coarseBest) {
			return null;
		}

		// Refine on a less reduced copy, around the coarse winner.
		var fineFactor = 2;
		var fine = reduce(energy, width, height, fineFactor);
		var fineII = integralOf(fine);
		var scale = coarseFactor / fineFactor;
		var cx = coarseBest.x * scale, cy = coarseBest.y * scale;
		var cpx = coarseBest.pitchX * scale, cpy = coarseBest.pitchY * scale;

		var finePitches = [];
		for (var dx = -4; dx <= 4; dx += 1) {
			for (var dy = -4; dy <= 4; dy += 1) {
				finePitches.push({ x: cpx + dx, y: cpy + dy });
			}
		}
		var fineBest = sweepGrid(fineII, columns, rows, finePitches, 1, {
			x0: cx - 12, x1: cx + 12 + columns * (cpx + 4),
			y0: cy - 12, y1: cy + 12 + rows * (cpy + 4)
		});
		var winner = fineBest || coarseBest;
		var factor = fineBest ? fineFactor : coarseFactor;

		var box = {
			x: winner.x * factor,
			y: winner.y * factor,
			w: winner.pitchX * columns * factor,
			h: winner.pitchY * rows * factor
		};

		// The global search gets within a few pixels; the profile snapper nails it.
		return refineGrid(rgba, width, height, box, columns, rows);
	}

	/*
	 * The same idea for a layout that is not a grid - worn equipment. Its shape is
	 * fixed, so only position and size are searched, and each slot is scored by
	 * how much more detail sits in its middle than around its edge.
	 */
	/*
	 * `options.iconWidth` is the width, in image pixels, that one item icon should
	 * occupy. Without it there is nothing to say how big the panel is and the
	 * search settles on whatever is busiest - a patch of chat text, typically.
	 * The client draws the inventory and the equipment panel at one size, so the
	 * grid detected in the inventory screenshot supplies it.
	 */
	function detectSlotBox(rgba, width, height, probes, aspect, options) {
		var energy = energyMap(rgba, width, height);
		var factor = 4;
		var small = reduce(energy, width, height, factor);
		var ii = integralOf(small);

		var best = null;
		var minW = Math.max(80, width * 0.06);
		var maxW = Math.min(width, height * aspect);

		var iconWidth = options && options.iconWidth;
		if (iconWidth) {
			// box.w * slotWidthFraction * iconInset = iconWidth
			var expected = iconWidth / (options.slotWidthFraction * options.iconInset);
			minW = Math.max(minW, expected * 0.85);
			maxW = Math.min(maxW, expected * 1.15);
		}
		if (maxW <= minW) {
			return null;
		}
		var widthStep = Math.max(2, (maxW - minW) / 40);

		for (var w = minW; w <= maxW; w += widthStep) {
			var h = w / aspect;
			if (h > height) {
				continue;
			}
			var step = Math.max(3, w / 48);
			for (var x = 0; x + w <= width; x += step) {
				for (var y = 0; y + h <= height; y += step) {
					var box = { x: x, y: y, w: w, h: h };
					var s = slotFitScore(ii, factor, probes(box));
					if (!best || s > best.score) {
						best = { score: s, box: box };
					}
				}
			}
		}

		return best ? refineSlotBox(rgba, width, height, best.box, probes) : null;
	}

	return {
		PITCH_TOLERANCE: PITCH_TOLERANCE,
		refineGrid: refineGrid,
		refineSlotBox: refineSlotBox,
		detectGrid: detectGrid,
		detectSlotBox: detectSlotBox
	};
}));
