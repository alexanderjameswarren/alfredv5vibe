import React from "react";
import { ArrowLeft } from "lucide-react";

// The "up one level" control, at the far left of whichever control row is on
// screen. It used to live in a page header that has since been removed (M4
// part 1) for the ~68px it cost.
//
// Where it goes depends on where you are, and the caller decides:
//
//   a song is open  -> SAM's own home, the song library. Leaving a piece is
//                      almost always about picking a different one, not about
//                      leaving SAM, so Back walks up one level rather than all
//                      the way out.
//   song library    -> Alfred. There is no level above it inside SAM, and this
//                      is the only route out, so it must not be taken away.
//
// It is rendered in every state that has a control row — stopped, paused,
// playing, and the library — because the header it replaced rendered in all of
// them, and the transport row alone covers neither playback nor the library.
export default function BackButton({ onBack, title = "Back" }) {
  return (
    <button
      onClick={onBack}
      className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground rounded shrink-0"
      title={title}
      aria-label={title}
    >
      <ArrowLeft className="w-5 h-5" />
    </button>
  );
}
