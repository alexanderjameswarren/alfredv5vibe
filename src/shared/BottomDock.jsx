import React from "react";
import { Send } from "lucide-react";
import UndoMessage from "./UndoMessage";

// The bottom dock — the Undo message on top of the Capture bar — moved out of
// Alfred.jsx unchanged. Its state stays in Alfred and comes in as props.
export default function BottomDock({
  pendingUndo,
  runUndo,
  dismissUndo,
  captureRef,
  captureText,
  setCaptureText,
  handleCapture,
}) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-20">
      <UndoMessage
        pendingUndo={pendingUndo}
        onUndo={runUndo}
        onDismiss={dismissUndo}
      />

      {/* Capture bar */}
      <div className="bg-white border-t border-border shadow-lg">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2 sm:py-4">
          <div className="flex gap-2 items-end">
            <textarea
              ref={captureRef}
              value={captureText}
              onChange={(e) => {
                setCaptureText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight * 0.5) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleCapture();
                }
              }}
              placeholder="Capture anything..."
              rows={1}
              className="flex-1 px-3 sm:px-4 py-2.5 sm:py-3 border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary resize-none overflow-hidden min-h-[44px] max-h-[50vh] text-base"
            />
            {/* The icon matches the Capture SOURCE tab in the inbox — Step 21b, and
                the glyph changed in 21c. This button is what creates a 'manual'
                capture, so the two must stay recognisably the same thing; if one moves,
                both move. See SOURCE_GLYPHS for why it is a paper aeroplane. */}
            <button
              onClick={handleCapture}
              className="inline-flex items-center gap-2 px-3 sm:px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Send className="w-4 h-4 shrink-0" aria-hidden="true" />
              Capture
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
