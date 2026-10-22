import { useState } from "react";

/** The list with the row at `from` moved to `to`. */
export function moveItem(list, from, to) {
  const next = [...list];
  const [dragged] = next.splice(from, 1);
  next.splice(to, 0, dragged);
  return next;
}

/**
 * The collection page's drag reorder (native HTML5 drag, long press on a phone),
 * as a hook: the list follows the finger on drag-over and `onCommit` runs on
 * drop. Spread `rowProps(index)` on each row.
 */
export function useDragReorder(setList, onCommit) {
  const [dragIdx, setDragIdx] = useState(null);
  function rowProps(index, { enabled = true } = {}) {
    return {
      draggable: enabled,
      onDragStart: (e) => {
        setDragIdx(index);
        e.dataTransfer.effectAllowed = "move";
      },
      onDragOver: (e) => {
        e.preventDefault();
        if (dragIdx === null || dragIdx === index) return;
        setList((prev) => moveItem(prev, dragIdx, index));
        setDragIdx(index);
      },
      onDragEnd: () => {
        setDragIdx(null);
        if (onCommit) onCommit();
      },
    };
  }
  return { dragIdx, rowProps };
}
