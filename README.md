# Bank Tag Converter

Converts a **RuneLite** bank tag export into the layout string the **official Old School
RuneScape client and mobile** expect.

Open `index.html` in a browser. No build step, no dependencies, no server — it runs
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
