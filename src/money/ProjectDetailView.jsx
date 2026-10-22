import React from "react";
import { ChevronLeft } from "lucide-react";
import { getProjectDetail } from "./moneyApi";
import { useLoad } from "./useMoneyData";
import HelpButton, { HelpTitle } from "./HelpButton";
import { STAGE_LABELS, annotatePlannedItem, formatDay, formatMoney, intervalLabel, toNumber } from "./moneyFormat";

const BADGE = "inline-block px-2 py-0.5 rounded-full text-xs";
const LIST = "divide-y divide-border bg-card border border-border rounded-lg px-4";
const ROW = "w-full text-left flex items-start justify-between gap-3 min-h-[44px] py-3";
const STATUS_LABELS = { active: "Active", on_hold: "On hold", done: "Done", cancelled: "Cancelled" };

function Line({ label, value, strong, tone }) {
  return (
    <div className="flex items-center justify-between py-2">
      <dt className={strong ? "font-medium" : ""}>{label}</dt>
      <dd className={`tabular-nums ${strong ? "font-medium" : ""} ${tone || ""}`}>{value}</dd>
    </div>
  );
}

function Back({ onBack }) {
  return (
    <button type="button" onClick={onBack} className="min-h-[44px] inline-flex items-center gap-1 text-sm text-primary">
      <ChevronLeft className="w-4 h-4" /> Plan
    </button>
  );
}

/**
 * One project (spec A36, A44, A47): its totals from wb_project_summary, its planned
 * items (each opening item detail) and the payments on it (each opening the payment).
 * Read-only; changes are made with Claude.
 */
export default function ProjectDetailView({ projectId, onBack, onOpenItem, onOpenTransaction }) {
  const { data, error, loading } = useLoad(() => getProjectDetail(projectId), [projectId]);
  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <div className="space-y-3"><Back onBack={onBack} /><p className="text-sm text-destructive">{error.message}</p></div>;
  if (!data) {
    return (
      <div className="space-y-3">
        <Back onBack={onBack} />
        <p className="text-sm text-muted-foreground">This project no longer exists, or you can't see it.</p>
      </div>
    );
  }

  const { summary: s, project, payments } = data;
  const items = data.items.map((it) => annotatePlannedItem(it, data.confirmed));
  const hasBudget = s.budget !== null && s.budget !== undefined;
  const over = hasBudget && toNumber(s.budget_left) < 0;
  const draftsDue = toNumber(s.draft_out_due) !== 0 || toNumber(s.draft_in_due) !== 0;

  return (
    <div className="space-y-6">
      <div>
        <Back onBack={onBack} />
        <h3 className="text-lg font-medium break-words">{s.name}</h3>
        <p className="flex flex-wrap items-center gap-1 mt-1 text-sm text-muted-foreground">
          <span className={`${BADGE} border border-border`}>{STATUS_LABELS[s.status] || s.status}</span>
          {s.planning && <span className={`${BADGE} bg-primary-light text-primary-dark`}>Planning</span>}
          {s.planning && <HelpButton helpKey="plan.planning" />}
          {(project?.starts_on || project?.ends_on) && (
            <span>{formatDay(project.starts_on)} to {formatDay(project.ends_on)}</span>
          )}
        </p>
        {project?.notes && <p className="text-sm mt-2 break-words whitespace-pre-line">{project.notes}</p>}
      </div>

      <section className="bg-card border border-border rounded-lg p-4">
        <h4 className="text-sm text-muted-foreground"><HelpTitle text="Spent, received and net" helpKey="plan.project_totals" /></h4>
        <dl className="mt-2 divide-y divide-border">
          <Line label="Spent" value={formatMoney(s.spent)} />
          <Line label="Received" value={formatMoney(s.received)} />
          <Line label="Net" value={formatMoney(s.net)} strong />
          {hasBudget && <Line label="Budget" value={formatMoney(s.budget)} />}
          {hasBudget && (
            <Line label={over ? "Over budget by" : "Budget left"} value={formatMoney(Math.abs(toNumber(s.budget_left)))}
              tone={over ? "text-destructive" : ""} />
          )}
          <Line label="Still to pay" value={formatMoney(s.planned_out_due)} />
          {toNumber(s.planned_in_due) !== 0 && <Line label="Still to receive" value={formatMoney(s.planned_in_due)} />}
          {draftsDue && (
            <Line label={<>What-ifs, not counted<HelpButton helpKey="plan.drafts" /></>}
              value={formatMoney((toNumber(s.draft_out_due) || 0) + (toNumber(s.draft_in_due) || 0))}
              tone="text-muted-foreground" />
          )}
        </dl>
      </section>

      <section>
        <h3 className="font-medium mb-2">
          <HelpTitle text="Planned items" helpKey="plan.project_items" />{" "}
          <span className="text-muted-foreground font-normal">({items.length})</span>
        </h3>
        {items.length === 0 ? <p className="text-sm text-muted-foreground">No planned items on this project.</p> : (
          <ul className={LIST}>
            {items.map((it) => (
              <li key={it.id}>
                <button type="button" className={ROW} onClick={() => onOpenItem(it.id)}>
                  <span className="min-w-0">
                    <span className="block break-words">{it.name}</span>
                    <span className="block text-xs text-muted-foreground break-words">
                      {it.repeating ? `${intervalLabel(it)} from ${formatDay(it.due_on)}` : formatDay(it.due_on)}
                    </span>
                    <span className="flex flex-wrap gap-1 mt-1">
                      {it.draft
                        ? <span className={`${BADGE} border border-dashed border-primary text-primary-dark`}>What if</span>
                        : !it.repeating && <span className={`${BADGE} border border-border text-muted-foreground`}>{STAGE_LABELS[it.stage]}</span>}
                      {it.over_matched && <span className={`${BADGE} border border-destructive text-destructive`}>More than planned</span>}
                    </span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    {formatMoney(it.repeating || ["paid", "cancelled"].includes(it.stage) ? it.amount : it.remaining)}
                    {!it.repeating && toNumber(it.confirmed_total) !== 0 && !["paid", "cancelled"].includes(it.stage) && (
                      <span className="block text-xs text-muted-foreground">of {formatMoney(it.amount)}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="font-medium mb-2">
          <HelpTitle text="Payments" helpKey="plan.project_payments" />{" "}
          <span className="text-muted-foreground font-normal">({payments.length})</span>
        </h3>
        {payments.length === 0 ? <p className="text-sm text-muted-foreground">No payments on this project yet.</p> : (
          <ul className={LIST}>
            {payments.map((p) => (
              <li key={p.split_id}>
                <button type="button" className={ROW} onClick={() => onOpenTransaction(p.id)}>
                  <span className="min-w-0">
                    <span className="block break-words">{p.part_description || p.clean_description || p.merchant_name || p.payee || "Payment"}</span>
                    <span className="block text-xs text-muted-foreground">{formatDay(p.txn_date)}</span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    {formatMoney(p.part_amount)}
                    {p.split_count > 1 && <span className="block text-xs text-muted-foreground">part of {formatMoney(p.amount)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
