// Shim (s61): re-exports what alfred-v5 still uses from the installed Switchboard's git/lib/finish-summary.mjs.
import { existsSync } from "node:fs"; import { homedir } from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
const target = path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "Switchboard", "git", "lib", "finish-summary.mjs");
if (!existsSync(target)) { console.error("Switchboard isn't installed: run install.ps1 in C:\\Users\\Alex\\projects\\switchboard"); process.exit(1); }
export const { branchFromSubject, collectFinishSummary, parseSendSummaryArgs } = await import(pathToFileURL(target).href);
