/**
 * The inbox detail page — Alfred Clipboard, Phase 3 Step 17.
 *
 * Design: docs/inbox-detail-mockups/README.md, approved 2026-09-24. Read it
 * before changing anything here; the page order and the rules are its, not this
 * file's.
 *
 * ── Why this is a page and not a card ────────────────────────────────────────
 *
 * Triage used to happen inside `InboxCard`, expanded in place, and three
 * ordinary expectations failed because it had no address: browser Back closed
 * the whole inbox rather than the form, a reload lost a half-filled triage, and
 * there was no way to link to the capture you were asking someone about. It also
 * meant the triage form was mounted once per row, so the inbox rendered N copies
 * of an element editor.
 *
 * ── Its own FILE, deliberately ───────────────────────────────────────────────
 *
 * Alfred.jsx is 12,900 lines. This is here for the reason `useExecutionRoute` is
 * in its own module: the tests exercise this code rather than a reproduction of
 * its shape. The page takes everything it needs as props and reads nothing
 * global, so a test can mount it with four plain objects.
 *
 * ── ONE normaliser ───────────────────────────────────────────────────────────
 *
 * `InboxCard` carried four copies of the suggested-element normaliser that had
 * to stay byte-identical — including key order, because its dirty check compared
 * JSON strings. This page imports `normaliseSuggestedElements` and calls it in
 * one place, `computeBaseline` below. Every other use reads that result.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 *
 * Per the README: no Collections (hidden for now), no Enrich / Re-enrich
 * (removed in Step 14), and no instruction or explanatory text anywhere on the
 * page. Three things the old card had are also gone, and they are FEATURE LOSSES
 * rather than oversights — flagged to Alex with Step 17:
 *
 *   * "Attach this Item", which appended the new item as an element of another
 *   * Target Start Date, and a separate context/tag pair per section — this page
 *     has one Context and one Tags, shared by both sections, as designed
 *
 * Editing the captured text was on that list until Alex ruled it back in (Step
 * 17b): it is the pencil on the Original capture section, and it is the only
 * control here that the mockups do not show apart from the existing-item picker.
 *
 * The End Date survives: `RecurrenceQuickSelect` carries it, and it is only
 * meaningful alongside a repeat anyway.
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  X,
  Trash2,
  GripVertical,
  Tag,
  FolderOpen,
  File,
  Navigation2,
  Calendar,
  Minus,
  Repeat,
  AlignLeft,
  Pencil,
} from "lucide-react";
import ItemPicker, { PickedItem } from "./ItemPicker";
import TagPicker from "./TagPicker";
import { friendlyDate, sourceLabel, SourceIcon } from "./CaptureMeta";
import { normaliseSuggestedElements } from "./utils/suggestedElements";
import { isFirstStep } from "./utils/elementOffsets";
import { getRecurrenceDisplayString } from "./utils/recurrenceDisplay";

/**
 * A YYYY-MM-DD date, written the way the design shows it ("Sat, Sep 26").
 *
 * ⚠️ Parsed field by field rather than with `new Date(value)`. A bare
 * "2026-09-26" is parsed as UTC midnight, which in every negative-offset zone —
 * Alex's included — renders as the 25th. The button would then disagree with the
 * date input directly beneath it.
 */
function formatWhenDate(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!parts) return null;
  const [, y, m, d] = parts;
  const local = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(local.getTime())) return null;
  return local.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * What a capture proposes, read off the row once.
 *
 * `capturedText` is in here alongside the suggestions because two fields are
 * seeded FROM it — an item's name and an intention's name, when the enrichment
 * proposed neither — and the only way to tell later whether one of those is still
 * showing the capture verbatim is to remember what the capture said at the time.
 */
function computeBaseline(inboxItem) {
  const capturedText = inboxItem.capturedText || "";
  return {
    capturedText,
    contextId: inboxItem.suggestedContextId || "",
    tags: inboxItem.suggestedTags || [],
    itemOn: !!inboxItem.suggestItem,
    intentionOn: !!inboxItem.suggestIntent,
    itemName: inboxItem.suggestedItemText || capturedText,
    itemDescription: inboxItem.suggestedItemDescription || "",
    elements: normaliseSuggestedElements(inboxItem.suggestedItemElements),
    intentText: inboxItem.suggestedIntentText || capturedText,
    // Nothing suggests an intention's Details: the column arrived with migration
    // 069 and no enrichment writes it. Always starts empty.
    intentDescription: "",
    linkedItemId: inboxItem.suggestedItemId || "",
    eventDate: inboxItem.suggestedEventDate || "",
  };
}

/**
 * One of the two section toggles.
 *
 * Filled when on, outlined in its own colour when off — the mockup's treatment,
 * which makes "off" still legible as an available choice rather than as a
 * disabled control. `aria-pressed` carries the state for a screen reader, since
 * colour is the only other thing saying it.
 */
function SectionToggle({ on, onToggle, tone, icon: Glyph, label }) {
  const filled = tone === "primary" ? "bg-primary text-white" : "bg-success text-white";
  const outlined = tone === "primary" ? "bg-card text-primary" : "bg-card text-success";
  const edge = tone === "primary" ? "border-primary" : "border-success";
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={`flex-1 inline-flex items-center justify-center gap-2 min-h-[48px] px-4 py-2.5 rounded-lg border-2 transition-colors ${edge} ${
        on ? filled : outlined
      }`}
    >
      <Glyph className="w-[18px] h-[18px] shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}

/** A section heading inside the card: glyph plus name, in the section's colour. */
function SectionHeading({ icon: Glyph, children, tone }) {
  const color =
    tone === "primary" ? "text-primary" : tone === "success" ? "text-success" : "text-muted-foreground";
  return (
    <h3 className={`flex items-center gap-2 text-lg font-bold ${color}`}>
      <Glyph className="w-[18px] h-[18px] shrink-0" aria-hidden="true" />
      {children}
    </h3>
  );
}

/** The hairline between sections. */
function Divider() {
  return <div className="h-px bg-border" />;
}

const FIELD = "w-full px-3 py-2.5 border border-border rounded-lg text-base bg-input-background";
const LABEL = "flex items-center gap-2 text-sm font-bold text-foreground mb-2";

/**
 * @param {object}   inboxItem       The capture being triaged.
 * @param {Array}    contexts        For the Context dropdown (archived filtered here).
 * @param {Array}    items           For the "existing item" picker.
 * @param {Array}    tagPool         Suggestions for the tag control.
 * @param {Function} onProcess       (inboxItemId, triageData) — Alfred's handleInboxSave.
 * @param {Function} onDiscard       (inboxItemId) — archives with reason 'discarded'.
 * @param {Function} onBack          Leave the page. Goes through Alfred's unsaved-changes guard.
 * @param {Function} onDirtyChange   (dirty, label) — feeds that guard.
 * @param {Function} onSaveCaptureText
 *   (inboxItemId, text) => Promise<boolean> — Alfred's updateInboxCaptureText.
 *   Corrects `captured_text` and nothing else; the row stays in the inbox. Omit it
 *   and the pencil is not rendered.
 * @param {Function} renderRecurrence
 *   Renders the repeat control. Passed IN rather than imported because
 *   `RecurrenceQuickSelect` lives in Alfred.jsx, which imports this file —
 *   importing back would be a cycle, and moving it here would drag two dialog
 *   components along with it. A prop also lets the test stub it.
 */
export default function InboxDetailView({
  inboxItem,
  contexts = [],
  items = [],
  tagPool = [],
  onProcess,
  onDiscard,
  onBack,
  onDirtyChange,
  onSaveCaptureText,
  renderRecurrence,
}) {
  /**
   * Everything the capture proposes, in one place.
   *
   * ⚠️ HELD IN STATE, SEEDED ONCE — not memoised on `inboxItem`.
   *
   * It is both the seed for the fields below AND what the dirty check compares
   * against, which is the whole reason the dirty check needs no hand-written
   * dependency list. But it must not track the row: `inboxItem` changes whenever
   * the row does, and saving a corrected capture text changes it a lot — the save
   * clears the enrichment, so `suggestItem`, `suggestedIntentText` and the rest all
   * go null. Recomputing from that would declare a form the user had not touched
   * to be different from its own baseline in a dozen places at once.
   *
   * So it advances only when something deliberately advances it — see
   * `handleSaveCapture`, the one place that does.
   */
  const [baseline, setBaseline] = useState(() => computeBaseline(inboxItem));

  // Shared by both sections — one Context, one set of Tags, as designed. The old
  // card had a pair per section, which meant filing one capture could put the
  // item in one context and its intention in another with nothing pointing that
  // out.
  const [contextId, setContextId] = useState(baseline.contextId);
  const [tags, setTags] = useState(baseline.tags);

  const [itemOn, setItemOn] = useState(baseline.itemOn);
  const [intentionOn, setIntentionOn] = useState(baseline.intentionOn);

  const [itemName, setItemName] = useState(baseline.itemName);
  const [itemDescription, setItemDescription] = useState(baseline.itemDescription);
  const [elements, setElements] = useState(baseline.elements);
  const [draggedIndex, setDraggedIndex] = useState(null);

  const [intentText, setIntentText] = useState(baseline.intentText);
  const [intentDescription, setIntentDescription] = useState(baseline.intentDescription);
  const [linkedItemId, setLinkedItemId] = useState(baseline.linkedItemId);
  const [linkedItemSearch, setLinkedItemSearch] = useState(
    () => items.find((i) => i.id === baseline.linkedItemId)?.name || "",
  );

  // "When" is three mutually exclusive answers, so it is one mode rather than
  // three independent fields. Seeded to a date only when the enrichment proposed
  // one; nothing proposes a recurrence.
  const [whenMode, setWhenMode] = useState(baseline.eventDate ? "date" : "someday");
  const [eventDate, setEventDate] = useState(baseline.eventDate);
  const [recurrenceConfig, setRecurrenceConfig] = useState(null);
  const [endDate, setEndDate] = useState(null);

  // Correcting the capture itself — Step 12.7's pencil, kept on this page on
  // Alex's ruling. NOT triage: it writes `captured_text` and leaves the row in the
  // inbox with `triaged_at` still null.
  const [editingCapture, setEditingCapture] = useState(false);
  const [captureDraft, setCaptureDraft] = useState(inboxItem.capturedText || "");

  const elementDescRefs = useRef([]);
  const itemDescRef = useRef(null);

  // ── The dirty flag ────────────────────────────────────────────────────────
  //
  // Computed during render from state versus `baseline`, then reported in an
  // effect. The old card did this in an effect with a hand-written dependency
  // list and an `eslint-disable` on top of it, because the list could not be
  // kept honest by hand. Here the comparison is a value, so the effect depends on
  // one thing and the linter has nothing to complain about.
  const sameStrings = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // An open capture editor holding text nobody has saved. Exactly the kind of
  // typing the guard exists for, and on the old card it was the one field that
  // could be lost by navigating away.
  const captureDirty = editingCapture && captureDraft.trim() !== (inboxItem.capturedText || "");
  const dirty =
    captureDirty ||
    contextId !== baseline.contextId ||
    !sameStrings(tags, baseline.tags) ||
    itemOn !== baseline.itemOn ||
    intentionOn !== baseline.intentionOn ||
    itemName !== baseline.itemName ||
    itemDescription !== baseline.itemDescription ||
    !sameStrings(elements, baseline.elements) ||
    intentText !== baseline.intentText ||
    intentDescription !== baseline.intentDescription ||
    linkedItemId !== baseline.linkedItemId ||
    eventDate !== baseline.eventDate ||
    recurrenceConfig !== null ||
    endDate !== null;

  // Held in a ref because `onDirtyChange` is a fresh function on every render of
  // Alfred. Without this the unmount cleanup below would re-run on every render,
  // clearing the flag it had just set.
  const dirtyCallbackRef = useRef(onDirtyChange);
  useEffect(() => {
    dirtyCallbackRef.current = onDirtyChange;
  });

  useEffect(() => {
    dirtyCallbackRef.current?.(dirty, "this capture");
  }, [dirty]);

  // Leaving the page cannot leave a stale guard behind, however it was left —
  // Process, Cancel, Discard, Back, or a redirect because the row is gone.
  useEffect(() => () => dirtyCallbackRef.current?.(false), []);

  // ⚠️ NOTHING RE-SEEDS THIS FORM. If an enrichment lands from claude.ai while
  // the page is open, the fields keep what they have. The old card re-seeded,
  // and had to: it had an Enrich button, so the user had asked for suggestions
  // and was waiting for them. Step 14 removed that button. Now the only way for
  // suggestions to arrive mid-edit is a coincidence, and overwriting what
  // somebody is typing to serve a coincidence is the wrong trade.

  // ── Element editor ────────────────────────────────────────────────────────
  //
  // Ported unchanged from the card's copy, down to the `.inbox-element-input`
  // class the focus helpers query: the README asks for the EXISTING editor, and
  // "existing" includes the overflow-to-description behaviour and the Enter key
  // inserting a row below. Step 18 deletes the copy this came from.

  function addElement() {
    setElements([...elements, { name: "", displayType: "step", quantity: "", description: "" }]);
    setTimeout(() => {
      const inputs = document.querySelectorAll(".inbox-element-input");
      if (inputs.length) {
        inputs[inputs.length - 1].scrollIntoView({ block: "nearest" });
        inputs[inputs.length - 1].focus();
      }
    }, 50);
  }

  function insertElementAbove(index) {
    const next = [...elements];
    next.splice(index, 0, { name: "", displayType: "step", quantity: "", description: "" });
    setElements(next);
    setTimeout(() => {
      const inputs = document.querySelectorAll(".inbox-element-input");
      if (inputs[index]) {
        inputs[index].scrollIntoView({ block: "nearest" });
        inputs[index].focus();
      }
    }, 50);
  }

  function updateElement(index, field, value) {
    const next = [...elements];
    const updated = { ...next[index], [field]: value };
    // `collectable` means "this is a thing you can buy" and only applies to
    // bullets. Changing a row away from bullet drops the flag rather than leaving
    // it set on a row whose checkbox is no longer rendered: an invisible flag
    // would still surface the row in Add to Collection.
    if (field === "displayType" && value !== "bullet") delete updated.collectable;
    // Same reasoning for the scheduling gap, which only applies to steps.
    if (field === "displayType" && value !== "step") delete updated.offsetMinutes;
    next[index] = updated;
    setElements(next);
  }

  /**
   * Typing past the name field's comfortable length spills into the description.
   *
   * The threshold is on the NAME because a name is what lists render; the
   * overflow lands in the field below with the caret following it, so a long
   * sentence typed into the wrong box ends up in the right two.
   */
  function handleItemNameChange(newName) {
    const OVERFLOW_THRESHOLD = 50;
    if (itemDescription && itemDescription.trim().length > 0) {
      setItemName(newName);
      return;
    }
    if (newName.length > OVERFLOW_THRESHOLD) {
      const lastSpaceIndex = newName.substring(0, OVERFLOW_THRESHOLD).lastIndexOf(" ");
      if (lastSpaceIndex > 0) {
        const nameText = newName.substring(0, lastSpaceIndex).trim();
        const overflowText = newName.substring(lastSpaceIndex + 1).trim();
        setItemName(nameText);
        setItemDescription(overflowText);
        setTimeout(() => {
          if (itemDescRef.current) {
            itemDescRef.current.focus();
            itemDescRef.current.setSelectionRange(overflowText.length, overflowText.length);
          }
        }, 0);
        return;
      }
    }
    setItemName(newName);
  }

  function handleElementNameChange(index, newName, currentDescription) {
    const OVERFLOW_THRESHOLD = 30;
    if (currentDescription && currentDescription.trim().length > 0) {
      updateElement(index, "name", newName);
      return;
    }
    if (newName.length > OVERFLOW_THRESHOLD) {
      const lastSpaceIndex = newName.substring(0, OVERFLOW_THRESHOLD).lastIndexOf(" ");
      if (lastSpaceIndex > 0) {
        const nameText = newName.substring(0, lastSpaceIndex).trim();
        const overflowText = newName.substring(lastSpaceIndex + 1).trim();
        const next = [...elements];
        next[index] = { ...next[index], name: nameText, description: overflowText };
        setElements(next);
        setTimeout(() => {
          const descField = elementDescRefs.current[index];
          if (descField) {
            descField.focus();
            descField.setSelectionRange(overflowText.length, overflowText.length);
          }
        }, 0);
        return;
      }
    }
    updateElement(index, "name", newName);
  }

  function deleteElement(index) {
    setElements(elements.filter((_, i) => i !== index));
  }

  function handleElementKeyPress(e, index) {
    if (e.key === "Enter") {
      e.preventDefault();
      insertElementAbove(index + 1);
      setTimeout(() => {
        const inputs = document.querySelectorAll(".inbox-element-input");
        if (inputs[index + 1]) inputs[index + 1].focus();
      }, 50);
    }
  }

  function handleDragStart(e, index) {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e, index) {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    const next = [...elements];
    const dragged = next[draggedIndex];
    next.splice(draggedIndex, 1);
    next.splice(index, 0, dragged);
    setElements(next);
    setDraggedIndex(index);
  }

  function handleDragEnd() {
    setDraggedIndex(null);
  }

  // ── When ──────────────────────────────────────────────────────────────────

  function chooseSomeday() {
    setWhenMode("someday");
    setEventDate("");
    setRecurrenceConfig(null);
    setEndDate(null);
  }

  function chooseDate() {
    setWhenMode("date");
    setRecurrenceConfig(null);
    setEndDate(null);
  }

  function chooseRepeat() {
    setWhenMode("repeat");
    setEventDate("");
  }

  const repeatLabel = recurrenceConfig ? getRecurrenceDisplayString(recurrenceConfig) : null;

  // ── Process ───────────────────────────────────────────────────────────────

  // Neither toggle on means nothing would be created, so there is nothing to
  // process — the same rule the old card's Save used. Discard is the button for
  // "this capture should just go away", and it says so.
  const canProcess =
    (itemOn || intentionOn) &&
    (!itemOn || itemName.trim().length > 0) &&
    (!intentionOn || intentText.trim().length > 0);

  /**
   * File the capture.
   *
   * ⚠️ DELIBERATELY DOES NOT NAVIGATE. `onProcess` archives the inbox row on
   * success and leaves it in place on failure, and it cannot report which — it
   * alerts and returns nothing. So the page lets the outcome decide: when the row
   * goes, Alfred's redirect takes us to the list; when it stays, so do we, with
   * the alert explaining why and every field still filled in.
   *
   * The dirty flag is deliberately NOT cleared here either. The redirect uses
   * `navigate` directly and never consults it, so clearing would buy nothing —
   * and on the failure path it would drop the guard over a form still full of
   * unsaved work.
   */
  /**
   * Commit a corrected capture text. Not triage — the row stays in the inbox.
   *
   * ⚠️ SAVING THIS CLEARS THE ENRICHMENT, in the database: the suggestions
   * describe text that no longer exists, so `updateInboxCaptureText` nulls them
   * along with `ai_status`. That is why the baseline is advanced by hand here
   * rather than recomputed — the row it would be recomputed from has just had
   * every suggestion removed from it.
   *
   * Two fields follow the correction: an item or intention name that was still
   * showing the capture VERBATIM, because that is a pre-fill rather than
   * something the user wrote. A name they have edited is theirs and is left
   * alone. Same rule the old card applied as you typed; applied here at the save,
   * which is the point at which it becomes true.
   */
  async function handleSaveCapture() {
    const next = captureDraft.trim();
    if (!next) return;
    const ok = await onSaveCaptureText?.(inboxItem.id, next);
    // A failed save has already alerted. Leave the editor open, holding the text,
    // rather than closing over an edit that did not land.
    if (!ok) return false;

    const wasVerbatim = baseline.capturedText;
    if (itemName === wasVerbatim) setItemName(next);
    if (intentText === wasVerbatim) setIntentText(next);
    setBaseline((prev) => ({
      ...prev,
      capturedText: next,
      itemName: prev.itemName === wasVerbatim ? next : prev.itemName,
      intentText: prev.intentText === wasVerbatim ? next : prev.intentText,
    }));
    setEditingCapture(false);
    return true;
  }

  async function handleProcess() {
    if (!canProcess) return;
    // The text first, so a triage in the same press files the CORRECTED capture
    // rather than the text being corrected. If it fails, nothing is filed.
    if (captureDirty) {
      const ok = await handleSaveCapture();
      if (!ok) return;
    }
    onProcess(inboxItem.id, {
      createItem: itemOn,
      itemData: itemOn
        ? {
            name: itemName.trim(),
            description: itemDescription,
            contextId: contextId || null,
            elements,
            tags,
          }
        : null,
      // "Attach this Item" is not on this page — see the header note.
      itemItemLinks: [],
      createIntention: intentionOn,
      intentionData: intentionOn
        ? {
            text: intentText.trim(),
            // Migration 069's column, labelled "Details".
            description: intentDescription,
            contextId: contextId || null,
            tags,
            recurrenceConfig: whenMode === "repeat" ? recurrenceConfig : null,
            endDate: whenMode === "repeat" ? endDate : null,
            // Not offered by this page's When control, which has three answers
            // and no fourth. Left null rather than guessed at.
            targetStartDate: null,
            // Linking to an EXISTING item — and DELIBERATELY null whenever the
            // New Item section is on.
            //
            // ⚠️ This cannot be left to the triage handler. It resolves the
            // intention's item as `triageData.intentionData.itemId ||
            // createdItemId`, so a value sent here WINS over the item it has just
            // created. Pick an existing item, then turn New Item on, and the page
            // says "the new item will be linked" while the intention would quietly
            // attach to the earlier pick instead. Dimming the picker hides the
            // stale value; it does not clear it.
            itemId: itemOn ? null : linkedItemId || null,
            createEvent: whenMode === "date" && !!eventDate,
            eventDate: whenMode === "date" ? eventDate || null : null,
          }
        : null,
      // Collections are hidden on this page for now — README, Rules.
      addToCollection: false,
      collectionData: null,
    });
  }

  function handleCancel() {
    // An explicit "leave without filing", so it must not then ask whether to
    // discard the changes the user has just chosen to abandon.
    dirtyCallbackRef.current?.(false);
    onBack();
  }

  function handleDiscard() {
    dirtyCallbackRef.current?.(false);
    // Same as Process: no navigation here. `onDiscard` archives on success and
    // alerts on failure, and the row leaving the list is what moves us.
    onDiscard(inboxItem.id);
  }

  const liveContexts = contexts.filter((c) => !c.archived);

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      {/* One centred card with the brown outline, matching the item and
          intention edit screens. max-w-[860px] is the mockup's card width; it
          collapses to full width below that, which is the phone layout — one
          column, same order. */}
      <div className="max-w-[860px] mx-auto bg-card border-2 border-primary rounded-xl p-4 sm:p-7 space-y-5">
        {/* Source and time */}
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-muted text-muted-foreground text-xs">
            <SourceIcon sourceType={inboxItem.sourceType} />
            {sourceLabel(inboxItem.sourceType)}
          </span>
          <span className="text-sm text-muted-foreground">{friendlyDate(inboxItem.createdAt)}</span>
        </div>

        {/* Context first and prominent, Tags directly underneath in the same
            section — both shared by whichever sections are on. */}
        <div className="space-y-3">
          <div>
            <label htmlFor="inbox-detail-context" className={LABEL}>
              <FolderOpen className="w-[18px] h-[18px]" aria-hidden="true" />
              Context
            </label>
            <select
              id="inbox-detail-context"
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
              className={FIELD}
            >
              <option value="">No context</option>
              {liveContexts.map((ctx) => (
                <option key={ctx.id} value={ctx.id}>
                  {ctx.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className={LABEL}>
              <Tag className="w-4 h-4" aria-hidden="true" />
              Tags
            </span>
            <TagPicker value={tags} onChange={setTags} pool={tagPool} />
          </div>
        </div>

        {/* The two toggles. Either, both, or neither. */}
        <div className="flex gap-3">
          <SectionToggle
            on={itemOn}
            onToggle={() => setItemOn((v) => !v)}
            tone="primary"
            icon={File}
            label="New Item"
          />
          <SectionToggle
            on={intentionOn}
            onToggle={() => setIntentionOn((v) => !v)}
            tone="success"
            icon={Navigation2}
            label="New Intention"
          />
        </div>

        {itemOn && (
          <>
            <Divider />
            <div className="space-y-4">
              <SectionHeading icon={File} tone="primary">
                New Item
              </SectionHeading>

              <div>
                <label htmlFor="inbox-detail-item-name" className={LABEL}>
                  Name
                </label>
                <div className="relative">
                  <input
                    id="inbox-detail-item-name"
                    type="text"
                    value={itemName}
                    onChange={(e) => handleItemNameChange(e.target.value)}
                    className={FIELD}
                  />
                  {itemName.length > 45 &&
                    itemName.length <= 50 &&
                    (!itemDescription || !itemDescription.trim()) && (
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-warning">
                        {50 - itemName.length}
                      </span>
                    )}
                </div>
              </div>

              <div>
                <label htmlFor="inbox-detail-item-description" className={LABEL}>
                  Description
                </label>
                <textarea
                  id="inbox-detail-item-description"
                  ref={itemDescRef}
                  value={itemDescription}
                  onChange={(e) => setItemDescription(e.target.value)}
                  rows={3}
                  className={`${FIELD} resize-y`}
                />
              </div>

              <div>
                <span className={LABEL}>Elements</span>
                <div className="space-y-2">
                  {elements.map((element, index) => (
                    <div key={index}>
                      <div
                        className={`space-y-2 p-3 border border-border rounded ${
                          draggedIndex === index ? "opacity-50" : ""
                        }`}
                        draggable
                        onDragStart={(e) => handleDragStart(e, index)}
                        onDragOver={(e) => handleDragOver(e, index)}
                        onDragEnd={handleDragEnd}
                      >
                        <div className="flex items-center gap-2">
                          <GripVertical
                            className="w-4 h-4 text-muted-foreground cursor-move flex-shrink-0"
                            title="Drag to reorder"
                          />
                          <div className="relative flex-1 min-w-0">
                            <input
                              type="text"
                              value={element.name}
                              onChange={(e) =>
                                handleElementNameChange(index, e.target.value, element.description)
                              }
                              onKeyPress={(e) => handleElementKeyPress(e, index)}
                              placeholder="Element name"
                              className="inbox-element-input w-full px-3 py-2 border border-border rounded"
                            />
                            {element.name.length > 25 &&
                              element.name.length <= 30 &&
                              (!element.description || !element.description.trim()) && (
                                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-warning">
                                  {30 - element.name.length}
                                </span>
                              )}
                          </div>
                          <button
                            onClick={() => deleteElement(index)}
                            className="text-destructive hover:text-destructive-hover flex-shrink-0"
                            title="Delete"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>

                        <textarea
                          ref={(el) => (elementDescRefs.current[index] = el)}
                          value={element.description || ""}
                          onChange={(e) => updateElement(index, "description", e.target.value)}
                          placeholder="Description (optional)"
                          className="w-full px-3 py-2 border border-border rounded text-sm"
                          rows="2"
                        />

                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={element.displayType || "step"}
                            onChange={(e) => updateElement(index, "displayType", e.target.value)}
                            className="px-2 py-2 border border-border rounded text-sm"
                            aria-label="Element type"
                          >
                            <option value="header">Header</option>
                            <option value="bullet">Bullet</option>
                            <option value="step">Step</option>
                          </select>
                          <input
                            type="text"
                            value={element.quantity || ""}
                            onChange={(e) => updateElement(index, "quantity", e.target.value)}
                            placeholder="Qty"
                            className="w-16 px-2 py-2 border border-border rounded text-sm"
                          />
                          {(element.displayType || "step") === "bullet" && (
                            <label
                              className="flex items-center gap-2 min-h-[44px] cursor-pointer"
                              title="This is something you can buy, so it can be added to a shopping collection."
                            >
                              <input
                                type="checkbox"
                                checked={element.collectable === true}
                                onChange={(e) =>
                                  updateElement(index, "collectable", e.target.checked ? true : undefined)
                                }
                                className="rounded accent-primary"
                              />
                              <span className="text-sm whitespace-nowrap">Can buy</span>
                            </label>
                          )}
                          {(element.displayType || "step") === "step" && (
                            <label
                              className="w-full text-sm text-muted-foreground"
                              title="Minutes to wait after the previous step is completed."
                            >
                              notify{" "}
                              <input
                                type="number"
                                min={0}
                                inputMode="numeric"
                                value={element.offsetMinutes ?? ""}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  const parsed = parseInt(raw, 10);
                                  updateElement(
                                    index,
                                    "offsetMinutes",
                                    raw === "" || Number.isNaN(parsed) ? undefined : Math.max(0, parsed),
                                  );
                                }}
                                placeholder="—"
                                className="inline-block w-16 align-middle px-2 py-1.5 border border-border rounded text-sm"
                              />{" "}
                              min after the step above is checked.
                              {isFirstStep(elements, index) && (
                                <span
                                  className="block mt-0.5 text-xs text-muted-foreground italic"
                                  title="Nothing precedes this step, so there is no completion to measure from. The value is kept and becomes live if you move this step below another one."
                                >
                                  — at starting step, no notification will be sent
                                </span>
                              )}
                            </label>
                          )}
                        </div>
                      </div>

                      {index < elements.length - 1 && (
                        <div className="flex justify-center -my-1">
                          <button
                            onClick={() => insertElementAbove(index + 1)}
                            className="text-success hover:text-success-hover text-lg"
                            title="Insert element below"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={addElement}
                    className="w-full px-4 py-2.5 border-2 border-dashed border-border rounded-lg text-muted-foreground hover:border-primary hover:text-primary transition-all duration-200"
                  >
                    + Add Element
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {intentionOn && (
          <>
            <Divider />
            <div className="space-y-4">
              <SectionHeading icon={Navigation2} tone="success">
                New Intention
              </SectionHeading>

              <div>
                <label htmlFor="inbox-detail-intent-name" className={LABEL}>
                  Name
                </label>
                <input
                  id="inbox-detail-intent-name"
                  type="text"
                  value={intentText}
                  onChange={(e) => setIntentText(e.target.value)}
                  className={FIELD}
                />
              </div>

              {/* Migration 069's `intents.description`. Labelled "Details" here
                  and named `description` in the database, to match
                  items.description — see the migration's header. */}
              <div>
                <label htmlFor="inbox-detail-intent-details" className={LABEL}>
                  Details
                </label>
                <textarea
                  id="inbox-detail-intent-details"
                  value={intentDescription}
                  onChange={(e) => setIntentDescription(e.target.value)}
                  rows={3}
                  className={`${FIELD} resize-y`}
                />
              </div>

              {/* Linking to an item that already exists. Not in the mockups, kept
                  on Alex's instruction: it is the only way an enrichment's
                  `suggested_item_id` can be acted on, and dropping it would make
                  that column unreachable from the app. Dimmed while New Item is
                  on, because the triage handler prefers the item it is about to
                  create and a live-looking picker would imply otherwise. */}
              <div>
                <span className={LABEL}>
                  Existing item (optional)
                  {itemOn && (
                    <span className="font-normal text-xs text-muted-foreground">
                      — {itemName.trim() || "the new item"} will be linked
                    </span>
                  )}
                </span>
                <div className={`relative ${itemOn ? "opacity-50 pointer-events-none" : ""}`}>
                  <ItemPicker
                    variant="dropdown"
                    items={items}
                    contexts={contexts}
                    query={linkedItemSearch}
                    onQueryChange={setLinkedItemSearch}
                    onPick={(item) => {
                      setLinkedItemId(item.id);
                      setLinkedItemSearch(item.name);
                    }}
                  />
                  <PickedItem
                    selectedId={linkedItemId}
                    items={items}
                    query={linkedItemSearch}
                    onClear={() => {
                      setLinkedItemId("");
                      setLinkedItemSearch("");
                    }}
                  />
                </div>
              </div>

              {/* When: Someday, a date, or Repeat. Three push buttons; the chosen
                  one shows what it is set to rather than its own name. */}
              <div>
                <span className={LABEL}>When</span>
                <div className="flex flex-wrap gap-2">
                  <WhenButton
                    on={whenMode === "someday"}
                    onClick={chooseSomeday}
                    icon={Minus}
                    label="Someday"
                  />
                  <WhenButton
                    on={whenMode === "date"}
                    onClick={chooseDate}
                    icon={Calendar}
                    label={(whenMode === "date" && formatWhenDate(eventDate)) || "Pick a date"}
                  />
                  <WhenButton
                    on={whenMode === "repeat"}
                    onClick={chooseRepeat}
                    icon={Repeat}
                    label={(whenMode === "repeat" && repeatLabel) || "Repeat"}
                  />
                </div>

                {whenMode === "date" && (
                  <input
                    type="date"
                    value={eventDate}
                    onChange={(e) => setEventDate(e.target.value)}
                    aria-label="Date"
                    className={`${FIELD} mt-2`}
                  />
                )}

                {whenMode === "repeat" && (
                  <div className="mt-2">
                    {renderRecurrence?.({
                      value: recurrenceConfig,
                      onChange: setRecurrenceConfig,
                      onEndDateChange: setEndDate,
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        <Divider />

        {/* The capture itself, always shown, last — and correctable in place.

            The pencil is the one control here that is not in the mockups: Alex
            ruled it back in, because after this page replaces the inbox card there
            would otherwise be no way in the app to fix a typo in a capture.

            It keeps its own Save and Cancel rather than committing through the
            footer. Step 12.7b argued against a second Save on the old card and was
            right THERE, where both pairs were labelled the same and one of them
            filed the capture. Here the footer's primary says "Process", which is a
            different action with a different outcome — so a scoped pair inside this
            section is clearer than folding a typo fix into the button that files
            the record. */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <SectionHeading icon={AlignLeft}>Original capture</SectionHeading>
            {onSaveCaptureText && !editingCapture && (
              <button
                onClick={() => {
                  setCaptureDraft(inboxItem.capturedText || "");
                  setEditingCapture(true);
                }}
                title="Correct this capture's text"
                aria-label="Edit capture text"
                className="shrink-0 flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}
          </div>

          {editingCapture ? (
            <div className="space-y-2">
              <textarea
                value={captureDraft}
                onChange={(e) => setCaptureDraft(e.target.value)}
                rows={5}
                autoFocus
                aria-label="Capture text"
                className={`${FIELD} resize-y min-h-[120px]`}
              />
              {/* A consequence, not an instruction: the suggestions describe the
                  text being replaced, so saving removes them. Shown only when
                  there is actually an enrichment to lose. */}
              {captureDirty &&
                (inboxItem.aiStatus === "enriched" || inboxItem.aiStatus === "re_enriched") && (
                  <p className="text-xs text-muted-foreground">
                    Saving this clears Claude's suggestions for this capture.
                  </p>
                )}
              <div className="flex gap-2">
                <button
                  onClick={handleSaveCapture}
                  disabled={!captureDraft.trim()}
                  className={`inline-flex items-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-lg text-sm transition-colors ${
                    captureDraft.trim()
                      ? "bg-primary hover:bg-primary-hover text-white"
                      : "bg-secondary text-muted-foreground cursor-not-allowed"
                  }`}
                >
                  <Check className="w-4 h-4" aria-hidden="true" />
                  Save text
                </button>
                <button
                  onClick={() => {
                    setEditingCapture(false);
                    setCaptureDraft(inboxItem.capturedText || "");
                  }}
                  className="inline-flex items-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-lg bg-secondary text-foreground text-sm"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="px-4 py-3.5 rounded-lg bg-background text-base leading-relaxed whitespace-pre-wrap">
              {inboxItem.capturedText}
            </div>
          )}
        </div>

        {/* Footer, pinned to the bottom of the card and flush on top of the
            global capture bar. `sticky-above-dock` positions it on the MEASURED
            height of the bottom dock rather than on a chosen number — Clipboard
            Step 17b, and the one rule every pinned footer in Alfred now uses.

            The negative margins pull it out to the card's own edges — bottom
            included, so it finishes flush with the rounded corner rather than
            floating above a strip of card padding. */}
        <div className="sticky-above-dock -mx-4 sm:-mx-7 -mb-4 sm:-mb-7 px-4 sm:px-7 py-3.5 flex items-center gap-2.5 bg-card border-t border-border rounded-b-xl">
          <button
            onClick={handleProcess}
            disabled={!canProcess}
            title={
              canProcess
                ? undefined
                : "Turn on New Item or New Intention, and give it a name, before processing."
            }
            className={`inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-lg shadow-sm transition-all duration-200 ${
              canProcess
                ? "bg-primary hover:bg-primary-hover text-white hover:shadow-md"
                : "bg-secondary text-muted-foreground cursor-not-allowed"
            }`}
          >
            <Check className="w-[18px] h-[18px]" aria-hidden="true" />
            Process
          </button>
          <button
            onClick={handleCancel}
            className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-lg bg-secondary hover:bg-secondary text-foreground shadow-sm hover:shadow-md transition-all duration-200"
          >
            <X className="w-[18px] h-[18px]" aria-hidden="true" />
            Cancel
          </button>
          <span className="flex-1" />
          <button
            onClick={handleDiscard}
            className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-lg bg-destructive hover:bg-destructive-hover text-white shadow-sm hover:shadow-md transition-all duration-200"
          >
            <Trash2 className="w-[18px] h-[18px]" aria-hidden="true" />
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

/** One of the three When choices. Sage when chosen, plain when not. */
function WhenButton({ on, onClick, icon: Glyph, label }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-1.5 rounded-lg border text-sm transition-colors ${
        on
          ? "border-success bg-success-light text-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      <Glyph className="w-4 h-4 shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}
