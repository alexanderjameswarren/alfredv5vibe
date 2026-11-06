import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Ban, BellRing, Ellipsis, Hourglass, Inbox, Radio } from "lucide-react";
import { OVERWATCH_PATH } from "../viewPaths";
import OverwatchSection from "./OverwatchSection";
import SignalActionDialog from "./SignalActionDialog";
import useLoad from "./useLoad";
import { getDispatcher, getDispatcherHistory } from "./overwatchApi";
import { SECTIONS, appendHistory, applyAction, dispatcherView, historyRows } from "./dispatcherModel";

// The Dispatcher screen (notification_routing-d7v, spec section 10): /overwatch/dispatcher. Every card's title
// is a real link to its record, stretched over the card. Unprocessed and Held cards also have a "⋯" button,
// above the link, that opens SignalActionDialog (step 11f).

const OPEN_BY_DEFAULT = new Set(["queued", "unprocessed", "held"]);

function Meta({ parts }) {
  const shown = parts.filter(Boolean);
  return (
    <p className="m-0 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
      {shown.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span aria-hidden="true">·</span>}
          <span>{p}</span>
        </React.Fragment>
      ))}
    </p>
  );
}

const KIND_ICONS = { notify: BellRing, inbox: Inbox, notsent: Ban, pending: Hourglass };

/**
 * One card, all of it the link: an icon for what happened, the title, the main line, the details. With
 * onActions, a "⋯" button sits above the link (z-10) at the right, so tapping it never opens the card.
 */
function Row({ row, onActions }) {
  const Icon = KIND_ICONS[row.kind] || Hourglass;
  return (
    <article className="relative flex items-start gap-3 px-4 py-3 bg-card border border-border rounded-lg hover:border-primary transition-colors">
      <Icon className="w-5 h-5 shrink-0 mt-0.5 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <h3 className="m-0 text-base font-medium leading-snug">
          <Link to={row.path} className="text-foreground after:absolute after:inset-0 after:rounded-lg">{row.title}</Link>
        </h3>
        {row.status && <p className="m-0 text-sm text-foreground">{row.status}</p>}
        {row.dispatcher && <p className="m-0 text-sm text-foreground">Dispatcher: {row.dispatcher}</p>}
        {row.note && <p className="m-0 text-sm text-muted-foreground">{row.note}</p>}
        <Meta parts={row.meta} />
      </div>
      {onActions && (
        <button type="button" aria-label={`Actions for ${row.title}`} onClick={() => onActions(row.id)}
          className="relative z-10 shrink-0 -mr-2 -my-1 inline-flex items-center justify-center w-11 h-11 rounded-lg text-muted-foreground hover:text-primary hover:bg-muted">
          <Ellipsis className="w-5 h-5" aria-hidden="true" />
        </button>
      )}
    </article>
  );
}

function List({ rows, empty, onActions }) {
  if (!rows.length) return <p className="m-0 text-sm text-muted-foreground">{empty}</p>;
  return <div className="space-y-2">{rows.map((r) => <Row key={r.id} row={r} onActions={onActions} />)}</div>;
}

const ACTION_SECTIONS = new Set(["unprocessed", "held"]);

const STATUS_WORDS = { "in force": "In force", "not yet": "Not started yet", ended: "Ended" };

function Overrides({ lines }) {
  if (!lines.length) return null;
  return (
    <div className="pt-2 space-y-1">
      <h3 className="m-0 text-sm font-medium text-foreground">Exceptions</h3>
      <ul className="m-0 p-0 list-none space-y-1">
        {lines.map((o) => (
          <li key={o.label} className={`text-sm ${o.status === "in force" ? "text-foreground" : "text-muted-foreground"}`}>
            <span>{o.text}</span>
            <span className="block text-xs text-muted-foreground">{STATUS_WORDS[o.status]} · {o.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Rules({ rules, inside, overrides }) {
  if (!rules) {
    return <p className="m-0 px-4 py-3 rounded-lg bg-muted text-sm text-foreground">The active Overwatch plan has no delivery rules.</p>;
  }
  return (
    <section aria-label="Delivery rules" className="px-4 py-3 bg-card border border-border rounded-lg space-y-1">
      <p className={`m-0 text-sm font-medium ${inside === false ? "text-muted-foreground" : "text-foreground"}`}>
        {inside === null ? "No window set" : inside ? "Inside the delivery window now" : "Outside the delivery window now"}
      </p>
      <p className="m-0 text-sm text-foreground">{rules.window}</p>
      <p className="m-0 text-sm text-foreground">{rules.pace}</p>
      <p className="m-0 text-sm text-foreground">{rules.defaults}</p>
      <Overrides lines={overrides} />
    </section>
  );
}

/** History, 50 at a time: "Show older" reads the next page past the oldest card shown. */
function History({ first, next, appNames }) {
  const [older, setOlder] = useState({ rows: [], next, busy: false, error: null });
  const rows = appendHistory(first, older.rows);
  const showOlder = () => {
    setOlder((o) => ({ ...o, busy: true, error: null }));
    getDispatcherHistory(older.next)
      .then((h) => setOlder((o) => ({ rows: appendHistory(o.rows, historyRows(h.notifications, h.signals, appNames)),
        next: h.next, busy: false, error: null })))
      .catch((err) => setOlder((o) => ({ ...o, busy: false, error: err.message })));
  };
  return (
    <OverwatchSection id="dispatcher-history" title="History" count={`${rows.length} shown`}>
      <List rows={rows} empty={SECTIONS.find((s) => s.id === "history").empty} />
      {older.error && <p role="alert" className="m-0 mt-2 text-sm text-destructive">{older.error}</p>}
      {older.next && (
        <button type="button" onClick={showOlder} disabled={older.busy}
          className="mt-2 w-full min-h-[44px] rounded-lg border border-border bg-card text-sm font-medium text-primary hover:border-primary disabled:opacity-60">
          {older.busy ? "Loading…" : "Show older"}
        </button>
      )}
    </OverwatchSection>
  );
}

export default function DispatcherPage() {
  const { loading, error, data: loaded } = useLoad(getDispatcher, "dispatcher");
  // The loaded data, then each action applied to it, so a card moves without a reload.
  const [data, setData] = useState(null);
  const [acting, setActing] = useState(null);
  useEffect(() => { if (loaded) setData(loaded); }, [loaded]);
  const back = (
    <Link to={OVERWATCH_PATH} className="inline-flex items-center gap-2 mb-3 min-h-[44px] text-primary hover:text-primary-hover">
      <ArrowLeft className="w-4 h-4" aria-hidden="true" />
      Overwatch
    </Link>
  );
  if (error) return <div>{back}<p role="alert" className="m-0 text-sm text-destructive">{error}</p></div>;
  if (loading || !data) return <div>{back}<p className="m-0 text-sm text-muted-foreground">Loading…</p></div>;
  const view = dispatcherView(data, { appNames: data.appNames });
  const actingSignal = acting ? (data.signals || []).find((s) => s.id === acting) : null;
  const done = (result) => {
    setData((d) => applyAction(d, acting, result));
    setActing(null);
  };
  const title = (s) => (s.id === "unprocessed" ? `Unprocessed – next run ${view.nextRun}` : s.title);
  return (
    // `isolate` keeps the cards' stretched links inside this page, under the app's sticky header.
    <div className="isolate min-w-0 [overflow-wrap:anywhere] space-y-3">
      {back}
      <h2 className="m-0 flex items-start gap-2 text-xl sm:text-2xl font-bold">
        <Radio className="w-6 h-6 shrink-0 mt-0.5 text-primary" aria-hidden="true" />
        <span className="min-w-0">Dispatcher</span>
      </h2>
      <Rules rules={view.rules} inside={view.inside} overrides={view.overrides} />
      {SECTIONS.filter((s) => s.id !== "history").map((s) => (
        <OverwatchSection key={s.id} id={`dispatcher-${s.id}`} title={title(s)} count={view[s.id].length}
          defaultOpen={OPEN_BY_DEFAULT.has(s.id)}>
          <List rows={view[s.id]} empty={s.empty} onActions={ACTION_SECTIONS.has(s.id) ? setActing : undefined} />
        </OverwatchSection>
      ))}
      <History first={view.history} next={view.historyNext} appNames={data.appNames} />
      {actingSignal && (
        <SignalActionDialog signal={actingSignal} onDone={done} onCancel={() => setActing(null)} />
      )}
    </div>
  );
}
