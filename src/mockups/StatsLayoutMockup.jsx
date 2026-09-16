import React from "react";
import {
  ALL_SONGS_TODAY_MINUTES as DAY_MIN,
  WHOLE_SONG,
  SNIPPETS,
  mins,
} from "./mockupData";
import {
  TransportRow,
  SettingsRow,
  SessionRow,
  SnippetPanelShell,
  ScorePlaceholder,
} from "./MockChrome";

// Three static layout options for the practice-statistics area, stacked so they
// can be compared at full width inside real SAM chrome. Hardcoded numbers,
// nothing clickable, no hooks and no Supabase. Throwaway: delete src/mockups
// and the guard in src/index.js once a layout is chosen.
//
// All three fix the same defect. Today the whole-song line reads
// "Today: 11 minutes", where Today is practice across ALL songs, sitting beside
// a "Total:" that means this song's lifetime — while snippet rows use those
// same two labels with both figures scoped to the snippet. Every option gives
// the all-songs figure its own line and its own wording, so it stops borrowing
// a label that means something else.

function DayBar() {
  return (
    <div className="flex items-center gap-3 mb-2 px-1 text-sm text-muted-foreground">
      <span>Practiced today</span>
      <strong className="text-dark">{mins(DAY_MIN)}</strong>
      <span>across all songs</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Option A - day bar on top, labels on every row                      */
/* ------------------------------------------------------------------ */

function LabelledFigures({ d }) {
  return (
    <span className="flex items-center gap-2 flex-wrap text-sm text-muted-foreground font-normal">
      <span>Passes</span>
      <span><strong className="text-dark">{d.passesToday}</strong> today</span>
      <span>·</span>
      <span><strong className="text-dark">{d.passesAllTime}</strong> all time</span>
      <span>·</span>
      <span>Time</span>
      <span><strong className="text-dark">{mins(d.timeTodayMin)}</strong> today</span>
      <span>·</span>
      <span><strong className="text-dark">{mins(d.timeAllTimeMin)}</strong> all time</span>
    </span>
  );
}

function OptionA() {
  return (
    <>
      <TransportRow />
      <SessionRow />
      <DayBar />

      <div className="flex items-center gap-3 flex-wrap mb-2 px-1 text-sm text-muted-foreground">
        <span className="font-medium text-dark">This song</span>
        <LabelledFigures d={WHOLE_SONG} />
      </div>

      <SnippetPanelShell
        snippets={SNIPPETS}
        renderRow={(s) => (
          <>
            <span className="font-medium">{s.title}</span>
            <LabelledFigures d={s} />
          </>
        )}
      />
      <ScorePlaceholder />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Option B - day total moves up to the session row                    */
/* ------------------------------------------------------------------ */

function TerseFigures({ d }) {
  return (
    <span className="flex items-center gap-3 flex-wrap text-sm text-muted-foreground font-normal">
      <span>
        Passes <strong className="text-dark">{d.passesToday}</strong>
        {" / "}
        <strong className="text-dark">{d.passesAllTime}</strong>
      </span>
      <span>
        Time <strong className="text-dark">{mins(d.timeTodayMin)}</strong>
        {" / "}
        <strong className="text-dark">{mins(d.timeAllTimeMin)}</strong>
      </span>
    </span>
  );
}

function Legend() {
  return (
    <div className="text-xs text-muted-foreground opacity-80 mb-2">
      today / all time
    </div>
  );
}

function OptionB() {
  return (
    <>
      <TransportRow />
      <SessionRow
        trailing={
          <span className="ml-auto">
            Practiced today <strong className="text-dark">{mins(DAY_MIN)}</strong>
          </span>
        }
      />

      <div className="mb-2 px-1">
        <Legend />
        <div className="flex items-center gap-3 flex-wrap text-sm text-muted-foreground">
          <span className="font-medium text-dark">This song</span>
          <TerseFigures d={WHOLE_SONG} />
        </div>
      </div>

      <SnippetPanelShell
        snippets={SNIPPETS}
        header={<Legend />}
        renderRow={(s) => (
          <>
            <span className="font-medium">{s.title}</span>
            <TerseFigures d={s} />
          </>
        )}
      />
      <ScorePlaceholder />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Option C - aligned columns                                          */
/* ------------------------------------------------------------------ */

function StatsTable() {
  const live = SNIPPETS.filter((s) => !s.archived);
  const archived = SNIPPETS.filter((s) => s.archived);

  const row = (label, d, opts = {}) => (
    <tr key={label} className={`border-t border-border ${opts.dim ? "opacity-60" : ""}`}>
      <td className="px-2 py-2 text-dark font-medium">{label}</td>
      <td className="px-2 py-2 text-right tabular-nums text-dark">{d.passesToday}</td>
      <td className="px-2 py-2 text-right tabular-nums text-dark">{d.passesAllTime}</td>
      <td className="px-2 py-2 text-right tabular-nums text-dark">{mins(d.timeTodayMin)}</td>
      <td className="px-2 py-2 text-right tabular-nums text-dark">{mins(d.timeAllTimeMin)}</td>
    </tr>
  );

  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="text-left font-medium px-2 py-1">Subject</th>
          <th className="text-right font-medium px-2 py-1">Passes today</th>
          <th className="text-right font-medium px-2 py-1">Passes all time</th>
          <th className="text-right font-medium px-2 py-1">Time today</th>
          <th className="text-right font-medium px-2 py-1">Time all time</th>
        </tr>
      </thead>
      <tbody>
        {row("This song", WHOLE_SONG)}
        {live.map((s) => row(s.title, s))}
        {archived.map((s) => row(`${s.title} (archived)`, s, { dim: true }))}
      </tbody>
    </table>
  );
}

function OptionC() {
  return (
    <>
      <TransportRow />
      <SessionRow />
      <DayBar />
      <SnippetPanelShell
        snippets={SNIPPETS}
        renderRow={() => null}
        listAsTable={<StatsTable />}
      />
      <ScorePlaceholder />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Option D - A, rearranged into three rows                            */
/* ------------------------------------------------------------------ */
//
// Same labelled figures as A. The difference is where the three pieces sit:
//
//   Row 1  back / Play / Full Song / title            ... Export ... Change Song
//   Row 2  BPM / Tuning / Repeat                      ... Practiced today 11 min
//   Row 3  Loop / Hits / Misses / accuracies + this song's passes and time
//
// "Practiced today" is pushed right with `ml-auto` so it lands under Change
// Song, which is what separates it visually from the song-scoped figures on the
// row below — the whole point being that it is a fact about the day, not about
// this song.

function OptionD() {
  return (
    <>
      <TransportRow compact />

      <SettingsRow
        trailing={
          <span className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            <span>Practiced today</span>
            <strong className="text-dark">{mins(DAY_MIN)}</strong>
          </span>
        }
      />

      <SessionRow
        trailing={
          <>
            <span className="font-medium text-dark">This song</span>
            <LabelledFigures d={WHOLE_SONG} />
          </>
        }
      />

      <SnippetPanelShell
        snippets={SNIPPETS}
        renderRow={(s) => (
          <>
            <span className="font-medium">{s.title}</span>
            <LabelledFigures d={s} />
          </>
        )}
      />
      <ScorePlaceholder />
    </>
  );
}

/* ------------------------------------------------------------------ */

function OptionFrame({ letter, title, note, children }) {
  return (
    <section className="mb-10">
      <div className="mb-3 pb-2 border-b-2 border-primary">
        <h2 className="text-lg font-bold text-dark">
          Option {letter} — {title}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">{note}</p>
      </div>
      {children}
    </section>
  );
}

export default function StatsLayoutMockup() {
  return (
    <div className="min-h-screen bg-primary-bg">
      <div className="mx-auto px-3 sm:px-4 py-6">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-dark">
            Practice statistics — layout options
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Static mockup. Hardcoded numbers, nothing clickable. Whole song 10 passes
            today / 21 all time, 4 min / 47 min. Practiced today 11 minutes across all
            songs. Six snippets: two with no practice at all, one archived, one over an
            hour of total practice.
          </p>
        </div>

        <OptionFrame
          letter="A"
          title="Day bar on top, labels on every row"
          note="Closest to what is built now. Every row spells out its own labels, repetition included."
        >
          <OptionA />
        </OptionFrame>

        <OptionFrame
          letter="B"
          title="Day total moves up to the session row"
          note="The all-songs figure sits with the other facts about this sitting. The block below is purely history, under a single legend."
        >
          <OptionB />
        </OptionFrame>

        <OptionFrame
          letter="C"
          title="Aligned columns"
          note="Headers written once. The only option where a column can be scanned down to compare snippets against each other."
        >
          <OptionC />
        </OptionFrame>

        <OptionFrame
          letter="D"
          title="A, rearranged into three rows"
          note="Same labelled figures as A. BPM, Tuning and Repeat get their own row under Play; Practiced today is pushed right to sit under Change Song; the session numbers and this song's figures share one row."
        >
          <OptionD />
        </OptionFrame>
      </div>
    </div>
  );
}
