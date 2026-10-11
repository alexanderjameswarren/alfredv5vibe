import React, { useState } from "react";
import { ArrowLeft, Undo2, X } from "lucide-react";
import AlwaysDoThisSheet from "./AlwaysDoThisSheet";
import SplitEditor from "./SplitEditor";
import {
  applyTags, findPairCandidates, getTagTree, getTransactionDetail, saveNotes, setKind, setReviewed, setTransferPair,
} from "./moneyApi";
import { useLoad } from "./useMoneyData";
import { KIND_LABELS, KIND_ORDER, exclusionLabel, formatDay, formatMoney, tagOptions } from "./moneyFormat";

const SECTION = "bg-card border border-border rounded-lg p-4";
const FIELD = "w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm";
const LINK = "min-h-[44px] px-3 text-sm text-primary inline-flex items-center gap-1.5";

/** The tags of one group on a single-split transaction, with removed-by-hand ones and their undo. */
function GroupTags({ group, tags, current, excluded, onAdd, onRemove, disabled }) {
  const options = tagOptions(tags, group.id);
  const here = current.filter((t) => t.group_id === group.id);
  const gone = excluded.filter((e) => tags.find((t) => t.id === e.tag_id)?.group_id === group.id);

  return (
    <div className="py-2">
      <p className="text-sm font-medium mb-1">{group.name}</p>
      {group.exclusive ? (
        <select aria-label={group.name} disabled={disabled} value={here[0]?.id || ""}
          onChange={(e) => (e.target.value ? onAdd(e.target.value) : here[0] && onRemove(here[0].id))}
          className={FIELD}>
          <option value="">None</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {here.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 pl-3 rounded-full border border-border text-sm">
              {t.name}
              <button type="button" onClick={() => onRemove(t.id)} disabled={disabled} aria-label={`Remove ${t.name}`}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground">
                <X className="w-4 h-4" />
              </button>
            </span>
          ))}
          <select aria-label={`Add ${group.name}`} disabled={disabled} value="" onChange={(e) => e.target.value && onAdd(e.target.value)}
            className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm max-w-full">
            <option value="">Add…</option>
            {options.filter((o) => !here.some((t) => t.id === o.id)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
      )}
      {gone.map((e) => (
        <p key={e.tag_id} className="flex flex-wrap items-center gap-2 mt-1 text-sm text-muted-foreground">
          <span><span className="line-through">{e.tag_name}</span> — {exclusionLabel(e)}</span>
          <button type="button" onClick={() => onAdd(e.tag_id)} disabled={disabled} className={LINK}>
            <Undo2 className="w-4 h-4" aria-hidden="true" /> Undo
          </button>
        </p>
      ))}
    </div>
  );
}

function PairPicker({ txn, onPaired, onCancel }) {
  const found = useLoad(() => findPairCandidates(txn), [txn.id]);
  const [error, setError] = useState(null);
  const pair = async (id) => {
    try { await setTransferPair(txn.id, id); onPaired(); } catch (err) { setError(err.message); }
  };
  return (
    <div className="space-y-2">
      {found.loading && <p className="text-sm text-muted-foreground">Looking…</p>}
      {found.error && <p role="alert" className="text-sm text-destructive">{found.error.message}</p>}
      {found.data && found.data.length === 0 && (
        <p className="text-sm text-muted-foreground">No unpaired transaction for the opposite amount on another account within 5 days.</p>
      )}
      <ul className="divide-y divide-border">
        {(found.data || []).map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0 text-sm">
              <span className="block break-words">{c.clean_description || "—"}</span>
              <span className="block text-xs text-muted-foreground">{c.account_label} · {formatDay(c.txn_date)}</span>
            </span>
            <button type="button" onClick={() => pair(c.id)}
              className="min-h-[44px] px-4 rounded-lg border border-border text-sm shrink-0">Pair</button>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <button type="button" onClick={onCancel} className={LINK}>Cancel</button>
    </div>
  );
}

export default function TransactionDetailView({ transactionId, onBack, onOpenTransaction }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [txn, tree] = await Promise.all([getTransactionDetail(transactionId), getTagTree()]);
    return { txn, tree };
  }, [transactionId]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [changed, setChanged] = useState(null); // {kind?: true, tagIds: []} after a hand change
  const [sheet, setSheet] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [notes, setNotes] = useState(null);

  const header = (
    <div className="flex items-center gap-3 mb-4">
      <button type="button" onClick={onBack} title="Back"
        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground rounded">
        <ArrowLeft className="w-5 h-5" />
      </button>
      <h3 className="text-lg font-medium">Transaction</h3>
    </div>
  );
  if (loading && !data) return <>{header}<p className="text-sm text-muted-foreground">Loading…</p></>;
  if (error) return <>{header}<p className="text-sm text-destructive">{error.message}</p></>;
  if (!data.txn) return <>{header}<p className="text-sm text-muted-foreground">No such transaction.</p></>;

  const { txn, tree } = data;
  const tagsById = new Map(tree.tags.map((t) => [t.id, t]));
  const single = txn.splits.length === 1;
  const current = single ? (txn.splits[0].tags || []).map((s) => tagsById.get(s.tag_id)).filter(Boolean) : [];
  const category = tree.groups.find((g) => g.name === "Category");
  const label = txn.merchant_name || txn.payee || txn.clean_description || "this merchant";

  async function act(fn, change) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      if (change) {
        setChanged((c) => ({ kind: change.kind || c?.kind || false, tagIds: [...new Set([...(c?.tagIds || []), ...(change.tagIds || [])])] }));
      }
      reload();
    } catch (err) {
      setActionError(err.message);
    }
    setBusy(false);
  }

  const addTag = (id) => act(() => applyTags([txn.id], [id], []), { tagIds: [id] });
  const removeTag = (id) => act(() => applyTags([txn.id], [], [id]), { tagIds: [] });

  return (
    <div>
      {header}
      <div className="space-y-4">
        <section className={SECTION}>
          <p className="text-2xl font-medium tabular-nums">{formatMoney(txn.amount)}</p>
          <p className="mt-1 break-words">{txn.clean_description || txn.payee || "—"}</p>
          <p className="text-sm text-muted-foreground break-words">
            {formatDay(txn.txn_date)} · {txn.account_label}{txn.merchant_name ? ` · ${txn.merchant_name}` : ""}
            {txn.pending ? " · pending" : ""}
          </p>
          <p className="text-xs text-muted-foreground mt-2 break-words">Bank text: {txn.description || "—"}</p>
        </section>

        {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}

        {changed && (changed.kind || changed.tagIds.length > 0) && !sheet && (
          <button type="button" onClick={() => setSheet(true)}
            className="w-full min-h-[44px] px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm">
            Always do this for {label}
          </button>
        )}

        <section className={SECTION}>
          <label htmlFor="txn-kind" className="block font-medium mb-1">Kind</label>
          <select id="txn-kind" value={txn.kind || ""} disabled={busy}
            onChange={(e) => act(() => setKind(txn, e.target.value), { kind: true })} className={FIELD}>
            {!txn.kind && <option value="">Not processed</option>}
            {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            {txn.kind_source === "manual" ? "Set by hand" : txn.kind_source === "claude" ? "Set by Claude" : txn.kind_source === "rule" ? "Set by a rule" : "Worked out automatically"}
          </p>
        </section>

        <section className={SECTION}>
          <h4 className="font-medium">Tags</h4>
          {single ? (
            <div className="divide-y divide-border">
              {tree.groups.map((g) => (
                <GroupTags key={g.id} group={g} tags={tree.tags} current={current} excluded={txn.excluded_tags || []}
                  onAdd={addTag} onRemove={removeTag} disabled={busy} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">This transaction is split: each part has its own category below.</p>
          )}
        </section>

        <section className={SECTION}>
          <div className="flex items-center justify-between">
            <h4 className="font-medium">Splits</h4>
            {!splitting && (
              <button type="button" onClick={() => setSplitting(true)} className={LINK}>
                {single ? "Split" : "Edit parts"}
              </button>
            )}
          </div>
          {splitting ? (
            <SplitEditor txn={txn} categoryOptions={category ? tagOptions(tree.tags, category.id) : []}
              categoryGroupId={category?.id} tagsById={tagsById}
              onSaved={() => { setSplitting(false); reload(); }} onCancel={() => setSplitting(false)} />
          ) : !single && (
            <ul className="divide-y divide-border mt-2">
              {txn.splits.map((s) => (
                <li key={s.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block break-words">{s.description || "Part"}</span>
                    <span className="block text-xs text-muted-foreground">
                      {(s.tags || []).map((t) => tagsById.get(t.tag_id)?.name).filter(Boolean).join(", ") || "No tags"}
                    </span>
                  </span>
                  <span className="tabular-nums shrink-0">{formatMoney(s.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {(txn.kind === "transfer" || txn.transfer_pair_id || txn.transfer_candidate) && (
          <section className={SECTION}>
            <h4 className="font-medium mb-1">Transfer</h4>
            {txn.pair ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => onOpenTransaction(txn.pair.id)} className={`${LINK} px-0 text-left`}>
                  Paired with {txn.pair.account_label}, {formatDay(txn.pair.txn_date)}
                </button>
                <button type="button" disabled={busy} onClick={() => act(() => setTransferPair(txn.id, null))}
                  className="min-h-[44px] px-4 rounded-lg border border-border text-sm">Unpair</button>
              </div>
            ) : pairing ? (
              <PairPicker txn={txn} onPaired={() => { setPairing(false); reload(); }} onCancel={() => setPairing(false)} />
            ) : (
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setPairing(true)} className="min-h-[44px] px-4 rounded-lg border border-border text-sm">
                  Find the other side
                </button>
                {txn.kind === "transfer" && (
                  <button type="button" disabled={busy} onClick={() => act(() => setKind(txn, "spend"), { kind: true })}
                    className="min-h-[44px] px-4 rounded-lg border border-border text-sm">Not a transfer</button>
                )}
              </div>
            )}
          </section>
        )}

        <section className={SECTION}>
          <label htmlFor="txn-notes" className="block font-medium mb-1">Notes</label>
          <textarea id="txn-notes" rows={3} value={notes ?? txn.notes ?? ""} onChange={(e) => setNotes(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm" />
          {notes !== null && notes !== (txn.notes ?? "") && (
            <button type="button" disabled={busy} onClick={() => act(async () => { await saveNotes(txn.id, notes); setNotes(null); })}
              className="mt-2 min-h-[44px] px-4 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm disabled:opacity-50">
              Save note
            </button>
          )}
        </section>

        <section className={SECTION}>
          <label className="flex items-center gap-3 min-h-[44px] text-sm">
            <input type="checkbox" checked={!!txn.reviewed} disabled={busy}
              onChange={(e) => act(() => setReviewed([txn.id], e.target.checked))} className="w-5 h-5" />
            Reviewed
          </label>
          {txn.needs_review && <p className="text-xs text-muted-foreground">This is in the review queue.</p>}
        </section>
      </div>

      {sheet && (
        <AlwaysDoThisSheet
          txn={txn}
          kind={txn.kind}
          kindPicked={!!changed?.kind}
          tags={current.map((t) => ({ id: t.id, name: t.name, picked: (changed?.tagIds || []).includes(t.id) }))}
          onClose={() => setSheet(false)}
          onDone={() => { setSheet(false); setChanged(null); reload(); }}
        />
      )}
    </div>
  );
}
