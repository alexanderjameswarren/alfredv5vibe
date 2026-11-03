// Shim (s61): runs the installed Switchboard's hooks/lib/session-status.mjs, for the old panel's "clear-wrong", with the same arguments and exit code.
import { spawnSync } from "node:child_process"; import { existsSync } from "node:fs"; import { homedir } from "node:os"; import path from "node:path";
const target = path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "Switchboard", "hooks", "lib", "session-status.mjs");
if (!existsSync(target)) { console.error("Switchboard isn't installed: run install.ps1 in C:\\Users\\Alex\\projects\\switchboard"); process.exit(1); }
process.exit(spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true }).status ?? 1);
