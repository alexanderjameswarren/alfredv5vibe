import React from "react";
import { getPlanOverview } from "./moneyApi";
import { useLoad } from "./useMoneyData";
import HelpButton, { HelpTitle } from "./HelpButton";
import { STAGE_LABELS, annotatePlannedItem, formatDay, formatMoney, intervalLabel, pacificToday, toNumber } from "./moneyFormat";

const BADGE = "inline-block px-2 py-0.5 rounded-full text-xs";
const LIST = "divide-y divide-border bg-card border border-border rounded-lg px-4";
const ROW = "w-full text-left flex items-start justify-between gap-3 min-h-[44px] py-3";
const STATUS_LABELS = { on_hold: "On hold", done: "Done", cancelled: "Cancelled" };
const STATUS_ORDER = { active: 0, on_hold: 1, done: 2, cancelled: 3 };

function WhatIf() {
  return <span className={`${BADGE} border border-dashed border-primary text-primary-dark`}>What if</span>;
}

function Section({ title, helpKey, count, children, empty }) {
  return (
    <section>
      <h3 className="font-medium mb-2">
        <HelpTitle text={title} helpKey={helpKey} />{" "}
        {count !== undefined && <span className="text-muted-foreground font-normal">({count})</span>}
      </h3>
      {count === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : children}
    </section>
  );
}

/**
 * The Plan tab overview (spec A44, A47): projects with their totals, upcoming one-offs,
 * repeating items and missed dates. Read-only: entry is done with Claude, and each row
 * opens its project or item.
 */
export default function PlanScreen({ onOpenProject, onOpenItem }) {
  const { data, error, loading } = useLoad(() => getPlanOverview(), []);
  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const today = pacificToday();
  const projectName = new Map(data.projects.map((p) => [p.project_id, p.name]));
  const items = data.items.map((it) => annotatePlannedItem(it, data.confirmed));
  const upcoming = items.filter((it) => !it.repeating && !["paid", "cancelled"].includes(it.stage) && it.due_on >= today);
  const repeating = items.filter((it) => it.repeating && (!it.ends_on || it.ends_on >= today));
  const projects = [...data.projects].sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));
  const drafts = items.filter((it) => it.draft && !["paid", "cancelled"].includes(it.stage)).length;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Add or change plans by asking Claude. Items marked <WhatIf /> are ideas, left out of free cash
        <HelpButton helpKey="plan.drafts" />
        {drafts > 0 && <> ({drafts} now)</>}.
      </p>

      <Section title="Projects" helpKey="plan.projects" count={projects.length} empty="No projects yet.">
        {projects.some((p) => p.planning) && (
          <p className="text-xs text-muted-foreground mb-2">
            <span className={`${BADGE} bg-primary-light text-primary-dark`}>Planning</span> means only what-ifs so far
            <HelpButton helpKey="plan.planning" />
          </p>
        )}
        <ul className={LIST}>
          {projects.map((p) => (
            <li key={p.project_id}>
              <button type="button" className={ROW} onClick={() => onOpenProject(p.project_id)}>
                <span className="min-w-0">
                  <span className="block break-words">{p.name}</span>
                  <span className="flex flex-wrap gap-1 mt-1">
                    {p.planning && <span className={`${BADGE} bg-primary-light text-primary-dark`}>Planning</span>}
                    {STATUS_LABELS[p.status] && <span className={`${BADGE} border border-border text-muted-foreground`}>{STATUS_LABELS[p.status]}</span>}
                  </span>
                </span>
                <span className="shrink-0 text-right text-sm tabular-nums">
                  <span className="block">Spent {formatMoney(Math.abs(toNumber(p.spent) ?? 0))}</span>
                  {p.budget !== null && p.budget !== undefined && (
                    <span className={`block text-xs ${toNumber(p.budget_left) < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                      {toNumber(p.budget_left) < 0 ? `Over budget by ${formatMoney(-toNumber(p.budget_left))}` : `${formatMoney(p.budget_left)} left`}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Upcoming" helpKey="plan.upcoming" count={upcoming.length} empty="Nothing one-off is coming up.">
        <ul className={LIST}>
          {upcoming.map((it) => (
            <li key={it.id}>
              <button type="button" className={ROW} onClick={() => onOpenItem(it.id)}>
                <span className="min-w-0">
                  <span className="block break-words">{it.name}</span>
                  <span className="block text-xs text-muted-foreground break-words">
                    {formatDay(it.due_on)}{it.project_id && projectName.get(it.project_id) ? ` · ${projectName.get(it.project_id)}` : ""}
                  </span>
                  <span className="flex flex-wrap gap-1 mt-1">
                    {it.draft ? <WhatIf /> : <span className={`${BADGE} border border-border text-muted-foreground`}>{STAGE_LABELS[it.stage]}</span>}
                  </span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  {formatMoney(it.remaining)}
                  {toNumber(it.confirmed_total) !== 0 && (
                    <span className="block text-xs text-muted-foreground">of {formatMoney(it.amount)}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Repeating" helpKey="plan.repeating" count={repeating.length} empty="No repeating bills or income yet.">
        <ul className={LIST}>
          {repeating.map((it) => (
            <li key={it.id}>
              <button type="button" className={ROW} onClick={() => onOpenItem(it.id)}>
                <span className="min-w-0">
                  <span className="block break-words">{it.name}</span>
                  <span className="block text-xs text-muted-foreground break-words">
                    {intervalLabel(it)} from {formatDay(it.due_on)}{it.ends_on ? ` to ${formatDay(it.ends_on)}` : ""}
                    {it.project_id && projectName.get(it.project_id) ? ` · ${projectName.get(it.project_id)}` : ""}
                  </span>
                  {it.draft && <span className="flex flex-wrap gap-1 mt-1"><WhatIf /></span>}
                </span>
                <span className="shrink-0 tabular-nums">{formatMoney(it.amount)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Missed dates" helpKey="plan.missed_dates" count={data.missed.length} empty="No missed dates.">
        <ul className={LIST}>
          {data.missed.map((m) => (
            <li key={`${m.planned_item_id}-${m.occurrence_on || ""}`}>
              <button type="button" className={ROW} onClick={() => onOpenItem(m.planned_item_id)}>
                <span className="min-w-0">
                  <span className="block break-words">{m.name}</span>
                  <span className="block text-xs text-muted-foreground break-words">
                    Due {formatDay(m.due_on)}{m.project_name ? ` · ${m.project_name}` : ""}
                  </span>
                  <span className="flex flex-wrap gap-1 mt-1">
                    {m.within_window && <span className={`${BADGE} border border-border text-muted-foreground`}>May still post</span>}
                    {m.has_suggestion && <span className={`${BADGE} bg-primary-light text-primary-dark`}>Suggestion in Review</span>}
                  </span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  {formatMoney(m.remaining)}
                  {toNumber(m.confirmed_total) !== 0 && <span className="block text-xs text-muted-foreground">of {formatMoney(m.amount)}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
