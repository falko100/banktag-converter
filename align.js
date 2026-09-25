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
	function refineSlotBox(rgba, width, height, box, rects) {
		var OFFSETS = [-12, -9, -6, -3, 0, 3, 6, 9, 12];
		var SCALES = [0.94, 0.97, 1, 1.03, 1.06];
		var best = null;

		function detail(rect) {
			// Compare mean absolute deviation in the middle against the border.
			var samples = 8;
			var inner = 0, outer = 0, innerN = 0, outerN = 0;
			var mean = 0, n = 0;
			var values = [];

			for (var sy = 0; sy < samples; sy++) {
				for (var sx = 0; sx < samples; sx++) {
					var px = Math.round(rect.x + (sx + 0.5) * rect.w / samples);
					var py = Math.round(rect.y + (sy + 0.5) * rect.h / samples);
					if (px < 0 || py < 0 || px >= width || py >= height) {
						values.push(null);
						continue;
					}
					var i = (py * width + px) * 4;
					var v = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
					values.push(v);
					mean += v;
					n++;
				}
			}
			if (!n) {
				return 0;
			}
			mean /= n;

			for (var k = 0; k < values.length; k++) {
				if (values[k] === null) {
					continue;
				}
				var gx = k % samples, gy = Math.floor(k / samples);
				var edge = gx === 0 || gy === 0 || gx === samples - 1 || gy === samples - 1;
				var deviation = Math.abs(values[k] - mean);
				if (edge) { outer += deviation; outerN++; } else { inner += deviation; innerN++; }
			}

			return (innerN ? inner / innerN : 0) - (outerN ? outer / outerN : 0);
		}

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

					var score = 0;
					var list = rects(candidate);
					for (var r = 0; r < list.length; r++) {
						score += detail(list[r]);
					}
					if (!best || score > best.score) {
						best = { score: score, box: candidate };
					}
				}
			}
		}

		return best ? best.box : box;
	}

	return {
		PITCH_TOLERANCE: PITCH_TOLERANCE,
		refineGrid: refineGrid,
		refineSlotBox: refineSlotBox
	};
}));
