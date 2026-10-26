import React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Newspaper } from "lucide-react";
import { OVERWATCH_PATH, overwatchBriefingPath } from "../viewPaths";
import { RECORD_LINK_BASE } from "../shared/copyRecord";
import NoteMarkdown from "./NoteMarkdown";
import OverwatchCopyButton from "./OverwatchCopyButton";

/** A Pacific YYYY-MM-DD as "Mon, Oct 26". */
export function noteDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  if (!m) return day || "";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Older notes began with a title line ("**Overwatch nightly, 2026-10-26**"); drop it so every briefing matches. */
export function stripTitle(body) {
  const lines = (body || "").split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^#{0,3}\s*\**\s*Overwatch\s+(nightly|weekly)\b/i.test(lines[first].trim())) {
    lines.splice(first, 1);
  }
  return lines.join("\n").trim();
}

export function briefingTitle(note) {
  return `${note.period === "weekly" ? "Weekly" : "Nightly"} briefing · ${noteDate(note.for_date)}`;
}

/** The copy for a whole briefing: paste-ready for a claude.ai thread. */
export function briefingCopy(note, run) {
  return {
    what: `${note.period} briefing ${note.for_date}`,
    facts: [stripTitle(note.body)],
    ids: { note_id: note.id, run_id: run?.id },
    link: `${RECORD_LINK_BASE}${overwatchBriefingPath(note.id).slice(1)}`,
    question: "Let's go through this briefing.",
  };
}

function BriefingCard({ note, run }) {
  return (
    <article className="px-4 py-3.5 bg-card border border-border rounded-lg">
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="m-0 text-base font-medium leading-snug">
          <Link to={overwatchBriefingPath(note.id)} className="inline-flex items-center min-h-[40px] text-foreground hover:text-primary">
            {briefingTitle(note)}
          </Link>
        </h3>
        <OverwatchCopyButton copy={briefingCopy(note, run)} />
      </div>
      <NoteMarkdown text={stripTitle(note.body)} />
    </article>
  );
}

/** /overwatch/briefing (the latest nightly, and the week's weekly) and /overwatch/briefing/<note_id>. */
export default function BriefingSection({ briefings, loading, missing }) {
  return (
    <div>
      <Link to={OVERWATCH_PATH} className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover">
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        Back
      </Link>
      <h2 className="flex items-start gap-2 mb-4 text-xl sm:text-2xl font-bold">
        <Newspaper className="w-6 h-6 text-primary shrink-0 mt-[0.2em]" aria-hidden="true" />
        <span className="min-w-0">Briefing</span>
      </h2>
      {loading && <p className="m-0 text-sm text-muted-foreground">Loading…</p>}
      {!loading && !briefings.length && (
        <p className="m-0 text-sm text-muted-foreground">
          {missing ? "That briefing was not found." : "No briefing yet. The nightly run writes one at 4:20 am."}
        </p>
      )}
      <div className="space-y-3">
        {briefings.map(({ note, run }) => <BriefingCard key={note.id} note={note} run={run} />)}
      </div>
    </div>
  );
}
