#!/usr/bin/env node
// Shim (s61): runs the installed Switchboard's hooks/session-status.mjs (without --user) with the same stdin and exit code.
import { spawnSync } from "node:child_process"; import { existsSync } from "node:fs"; import { homedir } from "node:os"; import path from "node:path";
const target = path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "Switchboard", "hooks", "session-status.mjs");
if (!existsSync(target)) { console.error("Switchboard isn't installed: run install.ps1 in C:\\Users\\Alex\\projects\\switchboard"); process.exit(1); }
process.exit(spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true }).status ?? 1);
