import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

// Modal sheet housing the file-drop zone + JSON/MusicXML paste box.
// Behaviourally identical to the pre-Milestone-5 top-of-page import area
// (spec §"+ Add sheet": "unchanged in behaviour, behind a button"). All
// file/paste plumbing stays in SongLoader (handleFile, handlePastedText,
// dragging state, fileInputRef); this component owns only the presentation
// and the pastedText local state.
//
// SongLoader passes down `onDropFile` (called from onDrop / file input),
// `onPaste(text)` (called from the Load-from-Paste button), and the sheet
// closes itself after a successful pass-through.

export default function AddImportSheet({ open, onClose, onDropFile, onPaste }) {
  const [pastedText, setPastedText] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setPastedText("");
      setDragging(false);
    }
  }, [open]);

  if (!open) return null;

  function submitPaste() {
    if (!pastedText.trim()) return;
    onPaste(pastedText);
    // Don't close automatically — SongLoader's onSongLoaded will unmount
    // the whole tree on success. On validation failure the sheet stays
    // open so the user can fix the paste.
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) onDropFile(file);
  }

  function handleFileInput(e) {
    const file = e.target.files?.[0];
    if (file) onDropFile(file);
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-card border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Add song"
      >
        <div className="flex items-start justify-between gap-3 p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-dark">Add a song</h2>
          <button
            onClick={onClose}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground rounded"
            title="Close"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragging(false);
            }}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              dragging
                ? "border-primary bg-primary-light"
                : "border-border hover:border-primary-light bg-background"
            }`}
          >
            <div className="text-3xl mb-2">🎵</div>
            <p className="text-dark font-medium mb-1">Drop a song file here</p>
            <p className="text-sm text-muted-foreground">
              .json, .musicxml, or .mxl — or click to browse
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.musicxml,.xml,.mxl"
              onChange={handleFileInput}
              className="hidden"
            />
          </div>

          <div className="mt-4">
            <label className="block text-sm font-medium text-foreground mb-2">
              Or paste JSON / MusicXML directly
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              To author a drill, include{" "}
              <code className="font-mono">"songType": "drill"</code> in the JSON.
              Optional <code className="font-mono">"parentSongId"</code> nests it
              under an existing song; omit to file it under the standalone Drills
              tab.
            </p>
            <textarea
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              placeholder="Paste your JSON or MusicXML content here..."
              className="w-full p-3 border border-border rounded-lg text-sm font-mono resize-y min-h-[120px] focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            />
            <button
              onClick={submitPaste}
              disabled={!pastedText.trim()}
              className="mt-2 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Load from Paste
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
