// ============================================================================
// supabase/functions/_shared/tools/sam-warmup.ts
//
// The warm-up ladder, as the tools validate it.
// Spec: docs/technical-spec-sam-warmup-ladder.md §5.1, §8.
//
// THE CHECK CONSTRAINT IS THE INVARIANT, NOT THIS FILE. Every rule here is a
// copy of `sam_warmup_ladder_is_valid` (migrations 078 and 080), and the only
// reason for the copy is a sentence that names the rung and says what is wrong,
// instead of a Postgres constraint name arriving after the write was refused. If
// the two ever disagree the database wins, and a ladder that slips past this
// function is still rejected — which is the point of putting the rule in a CHECK
// constraint in the first place.
//
// The same rules are also implemented for the app's editor in
// src/sam/lib/warmupLadderEdit.js. Three copies of one rule is two too many, and
// the reason it is tolerable is that the DATABASE is the one that decides: the
// other two only ever produce a better error message, never a different answer.
// ============================================================================

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const MIN_RUNGS = 2;
export const MAX_RUNGS = 6;
export const TARGET_PERCENT = 100;
const RUNG_KEYS = ["target_percent", "accuracy_target", "target_passes", "consecutive"];

const isWhole = (v: unknown) => Number.isInteger(v);

/**
 * Every problem with one ladder value, as messages prefixed by `where`.
 *
 * `undefined` and `null` are both "not set at this level", which is legitimate
 * and means the next level down applies — so they produce no errors. An empty
 * array is also legitimate: it means "no warm-up here", and it is the only way to
 * stop an inherited ladder applying.
 */
export function warmupLadderErrors(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    return [`${where} must be an array of rungs, or omitted to inherit, or [] for no warm-up here.`];
  }
  if (value.length === 0) return [];

  const errors: string[] = [];
  if (value.length < MIN_RUNGS) {
    errors.push(
      `${where} needs at least ${MIN_RUNGS} rungs — one below target, then target. ` +
      `A single rung would have to be 100%, which is a pass count at tempo rather than a ramp.`,
    );
  }
  if (value.length > MAX_RUNGS) {
    errors.push(`${where} can have at most ${MAX_RUNGS} rungs, got ${value.length}.`);
  }

  let previous: number | null = null;
  value.forEach((raw, i) => {
    const rung = (raw ?? {}) as Row;
    const rw = `${where}[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`${rw} must be an object with ${RUNG_KEYS.join(", ")}.`);
      return;
    }
    // Unknown keys are rejected rather than ignored: a rung written with
    // "target_pass" would otherwise be accepted and then silently do nothing.
    for (const k of Object.keys(rung)) {
      if (!RUNG_KEYS.includes(k)) errors.push(`${rw} has an unknown key \`${k}\`; expected ${RUNG_KEYS.join(", ")}.`);
    }
    for (const k of ["target_percent", "target_passes", "consecutive"]) {
      if (!(k in rung)) errors.push(`${rw} is missing \`${k}\`.`);
    }
    if (!("accuracy_target" in rung)) {
      errors.push(`${rw} is missing \`accuracy_target\`; use null to take the item's own accuracy target.`);
    }

    const pct = rung.target_percent;
    if (!isWhole(pct)) {
      errors.push(`${rw}.target_percent must be a whole number.`);
    } else if (pct < 10 || pct > TARGET_PERCENT) {
      errors.push(`${rw}.target_percent must be between 10 and ${TARGET_PERCENT}, got ${pct}.`);
    } else {
      if (previous !== null && pct <= previous) {
        errors.push(`${rw}.target_percent (${pct}) must be higher than the rung above it (${previous}).`);
      }
      previous = pct as number;
    }

    if (!isWhole(rung.target_passes) || (rung.target_passes as number) < 1) {
      errors.push(`${rw}.target_passes must be a whole number of 1 or more.`);
    }
    if (rung.accuracy_target !== null && rung.accuracy_target !== undefined) {
      const a = rung.accuracy_target;
      if (!isWhole(a) || (a as number) < 1 || (a as number) > 100) {
        errors.push(`${rw}.accuracy_target must be null, or a whole number from 1 to 100.`);
      }
    }
    if (typeof rung.consecutive !== "boolean") {
      errors.push(`${rw}.consecutive must be true or false.`);
    }
  });

  const last = (value[value.length - 1] ?? {}) as Row;
  if (isWhole(last.target_percent) && last.target_percent !== TARGET_PERCENT) {
    errors.push(
      `${where}: the last rung must be ${TARGET_PERCENT}% — that is the target tempo, and finishing it ` +
      `is what finishing the ladder means. Got ${last.target_percent}%.`,
    );
  }
  return errors;
}

/** "70% → 85% → 100%", for a proposal a human has to read. */
export function ladderSummary(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "none";
  return value.map((r) => `${(r as Row)?.target_percent}%`).join(" → ");
}

/**
 * The ladder a range will ACTUALLY run, by the player's own order (§4): the plan
 * item's, then the snippet's, then the song's, then the app default.
 *
 * `null` at a level means fall through; `[]` does NOT — it means "no warm-up here"
 * and stops the chain, which is why this cannot be a simple `??` over three values
 * and why the result can legitimately be an empty array.
 *
 * The app default is read from the database (`sam_default_warmup_ladder`) rather
 * than copied, so there is one definition of it. A failure to read it is treated as
 * "no default", which makes `goal_is_warmup` fail closed rather than pass on a
 * ladder nobody has seen.
 */
export async function resolveLadder(
  // deno-lint-ignore no-explicit-any
  db: { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: any }> },
  levels: { item?: unknown; snippet?: unknown; song?: unknown },
): Promise<{ ladder: unknown[] | null; source: "item" | "snippet" | "song" | "default" | null }> {
  for (const [source, value] of [
    ["item", levels.item],
    ["snippet", levels.snippet],
    ["song", levels.song],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) continue;
    return { ladder: value, source };
  }
  const { data, error } = await db.rpc("sam_default_warmup_ladder");
  if (error || !Array.isArray(data)) return { ladder: null, source: null };
  return { ladder: data, source: "default" };
}
