// Copy text for the Overwatch tab: paste-ready for an Overwatch chat or a new thread.
// Spec: docs/technical-spec-overwatch-q4n.md section 9 (Phase 6 design rule 2).

import { RECORD_LINK_BASE } from "../shared/copyRecord";
import { groupDetailPath } from "../viewPaths";

export const COPY_PREFIX = "Overwatch:";

export function recordLink(id) {
  return `${RECORD_LINK_BASE}${id}`;
}

export function groupLink(id) {
  return `${RECORD_LINK_BASE}${groupDetailPath(id).slice(1)}`;
}

/**
 * "Overwatch: <what> — <name>", then one line per fact, the ids, the link and, after a
 * blank line, the question. Empty facts and ids are left out.
 */
export function overwatchCopyText({ what, name, facts = [], ids = {}, link, question }) {
  const lines = [`${COPY_PREFIX} ${what}${name ? ` — ${name}` : ""}`];
  for (const fact of facts) if (fact) lines.push(fact);
  const idText = Object.entries(ids)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  if (idText) lines.push(idText);
  if (link) lines.push(link);
  if (question) lines.push("", question);
  return lines.join("\n");
}
