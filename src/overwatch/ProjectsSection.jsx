import React from "react";
import { Link } from "react-router-dom";
import { groupDetailPath } from "../viewPaths";
import { GroupTypeIcon } from "../shared/ObjectIcon";
import { groupLink } from "./overwatchCopy";
import OverwatchCopyButton from "./OverwatchCopyButton";
import { projectView, shortDay } from "./projectsModel";

function stepsText(v, unit = " steps") {
  if (!v.effort_estimate) return `${v.steps_used} steps, no estimate`;
  return `${v.steps_used} of ${v.effort_estimate}${unit}${v.original !== null ? ` (original ${v.original})` : ""}`;
}

function waitingText(v) {
  if (!v.waiting) return null;
  return v.waiting.groupId ? `${v.waiting.groupName}${v.waiting.text ? `: ${v.waiting.text}` : ""}` : v.waiting.text;
}

function scopeText(e) {
  const n = e.steps_added > 0 ? `+${e.steps_added}` : `${e.steps_added}`;
  return `${n}${e.at_step != null ? ` at step ${e.at_step}` : ""}: ${e.reason}`;
}

export function projectCopy(v) {
  return {
    what: "project",
    name: v.name,
    facts: [
      v.where_now && `Where now: ${v.where_now}`,
      v.next_step && `Next step: ${v.next_step}`,
      v.waiting && `Waiting on: ${waitingText(v)}`,
      `Steps: ${stepsText(v, "")}`,
      v.target_date && `Target: ${shortDay(v.target_date)}`,
      `Estimated finish: ${v.finish.label}`,
      v.stalledDays !== null && `Stalled: ${v.stalledDays} days since the last report`,
      v.overrun === "steps" && "Overrun: steps used are past the estimate",
      v.overrun === "target" && "Overrun: past the target date",
      v.empty && "No item or intention yet",
      ...v.scopeChanges.map((e) => `Scope change: ${scopeText(e)}`),
    ],
    ids: { group_id: v.group_id, project_code: v.project_code },
    link: groupLink(v.group_id),
    question: "Where should this project go next?",
  };
}

function Line({ label, children }) {
  return (
    <p className="m-0 text-sm text-foreground">
      <span className="text-muted-foreground">{label}: </span>
      {children}
    </p>
  );
}

/** The whole card is one real link to the group, stretched over it; inner links and the copy button sit above it. */
function ProjectCard({ v, icon }) {
  return (
    <article
      className={`relative px-4 py-3.5 bg-card border rounded-lg hover:border-primary transition-colors ${
        v.overrun || v.empty ? "border-destructive" : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="m-0 flex items-start gap-2 text-base font-medium leading-snug">
          <GroupTypeIcon icon={icon} className="w-4 h-4 text-primary" align="first-line" />
          <Link to={groupDetailPath(v.group_id)} className="text-foreground after:absolute after:inset-0">{v.name}</Link>
        </h3>
        <OverwatchCopyButton copy={projectCopy(v)} className="relative z-10" />
      </div>
      <p className="m-0 mt-1 mb-2 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
        {v.project_code && <><span>{v.project_code}</span><span aria-hidden="true">·</span></>}
        <span className={v.overrun === "steps" ? "text-destructive" : ""}>{stepsText(v)}</span>
        {v.target_date && (
          <><span aria-hidden="true">·</span>
            <span className={v.overrun === "target" ? "text-destructive" : ""}>Target {shortDay(v.target_date)}</span></>
        )}
        <span aria-hidden="true">·</span>
        <span>Finish {v.finish.label}</span>
      </p>
      <div className="space-y-1">
        {v.where_now && <Line label="Where now">{v.where_now}</Line>}
        {v.next_step && <Line label="Next">{v.next_step}</Line>}
        {v.waiting && (
          <Line label="Waiting on">
            {v.waiting.groupId
              ? <><Link to={groupDetailPath(v.waiting.groupId)} className="relative z-10 text-primary hover:text-primary-hover">{v.waiting.groupName}</Link>
                {v.waiting.text && `: ${v.waiting.text}`}</>
              : v.waiting.text}
          </Line>
        )}
        {v.stalledDays !== null && (
          <p className="m-0 text-sm text-foreground">Stalled: {v.stalledDays} days since the last report</p>
        )}
        {v.overrun && (
          <p className="m-0 text-sm text-destructive">
            {v.overrun === "steps" ? "Overrun: steps used are past the estimate" : "Overrun: past the target date"}
          </p>
        )}
        {v.empty && <p className="m-0 text-sm text-destructive">No item or intention yet</p>}
      </div>
      {v.scopeChanges.length > 0 && (
        <div className="mt-2">
          <p className="m-0 text-xs text-muted-foreground">Scope changes</p>
          <ul className="m-0 pl-5 list-disc text-xs text-muted-foreground">
            {v.scopeChanges.map((e) => <li key={`${e.created_at}-${e.kind}`}>{scopeText(e)}</li>)}
          </ul>
        </div>
      )}
    </article>
  );
}

export default function ProjectsSection({ data, today }) {
  if (!data.projects.length) return <p className="m-0 text-sm text-muted-foreground">No active Projects.</p>;
  return (
    <div className="space-y-2">
      {data.projects.map((p) => (
        <ProjectCard key={p.group_id} v={projectView(p, { ...data, today })} icon={data.projectIcon || "SquareKanban"} />
      ))}
    </div>
  );
}
