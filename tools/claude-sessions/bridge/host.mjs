#!/usr/bin/env node
// Switchboard bridge: Chrome native messaging host for the Alfred Clipboard
// extension. Spec: docs/history/technical-spec-switchboard_bridge.md, section 1.
//
// It does three things only: writes the extension's tab and chat lists to the
// bridge folder, forwards focus / sendcli commands the panel leaves in
// command.json, and writes a Send link's checked prompt to prompt-<project>.json.
// Its hello carries Alfred's link hosts, read from the panel's settings.ini. It never runs a program. stdout carries protocol frames and
// nothing else, so every diagnostic goes to host.log.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HOST_NAME = "com.alfred.switchboard";
const LOG_MAX_BYTES = 256 * 1024;
const POLL_MS = 500;
const TAG_SHAPE = /^[a-z0-9_]+-[a-z0-9]+-s\d+[a-z]?-[a-z0-9]{4}$/;

export function bridgeDir(env = process.env) {
  if (env.SWITCHBOARD_BRIDGE_DIR) return path.resolve(env.SWITCHBOARD_BRIDGE_DIR);
  const base = env.LOCALAPPDATA || path.join(env.USERPROFILE || ".", "AppData", "Local");
  return path.join(base, "claude-sessions", "bridge");
}

/** `chrome-extension://<id>/` (Chrome's first argument on Windows) to its id, or null. */
export function extensionIdOf(origin) {
  const m = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(String(origin ?? ""));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Framing: 4-byte little-endian length, then UTF-8 JSON
// ---------------------------------------------------------------------------

export function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Feed it chunks; it returns the whole messages each chunk completes. Bad JSON is skipped. */
export function createDecoder() {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const out = [];
    while (pending.length >= 4) {
      const len = pending.readUInt32LE(0);
      if (pending.length < 4 + len) break;
      const body = pending.subarray(4, 4 + len).toString("utf8");
      pending = pending.subarray(4 + len);
      try {
        out.push(JSON.parse(body));
      } catch {
        out.push({ type: "__bad_json__" });
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, text, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 3) {
        try { unlinkSync(tmp); } catch { /* gone */ }
        throw err;
      }
      pause(10);
    }
  }
}

export function makeLogger(dir) {
  return (line) => {
    try {
      const file = path.join(dir, "host.log");
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(file).size > LOG_MAX_BYTES) writeFileSync(file, "", "utf8");
      } catch { /* no log yet */ }
      appendFileSync(file, `${new Date().toISOString()}  ${process.pid}  ${line}\n`, "utf8");
    } catch {
      // Logging is never a reason to fail.
    }
  };
}

// ---------------------------------------------------------------------------
// Sanitising: only known fields, of known types, reach a file
// ---------------------------------------------------------------------------

const int = (v) => (Number.isInteger(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);

export function cleanTab(t = {}) {
  return {
    tabId: int(t.tabId), windowId: int(t.windowId), index: int(t.index),
    active: bool(t.active), windowFocused: bool(t.windowFocused),
    title: str(t.title, 500), url: str(t.url, 2048), discarded: bool(t.discarded),
  };
}

export function cleanChat(c = {}) {
  return {
    tabId: int(c.tabId), windowId: int(c.windowId), url: str(c.url, 2048), title: str(c.title, 500),
    state: ["responding", "finished", "unknown"].includes(c.state) ? c.state : "unknown",
    since: str(c.since, 40),
    issuedTag: typeof c.issuedTag === "string" && TAG_SHAPE.test(c.issuedTag) ? c.issuedTag : null,
    composerEmpty: bool(c.composerEmpty),
    viewedAt: str(c.viewedAt, 40),
  };
}

export function cleanResult(r = {}) {
  return {
    id: str(r.id, 64), ok: r.ok === true, windowTitle: str(r.windowTitle, 500),
    did: ["sent", "typed", "focused"].includes(r.did) ? r.did : null,
    error: str(r.error, 500),
  };
}

// ---------------------------------------------------------------------------
// Send to CLI (switchboard2-h8r 1.1-1.2): prompt-<project>.json for the panel
// ---------------------------------------------------------------------------

const PROMPT_MAX = 64 * 1024;
const HOST_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;

/** A file's text by its BOM: AutoHotkey's IniWrite creates settings.ini as UTF-16 LE. */
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  return buf.toString("utf8").replace(/^﻿/, "");
}

/**
 * Alfred's hosts for Send links: `[links] hosts=` in the panel's settings.ini
 * (the same SWITCHBOARD_SETTINGS_DIR the panel honours). Never in code (spec §2, rule 8).
 */
export function readLinkHosts(env = process.env) {
  const dir = env.SWITCHBOARD_SETTINGS_DIR || path.join(env.APPDATA || ".", "claude-sessions");
  let text;
  try {
    text = decodeText(readFileSync(path.join(dir, "settings.ini")));
  } catch {
    return [];
  }
  let section = "", value = "";
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (head) section = head[1].trim().toLowerCase();
    else if (section === "links") value = /^\s*hosts\s*=(.*)$/i.exec(line)?.[1] ?? value;
  }
  return value.split(",").map((h) => h.trim().toLowerCase()).filter((h) => HOST_SHAPE.test(h));
}
const projectOfTag = (tag) => (TAG_SHAPE.test(tag) ? tag.replace(/-s\d+[a-z]?-[a-z0-9]{4}$/, "") : null);
export const promptFile = (dir, project) => path.join(dir, `prompt-${project}.json`);

function readSent(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "sent.json"), "utf8")) ?? {};
  } catch {
    return {};
  }
}

/** Why this prompt may not be written, or null. Its project is its tag's. */
function promptProblem(dir, tag, text) {
  const project = projectOfTag(tag);
  if (!project) return "the prompt has no valid run tag";
  if (text.length > PROMPT_MAX) return "the prompt is over 64 KB";
  const lines = text.split("\n");
  if (lines[0] !== `Run tag: ${tag}` || lines.at(-1) !== `Run tag: ${tag}`) return "the prompt does not start with its Run tag line and end with it";
  if (readSent(dir)[project] === tag) return `${tag} was already sent`;
  try {
    statSync(promptFile(dir, project));
    return `a prompt for ${project} is waiting to be delivered`;
  } catch { /* none waiting */ }
  return null;
}

/**
 * A `prompt` frame from a Send link: write the prompt for the panel and record its
 * tag, or refuse. Returns the outcome for prompt-result.json, which never holds the text.
 */
function acceptPrompt(msg, { dir, now }) {
  const id = str(msg.id, 64);
  const tag = typeof msg.tag === "string" && TAG_SHAPE.test(msg.tag) ? msg.tag : null;
  const project = tag ? projectOfTag(tag) : null;
  const text = typeof msg.text === "string" ? msg.text : "";
  const problem = typeof msg.error === "string" ? msg.error.slice(0, 500) : promptProblem(dir, tag ?? "", text);
  const outcome = { id, ok: !problem, tag, project, error: problem ?? null };
  if (problem) return outcome;
  writeAtomic(promptFile(dir, project), `${JSON.stringify({ at: now.toISOString(), id, project, tag, text }, null, 2)}\n`);
  writeAtomic(path.join(dir, "sent.json"), `${JSON.stringify({ ...readSent(dir), [project]: tag }, null, 2)}\n`);
  return outcome;
}

/** Write the file a message from the extension calls for. Returns the file name, or null. */
export function handleMessage(msg, { dir, origin, now = new Date(), log = () => {} }) {
  const stamp = { at: now.toISOString(), origin: origin ?? null, extension_id: extensionIdOf(origin) };
  let name = null, body = null;
  if (msg?.type === "prompt") {
    // Its own file: a prompt outcome must never overwrite a focus reply the panel is waiting on.
    name = "prompt-result.json"; body = { ...stamp, ...acceptPrompt(msg, { dir, now }) };
    log(`prompt ${body.ok ? `written for ${body.tag}` : `refused: ${body.error}`}`);
  } else if (msg?.type === "tabs" && Array.isArray(msg.tabs)) {
    name = "tabs.json"; body = { ...stamp, tabs: msg.tabs.map(cleanTab) };
  } else if (msg?.type === "chats" && Array.isArray(msg.chats)) {
    name = "chats.json"; body = { ...stamp, chats: msg.chats.map(cleanChat) };
  } else if (msg?.type === "result") {
    name = "result.json"; body = { ...stamp, ...cleanResult(msg) };
  } else {
    log(`ignored message type=${String(msg?.type).slice(0, 40)}`);
    return null;
  }
  writeAtomic(path.join(dir, name), `${JSON.stringify(body, null, 2)}\n`);
  return name;
}

// ---------------------------------------------------------------------------
// Commands from the panel
// ---------------------------------------------------------------------------

/** The frame to forward for a command file's content, or null. Nothing else in it travels. */
export function commandToForward(cmd) {
  if (!cmd || typeof cmd.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(cmd.id)) return null;
  if (cmd.action !== "focus" && cmd.action !== "sendcli") return null;
  const out = { type: "command", id: cmd.id, action: cmd.action };
  if (Number.isInteger(cmd.tabId)) out.tabId = cmd.tabId;
  else if (typeof cmd.url === "string" && /^https?:\/\/\S{1,2040}$/.test(cmd.url)) out.url = cmd.url;
  else return null;
  if (cmd.action === "focus" && cmd.composer === true) out.composer = true;
  return out;
}

/** Read command.json once: forward a new, valid command, then delete the file. */
export function takeCommand(dir, state, send, log = () => {}) {
  const file = path.join(dir, "command.json");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let cmd = null;
  try {
    cmd = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null; // mid-write: next poll
  }
  try { unlinkSync(file); } catch { /* the panel may hold it; next poll */ }
  const frame = commandToForward(cmd);
  if (!frame) {
    log("refused command file");
    return null;
  }
  if (frame.id === state.lastId) return null;
  state.lastId = frame.id;
  send(frame);
  log(`forwarded ${frame.action} id=${frame.id}`);
  return frame;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const dir = bridgeDir();
  const log = makeLogger(dir);
  // Nothing may reach stdout except frames, whatever some code path tries.
  for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => log(a.join(" "));

  const origin = process.argv.slice(2).find((a) => a.startsWith("chrome-extension://")) ?? null;
  const send = (msg) => process.stdout.write(encode(msg));
  const decode = createDecoder();
  const state = { lastId: null };
  log(`start origin=${origin}`);

  process.stdin.on("data", (chunk) => {
    for (const msg of decode(chunk)) {
      try {
        handleMessage(msg, { dir, origin, log });
      } catch (e) {
        log(`write failed: ${e.message}`);
      }
    }
  });
  process.stdin.on("end", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });

  mkdirSync(dir, { recursive: true });
  const check = () => {
    try { takeCommand(dir, state, send, log); } catch (e) { log(`command failed: ${e.message}`); }
  };
  try {
    watch(dir, (_, name) => { if (name === "command.json") check(); });
  } catch (e) {
    log(`watch unavailable: ${e.message}`);
  }
  setInterval(check, POLL_MS);
  const linkHosts = readLinkHosts();
  log(`link hosts: ${linkHosts.join(", ") || "(none: Send links will open Alfred's page)"}`);
  send({ type: "hello", host: HOST_NAME, linkHosts });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
