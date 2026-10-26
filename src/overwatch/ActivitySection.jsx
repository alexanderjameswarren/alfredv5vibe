import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import AppIcon from "../apps/AppIcon";
import { daysBefore, pacificToday } from "../money/moneyFormat";
import { appDisplayName } from "./appNames";
import { GroupTypeIcon } from "../shared/ObjectIcon";
import { groupDetailPath } from "../viewPaths";
import { getActivityDay, getActivityGroupInfo, getApps } from "./overwatchApi";
import OverwatchCopyButton from "./OverwatchCopyButton";
import MoreLess, { useClamp } from "./MoreLess";
import {
  activityCopy, applyFilters, capitalize, dayEntries, dayLabel, emptyText, facets, fullDay, projectCopy, projectTitle,
  rowPath, rowTime, sameTitleCopy, sourceLabel, timeRange,
} from "./activityModel";

// The Activity section: one Pacific day at a time. It opens on yesterday, the last complete day,
// since app use is logged by the nightly run. Self-contained (its own reads, state and model) so it
// can become its own tab.

const CHIP = "px-3 py-1.5 min-h-[40px] text-sm rounded-full border transition-colors";
const CHIP_ON = "bg-primary text-white border-primary";
const CHIP_OFF = "bg-background text-muted-foreground border-border hover:bg-secondary";

function Chips({ label, options, selected, onSelect }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {[[null, "All"], ...options].map(([value, text]) => (
        <button key={value || "all"} type="button" aria-pressed={selected === value}
          onClick={() => onSelect(value)} className={`${CHIP} ${selected === value ? CHIP_ON : CHIP_OFF}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * One row. The copy rule: a group copies once, on its header; rows inside a group have no copy
 * button (`copy={null}`); a row on its own has its own.
 */
function Row({ row, app, appName, title, count = null, open = null, onToggle = null, copy = undefined }) {
  const path = count === null ? rowPath(row) : null;
  const source = sourceLabel(row.source);
  const text = count === null ? title : `${appName}: ${title} ×${count}`;
  const clamp = useClamp(text);
  return (
    <article className={`relative flex items-start gap-3 px-4 py-3.5 bg-card border border-border rounded-lg ${
      path ? "hover:border-primary transition-colors" : ""}`}>
      <AppIcon icon={app?.icon} className="w-4 h-4 mt-1 shrink-0 text-primary" />
      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
        <h3 ref={clamp.ref} className={`m-0 text-base font-medium leading-snug text-foreground ${clamp.expanded ? "" : "line-clamp-2"}`}>
          {path ? <Link to={path} className="text-foreground after:absolute after:inset-0">{text}</Link> : text}
        </h3>
        {clamp.show && <MoreLess expanded={clamp.expanded} onToggle={clamp.toggle} />}
        <p className="m-0 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
          <span>{capitalize(row.kind)}</span>
          <span aria-hidden="true">·</span>
          <span>{rowTime(row)}</span>
          {source && <><span aria-hidden="true">·</span><span>{source}</span></>}
        </p>
      </div>
      {count !== null && (
        <button type="button" onClick={onToggle} aria-expanded={open}
          aria-label={open ? `Hide the ${count}` : `Show all ${count}`}
          className="relative z-10 inline-flex items-center justify-center shrink-0 min-h-[40px] min-w-[40px] rounded text-muted-foreground hover:text-foreground">
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
        </button>
      )}
      {copy !== null && (
        <OverwatchCopyButton className="relative z-10" copy={copy || activityCopy(row, appName)} />
      )}
    </article>
  );
}

function Entry({ group, apps, names, dayText }) {
  const [open, setOpen] = useState(false);
  const first = group.rows[0];
  const app = apps.find((a) => a.id === first.app_id);
  const appName = appDisplayName(first.app_id, names);
  if (group.rows.length === 1) return <Row row={first} app={app} appName={appName} title={first.title} />;
  return (
    <div className="space-y-2">
      <Row row={first} app={app} appName={appName} title={first.title} count={group.rows.length}
        open={open} onToggle={() => setOpen(!open)} copy={sameTitleCopy(group.rows, appName, dayText)} />
      {open && (
        <div className="pl-4 space-y-2">
          {group.rows.map((r) => <Row key={r.id} row={r} app={app} appName={appName} title={r.title} copy={null} />)}
        </div>
      )}
    </div>
  );
}

/**
 * A project's rows for the day as one row: a real link to the group, with a chevron beside it that
 * expands the rows in place (its click stops there) and the project's own copy button.
 */
function ProjectEntry({ entry, apps, names, info, dayText }) {
  const [open, setOpen] = useState(false);
  const name = info.names[entry.groupId] || "Project";
  const first = entry.rows[0];
  const app = apps.find((a) => a.id === first.app_id);
  const title = projectTitle(name, entry.rows);
  const clamp = useClamp(title);
  return (
    <div className="space-y-2">
      <article className="relative flex items-start gap-3 px-4 py-3.5 bg-card border border-border rounded-lg hover:border-primary transition-colors">
        <AppIcon icon={app?.icon} className="w-4 h-4 mt-1 shrink-0 text-primary" />
        <div className="flex flex-col gap-1.5 min-w-0 flex-1">
          <h3 ref={clamp.ref} className={`m-0 text-base font-medium leading-snug text-foreground ${clamp.expanded ? "" : "line-clamp-2"}`}>
            <Link to={groupDetailPath(entry.groupId)} className="text-foreground after:absolute after:inset-0">
              {title}
            </Link>
          </h3>
          {clamp.show && <MoreLess expanded={clamp.expanded} onToggle={clamp.toggle} />}
          <p className="m-0 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
            <span>{timeRange(entry.rows)}</span>
            <span aria-hidden="true">·</span>
            <GroupTypeIcon icon={info.projectIcon} className="w-3.5 h-3.5" />
          </p>
        </div>
        <button type="button" aria-expanded={open}
          aria-label={open ? `Hide the ${entry.rows.length}` : `Show all ${entry.rows.length}`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); }}
          className="relative z-10 inline-flex items-center justify-center shrink-0 min-h-[40px] min-w-[40px] rounded text-muted-foreground hover:text-foreground">
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
        </button>
        <OverwatchCopyButton className="relative z-10" copy={projectCopy(name, entry.rows, dayText)} />
      </article>
      {open && (
        <div className="pl-4 space-y-2">
          {entry.rows.map((r) => (
            <Row key={r.id} row={r} app={apps.find((a) => a.id === r.app_id)} appName={appDisplayName(r.app_id, names)}
              title={r.title} copy={null} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ActivitySection({ initialDay = null }) {
  const today = pacificToday();
  const [day, setDay] = useState(initialDay || daysBefore(today, 1));
  const [filters, setFilters] = useState({ app: null, kind: null });
  const [state, setState] = useState({ loading: true, error: null, rows: [], info: { names: {}, projectIcon: "SquareKanban" } });
  // The apps, read live when the section opens (not the session-long useApps cache).
  const [apps, setApps] = useState([]);
  const names = Object.fromEntries(apps.map((a) => [a.id, a.name]));

  useEffect(() => {
    let live = true;
    getApps().then((list) => live && setApps(list)).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null, rows: [] }));
    (async () => {
      const rows = await getActivityDay(day);
      const info = await getActivityGroupInfo([...new Set(rows.map((r) => r.group_id).filter(Boolean))]);
      return { rows, info };
    })()
      .then(({ rows, info }) => live && setState({ loading: false, error: null, rows, info }))
      .catch((err) => live && setState((s) => ({ ...s, loading: false, error: err.message, rows: [] })));
    return () => { live = false; };
  }, [day]);

  const label = dayLabel(day, today);
  const shown = applyFilters(state.rows, filters);
  const appOptions = facets(state.rows, "app_id").map(([id, n]) => [id, `${appDisplayName(id, names)} (${n})`]);
  const kindOptions = facets(state.rows, "kind").map(([k, n]) => [k, `${capitalize(k)} (${n})`]);
  const filterNames = [filters.app && appDisplayName(filters.app, names), filters.kind && capitalize(filters.kind)].filter(Boolean);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => setDay(daysBefore(day, 1))}
          className="inline-flex items-center gap-1 min-h-[44px] text-sm text-primary hover:text-primary-hover">
          <ChevronLeft className="w-4 h-4" aria-hidden="true" />Earlier
        </button>
        <h4 className="m-0 text-base font-medium text-foreground">{label}</h4>
        <button type="button" onClick={() => setDay(daysBefore(day, -1))} disabled={day >= today}
          className="inline-flex items-center gap-1 min-h-[44px] text-sm text-primary hover:text-primary-hover disabled:text-muted-foreground disabled:opacity-50">
          Later<ChevronRight className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      {(state.rows.length > 0 || filterNames.length > 0) && (
        <div className="space-y-2">
          <Chips label="Filter by app" options={appOptions} selected={filters.app}
            onSelect={(app) => setFilters({ ...filters, app })} />
          <Chips label="Filter by kind" options={kindOptions} selected={filters.kind}
            onSelect={(kind) => setFilters({ ...filters, kind })} />
        </div>
      )}
      {state.error && <p role="alert" className="m-0 text-sm text-destructive">{state.error}</p>}
      {state.loading && <p className="m-0 text-sm text-muted-foreground">Loading…</p>}
      {!state.loading && !state.error && !shown.length && (
        <p className="m-0 text-sm text-muted-foreground">{emptyText(label, filterNames)}</p>
      )}
      {!state.loading && shown.length > 0 && (
        <div className="space-y-2">
          {dayEntries(shown).map((e) => (e.type === "project"
            ? <ProjectEntry key={e.key} entry={e} apps={apps} names={names} info={state.info} dayText={fullDay(day)} />
            : <Entry key={e.key} group={e} apps={apps} names={names} dayText={fullDay(day)} />))}
        </div>
      )}
    </div>
  );
}
