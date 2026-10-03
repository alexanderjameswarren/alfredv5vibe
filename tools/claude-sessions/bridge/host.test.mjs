import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bridgeDir, cleanChat, commandToForward, createDecoder, encode, extensionIdOf, handleMessage, takeCommand,
} from "./host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${ID}/`;
const scratch = () => mkdtempSync(path.join(tmpdir(), "bridge-test-"));
const read = (dir, name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

test("frames round-trip, split and joined", () => {
  const decode = createDecoder();
  const both = Buffer.concat([encode({ a: 1 }), encode({ b: "é" })]);
  assert.deepEqual(decode(both.subarray(0, 5)), []);
  assert.deepEqual(decode(both.subarray(5)), [{ a: 1 }, { b: "é" }]);
});

test("bridge folder and extension id", () => {
  assert.equal(bridgeDir({ LOCALAPPDATA: "C:\\L" }), path.join("C:\\L", "claude-sessions", "bridge"));
  assert.equal(bridgeDir({ SWITCHBOARD_BRIDGE_DIR: "C:\\x", LOCALAPPDATA: "C:\\L" }), path.resolve("C:\\x"));
  assert.equal(extensionIdOf(ORIGIN), ID);
  assert.equal(extensionIdOf("https://evil/"), null);
});

test("tabs and chats are written whole, stamped, and stripped to known fields", () => {
  const dir = scratch();
  const now = new Date("2026-10-02T10:00:00.000Z");
  handleMessage({ type: "tabs", tabs: [{ tabId: 1, windowId: 2, title: "t", url: "https://x/", body: "secret" }] },
    { dir, origin: ORIGIN, now });
  const tabs = read(dir, "tabs.json");
  assert.equal(tabs.at, "2026-10-02T10:00:00.000Z");
  assert.equal(tabs.extension_id, ID);
  assert.equal(tabs.tabs[0].tabId, 1);
  assert.equal("body" in tabs.tabs[0], false);

  handleMessage({ type: "chats", chats: [{ url: "https://claude.ai/chat/1", state: "responding", text: "hi",
    issuedTag: "proj-abc-s3-ab12" }] }, { dir, origin: ORIGIN, now });
  const chat = read(dir, "chats.json").chats[0];
  assert.equal(chat.state, "responding");
  assert.equal(chat.issuedTag, "proj-abc-s3-ab12");
  assert.equal("text" in chat, false);
  assert.deepEqual(readdirSync(dir).sort(), ["chats.json", "tabs.json"]);
});

test("a chat carries only its nine known fields", () => {
  assert.deepEqual(Object.keys(cleanChat({ latestFound: true, codeBlocks: 1, text: "x" })).sort(),
    ["composerEmpty", "issuedTag", "since", "state", "tabId", "title", "url", "viewedAt", "windowId"]);
});

test("a chat's bad state is unknown and a non-tag is dropped", () => {
  const c = cleanChat({ state: "done", issuedTag: "Run tag: proj-abc-s3-ab12 and more" });
  assert.equal(c.state, "unknown");
  assert.equal(c.issuedTag, null);
});

test("a reply is written to result.json", () => {
  const dir = scratch();
  handleMessage({ type: "result", id: "c9", ok: false, error: "no tab with id 99", extra: "x" }, { dir, origin: ORIGIN });
  const r = read(dir, "result.json");
  assert.equal(r.id, "c9");
  assert.equal(r.ok, false);
  assert.equal(r.error, "no tab with id 99");
  assert.equal("extra" in r, false);
});

test("unknown message types write nothing", () => {
  const dir = scratch();
  assert.equal(handleMessage({ type: "exec", cmd: "calc" }, { dir, origin: ORIGIN }), null);
  assert.deepEqual(readdirSync(dir), []);
});

test("only focus and sendcli are forwarded, with nothing extra", () => {
  assert.deepEqual(commandToForward({ id: "c1", action: "focus", tabId: 7, run: "calc" }),
    { type: "command", id: "c1", action: "focus", tabId: 7 });
  assert.deepEqual(commandToForward({ id: "c2", action: "sendcli", url: "https://claude.ai/chat/1" }),
    { type: "command", id: "c2", action: "sendcli", url: "https://claude.ai/chat/1" });
  assert.deepEqual(commandToForward({ id: "c5", action: "focus", tabId: 7, composer: true }),
    { type: "command", id: "c5", action: "focus", tabId: 7, composer: true });
  assert.equal("composer" in commandToForward({ id: "c6", action: "focus", tabId: 7, composer: "yes" }), false);
  assert.equal(commandToForward({ id: "c3", action: "run", tabId: 1 }), null);
  assert.equal(commandToForward({ id: "c4", action: "focus", url: "file:///c:/x" }), null);
  assert.equal(commandToForward({ id: "bad id!", action: "focus", tabId: 1 }), null);
});

test("a command file is forwarded once and deleted", () => {
  const dir = scratch();
  const sent = [], state = { lastId: null };
  const put = (o) => writeFileSync(path.join(dir, "command.json"), JSON.stringify(o));
  put({ id: "a1", action: "focus", tabId: 3 });
  takeCommand(dir, state, (m) => sent.push(m));
  assert.equal(existsSync(path.join(dir, "command.json")), false);
  put({ id: "a1", action: "focus", tabId: 3 });
  takeCommand(dir, state, (m) => sent.push(m));
  put({ id: "a2", action: "shell", tabId: 3 });
  takeCommand(dir, state, (m) => sent.push(m));
  assert.deepEqual(sent.map((m) => m.id), ["a1"]);
});

// The real process: through host.bat on Windows, so the launcher is proved silent too.
function startHost(dir) {
  const env = { ...process.env, SWITCHBOARD_BRIDGE_DIR: dir };
  return process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", `"${path.join(HERE, "host.bat")}" ${ORIGIN} --parent-window=0`], { env, windowsVerbatimArguments: true })
    : spawn(process.execPath, [path.join(HERE, "host.mjs"), ORIGIN], { env });
}

test("the host process speaks only frames, forwards a command, and exits on EOF", async () => {
  const dir = scratch();
  const host = startHost(dir);
  const out = [];
  host.stdout.on("data", (c) => out.push(c));
  const exited = new Promise((r) => host.on("exit", r));

  host.stdin.write(encode({ type: "tabs", tabs: [{ tabId: 5, windowId: 1, title: "A", url: "https://claude.ai/chat/1" }] }));
  writeFileSync(path.join(dir, "command.json"), JSON.stringify({ id: "e2e", action: "focus", tabId: 5 }));
  const forwarded = () => Buffer.concat(out).includes('"type":"command"');
  for (let i = 0; i < 40 && !(existsSync(path.join(dir, "tabs.json")) && forwarded()); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  host.stdin.end();
  assert.equal(await exited, 0);

  const frames = createDecoder()(Buffer.concat(out));
  const raw = Buffer.concat(out);
  let used = 0;
  for (const f of frames) used += 4 + Buffer.byteLength(JSON.stringify(f));
  assert.equal(used, raw.length, "stdout held something other than frames");
  assert.equal(frames[0].type, "hello");
  assert.deepEqual(frames.find((f) => f.type === "command"), { type: "command", id: "e2e", action: "focus", tabId: 5 });
  assert.equal(read(dir, "tabs.json").extension_id, ID);
});

test("install.ps1 dry run builds the manifest and refuses a bad id", { skip: process.platform !== "win32" }, () => {
  const ps = (args) => spawnSync("powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "install.ps1"), ...args], { encoding: "utf8" });
  const ok = ps(["-ExtensionId", `${ID},ponmlkjihgfedcbaponmlkjihgfedcba`, "-DryRun", "-BridgeDir", scratch()]);
  assert.equal(ok.status, 0, ok.stderr);
  const json = JSON.parse(ok.stdout.slice(ok.stdout.indexOf("{"), ok.stdout.lastIndexOf("}") + 1));
  assert.equal(json.name, "com.alfred.switchboard");
  assert.equal(json.path, path.join(HERE, "host.bat"));
  assert.deepEqual(json.allowed_origins, [ORIGIN, "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/"]);
  assert.match(ok.stdout, /would set HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.alfred\.switchboard/);
  assert.notEqual(ps(["-ExtensionId", "not-an-id", "-DryRun"]).status, 0);
});
