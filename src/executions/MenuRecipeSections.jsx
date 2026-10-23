import React, { useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, SkipForward, Undo2 } from "lucide-react";
import ObjectIcon from "../shared/ObjectIcon";
import ExecutionElements from "./ExecutionElements";
import { useExecutionNotes } from "../notes/useExecutionNotes";

const sectionId = (run) => `recipe-${run.id}`;
const nameOf = (item) => item?.name || "Recipe";

/**
 * How far down the window the page's own pinned header reaches: the bottom of every
 * visible element pinned at top 0 (Alfred's header, AppChrome), measured, so the jump
 * bar sticks just under it on any screen. 0 when nothing is pinned. Exported for tests.
 */
export function pinnedTopHeight(root = document, exclude = null) {
  let bottom = 0;
  for (const el of root.querySelectorAll("header, nav, div")) {
    if (el === exclude || exclude?.contains(el)) continue;
    const style = window.getComputedStyle(el);
    if ((style.position !== "sticky" && style.position !== "fixed") || style.top !== "0px") continue;
    const rect = el.getBoundingClientRect();
    if (rect.height > 0 && rect.width > 0 && rect.top <= 0.5) bottom = Math.max(bottom, rect.bottom);
  }
  return bottom;
}

/** Where to scroll so a section's header lands right under the bar. Pure. */
export function jumpTarget({ sectionTop, scrollY, barBottom }) {
  return Math.max(0, Math.round(sectionTop + scrollY - barBottom));
}

/**
 * The cooking page's recipes (Restructure P5 step 14): a sticky jump bar of recipe
 * names that scrolls sideways, then one collapsible section per recipe with its
 * steps, its own note (on the recipe, with that recipe run's execution_id) and Skip.
 * A skipped recipe closes as 'skipped' when the menu completes; Unskip takes it back.
 */
export default function MenuRecipeSections({ recipes, closed, loading = false, onToggleElement, onUpdateElement, onSkip, onOpenSettings }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const barRef = useRef(null);
  const [barTop, setBarTop] = useState(0);
  // Measured on mount and on resize: the header's height differs on phone and desktop.
  useLayoutEffect(() => {
    const measure = () => setBarTop(pinnedTopHeight(document, barRef.current));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const toggle = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  function jumpTo(run) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(run.id);
      return next;
    });
    // After the reopen renders: the section's header goes right under the bar.
    requestAnimationFrame(() => {
      const section = document.getElementById(sectionId(run));
      if (!section || !barRef.current) return;
      const top = jumpTarget({
        sectionTop: section.getBoundingClientRect().top,
        scrollY: window.scrollY,
        barBottom: barTop + barRef.current.getBoundingClientRect().height,
      });
      window.scrollTo?.({ top, behavior: "smooth" });
    });
  }

  if (loading) {
    return <p className="mb-6 border-t border-border pt-4 text-sm text-muted-foreground">Loading recipes…</p>;
  }
  if (recipes.length === 0) {
    return <p className="mb-6 border-t border-border pt-4 text-sm text-muted-foreground">No recipes in this menu.</p>;
  }

  return (
    <div className="mb-6 border-t border-border pt-2">
      {/* Sticks just under Alfred's own pinned header (measured), never over it. */}
      <nav
        ref={barRef}
        aria-label="Recipes"
        style={{ top: barTop }}
        className="sticky z-[5] -mx-1 px-1 py-2 bg-background flex gap-2 overflow-x-auto whitespace-nowrap"
      >
        {recipes.map(({ run, item }) => (
          <button
            key={run.id}
            type="button"
            onClick={() => jumpTo(run)}
            className={`shrink-0 px-3 min-h-[36px] rounded-full border border-border text-sm ${
              run.outcome === "skipped" ? "text-muted-foreground line-through" : "text-foreground"
            } hover:bg-secondary`}
          >
            {nameOf(item)}
          </button>
        ))}
      </nav>
      <div className="space-y-4 mt-2">
        {recipes.map(({ run, item }) => (
          <RecipeSection
            key={run.id}
            run={run}
            item={item}
            closed={closed}
            open={!collapsed.has(run.id)}
            onToggleOpen={() => toggle(run.id)}
            onToggleElement={(i) => onToggleElement(run, i)}
            onUpdateElement={(i, fields) => onUpdateElement(run, i, fields)}
            onSkip={onSkip}
            onOpenSettings={onOpenSettings}
          />
        ))}
      </div>
    </div>
  );
}

function RecipeSection({ run, item, closed, open, onToggleOpen, onToggleElement, onUpdateElement, onSkip, onOpenSettings }) {
  const skipped = run.outcome === "skipped";
  const notes = useExecutionNotes({ executionId: run.id, target: item ? { type: "item", id: item.id } : null });
  const name = nameOf(item);
  return (
    <section id={sectionId(run)} aria-label={name} className="border border-border rounded-lg">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          className="flex-1 min-w-0 flex items-center gap-2 min-h-[44px] text-left font-medium"
        >
          {open ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
          <ObjectIcon type="item" className="w-4 h-4 text-primary" />
          <span className={`min-w-0 truncate ${skipped ? "line-through text-muted-foreground" : ""}`}>{name}</span>
          {skipped && <span className="shrink-0 text-xs text-muted-foreground no-underline">Skipped</span>}
          {/* A finished cook marks each recipe (step 14b). */}
          {closed && !skipped && (
            <span className="shrink-0 inline-flex items-center gap-1 text-xs text-foreground">
              <Check className="w-3.5 h-3.5" />
              Done
            </span>
          )}
        </button>
        {!closed && (
          <button
            type="button"
            onClick={() => onSkip(run, !skipped)}
            className="shrink-0 flex items-center gap-1.5 px-3 min-h-[44px] rounded-lg bg-secondary text-foreground text-sm"
          >
            {skipped ? <Undo2 className="w-4 h-4" /> : <SkipForward className="w-4 h-4" />}
            {skipped ? "Unskip" : "Skip"}
          </button>
        )}
      </div>
      {open && (
        <div className="px-3 pb-3 border-t border-border pt-3">
          {run.elements?.length ? (
            <ExecutionElements
              execution={run}
              closed={closed || skipped}
              onToggleElement={onToggleElement}
              onUpdateElement={onUpdateElement}
              onOpenSettings={onOpenSettings}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No steps.</p>
          )}
          <textarea
            aria-label={`Note on ${name}`}
            value={notes.draft}
            onChange={(e) => notes.setDraft(e.target.value)}
            onBlur={() => notes.save()}
            disabled={!notes.loaded || !item}
            placeholder={notes.loaded ? `Notes on ${name}...` : "Loading notes…"}
            className="mt-3 w-full px-3 py-2 border border-border rounded-lg text-base bg-input-background min-h-[72px] disabled:opacity-60"
          />
          {notes.saveState === "error" && <p className="text-xs text-destructive mt-1">Note not saved. Tap outside the box to try again.</p>}
        </div>
      )}
    </section>
  );
}
