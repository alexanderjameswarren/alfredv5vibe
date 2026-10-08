import React from "react";
import { Menu, RefreshCw, Settings, Trash2, Wifi, WifiOff, X } from "lucide-react";
import AppLink from "./AppLink";
import ObjectIcon from "./ObjectIcon";

// The nav, as data. Rendered twice — a row of tabs on desktop, a list in the
// mobile drawer — from this one array, so the two cannot drift again.
//
// `count` names which counter decorates the label. `remembersReturn` marks the
// two destinations that record where you came from, so their own Back works;
// it was previously spelled as a `key === "sam" || key === "timer"` test in
// the drawer and as two hand-written onNavigate bodies on desktop.
const NAV_ITEMS = [
  { key: "home", label: "Home", icon: "home" },
  { key: "inbox", label: "Inbox", icon: "inbox", count: "inbox" },
  { key: "contexts", label: "Contexts", icon: "context" },
  { key: "schedule", label: "Schedule", icon: "schedule", count: "schedule" },
  { key: "intentions", label: "Intentions", icon: "intention" },
  { key: "memories", label: "Memories", icon: "item" },
  { key: "collections", label: "Collections", icon: "collection" },
  { key: "money", label: "Money", icon: "money" },
  { key: "timer", label: "Timer", icon: "timer", remembersReturn: true },
  { key: "sam", label: "Sam", icon: "sam", remembersReturn: true },
  { key: "games", label: "Games", icon: "games" },
];

// Alfred's header, mobile drawer and desktop tabs, moved out of Alfred.jsx
// unchanged. `menuOpen` stays Alfred's state and comes in as a prop.
export default function AppChrome({
  view,
  setView,
  setPreviousView,
  guardedSetView,
  confirmDiscardIfDirty,
  menuOpen,
  setMenuOpen,
  manualRefresh,
  realtimeStatus,
  handleSignOut,
  inboxItems,
  allNonArchivedEvents,
}) {
  // The counter for one NAV_ITEMS entry — Step 12.11.
  //
  // Returns the NUMBER, not a formatted label, because the desktop tabs drop
  // their text below xl and the count has to survive that. A tab reading just
  // an inbox glyph tells you nothing about whether there is anything in it.
  //
  // Zero renders nothing rather than "0": an empty inbox is the goal, and the
  // tab should look calm when you get there.
  function navCount(item) {
    const counts = {
      inbox: inboxItems.length,
      schedule: allNonArchivedEvents.length,
    };
    return item.count ? counts[item.count] || 0 : 0;
  }

  return (
    <>
      {/* Mobile header with hamburger */}
      <header className="sm:hidden sticky top-0 z-10 bg-white border-b border-border shadow-sm">
        <div className="px-3 py-3 flex items-center justify-between">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-foreground"
          >
            <Menu className="w-6 h-6" />
          </button>
          {/* Was a raw <a href="/">, so a plain click did a full page reload and
              never reached confirmDiscardIfDirty. AppLink keeps the same href
              and the same middle-click behaviour, and routes the plain click
              through the guard like the nav tabs. */}
          <AppLink
            view="home"
            onNavigate={() => guardedSetView("home")}
            className="text-lg font-bold text-foreground hover:text-foreground"
          >
            Alfred v5
          </AppLink>
          <div className="flex gap-1 items-center">
            <button
              onClick={manualRefresh}
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="Refresh data"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            {/* Connection status indicator */}
            <div
              className="flex items-center gap-1"
              title={realtimeStatus === 'connected' ? 'Connected' : realtimeStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
            >
              {realtimeStatus === 'connected' ? (
                <Wifi className="w-4 h-4 text-success" />
              ) : realtimeStatus === 'connecting' ? (
                <Wifi className="w-4 h-4 text-warning animate-pulse" />
              ) : (
                <WifiOff className="w-4 h-4 text-muted-foreground" />
              )}
            </div>
            <button
              onClick={() => guardedSetView("settings")}
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
            <button
              onClick={() => guardedSetView("recycle")}
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="Recycle Bin"
            >
              <Trash2 className="w-5 h-5" />
            </button>
            <button
              onClick={handleSignOut}
              className="text-sm px-3 py-1 text-muted-foreground hover:text-destructive transition-colors"
              title="Sign out"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Mobile slide-out menu */}
      {menuOpen && (
        <>
          <div
            className="sm:hidden fixed inset-0 bg-black bg-opacity-50 z-30"
            onClick={() => setMenuOpen(false)}
          />
          <nav className="sm:hidden fixed top-0 left-0 bottom-0 w-64 bg-white shadow-xl z-40">
            <div className="p-4 border-b border-border">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-foreground">Menu</h2>
                <button
                  onClick={() => setMenuOpen(false)}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-2">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  onClick={() => {
                    if (!confirmDiscardIfDirty()) return;
                    if (item.remembersReturn) setPreviousView(view);
                    setView(item.key);
                    setMenuOpen(false);
                  }}
                  className={`w-full text-left px-4 py-3 rounded-lg mb-1 ${
                    view === item.key
                      ? "bg-primary-light text-foreground font-medium"
                      : "text-foreground hover:bg-secondary/50"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <ObjectIcon type={item.icon} />
                    {item.label}
                    {navCount(item) > 0 && (
                      <span className="text-xs tabular-nums opacity-75">
                        {navCount(item)}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </nav>
        </>
      )}

      {/* Desktop header with tabs */}
      <div className="hidden sm:block sticky top-0 z-10 bg-white border-b border-border shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              {/* See the mobile logo above — same reason. */}
              <AppLink
                view="home"
                onNavigate={() => guardedSetView("home")}
                className="text-2xl font-bold text-foreground hover:text-foreground"
              >
                Alfred v5
              </AppLink>
              <p className="text-sm text-muted-foreground mt-1">
                Capture decisions. Hold intent. Execute with focus.
              </p>
            </div>
            <div className="flex gap-2 items-center">
              <button
                onClick={manualRefresh}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
                title="Refresh data"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              {/* Connection status indicator */}
              <div
                className="flex items-center gap-1"
                title={realtimeStatus === 'connected' ? 'Connected' : realtimeStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
              >
                {realtimeStatus === 'connected' ? (
                  <Wifi className="w-4 h-4 text-success" />
                ) : realtimeStatus === 'connecting' ? (
                  <Wifi className="w-4 h-4 text-warning animate-pulse" />
                ) : (
                  <WifiOff className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              <button
                onClick={() => guardedSetView("settings")}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
                title="Settings"
              >
                <Settings className="w-5 h-5" />
              </button>
              <button
                onClick={() => guardedSetView("recycle")}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
                title="Recycle Bin"
              >
                <Trash2 className="w-5 h-5" />
              </button>
              <button
                onClick={handleSignOut}
                className="text-sm px-3 py-1 text-muted-foreground hover:text-destructive transition-colors"
                title="Sign out"
              >
                Sign out
              </button>
            </div>
          </div>

          {/* Desktop navigation tabs — Step 12.10.

              Was ten hand-written AppLinks, each repeating the same class
              string and its own copy of the active-state ternary. They are now
              one map over NAV_ITEMS, which is the same array the mobile drawer
              renders.

              The icons are the reason for the merge, not a side effect of it:
              adding a glyph to each of two independent lists is precisely how
              the drawer's icons drifted from everything else in the first
              place. One array, one vocabulary, no way to update half of it. */}
          {/* Step 12.11. This bar has to hold ten destinations from 640px —
              where the mobile drawer stops — up to a wide desktop, and every
              one of them has to stay ONE tap away. That rules out an overflow
              menu: burying Sam behind a chevron is the one outcome worth
              avoiding.

              So the tabs compact instead of collapsing, in three tiers:

                640–1023   icon only, ~44px each — all ten fit in ~480px
                1024–1279  icon + label, tighter padding and text-sm
                1280+      icon + label, full padding

              `flex-wrap` is the safety net under all three. If a label ever
              runs longer than the arithmetic above assumes, the bar takes a
              second row rather than clipping Games off the end — a wrapped tab
              is still one tap, a clipped one is unreachable.

              The count survives the label: an inbox glyph on its own says
              nothing about whether there is anything in it, so the number
              renders separately and stays at every width. */}
          <nav className="flex flex-wrap gap-2 mt-3 pb-1">
            {NAV_ITEMS.map((item) => {
              const count = navCount(item);
              return (
                <AppLink
                  key={item.key}
                  view={item.key}
                  onNavigate={() => {
                    if (!confirmDiscardIfDirty()) return;
                    if (item.remembersReturn) setPreviousView(view);
                    setView(item.key);
                  }}
                  // The label is hidden at narrow widths, not removed, so the
                  // accessible name has to come from somewhere that survives.
                  title={item.label}
                  aria-label={item.label}
                  className={`inline-flex items-center justify-center gap-2 px-3 xl:px-4 py-2 rounded whitespace-nowrap min-h-[44px] min-w-[44px] text-sm xl:text-base ${
                    view === item.key
                      ? "bg-primary text-white shadow-sm"
                      : "bg-white text-foreground border border-border hover:border-primary"
                  }`}
                >
                  <ObjectIcon type={item.icon} />
                  <span className="hidden lg:inline">{item.label}</span>
                  {count > 0 && (
                    <span className="text-xs tabular-nums opacity-75">
                      {count}
                    </span>
                  )}
                </AppLink>
              );
            })}
          </nav>
        </div>
      </div>
    </>
  );
}
