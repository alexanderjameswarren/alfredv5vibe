import React from "react";
import IntentionCard from "../intentions/IntentionCard";
import ItemCard from "../items/ItemCard";
import GroupRowCard from "../groups/GroupRowCard";
import useRowClose from "./useRowClose";

/**
 * The rows of a one-row-per-thing list (Restructure P4), shared by context detail
 * and the Intentions list so both read and act the same. A row with a picked
 * intention is an IntentionCard reading as its item (or as itself when it has
 * none); a row with no pick is an ItemCard with item detail's Start Now and
 * Schedule. Every row closes rather than archives. `reminderFor(row)` is optional.
 */
export default function RowList({
  rows,
  events = [],
  executions = [],
  contexts,
  allItems = [],
  allIntents = [],
  collections = [],
  tagPool = [],
  getIntentDisplay,
  onUpdateIntent,
  onUpdateItem,
  onSchedule,
  onStartNow,
  onStartNowItem,
  onScheduleItem,
  onViewItemDetail,
  onViewIntentionDetail,
  onUpdateEvent,
  onActivate,
  onOpenExecution,
  onCancelExecution,
  onCloseRecords,
  // Restructure P5: group rows (kind "group") open the group detail page.
  onViewGroupDetail,
  // Step 13: (groupId, date), through the group's own intention.
  onScheduleGroup,
  // Step 14: (groupId) Start Now on a menu row.
  onStartGroupNow,
  reminderFor = () => null,
}) {
  const rowClose = useRowClose({ events, executions, onCloseRecords });
  return (
    <>
      <div className="space-y-2">
        {rows.map((row) =>
          row.kind === "group" ? (
            <GroupRowCard
              key={row.key}
              row={row}
              contextName={contexts?.find((c) => c.id === row.group.contextId)?.name}
              onOpen={onViewGroupDetail}
              onSchedule={onScheduleGroup}
              onStartNow={row.type?.executionMode === "together" ? onStartGroupNow : null}
              onOpenExecution={onOpenExecution}
              {...rowClose.closeProps(row)}
            />
          ) : row.intent ? (
            <IntentionCard
              tagPool={tagPool}
              key={row.key}
              row={row}
              intent={row.intent}
              contexts={contexts}
              items={allItems}
              collections={collections}
              getIntentDisplay={getIntentDisplay}
              onUpdate={onUpdateIntent}
              onSchedule={onSchedule}
              onStartNow={onStartNow}
              showScheduling={true}
              // A merged row is the item: it opens item detail.
              onViewDetail={row.item ? () => onViewItemDetail?.(row.item.id) : onViewIntentionDetail}
              reminder={reminderFor(row)}
              events={events}
              onUpdateEvent={onUpdateEvent}
              onActivate={onActivate}
              executions={executions}
              onOpenExecution={onOpenExecution}
              onCancelExecution={onCancelExecution}
              // Rows close; Archive is on the detail pages.
              {...rowClose.closeProps(row)}
            />
          ) : (
            <ItemCard
              tagPool={tagPool}
              key={row.key}
              item={row.item}
              contexts={contexts}
              onUpdate={onUpdateItem}
              onViewDetail={onViewItemDetail}
              allItems={allItems}
              executions={executions.filter((ex) => ex.itemIds?.includes(row.item.id))}
              // Every intention: a run's intention may live elsewhere, and a badge
              // that cannot find it reads "Execution".
              intents={allIntents}
              getIntentDisplay={getIntentDisplay}
              onOpenExecution={onOpenExecution}
              scheduleLine="Not scheduled"
              onStartNow={onStartNowItem}
              onSchedule={onScheduleItem}
              showContext
              {...rowClose.closeProps(row)}
            />
          ),
        )}
      </div>
      {rowClose.sheet}
    </>
  );
}
