// Warren Buffet history import: readers and planning. No network, no file writes.
import { createHash } from "node:crypto";

export const WF_FILES = [
  // Elise's small file first (spec: import order).
  { file: "CheckingElise5239.csv", last4: "5239" },
  { file: "CheckingJoint9881.csv", last4: "9881" },
  { file: "EliseVisa5819.csv", last4: "5819" },
  { file: "FamilySavings2756.csv", last4: "2756" },
  { file: "JointSavings5485.csv", last4: "5485" },
  { file: "JointVisa3782.csv", last4: "3782" },
];
export const CNB_FILE = "CNBTransaction_10312026.csv";
export const CNB_LAST4 = ["8560", "6900"];
export const ALL_FILES = [...WF_FILES.map((f) => f.file), CNB_FILE];

const WF_HEADER = ["DATE", "DESCRIPTION", "AMOUNT", "CHECK #", "STATUS"];
const CNB_HEADER = ["POSTED DATE", "MERCHANT", "ACCOUNT NUMBER", "TRANSACTION TYPE", "CATEGORY", "CREDITS", "DEBITS"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** RFC 4180 rows, each with the 1-based line it starts on. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false, line = 1, start = 1;
  const s = text.replace(/^﻿/, "");
  const endRow = () => {
    row.push(cell);
    rows.push({ line: start, cells: row });
    row = [];
    cell = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else { if (c === "\n") line++; cell += c; }
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { endRow(); line++; start = line; }
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}

function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function wfDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s).trim());
  return m ? isoDate(m[3], m[1], m[2]) : null;
}

export function cnbDate(s) {
  const m = /^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  return month ? isoDate(m[3], month, m[2]) : null;
}

/** "-$1,234.5" -> "-1234.50"; null if it is not money. CNB writes three decimals; a third that is not 0 is refused, never rounded. */
export function money(s) {
  const m = /^([+-]?)\$?(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d{1,2})(0?))?$/.exec(String(s).trim());
  if (!m || (!m[2] && !m[3])) return null;
  const whole = m[2].replace(/,/g, "") || "0";
  return `${m[1] === "-" ? "-" : ""}${whole}.${(m[3] ?? "").padEnd(2, "0")}`;
}

function sameHeader(cells, want) {
  return cells.length === want.length && want.every((h, i) => cells[i].trim() === h);
}

const blank = (cells) => cells.every((c) => c.trim() === "");

/** Rows are { last4, date, amount, description, memo, raw }; bad holds line numbers only. */
export function readWellsFargo(text, last4) {
  const [head, ...body] = parseCsv(text);
  if (!head || !sameHeader(head.cells, WF_HEADER)) throw new Error("columns are not the expected Wells Fargo columns");
  const rows = [], bad = [];
  for (const { line, cells } of body) {
    if (blank(cells)) continue;
    const date = wfDate(cells[0]);
    const amount = money(cells[2]);
    if (cells.length !== WF_HEADER.length || !date || amount === null) { bad.push(line); continue; }
    const check = cells[3].trim();
    rows.push({
      last4, date, amount,
      description: cells[1].trim(),
      memo: check ? `CHECK # ${check}` : null,
      raw: { date: cells[0], description: cells[1], amount: cells[2], check: cells[3], status: cells[4] },
    });
  }
  return { rows, bad };
}

/** Six filter lines, then the header. The account comes from each row; its number is not kept in raw. */
export function readCnb(text) {
  const all = parseCsv(text);
  const at = all.findIndex((r) => sameHeader(r.cells, CNB_HEADER));
  if (at < 0) throw new Error("columns are not the expected CNB columns");
  const rows = [], bad = [];
  for (const { line, cells } of all.slice(at + 1)) {
    if (blank(cells)) continue;
    const date = cnbDate(cells[0]);
    const last4 = /^\*(\d{4})$/.exec((cells[2] ?? "").trim())?.[1];
    const credit = (cells[5] ?? "").trim();
    const debit = (cells[6] ?? "").trim();
    const amount = money(credit || debit);
    const oneSide = !credit !== !debit;
    const signOk = amount !== null && (credit ? !amount.startsWith("-") : amount.startsWith("-"));
    if (cells.length !== CNB_HEADER.length || !date || !CNB_LAST4.includes(last4) || !oneSide || !signOk) {
      bad.push(line);
      continue;
    }
    rows.push({
      last4, date, amount,
      description: cells[1].trim(),
      memo: null,
      raw: { posted_date: cells[0], merchant: cells[1], type: cells[3], category: cells[4], credits: cells[5], debits: cells[6] },
    });
  }
  return { rows, bad };
}

/** Numbers identical rows in file order, so they stay distinct and a re-run gives the same ids. */
export function withExternalIds(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const key = JSON.stringify([r.last4, r.date, r.amount, r.description]);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    const hash = createHash("sha256").update(`${key}|${occurrence}`).digest("hex").slice(0, 40);
    return { ...r, occurrence, external_id: `history-import-${hash}` };
  });
}

/** cutoff is an ISO date or null (no synced rows: everything imports). */
export function splitAtCutoff(rows, cutoff) {
  const keep = cutoff ? rows.filter((r) => r.date < cutoff) : rows;
  return { keep, skipped: rows.length - keep.length };
}

const pacific = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23",
});

/** The Pacific calendar date of an instant, as every wb_ view reads it. */
export function pacificDate(iso) {
  const p = Object.fromEntries(pacific.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Noon Pacific on a date: the files give no time, and noon stays on that date. */
export function pacificNoon(date) {
  for (const utcHour of [19, 20]) {
    const d = new Date(`${date}T${utcHour}:00:00.000Z`);
    const p = Object.fromEntries(pacific.formatToParts(d).map((x) => [x.type, x.value]));
    if (p.hour === "12") return d.toISOString();
  }
  throw new Error("could not place a date at noon Pacific");
}

export function toRow(r, account) {
  return {
    user_id: account.user_id,
    context_id: account.context_id,
    account_id: account.id,
    external_id: r.external_id,
    posted_at: pacificNoon(r.date),
    amount: r.amount,
    description: r.description || null,
    memo: r.memo,
    pending: false,
    raw: r.raw,
    source: "history_import",
  };
}
