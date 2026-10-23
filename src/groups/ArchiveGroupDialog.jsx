import React from "react";
import { createPortal } from "react-dom";
import { Archive } from "lucide-react";
import CancelButton from "../shared/CancelButton";

/** The group archive confirm, in the Close pop-up's shape: portal, main button, shared Cancel. */
export default function ArchiveGroupDialog({ label, onConfirm, onCancel }) {
  const word = (label || "group").toLowerCase();
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        role="dialog"
        aria-label={`Archive ${word}`}
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-3">Archive this {word}?</h3>
        <p className="text-sm">Its members are not touched.</p>
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] border-2 border-destructive text-destructive hover:bg-destructive/10 rounded-lg text-sm"
          >
            <Archive className="w-4 h-4" aria-hidden="true" />
            Archive
          </button>
          <CancelButton onClick={onCancel} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
