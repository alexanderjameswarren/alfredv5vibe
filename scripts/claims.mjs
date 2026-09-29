#!/usr/bin/env node
// Claims: who owns which file, folder and database item while several CLI
// threads work on this repo at once.
//
// Each thread runs in its own git worktree. Before it edits anything it claims
// the paths it will touch; a second thread that wants one of them is told who
// holds it and stops to ask Alex. Because no two threads ever edit the same
// file, merging a worktree back into main is always clean.
//
// This is the granting half. The enforcing half is the PreToolUse hook at
// .claude/hooks/claims-guard.mjs. Both sit on scripts/lib/claims-core.mjs so
// they cannot disagree about what a conflict is.
//
// Usage:
//   node scripts/claims.mjs status
//   node scripts/claims.mjs check src/Alfred.jsx db:deploy
//   node scripts/claims.mjs claim src/sam/ docs/progress-x.md --run-tag abc-s2 --note "step 2"
//   node scripts/claims.mjs reserve db:table:inbox --step "Step 3"
//   node scripts/claims.mjs release src/sam/
//   node scripts/claims.mjs release --all
//   node scripts/claims.mjs release --owner stale-thread --all
//
// Exit codes: 0 fine, 1 conflict or refusal, 2 bad usage or a broken claims file.
//
// ---------------------------------------------------------------------------
// WHERE THE FILE LIVES, AND WHY
// ---------------------------------------------------------------------------
//
// <git common dir>/alfred-claims.json — the MAIN repo's .git folder. Every
// worktree shares that one folder, so every thread on this machine reads and
// writes the same file, and git never tracks it, so it cannot end up in a
// commit or a merge conflict.
//
// It follows that claims coordinate threads on ONE COMPUTER. The desktop and
// the Surface do not see each other's claims. Known limit, not solved here.

import {
  ClaimsError,
  covers,
  fold,
  inspect,
  isDbItem,
  isExempt,
  isFolderItem,
  normaliseItem,
  readState,
  resolveRepo,
  withLock,
} from "./lib/claims-core.mjs";

// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

function describe(item, owner, state) {
  // Exempt paths are per-worktree or generated; claiming one would lock other
  // threads out of a file they do not actually share. See EXEMPT_PREFIXES.
  if (!isDbItem(item) && isExempt(item)) {
    return { status: "exempt", line: `exempt    ${item} — no claim needed` };
  }

  const { mine, theirs, reserved } = inspect(state, item, owner);
  const warn = reserved.length
    ? ` (also reserved by ${reserved.map((r) => `${r.owner} for ${r.step}`).join(", ")})`
    : "";

  if (theirs.length) {
    const who = theirs
      .map((c) => `${c.owner} holds ${c.item}${c.note ? ` — ${c.note}` : ""}`)
      .join("; ");
    return { status: "conflict", line: `CONFLICT  ${item} — ${who}${warn}` };
  }
  if (mine.length) {
    const via = mine.some((c) => fold(c.item) === fold(item))
      ? ""
      : ` (via ${mine[0].item})`;
    return { status: "yours", line: `yours     ${item}${via}${warn}` };
  }
  if (reserved.length) {
    return {
      status: "reserved",
      line: `warning   ${item} — reserved by ${reserved
        .map((r) => `${r.owner} for ${r.step}`)
        .join(", ")}`,
    };
  }
  return { status: "free", line: `free      ${item}` };
}

function age(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown age";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

const noteStale = (ms) =>
  process.stderr.write(
    `Removing a stale claims lock (${Math.round(ms / 1000)}s old).\n`,
  );

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function cmdStatus(ctx) {
  const state = readState(ctx.file);
  console.log(`Claims file: ${ctx.file}`);
  console.log(`This thread: ${ctx.owner}\n`);

  if (!state.claims.length && !state.reservations.length) {
    console.log("Nothing claimed and nothing reserved.");
    return 0;
  }

  const owners = [
    ...new Set([
      ...state.claims.map((c) => c.owner),
      ...state.reservations.map((r) => r.owner),
    ]),
  ].sort();

  for (const owner of owners) {
    console.log(owner === ctx.owner ? `${owner}  (this thread)` : owner);
    for (const c of state.claims.filter((x) => x.owner === owner)) {
      const bits = [age(c.claimed_at)];
      if (c.run_tag) bits.push(c.run_tag);
      if (c.note) bits.push(c.note);
      console.log(`  claim     ${c.item}  [${bits.join(", ")}]`);
    }
    for (const r of state.reservations.filter((x) => x.owner === owner)) {
      console.log(`  reserved  ${r.item}  [${r.step}, ${age(r.reserved_at)}]`);
    }
    console.log("");
  }
  return 0;
}

function cmdCheck(ctx, items) {
  if (!items.length) fail("check needs at least one item", 2);
  const state = readState(ctx.file);
  let conflicts = 0;

  for (const item of items) {
    const { status, line } = describe(item, ctx.owner, state);
    if (status === "conflict") conflicts += 1;
    console.log(line);
  }

  if (conflicts) {
    console.log(
      `\n${conflicts} conflict${conflicts === 1 ? "" : "s"}. Stop and ask Alex — do not edit these.`,
    );
    return 1;
  }
  console.log("\nNo conflicts.");
  return 0;
}

function cmdClaim(ctx, items, flags) {
  if (!items.length) fail("claim needs at least one item", 2);
  let exit = 0;

  withLock(
    ctx,
    (state) => {
      // All or nothing: claiming half of what a step needs is worse than
      // claiming none of it, because the thread would start work it cannot finish.
      const conflicts = items
        .map((item) => describe(item, ctx.owner, state))
        .filter((r) => r.status === "conflict");

      if (conflicts.length) {
        for (const c of conflicts) console.log(c.line);
        console.log(
          `\nClaimed nothing. ${conflicts.length} item${conflicts.length === 1 ? " is" : "s are"} held by another thread — stop and ask Alex.`,
        );
        exit = 1;
        return null;
      }

      const now = new Date().toISOString();
      const added = [];
      const consolidated = [];

      for (const item of items) {
        if (!isDbItem(item) && isExempt(item)) {
          console.log(`exempt    ${item} — no claim needed, skipped`);
          continue;
        }
        const { mine } = inspect(state, item, ctx.owner);
        if (mine.some((c) => fold(c.item) === fold(item) || covers(c.item, item))) {
          console.log(`already   ${item}`);
          continue;
        }
        // Claiming a folder absorbs this owner's own claims inside it.
        if (isFolderItem(item)) {
          for (const c of mine) {
            if (covers(item, c.item)) consolidated.push(c.item);
          }
          state.claims = state.claims.filter(
            (c) => !(c.owner === ctx.owner && covers(item, c.item)),
          );
        }
        state.claims.push({
          item,
          owner: ctx.owner,
          run_tag: flags.runTag ?? null,
          claimed_at: now,
          note: flags.note ?? null,
        });
        added.push(item);
      }

      for (const item of added) console.log(`claimed   ${item}`);
      if (consolidated.length) {
        console.log(`\nAbsorbed into the folder claim: ${consolidated.join(", ")}`);
      }
      console.log(`\n${added.length} claimed for ${ctx.owner}.`);
      return state;
    },
    { onStale: noteStale },
  );

  return exit;
}

function cmdReserve(ctx, items, flags) {
  if (items.length !== 1) fail("reserve takes exactly one item", 2);
  if (!flags.step) fail("reserve needs --step <step>", 2);

  withLock(
    ctx,
    (state) => {
      const [item] = items;
      state.reservations = state.reservations.filter(
        (r) => !(r.owner === ctx.owner && fold(r.item) === fold(item)),
      );
      state.reservations.push({
        item,
        owner: ctx.owner,
        step: flags.step,
        reserved_at: new Date().toISOString(),
      });
      console.log(`reserved  ${item} for ${ctx.owner} at ${flags.step}`);

      // A reservation never blocks, but the thread should still know what it is
      // walking into at that step.
      const { theirs } = inspect(state, item, ctx.owner);
      if (theirs.length) {
        console.log(
          `\nNote: ${theirs.map((c) => `${c.owner} holds ${c.item}`).join("; ")} right now.`,
        );
      }
      return state;
    },
    { onStale: noteStale },
  );

  return 0;
}

/**
 * Release this thread's own claims. Never another thread's.
 *
 * `--owner` is refused here on purpose. The guard hook asks Alex before any
 * `claim`, `reserve` or `cleanup`, and it decides which is which by reading the
 * command. If `release` still took `--owner`, then wiping another thread's
 * claims would look exactly like a thread tidying up after itself, and would go
 * through unasked. Cross-owner cleanup is the separate `cleanup` command.
 */
function cmdRelease(ctx, items, flags) {
  if (flags.owner) {
    fail(
      "release does not take --owner. To clear another thread's claims:\n" +
        "  node scripts/claims.mjs cleanup <owner>\n" +
        "That is a separate command because it needs Alex to approve it.",
      2,
    );
  }
  return releaseFor(ctx, ctx.owner, items, flags);
}

/** Clear out everything a named thread holds. Manual cleanup of a dead thread. */
function cmdCleanup(ctx, items, flags) {
  // The owner to clear is the positional argument, never --owner: one name in
  // one place, so `cleanup ghost` cannot quietly clear something else.
  if (flags.owner) {
    fail("cleanup does not take --owner. Name the owner directly: cleanup <owner>", 2);
  }
  const target = items[0];
  if (!target || items.length > 1) {
    fail("cleanup takes exactly one owner name: cleanup <owner>", 2);
  }

  // A typo must not read as success. The claims file holds only what is claimed
  // now, so "never existed" and "released everything already" look identical —
  // but printing the owners that DO hold something makes a misspelling obvious
  // at a glance, which is what this is for.
  const state = readState(ctx.file);
  const owners = [
    ...new Set([
      ...state.claims.map((c) => c.owner),
      ...state.reservations.map((r) => r.owner),
    ]),
  ].sort();

  if (!owners.includes(target)) {
    console.log(`No owner called "${target}" holds anything. Nothing removed.`);
    if (owners.length) {
      console.log(`\nOwners with records right now: ${owners.join(", ")}`);
      const near = owners.filter(
        (o) => fold(o).includes(fold(target)) || fold(target).includes(fold(o)),
      );
      if (near.length) console.log(`Did you mean: ${near.join(", ")}?`);
    } else {
      console.log("\nThe claims file is empty — no thread holds anything.");
    }
    return 1;
  }

  if (target === ctx.owner) {
    console.log(`${target} is this thread — 'release --all' does the same thing.`);
  }
  return releaseFor(ctx, target, [], { all: true });
}

function releaseFor(ctx, target, items, flags) {
  if (!flags.all && !items.length) fail("release needs items, or --all", 2);
  if (flags.all && items.length) fail("release takes items or --all, not both", 2);

  withLock(
    ctx,
    (state) => {
      const before = state.claims.length + state.reservations.length;
      const removed = [];

      if (flags.all) {
        for (const c of state.claims) {
          if (c.owner === target) removed.push(`claim ${c.item}`);
        }
        for (const r of state.reservations) {
          if (r.owner === target) removed.push(`reservation ${r.item}`);
        }
        state.claims = state.claims.filter((c) => c.owner !== target);
        state.reservations = state.reservations.filter((r) => r.owner !== target);
      } else {
        for (const item of items) {
          const hit = state.claims.some(
            (c) => c.owner === target && fold(c.item) === fold(item),
          );
          const held = state.reservations.some(
            (r) => r.owner === target && fold(r.item) === fold(item),
          );
          if (!hit && !held) {
            console.log(`not held  ${item} (by ${target})`);
            continue;
          }
          if (hit) removed.push(`claim ${item}`);
          if (held) removed.push(`reservation ${item}`);
          state.claims = state.claims.filter(
            (c) => !(c.owner === target && fold(c.item) === fold(item)),
          );
          state.reservations = state.reservations.filter(
            (r) => !(r.owner === target && fold(r.item) === fold(item)),
          );
        }
      }

      for (const line of removed) console.log(`released  ${line}`);
      const after = state.claims.length + state.reservations.length;
      console.log(`\nReleased ${before - after} record(s) for ${target}.`);
      return state;
    },
    { onStale: noteStale },
  );

  return 0;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node scripts/claims.mjs status
  node scripts/claims.mjs check <items...>
  node scripts/claims.mjs claim <items...> [--run-tag <tag>] [--note <text>]
  node scripts/claims.mjs reserve <item> --step <step>
  node scripts/claims.mjs release <items...>
  node scripts/claims.mjs release --all
  node scripts/claims.mjs cleanup <owner>

Items are repo-relative paths, folders ending in /, or db:table:<name>,
db:fn:<name>, db:deploy. --owner <name> overrides the detected worktree name
for status, check, claim and reserve; release never takes it.

status, check and release run without interrupting Alex.

claim, reserve and cleanup raise Claude Code's permission prompt. That prompt is
a BACKSTOP, not Alex's approval. Claim a file he named; for one he did not,
stop and ask him first — see .claude/CLAUDE.md.

A THREAD NEVER RELEASES ITS OWN FILE CLAIMS. gitpush does that, once the work is
merged and pushed. A file claim is held for the whole life of the thread, not for
as long as you have the file open. Database claims (db:table, db:fn, db:deploy)
are the exception: claim them at the step that needs them, release them once Alex
has checkpointed that step into main.`;

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = (name) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} needs a value`, 2);
      i += 1;
      flags[name] = value;
    };
    switch (arg) {
      case "--all": flags.all = true; break;
      case "--owner": take("owner"); break;
      case "--run-tag": take("runTag"); break;
      case "--note": take("note"); break;
      case "--step": take("step"); break;
      case "-h":
      case "--help": flags.help = true; break;
      default:
        if (arg.startsWith("--")) fail(`unknown option: ${arg}\n\n${USAGE}`, 2);
        rest.push(arg);
    }
  }
  return { flags, rest };
}

function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const [command, ...rawItems] = rest;

  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!command) fail(USAGE, 2);

  const commands = {
    status: cmdStatus,
    check: cmdCheck,
    claim: cmdClaim,
    reserve: cmdReserve,
    release: cmdRelease,
    cleanup: cmdCleanup,
  };
  const handler = commands[command];
  if (!handler) fail(`unknown command: ${command}\n\n${USAGE}`, 2);

  try {
    const ctx = resolveRepo();
    if (flags.owner) ctx.owner = flags.owner;
    // cleanup's argument is an owner name, not a path — do not normalise it.
    const items =
      command === "cleanup"
        ? rawItems
        : rawItems.map((raw) => normaliseItem(raw, ctx.root));
    process.exit(handler(ctx, items, flags));
  } catch (err) {
    if (err instanceof ClaimsError) {
      const hint =
        err.code === "unreadable"
          ? "\nFix or delete it by hand — this script will not overwrite it."
          : "";
      fail(`${err.message}${hint}`, 2);
    }
    throw err;
  }
}

main();
