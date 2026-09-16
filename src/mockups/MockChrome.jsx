import React from "react";
import {
  ArrowLeft, Play, Disc, Repeat, ChevronDown, Archive, ArchiveRestore,
  Download, AudioWaveform, RefreshCw, Wand2, SlidersHorizontal, FolderOpen,
} from "lucide-react";

// Real SAM chrome, copied class-for-class from the live components so the stats
// block is judged in context rather than floating on a blank page. Static only.

function UtilityCluster() {
  const btn =
    "flex items-center gap-1 text-sm text-foreground hover:text-primary min-h-[44px] px-2";
  return (
    <div className="flex items-center gap-2">
      <span className={btn}><Download className="w-3.5 h-3.5" />Export</span>
      <span className={btn}><AudioWaveform className="w-3.5 h-3.5" />Audio</span>
      <span className={btn}><RefreshCw className="w-3.5 h-3.5" />Refresh</span>
      <span className={btn}><Wand2 className="w-3.5 h-3.5" />Auto-Match</span>
      <span className={btn}><FolderOpen className="w-3.5 h-3.5" />Change Song</span>
    </div>
  );
}

// `compact` drops BPM and Repeat, for option D where they get a row of their own.
export function TransportRow({ compact = false }) {
  return (
    <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
      <div className="flex items-center gap-3">
        <span className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground rounded shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </span>

        <span className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm bg-primary text-white">
          <Play className="w-4 h-4" />
          Play
        </span>

        <span className="flex items-center gap-1.5 px-3 py-2 rounded min-h-[44px] text-sm font-medium border border-border text-muted-foreground">
          <Disc className="w-4 h-4" />
          Full Song
        </span>

        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-dark">
            Pastorale No. 3
            <span className="text-muted-foreground font-normal">
              {" "}(full song · 60 BPM)
            </span>
            <span className="text-muted-foreground"> — Burgmüller</span>
          </h2>
        </div>

        {!compact && (
          <>
            <label className="text-sm text-foreground">
              BPM:{" "}
              <span className="inline-flex items-center w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]">
                60
              </span>
            </label>

            <span
              title="Repeat whole song"
              className="px-2 py-1 border rounded min-h-[44px] flex items-center border-border text-muted"
            >
              <Repeat className="w-4 h-4" />
            </span>
          </>
        )}
      </div>

      <UtilityCluster />
    </div>
  );
}

// Option D: BPM / Tuning / Repeat on a row of their own beneath Play, with
// whatever `trailing` holds pushed to the right so it sits under Change Song.
export function SettingsRow({ trailing = null }) {
  return (
    <div className="flex items-center gap-3 mb-3 flex-wrap">
      <label className="text-sm text-foreground">
        BPM:{" "}
        <span className="inline-flex items-center w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]">
          60
        </span>
      </label>

      <span className="flex items-center gap-1.5 px-2 py-1 border rounded text-sm min-h-[44px] border-border text-muted-foreground">
        <SlidersHorizontal className="w-4 h-4" />
        Tuning
      </span>

      <span
        title="Repeat whole song"
        className="px-2 py-1 border rounded min-h-[44px] flex items-center border-border text-muted"
      >
        <Repeat className="w-4 h-4" />
      </span>

      {trailing}
    </div>
  );
}

// Loop / Hits / Misses / Session Accuracy / Playthrough Accuracy.
// `trailing` lets option B hang the day total off the right-hand end.
export function SessionRow({ trailing = null }) {
  return (
    <div className="flex items-center gap-4 mb-2 px-1 text-sm text-muted-foreground flex-wrap">
      <span>Loop: <strong className="text-dark">2</strong></span>
      <span>Hits: <strong className="text-success">184</strong></span>
      <span>Misses: <strong className="text-destructive">23</strong></span>
      <span>Session Accuracy: <strong className="text-dark">89%</strong></span>
      <span>
        Playthrough Accuracy: <strong className="text-dark">94%</strong>
        <span className="ml-1 opacity-70">(47/50)</span>
      </span>
      {trailing}
    </div>
  );
}

// The snippet panel, open, with each option supplying its own row renderer.
// `header` is an optional legend line above the list (option B).
export function SnippetPanelShell({ snippets, renderRow, header = null, listAsTable = null }) {
  const live = snippets.filter((s) => !s.archived);
  const archived = snippets.filter((s) => s.archived);

  return (
    <div className="mb-3">
      <span className="flex items-center gap-1 text-sm font-medium text-muted-foreground min-h-[44px] px-1">
        <ChevronDown className="w-4 h-4" />
        Snippet
      </span>

      <div className="mt-1 p-3 bg-card border border-border rounded-lg text-sm">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-muted-foreground">
            Start:{" "}
            <span className="inline-flex items-center w-14 px-2 py-1 border border-border rounded text-sm min-h-[44px]">1</span>
          </label>
          <label className="text-muted-foreground">
            End:{" "}
            <span className="inline-flex items-center w-14 px-2 py-1 border border-border rounded text-sm min-h-[44px]">32</span>
          </label>
          <div className="flex items-center gap-1 text-muted-foreground">
            Rest:
            <span className="w-8 h-8 flex items-center justify-center border border-border rounded text-lg min-h-[44px] min-w-[44px]">−</span>
            <span className="w-6 text-center font-medium text-dark">0</span>
            <span className="w-8 h-8 flex items-center justify-center border border-border rounded text-lg min-h-[44px] min-w-[44px]">+</span>
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            Hand:
            <span className="px-2 py-1 border rounded text-sm min-h-[44px] flex items-center border-primary bg-primary-light text-primary font-medium">Both</span>
            <span className="px-2 py-1 border rounded text-sm min-h-[44px] flex items-center border-border">LH</span>
            <span className="px-2 py-1 border rounded text-sm min-h-[44px] flex items-center border-border">RH</span>
          </div>
        </div>

        {listAsTable ? (
          <div className="mt-3 border-t border-border pt-3">{listAsTable}</div>
        ) : (
          <>
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-xs text-muted-foreground mb-2 font-medium">Saved snippets</div>
              {header}
              <div className="flex flex-col gap-1">
                {live.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-1 rounded text-sm min-h-[44px] text-dark hover:bg-secondary"
                  >
                    <div className="flex-1 min-w-0 flex items-center gap-3 flex-wrap text-left px-3 py-2">
                      {renderRow(s)}
                    </div>
                    <span className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground">
                      <Archive className="w-3.5 h-3.5" />
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="text-center mt-2">
              <span className="text-xs text-muted-foreground min-h-[44px] px-2 inline-flex items-center">
                Hide archived snippets
              </span>
              <div className="mt-1 text-left">
                <div className="text-xs text-muted-foreground mb-2 font-medium">Archived</div>
                {header}
                <div className="flex flex-col gap-1">
                  {archived.map((s) => (
                    <div key={s.id} className="flex items-center gap-1 rounded text-sm min-h-[44px] opacity-60">
                      <div className="flex-1 min-w-0 flex items-center gap-3 flex-wrap px-3 py-2">
                        {renderRow(s)}
                      </div>
                      <span className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground">
                        <ArchiveRestore className="w-3.5 h-3.5" />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Stand-in for the score, so the block is seen with something below it.
export function ScorePlaceholder() {
  return (
    <div className="border border-dashed border-border rounded-lg h-24 flex items-center justify-center text-xs text-muted-foreground">
      (score)
    </div>
  );
}
