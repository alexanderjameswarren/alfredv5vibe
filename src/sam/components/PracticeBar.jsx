import React from "react";
import { Pause, GraduationCap } from "lucide-react";

// Collapsed top chrome while a PRACTICE run is playing — the counterpart to
// FocusedPlaybackBar, which is what Play shows.
//
// It is a separate component rather than a mode of that one because almost
// every number on that bar would be a lie here. Practice writes no session, no
// events and no pass, so Session time, Completed Passes, Playthrough accuracy
// and Session accuracy have nothing behind them; showing a frozen 0 or a stale
// value would be worse than showing nothing. What is left is the one fact worth
// having on screen at the piano: this is Practice, and it is not being counted.
//
// The badge is oversized for the same reason the Practice button is: Alex plays
// without glasses, and mistaking a practice run for a real one costs a sitting.
export default function PracticeBar({ onPause }) {
  return (
    <div className="flex items-center gap-4 mb-2 px-1 flex-wrap">
      <button
        onClick={onPause}
        className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors bg-amber-500 hover:bg-amber-600 text-white"
      >
        <Pause className="w-4 h-4" /> Pause
      </button>

      <div className="flex items-center gap-2 px-3 py-1 rounded-md bg-violet-50 border border-violet-300">
        <GraduationCap className="w-6 h-6 text-violet-700" aria-hidden="true" />
        <span className="text-2xl font-bold tracking-wide leading-none text-violet-700">
          PRACTICE
        </span>
      </div>

      <span className="text-sm text-muted-foreground">Nothing is recorded.</span>
    </div>
  );
}
