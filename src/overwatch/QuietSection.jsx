import React from "react";
import { Link } from "react-router-dom";
import AppIcon from "../apps/AppIcon";
import { RECORD_LINK_BASE } from "../shared/copyRecord";
import { appDisplayName } from "./appNames";
import OverwatchCopyButton from "./OverwatchCopyButton";
import { lastUsedLabel } from "./quietModel";

/** "Jobs (3 days)"; just "Money" when there is no date, since the line below says "No activity yet". */
function rowTitle(row, name) {
  return row.days === null ? name : `${name} (${row.days} day${row.days === 1 ? "" : "s"})`;
}

export function quietCopy(row, app, name) {
  return {
    what: "quiet app",
    name,
    facts: [
      row.lastUsed ? lastUsedLabel(row) : "No activity yet",
      `Rhythm: every ${row.rhythm} days`,
      row.days !== null && `Days since: ${row.days}`,
    ],
    ids: { app_id: row.appId },
    link: app?.path ? `${RECORD_LINK_BASE}${app.path.slice(1)}` : null,
    question: `Is ${name} still something I want to keep up with?`,
  };
}

/** With a screen, the whole row is one real link to it; without one, the row is plain. */
function QuietRow({ row, app, name }) {
  const title = rowTitle(row, name);
  const tone = row.red ? "text-destructive" : "text-foreground";
  return (
    <article
      className={`relative flex items-start gap-3 px-4 py-3.5 bg-card border rounded-lg ${
        app?.path ? "hover:border-primary transition-colors" : ""
      } ${row.red ? "border-destructive" : "border-border"}`}
    >
      <AppIcon icon={app?.icon} className={`w-4 h-4 mt-1 shrink-0 ${row.red ? "text-destructive" : "text-primary"}`} />
      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
        <h3 className={`m-0 text-base font-medium leading-snug ${tone}`}>
          {app?.path ? <Link to={app.path} className={`${tone} after:absolute after:inset-0`}>{title}</Link> : title}
        </h3>
        <p className="m-0 text-xs text-muted-foreground">
          {lastUsedLabel(row)} · rhythm {row.rhythm} days
        </p>
      </div>
      <OverwatchCopyButton className="relative z-10" copy={quietCopy(row, app, name)} />
    </article>
  );
}

export default function QuietSection({ rows, apps }) {
  if (!rows.length) return <p className="m-0 text-sm text-muted-foreground">Every app is on rhythm.</p>;
  const byId = Object.fromEntries(apps.map((a) => [a.id, a]));
  const names = Object.fromEntries(apps.map((a) => [a.id, a.name]));
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <QuietRow key={row.appId} row={row} app={byId[row.appId]} name={appDisplayName(row.appId, names)} />
      ))}
    </div>
  );
}
