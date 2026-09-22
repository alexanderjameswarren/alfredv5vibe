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
// STYLE: the neutral outline the rest of the app uses for secondary chrome —
// the same border and muted ground as the Playthrough badge on the Play bar.
// The TEXT stays oversized and near-black, because legibility without glasses
// is a requirement and colour was never what carried it.
//
// `stuck` is the beat the run has stopped on ({ meas, beat }), or null while it
// is scrolling.
export default function PracticeBar({ onPause, stuck = null }) {
  return (
    <div className="flex items-center gap-4 mb-2 px-1 flex-wrap">
      <button
        onClick={onPause}
        className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors bg-amber-500 hover:bg-amber-600 text-white"
      >
        <Pause className="w-4 h-4" /> Pause
      </button>

      <div className="flex items-center gap-2 px-3 py-1 rounded-md bg-secondary/40 border border-border">
        <GraduationCap className="w-6 h-6 text-muted-foreground" aria-hidden="true" />
        <span className="text-2xl font-bold tracking-wide leading-none text-dark">
          PRACTICE
        </span>
      </div>

      {stuck ? (
        // Named rather than merely implied: at the piano the score has just
        // jumped backwards to put the stuck beat on the play line, and the bar
        // is what confirms that was deliberate. The notes themselves are
        // already marked, in the grader's own colours.
        <div className="flex items-center gap-2 px-3 py-1 rounded-md bg-secondary/40 border border-border">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Stopped at
          </span>
          <span className="text-2xl font-mono font-bold tabular-nums leading-none text-dark">
            m.{stuck.meas}
          </span>
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">Nothing is recorded.</span>
      )}
    </div>
  );
}
