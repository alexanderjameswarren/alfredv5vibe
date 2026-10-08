import React, { useState } from "react";
import { Archive, Play } from "lucide-react";
import { supabase } from "../supabaseClient";
import ObjectIcon from "../shared/ObjectIcon";
import { formatEventDate } from "../utils/eventDates";
import { closedBlockTitle, RUN_ACTIVE_MOVE_REASON } from "../utils/status";
import EventMetaLink from "./EventMetaLink";

export default function EventCard({
  event,
  intent,
  contexts,
  onUpdate,
  onActivate,
  getIntentDisplay,
  executions = [],
  onOpenExecution,
  onCancelExecution,
  nested = false,
  // Step 12.9. An event card used to name only itself — a title, a date, a
  // status — so an event carrying its own `text` was a dead end: nothing on it
  // said which intention it came from or which item that intention is about,
  // and neither was reachable.
  //
  // Each of the three links is gated on ITS OWN handler rather than on
  // `nested`, because "already established by the surrounding UI" is a fact
  // about the caller, not about depth. Intention detail passes onViewItem and
  // onViewContextDetail but not onViewIntention — you are standing on the
  // intention. The nested site inside IntentionCard passes none of the three:
  // the card immediately above already carries all of them.
  items = [],
  onViewIntention,
  onViewItem,
  onViewContextDetail,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(event.time);
  const [eventName, setEventName] = useState(event.text || intent?.text || "");

  function handleSave() {
    // The date stays put while its run is active; the name may still change.
    onUpdate(event.id, runIsActive ? { text: eventName } : { time: scheduledDate, text: eventName });
    setIsEditing(false);
  }

  async function handleCancelEvent() {
    // Double-check for active execution
    const { data: activeExecs } = await supabase
      .from('executions')
      .select('id')
      .eq('event_id', event.id)
      .is('closed_at', null);

    if (activeExecs && activeExecs.length > 0) {
      alert('Cannot archive: this event has an active execution. Complete or cancel it first.');
      return;
    }

    // Delete the execution if one exists for this event
    if (onCancelExecution) {
      await onCancelExecution(event.id);
    }
    // Archive the event
    onUpdate(event.id, { archived: true });
    setIsEditing(false);
  }

  const execution = executions.find((ex) => ex.eventId === event.id);

  // Was a per-row `supabase.from('executions')` query on mount, which on the
  // Schedule page meant one round trip per event. It asked
  // `event_id = … AND closed_at IS NULL` — which is precisely the set the
  // `executions` prop already holds, because callers pass allLiveExecutions
  // (active + paused, both closed_at null). So `execution` above had already
  // answered the question the query was asking.
  //
  // `handleCancelEvent`'s own check stays: that one runs at the moment of the
  // write and guards against a stale client, which is a different job from
  // deciding whether to grey a button out.
  const hasActiveExecution = Boolean(execution);
  const runIsActive = execution?.status === "active";
  // A kept event of a closed intention: Start would run something status says is over.
  const closedTitle = intent ? closedBlockTitle(intent, "intention") : null;
  // The edit form's Start Now: one open run per intention, nothing on a closed one.
  const openRun = executions.find((ex) => ex.intentId === event.intentId);
  const startBlocked = closedTitle || (openRun ? "This intention already has an open execution. Continue it instead." : null);

  // The title, hoisted out of the JSX because the two links below compare
  // against it to decide whether to spell their own name out.
  const eventTitle = event.text || getIntentDisplay(intent);
  const intentionName = intent ? getIntentDisplay(intent) : null;
  const linkedItem = intent?.itemId
    ? items.find((i) => i.id === intent.itemId)
    : null;

  // Events copy `contextId` from their intention at creation — see
  // `moveToPlanner` — so most carry one. Two cases where the copy is not the
  // answer: an event made by a path that never set it, and an intention
  // re-homed after its event was already scheduled, which leaves the copy
  // pointing at the old context. Falling back to the intention's context
  // covers both. The event's own value still wins where it has one, because an
  // event deliberately scheduled into a different context is a real thing.
  const contextId = event.contextId || intent?.contextId || null;
  const contextName = contextId
    ? contexts.find((c) => c.id === contextId)?.name
    : null;

  // Following a link out of the EDIT form unmounts it and drops whatever is
  // typed. EventCard never joined the app's `onDirtyChange` plumbing — that is
  // wired to ItemCard and IntentionCard, the two page-sized surfaces that own
  // a whole screen — so this small inline form asks on its own, reusing the
  // wording `handleBackFromIntentionDetail` uses for the same situation.
  const isDirty =
    eventName !== (event.text || intent?.text || "") ||
    scheduledDate !== event.time;

  function confirmLeaveEditForm() {
    if (!isDirty) return true;
    return window.confirm(
      "You have unsaved changes to this event. Discard and navigate away?",
    );
  }

  // Rendered in BOTH modes, so it is a function rather than two copies of the
  // markup. A plain call, not a `<Component/>` — it closes over everything the
  // chips need, which is a dozen values that would otherwise become props, and
  // calling it inline keeps React out of the remount question entirely.
  //
  // `guard` is the only thing that differs between the two call sites.
  const showIntentionLink = Boolean(onViewIntention && intent?.id);
  const showItemLink = Boolean(onViewItem && linkedItem);
  // Hoisted rather than left as an early return inside the renderer, because
  // the edit form needs the answer BEFORE it decides whether to draw a label
  // above the row — and asking by calling the renderer and testing the result
  // means rendering it twice.
  const hasMetaRow = Boolean(contextName || showIntentionLink || showItemLink);

  function renderMetaRow(guard) {
    if (!hasMetaRow) return null;

    return (
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs">
        {contextName &&
          (onViewContextDetail ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (guard && !guard()) return;
                onViewContextDetail(contextId);
              }}
              title={`Open context: ${contextName}`}
              className="inline-flex items-center gap-1 bg-warning-light hover:bg-warning text-foreground px-2 py-1 rounded transition-colors"
            >
              <ObjectIcon type="context" className="w-3.5 h-3.5" />
              {contextName}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 bg-warning-light text-foreground px-2 py-1 rounded">
              <ObjectIcon type="context" className="w-3.5 h-3.5" />
              {contextName}
            </span>
          ))}
        {showIntentionLink && (
          <EventMetaLink
            icon={<ObjectIcon type="intention" className="w-3.5 h-3.5" />}
            name={intentionName}
            showName={intentionName !== eventTitle}
            onClick={() => onViewIntention(intent.id)}
            guard={guard}
            title={`Open intention: ${intentionName}`}
          />
        )}
        {showItemLink && (
          <EventMetaLink
            icon={<ObjectIcon type="item" className="w-3.5 h-3.5" />}
            name={linkedItem.name}
            showName={linkedItem.name !== eventTitle}
            onClick={() => onViewItem(linkedItem.id)}
            guard={guard}
            title={`Open item: ${linkedItem.name}`}
          />
        )}
      </div>
    );
  }

  // Show editable form when there's no execution
  if (isEditing) {
    return (
      <div className="p-3 sm:p-4 bg-card border-2 border-primary rounded-lg shadow-md">
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Event Name
            </label>
            <input
              type="text"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              className="w-full px-3 py-2 min-h-[44px] border border-border rounded text-base"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Scheduled Date
            </label>
            <input
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
              disabled={runIsActive}
              title={runIsActive ? RUN_ACTIVE_MOVE_REASON : undefined}
              className="w-full px-3 py-2 min-h-[44px] border border-border rounded disabled:opacity-50"
            />
            {runIsActive && <p className="mt-1 text-xs text-muted-foreground">{RUN_ACTIVE_MOVE_REASON}</p>}
          </div>

          {/* The same chips the display row carries. Opening the form used to
              be a one-way door: the two things an event is ABOUT stopped being
              visible at exactly the moment you were looking at the event
              closely enough to edit it.

              Labelled, unlike the display row, because here they sit among
              labelled inputs and an unlabelled chip strip would read as a third
              field. Read-only — these navigate, they do not edit — hence the
              dirty guard on every one of them.

              Same `!nested` rule as display mode: one rule for the card, not
              one per mode. */}
          {!nested && hasMetaRow && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Linked records
              </label>
              {renderMetaRow(confirmLeaveEditForm)}
            </div>
          )}

          {/* Standard footer order: primary, Cancel, gap, Archive pushed right.
              This was Save · Archive · Close, with the destructive action sitting
              between the two safe ones — the only footer in the app where a
              mis-tap on the button next to Save archived the record. The third
              button is also renamed: it resets the fields and leaves, which is
              Cancel, and calling it Close made it read like a fourth kind of
              thing next to three cards that all say Cancel. */}
          <div className="flex flex-wrap gap-2">
            {/* Teal Start Now, leftmost, as on the detail pages. Runs this event;
                a run already open on the intention, or a closed intention, says why not. */}
            <button
              onClick={() => {
                setIsEditing(false);
                onActivate(event.id);
              }}
              disabled={Boolean(startBlocked)}
              title={startBlocked || undefined}
              className="flex items-center gap-2 px-4 py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-4 h-4" />
              Start Now
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Save
            </button>
            <button
              onClick={() => {
                setScheduledDate(event.time);
                setEventName(event.text || intent?.text || "");
                setIsEditing(false);
              }}
              className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Cancel
            </button>
            <button
              onClick={handleCancelEvent}
              disabled={hasActiveExecution}
              className={`px-4 py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 ml-auto ${hasActiveExecution ? 'bg-secondary text-muted-foreground cursor-not-allowed' : 'bg-destructive hover:bg-destructive-hover text-white'}`}
              title={hasActiveExecution ? 'Cannot archive: active execution in progress' : 'Archive this event'}
            >
              Archive Event
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    // Whole-card clickable, like ItemCard and IntentionCard. Previously only the
    // title column responded, leaving the padding and the gap beside the
    // Start/Continue button dead.
    //
    // The stopPropagation moved up here with the handler, and still matters for
    // the same reason it did on the title block: IntentionCard renders its
    // related events nested INSIDE its own onClick div, so without it a click
    // runs this handler and the parent's together (defect 0.3). Inert at the
    // four top-level sites, load-bearing at the nested one.
    <div
      onClick={(e) => {
        e.stopPropagation();
        if (execution && onOpenExecution) {
          onOpenExecution(execution);
        } else {
          setIsEditing(true);
        }
      }}
      className={`p-3 bg-card border border-border rounded-lg cursor-pointer shadow-sm hover:shadow-md transition-shadow duration-200 ${
        // Deferred from Step 3, settled here. Every other whole-card-clickable
        // card has hover:border-primary; EventCard could not take it because it
        // also renders NESTED inside IntentionCard, whose own hover already
        // fires on the nested child — a second border would light two cards for
        // one click target that stopPropagation resolves to the inner one.
        //
        // Suppressing the parent's highlight instead would need a has-[…]
        // variant (available in Tailwind 3.4) reaching into a child's hover
        // state, which is a fragile selector to leave behind for one row type.
        // Gating on `nested` is the same outcome in a prop that already exists.
        //
        // The nested row does not lose its affordance: as of Step 8a every
        // EventCard carries always-visible Start/Continue and Archive buttons,
        // so interactivity is advertised by controls rather than by hover.
        nested ? "" : "hover:border-primary"
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex-1 min-w-0">
          {/* The glyph replaces the "Event: " prefix the nested variant used
              to carry. Same job — say what kind of record this row is — done
              in the vocabulary every other surface uses, and done on the
              top-level rows too, which never had the prefix and so were the
              one place an event did not announce itself. */}
          <p className="flex items-start gap-1.5 font-medium text-foreground hover:text-primary">
            <ObjectIcon type="event" className="w-4 h-4" align="first-line" />
            <span className="min-w-0">{eventTitle}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            {formatEventDate(event.time)} • {execution ? (execution.status === "active" ? "In progress" : "Paused") : "Not started"}
          </p>
          {/* Phones show no tooltips; desktop has Start's title instead. */}
          {closedTitle && !execution && (
            <p className="sm:hidden text-xs text-muted-foreground">{closedTitle}</p>
          )}
          {/* Suppressed entirely when nested. The IntentionCard this sits
              inside renders the same context badge two lines above, and its
              own row IS the intention — so every chip here would be a repeat
              of something already on screen within about 40px. The three link
              handlers are withheld at that site for the same reason; this
              guard covers the badge, which has no handler to withhold. */}
          {!nested && hasMetaRow && (
            <div className="mt-1">{renderMetaRow()}</div>
          )}
        </div>
        {/* Row action strip: Start/Continue then Archive, right-aligned and
            always visible — never hover-revealed, because the primary device is
            a touchscreen. No Edit button: clicking the row already opens the
            edit form, and a row action never duplicates the row click.

            Every button here stops propagation. They are descendants of the
            card's own onClick as of Step 3, so without it each would fire its
            action AND open the edit form. */}
        {/* gap-3 not gap-2: 8px is Material's documented FLOOR for adjacent
            targets, not a comfortable value, and the neighbour here is
            destructive. On a touchscreen a thumb landing between Start and
            Archive was a coin flip.

            self-end because below the sm breakpoint the parent is `flex-col`,
            where justify-between governs the VERTICAL axis and does nothing
            horizontally — so the "right-aligned" strip was left-aligned on
            exactly the device this app is built for. */}
        <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
          {execution ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (onOpenExecution) onOpenExecution(execution);
            }}
            // Teal is the primary action colour app-wide. An open run reads
            // Continue whether active or paused; the line above says which.
            className="flex items-center justify-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 shrink-0 text-sm sm:text-base bg-success hover:bg-success-hover text-white"
          >
            <Play className="w-3 h-3" />
            Continue
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onActivate(event.id);
            }}
            disabled={Boolean(closedTitle)}
            title={closedTitle || undefined}
            className="flex items-center justify-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 shrink-0 text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="w-3 h-3" />
            Start
          </button>
        )}
        {/* Archive lived only inside the edit form, which governing rule 4
            forbids: archiving changes the record's state, not its content, so
            it belongs on the row. Disabled while an execution is open, the same
            rule the form applies. `onUpdate` routes to updateEvent, which
            already offers the Undo. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleCancelEvent();
          }}
          disabled={hasActiveExecution}
          title={
            hasActiveExecution
              ? "Cannot archive: active execution in progress"
              : "Archive this event"
          }
          className={`flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg transition-colors shrink-0 ${
            hasActiveExecution
              ? "text-muted-foreground/40 cursor-not-allowed"
              : "text-muted-foreground hover:text-destructive hover:bg-secondary"
          }`}
        >
            <Archive className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
