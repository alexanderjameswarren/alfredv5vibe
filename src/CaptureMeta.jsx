/**
 * What a capture is and when it arrived — the two facts every inbox surface
 * shows about a row, and now shows the same way.
 *
 * Moved out of Alfred.jsx by Clipboard Step 17 because the inbox detail page
 * needs all three of these and Alfred.jsx cannot export them to it: the page is
 * imported BY Alfred.jsx, so importing back would be a cycle. One module both
 * import is the alternative to a second copy of the source vocabulary, which is
 * exactly how `clipboard` and `cli` would come to render as a pencil on one
 * screen and correctly on the other.
 */

import { Pencil, Bot, Mail, Paperclip, Terminal, ListChecks } from "lucide-react";

/**
 * A capture's timestamp, in words.
 *
 * Today and yesterday are named rather than dated, because on the inbox those
 * are the two answers that carry meaning — "this is from this morning" versus
 * "this has been sitting here". Anything older gets a weekday and a date.
 */
export function friendlyDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (isToday) return `Today at ${timeStr}`;
  if (isYesterday) return `Yesterday at ${timeStr}`;

  return (
    date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    }) + ` at ${timeStr}`
  );
}

/**
 * How each `source_type` reads when it is spelled out rather than drawn.
 *
 * The words are the design's, not the database's — the detail page shows a pill
 * saying "Claude", not "mcp". Keyed by the stored value so the mapping lives in
 * one place and the column keeps its own vocabulary.
 */
const SOURCE_LABELS = {
  manual: "Capture",
  mcp: "Claude",
  // Clipboard Step 20. A SCHEDULED run, not a conversation — which is why it is a
  // separate source rather than more `mcp`: a task row arrives unenriched and the
  // inbox has to say so and offer something different to do about it.
  task: "Task",
  email: "Email",
  clipboard: "Clipboard",
  cli: "CLI",
};

/**
 * The human name for a source type.
 *
 * Falls back to "Capture" for the same reason SourceIcon falls back to a pencil:
 * nothing constrains `source_type` in the database — no check, no enum — so an
 * unrecognised value is not an error anywhere and has to read as something.
 */
export function sourceLabel(sourceType) {
  return SOURCE_LABELS[sourceType] || SOURCE_LABELS.manual;
}

/**
 * How a capture arrived, as one small glyph.
 *
 * The fallback is `manual`, which means an UNRECOGNISED source_type renders as a
 * pencil rather than as nothing — quietly wrong instead of visibly wrong.
 * Nothing constrains source_type in the database (no check, no enum), so a new
 * writer that forgets to come here is not an error anywhere; it just looks
 * hand-typed. That is the reason to add the icon in the same change as the
 * writer, and the reason `clipboard` and `cli` are here now rather than later.
 */
export function SourceIcon({ sourceType }) {
  const icons = {
    manual: <Pencil className="w-3.5 h-3.5" />,
    mcp: <Bot className="w-3.5 h-3.5" />,
    // A checklist rather than a clock or a calendar: Calendar is already the
    // schedule, CalendarClock is already an event, and this is not a moment in
    // time — it is a named job that ran. Alfred's icon vocabulary is in
    // Alfred.jsx's OBJECT_ICONS; these five are the SOURCE vocabulary, which is a
    // different question ("how did this arrive") and deliberately separate.
    task: <ListChecks className="w-3.5 h-3.5" />,
    email: <Mail className="w-3.5 h-3.5" />,
    // Alfred Clipboard — spec 4.3.
    clipboard: <Paperclip className="w-3.5 h-3.5" />,
    cli: <Terminal className="w-3.5 h-3.5" />,
  };
  return <span title={`Source: ${sourceType || "manual"}`}>{icons[sourceType] || icons.manual}</span>;
}
