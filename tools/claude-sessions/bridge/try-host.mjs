#!/usr/bin/env node
// Hand check for the bridge host, no Chrome needed: starts host.bat as Chrome would,
// sends one fake tab list and chat list, drops a focus command, and prints what the
// host sent back. Writes to the real bridge folder unless SWITCHBOARD_BRIDGE_DIR is set.
//   node tools/claude-sessions/bridge/try-host.mjs

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeDir, createDecoder, encode } from "./host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/";
const dir = bridgeDir();
const host = process.platform === "win32"
  ? spawn("cmd.exe", ["/d", "/s", "/c", `"${path.join(HERE, "host.bat")}" ${ORIGIN}`], { windowsVerbatimArguments: true })
  : spawn(process.execPath, [path.join(HERE, "host.mjs"), ORIGIN]);
const decode = createDecoder();
host.stdout.on("data", (c) => decode(c).forEach((m) => console.log("host sent:", JSON.stringify(m))));

host.stdin.write(encode({ type: "tabs", tabs: [
  { tabId: 101, windowId: 1, index: 0, active: true, windowFocused: true, title: "try-host chat - Claude", url: "https://claude.ai/chat/try-host", discarded: false },
  { tabId: 102, windowId: 2, index: 3, active: false, windowFocused: false, title: "Some other page", url: "https://example.com/", discarded: false },
] }));
host.stdin.write(encode({ type: "chats", chats: [
  { tabId: 101, windowId: 1, url: "https://claude.ai/chat/try-host", title: "try-host chat", state: "finished",
    since: new Date().toISOString(), issuedTag: "switchboard_bridge-p8v-s5-k3hd", composerEmpty: true, viewedAt: null,
    text: "this field must not reach the file" },
] }));
setTimeout(() => writeFileSync(path.join(dir, "command.json"), JSON.stringify({ id: "try1", action: "focus", tabId: 102 })), 300);
setTimeout(() => host.stdin.end(), 1500);
host.on("exit", (code) => {
  console.log(`host exited ${code}. Bridge folder: ${dir}`);
});
