import React from "react";
import {
  Activity,
  House,
  Inbox,
  FolderOpen,
  Calendar,
  CalendarClock,
  Navigation2,
  File,
  Layers,
  Music,
  Timer,
  Gamepad2,
  Wallet,
  MessageSquareText,
} from "lucide-react";

// --- Alfred's icon vocabulary (Step 12.10) ----------------------------------
//
// ONE map, so a context looks like a context wherever you meet it: in the nav,
// on a pinned card, at the top of its own page, and on a chip inside an event.
//
// Before this the only icons in the app lived inside the mobile drawer's own
// array and nothing else referenced them. That is exactly how Intentions came
// to be a lightbulb in the menu while its chip was something else entirely —
// two vocabularies, neither aware of the other. A second list is the bug.
//
// Keyed by OBJECT, not by view: "item" rather than "memories", because what
// the reader is identifying is the record, not the screen it happens to be on.
// The Memories tab therefore carries the item glyph, and the Schedule tab the
// schedule glyph, while a single event carries its own. The two entries that
// are screens rather than objects — home and inbox — live here too, because
// the nav needs them and there is no second place for them to go.
export const OBJECT_ICONS = {
  home: House,
  inbox: Inbox,
  context: FolderOpen,
  schedule: Calendar,
  event: CalendarClock,
  intention: Navigation2,
  item: File,
  collection: Layers,
  // A run of an event. Deliberately NOT a play triangle: bare Play is already
  // the Start/Continue BUTTON on every event row, so a play-ish glyph beside
  // the title would put a near-twin of a control next to the thing the control
  // acts on. A pulse says "live" and collides with nothing.
  execution: Activity,
  // A note on an item, intention or execution (Restructure P2). Not StickyNote:
  // at 14px that reads as File, the item glyph (design-system.md, source icons).
  note: MessageSquareText,
  timer: Timer,
  sam: Music,
  games: Gamepad2,
  money: Wallet,
};

/**
 * The glyph for one of Alfred's objects.
 *
 * The size is passed in rather than fixed, because the same glyph appears at
 * three scales: 14px on an event-card chip, 16px in the nav and on a card row,
 * and 24px beside a page title. `aria-hidden` on all of them — every one of
 * these sits next to the name it illustrates, so announcing it would just read
 * the same thing twice.
 *
 * `align="first-line"` is for a glyph that leads a title which can WRAP. The
 * default centring is right for a nav tab or a chip, where there is exactly
 * one line; on a card whose name runs to three, it floats the glyph down to
 * the vertical middle of the paragraph, where it stops looking attached to the
 * name at all. Pairs with `items-start` on the row.
 *
 * The offset is in `em` deliberately: it has to hold at 14px on an event row
 * and at 24px on a page header, and one fixed pixel value cannot do both.
 * 0.2em lands within half a pixel of true first-line centring at every size
 * these titles actually use.
 */
export default function ObjectIcon({ type, className = "w-4 h-4", align = "center" }) {
  const Glyph = OBJECT_ICONS[type];
  if (!Glyph) return null;
  const offset = align === "first-line" ? " mt-[0.2em]" : "";
  return <Glyph className={`${className} shrink-0${offset}`} aria-hidden="true" />;
}
