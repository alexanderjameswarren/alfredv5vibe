#!/usr/bin/env node
// Push a file (or standard input) into Alfred as a CLI clip.
//
// This is the Claude CLI's half of the clipboard: instead of Alex reading a wall
// of terminal output and deciding what mattered, the report goes into Alfred and
// he can say "CLI responded" in any claude.ai conversation.
//
// Usage:
//   node scripts/clip.mjs --title "Clipboard Step 7" .clip/last-report.md
//   some-command | node scripts/clip.mjs --title "Test run"
//
// Exits 0 on success, non-zero on failure, and prints the new clip id and inbox
// id so a caller can quote them.
//
// ---------------------------------------------------------------------------
// 🛑 THE SECRET IS NEVER PRINTED, NOT EVEN ON FAILURE
// ---------------------------------------------------------------------------
//
// Every error path below reports the NAME of what was missing or wrong and, at
// most, a length. The value never reaches stdout, stderr, an error message, or a
// process argument — which is also why it is read from the environment rather
// than passed as a flag: anything on a command line is visible in the process
// list and in shell history.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const MIN_SECRET_LENGTH = 32;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Read a Windows USER environment variable straight from the registry.
 *
 * ⚠️ WHY THIS FALLBACK EXISTS. `setx` writes to the registry, but a shell that
 * was already open keeps the environment it started with — so right after
 * setting these, every existing terminal (and every tool spawned from one,
 * including the Claude CLI) still sees nothing. That looks exactly like "the
 * variables are not set" and sends you back to set them again.
 *
 * Reading the registry directly gets the value the machine actually holds.
 * Returns null on any failure: this is a convenience, not a requirement, and a
 * missing PowerShell is not worth a stack trace.
 */
function fromWindowsUserEnv(name) {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 },
    );
    const value = out.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function setting(name) {
  const fromEnv = (process.env[name] || "").trim();
  if (fromEnv) return { value: fromEnv, source: "environment" };
  const fromRegistry = fromWindowsUserEnv(name);
  if (fromRegistry) return { value: fromRegistry, source: "Windows user registry" };
  return { value: null, source: null };
}

function loadSettings() {
  const url = setting("CLIPBOARD_URL");
  const secret = setting("CLIPBOARD_SECRET");

  const missing = [];
  if (!url.value) missing.push("CLIPBOARD_URL");
  if (!secret.value) missing.push("CLIPBOARD_SECRET");

  if (missing.length) {
    fail(
      `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.\n\n` +
        `Checked the environment and, on Windows, the user registry.\n\n` +
        `Set them once per machine:\n` +
        `  setx CLIPBOARD_URL "https://<project>.supabase.co/functions/v1/clip-capture"\n` +
        `  setx CLIPBOARD_SECRET "<the CLIPBOARD_SECRET value>"\n\n` +
        `A shell opened before setx keeps its old environment, which is why this\n` +
        `script also reads the registry — but a brand-new shell is still the\n` +
        `simplest fix if something looks stale.`,
    );
  }

  // Mirrors the check the edge function makes, so a too-short secret is refused
  // here with a sentence rather than arriving as a 500. Length only; no value.
  if (secret.value.length < MIN_SECRET_LENGTH) {
    fail(
      `CLIPBOARD_SECRET is ${secret.value.length} characters; the server requires at ` +
        `least ${MIN_SECRET_LENGTH} and would refuse this. Re-copy it — the value itself is ` +
        `not shown here by design.`,
    );
  }

  return {
    baseUrl: url.value.replace(/\/+$/, ""),
    secret: secret.value,
    urlSource: url.source,
    secretSource: secret.source,
  };
}

// ---------------------------------------------------------------------------
// Arguments and input
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`\nclip.mjs: ${message}\n`);
  process.exit(1);
}

const USAGE = `
Push a report into Alfred as a CLI clip.

  node scripts/clip.mjs --title "What this is" <file>
  <command> | node scripts/clip.mjs --title "What this is"

  --title, -t   What to call it in the inbox. Optional but strongly preferred:
                without it the first markdown heading, then the file name, then
                "CLI report" are tried in that order.
  --help, -h    This.

Reads CLIPBOARD_URL and CLIPBOARD_SECRET from the environment, falling back to
the Windows user registry when a shell predates setx.
`;

function parseArgs(argv) {
  const out = { title: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--title" || a === "-t") {
      out.title = argv[++i];
      if (out.title === undefined) fail("--title needs a value.");
    } else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (!a.startsWith("-") && out.file === null) {
      out.file = a;
    } else {
      fail(`unexpected argument: ${a}\n${USAGE}`);
    }
  }
  return out;
}

function readStdin() {
  try {
    // fd 0 straight through, so this works with a pipe and with a redirect.
    return readFileSync(0, "utf8");
  } catch (e) {
    fail(`could not read standard input: ${e.message}`);
  }
}

/** A title, from the flag, the first heading, the file name, or a last resort. */
function deriveTitle(explicit, text, file) {
  if (explicit && explicit.trim()) return explicit.trim().slice(0, 300);
  const heading = text.split("\n").find((l) => /^#{1,3}\s+\S/.test(l));
  if (heading) return heading.replace(/^#+\s+/, "").trim().slice(0, 300);
  if (file) return path.basename(file).replace(/\.[^.]+$/, "").slice(0, 300);
  return "CLI report";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSettings();

  const text = args.file ? readFileOrDie(args.file) : readStdin();
  if (!text.trim()) {
    fail(
      args.file
        ? `${args.file} is empty, so there is nothing to push.`
        : "standard input was empty, so there is nothing to push.",
    );
  }

  const title = deriveTitle(args.title, text, args.file);

  // A cli clip skips /start entirely: there are no slices to upload, so there is
  // nothing for an upload link to be for. /finish mints the id itself.
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-clipboard-secret": cfg.secret },
      body: JSON.stringify({
        source: "cli",
        title,
        page_text: text,
        links: [],
      }),
    });
  } catch (e) {
    fail(
      `could not reach ${cfg.baseUrl}/finish: ${e.message}\n\n` +
        `CLIPBOARD_URL came from the ${cfg.urlSource}. Check the address and that you are online.`,
    );
  }

  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* fall through to the raw text */ }

  if (!res.ok || json?.ok === false) {
    if (res.status === 401) {
      fail(
        `the server refused the secret (401).\n\n` +
          `CLIPBOARD_SECRET came from the ${cfg.secretSource} and is ` +
          `${cfg.secret.length} characters. It must match the value set with ` +
          `\`supabase secrets set CLIPBOARD_SECRET\` exactly. The value is not printed here.`,
      );
    }
    fail(`/finish failed (${res.status}): ${json?.error || body.slice(0, 400)}`);
  }
  if (!json?.clip_id) fail(`/finish returned no clip id: ${body.slice(0, 400)}`);

  const kb = (Buffer.byteLength(text, "utf8") / 1024).toFixed(1);
  console.log(`Pushed to Alfred as a CLI clip.`);
  console.log(`  title:    ${title}`);
  console.log(`  size:     ${kb} KB${json.text_truncated ? " (TRUNCATED at 1 MB)" : ""}`);
  console.log(`  clip id:  ${json.clip_id}`);
  console.log(`  inbox id: ${json.inbox_id}`);
}

function readFileOrDie(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    fail(`could not read ${path.resolve(file)}: ${e.message}`);
  }
}

main().catch((e) => fail(`unexpected error: ${e?.message || e}`));
