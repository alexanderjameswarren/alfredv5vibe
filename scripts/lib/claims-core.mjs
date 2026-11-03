// Shim (s61): re-exports what alfred-v5 still uses from the installed Switchboard's claims/lib/claims-core.mjs.
import { existsSync } from "node:fs"; import { homedir } from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
const target = path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "Switchboard", "claims", "lib", "claims-core.mjs");
if (!existsSync(target)) { console.error("Switchboard isn't installed: run install.ps1 in C:\\Users\\Alex\\projects\\switchboard"); process.exit(1); }
export const { resolveCheckout, resolveRepo, withLock } = await import(pathToFileURL(target).href);
