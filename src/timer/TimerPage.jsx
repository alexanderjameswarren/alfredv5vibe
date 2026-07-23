import React, { useState } from "react";
import { ArrowLeft, Timer as TimerIcon } from "lucide-react";
import useNumericInput from "../sam/lib/useNumericInput";
import TimerBuilder from "./components/TimerBuilder";
import TimerRun from "./components/TimerRun";

// Top-level Timer page. Owns the Builder ↔ Run mode switch AND the config
// state (total duration inputs + phase list + loop flag) so a Stop from Run
// mode returns to Builder with everything intact. Engine and Run UI arrive
// in later steps; Step 2 delivers Builder + a Run placeholder that closes
// the mode-transition loop.
export default function TimerPage({ onBack }) {
  const [mode, setMode] = useState("builder");
  const totalMinutes = useNumericInput(5);
  const totalSecondsIn = useNumericInput(0);
  const [phases, setPhases] = useState([]);
  const [loop, setLoop] = useState(true);
  const [muted, setMuted] = useState(false);

  const totalSeconds = totalMinutes.value * 60 + totalSecondsIn.value;

  return (
    <div className="min-h-screen bg-primary-bg">
      <header className="sticky top-0 z-10 bg-card border-b border-border shadow-sm">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-3 flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground rounded"
            title="Back to Alfred"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg sm:text-2xl font-bold text-dark flex items-center gap-2">
            <TimerIcon className="w-5 h-5 sm:w-6 sm:h-6" />
            Timer
          </h1>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-6">
        {mode === "builder" ? (
          <TimerBuilder
            totalMinutes={totalMinutes}
            totalSecondsIn={totalSecondsIn}
            phases={phases}
            onPhasesChange={setPhases}
            loop={loop}
            onLoopChange={setLoop}
            muted={muted}
            onMuteChange={setMuted}
            onStart={() => setMode("run")}
          />
        ) : (
          <TimerRun
            totalSeconds={totalSeconds}
            phases={phases}
            loop={loop}
            muted={muted}
            onStop={() => setMode("builder")}
          />
        )}
      </div>
    </div>
  );
}
