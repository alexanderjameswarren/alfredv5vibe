import React, { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import AppIcon from "../apps/AppIcon";
import ObjectIcon, { GroupTypeIcon } from "../shared/ObjectIcon";
import OverwatchCopyButton from "./OverwatchCopyButton";
import MoreLess, { useClamp } from "./MoreLess";
import { addedLabel, groupCopy, ideaGroups, rowCopy } from "./ideasModel";

const ICON = "w-4 h-4 shrink-0 text-primary";

function GroupIcon({ icon, projectIcon, apps }) {
  if (icon.kind === "group") return <GroupTypeIcon icon={projectIcon} className={ICON} />;
  if (icon.kind === "context") return <ObjectIcon type="context" className={ICON} />;
  return <AppIcon icon={apps.find((a) => a.id === icon.value)?.icon} className={ICON} />;
}

function RowIcon({ row, projectIcon }) {
  if (row.kind === "project") return <GroupTypeIcon icon={projectIcon} className={`${ICON} mt-1`} />;
  return <ObjectIcon type={row.kind} className={`${ICON} mt-1`} />;
}

/** One idea: the whole row is a real link to the record. It copies itself only when its group has one row. */
function IdeaRow({ row, projectIcon, copyable }) {
  const clamp = useClamp(row.name);
  const added = addedLabel(row.created_at);
  return (
    <article className="relative flex items-start gap-3 px-4 py-3.5 bg-card border border-border rounded-lg hover:border-primary transition-colors">
      <RowIcon row={row} projectIcon={projectIcon} />
      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
        <h4 ref={clamp.ref} className={`m-0 text-base font-medium leading-snug text-foreground ${clamp.expanded ? "" : "line-clamp-2"}`}>
          <Link to={row.path} className="text-foreground after:absolute after:inset-0">{row.name}</Link>
        </h4>
        {clamp.show && <MoreLess expanded={clamp.expanded} onToggle={clamp.toggle} />}
        {(added || row.note) && (
          <p className="m-0 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
            {added && <span>{added}</span>}
            {added && row.note && <span aria-hidden="true">·</span>}
            {row.note && <span>{row.note}</span>}
          </p>
        )}
      </div>
      {copyable && <OverwatchCopyButton className="relative z-10" copy={rowCopy(row)} />}
    </article>
  );
}

/**
 * A group starts collapsed; its heading toggles it. The copy rule: a group of 2 or more copies once,
 * on its heading (open or not); a group of 1 copies on its row. The copy button sits beside the toggle.
 */
function Group({ group, projectIcon, apps }) {
  const [open, setOpen] = useState(false);
  const many = group.rows.length >= 2;
  return (
    <section aria-label={group.title} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
            className="flex items-center gap-2 min-h-[44px] text-sm font-medium text-muted-foreground hover:text-foreground">
            <ChevronDown className={`w-4 h-4 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
            <GroupIcon icon={group.icon} projectIcon={projectIcon} apps={apps} />
            {group.title} ({group.rows.length})
          </button>
        </h3>
        {many && <OverwatchCopyButton copy={groupCopy(group)} />}
      </div>
      {open && group.rows.map((row) => <IdeaRow key={row.id} row={row} projectIcon={projectIcon} copyable={!many} />)}
    </section>
  );
}

export function ideaCount(groups) {
  return groups.reduce((n, g) => n + g.rows.length, 0);
}

export default function IdeasSection({ groups = null, data = null, projectIcon = "SquareKanban", apps = [] }) {
  const list = groups || ideaGroups({ ...data, apps });
  if (!ideaCount(list)) return <p className="m-0 text-sm text-muted-foreground">No ideas waiting.</p>;
  return (
    <div className="space-y-4">
      {list.map((g) => <Group key={g.key} group={g} projectIcon={projectIcon} apps={apps} />)}
    </div>
  );
}
