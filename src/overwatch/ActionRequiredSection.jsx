import React from "react";
import { Link } from "react-router-dom";
import { friendlyDate, SourceIcon } from "../inbox/CaptureMeta";
import { inboxDetailPath } from "../viewPaths";
import { firstLine } from "./overwatchApi";
import { recordLink } from "./overwatchCopy";
import OverwatchCopyButton from "./OverwatchCopyButton";
import MoreLess, { useClamp } from "./MoreLess";

// Kinds that are time-sensitive: shown in the danger colour (spec section 9, rule 5).
const URGENT_KINDS = new Set(["overdue", "failure"]);

/** source_metadata.kind in words: "status_request" -> "Status request". */
export function kindLabel(kind) {
  if (!kind) return "Task";
  const words = String(kind).replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The row title: the first line without "Overwatch: " and a trailing " — <date>" (the copy keeps them). */
export function displayTitle(line) {
  const short = line.replace(/^Overwatch:\s*/, "").replace(/\s+—\s+\d{4}-\d{2}-\d{2}$/, "");
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** One of Overwatch's open inbox items, laid out like an Inbox row. The title is a real link stretched over the row. */
function ActionRow({ row }) {
  const title = firstLine(row.captured_text);
  const kind = kindLabel(row.source_metadata?.kind);
  const urgent = URGENT_KINDS.has(row.source_metadata?.kind);
  const clamp = useClamp(title);
  return (
    <article
      className={`relative flex items-start gap-3 px-4 py-3.5 bg-card border rounded-lg hover:border-primary transition-colors ${
        urgent ? "border-destructive" : "border-border"
      }`}
    >
      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
        <h3 ref={clamp.ref} className={`m-0 text-base font-medium leading-snug ${clamp.expanded ? "" : "line-clamp-2"}`}>
          <Link
            to={inboxDetailPath(row.id)}
            className={`after:absolute after:inset-0 ${urgent ? "text-destructive" : "text-foreground"}`}
          >
            {displayTitle(title)}
          </Link>
        </h3>
        {clamp.show && <MoreLess expanded={clamp.expanded} onToggle={clamp.toggle} />}
        <p className="m-0 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
          <span className={`inline-flex items-center gap-1.5 ${urgent ? "text-destructive" : ""}`}>
            <SourceIcon sourceType={row.source_type} />
            {kind}
          </span>
          <span aria-hidden="true">·</span>
          <span>{friendlyDate(row.created_at)}</span>
        </p>
      </div>
      <OverwatchCopyButton
        className="relative z-10"
        copy={{
          what: "inbox item",
          name: title,
          facts: [`Kind: ${kind}`],
          ids: { inbox_id: row.id },
          link: recordLink(row.id),
          question: "What should I do about this?",
        }}
      />
    </article>
  );
}

export default function ActionRequiredSection({ rows }) {
  if (!rows.length) return <p className="m-0 text-sm text-muted-foreground">Nothing from Overwatch is waiting on you.</p>;
  return (
    <div className="space-y-2">
      {rows.map((row) => <ActionRow key={row.id} row={row} />)}
    </div>
  );
}
