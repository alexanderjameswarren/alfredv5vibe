import React, { useState, useEffect } from "react";
import { Archive, Minus, Play, Repeat } from "lucide-react";
import { detailsForStorage } from "../utils/intentionRows";
import { formatEventDate, getTodayDate } from "../utils/eventDates";
import WhenButton from "../shared/WhenButton";
import { getRecurrenceConfig } from "../utils/recurrence";
import { getRecurrenceDisplayString } from "../utils/recurrenceDisplay";
import EditCard from "../shared/EditCard";
import PinnedFooter from "../shared/PinnedFooter";
import TagPicker from "../shared/TagPicker";
import ItemPicker, { PickedItem } from "../shared/ItemPicker";
import ObjectIcon from "../shared/ObjectIcon";
import SchedulePopover from "../shared/recurrence/SchedulePopover";
import RecurrenceQuickSelect from "../shared/recurrence/RecurrenceQuickSelect";
import ScheduledLine from "../shared/ScheduledLine";
import StatusPill from "../shared/StatusPill";
import StatusPicker from "../shared/StatusPicker";
import CardExecutionNotes from "../notes/CardExecutionNotes";
import { shortDate } from "../notes/noteFormat";
import { closedBlockTitle, recordActions, statusOf, statusOptionsFor } from "../utils/status";

export default function IntentionCard({
  intent,
  contexts,
  items,
  tagPool = [],
  onUpdate,
  onSchedule,
  onStartNow,
  getIntentDisplay,
  showScheduling = false,
  isEditing: initialEditing = false,
  onCancel,
  onViewDetail,
  events = [],
  onUpdateEvent,
  onActivate,
  executions = [],
  onOpenExecution,
  onCancelExecution,
  onArchive,
  collections = [],
  onDirtyChange,
  // See ItemCard — true only on intention detail, where this card is the page.
  stickyFooter = false,
  // `{ text, muted }` from reminderBadge ("7:17 AM", or muted "Sent 7:36 AM").
  // Intentions list only.
  reminder = null,
  // Edit form only: a status picker whose choice goes out with Save, as `status`.
  // The caller runs the guard and the live-events sheet then.
  editableStatus = false,
  // Shown inside the form, e.g. why Save was refused.
  formNotice = null,
}) {
  const [isEditing, setIsEditing] = useState(initialEditing);
  const [name, setName] = useState(intent.text);
  // `intents.description`, migration 069 — Step 17c. Held as "" when the column is
  // null so the textarea stays controlled; converted back to null on save.
  const [description, setDescription] = useState(intent.description || "");
  const [recurrenceConfig, setRecurrenceConfig] = useState(intent.recurrenceConfig || null);
  // The When control's mode. Repeat chosen but no pattern picked saves as once.
  const [repeating, setRepeating] = useState(getRecurrenceConfig(intent).type !== "once");
  const [intentEndDate, setIntentEndDate] = useState(intent.endDate || null);
  const [targetStartDate, setTargetStartDate] = useState(intent.targetStartDate || null);
  const [itemSearch, setItemSearch] = useState("");
  const [selectedItemId, setSelectedItemId] = useState(intent.itemId || "");
  const [selectedCollectionId, setSelectedCollectionId] = useState(intent.collectionId || "");
  const [tags, setTags] = useState(intent.tags || []);
  const [selectedContextId, setSelectedContextId] = useState(intent.contextId || "");
  const [editStatus, setEditStatus] = useState(statusOf(intent));

  // Was a per-card query on mount asking
  // `intent_id = … AND closed_at IS NULL` — one round trip per row on the
  // Intentions list. `executions` already carries allLiveExecutions, which is
  // that exact set, so the answer was in hand the whole time.
  //
  // The invariant this guard rests on is "every site that passes `onArchive`
  // also passes `executions`", because it FAILS OPEN — a missing prop defaults
  // to [] and reads as "no executions", leaving Archive enabled mid-execution.
  // Holds at 4 of 4, rechecked at Step 12.1. (8a had to give intention detail's
  // edit mode the prop. 12.1 added no new sites; it turned three existing ones
  // into Archive renderers, and all three already passed both props.) The other
  // three sites pass neither and are add-forms, so nothing renders there.
  //
  // Recheck this whenever a site gains `onArchive` or a row strip.
  const hasActiveExecutions = executions.some(
    (ex) => ex.intentId === intent.id,
  );

  useEffect(() => {
    if (!isEditing || !onDirtyChange) return;
    const isDirty =
      name !== intent.text ||
      description !== (intent.description || "") ||
      JSON.stringify(recurrenceConfig) !== JSON.stringify(intent.recurrenceConfig || null) ||
      intentEndDate !== (intent.endDate || null) ||
      selectedItemId !== (intent.itemId || "") ||
      selectedCollectionId !== (intent.collectionId || "") ||
      selectedContextId !== (intent.contextId || "") ||
      editStatus !== statusOf(intent) ||
      JSON.stringify(tags) !== JSON.stringify(intent.tags || []);
    onDirtyChange(isDirty, "this intention");
  }, [isEditing, name, description, recurrenceConfig, intentEndDate, selectedItemId, selectedCollectionId, selectedContextId, tags, editStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { if (onDirtyChange) onDirtyChange(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSave(scheduledDate) {
    if (!name.trim()) {
      // Name is required - just return without saving
      return;
    }
    if (onDirtyChange) onDirtyChange(false);
    if (onUpdate) {
      // Blank is stored as NULL — migration 069's contract. The rule itself lives
      // in utils/intentionRows.js so this screen and the inbox detail page cannot
      // disagree about what "no details" means.
      const detailsToStore = detailsForStorage(description);
      const updates = showScheduling
        ? { text: name, description: detailsToStore, recurrenceConfig, endDate: repeating ? intentEndDate : null, targetStartDate, itemId: selectedItemId || null, contextId: selectedContextId || null, tags, collectionId: selectedCollectionId || null }
        : { text: name, description: detailsToStore, itemId: selectedItemId || null, contextId: selectedContextId || null, tags, collectionId: selectedCollectionId || null };
      if (editableStatus && editStatus !== statusOf(intent)) updates.status = editStatus;
      onUpdate(intent.id, updates, scheduledDate);
    }
    if (!onCancel) {
      // Only control isEditing state if we're not in add mode
      setIsEditing(false);
    }
  }

  function handleCancel() {
    if (onDirtyChange) onDirtyChange(false);
    if (onCancel) {
      onCancel();
    } else {
      setName(intent.text);
      setDescription(intent.description || "");
      setRecurrenceConfig(intent.recurrenceConfig || null);
      setRepeating(getRecurrenceConfig(intent).type !== "once");
      setIntentEndDate(intent.endDate || null);
      setTargetStartDate(intent.targetStartDate || null);
      setTags(intent.tags || []);
      setSelectedItemId(intent.itemId || "");
      setSelectedCollectionId(intent.collectionId || "");
      setItemSearch("");
      setSelectedContextId(intent.contextId || "");
      setEditStatus(statusOf(intent));
      setIsEditing(false);
    }
  }

  // Get context name for badge
  const contextName =
    intent.contextId && contexts
      ? contexts.find((c) => c.id === intent.contextId)?.name
      : null;

  const closedTitle = closedBlockTitle(intent, "intention");
  const actions = recordActions(intent, events, executions);

  if (isEditing) {
    return (
      <EditCard>
        <div className="space-y-3">
          {editableStatus && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">Status</span>
              <StatusPicker value={editStatus} onChange={setEditStatus} options={statusOptionsFor(statusOf(intent))} />
            </div>
          )}
          {formNotice}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded text-base"
              autoFocus
            />
          </div>

          {/* Details — `intents.description`, migration 069. Step 17c.
              Directly under Name, matching the inbox detail page's New Intention
              section, so the same two fields are in the same order wherever an
              intention is written. Labelled "Details" and stored in a column named
              `description`: the label reads well here, the column name matches
              items.description everywhere else. */}
          <div>
            <label htmlFor={`intent-details-${intent.id}`} className="block text-sm font-medium text-foreground mb-1">
              Details
            </label>
            <textarea
              id={`intent-details-${intent.id}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-border rounded text-base resize-y"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Linked Context (optional)
            </label>
            {/* A dropdown, not a typeahead — Step 12.7c. Same rule and same
                reason as the inbox card's: nine contexts, so a search field
                hides the list instead of showing it. Linked Item below stays a
                typeahead — see the note there. */}
            <select
              value={selectedContextId}
              onChange={(e) => setSelectedContextId(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded text-base"
            >
              <option value="">No context</option>
              {contexts?.filter((c) => !c.archived).map((ctx) => (
                <option key={ctx.id} value={ctx.id}>
                  {ctx.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Linked Item (optional)
            </label>
            <div className="relative">
              {/* Items only, as of Step 12.7c — see the note on the context
                  dropdown above. */}
              <ItemPicker
                variant="dropdown"
                items={items}
                contexts={contexts}
                query={itemSearch}
                onQueryChange={setItemSearch}
                onPick={(item) => {
                  setSelectedItemId(item.id);
                  setItemSearch(item.name);
                }}
              />
              <PickedItem
                selectedId={selectedItemId}
                items={items}
                query={itemSearch}
                onClear={() => {
                  setSelectedItemId("");
                  setItemSearch("");
                }}
              />            </div>
          </div>

          {collections.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Linked Collection (optional)
              </label>
              <select
                value={selectedCollectionId}
                onChange={(e) => setSelectedCollectionId(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded text-base"
              >
                <option value="">None</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Tags
            </label>
            <TagPicker value={tags} onChange={setTags} pool={tagPool} />
          </div>

          {/* When: repeat or not, in the inbox's button style. No dates here —
              Schedule/Reschedule on the page own the one live event (step 31).
              The stop date is Repeat's own "Ends on" (intents.end_date). */}
          {showScheduling && (
            <div>
              <span className="block text-sm font-medium text-foreground mb-1">When</span>
              <div className="flex flex-wrap gap-2">
                <WhenButton
                  on={!repeating}
                  onClick={() => {
                    setRepeating(false);
                    setRecurrenceConfig({ type: "once" });
                    setIntentEndDate(null);
                  }}
                  icon={Minus}
                  label="Doesn't repeat"
                />
                <WhenButton
                  on={repeating}
                  onClick={() => setRepeating(true)}
                  icon={Repeat}
                  label="Repeat"
                />
              </div>
              {repeating && (
                <div className="mt-2">
                  <RecurrenceQuickSelect
                    value={recurrenceConfig}
                    onChange={setRecurrenceConfig}
                    onEndDateChange={setIntentEndDate}
                  />
                  {intentEndDate && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Ends {formatEventDate(intentEndDate)}
                      {" · "}
                      <button
                        type="button"
                        onClick={() => setIntentEndDate(null)}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        Remove end date
                      </button>
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Edit and add forms: Save, Cancel, Archive. No scheduling mid-form
              (Restructure P1 steps 18-19). */}
          <PinnedFooter pinned={stickyFooter}>
            <button
              onClick={() => handleSave(null)}
              className="px-3 sm:px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              Save Changes
            </button>

            <button
              onClick={handleCancel}
              className="px-3 sm:px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              Cancel
            </button>

            {onArchive && intent.id && (
              <button
                onClick={() => onArchive(intent.id)}
                disabled={hasActiveExecutions}
                className={`px-3 sm:px-4 py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base ml-auto ${hasActiveExecutions ? 'bg-secondary text-muted-foreground cursor-not-allowed' : 'bg-destructive hover:bg-destructive-hover text-white'}`}
                title={hasActiveExecutions ? 'Cannot archive: active execution in progress' : 'Archive this intention and all related events'}
              >
                Archive
              </button>
            )}
          </PinnedFooter>
        </div>
      </EditCard>
    );
  }

  return (
    <div
      className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow"
      onClick={() => {
        if (onViewDetail) {
          onViewDetail(intent.id);
        } else {
          setIsEditing(true);
        }
      }}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="flex items-start gap-1.5 font-medium">
            <ObjectIcon type="intention" className="w-4 h-4 text-primary" align="first-line" />
            <span className="min-w-0">{getIntentDisplay(intent)}</span>
          </p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <StatusPill row={intent} />
            {/* The one live event is a date on the row, not a nested card. */}
            {(actions.live || actions.open) && (
              <ScheduledLine actions={actions} className="text-xs text-foreground" />
            )}
            {showScheduling && (
              <span className="text-sm text-muted-foreground">
                {getRecurrenceDisplayString(getRecurrenceConfig(intent), intent.endDate)}
              </span>
            )}
            {contextName && (
              <span className="inline-flex items-center gap-1 text-xs bg-warning-light text-foreground px-2 py-0.5 rounded">
                <ObjectIcon type="context" className="w-3.5 h-3.5" />
                {contextName}
              </span>
            )}
            {reminder && (
              <span
                className={`text-xs text-muted-foreground${reminder.muted ? " opacity-70" : ""}`}
                title={reminder.muted ? "Reminder sent (Pacific time)" : "Pending reminder (Pacific time)"}
              >
                🔔 {reminder.text}
              </span>
            )}
            {intent.tags && intent.tags.length > 0 && intent.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="px-2 py-0.5 bg-warning-light text-accent-foreground text-xs rounded-full">
                {tag}
              </span>
            ))}
            {intent.tags && intent.tags.length > 3 && (
              <span className="px-2 py-0.5 bg-secondary/50 text-muted-foreground text-xs rounded-full">
                +{intent.tags.length - 3} more
              </span>
            )}
          </div>
          {/* Step 12.8. ItemCard has carried one of these since Phase 6;
              IntentionCard never got one, so an intention was the only record in
              Alfred whose "Last modified" order you could sort by but not see.
              Same format and same placement as ItemCard's: a text-xs muted span
              below the metadata row. No element count here — an intention has no
              elements — so it is the timestamp alone. */}
          {(intent.updatedAt || intent.lastCompletedAt) && (
            <span className="text-xs text-muted-foreground mt-1 block">
              {/* last_completed_at is set by trigger (Restructure P2); shown only once done. */}
              {[
                intent.lastCompletedAt && `last done: ${shortDate(intent.lastCompletedAt)}`,
                intent.updatedAt && `last updated: ${shortDate(intent.updatedAt)}`,
              ].filter(Boolean).join(" · ")}
            </span>
          )}
          {/* The open execution's latest notes, one line each (batched across the list). */}
          {actions.open && <CardExecutionNotes executionId={actions.open.id} />}
        </div>
        {/* Row action strip — Step 12.1. Matches the one EventCard took in 8a:
            gap-3 because 8px is Material's documented FLOOR for adjacent targets
            rather than a comfortable value and the neighbour here is destructive,
            and self-end sm:self-auto because below the sm breakpoint the parent is
            `flex-col`, where justify-between governs the vertical axis and does
            nothing horizontally — without it the "right-aligned" strip lands on the
            left on exactly the device this app is built for.

            The strip renders when it has something in it. Start Now / Schedule keep
            their own condition; Archive has a different one, which is the whole
            point of the restructure below. */}
        {(showScheduling || (onArchive && intent.id)) && (
          <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
            {/* Same rule as the detail pages (recordActions): always shown,
                labels follow the open execution and the one live event. */}
            {showScheduling && (
              <>
                {onStartNow && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (actions.open) onOpenExecution?.(actions.open);
                      else onStartNow(intent.id);
                    }}
                    disabled={Boolean(closedTitle)}
                    title={closedTitle || undefined}
                    className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] whitespace-nowrap bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Play className="w-4 h-4" />
                    {actions.primaryLabel}
                  </button>
                )}
                {/* Defaults to today (or the date being moved), so scheduling
                    for today stays two taps. The wrapper stops the tap reaching
                    the row's navigate. */}
                {onSchedule && (
                  <span onClick={(e) => e.stopPropagation()} title={closedTitle || actions.moveBlocked || undefined}>
                    <SchedulePopover
                      label={actions.scheduleLabel}
                      initialDate={actions.liveDate || getTodayDate()}
                      onPick={(date) => onSchedule(intent.id, date)}
                      disabled={Boolean(closedTitle || actions.moveBlocked)}
                      // Faded brown still read as live beside a faded Start Now; disabled is tan and flat.
                      className="px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-secondary disabled:hover:bg-secondary disabled:text-foreground disabled:shadow-none disabled:hover:shadow-none"
                    />
                  </span>
                )}
              </>
            )}
            {/* Archive lived only inside the edit form, which governing rule 4
                forbids: archiving changes the record's state, not its content, so
                it belongs on the row. Step 8 gave EventCard this and left its
                sibling behind — that omission is what 12.1 closes.

                Not gated on events. An intention with events is still archivable:
                `archiveIntention` cascades to them and builds the compound Undo
                from Step 2. That is why this sits outside their fragment.

                Gated on `intent.id` so it cannot render in add mode — Step 1's
                defect 0.1 was precisely a phantom record created by an Archive on
                an unsaved card. All four add/edit-form sites pass isEditing={true}
                and so never reach display mode at all; this is the second lock.

                stopPropagation because the whole card is the navigate target as of
                Step 3, so without it this would archive AND open the detail page.

                No Edit button: per 8b, clicking the row already opens detail, and a
                row action never duplicates the row click. */}
            {onArchive && intent.id && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive(intent.id);
                }}
                disabled={hasActiveExecutions}
                title={
                  hasActiveExecutions
                    ? "Cannot archive: active execution in progress"
                    : "Archive this intention and all related events"
                }
                className={`flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg transition-colors shrink-0 ${
                  hasActiveExecutions
                    ? "text-muted-foreground/40 cursor-not-allowed"
                    : "text-muted-foreground hover:text-destructive hover:bg-secondary"
                }`}
              >
                <Archive className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
