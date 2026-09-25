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

	return {
		PITCH_TOLERANCE: PITCH_TOLERANCE,
		refineGrid: refineGrid
	};
}));
