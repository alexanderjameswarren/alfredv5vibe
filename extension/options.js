import { getConfig, saveConfig, configProblem, DEFAULT_BASE_URL } from "./lib/config.js";

const $ = (id) => document.getElementById(id);
const baseUrlEl = $("baseUrl");
const secretEl = $("secret");
const statusEl = $("status");

function show(kind, text) {
  statusEl.className = kind;
  statusEl.textContent = text;
}

// Pre-fill the address so there is one less thing to type or mistype. The SECRET
// is never pre-filled and has no default anywhere in this extension — it is
// typed in here and lives only in chrome.storage.local on this machine.
(async function load() {
  const cfg = await getConfig();
  baseUrlEl.value = cfg.baseUrl || DEFAULT_BASE_URL;
  secretEl.value = cfg.secret || "";
  if (cfg.secret) {
    show("ok", "Settings are saved on this machine. Re-paste the secret if you want to change it.");
  }
})();

$("reveal").addEventListener("click", () => {
  const revealed = secretEl.type === "text";
  secretEl.type = revealed ? "password" : "text";
  $("reveal").textContent = revealed ? "Show" : "Hide";
});

$("save").addEventListener("click", async () => {
  const candidate = { baseUrl: baseUrlEl.value, secret: secretEl.value };
  // Validated with the same helper the service worker uses before every clip, so
  // a value that would be refused at clip time is refused here instead, next to
  // the field that is wrong.
  const problem = configProblem({
    baseUrl: (candidate.baseUrl || "").trim().replace(/\/+$/, ""),
    secret: (candidate.secret || "").trim(),
  });
  if (problem) {
    show("bad", problem);
    return;
  }
  await saveConfig(candidate);
  const saved = await getConfig();
  baseUrlEl.value = saved.baseUrl;
  show("ok", "Saved. Open a web page and click the toolbar icon, or press Ctrl+Shift+Y.");
});
