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
| `align.js` | Finds the item grid in a screenshot, from scratch |
| `gear.js` | Equipment + inventory to bank grid positions |
| `tools/` | Rebuilds the item signature database |
| `data/` | The item signature database (gzipped, unpacked in the browser) |

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

## Screenshot reader

`setup.html` reads a gear setup from two phone screenshots — worn equipment and
inventory — matches every slot against the full item list, and lays the result out
as a bank tag. **Both grids are found automatically**: choose two screenshots and
nothing needs dragging. A box can still be drawn by hand if a crop looks off, and
it snaps to the nearest grid.

**It is an assistant, not an oracle.** On a real screenshot an inventory reads
fairly well: consumables, food and runes usually come out right. Worn equipment is
weaker — each slot is narrowed to items that can actually be worn there, so the
answer is always a real helmet or a real ring, but often the wrong one, with the
right answer frequently second. Every slot is clickable and the unsure ones are
outlined.

### What was measured

Most of this was counter-intuitive, and none of it showed up against synthetic
test images — only against real phone screenshots:

- **Alignment dominates.** Shifting the grid by 12px — an eighth of a cell — moved
  the correct item from rank 2491 to rank 1 and cut its fit error from 62 to 26.
  No hand-drawn box is that accurate, so `align.js` measures the grid from the
  image instead of trusting the box. Gradient profiles find it reliably, but are
  periodic, so the offset search is anchored near the drawn box or it slips a
  whole row.
- **A cell is bigger than the icon in it.** Measured: a potion 51×69px in a cell of
  98.5×84.5, against reference artwork of 22×31 inside a 36×32 frame. The icon
  frame covers ~84% of the cell. Cropping the whole cell shrinks and pads the
  item, and matching does not survive that. A sweep confirmed 0.84 is optimal.
- **A screenshot is softer than the artwork.** It is upscaled from the game's own
  rendering, so comparing it against crisp reference icons charges an error along
  every edge. Blurring the prediction to match cut fit errors by about a quarter
  and cleaned up whole families of answers.
- **How common an item is matters as much as how it looks.** Obscure lookalikes
  kept winning by a hair — a herblore intermediate beat Super restore(4) by 2.0,
  "Kuhu essence" beat Blood rune by 0.7. Every false winner was untradeable and
  every true item tradeable, so grand exchange presence graded by trade volume
  separates them. This one change turned an unreadable inventory into a correct
  one.
- **The equipment interface is not a grid.** Its weapon/body/shield and
  hands/feet/ring rows are spread wider (pitch 130px) than cape/neck/ammo (94px).
  A uniform 3×5 grid crops the outer columns off their items no matter how it is
  placed. The measured layout lives in `gear.js`.
- **Equipment slots are the strongest constraint there is.** A head slot holds one
  of ~800 helmets rather than one of 15,398 items. Taken from the wiki's own
  category listings, this alone turned equipment from nonsense into plausible
  gear.
- **Shape must be compared, but not absolutely.** Colour alone ranks the right
  item first 0% of the time. On a real varying background, though, everything
  differing from the median background reads as foreground, so apparent coverage
  (0.55) far exceeds the icon's real coverage (0.36).
- **Some things did not help**, and are recorded so they are not retried:
  bounding-box normalisation (worse), centroid alignment (offsets were already
  zero), background estimated from corners or the whole crop rather than the
  border ring (no change), and widening full-resolution re-scoring from 8 to 600
  candidates (identical answers — the shortlist was never the bottleneck).

### Finding the grid without being told where it is

Detection needs a different objective from the snapper that polishes a drawn box.
Minimising boundary energy is fine once you are close, but across a whole
screenshot it is degenerate — a blank stretch of wall has no boundary energy at
all and scores perfectly. A global search also has to require that something is
actually there: detail inside the cells, quiet seams between them. That, searched
coarse-to-fine over a reduced copy with an integral image, lands within a pixel or
two of the truth on a 2556×1179 screenshot in under two seconds, and `refineGrid`
then nails the pitch.

The equipment panel needs yet another objective, because it is not a grid and its
slot squares put the strongest edges *on* the boundaries rather than in the gaps.
What makes it recognisable is its four holes — beside the head slot and beside the
legs slot — where nothing is ever drawn. So it is found by the quietest slot and
the busiest hole rather than by averages: on a real screenshot the true panel
scores 22.8 against 6.9, while the patch of chat text that otherwise wins manages
9.9 against 44.9. By the averages the chat text looks better; by these it loses by
a factor of thirteen. That measure finds the panel but is too jagged to align it,
so a gentler centring score does the final nudge.

Scale is the one thing the equipment search cannot pin down alone. The client
draws both panels at the same size, so the pitch measured in the inventory
screenshot tells it how big an equipment slot must be, and the equipment search is
redone once the inventory has been read.

### Known gaps

- Empty equipment slots draw a grey placeholder silhouette, which has real
  foreground, so they read as an item rather than as empty.
- Stacked items carry quantity text drawn over the icon, which corrupts the crop —
  the two runes in the test screenshot score far worse than everything else.
- Fine detail still separates poorly: a capped potion can score worse than an
  otherwise identical capless one.
- Equipment detection reliably finds the panel but lands a few percent off on
  size, which costs accuracy in a half that was already the weaker one. Dragging
  the box by hand there still does better.

## Deploying

The site is hosted on Netlify from the repo root with no build step. The current deploy
was uploaded manually, so it is **not** yet wired to this repository — pushing to `main`
will not redeploy on its own until the project is linked to GitHub in the Netlify UI.
