import React, { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Lightbulb, MoonStar, TriangleAlert } from "lucide-react";
import ObjectIcon, { GroupTypeIcon } from "../shared/ObjectIcon";
import { OVERWATCH_BRIEFING_PATH, overwatchRouteFromPath } from "../viewPaths";
import OverwatchSection from "./OverwatchSection";
import OverwatchCopyButton from "./OverwatchCopyButton";
import BriefingSection, { briefingCopy } from "./BriefingSection";
import ActionRequiredSection from "./ActionRequiredSection";
import ProjectsSection from "./ProjectsSection";
import QuietSection from "./QuietSection";
import ActivitySection from "./ActivitySection";
import IdeasSection from "./IdeasSection";
import FrictionSection from "./FrictionSection";
import {
  getApps, getIdeaRecords, getIdeas, getLatestRuns, getNeedsYou, getNote, getNotes, getOpenFriction, getProjects, getQuiet,
  getRunForNote,
} from "./overwatchApi";
import { ideaGroups } from "./ideasModel";
import { ideaCount } from "./IdeasSection";
import { quietApps } from "./quietModel";
import { statusLine } from "./statusLine";
import { pacificToday } from "../money/moneyFormat";

// The Overwatch tab (spec section 9): a live snapshot, read fresh when the page opens. The
// status line links to the latest briefing; the sections below never copy from it.

const ICON = "w-4 h-4 text-primary";

export const SECTIONS = [
  { id: "action-required", title: "Action Required", icon: <ObjectIcon type="inbox" className={ICON} />, defaultOpen: true },
  { id: "projects", title: "Active Projects", icon: <GroupTypeIcon icon="SquareKanban" className={ICON} />, defaultOpen: true,
    empty: "No active Projects." },
  { id: "quiet", title: "Quiet lately", icon: <MoonStar className={ICON} aria-hidden="true" />,
    empty: "No app is past its rhythm." },
  { id: "activity", title: "Activity", icon: <ObjectIcon type="execution" className={ICON} />,
    empty: "No activity today." },
  { id: "ideas", title: "Ideas", icon: <Lightbulb className={ICON} aria-hidden="true" />,
    empty: "No Someday or parked Projects." },
  { id: "friction", title: "Friction", icon: <TriangleAlert className={ICON} aria-hidden="true" />,
    empty: "No open friction." },
];

function useLoad(load, key) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null, data: null });
    load()
      .then((data) => live && setState({ loading: false, error: null, data }))
      .catch((err) => live && setState({ loading: false, error: err.message, data: null }));
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

async function loadTab() {
  const [notes, runs, needsYou, projects, quiet, ideas, ideaRecords, friction, apps] = await Promise.all([
    getNotes(), getLatestRuns(), getNeedsYou(), getProjects(), getQuiet(), getIdeas(), getIdeaRecords(), getOpenFriction(),
    getApps(),
  ]);
  return { notes, runs, needsYou, projects, quiet, ideas: { projects: ideas, ...ideaRecords }, friction, apps };
}

/** One briefing by id, or the latest nightly and this week's weekly, each with the run that wrote it. */
async function loadBriefings(noteId) {
  const notes = noteId ? [await getNote(noteId)] : Object.values(await getNotes());
  const real = notes.filter(Boolean);
  const runs = await Promise.all(real.map(getRunForNote));
  return real.map((note, i) => ({ note, run: runs[i] }));
}

/** The status line: a real link to the latest briefing, with that briefing's copy button. */
function StatusLine({ runs, nightlyNote, appNames }) {
  const { text, warning } = statusLine(runs, new Date(), appNames);
  return (
    <div
      className={`flex items-center justify-between gap-2 mb-3 px-4 py-1 rounded-lg border ${
        warning ? "border-destructive bg-destructive-light" : "border-border bg-card"
      }`}
    >
      <Link
        to={OVERWATCH_BRIEFING_PATH}
        className={`flex items-center gap-2 min-h-[44px] text-sm hover:underline ${
          warning ? "text-destructive" : "text-primary hover:text-primary-hover"
        }`}
      >
        {warning && <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />}
        {text}
      </Link>
      {nightlyNote && <OverwatchCopyButton copy={briefingCopy(nightlyNote, runs.nightly)} />}
    </div>
  );
}

function BriefingPage({ noteId }) {
  const { loading, error, data } = useLoad(() => loadBriefings(noteId), noteId || "latest");
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      <BriefingSection briefings={data || []} loading={loading} missing={!!noteId} />
    </div>
  );
}

function TabPage() {
  const { loading, error, data } = useLoad(loadTab, "tab");
  // Read live with the rest of the tab (getApps), so a new apps row groups and labels at once.
  const apps = data?.apps || [];
  const appNames = Object.fromEntries(apps.map((a) => [a.id, a.name]));
  const needsYou = data?.needsYou || [];
  const today = pacificToday();
  const quiet = data
    ? quietApps({ ...data.quiet, note: data.notes.nightly, today, toDay: (iso) => pacificToday(new Date(iso)) })
    : [];
  const ideas = data ? ideaGroups({ ...data.ideas, apps }) : [];
  const counts = data
    ? {
      "action-required": needsYou.length,
      projects: data.projects.projects.length,
      quiet: quiet.length,
      ideas: ideaCount(ideas),
      friction: data.friction.entries.length,
    }
    : {};
  const body = (id) => {
    if (loading) return <p className="m-0 text-sm text-muted-foreground">Loading…</p>;
    if (!data) return null;
    if (id === "action-required") return <ActionRequiredSection rows={needsYou} />;
    if (id === "projects") return <ProjectsSection data={data.projects} today={today} />;
    if (id === "quiet") return <QuietSection rows={quiet} apps={apps} />;
    if (id === "activity") return <ActivitySection />;
    if (id === "ideas") return <IdeasSection groups={ideas} projectIcon={data.projects.projectIcon} apps={apps} />;
    if (id === "friction") return <FrictionSection entries={data.friction.entries} settings={data.friction.settings} />;
    return <p className="m-0 text-sm text-muted-foreground">{SECTIONS.find((s) => s.id === id).empty}</p>;
  };
  return (
    // Long words, ids and URLs wrap anywhere, so nothing scrolls sideways on a phone.
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <h2 className="flex items-start gap-2 mb-4 sm:mb-6 text-xl sm:text-2xl font-bold">
        <ObjectIcon type="overwatch" className="w-6 h-6 text-primary" align="first-line" />
        <span className="min-w-0">Overwatch</span>
      </h2>
      {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      {data && <StatusLine runs={data.runs} nightlyNote={data.notes.nightly} appNames={appNames} />}
      <div className="space-y-3">
        {SECTIONS.map((s) => (
          <OverwatchSection key={s.id} id={s.id} title={s.title} icon={s.icon}
            count={counts[s.id] ?? null} defaultOpen={!!s.defaultOpen}>
            {body(s.id)}
          </OverwatchSection>
        ))}
      </div>
    </div>
  );
}

export default function OverwatchPage() {
  const location = useLocation();
  const route = overwatchRouteFromPath(location.pathname) || { screen: "tab" };
  if (route.screen === "briefing") return <BriefingPage noteId={route.noteId} />;
  return <TabPage />;
}
