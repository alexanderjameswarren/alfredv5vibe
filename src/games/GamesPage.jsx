import React from "react";
import {
  NotesBoard,
  LOW_BOARD,
  HIGH_BOARD,
  TILE_SIZES,
} from "./NotesBoard";

// The Games view.
//
// A game selection screen goes here later. For now Games renders the Notes
// board directly — six read-only grids at three tile sizes, so a phone-sized
// screen can be judged for legibility before any game logic exists.
export default function GamesPage() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground mb-1">Notes</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Six grids, three tile sizes. Which can you read at a glance?
      </p>

      {TILE_SIZES.map((size) => (
        <NotesBoard
          key={`low-${size}`}
          rows={LOW_BOARD}
          size={size}
          label="Low board"
        />
      ))}

      {TILE_SIZES.map((size) => (
        <NotesBoard
          key={`high-${size}`}
          rows={HIGH_BOARD}
          size={size}
          label="High board"
        />
      ))}
    </div>
  );
}
