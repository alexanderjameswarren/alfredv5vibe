import React, { useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Trash2 } from "lucide-react";
import {
  deletePlannedItem, getDeletePreview, getPlannedItemDetail, setPlannedItemBackToInvoiced, unconfirmPlannedMatch,
} from "./moneyApi";
import { useLoad } from "./useMoneyData";
import HelpButton, { HelpTitle } from "./HelpButton";
import { STAGE_LABELS, annotatePlannedItem, formatDay, formatMoney, intervalLabel, toNumber } from "./moneyFormat";

const BADGE = "inline-block px-2 py-0.5 rounded-full text-xs";
const LIST = "divide-y divide-border bg-card border border-border rounded-lg px-4";
const SMALL = "min-h-[44px] px-3 rounded-lg border border-border text-sm";
const MATCH_STATUS = { confirmed: "Confirmed", suggested: "Waiting in Review", rejected: "Turned down" };
const STATUS_ORDER = { confirmed: 0, suggested: 1, rejected: 2 };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Alfred's confirmation buttons: the main one as CloseDialog's, the other as the shared CancelButton.
const PRIMARY = "flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm disabled:opacity-60";
const SECONDARY = "inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-lg bg-secondary hover:bg-secondary text-foreground text-sm shadow-sm disabled:opacity-60";

/**
 * Alfred's confirmation pop-up, as ExecutionDetailView's "Delete execution" and
 * StatusEventsSheet: the same overlay and card, at the page root like CloseDialog.
 */
function Confirm({ label, onCancel, busy, children }) {
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={busy ? undefined : onCancel}>
      <div role="dialog" aria-label={label} className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Fact({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right break-words min-w-0">{children}</dd>
    </div>
  );
}

/** What a delete would remove, in plain words (spec A46). */
export function deleteLines(preview, projectName) {
  const lines = [];
  if (preview.confirmed) lines.push(`${plural(preview.confirmed, "confirmed match", "confirmed matches")}: those payments count in spending again.`);
  if (preview.suggested) lines.push(`${plural(preview.suggested, "suggestion")} waiting in Review.`);
  if (preview.rejected) lines.push(`${plural(preview.rejected, "turned-down match", "turned-down matches")}.`);
  if (preview.skips) lines.push(`${plural(preview.skips, "Not needed mark")}.`);
  if (projectName) lines.push(`${projectName}: its amounts still due will change.`);
  return lines;
}

/**
 * One planned item (spec A44, A46, A47): its amounts, schedule or stage, matches with
 * Remove match, Not needed marks, and Delete item. Every other change is made with Claude.
 */
export default function PlannedItemDetailView({ plannedItemId, onBack, onOpenProject, onOpenTransaction }) {
  const { data, error, loading, reload } = useLoad(() => getPlannedItemDetail(plannedItemId), [plannedItemId]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [askSetBack, setAskSetBack] = useState(false);
  const [preview, setPreview] = useState(null);

  const back = (
    <button type="button" onClick={onBack} className="min-h-[44px] inline-flex items-center gap-1 text-sm text-primary">
      <ChevronLeft className="w-4 h-4" /> Back
    </button>
  );
  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <div className="space-y-3">{back}<p className="text-sm text-destructive">{error.message}</p></div>;
  if (!data) {
    return <div className="space-y-3">{back}<p className="text-sm text-muted-foreground">This planned item no longer exists, or you can't see it.</p></div>;
  }

  const it = annotatePlannedItem(data.item,
    data.matches.filter((m) => m.status === "confirmed").map((m) => ({ ...m, planned_item_id: data.item.id })));
  const projectName = data.item.project?.name || null;
  const matches = [...data.matches].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  async function act(fn) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err.message);
    }
    setBusy(false);
  }

  const removeMatch = (m) => act(async () => {
    const res = await unconfirmPlannedMatch(m.id);
    setAskSetBack(Boolean(res?.paid_not_covered));
    reload();
  });
  const setBack = () => act(async () => {
    await setPlannedItemBackToInvoiced(it.id);
    setAskSetBack(false);
    reload();
  });
  const askDelete = () => act(async () => setPreview(await getDeletePreview(it.id)));
  const confirmDelete = () => act(async () => {
    await deletePlannedItem(it.id);
    onBack();
  });

  const lines = preview ? deleteLines(preview, projectName) : [];

  return (
    <div className="space-y-6">
      <div>
        {back}
        <h3 className="text-lg font-medium break-words">{it.name}</h3>
        <p className="flex flex-wrap items-center gap-1 mt-1">
          {it.draft
            ? <><span className={`${BADGE} border border-dashed border-primary text-primary-dark`}>What if</span><HelpButton helpKey="plan.drafts" /></>
            : !it.repeating && <span className={`${BADGE} border border-border text-muted-foreground`}>{STAGE_LABELS[it.stage]}</span>}
          {it.over_matched && (
            <><span className={`${BADGE} border border-destructive text-destructive`}>More than planned</span><HelpButton helpKey="plan.over_matched" /></>
          )}
        </p>
      </div>

      {askSetBack && (
        <Confirm label="Set it back to invoiced?" onCancel={() => setAskSetBack(false)} busy={busy}>
          <h3 className="text-lg font-semibold mb-2">Set it back to invoiced?</h3>
          <p className="text-sm mb-4">The match is removed. This item is still marked paid, but its payments no longer cover it.</p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={setBack} className={`flex-1 ${PRIMARY}`}>Yes, set it back</button>
            <button type="button" disabled={busy} onClick={() => setAskSetBack(false)} className={SECONDARY}>No, keep it paid</button>
          </div>
        </Confirm>
      )}
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}

      <section className="bg-card border border-border rounded-lg px-4">
        <dl className="divide-y divide-border text-sm">
          <Fact label={it.repeating ? "Each time" : "Amount"}><span className="tabular-nums">{formatMoney(it.amount)}</span></Fact>
          {!it.repeating && (
            <Fact label={<HelpTitle text="Left to pay" helpKey="plan.item_left" />}>
              <span className="tabular-nums">{formatMoney(it.remaining)}</span>
              {toNumber(it.confirmed_total) !== 0 && <span className="block text-xs text-muted-foreground">{formatMoney(it.confirmed_total)} matched</span>}
            </Fact>
          )}
          {it.repeating ? (
            <Fact label={<HelpTitle text="Repeats" helpKey="plan.repeating" />}>
              {intervalLabel(it)} from {formatDay(it.due_on)}{it.ends_on ? ` to ${formatDay(it.ends_on)}` : ", no end date"}
            </Fact>
          ) : (
            <Fact label="Due">{formatDay(it.due_on)}</Fact>
          )}
          {!it.repeating && <Fact label={<HelpTitle text="Stage" helpKey="plan.stages" />}>{STAGE_LABELS[it.stage]}</Fact>}
          <Fact label="Tolerance">± {formatMoney(it.amount_tolerance)}</Fact>
          {it.project_id && (
            <Fact label="Project">
              <button type="button" className="min-h-[44px] text-primary underline" onClick={() => onOpenProject(it.project_id)}>
                {projectName || "Open project"}
              </button>
            </Fact>
          )}
          <Fact label="Merchant">{data.item.merchant?.name || "None: never suggested a match"}</Fact>
          {it.tax_year && <Fact label="Tax year">{it.tax_year}</Fact>}
          {it.notes && <Fact label="Notes"><span className="whitespace-pre-line">{it.notes}</span></Fact>}
        </dl>
      </section>

      <section>
        <h3 className="font-medium mb-2">
          <HelpTitle text="Matches" helpKey="plan.matches" />{" "}
          <span className="text-muted-foreground font-normal">({matches.length})</span>
        </h3>
        {matches.length === 0 ? <p className="text-sm text-muted-foreground">No payments matched yet.</p> : (
          <ul className={LIST}>
            {matches.map((m) => (
              <li key={m.id} className="py-3 space-y-2">
                <button type="button" disabled={!m.payment} onClick={() => onOpenTransaction(m.transaction_id)}
                  className="w-full text-left flex items-start justify-between gap-3 min-h-[44px]">
                  <span className="min-w-0">
                    <span className="block break-words">
                      {m.payment ? (m.payment.clean_description || m.payment.merchant_name || m.payment.payee || "Payment") : "Payment not visible"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {m.payment ? `Paid ${formatDay(m.payment.txn_date)}` : ""}{m.occurrence_on ? ` · for ${formatDay(m.occurrence_on)}` : ""}
                    </span>
                    <span className={`${BADGE} mt-1 border border-border ${m.status === "rejected" ? "text-muted-foreground" : ""}`}>{MATCH_STATUS[m.status]}</span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    {formatMoney(m.amount_applied)}
                    {m.payment && toNumber(m.payment.amount) !== toNumber(m.amount_applied) && (
                      <span className="block text-xs text-muted-foreground">of {formatMoney(m.payment.amount)}</span>
                    )}
                  </span>
                </button>
                {m.status === "confirmed" && (
                  <button type="button" disabled={busy} className={SMALL} onClick={() => removeMatch(m)}>Remove match</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.skips.length > 0 && (
        <section>
          <h3 className="font-medium mb-2">
            <HelpTitle text="Not needed" helpKey="plan.not_needed" />{" "}
            <span className="text-muted-foreground font-normal">({data.skips.length})</span>
          </h3>
          <ul className={`${LIST} text-sm`}>
            {data.skips.map((k) => (
              <li key={k.id} className="py-2 flex flex-wrap justify-between gap-x-3">
                <span>{k.occurrence_on ? formatDay(k.occurrence_on) : "This item"}</span>
                <span className="text-muted-foreground break-words">{k.reason || "No reason given"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="border-t border-border pt-4">
        <p className="flex items-center gap-1">
          <button type="button" disabled={busy} onClick={askDelete}
            className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] border-2 border-destructive text-destructive hover:bg-destructive/10 rounded-lg transition-colors duration-200">
            <Trash2 className="w-4 h-4" />
            Delete item
          </button>
          <HelpButton helpKey="plan.delete_item" />
        </p>
      </section>

      {preview && (
        <Confirm label="Delete this item?" onCancel={() => setPreview(null)} busy={busy}>
          <h3 className="text-lg font-semibold mb-2 break-words">Delete {it.name}?</h3>
          {lines.length > 0 ? (
            <>
              <p className="text-sm">This also removes:</p>
              <ul className="list-disc pl-5 text-sm mb-2">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
            </>
          ) : <p className="text-sm mb-2">It has no matches or marks.</p>}
          <p className="text-sm text-muted-foreground mb-4">The payments themselves stay. This cannot be undone here.</p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={confirmDelete}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-destructive hover:bg-destructive-hover text-white rounded-lg shadow-sm disabled:opacity-60">
              <Trash2 className="w-4 h-4" />
              Delete it
            </button>
            <button type="button" disabled={busy} onClick={() => setPreview(null)} className={SECONDARY}>Keep it</button>
          </div>
        </Confirm>
      )}
    </div>
  );
}
