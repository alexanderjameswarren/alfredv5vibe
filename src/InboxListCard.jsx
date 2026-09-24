/**
 * One capture, as a row in the inbox list — Alfred Clipboard, Step 21.
 *
 * Design: docs/inbox-list-mockups/README.md §4, approved 2026-09-24.
 *
 * ── What it replaces ─────────────────────────────────────────────────────────
 *
 * `InboxCard`, which showed the capture's first 100 characters, a timestamp, a badge
 * and a trash can. Everything else about a capture — what Claude had suggested, which
 * context it would land in, whether it was waiting on anything — could only be seen by
 * opening it. So the list could not be triaged from; it could only be worked through.
 *
 * This card answers "what is this and what happens if I say yes" without opening it,
 * and Process acts on that answer in one tap.
 *
 * ── The three shapes it has ──────────────────────────────────────────────────
 *
 *   ENRICHED, suggesting an item or an intention → a preview line and **Process**,
 *     which files it from Claude's suggestions through the same save path the detail
 *     page uses. See `triageDataForOneTap` for why "one tap" is defined as "open it
 *     and press Process without editing".
 *   A TASK → **Copy**, because a task capture is something a Claude session has to
 *     pick up, and the copied text carries the row's id so that session can archive it
 *     afterwards.
 *   ANYTHING ELSE → no button. Tapping the card opens the detail page, which is where
 *     an unenriched capture has to be dealt with anyway.
 *
 * The trash can is on all three: disposing of a capture you can already read should not
 * require opening a form first, which was Step 5b's reasoning and has not changed.
 */

import { Calendar, Check, Copy, File, FolderOpen, Navigation2, Trash2 } from "lucide-react";
import { friendlyDate, sourceLabel, SourceIcon } from "./CaptureMeta";
import { canProcessInOneTap, isEnriched } from "./utils/inboxSuggestions";

/** A YYYY-MM-DD date, written short ("Thu, Oct 1"). */
function shortDate(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!parts) return null;
  const [, y, m, d] = parts;
  // Field by field, not `new Date(value)`: a bare "2026-10-01" parses as UTC midnight
  // and renders as September 30th in every negative-offset zone.
  const local = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(local.getTime())) return null;
  return local.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/**
 * What the meta line says about where this capture stands.
 *
 * A task reads differently from an unenriched capture even though both are
 * `not_started`, and the difference matters: an unenriched capture is waiting for
 * nothing in particular, while a task is explicitly waiting for a Claude session. Same
 * column, two honest readings of it.
 */
function statusLabel(inboxItem) {
  if (isEnriched(inboxItem)) return "Enriched";
  if (inboxItem.sourceType === "task") return "Needs a Claude session";
  return "Not enriched";
}

/** The beige chip: a context, or a tag. */
function Chip({ icon: Glyph, children, pill = false }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 bg-secondary text-foreground text-xs ${
        pill ? "rounded-full" : "rounded"
      }`}
    >
      {Glyph && <Glyph className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** An unbacked label in its own colour: what triage would create, or when. */
function PreviewMark({ icon: Glyph, tone, children }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${tone}`}>
      <Glyph className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * @param {object}   inboxItem
 * @param {Array}    contexts    To name the suggested context. Only the name is used.
 * @param {Function} onOpen      (id) => void. The whole card, minus the buttons.
 * @param {Function} onProcess   (id) => void. File it from its suggestions.
 * @param {Function} onCopy      (id) => void. Task items only.
 * @param {Function} onDiscard   (id) => void. Archives with reason 'discarded'.
 */
export default function InboxListCard({ inboxItem, contexts = [], onOpen, onProcess, onCopy, onDiscard }) {
  const enriched = isEnriched(inboxItem);
  const canProcess = canProcessInOneTap(inboxItem);
  const isTask = inboxItem.sourceType === "task";

  const contextName = inboxItem.suggestedContextId
    ? contexts.find((c) => c.id === inboxItem.suggestedContextId)?.name
    : null;
  const eventDate = shortDate(inboxItem.suggestedEventDate);
  const tags = Array.isArray(inboxItem.suggestedTags) ? inboxItem.suggestedTags : [];

  // The preview line answers "what happens if I press Process", so it is shown only
  // when there is a Process to press. On an unenriched row there is nothing to preview,
  // and on a task the suggestions do not exist yet.
  const showPreview = enriched && (contextName || inboxItem.suggestItem || inboxItem.suggestIntent || eventDate || tags.length > 0);

  const stop = (fn) => (e) => {
    // The whole card opens the detail page, so every control on it has to say so.
    e.stopPropagation();
    fn();
  };

  return (
    <article
      onClick={() => onOpen(inboxItem.id)}
      className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 px-4 py-3.5 bg-card border border-border rounded-lg cursor-pointer hover:border-primary transition-colors"
    >
      <div className="flex flex-col gap-1.5 min-w-0 sm:flex-1">
        {/* At most two lines. A capture can be a paragraph, and a list where one row is
            twelve lines tall is a list you cannot scan. */}
        {/* `line-clamp-2`, a Tailwind utility, rather than the inline webkit properties
            it compiles to: jsdom's CSS parser DISCARDS `-webkit-line-clamp` from an
            inline style, so the clamp would have been unassertable — and an unassertable
            rule is one that can go missing quietly. */}
        <h3 className="m-0 text-base font-bold leading-snug text-foreground line-clamp-2">
          {inboxItem.capturedText}
        </h3>

        <p className="m-0 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <SourceIcon sourceType={inboxItem.sourceType} />
            {sourceLabel(inboxItem.sourceType)}
          </span>
          <span aria-hidden="true">·</span>
          {/* Each fact in its own element rather than as a bare text node between
              separators, so a reader — or a test — can address one of the three
              without matching the whole line. */}
          <span>{friendlyDate(inboxItem.createdAt)}</span>
          <span aria-hidden="true">·</span>
          <span>{statusLabel(inboxItem)}</span>
        </p>

        {showPreview && (
          <div className="flex items-center gap-2.5 flex-wrap">
            {contextName && <Chip icon={FolderOpen}>{contextName}</Chip>}
            {inboxItem.suggestItem && (
              <PreviewMark icon={File} tone="text-primary">
                New item
              </PreviewMark>
            )}
            {inboxItem.suggestIntent && (
              <PreviewMark icon={Navigation2} tone="text-success">
                New intention
              </PreviewMark>
            )}
            {eventDate && (
              <PreviewMark icon={Calendar} tone="text-muted-foreground">
                {eventDate}
              </PreviewMark>
            )}
            {tags.map((tag) => (
              <Chip key={tag} pill>
                {tag}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {/* Desktop: beside the text, hugging the right. Phone: its own row underneath,
          with the trash can pushed to the far edge — the mockup's layout, and it keeps
          both targets away from the text you are reading. */}
      <div className="flex items-center justify-between sm:justify-end gap-1.5 shrink-0">
        {canProcess && (
          <button
            onClick={stop(() => onProcess(inboxItem.id))}
            title="File this using Claude's suggestions"
            className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm transition-colors"
          >
            <Check className="w-4 h-4" aria-hidden="true" />
            Process
          </button>
        )}
        {!canProcess && isTask && (
          <button
            onClick={stop(() => onCopy(inboxItem.id))}
            title="Copy the text, with this item's id, for a Claude session"
            className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 rounded-lg bg-success hover:bg-success-hover text-white text-sm transition-colors"
          >
            <Copy className="w-4 h-4" aria-hidden="true" />
            Copy
          </button>
        )}
        <button
          onClick={stop(() => onDiscard(inboxItem.id))}
          aria-label="Discard"
          title="Discard this capture (reversible)"
          className="inline-flex items-center justify-center p-2.5 min-h-[44px] min-w-[44px] rounded-lg text-muted-foreground hover:text-destructive hover:bg-secondary transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </article>
  );
}
