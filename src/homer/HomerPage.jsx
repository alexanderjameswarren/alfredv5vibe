import React, { useState } from "react";
import { BookOpen, ChevronDown, History, MoonStar } from "lucide-react";
import useLoad from "../overwatch/useLoad";
import { getActivePlan, getGenres, getQueue, getQuietSeries, getReads } from "./homerApi";
import {
  groupQueue, historyCards, kindleLinks, quietRows, quietView, seriesLink, shortDate, statusLabel, STATUS_LABEL,
} from "./homerModel";

// The Homer tab (homer-h4k phase F): Alex's read-next queues by genre, the series that have gone quiet, and his
// reading history by series. Read only; changes are made in a Homer chat.

export const HISTORY_PAGE = 20;

async function loadTab() {
  const [plan, queue, genres, quiet, reads] = await Promise.all([
    getActivePlan(), getQueue(), getGenres(), getQuietSeries(), getReads(),
  ]);
  const history = historyCards(reads);
  // homer_quiet_series returns neither the series ASIN nor its author; every quiet series has reads, so history has both.
  const seriesInfo = Object.fromEntries(history.filter((c) => !c.standalone)
    .map((c) => [c.id, { asin: c.seriesAsin, author: c.author }]));
  return { plan, groups: groupQueue(queue, genres), quiet: quietRows(quiet), history, seriesInfo };
}

const linkClass = "inline-flex items-center min-h-[44px] text-sm text-primary hover:underline";

function ExternalLink({ href, children }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>{children}</a>;
}

function HistoryBook({ book }) {
  return (
    <li className="py-2 border-t border-border first:border-t-0">
      <p className="m-0 text-sm text-foreground">
        {book.position !== null && <span className="text-muted-foreground">{String(book.position)}. </span>}
        {book.title}
      </p>
      {book.ownAuthor && <p className="m-0 text-xs text-muted-foreground">{book.ownAuthor}</p>}
      <p className="m-0 text-xs text-muted-foreground">
        {[STATUS_LABEL[book.status], book.date && shortDate(book.date), `${book.hours} h`].filter(Boolean).join(" · ")}
      </p>
      <div className="flex flex-wrap gap-x-4">
        {kindleLinks(book.asin).map((l) => <ExternalLink key={l.label} href={l.href}>{l.label}</ExternalLink>)}
      </div>
    </li>
  );
}

function HistoryCard({ card }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="bg-background border border-border rounded-lg">
      <div className="flex items-start justify-between gap-2 px-4 py-1">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
                className="flex items-start gap-2 min-h-[44px] py-2 text-left min-w-0">
          <ChevronDown className={`w-4 h-4 mt-1 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block text-base font-medium leading-snug text-foreground">{card.name}</span>
            {card.author && <span className="block text-sm text-muted-foreground">{card.author}</span>}
            <span className="block text-xs text-muted-foreground">
              {card.finished} of {card.read} finished{card.latest ? ` · ${shortDate(card.latest)}` : ""}
            </span>
          </span>
        </button>
        {card.link && <ExternalLink href={card.link}>Series</ExternalLink>}
      </div>
      {open && <ul className="m-0 px-4 pb-2 list-none">{card.books.map((b) => <HistoryBook key={b.asin} book={b} />)}</ul>}
    </article>
  );
}

function HistoryList({ cards }) {
  const [shown, setShown] = useState(HISTORY_PAGE);
  if (!cards.length) return <Muted>No reading history yet.</Muted>;
  return (
    <div className="space-y-2">
      {cards.slice(0, shown).map((c) => <HistoryCard key={c.id} card={c} />)}
      {cards.length > shown && (
        <button type="button" onClick={() => setShown(shown + HISTORY_PAGE)}
                className="min-h-[44px] px-4 text-sm text-primary hover:underline">
          Show more ({cards.length - shown} more)
        </button>
      )}
    </div>
  );
}

function Section({ title, icon, children }) {
  return (
    <section className="bg-card border border-border rounded-lg">
      <h2 className="flex items-center gap-2 m-0 px-4 pt-3 pb-2 text-base sm:text-lg font-medium text-foreground">
        {icon}
        {title}
      </h2>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

const Muted = ({ children }) => <p className="m-0 text-sm text-muted-foreground">{children}</p>;

function QueueItem({ item }) {
  return (
    <article className="px-4 py-3 bg-background border border-border rounded-lg">
      <div className="flex items-start justify-between gap-2">
        <h4 className="m-0 text-base font-medium leading-snug text-foreground min-w-0">{item.title}</h4>
        <span className="shrink-0 text-xs text-muted-foreground">{statusLabel(item.status)}</span>
      </div>
      {item.author && <p className="m-0 mt-0.5 text-sm text-muted-foreground">{item.author}</p>}
      {item.on_kindle_unlimited && (
        <span className="inline-block mt-1.5 px-2 py-0.5 text-xs font-medium rounded bg-primary-light text-primary">
          Kindle Unlimited
        </span>
      )}
      {item.why && <p className="m-0 mt-1.5 text-sm text-foreground">{item.why}</p>}
      {item.asin && (
        <div className="flex flex-wrap gap-x-4 mt-1">
          {kindleLinks(item.asin).map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center min-h-[44px] text-sm text-primary hover:underline">
              {l.label}
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function QuietItem({ row, seriesAsin, author }) {
  const v = quietView(row);
  return (
    <article className="px-4 py-3 bg-background border border-border rounded-lg">
      <div className="flex items-start justify-between gap-2">
        <h4 className="m-0 text-base font-medium leading-snug text-foreground min-w-0">{v.title}</h4>
        <span className="shrink-0 text-xs text-muted-foreground">{v.verdict}</span>
      </div>
      {author && <p className="m-0 text-sm text-muted-foreground">{author}</p>}
      {v.pickUp && <p className="m-0 mt-1 text-sm font-medium text-primary">Pick it up again?</p>}
      {v.lastBook && <p className="m-0 mt-1 text-sm text-foreground">{v.lastBook}</p>}
      <p className="m-0 text-xs text-muted-foreground">{[v.lastRead, v.daysSince].filter(Boolean).join(" · ")}</p>
      {(v.behind || v.caughtUp || v.upcoming) && (
        <p className="m-0 mt-1 text-sm text-foreground">
          {[v.behind, v.caughtUp && "Caught up", v.upcoming].filter(Boolean).join(" · ")}
        </p>
      )}
      <ExternalLink href={seriesLink(row.series_name, seriesAsin)}>Series</ExternalLink>
    </article>
  );
}

export default function HomerPage() {
  const { loading, error, data } = useLoad(loadTab, "homer");
  const icon = "w-4 h-4 text-primary";
  return (
    <div className="space-y-3 min-w-0 [overflow-wrap:anywhere]">
      <h1 className="m-0 text-xl font-semibold text-foreground">Homer</h1>
      {error && <p role="alert" className="m-0 text-sm text-destructive">{error}</p>}
      {loading && <Muted>Loading…</Muted>}
      {data && !data.plan && (
        <p className="m-0 px-4 py-3 text-sm bg-card border border-border rounded-lg text-muted-foreground">
          No Homer plan yet. Homer's plan is set up during calibration, in a Homer chat with Claude.
        </p>
      )}
      {data && (
        <>
          <Section title="Read next" icon={<BookOpen className={icon} aria-hidden="true" />}>
            {data.groups.length === 0 ? (
              <Muted>Nothing in the queue yet. Ask Claude for suggestions in a Homer chat.</Muted>
            ) : (
              <div className="space-y-4">
                {data.groups.map((g) => (
                  <div key={g.id}>
                    <h3 className="m-0 mb-2 text-sm font-medium text-muted-foreground">{g.name}</h3>
                    <div className="space-y-2">{g.items.map((it) => <QueueItem key={it.id} item={it} />)}</div>
                  </div>
                ))}
              </div>
            )}
          </Section>
          <Section title="Series gone quiet" icon={<MoonStar className={icon} aria-hidden="true" />}>
            {data.quiet.length === 0 ? (
              <Muted>{data.plan ? "No series has gone quiet." : "Series appear here once Homer's plan exists."}</Muted>
            ) : (
              <div className="space-y-2">
                {data.quiet.map((r) => (
                  <QuietItem key={r.series_id} row={r} seriesAsin={data.seriesInfo[r.series_id]?.asin}
                             author={data.seriesInfo[r.series_id]?.author} />
                ))}
              </div>
            )}
          </Section>
          <Section title="Reading history" icon={<History className={icon} aria-hidden="true" />}>
            <HistoryList cards={data.history} />
          </Section>
        </>
      )}
    </div>
  );
}
