// Shim (s61): re-exports what alfred-v5 still uses from the installed Switchboard's overwatch/lib/overwatch-post.mjs.
import { existsSync } from "node:fs"; import { homedir } from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
const target = path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "Switchboard", "overwatch", "lib", "overwatch-post.mjs");
if (!existsSync(target)) { console.error("Switchboard isn't installed: run install.ps1 in C:\\Users\\Alex\\projects\\switchboard"); process.exit(1); }
// SENDER_SCRIPT is absolute here: the installed sender.
export const { SENDER_SCRIPT, queueEvents } = await import(pathToFileURL(target).href);
