import React from "react";
import { formatMinutesUnits } from "../lib/practiceTimeFormat";

// The practice figures for one subject — the whole song, or one snippet — in
// the one wording used everywhere they appear:
//
//   Passes 10 today · 21 all time · Time 4 min today · 47 min all time
//
// Shared by the stats row's "This song" entry and by every snippet row, so the
// labels, their order and the spacing between them are written once rather than
// transcribed in two places that would drift the first time either changed.
//
// Every figure says its own scope. That is the whole point of this wording: the
// display it replaces read "Today: 11 minutes" beside "Total:", where Today was
// practice across ALL songs and Total was this song's lifetime — two different
// scopes, same two labels, one line apart. The all-songs figure now lives on
// the settings row as "Practiced today" and no longer borrows a label that
// means something else.
//
// Returns a fragment; the caller supplies the flex row it sits in, which is
// what lets a snippet row put its title first and flow these out beside it.
export default function PracticeFigures({
  passesToday,
  passesAllTime,
  timeTodayMinutes,
  timeAllTimeMinutes,
}) {
  return (
    <>
      <span>Passes</span>
      {/* Zero is a correct, meaningful reading — a subject not practised today,
          or never played at all — so every figure renders a digit rather than
          being hidden, blanked or dashed out. */}
      <span>
        <strong className="text-dark">{passesToday}</strong> today
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <strong className="text-dark">{passesAllTime}</strong> all time
      </span>
      <span aria-hidden="true">·</span>
      <span>Time</span>
      <span>
        <strong className="text-dark">{formatMinutesUnits(timeTodayMinutes)}</strong> today
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <strong className="text-dark">{formatMinutesUnits(timeAllTimeMinutes)}</strong> all time
      </span>
    </>
  );
}
