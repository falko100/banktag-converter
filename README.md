# Bank Tag Converter

Converts a **RuneLite** bank tag export into the layout string the **official Old School
RuneScape client and mobile** expect.

**Live: <https://banktag-converter.netlify.app>**

Or open `index.html` in a browser. No build step, no dependencies, no server — it runs
straight from the filesystem or any static host.

```
in   banktags,1,hydra rl,952,layout,1,23075,4,27281
out  1,2,23075,1,0,27281,4,0
```

## The formats

**RuneLite** (`Bank Tags` plugin, right-click a tag tab → Export):

```
banktags,<version>,<name>,<iconId>,<taggedItemId>*[,layout(,<position>,<itemId>)*]
```

A `position` is a 0-based index into the bank grid, which is **8 columns wide**. When the
export has no `,layout` section the tag has no custom layout, so the tagged items are
placed in export order starting at position 0 — the same thing you see in game.

geheur's **Bank Tag Layouts** plugin exports a different shape, which is also accepted:

```
banktaglayoutsplugin:<name>,(<itemId>:<position>)*,banktag:<name>,<iconId>,<itemId>*
```

**Official client / mobile:**

```
1,<itemCount>(,<itemId>,<column>,<row>)*
```

So the conversion is `column = position % 8` and `row = floor(position / 8)`, with the
item count in the header. In the example above, position 1 becomes column 1 row 0, and
position 4 becomes column 4 row 0.

The **tag name and icon are not carried by the output string** — the official client asks
for those when you create the tab, so the page shows you the name and icon item id from
the RuneLite export to copy across by hand.

## Behaviour worth knowing

- **Negative item ids** mark item variants in RuneLite (`-952` means "any variant of
  952") and are mapped onto their positive id.
- **`-1` and `0`** are empty-slot markers and are dropped rather than being turned into
  item id 1.
- **Duplicate positions** keep the later entry; **duplicate items** in an unlaid-out tag
  are placed once.
- **Several tags at once**: paste one export per line and each is converted separately.
- Pasting a string that is *already* in the official format is detected and reported
  instead of being mangled.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The page |
| `styles.css` | Styling |
| `converter.js` | The conversion itself — pure, no DOM, usable from Node too |
| `app.js` | Wires the page to the converter |
| `converter.test.js` | Tests |
| `netlify.toml` | Netlify config — publishes the repo root, sets security headers |
| `setup.html` / `setup.js` | Screenshot reader (experimental) |
| `matcher.js` | Item recognition from a slot crop |
| `align.js` | Finds the real item grid in a screenshot |
| `gear.js` | Equipment + inventory to bank grid positions |
| `tools/` | Rebuilds the item signature database |
| `data/` | The item signature database |

## Tests

```
node --test
```

## Format reference

The output format was cross-checked against the OSRS Wiki's own converter gadget,
[`MediaWiki:Gadget-banktag-converter-core.js`](https://oldschool.runescape.wiki/wiki/MediaWiki:Gadget-banktag-converter-core.js),
linked from the wiki's [Bank tags](https://oldschool.runescape.wiki/w/Bank_tags) page.

Item images are loaded from `static.runelite.net`; when they are unavailable the page
falls back to showing the raw item id in each slot.

## Screenshot reader (experimental, not working well)

`setup.html` reads a gear setup from two phone screenshots — worn equipment and
inventory — matches every slot against the full item list, and lays the result out
as a bank tag. The whole pipeline works: upload, automatic grid detection, crop,
match, per-slot correction with search, and both output formats.

**It is not accurate enough to rely on.** On real screenshots it gets roughly a
quarter to a third of slots right. It usually identifies the *kind* of item
correctly — a crossbow, a pink potion, a fish, a rune pouch — and then picks the
wrong exact item. It is committed as a foundation, not as a finished feature, and
is not deployed.

### What was measured

Worth recording, because most of it is counter-intuitive:

- **Alignment dominates everything.** Shifting the grid by 12px — about an eighth
  of a cell — moved the correct item from rank 2491 to rank 1 and cut its fit
  error from 62 to 26. No hand-drawn box is that accurate, which is why
  `align.js` measures the grid from the image instead of trusting the box.
- **A cell is bigger than the icon in it.** Measured on a real screenshot: a
  potion 51×69px in a cell of 98.5×84.5, against reference artwork of 22×31
  inside a 36×32 frame. The icon frame covers ~84% of the cell across, ~88% down.
  Cropping the whole cell shrinks and pads the item, and matching does not
  survive that.
- **Gradient profiles find the grid** reliably, but are periodic, so the offset
  search has to be anchored near the drawn box or it slips a whole row.
- **Shape must be compared, but not absolutely.** Colour alone ranks the right
  item first 0% of the time. On a real varying background, though, everything
  that differs from the median background reads as foreground, so the query's
  apparent coverage (0.55) far exceeds the icon's real coverage (0.36) and an
  absolute shape comparison punishes the correct item.
- **Widening refinement does not help.** Re-scoring the top 8, 50, 200 or 600
  candidates at full resolution gives the same answer, so the shortlist is not
  the bottleneck — the scoring itself prefers the wrong item.

### What it would take

Fine-detail discrimination is the open problem: a capped potion currently scores
worse than a capless one that is otherwise the same shape and colour. Stacked
items also carry quantity text drawn over the icon, and the equipment panel draws
each slot on its own lighter square, neither of which is modelled.

## Deploying

The site is hosted on Netlify from the repo root with no build step. The current deploy
was uploaded manually, so it is **not** yet wired to this repository — pushing to `main`
will not redeploy on its own until the project is linked to GitHub in the Netlify UI.
