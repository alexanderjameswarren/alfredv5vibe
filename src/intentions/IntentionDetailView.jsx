import React, { useState } from "react";
import { Archive, ArrowLeft, Play, Settings } from "lucide-react";
import { getTodayDate } from "../utils/eventDates";
import { getRecurrenceConfig } from "../utils/recurrence";
import { getRecurrenceDisplayString } from "../utils/recurrenceDisplay";
import ObjectIcon from "../shared/ObjectIcon";
import DetailMeta from "../shared/DetailMeta";
import SchedulePopover from "../shared/recurrence/SchedulePopover";
import PendingReminder from "../PendingReminder";
import OriginalCapture from "../OriginalCapture";
import IntentionCard from "./IntentionCard";
import ItemCard from "../items/ItemCard";
import EventCard from "../schedule/EventCard";

export default function IntentionDetailView({
  tagPool = [],
  intention,
  // The capture this intention was filed from, resolved by the caller from
  // `sourceInboxId`. Null for one created by hand. See OriginalCapture.
  capturedText,
  events,
  contexts,
  items,
  onBack,
  onUpdateIntention,
  onEditIntention,
  onUpdateEvent,
  onUpdateItem,
  onActivate,
  getIntentDisplay,
  onViewItemDetail,
  // Step 12.9. Threaded through purely so the event cards below can make their
  // context badge a link; nothing else on this page uses it.
  onViewContextDetail,
  executions = [],
  onOpenExecution,
  onCancelExecution,
  onArchiveIntention,
  onSchedule,
  onStartNow,
  collections = [],
  onDirtyChange,
}) {
  const [isEditing, setIsEditing] = useState(false);

  if (!intention) return null;

  // Filter events for this intention that aren't archived
  const intentionEvents = events.filter(
    (e) => e.intentId === intention.id && !e.archived,
  );

  // `executions` is allLiveExecutions — active plus paused, which is exactly
  // the set IntentionCard's own guard queries the database for. Same rule,
  // no round trip.
  const hasActiveExecutions = executions.some(
    (ex) => ex.intentId === intention.id,
  );

  // Get context name for badge
  const contextName =
    intention.contextId && contexts
      ? contexts.find((c) => c.id === intention.contextId)?.name
      : null;

  // If editing, show the IntentionCard in edit mode
  if (isEditing) {
    return (
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <IntentionCard
          tagPool={tagPool}
          intent={intention}
          contexts={contexts}
          items={items}
          collections={collections}
          onUpdate={(id, updates, scheduledDate) => {
            onUpdateIntention(id, updates, scheduledDate);
            setIsEditing(false);
          }}
          onSchedule={(id, date) => {
            // Don't need to schedule here, just close edit mode
            setIsEditing(false);
          }}
          getIntentDisplay={getIntentDisplay}
          showScheduling={true}
          isEditing={true}
          onCancel={() => setIsEditing(false)}
          onArchive={onArchiveIntention}
          // Required as of Step 8a: the card's archive guard is derived from
          // this prop now rather than from its own query, and this was the one
          // onArchive site that did not pass it. Without it the guard silently
          // reads "no executions" and Archive stays enabled mid-execution.
          executions={executions}
          onDirtyChange={onDirtyChange}
          // Same reasoning as item detail: alone on the page.
          stickyFooter
        />
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      {/* Header, as of Phase 1b: title on its own full-width row, then the
          record's metadata, then the actions on a row of their own.

          The title and the buttons used to share a flex row, the buttons
          holding a fixed width on the right. A long intention was squeezed into
          whatever column was left and broke across four or five lines while
          empty space sat beside it. Nothing here competes for horizontal room
          any more. Structurally identical to ItemDetailView's header. */}
      <div className="mb-4 sm:mb-6">
        <h2 className="flex items-start gap-2 text-xl sm:text-2xl font-bold">
          <ObjectIcon type="intention" className="w-6 h-6 text-primary" align="first-line" />
          <span className="min-w-0">{intention.text}</span>
        </h2>

        {/* Details — `intents.description`, migration 069. Step 17c.
            Below the name and above the metadata, because it is the intention's
            own prose rather than a fact about the record. Absent entirely when
            empty: an always-present blank paragraph would push the metadata down
            on every intention to serve the few that have one.
            `whitespace-pre-wrap`, unlike `items.description` a screen away, and
            the difference is deliberate — this field is long text and paragraph
            breaks are content. */}
        {intention.description && (
          <p className="mt-2 text-muted-foreground whitespace-pre-wrap">
            {intention.description}
          </p>
        )}

        <DetailMeta contextName={contextName} tags={intention.tags} />

        <p className="text-sm text-muted-foreground mt-2">
          Recurrence: {getRecurrenceDisplayString(getRecurrenceConfig(intention), intention.endDate)}
        </p>

        <PendingReminder intentId={intention.id} />

        {/* Record actions, in the spec's order:
            Do Today · Schedule Later · Start Now · Edit · Archive.

            Left-aligned now that they have their own row — they line up with
            the title above rather than floating off to the right of it.

            Do Today and Start Now are gated on having no events, matching
            IntentionCard: once something is scheduled, scheduling it again
            from the same screen is not the action anyone wants. */}
        <div className="flex flex-wrap gap-2 mt-3">
          {/* The slot Step 5 left open. No form to save here, so these commit
              the schedule directly. Opening downward — this bar is at the top
              of the page. */}
          {onSchedule && intentionEvents.length === 0 && (
            <>
              <SchedulePopover
                label="Do Today"
                initialDate={getTodayDate()}
                onPick={(date) => onSchedule(intention.id, date)}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              />
              <SchedulePopover
                label="Schedule Later"
                onPick={(date) => onSchedule(intention.id, date)}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              />
            </>
          )}
          {onStartNow && intentionEvents.length === 0 && (
            <button
              onClick={() => onStartNow(intention.id)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Play className="w-4 h-4" />
              Start Now
            </button>
          )}
          <button
            onClick={() => setIsEditing(true)}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
          >
            <Settings className="w-4 h-4" />
            <span className="hidden sm:inline">Edit Intention</span>
            <span className="sm:hidden">Edit</span>
          </button>
          {/* Archive was previously reachable only from inside the edit form.
              The same active-execution guard IntentionCard applies, but read
              from the `executions` prop already in hand rather than with a
              fresh query — the card does its own round trip, which this page
              does not need. */}
          {onArchiveIntention && (
            <button
              onClick={() => onArchiveIntention(intention.id)}
              disabled={hasActiveExecutions}
              title={
                hasActiveExecutions
                  ? "Cannot archive: active execution in progress"
                  : "Archive this intention and all related events"
              }
              className={`flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base ${
                hasActiveExecutions
                  ? "bg-secondary text-muted-foreground cursor-not-allowed"
                  : "bg-destructive hover:bg-destructive-hover text-white"
              }`}
            >
              <Archive className="w-4 h-4" />
              <span className="hidden sm:inline">Archive</span>
            </button>
          )}
        </div>
      </div>

      {/* Linked Item Section */}
      {intention.itemId && items && (
        <div className="mb-6">
          <h3 className="text-lg font-medium mb-3">Linked Item</h3>
          {(() => {
            const linkedItem = items.find((i) => i.id === intention.itemId);
            return linkedItem ? (
              <ItemCard
                tagPool={tagPool}
                item={linkedItem}
                contexts={contexts}
                onUpdate={onUpdateItem}
                onViewDetail={onViewItemDetail}
                executions={executions.filter((ex) => ex.itemIds?.includes(linkedItem.id))}
                intents={[intention]}
                getIntentDisplay={getIntentDisplay}
                onOpenExecution={onOpenExecution}
              />
            ) : (
              <p className="text-muted-foreground text-sm">Item not found</p>
            );
          })()}
        </div>
      )}

      <div>
        <h3 className="text-lg font-medium mb-3">
          Scheduled Events ({intentionEvents.length})
        </h3>
        {intentionEvents.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No events scheduled for this intention
          </p>
        ) : (
          <div className="space-y-2">
            {intentionEvents.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                intent={intention}
                contexts={contexts}
                onUpdate={onUpdateEvent}
                onActivate={onActivate}
                getIntentDisplay={getIntentDisplay}
                executions={executions}
                onOpenExecution={onOpenExecution}
                onCancelExecution={onCancelExecution}
                items={items}
                onViewItem={onViewItemDetail}
                onViewContextDetail={onViewContextDetail}
                // No onViewIntention: this page IS the intention, so the link
                // would point at the screen you are already reading.
              />
            ))}
          </div>
        )}
      </div>

      {/* Last on the page, and only when this intention was filed from a capture. */}
      <OriginalCapture capturedText={capturedText} />
    </div>
  );
}
