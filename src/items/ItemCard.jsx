import React, { useState, useEffect, useRef } from "react";
import { Copy, GripVertical, X } from "lucide-react";
import { offsetPatch, isFirstStep } from "../utils/elementOffsets";
import EditCard from "../shared/EditCard";
import PinnedFooter from "../shared/PinnedFooter";
import TagPicker from "../shared/TagPicker";
import ItemPicker from "../shared/ItemPicker";
import InsertRowButton from "../shared/InsertRowButton";
import RepeatBlockDialog from "../shared/RepeatBlockDialog";
import ObjectIcon from "../shared/ObjectIcon";
import ExecutionBadge from "../executions/ExecutionBadge";
import CardExecutionNotes from "../notes/CardExecutionNotes";
import { shortDate } from "../notes/noteFormat";
import StatusPill from "../shared/StatusPill";
import StatusPicker from "../shared/StatusPicker";
import { statusOf, statusOptionsFor } from "../utils/status";

export default function ItemCard({
  item,
  contexts,
  tagPool = [],
  onUpdate,
  isEditing: initialEditing = false,
  onCancel,
  onViewDetail,
  allItems = [],
  executions = [],
  intents = [],
  getIntentDisplay,
  onOpenExecution,
  onDirtyChange,
  // True only where this card IS the page — item detail's edit mode. Inside a
  // list it must stay false: sibling cards can be open at once, and several
  // footers each pinned to the same strip of viewport is nonsense.
  stickyFooter = false,
  // `{ text, muted }` for the capture this item came from. Memories list only.
  reminder = null,
  // Edit form only: a status picker whose choice goes out with Save, as `status`.
  editableStatus = false,
}) {
  const [isEditing, setIsEditing] = useState(initialEditing);
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description || "");
  const [contextId, setContextId] = useState(item.contextId || "");
  const [elements, setElements] = useState(
    (item.elements || item.components || []).map((el) =>
      typeof el === "string"
        ? { name: el, displayType: "step", quantity: "", description: "" }
        : {
            name: el.name || "",
            displayType: el.displayType || el.display_type || "step",
            quantity: el.quantity || "",
            description: el.description || "",
            ...(el.itemId || el.item_id ? { itemId: el.itemId || el.item_id } : {}),
            ...(el.collectable ? { collectable: true } : {}),
            ...offsetPatch(el),
          },
    ),
  );
  const [tags, setTags] = useState(item.tags || []);
  const [editStatus, setEditStatus] = useState(statusOf(item));
  const [isCaptureTarget, setIsCaptureTarget] = useState(
    item.isCaptureTarget || false,
  );
  const [draggedIndex, setDraggedIndex] = useState(null);
  // Which row anchors the repeat block, or null. Anchoring on the tapped row is
  // what lets a block be chosen without a drag-select gesture — see
  // RepeatBlockDialog for the reasoning.
  const [repeatFromIndex, setRepeatFromIndex] = useState(null);
  const [linkingElementIndex, setLinkingElementIndex] = useState(null);
  const [linkSearch, setLinkSearch] = useState("");
  const elementDescRefs = useRef([]);
  const itemDescRef = useRef(null);

  useEffect(() => {
    if (!isEditing || !onDirtyChange) return;
    const originalElements = (item.elements || item.components || []).map((el) =>
      typeof el === "string"
        ? { name: el, displayType: "step", quantity: "", description: "" }
        : {
            name: el.name || "",
            displayType: el.displayType || el.display_type || "step",
            quantity: el.quantity || "",
            description: el.description || "",
            ...(el.itemId || el.item_id ? { itemId: el.itemId || el.item_id } : {}),
            ...(el.collectable ? { collectable: true } : {}),
            ...offsetPatch(el),
          }
    );
    const isDirty =
      name !== item.name ||
      description !== (item.description || "") ||
      contextId !== (item.contextId || "") ||
      JSON.stringify(tags) !== JSON.stringify(item.tags || []) ||
      isCaptureTarget !== (item.isCaptureTarget || false) ||
      editStatus !== statusOf(item) ||
      JSON.stringify(elements) !== JSON.stringify(originalElements);
    onDirtyChange(isDirty, "this item");
  }, [isEditing, name, description, contextId, elements, tags, isCaptureTarget, editStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { if (onDirtyChange) onDirtyChange(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSave() {
    if (!name.trim()) {
      // Name is required - just return without saving
      return;
    }
    if (onDirtyChange) onDirtyChange(false);
    const finalContextId = contextId === "" ? null : contextId;
    onUpdate(item.id, {
      name,
      description,
      contextId: finalContextId,
      elements,
      tags,
      isCaptureTarget,
      // Only when changed; the caller applies it after the fields (storage.patch).
      ...(editableStatus && editStatus !== statusOf(item) ? { status: editStatus } : {}),
    });
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
      setName(item.name);
      setDescription(item.description || "");
      setContextId(item.contextId || "");
      setElements(
        (item.elements || item.components || []).map((el) =>
          typeof el === "string"
            ? { name: el, displayType: "step", quantity: "", description: "" }
            : { ...el },
        ),
      );
      setTags(item.tags || []);
      setEditStatus(statusOf(item));
      setIsCaptureTarget(item.isCaptureTarget || false);
      setIsEditing(false);
    }
  }

  function addElement() {
    setElements([
      ...elements,
      { name: "", displayType: "step", quantity: "", description: "" },
    ]);
    setTimeout(() => {
      const inputs = document.querySelectorAll('.element-input');
      if (inputs.length) {
        inputs[inputs.length - 1].scrollIntoView({ block: 'nearest' });
        inputs[inputs.length - 1].focus();
      }
    }, 50);
  }

  function insertElementAbove(index) {
    const newElements = [...elements];
    newElements.splice(index, 0, {
      name: "",
      displayType: "step",
      quantity: "",
      description: "",
    });
    setElements(newElements);
    setTimeout(() => {
      const inputs = document.querySelectorAll('.element-input');
      if (inputs[index]) {
        inputs[index].scrollIntoView({ block: 'nearest' });
        inputs[index].focus();
      }
    }, 50);
  }

  function updateElement(index, field, value) {
    const newElements = [...elements];
    const next = { ...newElements[index], [field]: value };
    // `collectable` means "this is a thing you can buy" and only applies to
    // bullets. Changing a row away from bullet drops the flag rather than
    // leaving it set on a row whose checkbox is no longer rendered: an
    // invisible flag would still surface the row in Add to Collection.
    if (field === "displayType" && value !== "bullet") delete next.collectable;
    // Same reasoning for the scheduling gap, which only applies to steps.
    if (field === "displayType" && value !== "step") delete next.offsetMinutes;
    newElements[index] = next;
    setElements(newElements);
  }

  function handleItemNameChange(newName) {
    setName(newName);
  }

  // Names and element text are one line where they render; a pasted newline becomes a space.
  const oneLine = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ');

  function handleElementNameChange(index, newName) {
    updateElement(index, 'name', oneLine(newName));
  }

  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    // 0 while not laid out (hidden); leave it at its two-row height then.
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }

  function copyElementToClipboard(el, itemsList) {
    const linkedItem = (el.itemId || el.item_id) ? itemsList.find((i) => i.id === (el.itemId || el.item_id)) : null;
    let text = el.name;
    if (el.description) text += " " + el.description;
    if (el.quantity) text += " qty:" + el.quantity;
    if (linkedItem) text += " related item:" + linkedItem.name;
    navigator.clipboard.writeText(text);
  }

  function deleteElement(index) {
    setElements(elements.filter((_, i) => i !== index));
  }

  // keydown, not keypress: in a textarea some phone keyboards never fire keypress
  // for Enter, and it would insert a newline instead of a new row.
  function handleKeyPress(e, index) {
    if (e.key === "Enter" && !e.nativeEvent?.isComposing) {
      e.preventDefault();
      insertElementAbove(index + 1);
      setTimeout(() => {
        const inputs = document.querySelectorAll(".element-input");
        if (inputs[index + 1]) {
          inputs[index + 1].focus();
        }
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

    const newElements = [...elements];
    const draggedItem = newElements[draggedIndex];
    newElements.splice(draggedIndex, 1);
    newElements.splice(index, 0, draggedItem);

    setElements(newElements);
    setDraggedIndex(index);
  }

  function handleDragEnd() {
    setDraggedIndex(null);
  }

  if (isEditing) {
    return (
      <EditCard>
        <div className="space-y-3">
          {editableStatus && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">Status</span>
              <StatusPicker value={editStatus} onChange={setEditStatus} options={statusOptionsFor(statusOf(item))} />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Name
            </label>
            <div className="relative">
              <textarea
                ref={autoGrow}
                rows={2}
                value={name}
                onChange={(e) => {
                  handleItemNameChange(oneLine(e.target.value));
                  autoGrow(e.target);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent?.isComposing) e.preventDefault();
                }}
                className="block w-full px-3 py-2 border border-border rounded text-base resize-none overflow-hidden"
                autoFocus
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Description
            </label>
            <textarea
              ref={itemDescRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description for this item"
              className="w-full px-3 py-2 border border-border rounded text-base"
              rows="2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Tags
            </label>
            <TagPicker value={tags} onChange={setTags} pool={tagPool} />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isCaptureTarget}
              onChange={(e) => setIsCaptureTarget(e.target.checked)}
              className="rounded accent-primary"
            />
            <span className="text-sm">
              Use as capture target (available in quick capture)
            </span>
          </label>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Context
            </label>
            <select
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded text-base"
            >
              <option value="">No context</option>
              {contexts.filter((c) => !c.archived).map((ctx) => (
                <option key={ctx.id} value={ctx.id}>
                  {ctx.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Elements
            </label>
            <div className="space-y-2">
              {elements.map((element, index) => (
                <div key={index}>
                  <div
                    className={`space-y-2 p-3 border border-border rounded ${draggedIndex === index ? "opacity-50" : ""}`}
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
                        <textarea
                          ref={autoGrow}
                          rows={2}
                          value={element.name}
                          onChange={(e) => {
                            handleElementNameChange(index, e.target.value);
                            autoGrow(e.target);
                          }}
                          onKeyDown={(e) => handleKeyPress(e, index)}
                          placeholder="Element name"
                          className="element-input block w-full px-3 py-2 border border-border rounded resize-none overflow-hidden"
                        />
                      </div>
                      <button
                        onClick={() => copyElementToClipboard(element, allItems)}
                        className="text-muted-foreground hover:text-foreground flex-shrink-0"
                        title="Copy element"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
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
                      onChange={(e) =>
                        updateElement(index, "description", e.target.value)
                      }
                      placeholder="Description (optional)"
                      className="w-full px-3 py-2 border border-border rounded text-sm"
                      rows="2"
                    />

                    <div className="flex flex-wrap items-center gap-2">
                      <select
                      value={element.displayType || "step"}
                        onChange={(e) =>
                          updateElement(index, "displayType", e.target.value)
                        }
                        className="px-2 py-2 border border-border rounded text-sm"
                      >
                        <option value="header">Header</option>
                        <option value="bullet">Bullet</option>
                        <option value="step">Step</option>
                      </select>
                      <input
                        type="text"
                        value={element.quantity || ""}
                        onChange={(e) =>
                          updateElement(index, "quantity", e.target.value)
                        }
                        placeholder="Qty"
                        className="w-16 px-2 py-2 border border-border rounded text-sm"
                      />
                      {(element.displayType || "step") === "step" && (
                        <label
                          className="w-full text-sm text-muted-foreground"
                          title="Minutes to wait after the previous step is completed."
                        >
                          {/* Inline flow, deliberately NOT a nested flex row.

                              At 390px the flex version could not wrap: the sentence was
                              squeezed into a four-word column while the nowrap note and the
                              repeat link were pushed past the right edge, out of reach, and the
                              page scrolled sideways.

                              inline-block on the input keeps it ON the line with the words, so
                              "notify [5] min after the step above is checked" still reads as one
                              sentence — the 6b decision — while the text wraps around it at any
                              width. w-full gives the sentence its own line beneath the type and
                              quantity controls, which is where vertical space is cheap. */}
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
                          {/* Its own line: a note about the sentence, not part of it. */}
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
                      {(element.displayType || "step") === "step" && (
                        <button
                          type="button"
                          onClick={() => setRepeatFromIndex(index)}
                          className="px-2 py-2 min-h-[44px] text-sm text-primary underline whitespace-nowrap"
                          title="Repeat this step, and optionally the ones below it, several times."
                        >
                          repeat…
                        </button>
                      )}
                      {(element.displayType || "step") === "bullet" && (
                        <label
                          className="flex items-center gap-2 min-h-[44px] cursor-pointer"
                          title="This is something you can buy, so it can be added to a shopping collection."
                        >
                          <input
                            type="checkbox"
                            checked={element.collectable === true}
                            onChange={(e) =>
                              updateElement(
                                index,
                                "collectable",
                                e.target.checked ? true : undefined,
                              )
                            }
                            className="rounded accent-primary"
                          />
                          <span className="text-sm whitespace-nowrap">Can buy</span>
                        </label>
                      )}
                    </div>

                    {/* Item reference link */}
                    {(element.itemId || element.item_id) ? (
                      <div className="flex items-center gap-2 px-2 py-1 bg-warning-light border border-accent rounded text-sm">
                        <span className="text-primary min-w-0 break-words">
                          → {allItems.find((i) => i.id === (element.itemId || element.item_id))?.name || (element.itemId || element.item_id)}
                        </span>
                        <button
                          onClick={() => updateElement(index, "itemId", undefined)}
                          className="text-primary hover:text-primary ml-auto"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : linkingElementIndex === index ? (
                      <div className="space-y-1">
                        <ItemPicker
                          variant="inline"
                          items={allItems}
                          contexts={contexts}
                          exclude={(i) => i.id === item.id}
                          query={linkSearch}
                          onQueryChange={setLinkSearch}
                          onPick={(i) => {
                            updateElement(index, "itemId", i.id);
                            setLinkingElementIndex(null);
                            setLinkSearch("");
                          }}
                          placeholder="Search for an item to link..."
                          autoFocus
                        />
                        <button
                          onClick={() => { setLinkingElementIndex(null); setLinkSearch(""); }}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setLinkingElementIndex(index)}
                        className="text-xs text-primary hover:text-primary-hover"
                      >
                        Link to Item →
                      </button>
                    )}
                  </div>

                  {index < elements.length - 1 && (
                    <InsertRowButton
                      onClick={() => insertElementAbove(index + 1)}
                      title="Insert element below"
                    />
                  )}
                </div>
              ))}
              <button
                onClick={addElement}
                className="w-full px-4 py-2.5 border-2 border-dashed border-border rounded-lg text-muted-foreground hover:border-primary hover:text-primary transition-all duration-200"
              >
                + Add Element
              </button>

              {/* The picker writes ordinary elements straight into local state.
                  Nothing is persisted until the item is saved, so it goes
                  through the same dirty check and Save as hand typing. */}
              {repeatFromIndex !== null && (
                <RepeatBlockDialog
                  elements={elements}
                  startIndex={repeatFromIndex}
                  onDone={(next) => {
                    setElements(next);
                    setRepeatFromIndex(null);
                  }}
                  onCancel={() => setRepeatFromIndex(null)}
                />
              )}
            </div>
          </div>

          <PinnedFooter pinned={stickyFooter} unpinnedClassName="pt-2">
            <button
              onClick={handleSave}
              className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Save
            </button>
            <button
              onClick={handleCancel}
              className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Cancel
            </button>
            {/* Add mode has no record to archive. Without this guard the click
                reached onUpdate(null, …), which the add-form handlers treat as a
                save and which created a real archived item named "New Item".
                Same guard shape IntentionCard already uses for its Archive. */}
            {item.id && (
              <button
                onClick={() => {
                  onUpdate(item.id, { archived: true });
                  setIsEditing(false);
                }}
                className="px-4 py-2.5 min-h-[44px] bg-destructive hover:bg-destructive-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 ml-auto"
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
          onViewDetail(item.id);
        } else {
          setIsEditing(true);
        }
      }}
    >
      <p className="flex items-start gap-1.5 font-medium mb-2">
        <ObjectIcon type="item" className="w-4 h-4 text-primary" align="first-line" />
        <span className="min-w-0">{item.name}</span>
      </p>
      <div className="mb-2">
        <StatusPill row={item} />
      </div>
      {reminder && (
        <p
          className={`text-xs text-muted-foreground mb-2${reminder.muted ? " opacity-70" : ""}`}
          title={reminder.muted ? "Reminder sent (Pacific time)" : "Pending reminder (Pacific time)"}
        >
          🔔 {reminder.text}
        </p>
      )}
      {item.tags && item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {item.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="px-2 py-0.5 bg-warning-light text-accent-foreground text-xs rounded-full">
              {tag}
            </span>
          ))}
          {item.tags.length > 3 && (
            <span className="px-2 py-0.5 bg-secondary/50 text-muted-foreground text-xs rounded-full">
              +{item.tags.length - 3} more
            </span>
          )}
        </div>
      )}
      {item.description && (
        <p className="text-sm text-muted-foreground mt-1">
          {item.description.length > 80
            ? item.description.substring(0, 80) + "..."
            : item.description}
        </p>
      )}
      {((item.elements || item.components)?.length > 0 || item.updatedAt || item.lastCompletedAt) && (
          <span className="text-xs text-muted-foreground mt-1 block">
            {/* last_completed_at is set by trigger (Restructure P2); shown only once done. */}
            {[
              (item.elements || item.components)?.length > 0 && `${(item.elements || item.components).length} elements`,
              item.lastCompletedAt && `last done: ${shortDate(item.lastCompletedAt)}`,
              item.updatedAt && `last updated: ${shortDate(item.updatedAt)}`,
            ].filter(Boolean).join(' · ')}
          </span>
        )}
      {executions.length > 0 && onOpenExecution && (
        <div className="mt-2 space-y-1">
          {executions.map((exec) => (
            <ExecutionBadge
              key={exec.id}
              exec={exec}
              intents={intents}
              contexts={contexts}
              getIntentDisplay={getIntentDisplay}
              onOpen={onOpenExecution}
            >
              <CardExecutionNotes executionId={exec.id} />
            </ExecutionBadge>
          ))}
        </div>
      )}
    </div>
  );
}
