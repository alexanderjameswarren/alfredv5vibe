import React, { useEffect, useState } from "react";
import { UI } from "./uiStyles";
import { loadSplitter } from "../lib/lyricsSplit";

// Paste lyrics for the open song. Save replaces every lyric row (placements
// too) and Auto-Matches the new syllables; Delete removes them. Both confirm
// first when there is something to lose. Nothing is written until a confirm.
export default function LyricsSheet({ songTitle, hasLyrics, onSave, onDelete, onClose }) {
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(null); // "save" | "delete" | null
  const [busy, setBusy] = useState(false);

  // Start fetching the syllable list while the text is being pasted; Save
  // awaits the same promise, and reports a failure then.
  useEffect(() => { loadSplitter().catch(() => {}); }, []);

  async function run(action) {
    setConfirming(null);
    setBusy(true);
    try {
      await action();
      onClose();
    } catch (err) {
      alert(err.message);
      setBusy(false);
    }
  }

  function handleSave() {
    if (hasLyrics) setConfirming("save");
    else run(() => onSave(text));
  }

  const button = `px-4 py-2 text-sm min-h-[44px] disabled:opacity-50 ${UI.radius} ${UI.press}`;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div role="dialog" aria-label="Lyrics" className="bg-card border border-border rounded-lg p-6 max-w-2xl w-full mx-4">
        <h3 className="text-lg font-medium text-dark mb-1">Lyrics</h3>
        <p className="text-sm text-muted-foreground mb-3">{songTitle}</p>

        {confirming ? (
          <>
            <p className="text-base text-foreground mb-6">
              {confirming === "save"
                ? "This will replace the existing lyrics."
                : "This will delete all lyrics for this song."}
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirming(null)} className={`flex-1 ${button} ${UI.outline}`}>
                Cancel
              </button>
              <button
                onClick={() => run(confirming === "save" ? () => onSave(text) : onDelete)}
                className={`flex-1 ${button} bg-primary text-white`}
              >
                {confirming === "save" ? "Replace" : "Delete"}
              </button>
            </div>
          </>
        ) : (
          <>
            <textarea
              aria-label="Lyrics text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste the lyrics here"
              rows={16}
              className={`w-full p-3 text-base border border-border bg-card text-foreground ${UI.radius}`}
            />
            <div className="flex gap-3 mt-4 flex-wrap">
              {hasLyrics && (
                <button onClick={() => setConfirming("delete")} disabled={busy} className={`${button} ${UI.outline}`}>
                  Delete lyrics
                </button>
              )}
              <div className="flex-1" />
              <button onClick={onClose} disabled={busy} className={`${button} ${UI.outline}`}>
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={busy || !text.trim()}
                className={`${button} bg-primary text-white`}
              >
                {busy ? "Saving..." : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
