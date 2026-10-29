// Gmail capture — runs in alex.warren@secorus.com, finds mail labelled alfred or
// alfred/<child>, posts it to the email-capture Edge Function, and labels the result.
// Pure logic is in lib.js. Spec: docs/technical-spec-gmail-capture.md.

var MAX_PER_RUN = 40;

function config_() {
  var p = PropertiesService.getScriptProperties();
  var c = {
    url: p.getProperty("CAPTURE_URL"),
    secret: p.getProperty("CAPTURE_SECRET"),
    startDate: p.getProperty("START_DATE"),
    dryRun: String(p.getProperty("DRY_RUN") || "").toLowerCase() === "true",
    testQuery: p.getProperty("TEST_QUERY"),
  };
  if (!c.url || !c.secret) throw new Error("Set CAPTURE_URL and CAPTURE_SECRET in Script Properties");
  return c;
}

/** Trigger entry point. DRY_RUN=true sends dry_run and changes no labels. */
function run() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log("Previous run still going; skipping");
    return;
  }
  try {
    var c = config_();
    process_(c, buildQuery(labelNames_(), c.startDate), c.dryRun);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Manual check: always a dry run, never changes labels. Uses TEST_QUERY when set
 * (e.g. "label:forwarded newer_than:7d", to try real mail before the cutover).
 */
function dryRun() {
  var c = config_();
  process_(c, c.testQuery || buildQuery(labelNames_(), c.startDate), true);
}

function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger("run").timeBased().everyMinutes(5).create();
  console.log("Trigger installed: run every 5 minutes");
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "run") ScriptApp.deleteTrigger(t);
  });
}

function labelNames_() {
  return (Gmail.Users.Labels.list("me").labels || []).map(function (l) { return l.name; });
}

function labelMap_() {
  var byId = {};
  var byName = {};
  (Gmail.Users.Labels.list("me").labels || []).forEach(function (l) {
    byId[l.id] = l.name;
    byName[l.name] = l.id;
  });
  return { byId: byId, byName: byName };
}

/** Label id by name, created on first use (so forwarded/rejected never exists before the cutover rename). */
function labelId_(map, name) {
  if (map.byName[name]) return map.byName[name];
  if (name.indexOf("/") !== -1) labelId_(map, name.split("/")[0]);
  var created = Gmail.Users.Labels.create({ name: name, labelListVisibility: "labelShow", messageListVisibility: "show" }, "me");
  map.byName[name] = created.id;
  map.byId[created.id] = name;
  return created.id;
}

var DECODE_ = {
  fromBytes: function (bytes, charset) { return Utilities.newBlob(bytes).getDataAsString(charset); },
  fromBase64WebSafe: function (s, charset) {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString(charset);
  },
};

function decodeBody_(part) {
  return decodeBodyPart(part, DECODE_);
}

function process_(c, query, dryRun) {
  var account = Gmail.Users.getProfile("me").emailAddress;
  var map = labelMap_();
  var listed = Gmail.Users.Messages.list("me", { q: query, maxResults: MAX_PER_RUN }).messages || [];
  var seen = {};
  var counts = { forwarded: 0, rejected: 0, none: 0, skipped: 0 };
  console.log((dryRun ? "Dry run" : "Run") + ": " + listed.length + " message(s) for " + query);

  listed.forEach(function (ref) {
    try {
      var msg = Gmail.Users.Messages.get("me", ref.id, { format: "full" });
      if (seenThisRun(seen, headerValue(msg.payload && msg.payload.headers, "Message-ID"))) {
        counts.skipped++;
        return;
      }
      var payload = buildPayload(msg, map.byId, decodeBody_(findBodyPart(msg.payload)), account, dryRun);
      var res = UrlFetchApp.fetch(c.url, {
        method: "post",
        contentType: "application/json",
        headers: { "x-capture-secret": c.secret },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      var code = res.getResponseCode();
      var text = res.getContentText();
      var action = actionFor(code, text);
      counts[action]++;
      if (dryRun) {
        console.log(dryRunLine(ref.id, code, text, headerValue(msg.payload && msg.payload.headers, "From")));
        return;
      }
      if (action === "none") {
        console.warn(ref.id + ": no change, " + code + " " + text.slice(0, 200));
        return;
      }
      var change = labelChange(action, {
        forwarded: action === "forwarded" ? labelId_(map, DONE_LABEL) : null,
        rejected: action === "rejected" ? labelId_(map, REJECTED_LABEL) : null,
      });
      Gmail.Users.Messages.modify(change, "me", ref.id);
    } catch (e) {
      counts.none++;
      console.error(ref.id + ": " + (e && e.message ? e.message : e));
    }
  });
  console.log(JSON.stringify(counts));
}
