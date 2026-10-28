import React, { useState } from "react";
import { Link } from "react-router-dom";
import { groupDetailPath, overwatchPlanPath } from "../viewPaths";
import { GroupTypeIcon } from "../shared/ObjectIcon";
import OverwatchCopyButton from "./OverwatchCopyButton";
import { ProjectCard } from "./ProjectsSection";
import { projectView } from "./projectsModel";
import {
  STATUS_WORDS, notInPlanCopy, pickPortfolio, portfolioView, sliceCopy, sliceTitle, slicesCopy,
} from "./portfolioModel";

// The portfolio plan in the Projects section (spec section 9, item 3): a switch, then Now, Next, Later and
// "Not in the plan". The copy rule is the Ideas one: a group of 2 or more copies once, on its heading.

const REMEMBER_KEY = "overwatch.portfolio";

function remembered() {
  try { return window.localStorage.getItem(REMEMBER_KEY); } catch { return null; }
}

function remember(id) {
  try { window.localStorage.setItem(REMEMBER_KEY, id); } catch { /* the choice just is not kept */ }
}

/** Chips in the Inbox chip style, in position order. */
function Switch({ portfolios, current, onPick }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Portfolio">
      {portfolios.map((p) => (
        <button key={p.id} type="button" onClick={() => onPick(p.id)} aria-pressed={p.id === current.id}
          className={`inline-flex items-center min-h-[44px] px-3 py-2 rounded-full border text-sm transition-colors ${
            p.id === current.id
              ? "bg-secondary text-foreground border-primary"
              : "bg-background text-muted-foreground border-border hover:bg-secondary"
          }`}>
          {p.name}
        </button>
      ))}
    </div>
  );
}

/** One slice: the whole row is a real link to its group. */
function SliceRow({ s, icon, label = null, copy = null }) {
  return (
    <article className="relative flex items-start gap-3 px-4 py-3.5 bg-card border border-border rounded-lg hover:border-primary transition-colors">
      <GroupTypeIcon icon={icon} className="w-4 h-4 shrink-0 mt-1 text-primary" />
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <h4 className="m-0 text-base font-medium leading-snug">
          <Link to={groupDetailPath(s.group_id)} className="text-foreground after:absolute after:inset-0">{sliceTitle(s)}</Link>
        </h4>
        <p className="m-0 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
          {label && <><span>{label}</span><span aria-hidden="true">·</span></>}
          <span>{STATUS_WORDS[s.status]}</span>
          {s.progress?.project_code && <><span aria-hidden="true">·</span><span>{s.progress.project_code}</span></>}
        </p>
        {s.status === "paused" && s.paused_reason && <p className="m-0 text-sm text-foreground">Paused: {s.paused_reason}</p>}
        {s.why && <p className="m-0 text-sm text-muted-foreground">{s.why}</p>}
      </div>
      {copy && <OverwatchCopyButton className="relative z-10" copy={copy} />}
    </article>
  );
}

const GROUP_STATUS = { someday: "Someday", active: "Active", background: "Background" };

/** A Project no slice names: a real link to its group. */
function ProjectRow({ p, icon, copy }) {
  return (
    <article className="relative flex items-start gap-3 px-4 py-3.5 bg-card border border-border rounded-lg hover:border-primary transition-colors">
      <GroupTypeIcon icon={icon} className="w-4 h-4 shrink-0 mt-1 text-primary" />
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <h4 className="m-0 text-base font-medium leading-snug">
          <Link to={groupDetailPath(p.group_id)} className="text-foreground after:absolute after:inset-0">{p.name}</Link>
        </h4>
        <p className="m-0 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
          <span>{GROUP_STATUS[p.group_status] || p.group_status}</span>
          {p.project_code && <><span aria-hidden="true">·</span><span>{p.project_code}</span></>}
        </p>
      </div>
      {copy && <OverwatchCopyButton className="relative z-10" copy={copy} />}
    </article>
  );
}

function Group({ title, copy = null, children }) {
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-medium text-muted-foreground">{title}</h3>
        {copy && <OverwatchCopyButton copy={copy} />}
      </div>
      {children}
    </section>
  );
}

function NowLane({ lane, slice, ctx, copyable }) {
  if (!slice) {
    return (
      <p className="m-0 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{lane.name}</span>: Nothing in progress
      </p>
    );
  }
  const copy = copyable ? sliceCopy(slice, ctx.portfolio.name) : null;
  return (
    <div className="space-y-1">
      <p className="m-0 text-sm font-medium text-foreground">{lane.name}</p>
      {slice.progress
        ? <ProjectCard v={projectView(slice.progress, { ...ctx.projects, today: ctx.today })} icon={ctx.icon}
          slice={slice} copy={copy} />
        : <SliceRow s={slice} icon={ctx.icon} copy={copy} />}
    </div>
  );
}

export default function PortfolioPlan({ projects, portfolios, today, fallback }) {
  const [pickedId, setPickedId] = useState(remembered);
  const portfolio = pickPortfolio(portfolios.portfolios, pickedId);
  const view = portfolioView(portfolio, portfolios);
  const icon = projects.projectIcon || "SquareKanban";
  const ctx = { portfolio, projects, today, icon };
  const pick = (id) => { setPickedId(id); remember(id); };
  const name = portfolio.name;

  const nowSlices = view.now.map((n) => n.slice).filter(Boolean);
  const nextSlices = view.next.map((n) => n.slice);
  return (
    <div className="space-y-4">
      <Switch portfolios={portfolios.portfolios} current={portfolio} onPick={pick} />
      {view.plan && (
        <Link to={overwatchPlanPath(portfolio.id)}
          className="inline-flex items-center min-h-[44px] text-sm text-primary hover:text-primary-hover">
          Open the {name} plan: theory, versions, status changes
        </Link>
      )}
      {!view.plan ? (
        <>
          <p className="m-0 text-sm text-muted-foreground">No plan for {name} yet.</p>
          {fallback}
        </>
      ) : (
        <>
          <Group title="Now" copy={nowSlices.length >= 2 ? slicesCopy("Now", nowSlices, name) : null}>
            {view.now.map(({ lane, slice }) => (
              <NowLane key={lane.id} lane={lane} slice={slice} ctx={ctx} copyable={nowSlices.length < 2} />
            ))}
          </Group>
          {nextSlices.length > 0 && (
            <Group title="Next" copy={nextSlices.length >= 2 ? slicesCopy("Next", nextSlices, name) : null}>
              {view.next.map(({ lane, slice }) => (
                <SliceRow key={slice.id} s={slice} icon={icon} label={lane.name}
                  copy={nextSlices.length < 2 ? sliceCopy(slice, name) : null} />
              ))}
            </Group>
          )}
          {view.later.length > 0 && (
            <Group title="Later">
              {view.later.map(({ lane, slices, done }) => (
                <section key={lane.id} aria-label={`Later in ${lane.name}`} className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="m-0 text-sm font-medium text-foreground">{lane.name}</p>
                    {slices.length >= 2 && <OverwatchCopyButton copy={slicesCopy(`Later ${lane.name}`, slices, name)} />}
                  </div>
                  {slices.map((s) => (
                    <SliceRow key={s.id} s={s} icon={icon} copy={slices.length < 2 ? sliceCopy(s, name) : null} />
                  ))}
                  {done > 0 && <p className="m-0 text-xs text-muted-foreground">{done} done</p>}
                </section>
              ))}
            </Group>
          )}
          {view.notInPlan.length > 0 && (
            <Group title="Not in the plan" copy={view.notInPlan.length >= 2 ? notInPlanCopy(view.notInPlan, name) : null}>
              {view.notInPlan.map((p) => (
                <ProjectRow key={p.group_id} p={p} icon={icon}
                  copy={view.notInPlan.length < 2 ? notInPlanCopy(view.notInPlan, name) : null} />
              ))}
            </Group>
          )}
        </>
      )}
    </div>
  );
}
