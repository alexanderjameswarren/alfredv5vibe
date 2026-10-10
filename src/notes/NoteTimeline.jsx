import React, { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { NOTE_LIST, NOTE_ROW, noteDate } from "./noteFormat";
import ObjectIcon from "../shared/ObjectIcon";
import RecordLinks from "../shared/RecordLinks";
import { storage } from "../utils/storage";

export const DELETE_NOTE_CONFIRM = "Delete this note? This cannot be undone.";

// The inbox detail page's Original capture controls (InboxDetailView): the
// pencil icon button, and its Save (brown, check) and Cancel (tan, X) pair.
const ICON_BUTTON =
  "shrink-0 flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg hover:bg-secondary transition-colors";
const SAVE_BUTTON = "inline-flex items-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-lg text-sm transition-colors";
const SAVE_ON = "bg-primary hover:bg-primary-hover text-white";
const SAVE_OFF = "bg-secondary text-muted-foreground cursor-not-allowed";
const CANCEL_BUTTON = "inline-flex items-center gap-1.5 min-h-[44px] px-3.5 py-2 rounded-lg bg-secondary text-foreground text-sm";
const FIELD = "w-full px-3 py-2.5 border border-border rounded-lg text-base bg-input-background";

export const ARCHIVED_NOTICE = "This is archived, so notes cannot be added. Restore it to add one.";

// A note box. Adding: one brown "Add note". Editing: Save and Cancel.
export function NoteInput({ initial = "", label, submitLabel, onSubmit, onCancel, autoFocus = false }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ready = Boolean(text.trim()) && !busy;

  async function submit() {
    setBusy(true);
    const ok = await onSubmit(text);
    setBusy(false);
    if (ok && !onCancel) setText("");
  }

  return (
    <div className="space-y-2">
      <textarea
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Write a note…"
        autoFocus={autoFocus}
        className={`${FIELD} resize-y min-h-[80px]`}
      />
      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={!ready} className={`${SAVE_BUTTON} ${ready ? SAVE_ON : SAVE_OFF}`}>
          {onCancel ? <Check className="w-4 h-4" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />}
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={CANCEL_BUTTON}>
            <X className="w-4 h-4" aria-hidden="true" />
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Where a note came from, as icon links (RecordLinks): its item, its
 * intention, the execution it was written in. A source that IS the page
 * you are on (`here`: { type, id }) is left out.
 *
 * `sources`: { here, itemName(id), intentionName(id), onViewItem(id),
 * onViewIntention(id), onOpenExecution(execution) }. A missing handler drops
 * that kind of link.
 */
function NoteSourceLinks({ note, sources = {} }) {
  const { here = {}, itemName, intentionName, onViewItem, onViewIntention, onOpenExecution } = sources;
  const isHere = (type, id) => here.type === type && here.id === id;

  const item =
    note.targetType === "item" && onViewItem && !isHere("item", note.targetId)
      ? { name: itemName?.(note.targetId) || "Item", onOpen: () => onViewItem(note.targetId) }
      : null;
  const intention =
    note.targetType === "intention" && onViewIntention && !isHere("intention", note.targetId)
      ? { name: intentionName?.(note.targetId) || "Intention", onOpen: () => onViewIntention(note.targetId) }
      : null;
  const execution =
    note.executionId && onOpenExecution && !isHere("execution", note.executionId)
      ? {
          title: `Open the execution this note was written in (${noteDate(note)})`,
          onOpen: async () => {
            const exec = await storage.get(`execution:${note.executionId}`);
            if (exec) onOpenExecution(exec);
          },
        }
      : null;

  return <RecordLinks intention={intention} item={item} execution={execution} />;
}

/**
 * The grouped list of notes, newest first: one white container, a divider
 * between notes. The author edits (pencil) and deletes (trash, after a
 * confirm); anyone else's note is marked "shared" and has no controls. Only
 * the source links are tappable. Renders nothing for no notes.
 */
export function NoteList({ notes, userId, edit, remove, sources }) {
  const [editing, setEditing] = useState(null);
  if (!notes || notes.length === 0) return null;

  return (
    <ul className={NOTE_LIST}>
      {notes.map((n) => {
        const mine = Boolean(userId) && n.userId === userId;
        return (
          <li key={n.id} className={`text-sm ${NOTE_ROW}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="flex items-center gap-x-1.5 gap-y-0.5 flex-wrap text-xs text-muted-foreground pt-1">
                <ObjectIcon type="note" className="w-3.5 h-3.5" />
                <span>{noteDate(n)}</span>
                <NoteSourceLinks note={n} sources={sources} />
                {!mine && <span>· shared</span>}
              </p>
              {mine && edit && editing !== n.id && (
                <div className="flex -my-2 -mr-2">
                  <button type="button" onClick={() => setEditing(n.id)} aria-label="Edit note" title="Edit this note" className={`${ICON_BUTTON} text-muted-foreground hover:text-foreground`}>
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(DELETE_NOTE_CONFIRM)) remove(n.id);
                    }}
                    aria-label="Delete note"
                    title="Delete this note"
                    className={`${ICON_BUTTON} text-destructive`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
            {editing === n.id ? (
              <div className="mt-1">
                <NoteInput
                  initial={n.body}
                  label="Edit note text"
                  submitLabel="Save"
                  autoFocus
                  onSubmit={async (text) => {
                    const ok = await edit(n.id, text);
                    if (ok) setEditing(null);
                    return ok;
                  }}
                  onCancel={() => setEditing(null)}
                />
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-foreground">{n.body}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Notes section on item and intention detail: the input, then the
 * grouped list. No input while the record is archived.
 */
export default function NoteTimeline({ notesState, archived, heading = "Notes", sources }) {
  const { notes, userId, error, add, edit, remove } = notesState;

  return (
    <section className="mb-6" aria-label={heading}>
      <h3 className="text-lg font-medium mb-3">{heading}</h3>
      {archived ? (
        <p className="text-sm text-muted-foreground mb-3">{ARCHIVED_NOTICE}</p>
      ) : (
        <div className="mb-3">
          <NoteInput label="New note" submitLabel="Add note" onSubmit={add} />
        </div>
      )}
      {error && <p className="text-sm text-destructive mb-2">{error}</p>}
      {notes === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet</p>
      ) : (
        <NoteList notes={notes} userId={userId} edit={edit} remove={remove} sources={sources} />
      )}
    </section>
  );
}
