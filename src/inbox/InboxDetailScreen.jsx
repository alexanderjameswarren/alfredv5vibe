import React from "react";
import RecurrenceQuickSelect from "../shared/recurrence/RecurrenceQuickSelect";
import { clipIdFor } from "../utils/capturedClip";
import InboxDetailView from "./InboxDetailView";
import ClipboardCapture from "./ClipboardCapture";
import PendingReminder from "./PendingReminder";

// The inbox detail route, moved out of Alfred.jsx unchanged apart from the
// `view === "inbox-detail" && routeInboxItem` test, which stays in Alfred.
export default function InboxDetailScreen({
  routeInboxItem,
  contexts,
  items,
  tagPool,
  handleInboxSave,
  discardInboxItem,
  guardedSetView,
  setUnsavedChanges,
  updateInboxCaptureText,
}) {
  return (
    <InboxDetailView
      key={routeInboxItem.id}
      inboxItem={routeInboxItem}
      contexts={contexts}
      items={items}
      tagPool={tagPool}
      onProcess={handleInboxSave}
      onDiscard={discardInboxItem}
      // Guarded: Back is the one exit that can be taken with a form full of
      // unsaved work and no intention of abandoning it. Cancel and Discard
      // clear the flag themselves before calling this.
      onBack={() => guardedSetView("inbox")}
      onDirtyChange={setUnsavedChanges}
      // Step 17b. Correcting a capture's text, which is not triage: the row
      // stays in the inbox. Alex ruled this back in — without it, retiring
      // the inbox card in Step 18 would leave no way to fix a typo.
      onSaveCaptureText={updateInboxCaptureText}
      // Passed in rather than imported: RecurrenceQuickSelect lives in this
      // file, which imports InboxDetailView, so importing back would be a
      // cycle — and moving it would drag its two dialogs along.
      renderRecurrence={({ value, onChange, onEndDateChange }) => (
        <RecurrenceQuickSelect
          value={value}
          onChange={onChange}
          onEndDateChange={onEndDateChange}
        />
      )}
      // Step 19. What a clipboard or CLI capture actually captured. Keyed by
      // clip id so moving between two captures remounts it rather than
      // showing the previous one's screenshot while the new one loads.
      renderCapturedContent={(item) => {
        const clipId = clipIdFor(item);
        if (!clipId) return null;
        return <ClipboardCapture key={clipId} clipId={clipId} inboxItem={item} />;
      }}
      renderReminders={(item) => <PendingReminder key={item.id} inboxId={item.id} />}
    />
  );
}
