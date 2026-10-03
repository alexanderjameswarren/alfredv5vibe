#!/usr/bin/env node
// Hand check for the focus command: drops a command for one tab, waits for the
// extension's reply in result.json, and prints it.
//   node tools/claude-sessions/bridge/focus-tab.mjs <tabId>
//   node tools/claude-sessions/bridge/focus-tab.mjs --url https://claude.ai/chat/<id>
// Add --sendcli to send a Send cli command instead (the watcher decides: sent, typed or focused).

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { bridgeDir, writeAtomic } from "./host.mjs";

const WAIT_MS = 5000;
const argv = process.argv.slice(2);
const sendcli = argv.includes("--sendcli");
const [first, second] = argv.filter((a) => a !== "--sendcli");
const cmd = { id: `hand-${Date.now().toString(36)}`, action: sendcli ? "sendcli" : "focus" };
if (first === "--url" && second) cmd.url = second;
else if (/^\d+$/.test(first ?? "")) cmd.tabId = Number(first);
else {
  console.error("Usage: focus-tab.mjs <tabId> [--sendcli]   or   focus-tab.mjs --url <address> [--sendcli]");
  process.exit(2);
}

const dir = bridgeDir();
const commandFile = path.join(dir, "command.json");
const resultFile = path.join(dir, "result.json");
writeAtomic(commandFile, JSON.stringify(cmd));
console.log(`sent:  ${JSON.stringify(cmd)}`);

const deadline = Date.now() + WAIT_MS;
const timer = setInterval(() => {
  let reply = null;
  try {
    reply = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch { /* not there yet */ }
  if (reply?.id === cmd.id) {
    clearInterval(timer);
    console.log(`reply: ${JSON.stringify(reply, null, 2)}`);
    process.exit(reply.ok ? 0 : 1);
  }
  if (Date.now() > deadline) {
    clearInterval(timer);
    const unread = existsSync(commandFile);
    if (unread) try { unlinkSync(commandFile); } catch { /* host took it */ }
    console.log(unread
      ? "no reply in 5 s, and the host never picked the command up: is the test copy of the extension switched on?"
      : "no reply in 5 s: the host took the command but the extension did not answer.");
    process.exit(1);
  }
}, 100);
