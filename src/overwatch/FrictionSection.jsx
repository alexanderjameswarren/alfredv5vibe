import React from "react";
import { firstLine } from "./overwatchApi";
import OverwatchCopyButton from "./OverwatchCopyButton";
import MoreLess, { useClamp } from "./MoreLess";

const PROCESS_NAMES = {
  cli_testing_steps: "CLI testing steps",
  cli_prompt: "CLI prompt",
  todos: "To-dos",
  closeout: "Closeout",
  inbox: "Inbox",
  other: "Other",
};

/** "CLI testing steps", "Skill: cli-workflow". */
export function processName(process) {
  if (process?.startsWith("skill:")) return `Skill: ${process.slice(6)}`;
  return PROCESS_NAMES[process] || process;
}

/** "Oct 24", Pacific. */
export function frictionDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

/**
 * Open entries grouped by process, biggest group first. A group is a pattern when its entries
 * inside friction_window_days reach friction_trigger_count; with either setting missing, none is.
 * "Other" is never grouped and never a pattern: those entries stand alone (see otherEntries).
 */
export function frictionGroups(entries, settings = {}, now = new Date()) {
  const { friction_window_days: windowDays, friction_trigger_count: trigger } = settings;
  const byProcess = new Map();
  for (const e of entries) {
    if (e.process !== "other") byProcess.set(e.process, [...(byProcess.get(e.process) || []), e]);
  }
  return [...byProcess].map(([process, rows]) => {
    const recent = windowDays == null ? 0 : rows.filter((e) => now - new Date(e.occurred_at) <= windowDays * 864e5).length;
    return { process, rows, pattern: windowDays != null && trigger != null && recent >= trigger };
  }).sort((a, b) => b.rows.length - a.rows.length || processName(a.process).localeCompare(processName(b.process)));
}

export function entryCopy(e) {
  return {
    what: "friction",
    name: processName(e.process),
    facts: [`Date: ${frictionDate(e.occurred_at)}`, e.what_happened],
    ids: { friction_id: e.id },
    question: "What change would stop this from happening again?",
  };
}

export function groupCopy(g) {
  return {
    what: "friction",
    name: `${processName(g.process)} (${g.rows.length} open)`,
    facts: g.rows.map((e) => `- ${frictionDate(e.occurred_at)}: ${e.what_happened} (friction_id: ${e.id})`),
    question: "These keep happening. What's the shared cause and the one fix?",
  };
}

/** The entries that stand alone: every "Other" entry, newest first. */
export function otherEntries(entries) {
  return entries.filter((e) => e.process === "other");
}

function EntryLine({ e, copyable }) {
  const full = (e.what_happened || "").trim();
  const first = firstLine(full);
  const clamp = useClamp(full, first !== full);
  return (
    <li className="flex items-start gap-2 py-2">
      <div className="min-w-0 flex-1 flex flex-col">
        <p ref={clamp.ref} className={`m-0 text-sm text-foreground ${clamp.expanded ? "whitespace-pre-line" : "line-clamp-2"}`}>
          {clamp.expanded ? full : first}
        </p>
        {clamp.show && <MoreLess expanded={clamp.expanded} onToggle={clamp.toggle} />}
        <p className="m-0 text-xs text-muted-foreground">{frictionDate(e.occurred_at)}</p>
      </div>
      {copyable && <OverwatchCopyButton copy={entryCopy(e)} />}
    </li>
  );
}

/** The copy rule: a group of 2 or more copies once, on its header; a group of 1 copies on its entry. */
function Group({ g }) {
  const many = g.rows.length >= 2;
  return (
    <section aria-label={processName(g.process)}
      className={`px-4 py-3.5 bg-card border rounded-lg ${g.pattern ? "border-destructive" : "border-border"}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={`m-0 flex items-center gap-2 flex-wrap text-base font-medium leading-snug ${g.pattern ? "text-destructive" : "text-foreground"}`}>
          <span>{processName(g.process)} ({g.rows.length})</span>
          {g.pattern && (
            <span className="px-2 py-0.5 rounded-full border border-destructive text-xs font-normal">Pattern</span>
          )}
        </h3>
        {many && <OverwatchCopyButton copy={groupCopy(g)} />}
      </div>
      <ul className="m-0 mt-2 p-0 list-none divide-y divide-border">
        {g.rows.map((e) => <EntryLine key={e.id} e={e} copyable={!many} />)}
      </ul>
    </section>
  );
}

/** An "Other" entry: its own card, never a group, never red. */
function Alone({ e }) {
  return (
    <section aria-label={`Other: ${firstLine(e.what_happened)}`} className="px-4 py-1.5 bg-card border border-border rounded-lg">
      <p className="m-0 mt-1.5 text-xs text-muted-foreground">Other</p>
      <ul className="m-0 p-0 list-none"><EntryLine e={e} copyable /></ul>
    </section>
  );
}

export default function FrictionSection({ entries, settings }) {
  if (!entries.length) return <p className="m-0 text-sm text-muted-foreground">No open friction.</p>;
  return (
    <div className="space-y-2">
      {frictionGroups(entries, settings).map((g) => <Group key={g.process} g={g} />)}
      {otherEntries(entries).map((e) => <Alone key={e.id} e={e} />)}
    </div>
  );
}
