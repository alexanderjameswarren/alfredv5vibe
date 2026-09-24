# Alfred's design system

Started 2026-09-24. Four shared components so far. This will grow into the full
contract; for now it records what exists and the rules that go with them.

## Why this file exists

Four full-screen edit forms had drifted into three corner radii, three shadows, three
paddings and two ways of spelling white — and the drift was not only cosmetic. A pinned
footer stretches to its card's edges, so when the two disagreed about the radius, the
footer's square corners painted over the card's rounded ones. That defect was fixed
three times in a row and each fix reached a different subset of the screens, because
there was nothing for them to share.

The lesson is not "be more careful". It is that a value used by two components has to
live in one of them.

---

## The rule

**A form that owns the screen renders `EditCard`, and its action buttons go in a
`PinnedFooter` inside it.** Neither states a border, a radius, a shadow, a padding or an
offset. If a screen needs to state one of those, that is a signal the component is
wrong, not the screen.

This covers the four full-screen edit forms:

| screen | component |
|---|---|
| Inbox detail page | `InboxDetailView` |
| Item edit | `ItemCard`, editing |
| Intention edit | `IntentionCard`, editing |
| Context add / edit, full-screen | `ContextForm` with `stickyFooter` |

Deliberately **not** covered, and not to be converted without a reason: cards in lists
(`EventCard`, `ItemCard` and `IntentionCard` in their display modes) and the Context
form when it renders as a panel on the context detail page. Those are not full-screen
forms and a pinned footer would hover over content it does not belong to.

`src/EditCard.test.jsx` enforces the rule: it fails if a fifth call site appears, if one
of the four stops using the card, if a call site tries to restyle it through
`className`, or if the retired class lists come back.

---

## `EditCard` — `src/EditCard.jsx`

**Owns:** border, corner radius, shadow, surface and padding.
Currently `bg-card border-2 border-primary rounded-lg shadow-md p-4 sm:p-6`.

**Also owns the two numbers its footer depends on**, and hands them down through
context so no screen states either:

- `EDIT_CARD_INSET` — the card's padding in px, `[16, 24]`. The footer cancels exactly
  this much margin to reach the card's edges.
- `EDIT_CARD_FOOTER_RADIUS` — `rounded-b-lg`, matching the card's `rounded-lg`, so a
  released footer rounds where the card rounds.

**Takes from the caller:** `className`, for layout only — width, centring, how children
are stacked.

**Why `rounded-lg` and not `rounded-xl`:** `rounded-xl` appeared 0 times in Alfred.jsx
and `rounded-lg` 92; `shadow-md` 53 times against `shadow-lg`'s 4. Three of the four
cards were already `rounded-lg shadow-md`. Adopting the inbox detail page's `rounded-xl`
would have made these four agree with each other and disagree with every other card in
the app.

**Why the card does not clip its contents:** `overflow: clip` would be the general fix
for a child painting over a corner, and unlike `overflow: hidden` it does not break
`position: sticky`. It would also clip `RecurrenceQuickSelect`'s and `ItemPicker`'s
absolutely-positioned dropdowns, both of which open near the bottom of the intention edit
form. Matching the footer's radius to the card's fixes the one element that is actually
stretched to the edges, and clips nothing.

---

## `PinnedFooter` — `src/PinnedFooter.jsx`

The row of Save / Cancel / Archive-style buttons that sits flush on the Capture bar while
the page scrolls and releases at the bottom to sit at the end of its card.

**Owns:** the sticky offset, the margins that reach the container's edges, equal space
above and below the buttons (`PINNED_FOOTER_PAD_Y`, one constant applied to both sides),
the top border, and the flex row.

**Takes from the caller:** `pinned` (false for a panel rather than a full-screen form),
`unpinnedClassName`, and `className` for the background *only when there is no card* —
the two add-to-collection pages sit on the page background.

**Takes from `EditCard`, through context:** the inset and the bottom radius. A footer
outside any card correctly has nothing to cancel and no corner to match.

### The two constants that are not derived from anything

In `src/index.css`, on `.pinned-footer`:

- **63px / 83px** — the Capture bar's height at its normal, unexpanded size, and so how
  far up the footer sits. 83px is measured; 63px is derived from it by the padding
  differences below `sm`.
- The content wrapper's **`pb-28 sm:pb-32`** is a *different* number doing a different
  job: scroll room, deliberately larger than the bar, because it is what lets the footer
  undock at the bottom of a form. Mirroring the two was the original bug, and cutting the
  padding to the bar's height once killed the release entirely.

### ⚠️ The `!important` on the cancelling margins

`.space-y-3` compiles to
`.space-y-3 > :not([hidden]) ~ :not([hidden]) { margin-bottom: 0 }` — specificity
(0,3,0), because each `:not([hidden])` carries an attribute selector's weight. A utility
class is (0,1,0). So a container's spacing utility silently set the footer's
`margin-bottom` to zero and won, which is what left three screens with their card's
padding stacked under a released footer.

The `!important` is on all three margins, not just the bottom, so the next spacing
utility cannot reopen the hole from another direction. `margin-top` is left alone: the
container's own spacing is what puts the gap above the footer, and that is wanted.

---

## `UnderlineTabs` — `src/UnderlineTabs.jsx`

One row of tab buttons under a hairline, the selected one carrying a brown underline.

**Owns:** the row, the hairline, the underline, the active and hover colours, the
horizontal scroll, and the `tablist` / `tab` roles.

**Takes:** `tabs` (`{ key, label, count?, icon? }`), `activeKey`, `onSelect`,
`ariaLabel`, and `className` for the gap and the margin below — layout only.

**Three screens use it:** Home's Active / Paused / Today, the Recycle Bin's eight record
types, and the Inbox's source filter. It was the same eight-class string written out in
two of those places — once by hand three times over, once through a `.map` — and the
inbox would have been a third copy.

`count` is omitted rather than shown as `(0)` only when it is `undefined`: the Recycle
Bin's tabs have no counts at all, while "All (0)" on an empty inbox is the truth and its
tab has to stay, because it is the way back.

### The rule

**A row of filters that chooses a VIEW of one list is tabs. A row that selects a
PROPERTY of the rows is pills.**

The inbox's source filter was pills — reusing `TagFilter` — and it read wrong: the pills
sat directly above cards carrying real tag pills, so two different things looked
identical. Source is not a property you are picking out of a growing vocabulary; it is
which slice of the inbox you are looking at.

Consequences of being tabs rather than pills, all deliberate:

- the order is **fixed** (All, Capture, Claude, Clipboard, Task, CLI, Email), not
  alphabetical and not by count. Six sources never change, so the row can be learned by
  position; the tag pills sort alphabetically because a tag vocabulary grows and you
  arrive looking for a name.
- there is an explicit **All** tab, where the pills have no "All" and use "nothing
  selected" to mean everything. A tab row with nothing selected has no state to read.
- selection is **single**, which a tab row implies anyway.

`src/utils/inboxSourceTabs.js` holds the order, the visibility rule and the fallback:
a source tab appears only while that source has items, and the selection is **derived**
rather than stored, so processing the last item of a source falls back to All rather than
leaving the list filtered by a tab that is no longer there. Deriving also means an Undo
brings the selection back with the row.

`src/UnderlineTabs.test.jsx` carries the guard: it fails if a fourth call site appears
hand-rolled, or if the retired `pb-2 border-b-2` string comes back.

---

## Source icons — `src/CaptureMeta.jsx`

`SOURCE_GLYPHS` maps a capture's `source_type` to its glyph, and `sourceLabel` to its
name. Both the source tabs and the card meta lines read that one map; a second list is
how `clipboard` once came to render correctly on one screen and as a pencil on the other.

**A hand-typed capture is `StickyNote`, not a pencil.** The pencil is reserved for
EDITING — it is the capture-text pencil on the inbox detail page — and using it for
"typed by hand" as well made one glyph mean two things on adjacent screens. The Capture
button in the capture bar carries the same StickyNote before its label, so the button and
the Capture tab are recognisably the same thing.

An unrecognised `source_type` folds onto `manual` everywhere — icon, label, tab and
filter — because the column has no constraint in the database and a row has to render as
something. Quietly wrong beats invisible.

---

## Tokens

Colours, radii and shadows come from the CSS custom properties in `src/index.css` and the
Tailwind theme that maps them (`tailwind.config.js`). Use the token, not the hex:
`bg-primary`, not `#7A4E37`. Approved designs quoting hex values are describing the
tokens, not overriding them.

Current conventions worth knowing before adding anything:

- radius: `rounded-lg` for cards and buttons, `rounded` for inputs and small chips
- shadow: `shadow-sm` at rest, `shadow-md` for a raised or hovered surface
- touch targets: `min-h-[44px]` on anything tappable
