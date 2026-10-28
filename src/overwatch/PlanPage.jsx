import React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import ObjectIcon, { GroupTypeIcon } from "../shared/ObjectIcon";
import { OVERWATCH_PATH, groupDetailPath, overwatchPlanPath, overwatchSlicePath } from "../viewPaths";
import { pacificToday } from "../money/moneyFormat";
import OverwatchCopyButton from "./OverwatchCopyButton";
import useLoad from "./useLoad";
import { getPlanPage } from "./overwatchApi";
import { shortDay } from "./projectsModel";
import { STATUS_WORDS, sliceTitle } from "./portfolioModel";
import { AUTHOR_WORDS, planCopy, planLanes, reviewPassed } from "./planPageModel";

// The plan page (spec section 9, item 3, Step 56): /overwatch/plan/<portfolio_id> shows the active version,
// .../version/<plan_id> an older one, read only. The whole plan copies once, from its heading.

function Field({ label, children, className = "" }) {
  return (
    <div>
      <p className="m-0 text-xs text-muted-foreground">{label}</p>
      <div className={`m-0 text-sm text-foreground whitespace-pre-wrap ${className}`}>{children}</div>
    </div>
  );
}

/** A slice: the whole card is a real link to its group; on the active version, "Change status" sits above it. */
function SliceCard({ s, editPath }) {
  return (
    <article className="relative flex items-start gap-3 px-4 py-3.5 bg-card border border-border rounded-lg hover:border-primary transition-colors">
      <GroupTypeIcon icon="SquareKanban" className="w-4 h-4 shrink-0 mt-1 text-primary" />
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <h4 className="m-0 text-base font-medium leading-snug">
          <Link to={groupDetailPath(s.group_id)} className="text-foreground after:absolute after:inset-0">{sliceTitle(s)}</Link>
        </h4>
        <p className="m-0 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
          <span>{STATUS_WORDS[s.status]}</span>
          {s.project_code && <><span aria-hidden="true">·</span><span>{s.project_code}</span></>}
        </p>
        {s.status === "paused" && s.paused_reason && <p className="m-0 text-sm text-foreground">Paused: {s.paused_reason}</p>}
        {s.why && <p className="m-0 text-sm text-muted-foreground">{s.why}</p>}
        {editPath && (
          <Link to={editPath} className="relative z-10 self-start inline-flex items-center min-h-[44px] text-sm text-primary hover:text-primary-hover">
            Change status
          </Link>
        )}
      </div>
    </article>
  );
}

/** Every version but the one on screen, newest first; hidden when there is none. */
function Versions({ portfolio, versions, current }) {
  const others = versions.filter((v) => v.id !== current.id);
  if (!others.length) return null;
  const title = current.active ? "Earlier versions" : "Other versions";
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="m-0 text-sm font-medium text-muted-foreground">{title}</h3>
      {others.map((v) => (
        <article key={v.id} className="relative px-4 py-3 bg-card border border-border rounded-lg hover:border-primary transition-colors">
          <p className="m-0 text-sm font-medium">
            <Link to={overwatchPlanPath(portfolio.id, v.active ? null : v.id)} className="text-foreground after:absolute after:inset-0">
              {shortDay(String(v.created_at).slice(0, 10))} · {AUTHOR_WORDS[v.written_by] || v.written_by}{v.active ? " · Active" : ""}
            </Link>
          </p>
          <p className="m-0 mt-1 text-sm text-muted-foreground">{v.reason}</p>
        </article>
      ))}
    </section>
  );
}

export default function PlanPage({ portfolioId, planId = null }) {
  const { loading, error, data } = useLoad(() => getPlanPage(portfolioId, planId), `${portfolioId}/${planId}`);
  const back = (
    <Link to={OVERWATCH_PATH} className="inline-flex items-center gap-2 mb-3 min-h-[44px] text-primary hover:text-primary-hover">
      <ArrowLeft className="w-4 h-4" aria-hidden="true" />
      Overwatch
    </Link>
  );
  if (loading) return <div>{back}<p className="m-0 text-sm text-muted-foreground">Loading…</p></div>;
  if (error) return <div>{back}<p role="alert" className="m-0 text-sm text-destructive">{error}</p></div>;
  const { portfolio, plan, versions } = data;
  if (!portfolio) return <div>{back}<p className="m-0 text-sm text-muted-foreground">No such portfolio.</p></div>;
  if (!plan) {
    return (
      <div>
        {back}
        <p className="m-0 text-sm text-muted-foreground">
          {planId ? `That version of the ${portfolio.name} plan was not found.` : `No plan for ${portfolio.name} yet.`}
        </p>
      </div>
    );
  }
  const lanes = planLanes(data);
  const editable = plan.active && !portfolio.archived;
  const passed = reviewPassed(plan.review_by, pacificToday());
  return (
    <div className="min-w-0 [overflow-wrap:anywhere] space-y-4">
      {back}
      <div className="flex items-start justify-between gap-2">
        <h2 className="m-0 flex items-start gap-2 text-xl sm:text-2xl font-bold">
          <ObjectIcon type="overwatch" className="w-6 h-6 text-primary" align="first-line" />
          <span className="min-w-0">{portfolio.name} plan</span>
        </h2>
        <OverwatchCopyButton copy={planCopy(portfolio, plan, lanes)} />
      </div>
      {!plan.active && (
        <p className="m-0 px-4 py-3 rounded-lg bg-muted text-sm text-foreground">
          An older version, read only.{" "}
          <Link to={overwatchPlanPath(portfolio.id)} className="text-primary hover:text-primary-hover">Open the current plan</Link>
        </p>
      )}
      <div className="space-y-3">
        <Field label="Theory">{plan.theory}</Field>
        {plan.notes_for_next_review && <Field label="Notes for next review">{plan.notes_for_next_review}</Field>}
        {plan.review_by && (
          <Field label="Review by" className={passed ? "text-destructive" : ""}>
            {shortDay(plan.review_by)}{passed ? " (passed)" : ""}
          </Field>
        )}
        <Field label="Why this version">{plan.reason}</Field>
        <Field label="Written">
          {AUTHOR_WORDS[plan.written_by] || plan.written_by}, {shortDay(String(plan.created_at).slice(0, 10))}
        </Field>
      </div>
      {lanes.map((lane) => (
        <section key={lane.id} aria-label={`Lane ${lane.name}`} className="space-y-2">
          <div>
            <h3 className="m-0 text-base font-medium text-foreground">{lane.name}</h3>
            {lane.note && <p className="m-0 text-sm text-muted-foreground">{lane.note}</p>}
          </div>
          {lane.slices.length
            ? lane.slices.map((s) => (
              <SliceCard key={s.id} s={s} editPath={editable ? overwatchSlicePath(portfolio.id, s.id) : null} />
            ))
            : <p className="m-0 text-sm text-muted-foreground">No slices.</p>}
        </section>
      ))}
      <Versions portfolio={portfolio} versions={versions} current={plan} />
    </div>
  );
}
