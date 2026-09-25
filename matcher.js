/*
 * Identifies OSRS items in a screenshot slot by comparing it against a database
 * of item icon signatures (see tools/build-icon-db.mjs for how that is built).
 *
 * The hard part is that an item is drawn over whatever is behind it - on mobile
 * that is the 3D world, not a fixed panel colour. So nothing can be compared
 * directly. Instead:
 *
 *   1. The slot's background colour is estimated from its border ring, which is
 *      almost always background rather than item.
 *   2. Each pixel's "foreground-ness" is how far it sits from that background,
 *      giving a rough alpha mask for the query.
 *   3. Candidates are scored on colour (weighted by the reference icon's own
 *      alpha, so only the item's own pixels count) plus a shape term comparing
 *      the two alpha masks.
 *
 * The shape term is not optional. Without it a nearly transparent icon matches
 * everything, because its handful of opaque pixels can always be made to agree -
 * measured over the full database, colour alone ranks the correct item first 0%
 * of the time while still keeping it inside the top 5.
 *
 * Shortlisting from signatures alone gets the right item into the top 25 about
 * 99% of the time but first only ~85%, so `refine` re-scores the shortlist at
 * full resolution by compositing each candidate icon over the estimated
 * background and comparing pixel for pixel.
 */
;(function (root, factory) {
	'use strict';
	var api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.BankTagMatcher = api;
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	var FOREGROUND_DISTANCE = 60;   // colour distance at which a pixel counts as fully item
	var SHAPE_WEIGHT = 0.5;         // relative weight of the alpha/shape term

	/*
	 * Emptiness is judged by how much foreground a slot holds, because that is the
	 * only signal that separates. Measured over a full screenshot: real items read
	 * 0.33 to 0.74, empty slots 0.00 to 0.31 - and the worst empties are the ones
	 * with chat text or bright scenery behind them. Match score and confidence do
	 * NOT separate at all (items score 7.7-17.9, empties 4.5-20.3), so neither is
	 * used for this.
	 *
	 * The two ranges very nearly touch, and a sparse icon over a busy background
	 * can cross over, so there are two marks rather than one: below EMPTY the slot
	 * is taken as empty, and anything below UNCERTAIN is still read but flagged
	 * for a human to confirm.
	 */
	var EMPTY_FOREGROUND = 0.12;
	var UNCERTAIN_FOREGROUND = 0.34;
	var UNCERTAIN_CONFIDENCE = 0.08;
	var SAME_NAME_TOLERANCE = 1.25;

	/*
	 * A screenshot is upscaled from the game's own rendering, so a cropped slot is
	 * softer than the crisp reference artwork. Comparing the two directly charges
	 * an error along every edge - exactly where items differ most - so the
	 * prediction is blurred to match before comparing. Measured on a real
	 * screenshot this cut fit errors by about a quarter across the board.
	 */
	var BLUR_PREDICTION = true;

	/*
	 * Weight given to how commonly an item is actually used (see the database
	 * builder). Obscure lookalikes otherwise win by a hair: a herblore
	 * intermediate beat Super restore(4) by 2.0, and "Kuhu essence" beat Blood
	 * rune by 0.7. At 0.15 those flip to the real items; at 0.30 the prior starts
	 * overriding good matches, so it sits below that.
	 */
	var POPULARITY_WEIGHT = 0.15;

	/* Median colour of the slot's outer ring, used as the background estimate. */
	function estimateBackground(rgba, width, height, ring) {
		ring = ring || Math.max(1, Math.round(Math.min(width, height) * 0.06));
		var channels = [[], [], []];

		for (var y = 0; y < height; y++) {
			for (var x = 0; x < width; x++) {
				var inner = x >= ring && x < width - ring && y >= ring && y < height - ring;
				if (inner) {
					continue;
				}
				var i = (y * width + x) * 4;
				channels[0].push(rgba[i]);
				channels[1].push(rgba[i + 1]);
				channels[2].push(rgba[i + 2]);
			}
		}

		return channels.map(function (values) {
			values.sort(function (a, b) { return a - b; });
			return values.length ? values[values.length >> 1] : 0;
		});
	}

	/*
	 * Builds the query signature. Unlike a reference icon the alpha here is not
	 * known, so it is inferred from distance to the background.
	 */
	function describe(rgba, width, height, cellsX, cellsY, background) {
		var bg = background || estimateBackground(rgba, width, height);
		var sig = new Float32Array(cellsX * cellsY * 4);
		var cellW = width / cellsX, cellH = height / cellsY;

		for (var cy = 0; cy < cellsY; cy++) {
			for (var cx = 0; cx < cellsX; cx++) {
				var r = 0, g = 0, b = 0, alpha = 0, count = 0;
				var x0 = Math.floor(cx * cellW), x1 = Math.floor((cx + 1) * cellW);
				var y0 = Math.floor(cy * cellH), y1 = Math.floor((cy + 1) * cellH);

				for (var y = y0; y < y1; y++) {
					for (var x = x0; x < x1; x++) {
						var i = (y * width + x) * 4;
						var dr = rgba[i] - bg[0], dg = rgba[i + 1] - bg[1], db = rgba[i + 2] - bg[2];
						var a = Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / FOREGROUND_DISTANCE);
						r += rgba[i] * a; g += rgba[i + 1] * a; b += rgba[i + 2] * a;
						alpha += a; count++;
					}
				}

				var k = (cy * cellsX + cx) * 4;
				var weight = Math.max(alpha, 1e-6);
				sig[k] = r / weight;
				sig[k + 1] = g / weight;
				sig[k + 2] = b / weight;
				sig[k + 3] = 255 * alpha / Math.max(count, 1);
			}
		}

		var alphaTotal = 0;
		for (var cell = 0; cell < cellsX * cellsY; cell++) {
			alphaTotal += sig[cell * 4 + 3];
		}

		return {
			signature: sig,
			background: bg,
			foreground: alphaTotal / (cellsX * cellsY) / 255
		};
	}

	/*
	 * Equipment slots, in the order the database encodes them. An item entry is
	 * [id, name, popularity, slot], where slot is 0 for anything that cannot be
	 * worn and otherwise an index into this list, offset by one.
	 */
	var SLOT_ORDER = ['head', 'cape', 'neck', 'ammo', 'weapon', 'body', 'shield', 'legs', 'hands', 'feet', 'ring'];

	/* Popularity is stored 0-255 in the third slot of each item entry. */
	function popularityOf(entry) {
		return entry && entry.length > 2 ? entry[2] / 255 : 0;
	}

	function applyPrior(score, popularity) {
		return score * (1 - POPULARITY_WEIGHT * popularity);
	}

	/* Two separable 3-tap passes, which is close enough to the screenshot's softness. */
	function blur(buffer, width, height) {
		var out = new Float32Array(buffer.length);
		var mid = new Float32Array(buffer.length);
		var x, y, c, d, sum, count, xx, yy;

		for (y = 0; y < height; y++) {
			for (x = 0; x < width; x++) {
				for (c = 0; c < 3; c++) {
					sum = 0; count = 0;
					for (d = -1; d <= 1; d++) {
						xx = x + d;
						if (xx < 0 || xx >= width) { continue; }
						sum += buffer[(y * width + xx) * 3 + c];
						count++;
					}
					mid[(y * width + x) * 3 + c] = sum / count;
				}
			}
		}
		for (y = 0; y < height; y++) {
			for (x = 0; x < width; x++) {
				for (c = 0; c < 3; c++) {
					sum = 0; count = 0;
					for (d = -1; d <= 1; d++) {
						yy = y + d;
						if (yy < 0 || yy >= height) { continue; }
						sum += mid[(yy * width + x) * 3 + c];
						count++;
					}
					out[(y * width + x) * 3 + c] = sum / count;
				}
			}
		}
		return out;
	}

	function scoreAgainst(query, blob, offset, cells) {
		var colour = 0, weightSum = 0, shape = 0;

		for (var c = 0; c < cells; c++) {
			var q = c * 4, r = offset + c * 4;
			var refAlpha = blob[r + 3] / 255;
			var dr = query[q] - blob[r];
			var dg = query[q + 1] - blob[r + 1];
			var db = query[q + 2] - blob[r + 2];
			colour += refAlpha * (dr * dr + dg * dg + db * db);
			weightSum += refAlpha;
			var da = query[q + 3] - blob[r + 3];
			shape += da * da;
		}

		return Math.sqrt(colour / Math.max(weightSum, 1e-6)) +
			SHAPE_WEIGHT * Math.sqrt(shape / cells);
	}

	/*
	 * db: { meta: <data/items.json>, blob: Uint8Array of <data/icons.bin> }
	 * options.slot restricts candidates to items that can be worn in that
	 * equipment slot, which is by far the strongest constraint available when
	 * reading worn equipment - a head slot holds one of ~800 helmets rather than
	 * one of 15,000 items.
	 *
	 * Returns the `limit` best candidates, best first.
	 */
	function rank(db, descriptor, limit, options) {
		var meta = db.meta;
		var cells = meta.cellsX * meta.cellsY;
		var stride = cells * 4;
		var query = descriptor.signature;
		var best = [];
		var worst = Infinity;
		var wantSlot = options && options.slot ? SLOT_ORDER.indexOf(options.slot) + 1 : 0;

		for (var i = 0; i < meta.count; i++) {
			if (wantSlot && meta.items[i][3] !== wantSlot) {
				continue;
			}
			var popularity = popularityOf(meta.items[i]);
			var s = applyPrior(scoreAgainst(query, db.blob, i * stride, cells), popularity);
			if (best.length < limit || s < worst) {
				best.push({
					index: i,
					id: meta.items[i][0],
					name: meta.items[i][1],
					popularity: popularity,
					score: s
				});
				best.sort(function (a, b) { return a.score - b.score; });
				if (best.length > limit) {
					best.pop();
				}
				worst = best[best.length - 1].score;
			}
		}

		return best;
	}

	/*
	 * Re-scores candidates at full resolution: composite the candidate's icon over
	 * the estimated background and measure how far the result is from what the
	 * screenshot actually shows.
	 *
	 * NOT used when reading a screenshot, because measurement says it makes things
	 * worse. It helped on synthetic composites - where the background really is
	 * the flat colour this assumes - but on real screenshots the backdrop is a 3D
	 * world or a textured stone slot square, and modelling it as one colour costs
	 * more than the extra resolution gains. Turning it off moved Blood Moon
	 * chestplate from third to first, Amulet of fury and Dual macuahuitl into
	 * first, and stopped five inventory items being read as their "Blighted"
	 * lookalikes.
	 *
	 * Kept because it is the measurement, and because a caller with a genuinely
	 * flat background can still use it.
	 *
	 * `iconPixels` maps an item id to its raw 36x32 RGBA bytes.
	 */
	function refine(candidates, slotRgba, slotW, slotH, background, iconPixels, iconW, iconH) {
		var scored = candidates.map(function (candidate) {
			var icon = iconPixels[candidate.id];
			if (!icon) {
				return { candidate: candidate, score: Infinity };
			}

			// Composite the candidate over the estimated background, then soften it
			// the way the screenshot softened the real thing.
			var predicted = new Float32Array(iconW * iconH * 3);
			for (var p = 0; p < iconW * iconH; p++) {
				var ii = p * 4;
				var a = icon[ii + 3] / 255;
				for (var c = 0; c < 3; c++) {
					predicted[p * 3 + c] = icon[ii + c] * a + background[c] * (1 - a);
				}
			}
			if (BLUR_PREDICTION) {
				predicted = blur(predicted, iconW, iconH);
			}

			var total = 0, samples = 0;
			for (var y = 0; y < iconH; y++) {
				for (var x = 0; x < iconW; x++) {
					// Nearest-neighbour is enough here; the slot is already icon-sized.
					var sx = Math.min(slotW - 1, Math.floor(x * slotW / iconW));
					var sy = Math.min(slotH - 1, Math.floor(y * slotH / iconH));
					var si = (sy * slotW + sx) * 4;
					var pi = (y * iconW + x) * 3;

					for (var ch = 0; ch < 3; ch++) {
						var diff = slotRgba[si + ch] - predicted[pi + ch];
						total += diff * diff;
						samples++;
					}
				}
			}

			return {
				candidate: candidate,
				score: applyPrior(Math.sqrt(total / Math.max(samples, 1)), candidate.popularity || 0)
			};
		});

		scored.sort(function (a, b) { return a.score - b.score; });

		return scored.map(function (entry) {
			return {
				id: entry.candidate.id,
				name: entry.candidate.name,
				popularity: entry.candidate.popularity || 0,
				score: entry.score,
				shortlistScore: entry.candidate.score
			};
		});
	}

	/*
	 * How much better the winner is than the runner-up, as a fraction. Low values
	 * mean the two candidates look alike and the guess deserves a second look.
	 */
	function confidence(ranked) {
		if (!ranked.length) {
			return 0;
		}
		if (ranked.length < 2 || !isFinite(ranked[1].score)) {
			return 1;
		}
		var best = Math.max(ranked[0].score, 1e-6);
		return Math.max(0, Math.min(1, (ranked[1].score - ranked[0].score) / best));
	}

	/* True when a slot holds so little foreground that it is probably empty. */
	function looksEmpty(descriptor) {
		return !descriptor || descriptor.foreground < EMPTY_FOREGROUND;
	}

	/* True when a result is worth a human glance before it is trusted. */
	function needsReview(descriptor, ranked) {
		if (!descriptor) {
			return true;
		}
		return descriptor.foreground < UNCERTAIN_FOREGROUND ||
			confidence(ranked || []) < UNCERTAIN_CONFIDENCE;
	}

	/*
	 * Several item ids can carry the same name - "Super combat potion(4)" exists
	 * twice with near-identical icons, for instance. Their icons are not
	 * byte-identical so they survive as separate entries, and which one wins is
	 * then down to resampling noise. When the close candidates agree on the name,
	 * prefer the lowest id, which is the original item rather than a later copy.
	 */
	function preferCanonicalName(ranked) {
		if (ranked.length < 2) {
			return ranked;
		}

		var best = ranked[0];
		var limit = best.score * SAME_NAME_TOLERANCE;
		var sameName = ranked.filter(function (candidate) {
			return candidate.name === best.name && candidate.score <= limit;
		});

		if (sameName.length < 2) {
			return ranked;
		}

		var winner = sameName.reduce(function (a, b) { return a.id <= b.id ? a : b; });
		if (winner === best) {
			return ranked;
		}

		return [winner].concat(ranked.filter(function (c) { return c !== winner; }));
	}

	return {
		SLOT_ORDER: SLOT_ORDER,
		FOREGROUND_DISTANCE: FOREGROUND_DISTANCE,
		SHAPE_WEIGHT: SHAPE_WEIGHT,
		POPULARITY_WEIGHT: POPULARITY_WEIGHT,
		EMPTY_FOREGROUND: EMPTY_FOREGROUND,
		UNCERTAIN_FOREGROUND: UNCERTAIN_FOREGROUND,
		looksEmpty: looksEmpty,
		needsReview: needsReview,
		preferCanonicalName: preferCanonicalName,
		estimateBackground: estimateBackground,
		describe: describe,
		rank: rank,
		refine: refine,
		confidence: confidence
	};
}));
