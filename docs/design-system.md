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
narrow-screen compression, and the `tablist` / `tab` roles.

**Takes:** `tabs` (`{ key, label, count?, icon? }`), `activeKey`, `onSelect`,
`ariaLabel`, and `className` for the gap and the margin below — layout only.

**Three screens use it:** Home's Active / Paused / Today, the Recycle Bin's eight record
types, and the Inbox's source filter. It was the same eight-class string written out in
two of those places — once by hand three times over, once through a `.map` — and the
inbox would have been a third copy.

`count` is omitted rather than shown as `(0)` only when it is `undefined`: the Recycle
Bin's tabs have no counts at all, while "All (0)" on an empty inbox is the truth and its
tab has to stay, because it is the way back.

### Narrow screens: compress, do not scroll

**Below `lg`, a tab with an icon shows only that icon and its count.** The full name stays
as `title` and `aria-label`, so the accessible name survives the label being hidden.

This is the **top navigation's** rule and the top navigation's breakpoint, reused rather
than reinvented: the nav carries ten destinations from 640px upward with
`hidden lg:inline` on its labels. If that breakpoint ever moves, both should move
together — `UnderlineTabs.test.jsx` asserts the nav still uses it.

The **count survives the label**, also following the nav: an inbox glyph on its own says
nothing about whether there is anything in it.

⚠️ **Only a tab with an icon compresses.** Without one there would be nothing left to show
— a bare count, or on the Recycle Bin's tabs, which have no counts either, nothing at all.
This is a safety rule for a future caller, not a licence: see below.

The row **wraps** rather than scrolling. It was `overflow-x-auto`, which hides tabs off
the right edge, and a tab you have to discover by swiping is not one tap away. Wrapping is
the nav's own safety net: a wrapped tab is still reachable; a clipped one is not.

### Every tab has an icon

**All three rows, every tab** — Step 22. It was "the inbox has icons and the other two do
not", which meant one row compressed on a phone and two did not: three behaviours where a
shared component was supposed to produce one. `UnderlineTabs.test.jsx` fails on any tab
literal in Alfred.jsx without an `icon:`, `NAV_ITEMS` included.

| row | glyphs | reused or chosen |
|---|---|---|
| Inbox sources | `Inbox` for All, then `SOURCE_GLYPHS` | reused — the nav's Inbox glyph and the one source map |
| Home | Active `Activity`, Paused `Pause`, Today `Sun` | two reused, one chosen |
| Recycle Bin | `OBJECT_ICONS` for six record types, plus `Music` and `Scissors` | six reused, one chosen |

Reused wherever the app already had a glyph for the thing:

- **Active** is `OBJECT_ICONS.execution` — the same pulse the cards inside that tab carry.
- **Paused** is `Pause`, which already means "this is paused" on an execution badge
  (`Pause` beside the word "Paused"). The Pause **button** is the same glyph, which is a
  verb sitting next to a noun — accepted, because the noun is the state the verb produces,
  and nothing else says "set aside" without inventing a meaning.
- The Recycle Bin's six record types are `OBJECT_ICONS` verbatim, so a record looks the
  same here as it does in the nav.

Two are chosen, and named as choices so they are not mistaken for vocabulary:

- **Today** is `Sun`. The two glyphs that already mean "time" both mean something else —
  `Calendar` is the Schedule, `CalendarClock` is an event — and `Sun` is used nowhere else.
- **Snippets** is `Scissors`. ⚠️ The nav has ONE SAM entry and the Recycle Bin has two
  rows for it, so Songs and Snippets would both be `Music`: two identical icons in a row
  that has **no counts**, which below `lg` is all it has. A snippet is a clipping out of a
  song; `Scissors` says so and collides with nothing.

Same test as the source glyphs applies to a replacement: it must not already mean
something else in Alfred, and it must still be legible at 14–16px.

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

### ⚠️ A hand-typed capture is `Send`, the paper aeroplane. Do not change it back.

It has now been three glyphs, and the two that failed each failed for a different reason
— which is why this is written down rather than left to whoever next looks at the icon and
thinks of something nicer.

| glyph | why it was wrong |
|---|---|
| `Pencil` | it is ALSO the edit control on the inbox detail page — the pencil that edits a capture's text. One glyph, two meanings, on adjacent screens. |
| `StickyNote` | a rounded rectangle with a folded corner. At 14px that is nearly indistinguishable from `File`, the ITEM icon — which appears on the same card, two lines below it. |

`Send` survives both tests. It is a **silhouette rather than an outlined rectangle**, so it
stays legible at 14px and cannot be mistaken for the item icon; and nothing else in the app
uses it, so it cannot collide the way the pencil did. It also reads as the gesture: you
typed something and sent it to Alfred, which is exactly what a `manual` capture is.

**The test for a replacement, if there ever is one:** it must not already mean something
else in Alfred, and it must still be distinguishable from `File` at 14px in a card's meta
line. Both previous choices passed a look at 24px and failed in place.

The Capture button in the capture bar carries the **same glyph** before its label, so the
button and the Capture tab are recognisably the same thing. **If one moves, both move** —
they read one entry in `SOURCE_GLYPHS`, which is what made the last two changes one line
each rather than four.

The Inbox source tabs' **All** tab uses `Inbox` — the same glyph the top navigation's
Inbox tab uses (`OBJECT_ICONS.inbox`). Two references rather than one shared export,
because `OBJECT_ICONS` lives in the file that imports the tab logic; a guard in
`inboxSourceTabs.test.js` reads Alfred.jsx and fails if they diverge.

An unrecognised `source_type` folds onto `manual` everywhere — icon, label, tab and
filter — because the column has no constraint in the database and a row has to render as
something. Quietly wrong beats invisible.

---

## Card titles in a list

**`font-medium`, at the body size. Not bold.** `EventCard` on the Schedule is the
reference — `font-medium text-foreground`, with no size of its own — and every list of
cards reads at that weight: items, intentions, memories, contexts.

The inbox's list card shipped `font-bold` in Step 21 and was corrected in Step 22. It was
not wrong in isolation; it was wrong next to everything else, which is the only way this
kind of thing ever goes wrong. `InboxListCard.test.jsx` asserts both halves — that the
card is `font-medium`, and that the Schedule card's class string is still what it was
matched against — so if the reference moves, the copy fails rather than drifting.

`InboxListCard` states `text-base` explicitly where `EventCard` inherits it. Same 16px;
spelled out because the card also states `leading-snug`, which a two-line `line-clamp-2`
title needs and a one-line title does not.

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
