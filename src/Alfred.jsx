import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  pathToView,
  viewToPath,
  normalizePath,
  isKnownPath,
  parentPath,
  DEFAULT_PATH,
  executionPath,
} from "./viewPaths";
import { useExecutionRoute } from "./useExecutionRoute";
import AppLink from "./AppLink";
import UndoMessage, { useUndo } from "./UndoMessage";
import SortControl, { useSortPreference } from "./SortControl";
import GamesPage from "./games/GamesPage";
import { sortRows } from "./utils/sortOrders";
import { offsetPatch, isFirstStep } from "./utils/elementOffsets";
import {
  createNotificationSteps,
  completeNotificationStep,
  cancelNotificationSteps,
  resumeNotificationSteps,
} from "./utils/notificationStepsApi";
import {
  parseIngredient,
  matchProduct,
  findNearMisses,
} from "./utils/ingredientMatch";
import {
  Plus,
  Share2,
  Play,
  Pause,
  Check,
  X,
  Trash2,
  ArrowLeft,
  Menu,
  Copy,
  ChevronDown,
  GripVertical,
  Settings,
  Archive,
  Sparkles,
  Wifi,
  WifiOff,
  Home,
  Inbox,
  FolderOpen,
  Calendar,
  Lightbulb,
  Star,
  ClipboardList,
  Music,
  Pin,
  Bot,
  Mail,
  Info,
  Timer,
  Pencil,
  RefreshCw,
  ArchiveRestore,
  Gamepad2,
} from "lucide-react";
import { supabase, supabaseUrl } from "./supabaseClient";
import { calculateNextEventDate, getRecurrenceConfig } from "./utils/recurrence";
import { getRecurrenceDisplayString } from "./utils/recurrenceDisplay";
import { toCamelCase, toSnakeCase } from "./utils/caseConvert";
import {
  loadMembers,
  loadRemovals,
  addMembers,
  addOrMergeMembers,
  removeMember,
  removeMembers,
  reAddRemoval,
  updateMemberQuantity,
  reorderMembers,
  REMOVAL_MANUAL,
  REMOVAL_COMPLETED,
} from "./utils/collectionMembers";
import SamPlayer from "./sam/SamPlayer";
import TimerPage from "./timer/TimerPage";

const storage = {
  // Map key prefixes to table names
  tableMap: {
    context: "contexts",
    item: "items",
    intent: "intents",
    event: "events",
    execution: "executions",
    inbox: "inbox",
    item_collections: "item_collections",
  },

  // Key-case conversion between camelCase React state and snake_case Postgres.
  // The implementation lives in utils/caseConvert.js so that this file and the
  // collection membership layer share one copy. Kept as storage properties
  // because callers throughout this file go through storage.toCamelCase(...).
  toSnakeCase,
  toCamelCase,

  async get(key, shared = false) {
    try {
      const [prefix, id] = key.split(":");
      const table = this.tableMap[prefix];

      if (!table || !id) {
        console.error("Invalid key format:", key);
        return null;
      }

      const { data, error } = await supabase
        .from(table)
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (error) {
        if (error.code === "PGRST116") return null; // Not found
        throw error;
      }

      return this.toCamelCase(data);
    } catch (e) {
      console.error("Storage get error:", e);
      return null;
    }
  },

  async set(key, value, shared = false) {
    try {
      const [prefix, id] = key.split(":");
      const table = this.tableMap[prefix];

      if (!table) {
        console.error("Invalid key prefix:", prefix);
        return false;
      }

      const dbValue = this.toSnakeCase(value);

      if (id) {
        // Try update first (works for both owned and shared records)
        const { data: updated, error: updateError } = await supabase
          .from(table)
          .update(dbValue)
          .eq("id", id)
          .select("id");

        if (updateError) throw updateError;

        // If update matched no rows, this is a new record — insert
        if (!updated || updated.length === 0) {
          const { error: insertError } = await supabase
            .from(table)
            .insert(dbValue);
          if (insertError) throw insertError;
        }
      } else {
        // No id in key — straight insert
        const { error } = await supabase.from(table).insert(dbValue);
        if (error) throw error;
      }

      return true;
    } catch (e) {
      console.error("Storage set error:", e, "Key:", key, "Value:", value);
      return false;
    }
  },

  async list(prefix, shared = false) {
    try {
      const cleanPrefix = prefix.replace(":", "");
      const table = this.tableMap[cleanPrefix];

      if (!table) {
        console.error("Invalid prefix:", prefix);
        return [];
      }

      const { data, error } = await supabase.from(table).select("id");

      if (error) throw error;
      return data ? data.map((row) => `${cleanPrefix}:${row.id}`) : [];
    } catch (e) {
      console.error("Storage list error:", e);
      return [];
    }
  },

  async delete(key, shared = false) {
    try {
      const [prefix, id] = key.split(":");
      const table = this.tableMap[prefix];

      if (!table || !id) {
        console.error("Invalid key format:", key);
        return false;
      }

      const { error } = await supabase.from(table).delete().eq("id", id);

      if (error) throw error;
      return true;
    } catch (e) {
      console.error("Storage delete error:", e);
      return false;
    }
  },
};

const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).substr(2);

// Flatten elements that reference other items (via itemId) into a single array with indent levels.
// itemsMap: object keyed by item id -> item, or a lookup function
async function flattenElements(elements, getItem, depth = 0, visited = new Set()) {
  if (depth >= 3) return elements.map((el) => ({ ...el, indent: depth }));
  const result = [];
  for (const el of elements) {
    const itemId = el.itemId || el.item_id;
    if (itemId && !visited.has(itemId)) {
      const childItem = typeof getItem === "function" ? await getItem(itemId) : null;
      if (childItem && childItem.elements && childItem.elements.length > 0) {
        // Add a header for the referenced item
        result.push({ ...el, displayType: "header", indent: depth });
        visited.add(itemId);
        const childFlattened = await flattenElements(
          childItem.elements, getItem, depth + 1, visited
        );
        result.push(...childFlattened);
      } else {
        // Deleted or missing child — show placeholder
        result.push({ ...el, indent: depth, missing: !childItem });
      }
    } else if (itemId && visited.has(itemId)) {
      // Circular reference detected — skip
      result.push({ ...el, indent: depth, circular: true });
    } else {
      result.push({ ...el, indent: depth });
    }
  }
  return result;
}

// Test suite for flattenElements — run via: window.testFlatten()
window.testFlatten = async function () {
  let passed = 0;
  let failed = 0;

  function assert(name, condition) {
    if (condition) { console.log(`  ✅ ${name}`); passed++; }
    else { console.error(`  ❌ ${name}`); failed++; }
  }

  console.log("=== flattenElements tests ===");

  // Test 1: Simple reference (depth 1)
  const items1 = {
    childA: { elements: [{ name: "Child step 1", displayType: "step" }, { name: "Child step 2", displayType: "step" }] },
  };
  const r1 = await flattenElements(
    [{ name: "Header", displayType: "header" }, { name: "Ref", displayType: "bullet", itemId: "childA" }],
    (id) => items1[id]
  );
  assert("1. Simple ref: correct count", r1.length === 4);
  assert("1. Simple ref: header at indent 0", r1[0].indent === 0);
  assert("1. Simple ref: child steps at indent 1", r1[2].indent === 1 && r1[3].indent === 1);

  // Test 2: Nested reference (depth 2)
  const items2 = {
    b: { elements: [{ name: "B step", displayType: "step", itemId: "c" }] },
    c: { elements: [{ name: "C step", displayType: "step" }] },
  };
  const r2 = await flattenElements(
    [{ name: "A ref B", displayType: "bullet", itemId: "b" }],
    (id) => items2[id]
  );
  assert("2. Nested ref: has depth 2 element", r2.some((e) => e.indent === 2));

  // Test 3: Max depth (stops at depth 3)
  const items3 = {
    d1: { elements: [{ name: "d1", displayType: "step", itemId: "d2" }] },
    d2: { elements: [{ name: "d2", displayType: "step", itemId: "d3" }] },
    d3: { elements: [{ name: "d3", displayType: "step", itemId: "d4" }] },
    d4: { elements: [{ name: "d4 deep", displayType: "step" }] },
  };
  const r3 = await flattenElements(
    [{ name: "top", displayType: "step", itemId: "d1" }],
    (id) => items3[id]
  );
  assert("3. Max depth: no element beyond indent 3", r3.every((e) => e.indent <= 3));

  // Test 4: Circular reference
  const items4 = {
    loopA: { elements: [{ name: "A", displayType: "step", itemId: "loopB" }] },
    loopB: { elements: [{ name: "B", displayType: "step", itemId: "loopA" }] },
  };
  const r4 = await flattenElements(
    [{ name: "start", displayType: "step", itemId: "loopA" }],
    (id) => items4[id]
  );
  assert("4. Circular ref: has circular flag", r4.some((e) => e.circular === true));
  assert("4. Circular ref: terminates", r4.length < 20);

  // Test 5: Deleted child (returns null)
  const r5 = await flattenElements(
    [{ name: "Ref deleted", displayType: "step", itemId: "gone" }],
    () => null
  );
  assert("5. Deleted child: marks missing", r5[0].missing === true);
  assert("5. Deleted child: still in result", r5.length === 1);

  // Test 6: Missing child (returns undefined)
  const r6 = await flattenElements(
    [{ name: "Ref missing", displayType: "step", itemId: "nope" }],
    () => undefined
  );
  assert("6. Missing child: marks missing", r6[0].missing === true);

  // Test 7: Multiple references
  const items7 = {
    m1: { elements: [{ name: "M1 step", displayType: "step" }] },
    m2: { elements: [{ name: "M2 step", displayType: "step" }] },
  };
  const r7 = await flattenElements(
    [
      { name: "Ref M1", displayType: "bullet", itemId: "m1" },
      { name: "Ref M2", displayType: "bullet", itemId: "m2" },
    ],
    (id) => items7[id]
  );
  assert("7. Multiple refs: both flattened", r7.length === 4);
  assert("7. Multiple refs: M1 step present", r7.some((e) => e.name === "M1 step"));
  assert("7. Multiple refs: M2 step present", r7.some((e) => e.name === "M2 step"));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  return { passed, failed };
};

/**
 * A Date rendered as the "YYYY-MM-DD" the app stores in `events.time`.
 *
 * Built from the LOCAL calendar fields, never `toISOString()`. That method
 * converts to UTC first, which shifts the date across the day boundary by the
 * zone offset:
 *
 *   now, at 18:30 in Pacific     -> UTC is already tomorrow  -> tomorrow's date
 *   local midnight, in Berlin    -> UTC is still yesterday   -> yesterday's date
 *
 * The two directions bit in two different places. `getTodayDate` was wrong every
 * evening in the Americas; `triggerRecurrence`'s serialisation was wrong all day
 * east of Greenwich and only looked right here by accident. One helper, so a
 * third caller cannot pick the broken idiom again.
 *
 * The counterpart for reading is `formatEventDate`, which appends "T00:00:00"
 * before parsing for the same reason, and `parseLocalDate` in utils/recurrence.js.
 */
function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTodayDate() {
  return toLocalDateString(new Date());
}

function formatEventDate(dateString) {
  const eventDate = new Date(dateString + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  eventDate.setHours(0, 0, 0, 0);

  const isToday = eventDate.getTime() === today.getTime();

  if (isToday) {
    return 'Today, ' + eventDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  }
  return eventDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// --- List sort options (Step 9b, docs/technical-spec-ui-standardization.md) --
//
// One list per page rather than one shared list, because the fields genuinely
// differ: an event has a scheduled date, a capture has a suggested one, a
// context has neither. The spec's rule is "show only applicable options; do not
// render disabled ones".
//
// "Name" maps to the key `title` throughout. That is not cosmetic — the shared
// comparator uses `get.title` as its tiebreaker for EVERY order, so the name
// accessor has to live under that key whether or not the page offers Name as a
// choice. See utils/sortOrders.js.

const EVENT_SORT_OPTIONS = [
  // "Scheduled date", never "Date" — an event also has a created date and a
  // modified date, and this is the one the user thinks of as the event's own.
  { value: "time", label: "Scheduled date", defaultDir: "asc" },
  // On these two pages the row is an EVENT, so "Created" means when it was
  // scheduled, not when the intention behind it was conceived.
  { value: "created", label: "Created", defaultDir: "desc" },
  { value: "updated", label: "Last modified", defaultDir: "desc" },
  { value: "title", label: "Name", defaultDir: "asc" },
];

const INBOX_SORT_OPTIONS = [
  { value: "created", label: "Created", defaultDir: "desc" },
  { value: "updated", label: "Last modified", defaultDir: "desc" },
  // Populated only by AI enrichment, so it is null on every un-enriched
  // capture. Nulls sort last in both directions, which means an all-null inbox
  // collapses to the title tiebreaker rather than shuffling — predictable, if
  // not useful until enrichment has run.
  { value: "suggested", label: "Suggested date", defaultDir: "asc" },
  { value: "title", label: "Name", defaultDir: "asc" },
];

// Contexts and Collections carry the same three, and the same accessors.
const NAMED_RECORD_SORT_OPTIONS = [
  { value: "title", label: "Name", defaultDir: "asc" },
  { value: "created", label: "Created", defaultDir: "desc" },
  { value: "updated", label: "Last modified", defaultDir: "desc" },
];

const NAMED_RECORD_ACCESSORS = {
  title: (r) => r.name,
  created: (r) => r.createdAt,
  updated: (r) => r.updatedAt,
};

const INBOX_ACCESSORS = {
  title: (r) => r.capturedText,
  created: (r) => r.createdAt,
  updated: (r) => r.updatedAt,
  suggested: (r) => r.suggestedEventDate,
};

function LoginScreen() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleGoogleLogin() {
    setLoading(true);
    setError('');

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        // `href`, not `origin`. Step 9: `origin` is scheme+host+port by
        // definition, so signing in from a deep link used to discard the
        // destination and dump the user on the home screen. That is the
        // difference between a URL you can share and a URL that only works
        // for someone already signed in.
        //
        // Paths are known to be accepted by the project's redirect allow-list
        // — OAuthConsent has always passed `window.location.href` with a query
        // string. Under PKCE the callback appends `?code=`, which auth-js
        // strips after the exchange, leaving the original address intact.
        redirectTo: window.location.href
      }
    });

    if (error) {
      setError('Login failed: ' + error.message);
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="w-full max-w-md p-8 bg-white rounded-lg shadow-md">
        <h1 className="text-2xl font-bold text-foreground mb-2 text-center">Alfred v5</h1>
        <p className="text-sm text-muted-foreground text-center mb-6">Household task management</p>

        {error && (
          <div className="mb-4 p-3 bg-destructive-light border border-destructive text-destructive rounded-lg text-sm">
            {error}
          </div>
        )}

        <button
          onClick={handleGoogleLogin}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white border-2 border-border rounded-lg hover:border-primary hover:bg-secondary/50 transition-colors disabled:opacity-50"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          {loading ? 'Signing in...' : 'Continue with Google'}
        </button>
      </div>
    </div>
  );
}

function LoadingOverlay({ message }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-8 flex flex-col items-center gap-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        <p className="text-foreground font-medium">{message || 'Loading...'}</p>
      </div>
    </div>
  );
}

function TagInput({ value = [], onChange, placeholder = "Add tags (comma separated)" }) {
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState("");

  function processTags(raw) {
    return raw
      .split(",")
      .map((t) => t.toLowerCase().trim())
      .filter((t) => t.length > 0 && t.length <= 50)
      .filter((t) => /^[a-z0-9_-]+$/.test(t));
  }

  function addTags() {
    if (!inputValue.trim()) return;
    const rawParts = inputValue.split(",").map((t) => t.toLowerCase().trim()).filter((t) => t.length > 0);
    const validTags = processTags(inputValue);
    const rejected = rawParts.filter((t) => !validTags.includes(t));
    if (rejected.length > 0) {
      setError("Invalid tags removed (use only letters, numbers, hyphens, underscores)");
      setTimeout(() => setError(""), 3000);
    }
    if (value.length >= 20) {
      setError("Maximum 20 tags allowed");
      setTimeout(() => setError(""), 3000);
      setInputValue("");
      return;
    }
    const merged = [...new Set([...value, ...validTags])].slice(0, 20);
    onChange(merged);
    setInputValue("");
  }

  function removeTag(tag) {
    onChange(value.filter((t) => t !== tag));
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      addTags();
    }
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={addTags}
          placeholder={placeholder}
          className="flex-1 min-w-0 px-3 py-2 min-h-[44px] border border-border rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      {error && (
        <p className="text-xs text-destructive mt-1">{error}</p>
      )}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-warning-light text-accent-foreground text-xs rounded-full"
            >
              {tag}
              <button
                onClick={() => removeTag(tag)}
                className="p-1 hover:text-primary"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TagFilter({ entities, activeTag, onFilter }) {
  const tagCounts = {};
  for (const entity of entities) {
    if (entity.tags) {
      for (const tag of entity.tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
  }

  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

  if (sortedTags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {sortedTags.map(([tag, count]) => (
        <button
          key={tag}
          onClick={() => onFilter(activeTag === tag ? null : tag)}
          className={`px-3 py-1.5 text-sm rounded-full transition-colors ${
            activeTag === tag
              ? "bg-primary text-white"
              : "bg-warning-light text-accent-foreground hover:bg-accent/80"
          }`}
        >
          {tag} ({count})
        </button>
      ))}
      {activeTag && (
        <button
          onClick={() => onFilter(null)}
          className="px-3 py-1.5 text-sm rounded-full bg-secondary text-muted-foreground hover:bg-secondary"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function CollectionAddItems({ availableItems, contexts, onAdd, onCancel, maxItems, collection, onCreateItem }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState({});

  const filtered = search.trim()
    ? availableItems.filter((item) =>
        item.name.toLowerCase().includes(search.toLowerCase()) ||
        (item.tags && item.tags.some((t) => t.includes(search.toLowerCase())))
      )
    : availableItems;

  function toggleItem(itemId) {
    setSelected((prev) => {
      if (prev[itemId]) {
        const next = { ...prev };
        delete next[itemId];
        return next;
      }
      if (Object.keys(prev).length >= maxItems) return prev;
      return { ...prev, [itemId]: { itemId, quantity: "" } };
    });
  }

  function setQuantity(itemId, quantity) {
    setSelected((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], quantity },
    }));
  }

  return (
    <div>
      <button
        onClick={onCancel}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Collection
      </button>

      <h2 className="text-lg font-medium mb-3">Add Items to Collection</h2>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search items by name or tag..."
        className="w-full px-3 py-2 border border-border rounded-lg text-base mb-3"
        autoFocus
      />

      <div className="space-y-2 mb-4" style={{ maxHeight: "50vh", overflowY: "auto" }}>
        {filtered.length === 0 && search.trim() ? (
          <div className="py-2">
            <button
              onClick={() => onCreateItem(search.trim())}
              className="w-full flex items-center gap-3 px-4 py-3 border-2 border-dashed border-primary rounded-lg hover:bg-primary/5 transition-colors"
            >
              <Plus className="w-5 h-5 text-primary flex-shrink-0" />
              <div className="text-left flex-1 min-w-0">
                <div className="font-medium text-primary">Create "{search.trim()}"</div>
                <div className="text-sm text-muted-foreground">
                  Add as new item{collection?.contextId && contexts ? ` in ${contexts.find(c => c.id === collection.contextId)?.name || 'this context'}` : ''}
                </div>
              </div>
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">No matching items</p>
        ) : (
          filtered.map((item) => {
            const isSelected = !!selected[item.id];
            const contextName = item.contextId && contexts
              ? contexts.find((c) => c.id === item.contextId)?.name
              : null;
            return (
              <div
                key={item.id}
                className={`flex items-center gap-2 p-3 border rounded cursor-pointer ${
                  isSelected ? "border-primary bg-background" : "border-border bg-white hover:border-primary"
                }`}
                onClick={() => toggleItem(item.id)}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded accent-primary pointer-events-none"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{item.name}</p>
                  {contextName && (
                    <span className="text-xs text-muted-foreground">{contextName}</span>
                  )}
                </div>
                {isSelected && (
                  <input
                    type="text"
                    value={selected[item.id]?.quantity || ""}
                    onChange={(e) => {
                      e.stopPropagation();
                      setQuantity(item.id, e.target.value);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="Qty"
                    className="w-20 sm:w-24 px-2 py-2 border border-border rounded text-base"
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Same offsets as ContextForm's. Note this one will rarely engage: the
          item list above is capped at 50vh with its own scrollbar, so the page
          as a whole does not usually exceed the viewport. It is here for the
          cases that do — a very short window, or if that cap is ever lifted —
          rather than because it changes anything today. */}
      <div className="flex gap-2 sticky bottom-28 sm:bottom-32 pt-2 pb-3 bg-background border-t border-border">
        <button
          onClick={() => onAdd(Object.values(selected))}
          disabled={Object.keys(selected).length === 0}
          className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm disabled:opacity-50 text-sm"
        >
          Add {Object.keys(selected).length > 0 ? `(${Object.keys(selected).length})` : ""} to Collection
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Add to Collection — resolve an item's collectable elements to items in a
 * target collection's context, and pick which to add.
 *
 * Step 6 is read-only: it resolves, displays and lets the user adjust, but
 * writes nothing. The footer is inert.
 *
 * Measured on the real corpus, 55% of rows resolve to nothing and must create a
 * new item, so create-new is the common path and costs exactly one tap: the row
 * checkbox itself commits to it. There is no dialog and no detour. Rows that
 * failed to match but have plausible alternatives show them as chips, each of
 * which retargets and checks the row in one tap — that is what stops the
 * Shopping context growing "Salt", "kosher salt" and "Sea salt" separately.
 */
function ItemAddToCollection({ item, items, collections, contexts, onBack, onAdd }) {
  const available = useMemo(
    () => (collections || []).filter((c) => !c.archived),
    [collections],
  );

  // Preselect: the item context's default collection, then a capture target in
  // that context, then any capture target, then the first collection.
  //
  // The third rule is not in the spec. Without it the driving case never fires:
  // Groceries is the capture target but lives in Shopping, while recipes live
  // in Recipes, so rule two cannot match and an arbitrary "first collection"
  // wins. Preferring a capture target anywhere over an arbitrary one is
  // strictly better; flagged for review.
  const defaultCollectionId = useMemo(() => {
    const ctx = (contexts || []).find((c) => c.id === item.contextId);
    const pinned =
      ctx && ctx.defaultCollectionId
        ? available.find((c) => c.id === ctx.defaultCollectionId)
        : null;
    if (pinned) return pinned.id;
    const captureHere = available.find(
      (c) => c.isCaptureTarget && c.contextId === item.contextId,
    );
    if (captureHere) return captureHere.id;
    const captureAnywhere = available.find((c) => c.isCaptureTarget);
    if (captureAnywhere) return captureAnywhere.id;
    return available[0] ? available[0].id : "";
  }, [available, contexts, item.contextId]);

  const [collectionId, setCollectionId] = useState(defaultCollectionId);
  const [overrides, setOverrides] = useState({});
  const [pickerRow, setPickerRow] = useState(null);
  const [pickerSearch, setPickerSearch] = useState("");

  const collection = available.find((c) => c.id === collectionId) || null;
  const targetContextId = collection ? collection.contextId ?? null : null;

  // Targets are context-specific, so a change of collection invalidates every
  // resolved row. Reset rather than carry stale targets across.
  useEffect(() => {
    setOverrides({});
  }, [collectionId]);

  /**
   * Resolve once per (item, collection). Ordering is computed here and frozen:
   * unmatched first, then matched in recipe order. It deliberately does not
   * depend on `overrides`, because re-sorting as the user accepts a suggestion
   * would move rows out from under a thumb mid-tap.
   */
  const rows = useMemo(() => {
    const elements = Array.isArray(item.elements) ? item.elements : [];
    const typeOf = (el) => el.displayType || el.display_type || "step";
    // Carry the index into item.elements, not into the filtered list: Step 7
    // stamps collectable/collectableItemId back onto the original array.
    const indexed = elements.map((el, idx) => ({ el, idx }));
    const flagged = indexed.filter(({ el }) => el.collectable === true);
    // Fallback: an un-annotated item still works, on its bullets.
    const source = flagged.length
      ? flagged
      : indexed.filter(({ el }) => typeOf(el) === "bullet");

    const resolved = source.map(({ el, idx }) => {
      const text = el.name || "";
      const { quantity, product } = parseIngredient(text);
      const pinnedId = el.collectableItemId || el.collectable_item_id || null;
      // Already resolved on a previous visit: skip matching entirely.
      const pinned = pinnedId
        ? (items || []).find((i) => i.id === pinnedId && !i.archived)
        : null;
      const match =
        pinned ||
        matchProduct(product, items || [], { contextId: targetContextId });
      const near = match
        ? []
        : findNearMisses(product, items || [], { contextId: targetContextId });
      return { key: `${idx}-${text}`, elementIndex: idx, text, quantity, product, match, near };
    });

    const unmatched = resolved.filter((r) => !r.match);
    const matched = resolved.filter((r) => r.match);
    return [...unmatched, ...matched];
  }, [item.elements, items, targetContextId]);

  const stateFor = (row) => {
    const o = overrides[row.key] || {};
    return {
      checked: o.checked === true,
      quantity: o.quantity !== undefined ? o.quantity : row.quantity,
      targetId:
        o.targetId !== undefined ? o.targetId : row.match ? row.match.id : null,
    };
  };

  const patch = (key, next) =>
    setOverrides((prev) => ({ ...prev, [key]: { ...prev[key], ...next } }));

  const selectedCount = rows.filter((r) => stateFor(r).checked).length;

  const [busy, setBusy] = useState(false);

  // "Existing" means the row currently resolves to an item that already lives
  // in the target context — either matched automatically or via an accepted
  // suggestion. Deliberately NOT create-new rows: each of those mints a new
  // item in the catalogue, and fifteen uninspected new items in one tap is how
  // a shopping catalogue fills with junk. Creating stays one deliberate tap.
  const existingRows = rows.filter((r) => stateFor(r).targetId);
  const allExistingSelected =
    existingRows.length > 0 && existingRows.every((r) => stateFor(r).checked);

  function selectExisting() {
    const keys = existingRows.map((r) => r.key);
    setOverrides((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = { ...next[k], checked: true };
      return next;
    });
  }

  function clearSelection() {
    const keys = rows.map((r) => r.key);
    setOverrides((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = { ...next[k], checked: false };
      return next;
    });
  }

  async function handleAdd() {
    if (busy || !collection) return;
    const picks = rows
      .filter((r) => stateFor(r).checked)
      .map((r) => {
        const st = stateFor(r);
        return {
          elementIndex: r.elementIndex,
          targetItemId: st.targetId,
          productName: r.product,
          quantity: st.quantity,
        };
      });
    if (picks.length === 0) return;
    setBusy(true);
    const ok = await onAdd(collection.id, picks);
    setBusy(false);
    // Stay put on failure so the selection is not lost.
    if (ok) onBack();
  }

  const pickerRowData = pickerRow ? rows.find((r) => r.key === pickerRow) : null;
  const pickerCandidates = (items || [])
    .filter((i) => !i.archived)
    .filter((i) => targetContextId == null || i.contextId === targetContextId)
    .filter((i) => {
      const q = pickerSearch.trim().toLowerCase();
      return !q || i.name.toLowerCase().includes(q);
    })
    .slice(0, 20);

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <h2 className="text-lg sm:text-xl font-medium text-foreground mb-1">
        Add to Collection
      </h2>
      <p className="text-sm text-muted-foreground mb-3">{item.name}</p>

      {available.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          No collections yet. Create one first.
        </p>
      ) : (
        <>
          <label className="block text-sm font-medium text-foreground mb-1">
            Collection
          </label>
          <select
            value={collectionId}
            onChange={(e) => setCollectionId(e.target.value)}
            className="w-full px-3 py-2 min-h-[44px] border border-border rounded-lg text-base mb-3"
          >
            {available.map((c) => {
              const ctx = (contexts || []).find((x) => x.id === c.contextId);
              return (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {ctx ? ` — ${ctx.name}` : ""}
                </option>
              );
            })}
          </select>

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              Nothing to add — this item has no collectable elements and no
              bullets.
            </p>
          ) : (
            <>
            {/* Select-all covers only rows that already resolve to an existing
                item. A create-new row mints a new catalogue entry, so it stays
                one deliberate tap. The label carries the count and the word
                "existing" for exactly that reason: a plain "Select all" here
                would claim to do something it deliberately does not. */}
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm text-muted-foreground">
                {selectedCount} of {rows.length} selected
              </span>
              {existingRows.length > 0 && (
                <button
                  onClick={allExistingSelected ? clearSelection : selectExisting}
                  className="px-3 py-2 min-h-[44px] shrink-0 rounded-lg border border-border text-sm text-primary hover:border-primary"
                >
                  {allExistingSelected
                    ? "Select none"
                    : `Select ${existingRows.length} existing`}
                </button>
              )}
            </div>
            {existingRows.length < rows.length && (
              <p className="text-xs text-muted-foreground mb-2">
                Rows that create a new item are not included — tap those
                individually.
              </p>
            )}

            {/* No interior scroll. An inner scroller nested in the page
                scroller is unusable on a phone — a 32-row recipe in a
                half-screen box is the case that breaks it. The page scrolls
                once and the sticky footer now genuinely engages, which is
                what it was always there for. */}
            <div className="space-y-2 mb-4">
              {rows.map((row) => {
                const st = stateFor(row);
                const target = st.targetId
                  ? (items || []).find((i) => i.id === st.targetId)
                  : null;
                return (
                  <div
                    key={row.key}
                    onClick={() => patch(row.key, { checked: !st.checked })}
                    className={`flex gap-3 p-3 border rounded-lg cursor-pointer ${
                      st.checked
                        ? "border-primary bg-background"
                        : "border-border bg-white hover:border-primary"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={st.checked}
                      readOnly
                      className="mt-1 rounded accent-primary pointer-events-none shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground break-words">
                        {row.text}
                      </p>

                      <div className="flex items-center gap-2 mt-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setPickerSearch("");
                            setPickerRow(row.key);
                          }}
                          className={`flex-1 min-w-0 text-left truncate px-2 py-2 min-h-[44px] rounded text-sm ${
                            target
                              ? "border border-border text-foreground"
                              : "border-2 border-dashed border-primary text-primary"
                          }`}
                        >
                          {target ? (
                            <span className="truncate">{target.name}</span>
                          ) : (
                            <span className="truncate">
                              Create &quot;{row.product}&quot;
                            </span>
                          )}
                        </button>
                        <input
                          type="text"
                          value={st.quantity}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            e.stopPropagation();
                            patch(row.key, { quantity: e.target.value });
                          }}
                          placeholder="Qty"
                          className="w-20 sm:w-24 shrink-0 px-2 py-2 min-h-[44px] border border-border rounded text-base"
                        />
                      </div>

                      {!target && row.near.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          <span className="text-xs text-muted-foreground">
                            or use
                          </span>
                          {row.near.map((n) => (
                            <button
                              key={n.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                patch(row.key, { targetId: n.id, checked: true });
                              }}
                              className="px-2 py-1 min-h-[32px] rounded-full border border-border bg-secondary text-xs text-foreground hover:border-primary"
                            >
                              {n.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            </>
          )}

          {/* Same offsets as CollectionAddItems. Now that the list no longer
              scrolls internally this genuinely engages on a long recipe. */}
          <div className="flex gap-2 sticky bottom-28 sm:bottom-32 pt-2 pb-3 bg-background border-t border-border">
            <button
              onClick={handleAdd}
              disabled={busy || selectedCount === 0 || !collection}
              className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm disabled:opacity-50 text-sm"
            >
              {busy
                ? "Adding..."
                : `Add ${selectedCount > 0 ? `(${selectedCount})` : ""} to Collection`}
            </button>
            <button
              onClick={onBack}
              className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg text-sm"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {pickerRowData && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setPickerRow(null)}
        >
          <div
            className="bg-card p-4 sm:p-6 rounded-lg max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-foreground">Change target</h3>
              <button
                onClick={() => setPickerRow(null)}
                aria-label="Close"
                className="flex items-center justify-center min-h-[44px] min-w-[44px] -mr-2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-muted-foreground mb-3 break-words">
              {pickerRowData.text}
            </p>

            <button
              onClick={() => {
                patch(pickerRowData.key, { targetId: null, checked: true });
                setPickerRow(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 min-h-[44px] mb-3 border-2 border-dashed border-primary rounded-lg text-primary text-sm"
            >
              <Plus className="w-4 h-4 shrink-0" />
              <span className="truncate">
                Create &quot;{pickerRowData.product}&quot;
              </span>
            </button>

            <input
              type="text"
              placeholder="Search items..."
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              className="w-full px-3 py-2 min-h-[44px] border border-border rounded-lg text-base mb-3"
              autoFocus
            />

            <div className="space-y-2">
              {pickerCandidates.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No matching items
                </p>
              ) : (
                pickerCandidates.map((cand) => (
                  <button
                    key={cand.id}
                    onClick={() => {
                      patch(pickerRowData.key, { targetId: cand.id, checked: true });
                      setPickerRow(null);
                    }}
                    className="w-full text-left px-3 py-2 min-h-[44px] border border-border rounded-lg text-sm hover:border-primary"
                  >
                    {cand.name}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


export default function Alfred() {
  // --- Navigation bridge (Step 4, docs/technical-spec-navigation-urls.md) ---
  // `view` used to be `useState("home")`. It is now derived from the URL, and
  // `setView` is a thin wrapper around the router's navigate(). The point of
  // doing it this way round is that all 39 existing call sites keep working
  // with no edits — the URL simply becomes the thing that backs them.
  // See src/viewPaths.js for the 18-entry map.
  //
  // (Deliberately no literal call syntax in this comment: the call sites get
  // counted by grep at every step, and a comment would inflate the count.)
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = normalizePath(location.pathname);
  const view = pathToView(location.pathname);
  const setView = useCallback(
    (nextView) => {
      const path = viewToPath(nextView);
      // Re-selecting the screen you are already on used to be an inert
      // re-render. Pushing an identical entry would make the next Back press
      // look broken, so same-path navigations replace instead of push.
      navigate(path, { replace: path === currentPath });
    },
    [navigate, currentPath]
  );
  // Opening an execution goes through here rather than setView, because
  // setView can only reach the id-less /schedule/execution — it is handed a
  // view name and has no way to know which execution is meant. Every
  // navigation to an execution carries its id so the address stays meaningful
  // after a refresh, a paste, or a notification tap.
  const goToExecution = useCallback(
    (exec) => {
      if (!exec || !exec.id) return;
      const path = executionPath(exec.id);
      navigate(path, { replace: path === currentPath });
    },
    [navigate, currentPath]
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [contexts, setContexts] = useState([]);
  const [items, setItems] = useState([]);
  const [intents, setIntents] = useState([]);
  const [events, setEvents] = useState([]);
  const [activeExecution, setActiveExecution] = useState(null); // currently viewed
  const [activeExecutions, setActiveExecutions] = useState([]);
  const [pausedExecutions, setPausedExecutions] = useState([]);
  const [inboxItems, setInboxItems] = useState([]);
  const [collections, setCollections] = useState([]);
  // Step 3b: collection membership is READ from the collection_items table,
  // keyed by collection id. Writes still land in the item_collections.items
  // jsonb until Step 3c, so the two sources can diverge in between.
  const [collectionMembers, setCollectionMembers] = useState({});
  const [collectionMembersError, setCollectionMembersError] = useState(null);
  // Manual removal history, keyed by collection id — feeds the recently-removed
  // panel on the collection detail view.
  const [collectionRemovals, setCollectionRemovals] = useState({});
  const [collectionRemovalsError, setCollectionRemovalsError] = useState(null);
  const [reAddingRemovalId, setReAddingRemovalId] = useState(null);
  // Full removal history — both kinds, unfiltered — for the history view.
  const [collectionHistory, setCollectionHistory] = useState({});
  const [collectionHistoryError, setCollectionHistoryError] = useState(null);
  // Live-refresh support for the collection detail view. The poll must never
  // land on top of an edit in progress, so these track what is being touched.
  // Refs rather than state: the interval callback closes over the render that
  // created it, and reading stale values here would defeat the guard.
  const [editingQuantityItemId, setEditingQuantityItemId] = useState(null);
  const pollPausedRef = useRef(false);
  const memberWriteInFlight = useRef(0);
  const [filterTag, setFilterTag] = useState(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState(null);
  const [collDragIdx, setCollDragIdx] = useState(null);
  const [collectionContextFilter, setCollectionContextFilter] = useState("");

  const captureRef = useRef(null);
  const [executionTab, setExecutionTab] = useState("active");
  const [captureText, setCaptureText] = useState("");
  const [showContextForm, setShowContextForm] = useState(false);
  const [editingContext, setEditingContext] = useState(null);
  const [selectedContextId, setSelectedContextId] = useState(null);
  const [selectedIntentionId, setSelectedIntentionId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [previousView, setPreviousView] = useState("home");
  const [intentionReturnView, setIntentionReturnView] = useState("home");
  const [itemHistoryStack, setItemHistoryStack] = useState([]);
  const [showAddIntentionForm, setShowAddIntentionForm] = useState(false);
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [realtimeStatus, setRealtimeStatus] = useState('disconnected'); // 'connected', 'connecting', 'disconnected'
  const [recycleTab, setRecycleTab] = useState("items");
  const [recycleData, setRecycleData] = useState([]);
  const [recycleLoading, setRecycleLoading] = useState(false);
  const [recycleHasMore, setRecycleHasMore] = useState(false);
  const [recycleSelected, setRecycleSelected] = useState(new Set());

  // --- Execution deep link (notification chains, Phase 1) -------------------
  //
  // The URL is the source of truth for which execution is open. This owns the
  // cold-load fetch, the guard suppression that keeps a deep link from being
  // redirected away before it has been looked up, and the clearing of an
  // execution the URL no longer names. It lives in its own module so the test
  // exercises it rather than a copy of it.
  const { awaitingExecutionLoad, executionForRoute } =
    useExecutionRoute({
      pathname: location.pathname,
      user,
      activeExecution,
      setActiveExecution,
      fetchExecution: (id) => storage.get(`execution:${id}`),
    });

  // --- Cold-load redirects (Step 9, docs/technical-spec-navigation-urls.md) --
  //
  // Two things can put Alfred on a path it cannot actually render:
  //
  //   1. An unknown path (/testing). It used to render home while the address
  //      bar went on claiming otherwise. Now the address is corrected too.
  //   2. A detail view opened cold. The seven detail views carry no id in the
  //      URL this slice — their id is set by a separate React state call that
  //      has not flushed when setView runs, so threading it into the URL would
  //      mean editing the 39 call sites. Pasting /collections/detail into a
  //      fresh tab therefore arrives with no id and would render "not found".
  //      Falling back to the parent list is the honest answer.
  //
  // These fire only when the required state is genuinely absent. In normal
  // navigation the id and the view are set in the same batch, so by the render
  // where `view` becomes a detail view its id is already there and nothing
  // redirects.
  const DETAIL_VIEW_STATE = {
    "context-detail": selectedContextId,
    "intention-detail": selectedIntentionId,
    "item-detail": selectedItemId,
    "item-add-to-collection": selectedItemId,
    // Not `activeExecution`: the route decides which execution counts as
    // present. See useExecutionRoute — an execution left in state from a
    // previous visit must not satisfy this guard for a different URL.
    "execution-detail": executionForRoute,
    "collection-detail": selectedCollectionId,
    "collection-history": selectedCollectionId,
    "collection-add-items": selectedCollectionId,
  };

  const detailStateMissing =
    view in DETAIL_VIEW_STATE &&
    !DETAIL_VIEW_STATE[view] &&
    // Execution-detail is the exception to point 2 above: since Phase 1 of the
    // notification-chain work it carries its id in the URL, so a cold load can
    // fetch the execution instead of giving up. The guard holds its fire until
    // that lookup has actually completed and found nothing.
    !awaitingExecutionLoad;

  useEffect(() => {
    if (!isKnownPath(currentPath)) {
      navigate(DEFAULT_PATH, { replace: true });
      return;
    }
    if (detailStateMissing) {
      // parentPath() consults its override table first — the last-segment rule
      // is a tiebreaker for naming, not a law.
      navigate(parentPath(currentPath), { replace: true });
    }
    // `replace` in both cases: a path the app cannot render should not become
    // a history entry the Back button can return the user to.
  }, [currentPath, detailStateMissing, navigate]);

  // --- List sort preferences (Step 9b) --------------------------------------
  //
  // One key per page, each persisting independently — changing the Inbox order
  // must not reorder Schedule. Called unconditionally at the top level: Alfred
  // renders every screen from one component, so these are not conditional even
  // though only one list is on screen at a time.
  //
  // Home's is named for the page but governs its **Today tab only**. Active and
  // Paused render ExecutionBadge, are ordered by `started_at` descending from
  // the database, and have none of these fields; the control is rendered inside
  // the Today panel rather than above the tab bar so it cannot imply otherwise.
  // Same reasoning that excluded those two tabs from the row strips in Step 8a.
  const homeSort = useSortPreference("alfred.sort.home", EVENT_SORT_OPTIONS, "time");
  const scheduleSort = useSortPreference("alfred.sort.schedule", EVENT_SORT_OPTIONS, "time");
  const inboxSort = useSortPreference("alfred.sort.inbox", INBOX_SORT_OPTIONS, "created");
  const contextsSort = useSortPreference("alfred.sort.contexts", NAMED_RECORD_SORT_OPTIONS, "title");
  const collectionsSort = useSortPreference("alfred.sort.collections", NAMED_RECORD_SORT_OPTIONS, "title");

  // --- Undo (Step 2, docs/technical-spec-ui-standardization.md) -------------
  //
  // Governing rule 3: destructive actions get no confirmation dialog, so this
  // message is the safety net. Every handler that archives or deletes ends by
  // offering an undo whose restore closure puts back exactly what it took.
  //
  // Restores go through `storage.set`, which UPDATEs by id and INSERTs only if
  // that matched nothing — so the same call re-flags an archived row and
  // re-inserts a deleted one with its original id. See UndoMessage.jsx.
  const { pendingUndo, offerUndo, runUndo, dismissUndo } = useUndo();

  // Undo restores are written where the state setters live, and they need the
  // same "Saving…" overlay and error handling as the action they reverse.
  function offerUndoFor(message, restore) {
    offerUndo(message, () => withLoading("Restoring...", restore));
  }

  // Unsaved changes guard
  const unsavedChangesRef = useRef(false);
  const unsavedChangesLabelRef = useRef("");

  function setUnsavedChanges(dirty, label = "") {
    unsavedChangesRef.current = dirty;
    unsavedChangesLabelRef.current = label;
  }

  // The single unsaved-changes guard (Step 5, docs/technical-spec-navigation-urls.md).
  //
  // This block used to be written out four times: here, plus hand-inlined
  // copies in the Sam tab, the Timer tab, and the mobile drawer. Those three
  // could not call `guardedSetView` because each needs to run its own side
  // effects (setPreviousView, setMenuOpen) *after* the confirm passes but
  // *before* navigating — so the reusable part is the question, not the
  // navigation.
  //
  // Returns true if it is safe to navigate. Clears the dirty flag as a side
  // effect when the user chooses to discard, exactly as the inline copies did.
  function confirmDiscardIfDirty() {
    if (!unsavedChangesRef.current) return true;
    const label = unsavedChangesLabelRef.current || "this form";
    if (!window.confirm(`You have unsaved changes to ${label}. Discard and navigate away?`)) {
      return false;
    }
    unsavedChangesRef.current = false;
    unsavedChangesLabelRef.current = "";
    return true;
  }

  function guardedSetView(newView) {
    if (!confirmDiscardIfDirty()) return;
    setView(newView);
  }

  useEffect(() => {
    function handleBeforeUnload(e) {
      if (unsavedChangesRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  async function withLoading(message, operation) {
    setIsLoading(true);
    setLoadingMessage(message);
    try {
      return await operation();
    } catch (error) {
      console.error('Operation failed:', error);
      alert('Operation failed: ' + error.message);
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  }

  useEffect(() => {
    let realtimeCleanup = null;
    let isInitialized = false;

    async function handleAuthChange(event, session) {
      try {
        console.log('[Auth] State changed:', event, 'User:', session?.user?.email || 'none');

        // Skip SIGNED_IN event - wait for INITIAL_SESSION when session is fully ready
        if (event === 'SIGNED_IN') {
          console.log('[Auth] Skipping SIGNED_IN - waiting for INITIAL_SESSION');
          return;
        }

        // Check allowlist if user exists
        if (session?.user) {
          console.log('[Auth] Checking allowlist for:', session.user.email);

          // Add timeout to prevent hanging forever
          const queryPromise = supabase
            .from('allowed_emails')
            .select('email')
            .eq('email', session.user.email)
            .maybeSingle();

          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Allowlist query timeout after 5 seconds')), 5000)
          );

          const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

          console.log('[Auth] Allowlist query completed:', { data, error });

          if (error) {
            console.error('[Auth] Allowlist query error:', error);
            alert(`Allowlist check failed: ${error.message}\n\nPlease check:\n1. RLS policy on allowed_emails table\n2. Your email is in the allowed_emails table\n3. Supabase console for errors`);
            setAuthLoading(false);
            setIsLoading(false);
            return;
          }

          if (!data) {
            console.log('[Auth] Email not in allowlist, signing out');
            await supabase.auth.signOut();
            alert('Access denied. Your email is not authorized to access this app.');
            setUser(null);
            setAuthLoading(false);
            return;
          }

          console.log('[Auth] Email allowed');
        }

        setUser(session?.user ?? null);
        setAuthLoading(false);

        // Only initialize once on first auth event with user
        if (session?.user && !isInitialized) {
          isInitialized = true;
          console.log('[Auth] First-time init - loading data...');
          await loadData();
          setDataLoaded(true);
          console.log('[Auth] Data loaded');

          console.log('[Auth] Setting up realtime...');
          realtimeCleanup = await setupRealtimeSubscriptions(session.user);
          console.log('[Auth] Realtime setup complete');
        } else if (session?.user && isInitialized) {
          // Subsequent auth changes - just reload data
          console.log('[Auth] Reloading data...');
          loadData();
        }
      } catch (error) {
        console.error('[Auth] handleAuthChange error:', error);
        setAuthLoading(false);
        setIsLoading(false);
      }
    }

    // Listen for auth state changes (fires immediately with current session)
    console.log('[Init] Setting up auth listener');
    const { data: { subscription } } = supabase.auth.onAuthStateChange(handleAuthChange);
    console.log('[Init] Auth listener ready');

    // Cleanup function
    return () => {
      console.log('[Init] Cleanup: unsubscribing');
      subscription.unsubscribe();
      if (realtimeCleanup) {
        realtimeCleanup();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let lastRefresh = Date.now();

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && user) {
        const elapsed = Date.now() - lastRefresh;
        if (elapsed > 30000) { // 30 second debounce
          lastRefresh = Date.now();
          refreshData();
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    // refreshData is intentionally omitted: it is recreated every render, so
    // depending on it would tear down and re-attach this listener constantly.
    // It closes over nothing render-scoped — only stable setters and module
    // imports — so there is no staleness to guard against. Same reasoning as the
    // suppression on the init effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    setFilterTag(null);
  }, [view]);

  // Load removal history when a collection view is opened. One-shot fetches on
  // open — deliberately not a poll or a realtime channel.
  useEffect(() => {
    if (!selectedCollectionId) return;
    if (view === "collection-detail") {
      // The detail view needs all three: membership, manual removals for the
      // panel, and the full history so it knows whether the "view all" entry
      // point should exist.
      loadCollectionMembers([selectedCollectionId]);
      loadCollectionRemovals(selectedCollectionId);
      loadCollectionHistory(selectedCollectionId);
    } else if (view === "collection-history") {
      loadCollectionHistory(selectedCollectionId);
    }
    // These loaders are recreated every render; depending on them would refetch
    // in a loop. They close over nothing render-scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedCollectionId]);

  // Keep the poll's guard current. Read from a ref, not state, because the
  // interval callback below closes over the render that created it.
  useEffect(() => {
    pollPausedRef.current =
      collDragIdx !== null || editingQuantityItemId !== null || isLoading;
  }, [collDragIdx, editingQuantityItemId, isLoading]);

  /**
   * Live refresh for the open collection: a five-second poll, the same cadence
   * and shape as the execution view's. Deliberately a poll and not a realtime
   * channel.
   *
   * Runs only while the collection detail view is open, and only for the
   * collection being viewed — the interval is torn down on navigate away, so no
   * other collection is ever polled.
   *
   * Membership and the manual-removal panel refresh; the full history does not.
   * Seeing the other person's removal land in "Recently removed" is the point of
   * that panel — without it an item would vanish from the list with no
   * explanation and no way to put it back. The history view is a record rather
   * than a live surface, costs a third query per tick, and reloads on entry
   * anyway.
   */
  useEffect(() => {
    if (view !== "collection-detail" || !selectedCollectionId) return;

    const interval = setInterval(() => {
      // Never land on top of an edit in progress. A skipped tick costs five
      // seconds; overwriting a half-typed quantity or a drag mid-flight costs
      // the user their work.
      if (pollPausedRef.current || memberWriteInFlight.current > 0) return;
      loadCollectionMembers([selectedCollectionId], { quiet: true });
      loadCollectionRemovals(selectedCollectionId, { quiet: true });
    }, 5000);

    return () => clearInterval(interval);
    // The loaders are recreated every render; depending on them would tear down
    // and restart the interval continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedCollectionId]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    setUser(null);
  }

  async function loadData() {
    return withLoading('Loading your data...', async () => {
      const [
        { data: contextsData },
        { data: itemsData },
        { data: intentsData },
        { data: eventsData },
        { data: inboxData },
        { data: collectionsData },
        { data: activeExecData },
        { data: pausedExecData },
      ] = await Promise.all([
        supabase.from("contexts").select("*"),
        supabase.from("items").select("*"),
        supabase.from("intents").select("*"),
        supabase.from("events").select("*"),
        supabase.from("inbox").select("*"),
        supabase.from("item_collections").select("*"),
        supabase.from("executions").select("*").eq("status", "active").order("started_at", { ascending: false }),
        supabase.from("executions").select("*").eq("status", "paused").order("started_at", { ascending: false }),
      ]);

      setContexts((contextsData || []).map(d => storage.toCamelCase(d)));
      setItems((itemsData || []).map(d => storage.toCamelCase(d)));
      setIntents((intentsData || []).map(d => storage.toCamelCase(d)));
      setEvents((eventsData || []).map(d => storage.toCamelCase(d)));
      setInboxItems(
        (inboxData || [])
          .map(d => storage.toCamelCase(d))
          .filter(item => !item.archived)
          .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      );
      setCollections((collectionsData || []).map(d => storage.toCamelCase(d)));
      await loadCollectionMembers((collectionsData || []).map(d => d.id));
      setActiveExecutions((activeExecData || []).map(d => storage.toCamelCase(d)));
      setPausedExecutions((pausedExecData || []).map(d => storage.toCamelCase(d)));

      // Sync activeExecution if one is currently being viewed
      setActiveExecution(prev => {
        if (!prev) return prev;
        const allRefreshed = [
          ...(activeExecData || []).map(d => storage.toCamelCase(d)),
          ...(pausedExecData || []).map(d => storage.toCamelCase(d)),
        ];
        const refreshed = allRefreshed.find(e => e.id === prev.id);
        return refreshed || prev;
      });
    });
  }

  async function refreshData() {
    try {
      console.log('[Refresh] Silent background refresh...');
      const [
        { data: contextsData },
        { data: itemsData },
        { data: intentsData },
        { data: eventsData },
        { data: inboxData },
        { data: collectionsData },
        { data: activeExecData },
        { data: pausedExecData },
      ] = await Promise.all([
        supabase.from("contexts").select("*"),
        supabase.from("items").select("*"),
        supabase.from("intents").select("*"),
        supabase.from("events").select("*"),
        supabase.from("inbox").select("*"),
        supabase.from("item_collections").select("*"),
        supabase.from("executions").select("*").eq("status", "active").order("started_at", { ascending: false }),
        supabase.from("executions").select("*").eq("status", "paused").order("started_at", { ascending: false }),
      ]);

      setContexts((contextsData || []).map(d => storage.toCamelCase(d)));
      setItems((itemsData || []).map(d => storage.toCamelCase(d)));
      setIntents((intentsData || []).map(d => storage.toCamelCase(d)));
      setEvents((eventsData || []).map(d => storage.toCamelCase(d)));
      setInboxItems(
        (inboxData || [])
          .map(d => storage.toCamelCase(d))
          .filter(item => !item.archived)
          .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      );
      setCollections((collectionsData || []).map(d => storage.toCamelCase(d)));
      await loadCollectionMembers((collectionsData || []).map(d => d.id));
      setActiveExecutions((activeExecData || []).map(d => storage.toCamelCase(d)));
      setPausedExecutions((pausedExecData || []).map(d => storage.toCamelCase(d)));

      // Sync activeExecution if one is currently being viewed
      setActiveExecution(prev => {
        if (!prev) return prev;
        const allRefreshed = [
          ...(activeExecData || []).map(d => storage.toCamelCase(d)),
          ...(pausedExecData || []).map(d => storage.toCamelCase(d)),
        ];
        const refreshed = allRefreshed.find(e => e.id === prev.id);
        return refreshed || prev;
      });

      console.log('[Refresh] Done');
    } catch (e) {
      console.error('[Refresh] Failed:', e);
    }
  }

  async function manualRefresh() {
    return withLoading('Refreshing...', refreshData);
  }

  const RECYCLE_PAGE_SIZE = 30;

  /**
   * Wording for a permanent-delete confirmation.
   *
   * These two dialogs are the only confirmations left in the app, and they are
   * kept on purpose: this is the terminal irreversible step, and the Recycle Bin
   * is itself the undo for everything upstream of it. There is nothing behind
   * this one, so it is the one place a confirm is doing real work.
   *
   * Collections get their own wording. For the other six tabs the cascade takes
   * the record's own content, which is what "delete this song" already implies.
   * Deleting a collection also destroys `collection_item_removals` — an
   * append-only log of what was taken out of it and when, kept as the recovery
   * path for accidental removals during shopping. That is a record of actions
   * taken on OTHER things, and nothing in "delete this collection" hints at
   * losing it. This dialog is the last place anyone finds out.
   *
   * `count` is null for the single-row path, which says "this record" rather
   * than counting to one — preserving both existing strings verbatim.
   */
  function permanentDeleteWarning(tab, count = null) {
    const isCollection = tab === "collections";
    // Contexts reach this point only when empty — the guards above refuse
    // otherwise — so there is nothing to warn about destroying. The generic
    // wording is honest here in a way it is not for collections.
    const noun = isCollection ? "collection" : tab === "contexts" ? "context" : "record";
    const subject =
      count === null ? `this ${noun}` : `${count} ${noun}${count > 1 ? "s" : ""}`;
    const cascade = !isCollection
      ? ""
      : count === null || count === 1
        ? " Its item list and removal history will be destroyed."
        : " Their item lists and removal history will be destroyed.";
    return `Permanently delete ${subject}?${cascade} This cannot be undone.`;
  }

  async function loadRecycleBin(tab, append = false) {
    setRecycleLoading(true);
    try {
      let query;
      const offset = append ? recycleData.length : 0;

      switch (tab) {
        case "items":
          query = supabase.from("items").select("id, name, context_id, tags, updated_at")
            .eq("archived", true)
            .order("updated_at", { ascending: false, nullsFirst: false })
            .range(offset, offset + RECYCLE_PAGE_SIZE - 1);
          break;
        case "intents":
          query = supabase.from("intents").select("id, text, context_id, recurrence_config, target_start_date, end_date, tags, updated_at")
            .eq("archived", true)
            .order("updated_at", { ascending: false, nullsFirst: false })
            .range(offset, offset + RECYCLE_PAGE_SIZE - 1);
          break;
        case "events":
          query = supabase.from("events").select("id, intent_id, time, context_id, updated_at")
            .eq("archived", true)
            .order("updated_at", { ascending: false, nullsFirst: false })
            .range(offset, offset + RECYCLE_PAGE_SIZE - 1);
          break;
        case "executions":
          query = supabase.from("executions").select("id, intent_id, event_id, outcome, started_at, closed_at, updated_at")
            .eq("status", "closed")
            .order("updated_at", { ascending: false, nullsFirst: false })
            .range(offset, offset + RECYCLE_PAGE_SIZE - 1);
          break;
        case "contexts":
          query = supabase.from("contexts").select("id, name, description, shared, updated_at")
            .eq("archived", true)
            .order("updated_at", { ascending: false, nullsFirst: false })
            .range(offset, offset + RECYCLE_PAGE_SIZE - 1);
          break;
        case "collections":
          // Only the columns the row actually renders. Membership is not read
          // here: an archived collection's `collection_items` rows are untouched
          // by the soft delete, so there is nothing to report and nothing to
          // repair on restore.
          query = supabase.from("item_collections").select("id, name, context_id, updated_at")
            .eq("archived", true)
            .order("updated_at", { ascending: false, nullsFirst: false })
            .range(offset, offset + RECYCLE_PAGE_SIZE - 1);
          break;
        case "songs":
          query = supabase.from("sam_songs").select("id, title, artist, updated_at")
            .eq("archived", true)
            .order("updated_at", { ascending: false, nullsFirst: false })
            .range(offset, offset + RECYCLE_PAGE_SIZE - 1);
          break;
        case "snippets":
          query = supabase.from("sam_snippets").select("id, title, song_id, start_measure, end_measure, updated_at")
            .eq("archived", true)
            .order("updated_at", { ascending: false, nullsFirst: false })
            .range(offset, offset + RECYCLE_PAGE_SIZE - 1);
          break;
        default:
          setRecycleLoading(false);
          return;
      }

      const { data, error } = await query;
      if (error) {
        console.error("[Recycle] Load error:", error);
        setRecycleLoading(false);
        return;
      }

      const camelData = (data || []).map(d => storage.toCamelCase(d));
      setRecycleData(append ? [...recycleData, ...camelData] : camelData);
      setRecycleHasMore((data || []).length === RECYCLE_PAGE_SIZE);
    } catch (e) {
      console.error("[Recycle] Load error:", e);
    } finally {
      setRecycleLoading(false);
    }
  }

  async function recycleRestore(tab, id) {
    setRecycleLoading(true);
    try {
      let table, updates;
      switch (tab) {
        case "items": table = "items"; updates = { archived: false }; break;
        case "intents": table = "intents"; updates = { archived: false }; break;
        case "events": table = "events"; updates = { archived: false }; break;
        case "executions": table = "executions"; updates = { status: "paused" }; break;
        case "collections": table = "item_collections"; updates = { archived: false }; break;
        case "contexts": table = "contexts"; updates = { archived: false }; break;
        case "songs": table = "sam_songs"; updates = { archived: false }; break;
        case "snippets": table = "sam_snippets"; updates = { archived: false }; break;
        default: return;
      }

      const { error } = await supabase.from(table).update(updates).eq("id", id);
      if (error) throw error;

      setRecycleData(prev => prev.filter(r => r.id !== id));

      // Collections MUST be in this list. Items, intents and events each have a
      // realtime channel that would eventually re-sync them anyway; there is no
      // channel on `item_collections`, so without this a restored collection
      // stays invisible until a manual refresh — a silent failure, not a delay.
      // refreshData also re-runs loadCollectionMembers, so the member counts
      // come back with it.
      // "contexts" is here for robustness, NOT necessity — unlike collections.
      // There IS a realtime channel on contexts, so an UPDATE propagates to
      // handleContextChange and the row reappears without this. But realtime
      // can be disconnected (the header shows exactly that state), and items,
      // intents and events are all in this list despite having channels too.
      // Consistent, and correct when the socket is down.
      if (["items", "intents", "events", "collections", "contexts"].includes(tab)) {
        refreshData();
      }
    } catch (e) {
      console.error("[Recycle] Restore error:", e);
      alert("Failed to restore: " + e.message);
    } finally {
      setRecycleLoading(false);
    }
  }

  async function recyclePermanentDelete(tab, id) {
    // Re-check emptiness at the far end, not just at archive time. The empty
    // rule is what makes context archiving safe at all, and children can appear
    // between archive and purge — from another device, from an MCP tool, or
    // from Elise on a shared context. Deleting a context with children does not
    // remove them; it leaves them pointing at a row that no longer exists, and
    // an item in that state shows up nowhere at all: Memories filters on
    // `!contextId`, and an orphan HAS one.
    if (tab === "contexts") {
      const blockers = contextArchiveBlockers(id);
      if (blockers.length > 0) {
        window.alert(
          `Cannot delete this context: it still holds ${blockers.join(", ")}. ` +
            "Deleting it would leave those records pointing at nothing, and an " +
            "item in that state is reachable from nowhere. Restore the context " +
            "and empty it first.",
        );
        return;
      }
    }
    if (!window.confirm(permanentDeleteWarning(tab))) return;
    setRecycleLoading(true);
    try {
      let table;
      switch (tab) {
        case "items": table = "items"; break;
        case "intents": table = "intents"; break;
        case "events": table = "events"; break;
        case "executions": table = "executions"; break;
        // The one hard delete left in the app. Cascades to collection_items and
        // collection_item_removals — deliberate, and named in the confirm.
        case "collections": table = "item_collections"; break;
        // Contexts do NOT cascade: no child table carries a foreign key to
        // them. Deleting one ORPHANS its children instead, which is quieter
        // and worse — see the guard above recyclePermanentDelete.
        case "contexts": table = "contexts"; break;
        case "songs": table = "sam_songs"; break;
        case "snippets": table = "sam_snippets"; break;
        default: return;
      }

      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw error;

      setRecycleData(prev => prev.filter(r => r.id !== id));
    } catch (e) {
      console.error("[Recycle] Delete error:", e);
      alert("Failed to delete: " + e.message);
    } finally {
      setRecycleLoading(false);
    }
  }

  function recycleToggleSelect(id) {
    setRecycleSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function recycleSelectAll() {
    if (recycleSelected.size === recycleData.length) {
      setRecycleSelected(new Set());
    } else {
      setRecycleSelected(new Set(recycleData.map(r => r.id)));
    }
  }

  async function recycleBulkRestore() {
    if (recycleSelected.size === 0) return;
    setRecycleLoading(true);
    try {
      let table, updates;
      switch (recycleTab) {
        case "items": table = "items"; updates = { archived: false }; break;
        case "intents": table = "intents"; updates = { archived: false }; break;
        case "events": table = "events"; updates = { archived: false }; break;
        case "executions": table = "executions"; updates = { status: "paused" }; break;
        case "collections": table = "item_collections"; updates = { archived: false }; break;
        case "contexts": table = "contexts"; updates = { archived: false }; break;
        case "songs": table = "sam_songs"; updates = { archived: false }; break;
        case "snippets": table = "sam_snippets"; updates = { archived: false }; break;
        default: return;
      }

      const ids = Array.from(recycleSelected);
      const { error } = await supabase.from(table).update(updates).in("id", ids);
      if (error) throw error;

      setRecycleData(prev => prev.filter(r => !recycleSelected.has(r.id)));
      setRecycleSelected(new Set());

      // See recycleRestore for why contexts is included and collections is
      // required.
      if (["items", "intents", "events", "collections", "contexts"].includes(recycleTab)) {
        refreshData();
      }
    } catch (e) {
      console.error("[Recycle] Bulk restore error:", e);
      alert("Failed to restore: " + e.message);
    } finally {
      setRecycleLoading(false);
    }
  }

  async function recycleBulkDelete() {
    if (recycleSelected.size === 0) return;
    if (recycleTab === "contexts") {
      const blocked = Array.from(recycleSelected).filter(
        (id) => contextArchiveBlockers(id).length > 0,
      );
      if (blocked.length > 0) {
        window.alert(
          `${blocked.length} of the selected contexts still hold records. ` +
            "Deleting them would leave those records pointing at nothing. " +
            "Deselect them and try again.",
        );
        return;
      }
    }
    if (!window.confirm(permanentDeleteWarning(recycleTab, recycleSelected.size))) return;
    setRecycleLoading(true);
    try {
      let table;
      switch (recycleTab) {
        case "items": table = "items"; break;
        case "intents": table = "intents"; break;
        case "events": table = "events"; break;
        case "executions": table = "executions"; break;
        // The one hard delete left in the app. Cascades to collection_items and
        // collection_item_removals — deliberate, and named in the confirm.
        case "collections": table = "item_collections"; break;
        // Contexts do NOT cascade: no child table carries a foreign key to
        // them. Deleting one ORPHANS its children instead, which is quieter
        // and worse — see the guard above recyclePermanentDelete.
        case "contexts": table = "contexts"; break;
        case "songs": table = "sam_songs"; break;
        case "snippets": table = "sam_snippets"; break;
        default: return;
      }

      const ids = Array.from(recycleSelected);
      const { error } = await supabase.from(table).delete().in("id", ids);
      if (error) throw error;

      setRecycleData(prev => prev.filter(r => !recycleSelected.has(r.id)));
      setRecycleSelected(new Set());
    } catch (e) {
      console.error("[Recycle] Bulk delete error:", e);
      alert("Failed to delete: " + e.message);
    } finally {
      setRecycleLoading(false);
    }
  }

  useEffect(() => {
    if (view === "recycle") {
      setRecycleSelected(new Set());
      loadRecycleBin(recycleTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, recycleTab]);

  async function setupRealtimeSubscriptions(currentUser) {
    if (!currentUser) return null;

    console.log('[Realtime] Setting up subscriptions for user:', currentUser.id);
    setRealtimeStatus('connecting');

    // Use the recursive converter so JSONB columns (elements, tags, etc.) get camelCased too
    const toCamelCase = (obj) => storage.toCamelCase(obj);

    // Subscribe to inbox changes
    const inboxChannel = supabase
      .channel('inbox-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'inbox',
          filter: `user_id=eq.${currentUser.id}`
        },
        (payload) => {
          console.log('[Realtime] Inbox change:', payload.eventType, payload);
          handleInboxChange(payload, toCamelCase);
        }
      )
      .subscribe((status) => {
        console.log('[Realtime] Inbox subscription status:', status);
        if (status === 'SUBSCRIBED') {
          setRealtimeStatus('connected');
        }
      });

    // Subscribe to contexts changes
    const contextsChannel = supabase
      .channel('contexts-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'contexts'
        },
        (payload) => {
          console.log('[Realtime] Context change:', payload.eventType);
          handleContextChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to items changes
    const itemsChannel = supabase
      .channel('items-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'items'
        },
        (payload) => {
          console.log('[Realtime] Item change:', payload.eventType);
          handleItemChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to intents changes
    const intentsChannel = supabase
      .channel('intents-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'intents'
        },
        (payload) => {
          console.log('[Realtime] Intent change:', payload.eventType);
          handleIntentChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to events changes
    const eventsChannel = supabase
      .channel('events-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'events'
        },
        (payload) => {
          console.log('[Realtime] Event change:', payload.eventType);
          handleEventChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to executions changes
    const executionsChannel = supabase
      .channel('executions-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'executions'
        },
        (payload) => {
          console.log('[Realtime] Execution change:', payload.eventType);
          handleExecutionChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Return cleanup function
    return () => {
      console.log('[Realtime] Unsubscribing all channels');
      setRealtimeStatus('disconnected');
      inboxChannel.unsubscribe();
      contextsChannel.unsubscribe();
      itemsChannel.unsubscribe();
      intentsChannel.unsubscribe();
      eventsChannel.unsubscribe();
      executionsChannel.unsubscribe();
    };
  }

  function handleInboxChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setInboxItems(prev => {
        // Don't add duplicates
        if (prev.find(item => item.id === record.id)) return prev;
        // Add to top, maintain sort by createdAt
        return [record, ...prev].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setInboxItems(prev =>
        prev.map(item => item.id === record.id ? record : item)
      );
    } else if (eventType === 'DELETE') {
      setInboxItems(prev =>
        prev.filter(item => item.id !== oldRecord.id)
      );
    }
  }

  function handleContextChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setContexts(prev => {
        if (prev.find(ctx => ctx.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setContexts(prev =>
        prev.map(ctx => ctx.id === record.id ? record : ctx)
      );
    } else if (eventType === 'DELETE') {
      setContexts(prev =>
        prev.filter(ctx => ctx.id !== oldRecord.id)
      );
    }
  }

  function handleItemChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setItems(prev => {
        if (prev.find(item => item.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setItems(prev =>
        prev.map(item => item.id === record.id ? record : item)
      );
    } else if (eventType === 'DELETE') {
      setItems(prev =>
        prev.filter(item => item.id !== oldRecord.id)
      );
    }
  }

  function handleIntentChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setIntents(prev => {
        if (prev.find(intent => intent.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setIntents(prev =>
        prev.map(intent => intent.id === record.id ? record : intent)
      );
    } else if (eventType === 'DELETE') {
      setIntents(prev =>
        prev.filter(intent => intent.id !== oldRecord.id)
      );
    }
  }

  function handleEventChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setEvents(prev => {
        if (prev.find(event => event.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setEvents(prev =>
        prev.map(event => event.id === record.id ? record : event)
      );
    } else if (eventType === 'DELETE') {
      setEvents(prev =>
        prev.filter(event => event.id !== oldRecord.id)
      );
    }
  }

  function handleExecutionChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      if (record.status === 'active') {
        setActiveExecutions(prev => {
          if (prev.find(exec => exec.id === record.id)) return prev;
          return [...prev, record];
        });
      } else if (record.status === 'paused') {
        setPausedExecutions(prev => {
          if (prev.find(exec => exec.id === record.id)) return prev;
          return [...prev, record];
        });
      }
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      // Remove from both lists first
      setActiveExecutions(prev => prev.filter(exec => exec.id !== record.id));
      setPausedExecutions(prev => prev.filter(exec => exec.id !== record.id));
      // Add to appropriate list based on status
      if (record.status === 'active') {
        setActiveExecutions(prev => [...prev, record]);
      } else if (record.status === 'paused') {
        setPausedExecutions(prev => [...prev, record]);
      }
    } else if (eventType === 'DELETE') {
      setActiveExecutions(prev => prev.filter(exec => exec.id !== oldRecord.id));
      setPausedExecutions(prev => prev.filter(exec => exec.id !== oldRecord.id));
    }
  }

  async function handleCapture() {
    if (!captureText.trim()) return;
    return withLoading('Saving...', async () => {
      const inboxItem = {
        id: uid(),
        user_id: user.id,
        capturedText: captureText.trim(),
        createdAt: new Date().toISOString(),
        archived: false,
        triagedAt: null,
        suggestedContextId: null,
        suggestItem: false,
        suggestedItemText: null,
        suggestedItemDescription: null,
        suggestedItemElements: null,
        suggestIntent: false,
        suggestedIntentText: null,
        suggestedIntentRecurrence: null,
        suggestEvent: false,
        suggestedEventDate: null,
        // NEW fields from Phase 7.2.1
        aiStatus: 'not_started',
        sourceType: 'manual',
        sourceMetadata: {},
        aiConfidence: null,
        aiReasoning: null,
        suggestedTags: [],
        suggestedItemId: null,
        suggestedCollectionId: null,
      };

      await storage.set(`inbox:${inboxItem.id}`, inboxItem);
      setInboxItems([...inboxItems, inboxItem]); // Add to end (oldest first)
      setCaptureText("");
      if (captureRef.current) {
        captureRef.current.style.height = "auto";
      }
      setView("inbox");
    });
  }

  // Discard. A capture that does not make it through the inbox never happened,
  // so the row is deleted rather than flagged — see the spec's Part C. The
  // `audit_row` AFTER DELETE trigger in platform.audit_log records it, so this
  // is not the last copy.
  //
  // `archived` and `triaged_at` are deliberately NOT written on the way out and
  // NOT dropped from the table: existing archived rows are the only record of
  // past captures and are out of scope here.
  async function deleteInboxItem(inboxItemId) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    return withLoading('Deleting...', async () => {
      const deleted = await storage.delete(`inbox:${inboxItem.id}`);
      // storage.delete swallows its own errors and returns false. Dropping the
      // row from the list after a failed delete would hide a capture that is
      // still in the database, and it would come back on the next refresh.
      if (!deleted) {
        window.alert("Could not delete that capture. It is still in your inbox.");
        return;
      }
      setInboxItems(inboxItems.filter((i) => i.id !== inboxItemId));

      // Unchanged from Step 2, which is the point: `storage.set` UPDATEs by id
      // and INSERTs only when that matched nothing, so re-inserting a deleted
      // row keeps its original id for free. Swapping the archive for a delete
      // above changed what this closure reverses, not how it does it.
      //
      // (Step 2 called the createdAt re-sort load-bearing. It no longer is —
      // Step 9b made display order a function of the sort preference rather
      // than of array order. Kept so `inboxItems` stays in a canonical order.)
      offerUndoFor("Capture deleted.", async () => {
        await storage.set(`inbox:${inboxItem.id}`, inboxItem);
        setInboxItems((prev) =>
          [...prev.filter((i) => i.id !== inboxItemId), inboxItem].sort((a, b) =>
            (a.createdAt || "").localeCompare(b.createdAt || ""),
          ),
        );
      });
    });
  }

  function handleInboxEnrich(inboxItemId, updatedItem) {
    setInboxItems((prev) =>
      prev.map((item) => (item.id === inboxItemId ? updatedItem : item))
    );
  }

  async function handleInboxSave(inboxItemId, triageData) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    return withLoading('Saving...', async () => {
      let createdItemId = null;

      // "Delete only on success" needs an explicit check, because none of the
      // writers below throw. `storage.set` catches its own errors and returns
      // false; `addItemsToCollection` alerts and returns false. Nothing read
      // either until now, which was survivable while disposal merely set a
      // flag — the row stayed in the table and could be recovered. A hard
      // delete on a failed triage would destroy the capture AND leave nothing
      // downstream to show for it.
      let allWritesSucceeded = true;
      const wrote = (result) => {
        if (result === false) allWritesSucceeded = false;
        return result !== false;
      };

      // Create item if Item section was open
      if (triageData.createItem && triageData.itemData) {
        const newItem = {
          id: uid(),
          user_id: user.id,
          name: triageData.itemData.name,
          description: triageData.itemData.description || "",
          contextId: triageData.itemData.contextId,
          elements: triageData.itemData.elements || [],
          tags: triageData.itemData.tags || [],
          isCaptureTarget: false,
          createdAt: new Date().toISOString(),
        };

        const context = contexts.find((c) => c.id === newItem.contextId);
        const isShared = context?.shared || false;
        wrote(await storage.set(`item:${newItem.id}`, newItem, isShared));
        setItems((prev) => [...prev, newItem]);
        createdItemId = newItem.id;

        // Update linked items to reference the newly created item
        if (triageData.itemItemLinks && triageData.itemItemLinks.length > 0) {
          for (const linkedItem of triageData.itemItemLinks) {
            const itemToUpdate = items.find((i) => i.id === linkedItem.id);
            if (itemToUpdate) {
              const updatedElements = [
                ...(itemToUpdate.elements || []),
                {
                  name: newItem.name,
                  displayType: 'bullet',
                  itemId: newItem.id,
                },
              ];
              await updateItem(linkedItem.id, { elements: updatedElements });
            }
          }
        }
      }

      // Create intention if Intention section was open
      if (triageData.createIntention && triageData.intentionData) {
        const intentionItemId =
          triageData.intentionData.itemId || createdItemId;
        const newIntent = {
          id: uid(),
          user_id: user.id,
          text: triageData.intentionData.text,
          createdAt: new Date().toISOString(),
          isIntention: true,
          isItem: !!intentionItemId,
          archived: false,
          itemId: intentionItemId,
          contextId: triageData.intentionData.contextId,
          recurrenceConfig: triageData.intentionData.recurrenceConfig || null,
          targetStartDate: triageData.intentionData.targetStartDate || null,
          endDate: triageData.intentionData.endDate || null,
          tags: triageData.intentionData.tags || [],
        };
        wrote(await storage.set(`intent:${newIntent.id}`, newIntent));
        setIntents((prev) => [...prev, newIntent]);

        // Create event if scheduled
        if (triageData.intentionData.createEvent && triageData.intentionData.eventDate) {
          const newEvent = {
            id: uid(),
            user_id: user.id,
            intentId: newIntent.id,
            contextId: triageData.intentionData.contextId,
            time: triageData.intentionData.eventDate,
            itemIds: intentionItemId ? [intentionItemId] : [],
            archived: false,
            createdAt: new Date().toISOString(),
            text: triageData.intentionData.text,
          };
          wrote(await storage.set(`event:${newEvent.id}`, newEvent));
          setEvents((prev) => [...prev, newEvent]);
        }
      }

      // Add to collection if Collection section was open
      if (triageData.addToCollection && triageData.collectionData) {
        const targetItemId = triageData.collectionData.itemId || createdItemId;
        const targetCollectionId = triageData.collectionData.collectionId;
        if (targetItemId && targetCollectionId) {
          wrote(
            await addItemsToCollection(targetCollectionId, [
              {
                itemId: targetItemId,
                quantity: triageData.collectionData.quantity || '1',
              },
            ]),
          );
        }
      }

      // On failure the row stays put. Partial success is possible — the item
      // may have been created and the intention not — so this says "check what
      // was created" rather than "try again", which could duplicate the half
      // that worked.
      if (!allWritesSucceeded) {
        window.alert(
          "Some of that capture could not be saved, so it has been left in your inbox. Check what was created before filing it again.",
        );
        return;
      }

      // Triage succeeded, so the capture has become an item, an intention, an
      // event or a collection member. The row has no further job.
      //
      // No Undo offered here, deliberately, unlike the discard path. Undo would
      // put the inbox row back but could not remove the records it turned into,
      // so it would restore a capture that had already been filed — a button
      // labelled Undo that half-undoes is worse than none. Discard has no such
      // problem: nothing downstream exists to reverse.
      const disposed = await storage.delete(`inbox:${inboxItem.id}`);
      if (!disposed) {
        window.alert(
          "Everything was saved, but the capture could not be removed from your inbox. Delete it manually.",
        );
        return;
      }
      setInboxItems((prev) => prev.filter((i) => i.id !== inboxItemId));
    });
  }

  async function moveToPlanner(intentId, scheduledDate = "today") {
    return withLoading('Scheduling...', async () => {
      // Always read from storage first to get the latest data
      // (state may be stale if updateIntent was just called)
      let intent = await storage.get(`intent:${intentId}`);
      if (!intent) {
        intent = intents.find((i) => i.id === intentId);
      }

      if (!intent) {
        console.error("Intent not found:", intentId);
        return;
      }

      const eventDate = scheduledDate === "today" ? getTodayDate() : scheduledDate;

      // Create event for this intent
      const event = {
        id: uid(),
        user_id: user.id,
        intentId,
        time: eventDate,
        itemIds: intent.itemId ? [intent.itemId] : [],
        contextId: intent.contextId,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };

      await storage.set(`event:${event.id}`, event);
      setEvents([...events, event]);

      // No navigation. This used to end by switching the view to the schedule
      // whenever the date was today, which is what made "Do Today" throw you
      // off whatever list you were working through. The message below is how
      // you now know it worked, and it names the date so scheduling for today
      // and scheduling for a Tuesday give the same feedback.
      //
      // (No literal call syntax in this comment — the navigation call sites are
      // counted by grep at every step of the routing work, and a comment would
      // inflate the count. Same convention as the bridge comment at the top.)
      //
      // Every caller loses the jump, not just the two surfaces Step 6 touches:
      // the add-intention forms on Intentions, Context detail and Item detail
      // all funnelled through here too. Staying put is right for all of them.
      //
      // Undo deletes rather than archives — the event was created seconds ago
      // and never seen, so an archived ghost in the recycle bin would be a
      // record of something that never happened. Same reasoning as the
      // recurrence successor in Step 2.
      offerUndoFor(`Scheduled for ${formatEventDate(eventDate)}.`, async () => {
        await storage.delete(`event:${event.id}`);
        setEvents((prev) => prev.filter((e) => e.id !== event.id));
      });
    });
  }

  async function updateIntent(intentId, updates, scheduledDate) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    return withLoading('Saving...', async () => {
      // Be explicit about what we're storing
      const updated = {
        id: intent.id,
        userId: intent.userId,
        text: updates.text !== undefined ? updates.text : intent.text,
        createdAt: intent.createdAt,
        isIntention:
          updates.isIntention !== undefined
            ? updates.isIntention
            : intent.isIntention || false,
        isItem:
          updates.isItem !== undefined ? updates.isItem : intent.isItem || false,
        archived:
          updates.archived !== undefined
            ? updates.archived
            : intent.archived || false,
        itemId: updates.itemId !== undefined ? updates.itemId : intent.itemId,
        contextId:
          updates.contextId !== undefined ? updates.contextId : intent.contextId,
        recurrenceConfig:
          updates.recurrenceConfig !== undefined
            ? updates.recurrenceConfig
            : intent.recurrenceConfig || null,
        targetStartDate:
          updates.targetStartDate !== undefined
            ? updates.targetStartDate
            : intent.targetStartDate || null,
        endDate:
          updates.endDate !== undefined
            ? updates.endDate
            : intent.endDate || null,
        tags:
          updates.tags !== undefined ? updates.tags : intent.tags || [],
        collectionId:
          updates.collectionId !== undefined ? updates.collectionId : intent.collectionId || null,
      };

      await storage.set(`intent:${intent.id}`, updated);
      setIntents(intents.map((i) => (i.id === intentId ? updated : i)));

      // If scheduledDate provided, create an event
      if (scheduledDate) {
        await moveToPlanner(intentId, scheduledDate);
      }
    });
  }

  async function archiveIntention(intentId) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    return withLoading('Archiving...', async () => {
      const archivedIntent = { ...intent, archived: true };
      await storage.set(`intent:${intentId}`, archivedIntent);
      setIntents(intents.map((i) => (i.id === intentId ? archivedIntent : i)));

      // Archive all related events
      const relatedEvents = events.filter((e) => e.intentId === intentId && !e.archived);
      for (const event of relatedEvents) {
        const archivedEvent = { ...event, archived: true };
        await storage.set(`event:${event.id}`, archivedEvent);
        setEvents((prev) => prev.map((e) => (e.id === event.id ? archivedEvent : e)));
      }

      // Archiving an intention cascades to its events, so undoing it has to as
      // well — restoring the intention alone would leave its schedule silently
      // archived. `relatedEvents` holds only the ones this call actually
      // touched, so an event archived earlier stays archived.
      offerUndoFor(`Archived "${intent.text || "intention"}".`, async () => {
        await storage.set(`intent:${intentId}`, intent);
        setIntents((prev) => prev.map((i) => (i.id === intentId ? intent : i)));
        for (const event of relatedEvents) {
          await storage.set(`event:${event.id}`, event);
          setEvents((prev) => prev.map((e) => (e.id === event.id ? event : e)));
        }
      });

      // Only the detail page has to leave: it is showing the record that just
      // got archived, so staying would render an archived intention. A list row
      // simply disappears from its own list, and yanking the user to another
      // screen for that was the defect.
      //
      // `view` is derived from the URL, so this reads the screen the click
      // actually came from. The return address is `intentionReturnView` — the
      // slot `viewIntentionDetail` wrote on the way in — not the globally
      // shared `previousView`, which any intervening navigation can clobber.
      if (view === "intention-detail") {
        setSelectedIntentionId(null);
        setView(intentionReturnView);
      }
    });
  }

  async function updateItem(itemId, updates) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    return withLoading('Saving...', async () => {
      const updated = {
        id: item.id,
        userId: item.userId,
        name: updates.name !== undefined ? updates.name : item.name,
        description:
          updates.description !== undefined
            ? updates.description
            : item.description || "",
        contextId:
          updates.contextId !== undefined ? updates.contextId : item.contextId,
        elements:
          updates.elements !== undefined
            ? updates.elements
            : item.elements || item.components || [],
        tags:
          updates.tags !== undefined ? updates.tags : item.tags || [],
        isCaptureTarget:
          updates.isCaptureTarget !== undefined
            ? updates.isCaptureTarget
            : item.isCaptureTarget || false,
        archived:
          updates.archived !== undefined
            ? updates.archived
            : item.archived || false,
        createdAt: item.createdAt,
      };

      const context = contexts.find((c) => c.id === updated.contextId);
      const isShared = context?.shared || false;

      await storage.set(`item:${item.id}`, updated, isShared);
      setItems(items.map((i) => (i.id === itemId ? updated : i)));

      // `item` is the pre-archive snapshot, so restoring is a straight rewrite
      // rather than a flag flip — it also puts back anything the archiving edit
      // happened to change alongside `archived`.
      if (updates.archived === true) {
        offerUndoFor(`Archived "${item.name}".`, async () => {
          await storage.set(`item:${item.id}`, item, isShared);
          setItems((prev) => prev.map((i) => (i.id === itemId ? item : i)));
        });
      }
    });
  }

  async function deepCloneItem(sourceItemId, newName) {
    const source = items.find((i) => i.id === sourceItemId);
    if (!source) return null;
    return withLoading('Cloning...', async () => {
      const clonedIds = new Map(); // sourceId -> cloneId
      const newItems = [];

      // Recursively clone item and its children
      async function cloneRecursive(itemId, visited = new Set()) {
        if (visited.has(itemId) || clonedIds.has(itemId)) return clonedIds.get(itemId);
        visited.add(itemId);

        const item = items.find((i) => i.id === itemId);
        if (!item) return null;

        const cloneId = uid();
        clonedIds.set(itemId, cloneId);

        // Clone child references first
        const clonedElements = [];
        for (const el of (item.elements || [])) {
          const elItemId = el.itemId || el.item_id;
          if (elItemId) {
            const childCloneId = await cloneRecursive(elItemId, new Set(visited));
            clonedElements.push({ ...el, itemId: childCloneId || elItemId });
          } else {
            clonedElements.push({ ...el });
          }
        }

        const cloned = {
          id: cloneId,
          userId: user.id,
          name: itemId === sourceItemId ? newName : item.name,
          description: item.description || "",
          contextId: item.contextId || null,
          elements: clonedElements,
          tags: [...(item.tags || [])],
          isCaptureTarget: false,
          archived: false,
          createdAt: new Date().toISOString(),
        };

        await storage.set(`item:${cloneId}`, cloned);
        newItems.push(cloned);
        return cloneId;
      }

      await cloneRecursive(sourceItemId);
      setItems((prev) => [...prev, ...newItems]);
      return newItems.find((i) => i.id === clonedIds.get(sourceItemId));
    });
  }

  async function updateEvent(eventId, updates) {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    return withLoading('Saving...', async () => {
      const updated = { ...event, ...updates };
      await storage.set(`event:${event.id}`, updated);
      setEvents(events.map((e) => (e.id === eventId ? updated : e)));

      // If archiving a recurring event, trigger recurrence to create next event
      let successor = null;
      if (updates.archived === true && event.intentId) {
        successor = await triggerRecurrence(event.intentId, event);
      }

      if (updates.archived === true) {
        const intent = intents.find((i) => i.id === event.intentId);
        const label = event.text || intent?.text || "event";
        offerUndoFor(`Archived "${label}".`, async () => {
          await storage.set(`event:${event.id}`, event);
          setEvents((prev) => prev.map((e) => (e.id === eventId ? event : e)));
          // The successor only exists because of the archive being undone, so
          // it goes with it. Deleting rather than archiving: it was never a
          // real event the user saw, and an archived ghost would surface in the
          // recycle bin as something they never scheduled.
          if (successor) {
            await storage.delete(`event:${successor.id}`);
            setEvents((prev) => prev.filter((e) => e.id !== successor.id));
          }
        });
      }
    });
  }

  async function activate(eventId) {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    return withLoading('Starting execution...', async () => {
      // Collection-based execution
      if (event.collectionId) {
        const execution = {
          id: uid(),
          user_id: user.id,
          eventId,
          intentId: event.intentId,
          contextId: event.contextId,
          collectionId: event.collectionId,
          itemIds: [],
          startedAt: new Date().toISOString(),
          status: "active",
          notes: "",
          elements: [],
          completedItemIds: [],
          progress: [],
        };
        await storage.set(`execution:${execution.id}`, execution);
        await startNotificationChain(execution);
        setActiveExecution(execution);
        setActiveExecutions((prev) => [execution, ...prev]);
        setPreviousView(view);
        goToExecution(execution);
        return;
      }

      // Item-based execution
      const itemElements = [];
      const getItem = (id) => items.find((i) => i.id === id) || null;
      if (event.itemIds && event.itemIds.length > 0) {
        for (const itemId of event.itemIds) {
          const item = items.find((i) => i.id === itemId);
          if (item && (item.elements || item.components)) {
            const rawEls = (item.elements || item.components).map((el) =>
              typeof el === "string"
                ? { name: el, displayType: "step", quantity: "", description: "" }
                : { ...el }
            );
            const flattened = await flattenElements(rawEls, getItem);
            const els = flattened.map((el) => ({
              ...el,
              isCompleted: false,
              completedAt: null,
              inProgress: false,
              startedAt: null,
              sourceItemId: el.sourceItemId || itemId,
            }));
            itemElements.push(...els);
          }
        }
      }

      const execution = {
        id: uid(),
        user_id: user.id,
        eventId,
        intentId: event.intentId,
        contextId: event.contextId,
        itemIds: event.itemIds,
        startedAt: new Date().toISOString(),
        status: "active",
        notes: "",
        elements: itemElements,
        progress: [],
      };

      await storage.set(`execution:${execution.id}`, execution);
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      goToExecution(execution);
    });
  }

  /**
   * Creates the next recurring event for an intent after an event is archived.
   * Shared by closeExecution (completion) and manual event archive (skip).
   */
  // Returns the successor event it created, or null when it created none — so
  // an undo of the archive that triggered it can take that successor back out.
  // Without this, undoing left the successor behind and the intention ended up
  // with two live events.
  async function triggerRecurrence(intentId, archivedEvent) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return null;

    const config = getRecurrenceConfig(intent);
    if (config.type === "once") return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDate = calculateNextEventDate(config, today);

    if (nextDate && (!intent.endDate || nextDate <= new Date(intent.endDate + "T23:59:59"))) {
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: intent.id,
        // Local fields, not toISOString: calculateNextEventDate returns a
        // LOCAL-midnight Date (it normalises with setHours and parses via
        // parseLocalDate), and converting that to UTC moves it back a day in
        // any zone east of Greenwich.
        time: toLocalDateString(nextDate),
        itemIds: archivedEvent?.itemIds || [],
        contextId: intent.contextId,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      await storage.set(`event:${newEvent.id}`, newEvent);
      setEvents((prev) => [...prev, newEvent]);
      return newEvent;
    }
    return null;
  }

  // --- Notification chain (Phase 4) -----------------------------------------
  //
  // Every one of these is a background concern: a chain that fails to expand
  // must not stop an execution from starting, and a chain that fails to advance
  // must not stop a step being ticked. So each is wrapped and logged rather
  // than thrown — but logged loudly, because Phase 4 is verified by inspecting
  // rows and a silent no-op would look identical to an item with no offsets.
  //
  // Nothing here sends anything. The dispatcher is Phase 5.

  async function startNotificationChain(execution) {
    try {
      const rows = await createNotificationSteps(execution.id, execution.elements);
      if (rows.length > 0) {
        console.log(`[Chain] Expanded ${rows.length} notification step(s) for execution ${execution.id}`);
      }
    } catch (e) {
      console.error("[Chain] Failed to expand notification steps:", e);
    }
  }

  // Logged on EVERY tick, not only when something changed.
  //
  // The field failure was a chain that silently stopped advancing, and the
  // three ways that can happen — the advance was never called, the rows were
  // not visible, or the writes were refused — were indistinguishable from each
  // other and from "the chain is simply finished". Each now says which.
  async function advanceNotificationChain(execution, elementIndex) {
    try {
      const { complete, schedule, rowsSeen } = await completeNotificationStep(
        execution.id,
        execution.elements,
        elementIndex
      );
      if (rowsSeen === 0) {
        console.log(
          `[Chain] Element ${elementIndex}: no notification_steps rows visible for execution ${execution.id}. ` +
            `Either this item has no offsets, or the rows exist and RLS is hiding them.`
        );
        return;
      }
      console.log(
        `[Chain] Element ${elementIndex} (seq ${elementIndex + 1}): saw ${rowsSeen} row(s), ` +
          `completed ${complete.length}, scheduled ${schedule.length}.`
      );
    } catch (e) {
      console.error("[Chain] Failed to advance notification chain:", e, e.failures ?? "");
    }
  }

  async function endNotificationChain(executionId) {
    try {
      const cancelled = await cancelNotificationSteps(executionId);
      if (cancelled.length > 0) {
        console.log(`[Chain] Cancelled ${cancelled.length} remaining step(s) for execution ${executionId}`);
      }
    } catch (e) {
      console.error("[Chain] Failed to cancel notification steps:", e);
    }
  }

  async function rescheduleNotificationChain(executionId) {
    try {
      const moved = await resumeNotificationSteps(executionId);
      if (moved.length > 0) {
        console.log(`[Chain] Resume: moved ${moved.length} overdue step(s) to now`);
      }
    } catch (e) {
      console.error("[Chain] Failed to reschedule notification steps on resume:", e);
    }
  }

  async function closeExecution(outcome) {
    if (!activeExecution) return;
    return withLoading('Completing...', async () => {
      // Cancel = Delete: just remove active execution, don't archive anything
      if (outcome === "cancelled") {
        // Cancel the chain BEFORE deleting the execution: afterwards the rows
        // would be orphans referencing a row that no longer exists. The
        // dispatcher's join to active executions would hide them, but leaving
        // live-looking rows behind for a run that never happened is not a
        // state worth defending.
        await endNotificationChain(activeExecution.id);
        await storage.delete(`execution:${activeExecution.id}`);
        setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
        setActiveExecution(null);
        setView(previousView);
        return;
      }

      const closed = {
        ...activeExecution,
        closedAt: new Date().toISOString(),
        outcome,
        status: "closed",
      };

      // Archive the execution (notes and elements are preserved via spread)
      await storage.set(`execution:${closed.id}`, closed);
      await endNotificationChain(closed.id);

      // Archive the event
      const event = events.find((e) => e.id === activeExecution.eventId);
      if (event) {
        const archivedEvent = { ...event, archived: true };
        await storage.set(`event:${event.id}`, archivedEvent);
        setEvents(events.map((e) => (e.id === event.id ? archivedEvent : e)));
      }

      // Handle recurrence: archive one-time intents, or create next event for recurring
      const intent = intents.find((i) => i.id === activeExecution.intentId);
      if (intent) {
        const config = getRecurrenceConfig(intent);
        if (config.type === "once") {
          // One-time: archive intent on done (existing behavior)
          if (outcome === "done") {
            const archivedIntent = { ...intent, archived: true };
            await storage.set(`intent:${intent.id}`, archivedIntent);
            setIntents(intents.map((i) => (i.id === intent.id ? archivedIntent : i)));
          }
        } else {
          // Recurring: calculate and create next event
          await triggerRecurrence(intent.id, event);
        }
      }

      // Remove completed items from collection. Only an affirmative completion
      // clears anything — cancel returns above, and pause never reaches here.
      //
      // We are already inside withLoading, which clears the overlay in its
      // finally and never rethrows, so there is no nested withLoading here and
      // the failure is read off the returned result rather than thrown.
      if (outcome === "done" && activeExecution.collectionId) {
        const completedIds = activeExecution.completedItemIds || [];
        if (completedIds.length > 0) {
          await clearCompletedFromCollection(
            activeExecution.collectionId,
            completedIds,
          );
        }
      }

      setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setActiveExecution(null);
      setView(previousView);
    });
  }

  async function cancelExecutionForEvent(eventId) {
    const exec =
      activeExecutions.find((e) => e.eventId === eventId) ||
      pausedExecutions.find((e) => e.eventId === eventId);
    if (!exec) return;
    return withLoading('Cancelling...', async () => {
      await storage.delete(`execution:${exec.id}`);
      setActiveExecutions((prev) => prev.filter((e) => e.id !== exec.id));
      setPausedExecutions((prev) => prev.filter((e) => e.id !== exec.id));
      if (activeExecution && activeExecution.id === exec.id) {
        setActiveExecution(null);
      }
    });
  }

  async function pauseExecution() {
    if (!activeExecution) return;
    return withLoading('Pausing...', async () => {
      const paused = { ...activeExecution, status: "paused" };
      await storage.set(`execution:${paused.id}`, paused);
      setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setPausedExecutions((prev) => [paused, ...prev]);
      setActiveExecution(null);
      setView("home");
    });
  }

  async function makeExecutionActive() {
    if (!activeExecution) return;
    return withLoading('Resuming...', async () => {
      const activated = { ...activeExecution, status: "active" };
      await storage.set(`execution:${activated.id}`, activated);
      // Pausing writes no rows — the dispatcher filters on execution status, so
      // a paused chain is already silent. Only resuming needs to act, so that a
      // due time that passed during the pause does not fire for a moment gone by.
      await rescheduleNotificationChain(activated.id);
      setPausedExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setActiveExecutions((prev) => [activated, ...prev]);
      setActiveExecution(activated);
    });
  }

  async function toggleExecutionElement(elementIndex) {
    if (!activeExecution) return;
    const updatedElements = [...activeExecution.elements];
    const el = updatedElements[elementIndex];
    updatedElements[elementIndex] = {
      ...el,
      isCompleted: !el.isCompleted,
      completedAt: !el.isCompleted ? new Date().toISOString() : null,
      inProgress: false,
    };
    const updated = { ...activeExecution, elements: updatedElements };

    // Optimistic: update UI immediately
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );

    // Persist — await to prevent refresh race condition
    try {
      await storage.set(`execution:${updated.id}`, updated);
    } catch (e) {
      console.error('[Execution] Failed to save element toggle:', e);
    }

    // Advance the chain only when the element is being marked COMPLETE. This
    // is a toggle, and un-ticking must not close a row or start a clock.
    // Re-ticking is safe: planCompletion only moves rows out of `waiting`, and
    // a row already terminal is left alone.
    if (!el.isCompleted) {
      await advanceNotificationChain(updated, elementIndex);
    } else {
      // Un-ticking. The chain deliberately does not retreat — but say so,
      // because "I ticked it and nothing happened" and "I un-ticked it and
      // nothing happened" produce the same empty audit log, and the second is
      // correct behaviour that has already been mistaken for the first.
      console.log(
        `[Chain] Element ${elementIndex} un-ticked — chain not advanced (by design).`
      );
    }
  }

  async function updateExecutionElement(elementIndex, fields) {
    if (!activeExecution) return;
    const updatedElements = [...activeExecution.elements];
    updatedElements[elementIndex] = { ...updatedElements[elementIndex], ...fields };
    const updated = { ...activeExecution, elements: updatedElements };

    // Optimistic: update UI immediately
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );

    // Persist — await to prevent refresh race condition
    try {
      await storage.set(`execution:${updated.id}`, updated);
    } catch (e) {
      console.error('[Execution] Failed to save element update:', e);
    }
  }

  async function updateExecutionNotes(notes) {
    if (!activeExecution) return;
    const updated = { ...activeExecution, notes };
    await storage.set(`execution:${updated.id}`, updated);
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
  }

  async function toggleCollectionItem(itemId) {
    if (!activeExecution) return;
    const completed = activeExecution.completedItemIds || [];
    const isCompleted = completed.includes(itemId);
    const updatedIds = isCompleted
      ? completed.filter((id) => id !== itemId)
      : [...completed, itemId];
    const updated = { ...activeExecution, completedItemIds: updatedIds };
    await storage.set(`execution:${updated.id}`, updated);
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
  }

  /**
   * Load membership rows for the given collections from collection_items.
   *
   * loadMembers reports failure by returning an error rather than throwing,
   * because withLoading swallows exceptions. A read failure must not look like
   * an empty collection, so it is surfaced in the UI rather than logged only.
   */
  async function loadCollectionMembers(collectionIds, options = {}) {
    const ids = (collectionIds || []).filter(Boolean);
    if (ids.length === 0) return;

    const results = await Promise.all(
      ids.map(async (id) => ({ id, ...(await loadMembers(id)) })),
    );

    const failed = results.filter((r) => r.error);
    if (failed.length > 0) {
      console.error("[collections] failed to load members:", failed[0].error);
      // `quiet` is for the five-second poll. A failed tick means what is on
      // screen is five seconds old, not that it is wrong, and a banner that
      // flickers every five seconds would be worse than the staleness. A
      // foreground load still raises it, and a later success still clears it.
      if (!options.quiet) {
        setCollectionMembersError(`Could not load collection contents: ${failed[0].error}`);
      }
    } else {
      setCollectionMembersError(null);
    }

    setCollectionMembers((prev) => {
      const next = { ...prev };
      for (const r of results) {
        if (!r.error) next[r.id] = r.data;
      }
      return next;
    });
  }

  function membersOf(collectionId) {
    return collectionMembers[collectionId] || [];
  }

  function setMembersFor(collectionId, updater) {
    setCollectionMembers((prev) => ({
      ...prev,
      [collectionId]: updater(prev[collectionId] || []),
    }));
  }

  // ─── Collection membership writes ──────────────────────────────────────────
  //
  // These target collection_items. The item_collections.items jsonb is no longer
  // written by any of them and is now a frozen rollback snapshot.
  //
  // The data layer reports failure by returning { data, error } rather than
  // throwing, because withLoading catches and never rethrows — a thrown error
  // would be swallowed and the person would believe their edit had saved. Every
  // helper below inspects error and puts it in front of the user.

  function reportMembershipError(action, message) {
    console.error(`[collections] failed to ${action}:`, message);
    window.alert(`Could not ${action}: ${message}`);
  }

  async function addItemsToCollection(collectionId, entries) {
    const result = await addMembers(collectionId, entries, { userId: user.id });
    if (result.error) {
      reportMembershipError("add to this collection", result.error);
      return false;
    }
    await loadCollectionMembers([collectionId]);
    if (result.skipped.length > 0) {
      window.alert(
        result.skipped.length === 1
          ? "That item is already in this collection."
          : `${result.skipped.length} of those items were already in this collection.`,
      );
    }
    return true;
  }

  /**
   * Step 7 write path for Add to Collection.
   *
   * Three things happen, in this order:
   *   1. create any items the user chose to create
   *   2. ONE save of the source item's elements, stamping collectable and
   *      collectableItemId onto every row that was added
   *   3. add-or-merge the membership rows
   *
   * Returns true only if all three succeeded. The caller stays on the page on
   * false so the selection is not lost.
   *
   * Deliberately does NOT call updateItem: that helper ends with
   * `setItems(items.map(...))` over a closed-over snapshot, which would drop
   * the items created moments earlier in this same handler. State is updated
   * once here, functionally.
   */
  async function addElementsToCollection(collectionId, sourceItem, picks) {
    if (!collectionId || !sourceItem || !picks || picks.length === 0) return false;
    const coll = collections.find((c) => c.id === collectionId);
    if (!coll) return false;

    return withLoading("Adding...", async () => {
      const targetContext = contexts.find((c) => c.id === coll.contextId);
      const targetShared = targetContext?.shared || false;

      const created = [];
      const entries = [];
      const stamp = new Map();
      // One recipe can yield two create-new rows for the same product —
      // "Salt for the bean water" and "1/4 tsp salt" both reduce to salt.
      // Creating two items would be the catalogue pollution this feature
      // exists to prevent, so the first creation wins and the second reuses it.
      const createdByName = new Map();

      try {
        for (const pick of picks) {
          let itemId = pick.targetItemId;
          const nameKey = (pick.productName || "").trim().toLowerCase();
          if (!itemId && createdByName.has(nameKey)) {
            itemId = createdByName.get(nameKey);
          }
          if (!itemId) {
            // Same on-the-fly shape as CollectionAddItems.
            const newItem = {
              id: uid(),
              user_id: user.id,
              name: pick.productName,
              description: "",
              contextId: coll.contextId,
              elements: [],
              tags: [],
              isCaptureTarget: false,
              createdAt: new Date().toISOString(),
            };
            await storage.set(`item:${newItem.id}`, newItem, targetShared);
            created.push(newItem);
            itemId = newItem.id;
            createdByName.set(nameKey, itemId);
          }
          entries.push({ itemId, quantity: pick.quantity });
          if (Number.isInteger(pick.elementIndex)) stamp.set(pick.elementIndex, itemId);
        }

        // One save of the elements array, not one per row.
        const nextElements = (sourceItem.elements || []).map((el, idx) =>
          stamp.has(idx)
            ? { ...el, collectable: true, collectableItemId: stamp.get(idx) }
            : el,
        );
        const updatedSource = { ...sourceItem, elements: nextElements };
        const sourceContext = contexts.find((c) => c.id === updatedSource.contextId);
        await storage.set(
          `item:${updatedSource.id}`,
          updatedSource,
          sourceContext?.shared || false,
        );

        // One functional update covering both writes above.
        setItems((prev) => [
          ...prev.map((i) => (i.id === updatedSource.id ? updatedSource : i)),
          ...created,
        ]);
      } catch (error) {
        // storage.set throws; the module contract does not apply to it.
        console.error("[addElementsToCollection]", error);
        window.alert(
          "Could not save: " + (error?.message || "Unknown error") +
            ". Nothing was added to the collection.",
        );
        return false;
      }

      const result = await addOrMergeMembers(collectionId, entries, {
        userId: user.id,
      });
      await loadCollectionMembers([collectionId]);
      if (result.error) {
        reportMembershipError("add to this collection", result.error);
        return false;
      }
      return true;
    });
  }

  async function removeItemFromCollection(collectionId, itemId) {
    const result = await removeMember(collectionId, itemId, {
      reason: REMOVAL_MANUAL,
      userId: user.id,
    });
    // Reload either way: on failure the membership row may or may not have gone,
    // and the list must show what is actually there rather than what we assumed.
    await loadCollectionMembers([collectionId]);
    await loadCollectionRemovals(collectionId);
    await loadCollectionHistory(collectionId);
    if (result.error) {
      reportMembershipError("remove that item", result.error);
      return false;
    }
    return true;
  }

  /**
   * Load manual removal history for the recently-removed panel.
   *
   * Only reason='manual'. A single execution completion can clear a dozen items
   * at once, and mixing those in would bury the accidental removal this panel
   * exists to catch; they show up in the full history view instead.
   *
   * Fetches a wider window than the panel displays, because entries whose item
   * is back in the collection are filtered out at render — fetching exactly five
   * could leave the panel showing fewer than it could.
   */
  async function loadCollectionRemovals(collectionId, options = {}) {
    const result = await loadRemovals(collectionId, {
      reason: REMOVAL_MANUAL,
      limit: 25,
    });
    if (result.error) {
      // Surfaced in the panel rather than as an alert: this is a background read
      // on view open, and an alert on every visit would be intolerable. Poll
      // ticks pass `quiet` and do not raise the banner at all — see
      // loadCollectionMembers.
      console.error("[collections] failed to load removal history:", result.error);
      if (!options.quiet) {
        setCollectionRemovalsError(`Could not load removal history: ${result.error}`);
      }
      return false;
    }
    setCollectionRemovalsError(null);
    setCollectionRemovals((prev) => ({ ...prev, [collectionId]: result.data }));
    return true;
  }

  /**
   * Load the full removal history for the history view: both kinds, nothing
   * filtered out, newest first, capped at 50.
   *
   * Kept as a separate fetch from loadCollectionRemovals rather than deriving
   * both from one query. The panel wants the most recent *manual* removals, and
   * a collection with heavy completion churn could push every manual row out of
   * a mixed 50-row window while manual removals still exist.
   */
  async function loadCollectionHistory(collectionId) {
    const result = await loadRemovals(collectionId, { limit: 50 });
    if (result.error) {
      console.error("[collections] failed to load full history:", result.error);
      setCollectionHistoryError(`Could not load removal history: ${result.error}`);
      return false;
    }
    setCollectionHistoryError(null);
    setCollectionHistory((prev) => ({ ...prev, [collectionId]: result.data }));
    return true;
  }

  /**
   * Put a removed item back. The removal record is left in place — the table is
   * append-only and the item genuinely was removed at that time. The entry drops
   * out of the panel because the item is a member again, not because the history
   * was rewritten.
   */
  async function putBackRemoval(removal) {
    if (reAddingRemovalId) return false;
    setReAddingRemovalId(removal.id);
    try {
      const result = await reAddRemoval(removal, { userId: user.id });
      if (result.error) {
        reportMembershipError("put that item back", result.error);
        return false;
      }
      // alreadyPresent means a double tap, or the other person restored it first.
      // That is the desired end state, so it is a quiet success, not a warning.
      await loadCollectionMembers([removal.collectionId]);
      await loadCollectionRemovals(removal.collectionId);
      return true;
    } finally {
      setReAddingRemovalId(null);
    }
  }

  // saveMemberQuantity and saveMemberOrder are the two writes that are NOT
  // wrapped in withLoading, so nothing else stops a poll tick landing in the
  // middle of one and reverting the change until the next tick. They hold the
  // poll off for their own duration.
  async function saveMemberQuantity(collectionId, itemId, quantity) {
    memberWriteInFlight.current += 1;
    try {
      const result = await updateMemberQuantity(collectionId, itemId, quantity);
      if (result.error) {
        reportMembershipError("save that quantity", result.error);
        await loadCollectionMembers([collectionId]);
        return false;
      }
      setMembersFor(collectionId, (prev) =>
        prev.map((m) => (m.itemId === itemId ? result.data : m)),
      );
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
    }
  }

  /**
   * Clear the items checked off during an execution, recording each as a
   * 'completed' removal.
   *
   * One removeMembers call rather than a loop over singular removals: every row
   * must land in a single INSERT so they share the server's transaction
   * timestamp exactly, which is what lets the history view group a bulk
   * clear-out under one heading.
   */
  async function clearCompletedFromCollection(collectionId, itemIds) {
    const result = await removeMembers(collectionId, itemIds, {
      reason: REMOVAL_COMPLETED,
      userId: user.id,
    });
    await loadCollectionMembers([collectionId]);
    if (result.error) {
      reportMembershipError("clear the completed items", result.error);
      return false;
    }
    return true;
  }

  async function saveMemberOrder(collectionId, orderedMembers) {
    memberWriteInFlight.current += 1;
    try {
      const result = await reorderMembers(collectionId, orderedMembers);
      if (result.error) {
        reportMembershipError("save the new order", result.error);
        await loadCollectionMembers([collectionId]);
        return false;
      }
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
    }
  }

  async function refreshCollection(collectionId) {
    const coll = await storage.get(`item_collections:${collectionId}`);
    if (coll) {
      setCollections((prev) =>
        prev.map((c) => (c.id === collectionId ? coll : c))
      );
    }
    await loadCollectionMembers([collectionId]);
  }

  // The core save, with the target passed in rather than read from
  // `editingContext`. Context detail edits in place now (Step 5) and has its own
  // notion of what it is editing; making it set Alfred's modal state first would
  // have meant two sources of truth for the same question.
  async function saveContextRecord(
    existing,
    name,
    shared = false,
    keywords = "",
    description = "",
    pinned = false,
    defaultCollectionId = null,
  ) {
    return withLoading('Saving context...', async () => {
      // The <select> uses "" for "none", but default_collection_id is a FK to
      // item_collections.id — an empty string would violate it. Normalise here,
      // at the single point every caller funnels through.
      const defaultCollection = defaultCollectionId || null;
      const context = existing
        ? {
            ...existing,
            name,
            shared,
            keywords,
            description,
            pinned,
            defaultCollectionId: defaultCollection,
          }
        : {
            id: uid(),
            user_id: user.id,
            name,
            shared,
            keywords,
            description,
            pinned,
            defaultCollectionId: defaultCollection,
            createdAt: new Date().toISOString(),
          };

      await storage.set(`context:${context.id}`, context, shared);

      if (existing) {
        setContexts((prev) =>
          prev.map((c) => (c.id === context.id ? context : c)),
        );
      } else {
        setContexts((prev) => [...prev, context]);
      }
    });
  }

  // The Contexts page's form, which is driven by the `editingContext` modal
  // slot. Clearing that slot is a page concern, so it stays here rather than in
  // the shared core.
  async function saveContext(
    name,
    shared = false,
    keywords = "",
    description = "",
    pinned = false,
    defaultCollectionId = null,
  ) {
    await saveContextRecord(
      editingContext,
      name,
      shared,
      keywords,
      description,
      pinned,
      defaultCollectionId,
    );
    setShowContextForm(false);
    setEditingContext(null);
  }

  function getIntentDisplay(intent) {
    if (intent.text) return intent.text;
    if (intent.itemId) {
      const item = items.find((i) => i.id === intent.itemId);
      return item?.name || "Untitled";
    }
    return intent.text || "Untitled";
  }

  function viewContextDetail(contextId) {
    setPreviousView(view);
    setSelectedContextId(contextId);
    setView("context-detail");
  }

  function viewIntentionDetail(intentionId, fromView) {
    setSelectedIntentionId(intentionId);
    setIntentionReturnView(fromView || view);
    setView("intention-detail");
  }

  function handleBackFromIntentionDetail() {
    if (unsavedChangesRef.current) {
      const label = unsavedChangesLabelRef.current || "this form";
      if (!window.confirm(`You have unsaved changes to ${label}. Discard and navigate away?`)) return;
      unsavedChangesRef.current = false;
      unsavedChangesLabelRef.current = "";
    }
    setSelectedIntentionId(null);
    setView(intentionReturnView);
  }

  function viewItemDetail(itemId, fromView) {
    // If already on item-detail, push current item onto stack
    if (view === "item-detail" && selectedItemId) {
      setItemHistoryStack((prev) => [...prev, selectedItemId]);
    } else {
      setPreviousView(fromView || view);
      setItemHistoryStack([]);
    }
    setSelectedItemId(itemId);
    setView("item-detail");
  }

  function handleBackFromItemDetail() {
    if (unsavedChangesRef.current) {
      const label = unsavedChangesLabelRef.current || "this form";
      if (!window.confirm(`You have unsaved changes to ${label}. Discard and navigate away?`)) return;
      unsavedChangesRef.current = false;
      unsavedChangesLabelRef.current = "";
    }
    if (itemHistoryStack.length > 0) {
      // Pop back to previous item
      const stack = [...itemHistoryStack];
      const prevItemId = stack.pop();
      setItemHistoryStack(stack);
      setSelectedItemId(prevItemId);
    } else {
      setSelectedItemId(null);
      setView(previousView);
    }
  }

  async function handleAddItemToContext(
    name,
    elements,
    contextId,
    description = "",
    isCaptureTarget = false,
  ) {
    return withLoading('Saving...', async () => {
      const newItem = {
        id: uid(),
        user_id: user.id,
        name: name || "New Item",
        description: description || "",
        contextId: contextId,
        elements: elements || [],
        isCaptureTarget: isCaptureTarget || false,
        createdAt: new Date().toISOString(),
      };

      const context = contexts.find((c) => c.id === contextId);
      const isShared = context?.shared || false;

      await storage.set(`item:${newItem.id}`, newItem, isShared);
      setItems([...items, newItem]);
    });
  }

  async function handleAddIntentionToContext(
    text,
    contextId,
    itemId = null,
    collectionId = null,
    recurrenceConfig = null,
  ) {
    return withLoading('Saving...', async () => {
      const newIntent = {
        id: uid(),
        user_id: user.id,
        text: text || "New Intention",
        createdAt: new Date().toISOString(),
        isIntention: true,
        isItem: false,
        archived: false,
        itemId: itemId,
        contextId: contextId,
        recurrenceConfig: recurrenceConfig,
        collectionId: collectionId,
      };

      await storage.set(`intent:${newIntent.id}`, newIntent);
      setIntents([...intents, newIntent]);
      return newIntent.id; // Return the ID so it can be scheduled
    });
  }


  // Collection CRUD
  async function addCollection(name, contextId = null) {
    return withLoading('Creating collection...', async () => {
      const newColl = {
        id: uid(),
        userId: user.id,
        name: name || "New Collection",
        contextId: contextId || null,
        shared: false,
        isCaptureTarget: false,
        // Explicit rather than leaning on the column default, so the object in
        // local state has the same shape as one read back from the database —
        // `updateCollection` spreads the whole row, and `activeCollections`
        // filters on this field.
        archived: false,
        // No items seed: membership lives in collection_items now. The jsonb
        // column keeps its own '[]' default and is never written again.
        createdAt: new Date().toISOString(),
      };
      await storage.set(`item_collections:${newColl.id}`, newColl);
      setCollections((prev) => [...prev, newColl]);
      return newColl.id;
    });
  }

  // Collection metadata only — name, context, shared, pinned. Membership goes
  // through the collection_items helpers above.
  async function updateCollection(collId, updates, silent = false) {
    const coll = collections.find((c) => c.id === collId);
    if (!coll) return;
    const doSave = async () => {
      await storage.set(`item_collections:${coll.id}`, { ...coll, ...updates });
      // Functional updater: apply the patch to the freshest state rather than
      // replacing the row with a snapshot captured at render time, which is an
      // independent cause of lost concurrent edits.
      setCollections((prev) =>
        prev.map((c) => (c.id === collId ? { ...c, ...updates } : c)),
      );
    };
    if (silent) {
      try { await doSave(); } catch (e) { console.error('Collection save error:', e); }
    } else {
      return withLoading('Saving...', doSave);
    }
  }

  // Archive, not delete. Hard-deleting a collection cascades to
  // `collection_items` AND `collection_item_removals` — and the latter is an
  // append-only log of what was taken out of the collection and when, which is
  // the recovery path for accidental removals during shopping. Destroying that
  // behind a 5-second Undo was not acceptable, so collections became
  // soft-deletable like every other Alfred entity. See the spec's Undo section,
  // exception 2. The only hard delete left is the Recycle Bin's terminal one.
  //
  // Membership is deliberately left in `collectionMembers`: a soft delete does
  // not touch `collection_items`, so the cached rows stay correct and Undo has
  // nothing to rebuild.
  async function archiveCollection(collId) {
    const coll = collections.find((c) => c.id === collId);
    if (!coll) return;
    return withLoading('Archiving...', async () => {
      const archived = { ...coll, archived: true };
      await storage.set(`item_collections:${collId}`, archived);
      setCollections((prev) => prev.map((c) => (c.id === collId ? archived : c)));

      offerUndoFor(`Archived "${coll.name}".`, async () => {
        await storage.set(`item_collections:${collId}`, coll);
        setCollections((prev) => prev.map((c) => (c.id === collId ? coll : c)));
      });
    });
  }

  // Filter events to only show those with valid, non-archived intents
  const validEvents = events.filter((e) => {
    if (e.archived) return false;
    const intent = intents.find((i) => i.id === e.intentId);
    return intent && !intent.archived;
  });

  const todayEvents = validEvents.filter((e) => {
    const today = getTodayDate();
    // Include all events that are today or in the past (validEvents already excludes archived)
    return e.time <= today;
  });
  const allNonArchivedEvents = validEvents;
  // Contexts are soft-deletable from Step 11. Same split as activeCollections:
  // `activeContexts` for anything that offers a CHOICE, raw `contexts` for
  // anything that resolves an ID — an archived context's name must still render
  // on a Recycle Bin row, an execution badge, and every item that was in it.
  const activeContexts = contexts.filter((c) => !c.archived);
  const pinnedContexts = activeContexts.filter((c) => c.pinned);

  // Contexts are taxonomy, not content, so archiving one is only safe while it
  // holds nothing — nothing cascades, and nothing is left pointing at a parent
  // the UI has stopped showing.
  //
  // ARCHIVED CHILDREN COUNT. An archived item still belongs to its context, and
  // there is a concrete reason beyond principle: the Recycle Bin labels each
  // archived row with its context name, and restoring an item whose context is
  // archived would put it somewhere with no page to reach. Emptiness means "no
  // children at all", not "no live children".
  //
  // All four counts come from state already loaded — `loadData` selects every
  // row of each table without a filter — so this needs no query.
  function contextChildCounts(contextId) {
    return {
      items: items.filter((i) => i.contextId === contextId).length,
      intentions: intents.filter((i) => i.contextId === contextId).length,
      events: events.filter((e) => e.contextId === contextId).length,
      collections: collections.filter((c) => c.contextId === contextId).length,
    };
  }

  /** Human list of what is stopping a context being archived; empty when clear. */
  function contextArchiveBlockers(contextId) {
    const counts = contextChildCounts(contextId);
    const label = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
    const parts = [];
    if (counts.items) parts.push(label(counts.items, "item", "items"));
    if (counts.intentions)
      parts.push(label(counts.intentions, "intention", "intentions"));
    if (counts.events) parts.push(label(counts.events, "event", "events"));
    if (counts.collections)
      parts.push(label(counts.collections, "collection", "collections"));
    return parts;
  }

  async function archiveContext(contextId) {
    const context = contexts.find((c) => c.id === contextId);
    if (!context) return;
    // Belt and braces: the button is disabled when this is non-empty, but the
    // counts come from state that a realtime insert can change between render
    // and click.
    const blockers = contextArchiveBlockers(contextId);
    if (blockers.length > 0) {
      window.alert(
        `Cannot archive "${context.name}": it still holds ${blockers.join(", ")}.`,
      );
      return;
    }
    return withLoading("Archiving...", async () => {
      const archived = { ...context, archived: true };
      await storage.set(`context:${contextId}`, archived, context.shared);
      setContexts((prev) => prev.map((c) => (c.id === contextId ? archived : c)));

      offerUndoFor(`Archived "${context.name}".`, async () => {
        await storage.set(`context:${contextId}`, context, context.shared);
        setContexts((prev) => prev.map((c) => (c.id === contextId ? context : c)));
      });
    });
  }

  // Collections are soft-deleted from Step 4b, so `collections` now holds
  // archived rows too — the Recycle Bin reads them from there. Everything else
  // wants the live ones, and "everything else" is about fifteen places: three
  // lists plus a collection picker on IntentionCard, InboxCard, and three
  // detail views. Filtering once here rather than at each use is the same move
  // `validEvents` above makes, for the same reason — fifteen filter sites is
  // fifteen places to forget one.
  //
  // Pass `activeCollections` to anything that offers a choice; keep raw
  // `collections` for lookups by id, which must still resolve for a row that is
  // archived (the detail view during an archive, and Undo restoring it).
  // Needs `intents` and `getIntentDisplay` in scope, so unlike the other three
  // accessor bags this one cannot be module-level. The name shown on an event
  // row is its own text when it has one, and the intention's otherwise —
  // exactly what the row renders, so sorting by Name matches what you can read.
  const eventSortAccessors = {
    title: (e) =>
      e.text || getIntentDisplay(intents.find((i) => i.id === e.intentId) || {}),
    time: (e) => e.time,
    created: (e) => e.createdAt,
    updated: (e) => e.updatedAt,
  };

  // Home's Today tab used to end with `.sort((a, b) => a.time.localeCompare(b.time))`
  // and a "Sort by oldest date first" comment. That order is now the control's
  // DEFAULT rather than a fixture, so day one looks identical and every other
  // order becomes reachable.
  //
  // Schedule had no sort at all — `allNonArchivedEvents` is a bare alias, so its
  // order was whatever Postgres returned from an unordered SELECT, further
  // mutated by local appends and realtime inserts. That is why it could reshuffle
  // between sessions. Sorting here fixes it by construction: the order is now a
  // function of the rows and the preference, neither of which depends on the
  // order they arrived in.
  const sortedTodayEvents = sortRows(
    todayEvents, homeSort.sortKey, eventSortAccessors, homeSort.sortDir,
  );
  const sortedScheduleEvents = sortRows(
    allNonArchivedEvents, scheduleSort.sortKey, eventSortAccessors, scheduleSort.sortDir,
  );

  const activeCollections = collections.filter((c) => !c.archived);
  const pinnedCollections = activeCollections.filter((c) => c.pinned);
  const allLiveExecutions = [...activeExecutions, ...pausedExecutions];

  function openExecution(exec) {
    setPreviousView(view);
    setActiveExecution(exec);
    goToExecution(exec);
  }

  async function startNowFromItem(itemId) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    return withLoading('Starting execution...', async () => {
      // Create intention linked to this item
      const newIntent = {
        id: uid(),
        user_id: user.id,
        text: item.name,
        createdAt: new Date().toISOString(),
        isIntention: true,
        isItem: false,
        archived: false,
        itemId: item.id,
        contextId: item.contextId || null,
        recurrenceConfig: { type: "once" },
      };
      await storage.set(`intent:${newIntent.id}`, newIntent);
      setIntents((prev) => [...prev, newIntent]);

      // Create event for today
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: newIntent.id,
        time: getTodayDate(),
        itemIds: [item.id],
        contextId: item.contextId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      await storage.set(`event:${newEvent.id}`, newEvent);
      setEvents((prev) => [...prev, newEvent]);

      // Build execution inline (can't call activate — state hasn't updated yet)
      let itemElements = [];
      if (item.elements || item.components) {
        const rawEls = (item.elements || item.components).map((el) =>
          typeof el === "string"
            ? { name: el, displayType: "step", quantity: "", description: "" }
            : { ...el }
        );
        // Flatten item references
        const getItem = (id) => items.find((i) => i.id === id) || null;
        const flattened = await flattenElements(rawEls, getItem);
        itemElements = flattened.map((el) => ({
          ...el,
          isCompleted: false,
          completedAt: null,
          inProgress: false,
          startedAt: null,
          sourceItemId: el.sourceItemId || item.id,
        }));
      }

      const execution = {
        id: uid(),
        user_id: user.id,
        eventId: newEvent.id,
        intentId: newIntent.id,
        contextId: item.contextId || null,
        itemIds: [item.id],
        startedAt: new Date().toISOString(),
        status: "active",
        notes: "",
        elements: itemElements,
        progress: [],
      };

      await storage.set(`execution:${execution.id}`, execution);
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      goToExecution(execution);
    });
  }

  async function startNowFromIntention(intentId) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    return withLoading('Starting execution...', async () => {
      // Find linked item if any
      const linkedItem = intent.itemId
        ? items.find((i) => i.id === intent.itemId)
        : null;

      // Create event for today
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: intent.id,
        time: getTodayDate(),
        itemIds: linkedItem ? [linkedItem.id] : [],
        contextId: intent.contextId || null,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      await storage.set(`event:${newEvent.id}`, newEvent);
      setEvents((prev) => [...prev, newEvent]);

      // Collection-based execution
      if (intent.collectionId) {
        const execution = {
          id: uid(),
          user_id: user.id,
          eventId: newEvent.id,
          intentId: intent.id,
          contextId: intent.contextId || null,
          collectionId: intent.collectionId,
          itemIds: [],
          startedAt: new Date().toISOString(),
          status: "active",
          notes: "",
          elements: [],
          completedItemIds: [],
          progress: [],
        };
        await storage.set(`execution:${execution.id}`, execution);
        await startNotificationChain(execution);
        setActiveExecution(execution);
        setActiveExecutions((prev) => [execution, ...prev]);
        setPreviousView(view);
        goToExecution(execution);
        return;
      }

      // Build execution elements from linked item
      let itemElements = [];
      if (linkedItem && (linkedItem.elements || linkedItem.components)) {
        const rawEls = (linkedItem.elements || linkedItem.components).map((el) =>
          typeof el === "string"
            ? { name: el, displayType: "step", quantity: "", description: "" }
            : { ...el }
        );
        const getItem = (id) => items.find((i) => i.id === id) || null;
        const flattened = await flattenElements(rawEls, getItem);
        itemElements = flattened.map((el) => ({
          ...el,
          isCompleted: false,
          completedAt: null,
          inProgress: false,
          startedAt: null,
          sourceItemId: el.sourceItemId || linkedItem.id,
        }));
      }

      const execution = {
        id: uid(),
        user_id: user.id,
        eventId: newEvent.id,
        intentId: intent.id,
        contextId: intent.contextId || null,
        itemIds: linkedItem ? [linkedItem.id] : [],
        startedAt: new Date().toISOString(),
        status: "active",
        notes: "",
        elements: itemElements,
        progress: [],
      };

      await storage.set(`execution:${execution.id}`, execution);
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      goToExecution(execution);
    });
  }

  // Intentions: Marked as intentions, not archived, no active event
  const intentionsWithoutActiveEvent = intents.filter((i) => {
    if (!i.isIntention || i.archived) return false;
    const hasActiveEvent = validEvents.some((e) => e.intentId === i.id);
    return !hasActiveEvent;
  });

  const memoriesWithoutContext = items.filter((i) => !i.contextId && !i.archived);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  if (!dataLoaded) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          <p className="text-foreground font-medium">Loading your data...</p>
        </div>
      </div>
    );
  }

  if (view === "sam") {
    return (
      <SamPlayer
        onBack={() => setView(previousView || "home")}
      />
    );
  }

  if (view === "timer") {
    return (
      <TimerPage
        onBack={() => setView(previousView || "home")}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {isLoading && <LoadingOverlay message={loadingMessage} />}

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
              {[
                { key: "home", label: "Home", icon: <Home className="w-4 h-4" /> },
                { key: "inbox", label: `Inbox${inboxItems.length > 0 ? ` (${inboxItems.length})` : ""}`, icon: <Inbox className="w-4 h-4" /> },
                { key: "contexts", label: "Contexts", icon: <FolderOpen className="w-4 h-4" /> },
                { key: "schedule", label: `Schedule${allNonArchivedEvents.length > 0 ? ` (${allNonArchivedEvents.length})` : ""}`, icon: <Calendar className="w-4 h-4" /> },
                { key: "intentions", label: "Intentions", icon: <Lightbulb className="w-4 h-4" /> },
                { key: "memories", label: "Memories", icon: <Star className="w-4 h-4" /> },
                { key: "collections", label: "Collections", icon: <ClipboardList className="w-4 h-4" /> },
                { key: "timer", label: "Timer", icon: <Timer className="w-4 h-4" /> },
                { key: "sam", label: "Sam", icon: <Music className="w-4 h-4" /> },
                { key: "games", label: "Games", icon: <Gamepad2 className="w-4 h-4" /> },
              ].map((item) => (
                <button
                  key={item.key}
                  onClick={() => {
                    if (!confirmDiscardIfDirty()) return;
                    if (item.key === "sam" || item.key === "timer") setPreviousView(view);
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
                    {item.icon} {item.label}
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

          {/* Desktop navigation tabs */}
          <nav className="flex gap-2 mt-3 pb-1">
            <AppLink
              view="home"
              onNavigate={() => guardedSetView("home")}
              className={`inline-flex items-center px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "home"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Home
            </AppLink>
            <AppLink
              view="inbox"
              onNavigate={() => guardedSetView("inbox")}
              className={`inline-flex items-center px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "inbox"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Inbox {inboxItems.length > 0 && `(${inboxItems.length})`}
            </AppLink>
            <AppLink
              view="contexts"
              onNavigate={() => guardedSetView("contexts")}
              className={`inline-flex items-center px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "contexts"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Contexts
            </AppLink>
            <AppLink
              view="schedule"
              onNavigate={() => guardedSetView("schedule")}
              className={`inline-flex items-center px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "schedule"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Schedule{" "}
              {allNonArchivedEvents.length > 0 &&
                `(${allNonArchivedEvents.length})`}
            </AppLink>
            <AppLink
              view="intentions"
              onNavigate={() => guardedSetView("intentions")}
              className={`inline-flex items-center px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "intentions"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Intentions
            </AppLink>
            <AppLink
              view="memories"
              onNavigate={() => guardedSetView("memories")}
              className={`inline-flex items-center px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "memories"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Memories
            </AppLink>
            <AppLink
              view="collections"
              onNavigate={() => guardedSetView("collections")}
              className={`inline-flex items-center px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "collections"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Collections
            </AppLink>
            <AppLink
              view="timer"
              onNavigate={() => {
                if (!confirmDiscardIfDirty()) return;
                setPreviousView(view);
                setView("timer");
              }}
              className={`inline-flex items-center px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "timer"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Timer
            </AppLink>
            <AppLink
              view="sam"
              onNavigate={() => {
                if (!confirmDiscardIfDirty()) return;
                setPreviousView(view);
                setView("sam");
              }}
              className={`inline-flex items-center px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "sam"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Sam
            </AppLink>
            <AppLink
              view="games"
              onNavigate={() => guardedSetView("games")}
              className={`inline-flex items-center px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "games"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Games
            </AppLink>
          </nav>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-28 sm:pb-32">
        {/* Home View */}
        {view === "home" && (
          <div>
            {/* Executions & Today Tabs */}
            <div className="mb-8">
              <div className="flex gap-6 border-b border-border mb-4">
                <button
                  onClick={() => setExecutionTab("active")}
                  className={`pb-2 border-b-2 cursor-pointer transition-colors ${
                    executionTab === "active"
                      ? "border-primary text-primary font-medium"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                  }`}
                >
                  Active ({activeExecutions.length})
                </button>
                {pausedExecutions.length > 0 && (
                  <button
                    onClick={() => setExecutionTab("paused")}
                    className={`pb-2 border-b-2 cursor-pointer transition-colors ${
                      executionTab === "paused"
                        ? "border-primary text-primary font-medium"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                    }`}
                  >
                    Paused ({pausedExecutions.length})
                  </button>
                )}
                <button
                  onClick={() => setExecutionTab("today")}
                  className={`pb-2 border-b-2 cursor-pointer transition-colors ${
                    executionTab === "today"
                      ? "border-primary text-primary font-medium"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                  }`}
                >
                  Today ({todayEvents.length})
                </button>
              </div>

              {executionTab === "active" && (
                <div className="space-y-2">
                  {activeExecutions.length > 0 ? (
                    activeExecutions.map((exec) => (
                      <ExecutionBadge
                        key={exec.id}
                        exec={exec}
                        intents={intents}
                        contexts={contexts}
                        getIntentDisplay={getIntentDisplay}
                        onOpen={openExecution}
                      />
                    ))
                  ) : (
                    <p className="text-muted-foreground text-sm">No active executions.</p>
                  )}
                </div>
              )}

              {executionTab === "paused" && (
                <div className="space-y-2">
                  {pausedExecutions.length > 0 ? (
                    pausedExecutions.map((exec) => (
                      <ExecutionBadge
                        key={exec.id}
                        exec={exec}
                        intents={intents}
                        contexts={contexts}
                        getIntentDisplay={getIntentDisplay}
                        onOpen={openExecution}
                      />
                    ))
                  ) : (
                    <p className="text-muted-foreground text-sm">No paused executions.</p>
                  )}
                </div>
              )}

              {executionTab === "today" && (
                <div className="space-y-2">
                  {/* Inside the Today panel, not above the tab bar — Active and
                      Paused are execution lists ordered by started_at and this
                      does not govern them. */}
                  {todayEvents.length > 0 && (
                    <SortControl
                      id="home-sort"
                      options={EVENT_SORT_OPTIONS}
                      sortKey={homeSort.sortKey}
                      sortDir={homeSort.sortDir}
                      onChooseKey={homeSort.chooseKey}
                      onToggleDir={homeSort.toggleDir}
                      className="mb-3"
                    />
                  )}
                  {sortedTodayEvents.length > 0 ? (
                    sortedTodayEvents.map((event) => {
                      const intent = intents.find((i) => i.id === event.intentId);
                      if (!intent) return null;
                      return (
                        <EventCard
                          key={event.id}
                          event={event}
                          intent={intent}
                          contexts={contexts}
                          onUpdate={updateEvent}
                          onActivate={activate}
                          getIntentDisplay={getIntentDisplay}
                          executions={allLiveExecutions}
                          onOpenExecution={openExecution}
                          onCancelExecution={cancelExecutionForEvent}
                        />
                      );
                    })
                  ) : (
                    <p className="text-muted-foreground text-sm">No events scheduled for today.</p>
                  )}
                </div>
              )}
            </div>

            {/* Pinned Collections Section */}
            {pinnedCollections.length > 0 && (
              <div>
                <h3 className="text-lg font-medium mb-3 text-foreground">Pinned Collections</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {pinnedCollections.map((coll) => (
                    <CollectionCard
                      key={coll.id}
                      collection={coll}
                      contexts={contexts}
                      memberCount={membersOf(coll.id).length}
                      onOpen={() => {
                        setPreviousView("home");
                        setSelectedCollectionId(coll.id);
                        setView("collection-detail");
                      }}
                      onArchive={archiveCollection}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Pinned Contexts Section */}
            <div className="mt-6">
              <h3 className="text-lg font-medium mb-3 text-foreground">Pinned Contexts</h3>
              {pinnedContexts.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No pinned contexts. Pin contexts to see them here.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {pinnedContexts.map((context) => (
                    <ContextCard
                      key={context.id}
                      context={context}
                      onClick={() => viewContextDetail(context.id)}
                      showSettings={false}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Inbox View */}
        {view === "inbox" && (
          <div>
            <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Inbox</h2>
            {inboxItems.length > 0 && (
              <SortControl
                id="inbox-sort"
                options={INBOX_SORT_OPTIONS}
                sortKey={inboxSort.sortKey}
                sortDir={inboxSort.sortDir}
                onChooseKey={inboxSort.chooseKey}
                onToggleDir={inboxSort.toggleDir}
                className="mb-3"
              />
            )}
            {inboxItems.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>Empty inbox.</p>
                <p className="text-sm mt-2">This is success, not failure.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {sortRows(
                  inboxItems, inboxSort.sortKey, INBOX_ACCESSORS, inboxSort.sortDir,
                ).map((inboxItem) => (
                  <InboxCard
                    key={inboxItem.id}
                    inboxItem={inboxItem}
                    contexts={contexts}
                    items={items}
                    collections={activeCollections}
                    onSave={handleInboxSave}
                    onDelete={deleteInboxItem}
                    onEnrich={handleInboxEnrich}
                    onDirtyChange={setUnsavedChanges}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Contexts View */}
        {view === "contexts" && (
          <div>
            <div className="flex items-center justify-between mb-3 sm:mb-4">
              <h2 className="text-lg sm:text-xl font-medium">Contexts</h2>
              <button
                onClick={() => {
                  setEditingContext(null);
                  setShowContextForm(true);
                }}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Plus className="w-4 h-4" />
                Add Context
              </button>
            </div>

            {showContextForm ? (
              <ContextForm
                editing={editingContext}
                stickyFooter
                collections={collections}
                onSave={saveContext}
                onCancel={() => {
                  setShowContextForm(false);
                  setEditingContext(null);
                }}
                onDirtyChange={setUnsavedChanges}
              />
            ) : activeContexts.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No contexts yet.</p>
                <p className="text-sm mt-2">
                  Add a context to define how things get done.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <SortControl
                  id="contexts-sort"
                  options={NAMED_RECORD_SORT_OPTIONS}
                  sortKey={contextsSort.sortKey}
                  sortDir={contextsSort.sortDir}
                  onChooseKey={contextsSort.chooseKey}
                  onToggleDir={contextsSort.toggleDir}
                  className="mb-1"
                />
                {/* Was a hardcoded `.sort(a.name.localeCompare(b.name))`. That
                    order is now this page's DEFAULT rather than its only option.

                    Context DETAIL's sub-lists are deliberately untouched — its
                    Items still sort by updatedAt descending, and its Intentions
                    and Collections keep their arrival order. The spec covers
                    list pages; detail pages hold five such sub-lists between
                    them, and giving each a control is a different decision. */}
                {sortRows(
                  activeContexts, contextsSort.sortKey, NAMED_RECORD_ACCESSORS, contextsSort.sortDir,
                ).map((context) => (
                  <ContextCard
                    key={context.id}
                    context={context}
                    onClick={() => viewContextDetail(context.id)}
                    onEdit={() => {
                      setEditingContext(context);
                      setShowContextForm(true);
                    }}
                    showSettings={true}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Context Detail View */}
        {view === "context-detail" && selectedContextId && (
          <ContextDetailView
            contextId={selectedContextId}
            context={contexts.find((c) => c.id === selectedContextId)}
            items={items.filter((i) => i.contextId === selectedContextId && !i.archived).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))}
            intents={intents.filter((i) => i.contextId === selectedContextId && !(i.isIntention && i.archived))}
            contexts={contexts}
            onBack={() => {
              setSelectedContextId(null);
              setView("contexts");
            }}
            getIntentDisplay={getIntentDisplay}
            onUpdateItem={updateItem}
            onUpdateIntent={updateIntent}
            onSchedule={moveToPlanner}
            onSaveContext={saveContextRecord}
            onArchiveContext={archiveContext}
            archiveBlockers={contextArchiveBlockers(selectedContextId)}
            onAddItem={handleAddItemToContext}
            onAddIntention={handleAddIntentionToContext}
            onViewIntentionDetail={(id) =>
              viewIntentionDetail(id, "context-detail")
            }
            onViewItemDetail={(id) => viewItemDetail(id, "context-detail")}
            executions={allLiveExecutions}
            onOpenExecution={openExecution}
            events={events}
            onUpdateEvent={updateEvent}
            onActivate={activate}
            onCancelExecution={cancelExecutionForEvent}
            onStartNow={startNowFromIntention}
            onArchiveIntention={archiveIntention}
            filterTag={filterTag}
            onFilterTag={setFilterTag}
            allItems={items}
            collections={activeCollections}
            collectionMembers={collectionMembers}
            onViewCollection={(id) => {
              setPreviousView("context-detail");
              setSelectedCollectionId(id);
              setView("collection-detail");
            }}
            onArchiveCollection={archiveCollection}
            onDirtyChange={setUnsavedChanges}
          />
        )}

        {/* Intention Detail View */}
        {view === "intention-detail" && selectedIntentionId && (
          <IntentionDetailView
            intention={intents.find((i) => i.id === selectedIntentionId)}
            events={events}
            contexts={contexts}
            items={items}
            onBack={handleBackFromIntentionDetail}
            onUpdateIntention={updateIntent}
            onEditIntention={() => {
              // For now, the user can see all events scheduled for this intention
              // Could add inline editing in the future
            }}
            onUpdateEvent={updateEvent}
            onUpdateItem={updateItem}
            onActivate={activate}
            getIntentDisplay={getIntentDisplay}
            onViewItemDetail={(id) => viewItemDetail(id, "intention-detail")}
            executions={allLiveExecutions}
            onOpenExecution={openExecution}
            onCancelExecution={cancelExecutionForEvent}
            onArchiveIntention={archiveIntention}
            onSchedule={moveToPlanner}
            onStartNow={startNowFromIntention}
            collections={activeCollections}
            onDirtyChange={setUnsavedChanges}
          />
        )}

        {/* Item Detail View */}
        {view === "item-detail" && selectedItemId && (
          <ItemDetailView
            item={items.find((i) => i.id === selectedItemId)}
            intents={intents}
            events={events}
            contexts={contexts}
            items={items}
            onBack={handleBackFromItemDetail}
            onAddToCollection={() => setView("item-add-to-collection")}
            onUpdateItem={updateItem}
            onEditItem={() => {
              // User can click item to edit inline
            }}
            onUpdateIntent={updateIntent}
            onSchedule={moveToPlanner}
            getIntentDisplay={getIntentDisplay}
            executions={allLiveExecutions.filter((ex) => ex.itemIds?.includes(selectedItemId))}
            onOpenExecution={openExecution}
            onStartNow={startNowFromItem}
            onUpdateEvent={updateEvent}
            onActivate={activate}
            onAddIntention={handleAddIntentionToContext}
            onCancelExecution={cancelExecutionForEvent}
            onStartNowIntention={startNowFromIntention}
            onArchiveIntention={archiveIntention}
            onViewItem={viewItemDetail}
            onViewIntentionDetail={(id) => viewIntentionDetail(id, "item-detail")}
            onClone={async (itemId, newName) => {
              const cloned = await deepCloneItem(itemId, newName);
              if (cloned) {
                viewItemDetail(cloned.id, "item-detail");
              }
            }}
            collections={activeCollections}
            onDirtyChange={setUnsavedChanges}
          />
        )}

        {/* Opening an execution from a URL rather than from in-app state —
            a pasted link, a refresh, or a notification tap. Without this the
            pane is blank for the length of the fetch, which reads as a broken
            link on the one path where the user has no other context. */}
        {view === "execution-detail" && !executionForRoute && awaitingExecutionLoad && (
          <div className="p-6 text-center text-muted-foreground">
            Opening execution…
          </div>
        )}

        {/* Execution Detail View. Rendered from executionForRoute, not
            activeExecution: on the render after the URL changes to a different
            execution, state still holds the previous one, and drawing it under
            the new address would show the wrong execution. */}
        {view === "execution-detail" && executionForRoute && (
          <ExecutionDetailView
            execution={executionForRoute}
            intent={intents.find((i) => i.id === executionForRoute.intentId)}
            event={events.find((e) => e.id === executionForRoute.eventId)}
            items={items}
            contexts={contexts}
            collections={collections}
            collectionMembers={collectionMembers}
            onToggleElement={toggleExecutionElement}
            onUpdateElement={updateExecutionElement}
            onToggleCollectionItem={toggleCollectionItem}
            onUpdateCollectionItemQty={saveMemberQuantity}
            onRefreshCollection={refreshCollection}
            onUpdateNotes={updateExecutionNotes}
            onComplete={() => closeExecution("done")}
            onPause={pauseExecution}
            onMakeActive={makeExecutionActive}
            onCancel={() => closeExecution("cancelled")}
            onBack={() => setView(previousView)}
            getIntentDisplay={getIntentDisplay}
          />
        )}

        {/* Schedule View */}
        {view === "schedule" && (
          <div>
            <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Schedule</h2>
            {allNonArchivedEvents.length > 0 && (
              <SortControl
                id="schedule-sort"
                options={EVENT_SORT_OPTIONS}
                sortKey={scheduleSort.sortKey}
                sortDir={scheduleSort.sortDir}
                onChooseKey={scheduleSort.chooseKey}
                onToggleDir={scheduleSort.toggleDir}
                className="mb-3"
              />
            )}
            {allNonArchivedEvents.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No scheduled events.</p>
                <p className="text-sm mt-2">This is a valid state.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {sortedScheduleEvents.map((event) => {
                  const intent = intents.find((i) => i.id === event.intentId);
                  if (!intent) return null;

                  return (
                    <EventCard
                      key={event.id}
                      event={event}
                      intent={intent}
                      contexts={contexts}
                      onUpdate={updateEvent}
                      onActivate={activate}
                      getIntentDisplay={getIntentDisplay}
                      executions={allLiveExecutions}
                      onOpenExecution={openExecution}
                      onCancelExecution={cancelExecutionForEvent}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Intentions View */}
        {view === "intentions" && (
          <div>
            <div className="flex items-center justify-between mb-3 sm:mb-4">
              <h2 className="text-lg sm:text-xl font-medium">Intentions</h2>
              <button
                onClick={() => setShowAddIntentionForm(true)}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Plus className="w-4 h-4" />
                Add Intention
              </button>
            </div>

            {showAddIntentionForm && (
              <div className="mb-3">
                <IntentionCard
                  intent={{
                    id: null,
                    text: "",
                    contextId: "",
                    isIntention: true,
                    isItem: false,
                    archived: false,
                    itemId: null,
                  }}
                  contexts={contexts}
                  items={items}
                  collections={activeCollections}
                  onUpdate={async (_, updates, scheduledDate) => {
                    const newIntentId = await handleAddIntentionToContext(
                      updates.text,
                      updates.contextId || null,
                      updates.itemId || null,
                      updates.collectionId || null,
                      updates.recurrenceConfig || null,
                    );
                    if (scheduledDate && newIntentId) {
                      moveToPlanner(newIntentId, scheduledDate);
                    }
                    setShowAddIntentionForm(false);
                  }}
                  onSchedule={moveToPlanner}
                  getIntentDisplay={getIntentDisplay}
                  showScheduling={true}
                  isEditing={true}
                  onCancel={() => setShowAddIntentionForm(false)}
                  onDirtyChange={setUnsavedChanges}
                />
              </div>
            )}

            <TagFilter entities={intentionsWithoutActiveEvent} activeTag={filterTag} onFilter={setFilterTag} />

            {intentionsWithoutActiveEvent.length === 0 && !showAddIntentionForm ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No available intentions.</p>
                <p className="text-sm mt-2">
                  All intentions are currently scheduled.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {intentionsWithoutActiveEvent
                  .filter((intent) => !filterTag || (intent.tags && intent.tags.includes(filterTag)))
                  .map((intent) => (
                  <IntentionCard
                    key={intent.id}
                    intent={intent}
                    contexts={contexts}
                    items={items}
                    collections={activeCollections}
                    onUpdate={updateIntent}
                    onSchedule={moveToPlanner}
                    onStartNow={startNowFromIntention}
                    getIntentDisplay={getIntentDisplay}
                    showScheduling={true}
                    onViewDetail={(id) => viewIntentionDetail(id, "intentions")}
                    events={validEvents}
                    onUpdateEvent={updateEvent}
                    onActivate={activate}
                    executions={allLiveExecutions}
                    onOpenExecution={openExecution}
                    onCancelExecution={cancelExecutionForEvent}
                    onArchive={archiveIntention}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Memories View */}
        {view === "memories" && (
          <div>
            <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Memories</h2>
            <TagFilter entities={memoriesWithoutContext} activeTag={filterTag} onFilter={setFilterTag} />
            {memoriesWithoutContext.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No memories without context.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {memoriesWithoutContext
                  .filter((item) => !filterTag || (item.tags && item.tags.includes(filterTag)))
                  .map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    contexts={contexts}
                    onUpdate={updateItem}
                    onViewDetail={(id) => viewItemDetail(id, "memories")}
                    executions={allLiveExecutions.filter((ex) => ex.itemIds?.includes(item.id))}
                    intents={intents}
                    getIntentDisplay={getIntentDisplay}
                    onOpenExecution={openExecution}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Collections View */}
        {view === "collections" && (
          <div>
            <div className="flex items-center justify-between mb-3 sm:mb-4">
              <h2 className="text-lg sm:text-xl font-medium">Collections</h2>
              <button
                onClick={async () => {
                  const id = await addCollection("New Collection");
                  if (id) {
                    setPreviousView("collections");
                    setSelectedCollectionId(id);
                    setView("collection-detail");
                  }
                }}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Plus className="w-4 h-4" />
                New Collection
              </button>
            </div>

            {contexts.length > 0 && (
              <div className="mb-3">
                <select
                  value={collectionContextFilter}
                  onChange={(e) => setCollectionContextFilter(e.target.value)}
                  className="px-3 py-2 min-h-[44px] border border-border rounded text-base"
                >
                  <option value="">All Contexts</option>
                  <option value="__none__">No Context</option>
                  {contexts.filter((c) => !c.archived).map((ctx) => (
                    <option key={ctx.id} value={ctx.id}>{ctx.name}</option>
                  ))}
                </select>
              </div>
            )}

            {(() => {
              const filtered = activeCollections.filter((coll) => {
                if (!collectionContextFilter) return true;
                if (collectionContextFilter === "__none__") return !coll.contextId;
                return coll.contextId === collectionContextFilter;
              });

              if (filtered.length === 0) return (
                <div className="text-center py-12 text-muted-foreground">
                  <p>No collections{collectionContextFilter ? " in this context" : " yet"}.</p>
                  <p className="text-sm mt-2">Create a collection to group items together.</p>
                </div>
              );

              return (
              <div className="space-y-2">
                <SortControl
                  id="collections-sort"
                  options={NAMED_RECORD_SORT_OPTIONS}
                  sortKey={collectionsSort.sortKey}
                  sortDir={collectionsSort.sortDir}
                  onChooseKey={collectionsSort.chooseKey}
                  onToggleDir={collectionsSort.toggleDir}
                  className="mb-1"
                />
                {sortRows(
                  filtered, collectionsSort.sortKey, NAMED_RECORD_ACCESSORS, collectionsSort.sortDir,
                ).map((coll) => (
                  <CollectionCard
                    key={coll.id}
                    collection={coll}
                    contexts={contexts}
                    memberCount={membersOf(coll.id).length}
                    onOpen={() => {
                      setPreviousView("collections");
                      setSelectedCollectionId(coll.id);
                      setView("collection-detail");
                    }}
                    onArchive={archiveCollection}
                  />
                ))}
              </div>
              );
            })()}
          </div>
        )}

        {/* Collection Detail View */}
        {view === "collection-detail" && (() => {
          const coll = collections.find((c) => c.id === selectedCollectionId);
          if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
          const members = membersOf(coll.id);
          // An item that has been put back is a resolved problem, so it drops out
          // of a panel meant for unresolved ones. The removal record itself stays
          // in the table — the history stays honest.
          const memberItemIds = new Set(members.map((m) => m.itemId));
          const recentRemovals = (collectionRemovals[coll.id] || [])
            .filter((r) => !memberItemIds.has(r.itemId))
            .slice(0, 5);
          const history = collectionHistory[coll.id] || [];
          return (
            <div>
              <button
                onClick={() => {
                  setSelectedCollectionId(null);
                  setView(previousView || "collections");
                }}
                className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Name</label>
                  <input
                    type="text"
                    value={coll.name}
                    onChange={(e) => {
                      const updated = { ...coll, name: e.target.value };
                      setCollections(collections.map((c) => (c.id === coll.id ? updated : c)));
                    }}
                    onBlur={() => updateCollection(coll.id, { name: coll.name }, true)}
                    className="w-full px-3 py-2 border border-border rounded text-base"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Context</label>
                  <select
                    value={coll.contextId || ""}
                    onChange={(e) => updateCollection(coll.id, { contextId: e.target.value || null })}
                    className="w-full px-3 py-2 border border-border rounded text-base"
                  >
                    <option value="">No context</option>
                    {/* Filtered inline rather than by swapping the prop: this
                        component also looks context names up by id for badges,
                        and an archived context must still resolve there. */}
                    {contexts.filter((c) => !c.archived).map((ctx) => (
                      <option key={ctx.id} value={ctx.id}>{ctx.name}</option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={coll.shared || false}
                    onChange={(e) => updateCollection(coll.id, { shared: e.target.checked })}
                    className="rounded accent-primary"
                  />
                  <span className="text-sm">Shared collection</span>
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={coll.pinned || false}
                    onChange={(e) => updateCollection(coll.id, { pinned: e.target.checked })}
                    className="rounded accent-primary"
                  />
                  <span className="text-sm">Pin to home</span>
                </label>

                {/* The column has existed since the collections migration and
                    ai-enrich has been reading it to decide where a capture
                    should go, but there was no UI — the only way to set it was
                    raw SQL, which is how Groceries got its flag. */}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={coll.isCaptureTarget || false}
                    onChange={(e) =>
                      updateCollection(coll.id, { isCaptureTarget: e.target.checked })
                    }
                    className="mt-1 rounded accent-primary"
                  />
                  <span className="text-sm">
                    Capture target
                    <span className="block text-xs text-muted-foreground">
                      Alfred files new captures here by default, and it is
                      preselected when adding an item's ingredients to a
                      collection.
                    </span>
                  </span>
                </label>

                <div>
                  {/* Membership — reads and writes both go to collection_items. */}
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-base font-medium">
                      Items ({members.length})
                    </h3>
                    <button
                      onClick={() => setView("collection-add-items")}
                      className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm"
                    >
                      <Plus className="w-4 h-4" />
                      Add Items
                    </button>
                  </div>

                  {collectionMembersError && (
                    <p className="text-xs text-destructive mb-2">{collectionMembersError}</p>
                  )}

                  {members.length >= 50 && members.length < 200 && (
                    <p className="text-xs text-warning mb-2">Warning: {members.length} items. Performance may degrade above 200.</p>
                  )}
                  {members.length >= 200 && (
                    <p className="text-xs text-destructive mb-2">Maximum 200 items reached.</p>
                  )}

                  {members.length === 0 ? (
                    <p className="text-muted-foreground text-sm py-4 text-center">No items in this collection</p>
                  ) : (
                    <div className="space-y-2">
                      {members.map((member, index) => {
                        const linkedItem = items.find((i) => i.id === member.itemId);
                        return (
                          <div
                            key={member.id || member.itemId || index}
                            className={`flex items-center gap-2 p-3 bg-card border border-border rounded-lg ${collDragIdx === index ? "opacity-50" : ""}`}
                            draggable
                            onDragStart={(e) => { setCollDragIdx(index); e.dataTransfer.effectAllowed = "move"; }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              if (collDragIdx === null || collDragIdx === index) return;
                              setMembersFor(coll.id, (prev) => {
                                const next = [...prev];
                                const [dragged] = next.splice(collDragIdx, 1);
                                next.splice(index, 0, dragged);
                                return next;
                              });
                              setCollDragIdx(index);
                            }}
                            onDragEnd={() => {
                              setCollDragIdx(null);
                              saveMemberOrder(coll.id, members);
                            }}
                          >
                            <GripVertical className="w-4 h-4 text-muted-foreground cursor-move flex-shrink-0" title="Drag to reorder" />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate">
                                <ItemNameLabel name={linkedItem?.name} />
                              </p>
                            </div>
                            {/* Quantity is disabled when the item cannot be shown:
                                setting an amount on something you cannot identify
                                is a guess, and it would be a silent edit to data
                                the owner can see and you cannot. Removing the row
                                stays available — a member you cannot see is exactly
                                the one you may need to get rid of. */}
                            <input
                              type="text"
                              value={member.quantity || ""}
                              disabled={!linkedItem}
                              title={linkedItem ? undefined : "This item cannot be shown, so its quantity cannot be edited"}
                              onChange={(e) => {
                                const quantity = e.target.value;
                                setMembersFor(coll.id, (prev) =>
                                  prev.map((m) => (m.itemId === member.itemId ? { ...m, quantity } : m)),
                                );
                              }}
                              // The typed value lives in collectionMembers until
                              // blur, which is exactly what the poll overwrites.
                              // Focus pauses the poll; the pause is not lifted
                              // until the save has settled, so a tick cannot land
                              // between blur and the write completing.
                              onFocus={() => setEditingQuantityItemId(member.itemId)}
                              onBlur={async () => {
                                await saveMemberQuantity(coll.id, member.itemId, member.quantity);
                                setEditingQuantityItemId(null);
                              }}
                              placeholder="Qty"
                              className="w-20 sm:w-24 px-2 py-2 border border-border rounded text-base disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            <button
                              onClick={() =>
                                withLoading('Removing...', () =>
                                  removeItemFromCollection(coll.id, member.itemId),
                                )
                              }
                              className="p-1 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-destructive"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Recently removed — manual removals only, most recent first,
                    plus the entry point to the full history. The whole region
                    disappears when there is neither history nor an error to
                    report; an empty panel on a fresh collection is noise. */}
                {(recentRemovals.length > 0 ||
                  collectionRemovalsError ||
                  history.length > 0 ||
                  collectionHistoryError) && (
                  <div className="pt-4 border-t border-border">
                    {(recentRemovals.length > 0 || collectionRemovalsError) && (
                      <>
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-base font-medium">Recently removed</h3>
                          {/* Also shown when the panel has rows but `history` is
                              stale: the poll refreshes removals, not history, so
                              a removal polled in from the other person would
                              otherwise have no way through to the full view.
                              The history view reloads on entry regardless. */}
                          {(history.length > 0 || recentRemovals.length > 0) && (
                            <button
                              onClick={() => setView("collection-history")}
                              className="min-h-[44px] text-sm text-primary hover:text-primary-hover"
                            >
                              View all
                            </button>
                          )}
                        </div>

                        {collectionRemovalsError && (
                          <p className="text-xs text-destructive mb-2">{collectionRemovalsError}</p>
                        )}

                        <div className="space-y-2">
                          {recentRemovals.map((removal) => (
                            <div
                              key={removal.id}
                              className="flex items-center gap-2 p-3 bg-card border border-border rounded-lg"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-sm truncate">
                                  <ItemNameLabel name={removal.itemName} />
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {friendlyDate(removal.removedAt)}
                                </p>
                              </div>
                              <button
                                onClick={() =>
                                  withLoading('Putting back...', () => putBackRemoval(removal))
                                }
                                disabled={reAddingRemovalId !== null}
                                className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm shrink-0 disabled:opacity-50"
                              >
                                <ArchiveRestore className="w-4 h-4" />
                                Put back
                              </button>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {/* A collection can have history worth reading while the panel
                        itself is empty — every removal was a completion, or every
                        manual one has been put back. Keep the history reachable. */}
                    {recentRemovals.length === 0 && !collectionRemovalsError && history.length > 0 && (
                      <button
                        onClick={() => setView("collection-history")}
                        className="flex items-center gap-2 min-h-[44px] text-sm text-primary hover:text-primary-hover"
                      >
                        <Archive className="w-4 h-4" />
                        View removal history
                      </button>
                    )}

                    {collectionHistoryError && (
                      <p className="text-xs text-destructive mt-2">{collectionHistoryError}</p>
                    )}
                  </div>
                )}

                <div className="pt-4 border-t border-border">
                  {/* Relabelled with the behaviour: this archives now, and the
                      row is recoverable from the Recycle Bin. The confirm is
                      gone — safety is the 5-second Undo, per governing rule 3.
                      Navigating away is unconditional because this page is
                      showing the record being archived. */}
                  <button
                    onClick={() => {
                      archiveCollection(coll.id);
                      setSelectedCollectionId(null);
                      setView("collections");
                    }}
                    className="px-4 py-2.5 min-h-[44px] bg-destructive hover:bg-destructive-hover text-white rounded-lg text-sm"
                  >
                    Archive Collection
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Collection Removal History View */}
        {view === "collection-history" && (() => {
          const coll = collections.find((c) => c.id === selectedCollectionId);
          if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
          const history = collectionHistory[coll.id] || [];
          const groups = groupRemovalsByAction(history);

          return (
            <div>
              <button
                onClick={() => setView("collection-detail")}
                className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Collection
              </button>

              <h2 className="text-lg font-medium mb-1">Removal history</h2>
              <p className="text-sm text-muted-foreground mb-3">
                {coll.name.trim()} — newest first
                {history.length >= 50 ? ", most recent 50" : ""}
              </p>

              {collectionHistoryError && (
                <p className="text-xs text-destructive mb-2">{collectionHistoryError}</p>
              )}

              {groups.length === 0 ? (
                !collectionHistoryError && (
                  <p className="text-muted-foreground text-sm py-4 text-center">
                    Nothing has been removed from this collection.
                  </p>
                )
              ) : (
                <div className="space-y-3">
                  {groups.map((group, groupIndex) =>
                    // A single removal carries its own timestamp inline, the same
                    // shape as the panel row. A heading over one item would be
                    // ceremony for nothing. Bulk actions get the heading, so the
                    // timestamp is stated once instead of on every row.
                    group.rows.length === 1 ? (
                      <div
                        key={group.rows[0].id}
                        className="flex items-start gap-2 p-3 bg-card border border-border rounded-lg"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">
                            <ItemNameLabel name={group.rows[0].itemName} />
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {friendlyDate(group.removedAt)}
                          </p>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {removalReasonLabel(group.reason)}
                        </span>
                      </div>
                    ) : (
                      <div
                        key={`${group.removedAt}-${group.reason}-${groupIndex}`}
                        className="p-3 bg-card border border-border rounded-lg"
                      >
                        {/* Same header shape as a single entry — count in the slot
                            a lone item's name occupies, timestamp beneath, reason
                            label on the right — so the two read as two shapes of
                            one thing rather than two components. */}
                        <div className="flex items-start gap-2 pb-2 mb-2 border-b border-border">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{group.rows.length} items</p>
                            <p className="text-xs text-muted-foreground">
                              {friendlyDate(group.removedAt)}
                            </p>
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {removalReasonLabel(group.reason)}
                          </span>
                        </div>
                        <div className="space-y-1">
                          {group.rows.map((removal) => (
                            <p key={removal.id} className="text-sm truncate">
                              <ItemNameLabel name={removal.itemName} />
                            </p>
                          ))}
                        </div>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Collection Add Items View */}
        {/* The picker. Back is a bare setView("item-detail"): it touches
            neither previousView (the shared slot holding where item detail
            itself came from) nor itemHistoryStack (a stack of item ids for
            item-to-item navigation). selectedItemId is untouched by this
            navigation and this view is keyed on it in DETAIL_VIEW_STATE, so
            no return address is needed. Same as collection-add-items. */}
        {view === "item-add-to-collection" && (() => {
          const target = items.find((i) => i.id === selectedItemId);
          if (!target) return <p className="text-muted-foreground">Item not found</p>;
          return (
            <ItemAddToCollection
              item={target}
              items={items}
              collections={collections}
              contexts={contexts}
              onBack={() => setView("item-detail")}
              onAdd={(collectionId, picks) =>
                addElementsToCollection(collectionId, target, picks)
              }
            />
          );
        })()}

        {view === "collection-add-items" && (() => {
          const coll = collections.find((c) => c.id === selectedCollectionId);
          if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
          const members = membersOf(coll.id);
          const existingItemIds = new Set(members.map((m) => m.itemId));
          const availableItems = items.filter((i) => !i.archived && !existingItemIds.has(i.id) && (!coll.contextId || i.contextId === coll.contextId));

          return (
            <CollectionAddItems
              availableItems={availableItems}
              contexts={contexts}
              collection={coll}
              onAdd={async (selectedItems) => {
                const added = await withLoading('Saving...', () =>
                  addItemsToCollection(
                    coll.id,
                    selectedItems.map((s) => ({ itemId: s.itemId, quantity: s.quantity })),
                  ),
                );
                // Stay on this screen if it failed, so the selection is not lost.
                if (added) setView("collection-detail");
              }}
              onCreateItem={async (itemName) => {
                // Create new item
                const newItem = {
                  id: uid(),
                  user_id: user.id,
                  name: itemName,
                  description: '',
                  contextId: coll.contextId,
                  elements: [],
                  tags: [],
                  isCaptureTarget: false,
                  createdAt: new Date().toISOString(),
                };

                // Save to database
                const context = contexts.find((c) => c.id === newItem.contextId);
                const isShared = context?.shared || false;
                await storage.set(`item:${newItem.id}`, newItem, isShared);

                // Add to local items state
                setItems((prev) => [...prev, newItem]);

                // Add to collection
                const added = await addItemsToCollection(coll.id, [
                  { itemId: newItem.id, quantity: '' },
                ]);

                // Close dialog
                if (added) setView("collection-detail");
              }}
              onCancel={() => setView("collection-detail")}
              maxItems={200 - members.length}
            />
          );
        })()}

        {/* Games View */}
        {view === "games" && <GamesPage />}

        {/* Settings View */}
        {view === "settings" && (
          <div>
            <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Settings</h2>
            <div className="p-4 sm:p-6 bg-card border border-border rounded-lg">
              <p className="text-muted-foreground">Settings coming soon...</p>
            </div>
            {process.env.REACT_APP_BUILD_TIMESTAMP && (
              <div className="mt-6 text-xs text-muted-foreground/60">
                <p>Last deployed: {new Date(process.env.REACT_APP_BUILD_TIMESTAMP).toLocaleString()}</p>
                <p>Commit: {(process.env.REACT_APP_COMMIT_SHA || 'local').slice(0, 7)}</p>
              </div>
            )}
          </div>
        )}

        {/* Recycle Bin View */}
        {view === "recycle" && (
          <div>
            <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Recycle Bin</h2>

            {/* Tabs */}
            <div className="flex gap-4 border-b border-border mb-4 overflow-x-auto">
              {[
                { key: "items", label: "Items" },
                { key: "intents", label: "Intents" },
                { key: "events", label: "Events" },
                { key: "executions", label: "Executions" },
                { key: "collections", label: "Collections" },
                { key: "contexts", label: "Contexts" },
                { key: "songs", label: "Songs" },
                { key: "snippets", label: "Snippets" },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setRecycleTab(tab.key)}
                  className={`pb-2 border-b-2 whitespace-nowrap cursor-pointer transition-colors text-sm ${
                    recycleTab === tab.key
                      ? "border-primary text-primary font-medium"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Bulk action bar */}
            <div className="flex items-center justify-between mb-3">
              <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                <input
                  type="checkbox"
                  checked={recycleData.length > 0 && recycleSelected.size === recycleData.length}
                  onChange={recycleSelectAll}
                  className="w-4 h-4 rounded border-border accent-primary"
                />
                <span className="text-sm text-muted-foreground">
                  {recycleSelected.size > 0
                    ? `${recycleSelected.size} selected`
                    : "Select all"}
                </span>
              </label>
              {recycleSelected.size > 0 && (
                <div className="flex gap-2">
                  <button
                    onClick={recycleBulkRestore}
                    disabled={recycleLoading}
                    className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-success hover:bg-secondary rounded-lg transition-colors min-h-[44px] disabled:opacity-50"
                  >
                    <ArchiveRestore className="w-4 h-4" />
                    Restore
                  </button>
                  <button
                    onClick={recycleBulkDelete}
                    disabled={recycleLoading}
                    className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-destructive hover:bg-secondary rounded-lg transition-colors min-h-[44px] disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                </div>
              )}
            </div>

            {/* Content */}
            {recycleLoading && recycleData.length === 0 ? (
              <p className="text-muted-foreground text-sm">Loading...</p>
            ) : recycleData.length === 0 ? (
              <p className="text-muted-foreground text-sm">No archived {recycleTab}.</p>
            ) : (
              <div className="space-y-2">
                {recycleData.map((record) => {
                  let title = "";
                  let subtitle = "";
                  const contextName = record.contextId
                    ? contexts.find((c) => c.id === record.contextId)?.name
                    : null;

                  switch (recycleTab) {
                    case "items":
                      title = record.name || "Untitled item";
                      subtitle = [contextName, (record.tags || []).join(", ")].filter(Boolean).join(" · ");
                      break;
                    case "intents":
                      title = record.text || "Untitled intent";
                      subtitle = [contextName, record.recurrenceConfig && record.recurrenceConfig.type !== "once" ? getRecurrenceDisplayString(record.recurrenceConfig) : null].filter(Boolean).join(" · ");
                      break;
                    case "events": {
                      const intent = intents.find((i) => i.id === record.intentId);
                      title = intent ? intent.text : "Unknown intent";
                      subtitle = [record.time, contextName].filter(Boolean).join(" · ");
                      break;
                    }
                    case "executions": {
                      const intent = intents.find((i) => i.id === record.intentId);
                      title = intent ? intent.text : "Unknown intent";
                      subtitle = [record.outcome, record.closedAt ? new Date(record.closedAt).toLocaleDateString() : null].filter(Boolean).join(" · ");
                      break;
                    }
                    case "collections":
                      title = record.name || "Untitled collection";
                      subtitle = contextName || "";
                      break;
                    case "contexts":
                      title = record.name || "Untitled context";
                      subtitle = [record.description, record.shared ? "Shared" : null]
                        .filter(Boolean)
                        .join(" · ");
                      break;
                    case "songs":
                      title = record.title || "Untitled song";
                      subtitle = record.artist || "";
                      break;
                    case "snippets":
                      title = record.title || "Untitled snippet";
                      subtitle = `Measures ${record.startMeasure}–${record.endMeasure}`;
                      break;
                    default:
                      break;
                  }

                  const updatedLabel = record.updatedAt
                    ? new Date(record.updatedAt).toLocaleDateString()
                    : "";

                  return (
                    <div
                      key={record.id}
                      className="flex items-center gap-3 px-4 py-3 bg-card border border-border rounded-lg group"
                    >
                      <input
                        type="checkbox"
                        checked={recycleSelected.has(record.id)}
                        onChange={() => recycleToggleSelect(record.id)}
                        className="w-4 h-4 flex-shrink-0 rounded border-border accent-primary"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-foreground truncate">{title}</p>
                        {(subtitle || updatedLabel) && (
                          <p className="text-xs text-muted-foreground truncate">
                            {[subtitle, updatedLabel].filter(Boolean).join(" · ")}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => recycleRestore(recycleTab, record.id)}
                        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-success transition-colors"
                        title="Restore"
                      >
                        <ArchiveRestore className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => recyclePermanentDelete(recycleTab, record.id)}
                        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                        title="Delete forever"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}

                {/* Load More */}
                {recycleHasMore && (
                  <button
                    onClick={() => loadRecycleBin(recycleTab, true)}
                    disabled={recycleLoading}
                    className="w-full py-3 text-sm text-primary hover:text-primary-hover font-medium disabled:opacity-50"
                  >
                    {recycleLoading ? "Loading..." : "Load more"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom dock: the Undo message stacked directly on top of the Capture
          bar. One bottom-anchored container rather than two, so the message is
          above the bar by document order instead of by a hard-coded offset —
          the bar's height changes as its textarea grows, and any offset would
          be wrong the moment somebody types a long capture. */}
      <div className="fixed bottom-0 left-0 right-0 z-20">
        <UndoMessage
          pendingUndo={pendingUndo}
          onUndo={runUndo}
          onDismiss={dismissUndo}
        />

        {/* Capture bar */}
        <div className="bg-white border-t border-border shadow-lg">
          <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2 sm:py-4">
            <div className="flex gap-2 items-end">
              <textarea
                ref={captureRef}
                value={captureText}
                onChange={(e) => {
                  setCaptureText(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight * 0.5) + "px";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleCapture();
                  }
                }}
                placeholder="Capture anything..."
                rows={1}
                className="flex-1 px-3 sm:px-4 py-2.5 sm:py-3 border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary resize-none overflow-hidden min-h-[44px] max-h-[50vh] text-base"
              />
              <button
                onClick={handleCapture}
                className="px-3 sm:px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                Capture
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper functions for InboxCard
/**
 * An item's name, or an honest stand-in when there isn't one.
 *
 * Two situations produce a missing name and the client cannot tell them apart:
 * the `items` row was deleted, or it is unreadable to whoever is looking. An
 * item is readable through ownership or a shared context — collection
 * membership grants nothing — so an item added without a context is invisible
 * to the other person even inside a shared collection. The wording commits to
 * neither cause.
 *
 * Four callers, two provenances: the recently-removed panel and the history
 * view pass the removal record's `item_name` snapshot; the collection detail
 * list and the execution checklist pass a live lookup that may find nothing.
 * The reader should not have to care which.
 */
function ItemNameLabel({ name }) {
  if (name) return <>{name}</>;
  return <span className="italic text-muted-foreground">⚠ Item unavailable</span>;
}

/** "Removed" reads as deliberate; "Checked off" as the tail of a shopping trip. */
function removalReasonLabel(reason) {
  return reason === "completed" ? "Checked off" : "Removed";
}

/**
 * Collapse removals into the actions that produced them.
 *
 * Rows written by one action share an exact `removed_at` — they go in a single
 * INSERT, so Postgres gives them one transaction timestamp, confirmed to
 * microsecond equality across a multi-item completion in Step 4. Grouping is
 * therefore exact string equality, never a rounded or bucketed time window,
 * which would fuse genuinely separate actions that happened to land close
 * together. Input must already be sorted newest-first.
 */
function groupRemovalsByAction(removals) {
  const groups = [];
  for (const removal of removals) {
    const current = groups[groups.length - 1];
    if (
      current &&
      current.removedAt === removal.removedAt &&
      current.reason === removal.reason
    ) {
      current.rows.push(removal);
    } else {
      groups.push({
        removedAt: removal.removedAt,
        reason: removal.reason,
        rows: [removal],
      });
    }
  }
  return groups;
}

function friendlyDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (isToday) return `Today at ${timeStr}`;
  if (isYesterday) return `Yesterday at ${timeStr}`;

  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }) + ` at ${timeStr}`;
}

function AiStatusBadge({ status }) {
  const config = {
    not_started: { label: 'Not enriched', bg: 'bg-secondary/50', text: 'text-muted-foreground', dot: 'bg-muted' },
    in_progress: { label: 'Enriching...', bg: 'bg-warning-light', text: 'text-warning', dot: 'bg-warning animate-pulse' },
    enriched: { label: 'Enriched (Sonnet)', bg: 'bg-success-light', text: 'text-success', dot: 'bg-success' },
    re_enriched: { label: 'Re-enriched (Opus)', bg: 'bg-primary-light', text: 'text-primary', dot: 'bg-primary' },
  };
  const c = config[status] || config.not_started;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  );
}

function SourceIcon({ sourceType }) {
  const icons = {
    manual: <Pencil className="w-3.5 h-3.5" />,
    mcp: <Bot className="w-3.5 h-3.5" />,
    email: <Mail className="w-3.5 h-3.5" />,
  };
  return <span title={`Source: ${sourceType || 'manual'}`}>{icons[sourceType] || icons.manual}</span>;
}

function InboxCard({
  inboxItem,
  contexts,
  items,
  collections,
  onSave,
  // Renamed with the behaviour in Step 10: this hard-deletes the row now
  // rather than flagging it, and a prop still called onArchive would be the
  // last place anyone looked to find that out.
  onDelete,
  onEnrich,
  onDirtyChange,
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAiInfo, setShowAiInfo] = useState(false);
  const [enriching, setEnriching] = useState(false);

  // Accordion section open/closed state — auto-open if suggestions exist
  const [intentionOpen, setIntentionOpen] = useState(!!inboxItem.suggestIntent);
  const [itemOpen, setItemOpen] = useState(!!inboxItem.suggestItem);
  const [collectionOpen, setCollectionOpen] = useState(!!inboxItem.suggestedCollectionId);

  const [eventDate, setEventDate] = useState(inboxItem.suggestedEventDate || '');

  // Tags (shared suggestions applied to whichever sections are open)
  const [intentTags, setIntentTags] = useState(inboxItem.suggestedTags || []);

  // Intention form state (updated to pre-fill from suggestions)
  const [intentText, setIntentText] = useState(
    inboxItem.suggestedIntentText || inboxItem.capturedText
  );
  const [intentRecurrenceConfig, setIntentRecurrenceConfig] = useState(null);
  const [intentEndDate, setIntentEndDate] = useState(null);
  const [intentTargetStartDate, setIntentTargetStartDate] = useState(null);
  const [intentContextId, setIntentContextId] = useState(
    inboxItem.suggestedContextId || ''
  );
  const [intentContextSearch, setIntentContextSearch] = useState("");
  const [showIntentContextPicker, setShowIntentContextPicker] = useState(false);
  const [intentItemId, setIntentItemId] = useState(
    inboxItem.suggestedItemId || ''
  );
  const [intentItemSearch, setIntentItemSearch] = useState(
    (inboxItem.suggestedItemId && items?.find(i => i.id === inboxItem.suggestedItemId)?.name) || ''
  );
  const [showIntentItemPicker, setShowIntentItemPicker] = useState(false);

  // Item form state (updated to pre-fill from suggestions)
  const [itemName, setItemName] = useState(
    inboxItem.suggestedItemText || inboxItem.capturedText
  );
  const [itemDescription, setItemDescription] = useState(
    inboxItem.suggestedItemDescription || ''
  );
  const [itemContextId, setItemContextId] = useState(
    inboxItem.suggestedContextId || ''
  );
  const [itemElements, setItemElements] = useState(
    (inboxItem.suggestedItemElements || []).map((el) =>
      el.name ? el : {
        name: el.text || '',
        displayType: el.type || 'step',
        quantity: el.quantity || '',
        description: el.description || '',
        ...(el.collectable ? { collectable: true } : {}),
        ...offsetPatch(el)
      }
    )
  );
  const [itemTags, setItemTags] = useState(inboxItem.suggestedTags || []);
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [itemItemLinks, setItemItemLinks] = useState([]);
  const [showItemItemPicker, setShowItemItemPicker] = useState(false);
  const [itemItemSearch, setItemItemSearch] = useState('');
  const inboxElementDescRefs = useRef([]);
  const inboxItemDescRef = useRef(null);

  // Collection form state
  const [selectedCollectionId, setSelectedCollectionId] = useState(
    inboxItem.suggestedCollectionId || ''
  );
  const [collectionItemId, setCollectionItemId] = useState(
    inboxItem.suggestedItemId || ''
  );
  const [collectionItemSearch, setCollectionItemSearch] = useState(
    (inboxItem.suggestedItemId && items?.find(i => i.id === inboxItem.suggestedItemId)?.name) || ''
  );
  const [showCollectionItemPicker, setShowCollectionItemPicker] = useState(false);
  const [collectionQuantity, setCollectionQuantity] = useState('1');

  // Autocomplete filtering
  const filteredIntentContexts =
    contexts && intentContextSearch.trim()
      ? contexts
          .filter((c) =>
            !c.archived &&
            c.name.toLowerCase().includes(intentContextSearch.toLowerCase()),
          )
          .slice(0, 10)
      : [];

  const filteredIntentItems =
    items && intentItemSearch.trim()
      ? items
          .filter((item) =>
            item.name.toLowerCase().includes(intentItemSearch.toLowerCase()),
          )
          .slice(0, 10)
      : [];

  const filteredCollectionItems =
    items && collectionItemSearch.trim()
      ? items
          .filter((item) =>
            item.name.toLowerCase().includes(collectionItemSearch.toLowerCase()),
          )
          .slice(0, 10)
      : [];

  // Re-sync local state when enrichment populates suggestions
  useEffect(() => {
    if (inboxItem.aiStatus === 'enriched' || inboxItem.aiStatus === 're_enriched') {
      // Open sections based on suggestions
      if (inboxItem.suggestIntent) {
        setIntentionOpen(true);
        setIntentText(inboxItem.suggestedIntentText || inboxItem.capturedText);
        setIntentRecurrenceConfig(null);
        setIntentEndDate(null);
        setIntentTargetStartDate(null);
        setIntentContextId(inboxItem.suggestedContextId || '');
        setIntentTags(inboxItem.suggestedTags || []);
      }
      if (inboxItem.suggestItem) {
        setItemOpen(true);
        setItemName(inboxItem.suggestedItemText || inboxItem.capturedText);
        setItemDescription(inboxItem.suggestedItemDescription || '');
        setItemContextId(inboxItem.suggestedContextId || '');
        setItemElements((inboxItem.suggestedItemElements || []).map((el) =>
          el.name ? el : {
            name: el.text || '',
            displayType: el.type || 'step',
            quantity: el.quantity || '',
            description: el.description || '',
            ...(el.collectable ? { collectable: true } : {}),
            ...offsetPatch(el)
          }
        ));
        setItemTags(inboxItem.suggestedTags || []);
      }
      if (inboxItem.suggestedCollectionId) {
        setCollectionOpen(true);
        setSelectedCollectionId(inboxItem.suggestedCollectionId);
      }
      if (inboxItem.suggestEvent) {
        setEventDate(inboxItem.suggestedEventDate || '');
      }
      if (inboxItem.suggestedItemId) {
        setIntentItemId(inboxItem.suggestedItemId);
        setCollectionItemId(inboxItem.suggestedItemId);
        const existingItem = items?.find(i => i.id === inboxItem.suggestedItemId);
        if (existingItem) {
          setIntentItemSearch(existingItem.name);
          setCollectionItemSearch(existingItem.name);
        }
      }
    }
  }, [inboxItem.aiStatus, inboxItem, items]);

  useEffect(() => {
    if (!expanded || !onDirtyChange) return;
    const isDirty =
      intentText !== (inboxItem.suggestedIntentText || inboxItem.capturedText) ||
      intentContextId !== (inboxItem.suggestedContextId || '') ||
      intentItemId !== (inboxItem.suggestedItemId || '') ||
      JSON.stringify(intentTags) !== JSON.stringify(inboxItem.suggestedTags || []) ||
      eventDate !== (inboxItem.suggestedEventDate || '') ||
      itemName !== (inboxItem.suggestedItemText || inboxItem.capturedText) ||
      itemDescription !== (inboxItem.suggestedItemDescription || '') ||
      itemContextId !== (inboxItem.suggestedContextId || '') ||
      JSON.stringify(itemTags) !== JSON.stringify(inboxItem.suggestedTags || []) ||
      JSON.stringify(itemElements) !== JSON.stringify(
        (inboxItem.suggestedItemElements || []).map((el) =>
          el.name ? el : {
            name: el.text || '',
            displayType: el.type || 'step',
            quantity: el.quantity || '',
            description: el.description || '',
            ...(el.collectable ? { collectable: true } : {}),
            ...offsetPatch(el)
          }
        )
      ) ||
      itemItemLinks.length > 0 ||
      selectedCollectionId !== (inboxItem.suggestedCollectionId || '') ||
      collectionItemId !== (inboxItem.suggestedItemId || '') ||
      intentionOpen !== !!inboxItem.suggestIntent ||
      itemOpen !== !!inboxItem.suggestItem ||
      collectionOpen !== !!inboxItem.suggestedCollectionId;
    onDirtyChange(isDirty, "this inbox item");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    expanded, intentText, intentContextId, intentItemId,
    intentTags, eventDate, itemName, itemDescription, itemContextId,
    itemElements, itemTags, itemItemLinks, selectedCollectionId,
    collectionItemId, intentionOpen, itemOpen, collectionOpen
  ]);

  useEffect(() => {
    return () => { if (onDirtyChange) onDirtyChange(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Item element helpers
  function addElement() {
    setItemElements([
      ...itemElements,
      { name: "", displayType: "step", quantity: "", description: "" },
    ]);
    setTimeout(() => {
      const inputs = document.querySelectorAll('.inbox-element-input');
      if (inputs.length) {
        inputs[inputs.length - 1].scrollIntoView({ block: 'nearest' });
        inputs[inputs.length - 1].focus();
      }
    }, 50);
  }

  function insertElementAbove(index) {
    const newElements = [...itemElements];
    newElements.splice(index, 0, {
      name: "",
      displayType: "step",
      quantity: "",
      description: "",
    });
    setItemElements(newElements);
    setTimeout(() => {
      const inputs = document.querySelectorAll('.inbox-element-input');
      if (inputs[index]) {
        inputs[index].scrollIntoView({ block: 'nearest' });
        inputs[index].focus();
      }
    }, 50);
  }

  function updateElement(index, field, value) {
    const newElements = [...itemElements];
    const next = { ...newElements[index], [field]: value };
    // An offset is a gap before a step. Changing a row to a header or a bullet
    // drops it rather than leaving a scheduling instruction on a row that can
    // never be scheduled — mirroring `collectable` on bullets in the item
    // editor's copy of this function.
    if (field === "displayType" && value !== "step") delete next.offsetMinutes;
    newElements[index] = next;
    setItemElements(newElements);
  }

  function handleInboxItemNameChange(newName) {
    const OVERFLOW_THRESHOLD = 50;
    if (itemDescription && itemDescription.trim().length > 0) {
      setItemName(newName);
      return;
    }
    if (newName.length > OVERFLOW_THRESHOLD) {
      const textUpToThreshold = newName.substring(0, OVERFLOW_THRESHOLD);
      const lastSpaceIndex = textUpToThreshold.lastIndexOf(' ');
      if (lastSpaceIndex > 0) {
        const nameText = newName.substring(0, lastSpaceIndex).trim();
        const overflowText = newName.substring(lastSpaceIndex + 1).trim();
        setItemName(nameText);
        setItemDescription(overflowText);
        setTimeout(() => {
          if (inboxItemDescRef.current) {
            inboxItemDescRef.current.focus();
            inboxItemDescRef.current.setSelectionRange(overflowText.length, overflowText.length);
          }
        }, 0);
        return;
      }
    }
    setItemName(newName);
  }

  function handleElementNameChange(index, newName, currentDescription) {
    const OVERFLOW_THRESHOLD = 30;
    if (currentDescription && currentDescription.trim().length > 0) {
      updateElement(index, 'name', newName);
      return;
    }
    if (newName.length > OVERFLOW_THRESHOLD) {
      const textUpToThreshold = newName.substring(0, OVERFLOW_THRESHOLD);
      const lastSpaceIndex = textUpToThreshold.lastIndexOf(' ');
      if (lastSpaceIndex > 0) {
        const nameText = newName.substring(0, lastSpaceIndex).trim();
        const overflowText = newName.substring(lastSpaceIndex + 1).trim();
        const updatedElements = [...itemElements];
        updatedElements[index] = { ...updatedElements[index], name: nameText, description: overflowText };
        setItemElements(updatedElements);
        setTimeout(() => {
          const descField = inboxElementDescRefs.current[index];
          if (descField) {
            descField.focus();
            descField.setSelectionRange(overflowText.length, overflowText.length);
          }
        }, 0);
        return;
      }
    }
    updateElement(index, 'name', newName);
  }

  function deleteElement(index) {
    setItemElements(itemElements.filter((_, i) => i !== index));
  }

  function handleElementKeyPress(e, index) {
    if (e.key === "Enter") {
      e.preventDefault();
      insertElementAbove(index + 1);
      setTimeout(() => {
        const inputs = document.querySelectorAll(".inbox-element-input");
        if (inputs[index + 1]) {
          inputs[index + 1].focus();
        }
      }, 50);
    }
  }

  function handleDragStart(e, index) {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e, index) {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    const newElements = [...itemElements];
    const draggedItem = newElements[draggedIndex];
    newElements.splice(draggedIndex, 1);
    newElements.splice(index, 0, draggedItem);
    setItemElements(newElements);
    setDraggedIndex(index);
  }

  function handleDragEnd() {
    setDraggedIndex(null);
  }

  async function handleEnrich() {
    setEnriching(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(
        `${supabaseUrl}/functions/v1/ai-enrich`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ inbox_id: inboxItem.id }),
        }
      );

      let result;
      try {
        result = await response.json();
      } catch (e) {
        throw new Error(`Enrich failed: ${response.status} - Could not parse response`);
      }

      if (!response.ok) {
        throw new Error(result.error || `Enrich failed: ${response.status}`);
      }

      if (result.success) {
        // Convert snake_case to camelCase
        const camelSuggestions = storage.toCamelCase(result.suggestions);
        const updatedItem = {
          ...inboxItem,
          aiStatus: result.status,
          ...camelSuggestions,
        };
        onEnrich(inboxItem.id, updatedItem);
      } else {
        throw new Error(result.error || 'Enrichment failed');
      }
    } catch (error) {
      console.error('Enrich error:', error);
      alert('Enrichment failed: ' + error.message);
    } finally {
      setEnriching(false);
    }
  }

  async function handleReEnrich() {
    // Save current form state back to inbox record first
    const updatedInbox = {
      ...inboxItem,
      suggestedContextId: intentContextId || null,
      suggestIntent: intentionOpen,
      suggestedIntentText: intentText,
      suggestItem: itemOpen,
      suggestedItemText: itemName,
      suggestedItemDescription: itemDescription,
      suggestedItemElements: itemElements.length > 0 ? itemElements : null,
      suggestEvent: !!eventDate,
      suggestedEventDate: eventDate || null,
      suggestedTags: intentTags.length > 0 ? intentTags : [],
      suggestedItemId: intentItemId || null,
      suggestedCollectionId: selectedCollectionId || null,
    };

    await storage.set(`inbox:${inboxItem.id}`, updatedInbox);
    onEnrich(inboxItem.id, updatedInbox);

    // Now trigger enrichment
    await handleEnrich();
  }

  function handleSave() {
    if (onDirtyChange) onDirtyChange(false);
    if (!intentionOpen && !itemOpen && !collectionOpen) return;
    if (intentionOpen && !intentText.trim()) return;
    if (itemOpen && !itemName.trim()) return;
    if (collectionOpen && !selectedCollectionId) return;

    onSave(inboxItem.id, {
      createIntention: intentionOpen,
      intentionData: intentionOpen
        ? {
            text: intentText,
            contextId: intentContextId || null,
            recurrenceConfig: intentRecurrenceConfig,
            endDate: intentEndDate,
            targetStartDate: intentTargetStartDate,
            itemId: intentItemId || null,
            tags: intentTags,
            createEvent: !!eventDate,
            eventDate: eventDate || null,
          }
        : null,
      createItem: itemOpen,
      itemData: itemOpen
        ? {
            name: itemName,
            description: itemDescription,
            contextId: itemContextId || null,
            elements: itemElements,
            tags: itemTags,
          }
        : null,
      itemItemLinks: itemOpen ? itemItemLinks : [],
      addToCollection: collectionOpen,
      collectionData: collectionOpen
        ? {
            collectionId: selectedCollectionId,
            itemId: collectionItemId || null,
            quantity: collectionQuantity,
          }
        : null,
    });
  }

  function handleCancel() {
    if (onDirtyChange) onDirtyChange(false);
    setExpanded(false);

    // Reset accordion states
    setIntentionOpen(!!inboxItem.suggestIntent);
    setItemOpen(!!inboxItem.suggestItem);
    setCollectionOpen(!!inboxItem.suggestedCollectionId);

    // Reset Intention form to suggestions
    setIntentText(inboxItem.suggestedIntentText || inboxItem.capturedText);
    setIntentRecurrenceConfig(null);
    setIntentEndDate(null);
    setIntentTargetStartDate(null);
    setIntentContextId(inboxItem.suggestedContextId || '');
    setIntentContextSearch('');
    setIntentItemId(inboxItem.suggestedItemId || '');
    setIntentItemSearch(
      (inboxItem.suggestedItemId && items?.find(i => i.id === inboxItem.suggestedItemId)?.name) || ''
    );
    setIntentTags(inboxItem.suggestedTags || []);
    setEventDate(inboxItem.suggestedEventDate || '');

    // Reset Item form to suggestions
    setItemName(inboxItem.suggestedItemText || inboxItem.capturedText);
    setItemDescription(inboxItem.suggestedItemDescription || '');
    setItemContextId(inboxItem.suggestedContextId || '');
    setItemElements((inboxItem.suggestedItemElements || []).map((el) =>
      el.name ? el : {
        name: el.text || '',
        displayType: el.type || 'step',
        quantity: el.quantity || '',
        description: el.description || '',
        ...(el.collectable ? { collectable: true } : {}),
        ...offsetPatch(el)
      }
    ));
    setItemTags(inboxItem.suggestedTags || []);
    setItemItemLinks([]);
    setShowItemItemPicker(false);
    setItemItemSearch('');

    // Reset Collection form to suggestions
    setSelectedCollectionId(inboxItem.suggestedCollectionId || '');
    setCollectionItemId(inboxItem.suggestedItemId || '');
    setCollectionItemSearch(
      (inboxItem.suggestedItemId && items?.find(i => i.id === inboxItem.suggestedItemId)?.name) || ''
    );
    setCollectionQuantity('1');
  }

  // Collapsed display
  if (!expanded) {
    const truncated = inboxItem.capturedText.length > 100
      ? inboxItem.capturedText.substring(0, 100) + '...'
      : inboxItem.capturedText;

    return (
      <div
        className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary transition-colors shadow-sm hover:shadow-md"
        onClick={() => setExpanded(true)}
      >
        <p className="text-foreground mb-2">{truncated}</p>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{friendlyDate(inboxItem.createdAt)}</span>
          <div className="flex items-center gap-2">
            <AiStatusBadge status={inboxItem.aiStatus} />
            <span className="flex items-center gap-1">
              source: <SourceIcon sourceType={inboxItem.sourceType} />
            </span>
            {/* Every action on this card used to live behind expansion — the
                collapsed row was a pure expand target. Disposing of a capture
                you can already read in full should not require opening the
                triage form first.

                Behaviour is deliberately untouched: this is the SAME archive
                call the expanded footer makes. Step 10 turns both into a hard
                delete and relabels them "Delete".

                stopPropagation because the whole card is the expand target. */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (onDirtyChange) onDirtyChange(false);
                onDelete(inboxItem.id);
              }}
              title="Delete this capture"
              // ml-1 on top of the row's gap-2 = 12px. The badges stay tightly
              // grouped as one informational cluster; the action separates from
              // them. Its neighbour is the source icon, which LOOKS static but
              // is card-click — tap it and the card expands instead.
              className="ml-1 flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-muted-foreground hover:text-destructive hover:bg-secondary transition-colors shrink-0"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Expanded triage view
  return (
    <div className="p-3 sm:p-4 bg-card border-2 border-primary rounded-lg shadow-md">
      {/* Captured text */}
      <p className="text-lg text-foreground mb-2 whitespace-pre-wrap">
        {inboxItem.capturedText}
      </p>

      {/* Metadata row */}
      <div className="flex items-center justify-between text-xs text-muted-foreground mb-3">
        <span>{friendlyDate(inboxItem.createdAt)}</span>
        <div className="flex items-center gap-2">
          <AiStatusBadge status={inboxItem.aiStatus} />
          {(inboxItem.aiStatus === 'enriched' || inboxItem.aiStatus === 're_enriched') && (
            <button
              onClick={() => setShowAiInfo(!showAiInfo)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Enrichment details"
            >
              <Info className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* AI info panel (collapsible) */}
      {showAiInfo && (inboxItem.aiStatus === 'enriched' || inboxItem.aiStatus === 're_enriched') && (
        <div className="mb-3 p-3 bg-muted border border-border rounded text-sm">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-muted-foreground">Source:</span>
            <SourceIcon sourceType={inboxItem.sourceType} />
            <span>{inboxItem.sourceType || 'manual'}</span>
          </div>
          {inboxItem.aiConfidence != null && (
            <div className="flex items-center gap-2 mb-1">
              <span className="text-muted-foreground">Confidence:</span>
              <span>{Math.round(inboxItem.aiConfidence * 100)}%</span>
              <div className="flex-1 max-w-[120px] h-1.5 bg-secondary rounded-full">
                <div
                  className="h-full bg-primary rounded-full"
                  style={{ width: `${inboxItem.aiConfidence * 100}%` }}
                />
              </div>
            </div>
          )}
          {inboxItem.aiReasoning && (
            <div>
              <span className="text-muted-foreground">Reasoning:</span>
              <p className="mt-1 text-foreground">{inboxItem.aiReasoning}</p>
            </div>
          )}
        </div>
      )}

      <hr className="mb-4 border-border" />

      {/* Intention accordion */}
      <div className={`border rounded mb-3 ${intentionOpen ? 'border-primary bg-white' : 'border-border bg-muted'}`}>
        <button
          onClick={() => setIntentionOpen(!intentionOpen)}
          className={`flex items-center gap-2 w-full text-left px-4 py-3 font-medium ${
            intentionOpen ? 'text-foreground' : 'text-muted-foreground'
          }`}
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${intentionOpen ? 'rotate-180' : ''}`} />
          Intention
        </button>
        {intentionOpen && (
          <div className="px-4 pb-4 space-y-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Name
              </label>
              <input
                type="text"
                value={intentText}
                onChange={(e) => setIntentText(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded text-base"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Linked Context (optional)
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={intentContextSearch}
                  onChange={(e) => {
                    setIntentContextSearch(e.target.value);
                    setShowIntentContextPicker(true);
                  }}
                  onFocus={() => setShowIntentContextPicker(true)}
                  onBlur={() =>
                    setTimeout(() => setShowIntentContextPicker(false), 200)
                  }
                  placeholder="Search for a context..."
                  className="w-full px-3 py-2 border border-border rounded text-base"
                />
                {intentContextId && !intentContextSearch && contexts && (
                  <div className="mt-1 text-sm text-muted-foreground">
                    Selected:{" "}
                    {contexts.find((c) => c.id === intentContextId)?.name}
                    <button
                      onClick={() => {
                        setIntentContextId("");
                        setIntentContextSearch("");
                      }}
                      className="ml-2 text-destructive hover:text-destructive-hover"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
                {showIntentContextPicker &&
                  intentContextSearch &&
                  filteredIntentContexts.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {filteredIntentContexts.map((ctx) => (
                        <button
                          key={ctx.id}
                          onClick={() => {
                            setIntentContextId(ctx.id);
                            setIntentContextSearch(ctx.name);
                            setShowIntentContextPicker(false);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-background border-b border-border last:border-b-0"
                        >
                          <div className="font-medium">{ctx.name}</div>
                        </button>
                      ))}
                    </div>
                  )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Linked Item (optional)
                {itemOpen && (
                  <span className="text-xs text-muted-foreground ml-2">— {itemName || "new item"} will auto-link</span>
                )}
              </label>
              <div className={`relative ${itemOpen ? 'opacity-50 pointer-events-none' : ''}`}>
                <input
                  type="text"
                  value={intentItemSearch}
                  onChange={(e) => {
                    setIntentItemSearch(e.target.value);
                    setShowIntentItemPicker(true);
                  }}
                  onFocus={() => setShowIntentItemPicker(true)}
                  onBlur={() =>
                    setTimeout(() => setShowIntentItemPicker(false), 200)
                  }
                  placeholder="Search for an item..."
                  className="w-full px-3 py-2 border border-border rounded text-base"
                />
                {intentItemId && !intentItemSearch && items && (
                  <div className="mt-1 text-sm text-muted-foreground">
                    Selected:{" "}
                    {items.find((i) => i.id === intentItemId)?.name}
                    <button
                      onClick={() => {
                        setIntentItemId("");
                        setIntentItemSearch("");
                      }}
                      className="ml-2 text-destructive hover:text-destructive-hover"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
                {showIntentItemPicker &&
                  intentItemSearch &&
                  filteredIntentItems.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {filteredIntentItems.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => {
                            setIntentItemId(item.id);
                            setIntentItemSearch(item.name);
                            setShowIntentItemPicker(false);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-background border-b border-border last:border-b-0"
                        >
                          <div className="font-medium">{item.name}</div>
                          {item.contextId && contexts && (
                            <div className="text-xs text-muted-foreground">
                              {
                                contexts.find((c) => c.id === item.contextId)
                                  ?.name
                              }
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Recurrence
              </label>
              <RecurrenceQuickSelect
                value={intentRecurrenceConfig}
                onChange={(config) => {
                  setIntentRecurrenceConfig(config);
                }}
                onEndDateChange={setIntentEndDate}
              />
            </div>

            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-sm font-medium text-foreground mb-1">
                  Target Start Date
                </label>
                <input
                  type="date"
                  value={intentTargetStartDate || ""}
                  onChange={(e) => setIntentTargetStartDate(e.target.value || null)}
                  className="w-full px-3 py-2 border border-border rounded text-base"
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-foreground mb-1">
                  End Date
                </label>
                <input
                  type="date"
                  value={intentEndDate || ""}
                  onChange={(e) => setIntentEndDate(e.target.value || null)}
                  className="w-full px-3 py-2 border border-border rounded text-base"
                />
              </div>
            </div>

            {/* Tags */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Tags</label>
              <TagInput value={intentTags} onChange={setIntentTags} />
            </div>

            {/* Schedule Event */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Schedule Event
              </label>
              <input
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded text-base"
              />
            </div>
          </div>
        )}
      </div>

      {/* Item accordion */}
      <div className={`border rounded mb-3 ${itemOpen ? 'border-primary bg-white' : 'border-border bg-muted'}`}>
        <button
          onClick={() => setItemOpen(!itemOpen)}
          className={`flex items-center gap-2 w-full text-left px-4 py-3 font-medium ${
            itemOpen ? 'text-foreground' : 'text-muted-foreground'
          }`}
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${itemOpen ? 'rotate-180' : ''}`} />
          Item
        </button>
        {itemOpen && (
          <div className="px-4 pb-4 space-y-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Name
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={itemName}
                  onChange={(e) => handleInboxItemNameChange(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded text-base"
                />
                {itemName.length > 45 && itemName.length <= 50 && (!itemDescription || !itemDescription.trim()) && (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-warning">
                    {50 - itemName.length}
                  </span>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Description
              </label>
              <textarea
                ref={inboxItemDescRef}
                value={itemDescription}
                onChange={(e) => setItemDescription(e.target.value)}
                placeholder="Optional description"
                className="w-full px-3 py-2 border border-border rounded text-base"
                rows="2"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Context
              </label>
              <select
                value={itemContextId}
                onChange={(e) => setItemContextId(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded text-base"
              >
                <option value="">No context</option>
                {contexts.filter((c) => !c.archived).map((ctx) => (
                  <option key={ctx.id} value={ctx.id}>
                    {ctx.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Elements
              </label>
              <div className="space-y-2">
                {itemElements.map((element, index) => (
                  <div key={index}>
                    <div
                      className={`space-y-2 p-3 border border-border rounded ${draggedIndex === index ? "opacity-50" : ""}`}
                      draggable
                      onDragStart={(e) => handleDragStart(e, index)}
                      onDragOver={(e) => handleDragOver(e, index)}
                      onDragEnd={handleDragEnd}
                    >
                      <div className="flex items-center gap-2">
                        <GripVertical
                          className="w-4 h-4 text-muted-foreground cursor-move flex-shrink-0"
                          title="Drag to reorder"
                        />
                        <div className="relative flex-1 min-w-0">
                          <input
                            type="text"
                            value={element.name}
                            onChange={(e) =>
                              handleElementNameChange(index, e.target.value, element.description)
                            }
                            onKeyPress={(e) => handleElementKeyPress(e, index)}
                            placeholder="Element name"
                            className="inbox-element-input w-full px-3 py-2 border border-border rounded"
                          />
                          {element.name.length > 25 && element.name.length <= 30 && (!element.description || !element.description.trim()) && (
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-warning">
                              {30 - element.name.length}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => deleteElement(index)}
                          className="text-destructive hover:text-destructive-hover flex-shrink-0"
                          title="Delete"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>

                      <textarea
                        ref={(el) => (inboxElementDescRefs.current[index] = el)}
                        value={element.description || ""}
                        onChange={(e) =>
                          updateElement(index, "description", e.target.value)
                        }
                        placeholder="Description (optional)"
                        className="w-full px-3 py-2 border border-border rounded text-sm"
                        rows="2"
                      />

                      <div className="flex items-center gap-2">
                        <select
                          value={element.displayType || "step"}
                          onChange={(e) =>
                            updateElement(index, "displayType", e.target.value)
                          }
                          className="px-2 py-2 border border-border rounded text-sm"
                        >
                          <option value="header">Header</option>
                          <option value="bullet">Bullet</option>
                          <option value="step">Step</option>
                        </select>
                        <input
                          type="text"
                          value={element.quantity || ""}
                          onChange={(e) =>
                            updateElement(index, "quantity", e.target.value)
                          }
                          placeholder="Qty"
                          className="w-16 px-2 py-2 border border-border rounded text-sm"
                        />
                        {(element.displayType || "step") === "step" && (
                          <label
                            className="flex items-center gap-1"
                            title="Minutes to wait after the previous step is completed."
                          >
                            <span className="text-sm text-muted-foreground whitespace-nowrap">
                              after
                            </span>
                            <input
                              type="number"
                              min={0}
                              inputMode="numeric"
                              value={element.offsetMinutes ?? ""}
                              onChange={(e) => {
                                const raw = e.target.value;
                                const parsed = parseInt(raw, 10);
                                updateElement(
                                  index,
                                  "offsetMinutes",
                                  raw === "" || Number.isNaN(parsed) ? undefined : Math.max(0, parsed),
                                );
                              }}
                              placeholder="—"
                              className="w-16 px-2 py-2 border border-border rounded text-sm"
                            />
                            <span className="text-sm text-muted-foreground">min</span>
                            {/* Alongside the input, never in place of it. The value stays
                                authorable at position one so a step created at the top can be
                                given a gap and carry it when dragged down — which is the whole
                                reason the offset lives on the element rather than on the item. */}
                            {isFirstStep(itemElements, index) && (
                              <span
                                className="text-xs text-muted-foreground italic whitespace-nowrap"
                                title="Not used while this step is first — the first step is scheduled when the execution starts. It applies if you move this step below another one."
                              >
                                at start
                              </span>
                            )}
                          </label>
                        )}
                      </div>
                    </div>

                    {index < itemElements.length - 1 && (
                      <div className="flex justify-center -my-1">
                        <button
                          onClick={() => insertElementAbove(index + 1)}
                          className="text-success hover:text-success-hover text-lg"
                          title="Insert element below"
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                <button
                  onClick={addElement}
                  className="w-full px-4 py-2.5 border-2 border-dashed border-border rounded-lg text-muted-foreground hover:border-primary hover:text-primary transition-all duration-200"
                >
                  + Add Element
                </button>
              </div>
            </div>

            {/* Attach this Item */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Attach this Item (Optional)
              </label>

              {itemItemLinks.length > 0 && (
                <div className="space-y-2 mb-3">
                  {itemItemLinks.map((link, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2 p-2 bg-primary-light/20 rounded border border-primary-light"
                    >
                      <span className="text-sm text-primary font-medium flex-1">→ {link.name}</span>
                      <button
                        onClick={() => setItemItemLinks((prev) => prev.filter((_, i) => i !== index))}
                        className="text-muted-foreground hover:text-destructive"
                        title="Remove link"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={() => setShowItemItemPicker(true)}
                className="flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-lg hover:bg-accent transition-colors"
              >
                <Plus className="w-4 h-4" />
                Attach this Item
              </button>
            </div>

            {/* Tags */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Tags</label>
              <TagInput value={itemTags} onChange={setItemTags} />
            </div>
          </div>
        )}
      </div>

      {/* Add to Collection accordion */}
      <div className={`border rounded mb-3 ${collectionOpen ? 'border-primary bg-white' : 'border-border bg-muted'}`}>
        <button
          onClick={() => setCollectionOpen(!collectionOpen)}
          className={`flex items-center gap-2 w-full text-left px-4 py-3 font-medium ${
            collectionOpen ? 'text-foreground' : 'text-muted-foreground'
          }`}
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${collectionOpen ? 'rotate-180' : ''}`} />
          Add to Collection
        </button>
        {collectionOpen && (
          <div className="px-4 pb-4 space-y-3">
            {/* Collection dropdown */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Collection</label>
              <select
                value={selectedCollectionId}
                onChange={(e) => setSelectedCollectionId(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded text-base"
              >
                <option value="">Select collection...</option>
                {collections?.map((col) => (
                  <option key={col.id} value={col.id}>{col.name}</option>
                ))}
              </select>
            </div>

            {/* Item — disabled if Create Item section is open */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Item
                {itemOpen && (
                  <span className="text-xs text-muted-foreground ml-2">— new item will be added</span>
                )}
              </label>
              <div className={`relative ${itemOpen ? 'opacity-50 pointer-events-none' : ''}`}>
                <input
                  type="text"
                  value={collectionItemSearch}
                  onChange={(e) => {
                    setCollectionItemSearch(e.target.value);
                    setShowCollectionItemPicker(true);
                  }}
                  onFocus={() => setShowCollectionItemPicker(true)}
                  onBlur={() =>
                    setTimeout(() => setShowCollectionItemPicker(false), 200)
                  }
                  placeholder="Search for an item..."
                  className="w-full px-3 py-2 border border-border rounded text-base"
                />
                {collectionItemId && !collectionItemSearch && items && (
                  <div className="mt-1 text-sm text-muted-foreground">
                    Selected:{" "}
                    {items.find((i) => i.id === collectionItemId)?.name}
                    <button
                      onClick={() => {
                        setCollectionItemId("");
                        setCollectionItemSearch("");
                      }}
                      className="ml-2 text-destructive hover:text-destructive-hover"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
                {showCollectionItemPicker &&
                  collectionItemSearch &&
                  filteredCollectionItems.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {filteredCollectionItems.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => {
                            setCollectionItemId(item.id);
                            setCollectionItemSearch(item.name);
                            setShowCollectionItemPicker(false);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-background border-b border-border last:border-b-0"
                        >
                          <div className="font-medium">{item.name}</div>
                          {item.contextId && contexts && (
                            <div className="text-xs text-muted-foreground">
                              {
                                contexts.find((c) => c.id === item.contextId)
                                  ?.name
                              }
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
              </div>
            </div>

            {/* Quantity */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Quantity</label>
              <input
                type="text"
                value={collectionQuantity}
                onChange={(e) => setCollectionQuantity(e.target.value)}
                className="w-32 px-3 py-2 border border-border rounded text-base"
              />
            </div>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {/* Enrich / Re-enrich button */}
          {inboxItem.aiStatus !== 'in_progress' && !enriching && (
            <button
              onClick={inboxItem.aiStatus === 'not_started' ? handleEnrich : handleReEnrich}
              className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 flex items-center gap-2"
            >
              <Sparkles className="w-4 h-4" />
              {inboxItem.aiStatus === 'not_started'
                ? 'Enrich (Sonnet)'
                : 'Re-enrich (Opus)'}
            </button>
          )}
          {(inboxItem.aiStatus === 'in_progress' || enriching) && (
            <button
              disabled
              className="px-4 py-2.5 min-h-[44px] bg-warning-light text-warning rounded-lg cursor-not-allowed"
            >
              Enriching...
            </button>
          )}

          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={!intentionOpen && !itemOpen && !collectionOpen}
            className={`px-4 py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 ${
              intentionOpen || itemOpen || collectionOpen
                ? "bg-primary hover:bg-primary-hover text-white"
                : "bg-secondary text-muted-foreground cursor-not-allowed"
            }`}
          >
            Save
          </button>
          <button
            onClick={handleCancel}
            className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
          >
            Cancel
          </button>
        </div>
        {/* "Delete", not "Archive". The two ran byte-identical code and were
            indistinguishable in the data; now this removes the row and the
            label says so. Same call as the collapsed row's icon. */}
        <button
          onClick={() => { if (onDirtyChange) onDirtyChange(false); onDelete(inboxItem.id); }}
          className="min-h-[44px] text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
        >
          <Trash2 className="w-4 h-4" /> Delete
        </button>
      </div>

      {/* Item Picker Modal */}
      {showItemItemPicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowItemItemPicker(false)}>
          <div className="bg-card p-6 rounded-lg max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-medium text-foreground">Select Item to Attach</h3>
              <button onClick={() => setShowItemItemPicker(false)} className="text-muted-foreground hover:text-foreground">
                <X className="w-5 h-5" />
              </button>
            </div>

            <input
              type="text"
              placeholder="Search items..."
              value={itemItemSearch}
              onChange={(e) => setItemItemSearch(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg text-base mb-3"
              autoFocus
            />

            <div className="space-y-2">
              {items
                ?.filter((item) => !item.archived && !itemItemLinks.find((link) => link.id === item.id))
                .filter((item) => {
                  if (!itemItemSearch.trim()) return true;
                  const query = itemItemSearch.toLowerCase();
                  return (
                    item.name.toLowerCase().includes(query) ||
                    (item.description && item.description.toLowerCase().includes(query))
                  );
                })
                .slice(0, 20)
                .map((item) => {
                  const contextName = item.contextId && contexts
                    ? contexts.find((c) => c.id === item.contextId)?.name
                    : null;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setItemItemLinks((prev) => [...prev, { id: item.id, name: item.name }]);
                        setShowItemItemPicker(false);
                        setItemItemSearch('');
                      }}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-accent transition-colors border border-border"
                    >
                      <div className="font-medium text-foreground">{item.name}</div>
                      {contextName && (
                        <div className="text-xs text-muted-foreground">{contextName}</div>
                      )}
                      {item.description && (
                        <div className="text-sm text-muted-foreground mt-1 line-clamp-2">{item.description}</div>
                      )}
                    </button>
                  );
                })}
              {items?.filter((item) => !item.archived && !itemItemLinks.find((link) => link.id === item.id)).length === 0 && (
                <p className="text-muted-foreground text-sm py-4 text-center">No items available to link</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * @param {boolean} [stickyFooter] - Pin Save/Cancel above the Capture bar.
 *
 * Opt-in rather than always-on, because since Step 5 this form renders in two
 * places that want different treatment:
 *
 *   Contexts list    the form REPLACES the list, so it owns the screen and a
 *                    pinned footer is right — this is the "full-screen form"
 *                    the spec means.
 *   Context detail   the form is a panel with the context's items, intentions
 *                    and collections below it. A pinned footer would hover over
 *                    that content and imply it belonged to whatever you had
 *                    scrolled to, which is worse than no pinning at all.
 *
 * Defaulting to false so a third render site gets the safe behaviour and has to
 * ask for the other.
 */
function ContextForm({ editing, onSave, onCancel, onDirtyChange, stickyFooter = false, collections = [] }) {
  const [name, setName] = useState(editing?.name || "");
  const [shared, setShared] = useState(editing?.shared || false);
  const [keywords, setKeywords] = useState(editing?.keywords || "");
  const [description, setDescription] = useState(editing?.description || "");
  const [pinned, setPinned] = useState(editing?.pinned || false);
  const [defaultCollectionId, setDefaultCollectionId] = useState(
    editing?.defaultCollectionId || "",
  );

  useEffect(() => {
    if (!onDirtyChange) return;
    const isDirty =
      name !== (editing?.name || "") ||
      shared !== (editing?.shared || false) ||
      keywords !== (editing?.keywords || "") ||
      description !== (editing?.description || "") ||
      pinned !== (editing?.pinned || false) ||
      defaultCollectionId !== (editing?.defaultCollectionId || "");
    onDirtyChange(isDirty, "this context");
  }, [name, shared, keywords, description, pinned, defaultCollectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { if (onDirtyChange) onDirtyChange(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mb-4 sm:mb-6 p-4 sm:p-6 bg-white border-2 border-primary rounded-lg shadow-lg">
      <h3 className="font-medium text-lg mb-4">
        {editing ? "Edit Context" : "New Context"}
      </h3>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Context name"
            className="w-full px-3 py-2 border border-border rounded text-base"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Keywords
          </label>
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="Keywords (comma separated)"
            className="w-full px-3 py-2 border border-border rounded text-base"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            rows={3}
            className="w-full px-3 py-2 border border-border rounded text-base"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Default collection
          </label>
          {/* Every non-archived collection, deliberately unfiltered by context.
              A default collection names where this context's items GO, which is
              normally a *different* context: a recipe lives in Recipes and its
              ingredients belong in Shopping alongside the other products. An
              earlier same-context filter here broke the feature's own driving
              case, because Recipes could not point at Groceries. */}
          <select
            value={defaultCollectionId}
            onChange={(e) => setDefaultCollectionId(e.target.value)}
            className="w-full px-3 py-2 min-h-[44px] border border-border rounded text-base"
          >
            <option value="">None</option>
            {(collections || [])
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            Preselected when adding an item's ingredients to a collection.
          </p>
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
            className="rounded accent-primary"
          />
          <span className="text-sm">Share this context</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
            className="rounded accent-primary"
          />
          <span className="text-sm">Pin to home</span>
        </label>

        {/* bottom-28 / sm:bottom-32 mirrors the main content wrapper's
            pb-28 sm:pb-32, which is the space the Capture bar is already
            reserved. Same two numbers, same reason — if one moves the other
            has to. */}
        <div
          className={`flex gap-2 pt-2 ${
            stickyFooter
              ? "sticky bottom-28 sm:bottom-32 -mx-4 sm:-mx-6 px-4 sm:px-6 pb-3 bg-white border-t border-border"
              : ""
          }`}
        >
          <button
            onClick={() => {
              if (name.trim()) {
                if (onDirtyChange) onDirtyChange(false);
                onSave(name, shared, keywords, description, pinned, defaultCollectionId);
              }
            }}
            className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
          >
            Save
          </button>
          <button
            onClick={() => { if (onDirtyChange) onDirtyChange(false); onCancel(); }}
            className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ContextCard({ context, onClick, onEdit, showSettings = false }) {
  return (
    // The handler sits on the root, not on the title block. The card already
    // advertised itself as clickable with cursor-pointer and hover:border-primary,
    // but only the left column responded — so the right half, the padding, and
    // the gap beside the gear were all dead. Matches ItemCard and IntentionCard.
    <div
      onClick={onClick}
      className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow duration-200"
    >
      {/* See CollectionCard — same shape, same collapse. Not a strip 8b added,
          but leaving it at 0 while the other three sit at 12 would recreate the
          inconsistency this step exists to remove. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {context.pinned && <Pin className="w-4 h-4 text-muted-foreground" />}
            <h3 className="font-medium text-foreground">{context.name}</h3>
          </div>
          {context.description && (
            <p className="text-sm text-muted-foreground mt-1">{context.description}</p>
          )}
          <div className="flex items-center gap-2 mt-1">
            {context.shared && (
              <span className="text-xs text-primary flex items-center gap-1">
                <Share2 className="w-3 h-3" />
                Shared
              </span>
            )}
          </div>
        </div>
        {showSettings && onEdit && (
          // KEPT, and now load-bearing. The spec asked for this stopPropagation
          // to go because the gear was a SIBLING of the clickable region and had
          // nothing to stop. Moving the handler to the root above makes the gear
          // a descendant of it, so without this a click here would open the
          // context AND the edit form — defect 0.3 all over again. The premise
          // for removing it was true only before this step's other half.
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <Settings className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One collection row. Step 4a of docs/technical-spec-ui-standardization.md.
 *
 * Replaces three copy-pasted copies that had drifted on four axes with no two
 * identical. Two of the four differences were adaptation and survive as props;
 * two were drift and are gone:
 *
 *   Pin icon        DRIFT       Home rendered it unconditionally. Invisible,
 *                               because every row in "Pinned Collections" is
 *                               pinned by definition — but only by accident.
 *                               Now conditional, and hardcoded rather than a
 *                               prop: no caller wants it suppressed, and a
 *                               never-varied prop is noise.
 *   Member count    DRIFT       Home and Collections called Alfred's
 *                               `membersOf`; Context detail inlined the same
 *                               lookup because `membersOf` is out of its scope.
 *                               The component takes the number, so neither
 *                               caller needs the lookup shape.
 *   Context badge   ADAPTATION  Context detail omits it: every row already
 *                               shares that context, so the chip says nothing.
 *                               Kept as `showContextBadge`.
 *   Click handler   ADAPTATION  Each site returns to a different screen.
 *                               Kept as `onOpen`.
 *
 * Anatomy matches the other five shared cards after Step 3: the whole card is
 * the click target, not just the title block. There are no action buttons yet —
 * Step 8 adds Edit and Archive — and when they arrive they go inside this root
 * as descendants with `stopPropagation`, the way ContextCard's gear and
 * EventCard's Start button already do.
 *
 * Not an anchor, deliberately: `/collections/detail` carries no record id, so a
 * middle-click would open the wrong screen in a new tab. See the spec's "Row
 * click targets — deferred".
 */
function CollectionCard({
  collection,
  contexts = [],
  memberCount = 0,
  showContextBadge = true,
  onOpen,
  onArchive,
}) {
  // Cards in this file take `contexts` and resolve the name themselves —
  // ItemCard, IntentionCard and EventCard all do. Following that keeps the
  // lookup out of two call sites rather than duplicating it in both.
  const contextName =
    showContextBadge && collection.contextId
      ? contexts.find((c) => c.id === collection.contextId)?.name
      : null;

  return (
    <div
      onClick={onOpen}
      className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow"
    >
      {/* gap-3 as a floor. justify-between leaves a generous gap on a wide row
          but collapses to nothing once the collection name fills the width, and
          what sits on the other side of that gap is the card's own onClick. */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            {collection.pinned && (
              <Pin className="w-4 h-4 text-muted-foreground" />
            )}
            <p className="font-medium">{collection.name}</p>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm text-muted-foreground">
              {memberCount} {memberCount === 1 ? "item" : "items"}
            </span>
            {contextName && (
              <span className="text-xs bg-warning-light text-foreground px-2 py-0.5 rounded">
                {contextName}
              </span>
            )}
            {collection.shared && (
              <span className="text-xs text-primary flex items-center gap-1">
                <Share2 className="w-3 h-3" />
                Shared
              </span>
            )}
          </div>
        </div>
        {/* Archive only — no Edit. Clicking the row opens collection detail,
            which auto-saves each field on blur and has no Save button, so it
            genuinely IS this record's edit surface. A row action never
            duplicates the row click.

            stopPropagation because this sits inside the card's own onClick.
            No confirmation: `onArchive` routes to archiveCollection, which
            offers the Undo. */}
        {onArchive && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onArchive(collection.id);
            }}
            title="Archive this collection"
            className="flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-muted-foreground hover:text-destructive hover:bg-secondary transition-colors shrink-0"
          >
            <Archive className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function ContextDetailView({
  contextId,
  context,
  items,
  intents,
  contexts,
  onBack,
  getIntentDisplay,
  onUpdateItem,
  onUpdateIntent,
  onSchedule,
  onSaveContext,
  onArchiveContext,
  archiveBlockers = [],
  onAddItem,
  onAddIntention,
  onViewIntentionDetail,
  onViewItemDetail,
  executions = [],
  onOpenExecution,
  events = [],
  onUpdateEvent,
  onActivate,
  onCancelExecution,
  onStartNow,
  onArchiveIntention,
  filterTag,
  onFilterTag,
  allItems = [],
  collections = [],
  collectionMembers = {},
  onViewCollection,
  onArchiveCollection,
  onDirtyChange,
}) {
  const [showAddItemForm, setShowAddItemForm] = useState(false);
  const [showAddIntentionForm, setShowAddIntentionForm] = useState(false);
  const [itemsExpanded, setItemsExpanded] = useState(true);
  const [intentionsExpanded, setIntentionsExpanded] = useState(true);
  // Editing happens here now. It used to set two pieces of Alfred state and
  // then navigate to the Contexts list to render the form there, so "Edit" on
  // this page silently moved you to a different screen — and browser Back left
  // the form open on a page that had not asked for it.
  const [isEditingContext, setIsEditingContext] = useState(false);

  if (!context) return null;

  // Temporary new item for the add form
  const newItem = {
    id: null,
    name: "",
    description: "",
    contextId: contextId,
    elements: [],
    isCaptureTarget: false,
  };

  // Temporary new intention for the add form
  const newIntention = {
    id: null,
    text: "",
    contextId: contextId,
    isIntention: true,
    isItem: false,
    archived: false,
  };

  function handleSaveNewItem(itemId, updates) {
    // Create the actual item - use contextId from updates if changed, otherwise use current contextId
    const finalContextId =
      updates.contextId !== undefined ? updates.contextId : contextId;
    onAddItem(
      updates.name,
      updates.elements,
      finalContextId,
      updates.description,
      updates.isCaptureTarget,
    );
    setShowAddItemForm(false);
  }

  async function handleSaveNewIntention(intentId, updates, scheduledDate) {
    const finalContextId =
      updates.contextId !== undefined ? updates.contextId : contextId;
    const newIntentId = await onAddIntention(
      updates.text,
      finalContextId,
      updates.itemId || null,
      updates.collectionId || null,
      updates.recurrenceConfig || null,
    );

    if (scheduledDate && onSchedule) {
      onSchedule(newIntentId, scheduledDate);
    }

    setShowAddIntentionForm(false);
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      {isEditingContext && (
        <div className="mb-4 sm:mb-6">
          {/* onSave below forwards with (...args), so it is positionally
              transparent: the new defaultCollectionId argument flows through
              without an edit here. The other three layers are explicit and all
              had to change. */}
          <ContextForm
            editing={context}
            collections={collections}
            onSave={async (...args) => {
              await onSaveContext(context, ...args);
              setIsEditingContext(false);
            }}
            onCancel={() => setIsEditingContext(false)}
            onDirtyChange={onDirtyChange}
          />
        </div>
      )}

      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h2 className="text-xl sm:text-2xl font-bold">{context.name}</h2>
          {/* Record actions, top right. The spec asks for Edit · Archive here;
              Archive is absent because `contexts` has no `archived` column and
              adding one is a migration. See the Step 5 findings. */}
          <div className="flex flex-wrap justify-end gap-2 shrink-0">
            <button
              onClick={() => setIsEditingContext((v) => !v)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">
                {isEditingContext ? "Close Editor" : "Edit Context"}
              </span>
              <span className="sm:hidden">{isEditingContext ? "Close" : "Edit"}</span>
            </button>
            {/* Only while the context is empty. Contexts are taxonomy: nothing
                cascades, so archiving one that still holds records would strand
                them under a parent the UI no longer shows — and an archived
                child would be strandable in a way nothing could reach.
                Disabled-with-a-reason, reading the same way as the
                active-execution guards on EventCard and IntentionCard. */}
            {onArchiveContext && (
              <button
                onClick={() => onArchiveContext(context.id)}
                disabled={archiveBlockers.length > 0}
                title={
                  archiveBlockers.length > 0
                    ? `Cannot archive: still holds ${archiveBlockers.join(", ")}`
                    : "Archive this context"
                }
                className={`flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base ${
                  archiveBlockers.length > 0
                    ? "bg-secondary text-muted-foreground cursor-not-allowed"
                    : "bg-destructive hover:bg-destructive-hover text-white"
                }`}
              >
                <Archive className="w-4 h-4" />
                <span className="hidden sm:inline">Archive</span>
              </button>
            )}
          </div>
        </div>
        {context.description && (
          <p className="text-muted-foreground">{context.description}</p>
        )}
        {context.keywords && (
          <p className="text-sm text-muted-foreground mt-1">
            Keywords: {context.keywords}
          </p>
        )}
      </div>

      <div className="space-y-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setItemsExpanded(!itemsExpanded)}
              className="flex items-center gap-2 text-base sm:text-lg font-medium text-foreground"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${itemsExpanded ? "" : "-rotate-90"}`} />
              Items ({items.length})
            </button>
            <button
              onClick={() => setShowAddItemForm(true)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Plus className="w-4 h-4" />
              Add Item
            </button>
          </div>

          {showAddItemForm && (
            <div className="mb-3">
              <ItemCard
                item={newItem}
                contexts={contexts}
                onUpdate={handleSaveNewItem}
                isEditing={true}
                onCancel={() => setShowAddItemForm(false)}
                allItems={allItems}
                onDirtyChange={onDirtyChange}
              />
            </div>
          )}

          {itemsExpanded && (
            <>
              <TagFilter entities={items} activeTag={filterTag} onFilter={onFilterTag} />
              {items.length === 0 ? (
                <p className="text-muted-foreground text-sm">No items in this context</p>
              ) : (
                <div className="space-y-2">
                  {items
                    .filter((item) => !filterTag || (item.tags && item.tags.includes(filterTag)))
                    .map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      contexts={contexts}
                      onUpdate={onUpdateItem}
                      onViewDetail={onViewItemDetail}
                      allItems={allItems}
                      executions={executions.filter((ex) => ex.itemIds?.includes(item.id))}
                      intents={intents}
                      getIntentDisplay={getIntentDisplay}
                      onOpenExecution={onOpenExecution}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setIntentionsExpanded(!intentionsExpanded)}
              className="flex items-center gap-2 text-base sm:text-lg font-medium text-foreground"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${intentionsExpanded ? "" : "-rotate-90"}`} />
              Intentions ({intents.length})
            </button>
            <button
              onClick={() => setShowAddIntentionForm(true)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Plus className="w-4 h-4" />
              Add Intention
            </button>
          </div>

          {showAddIntentionForm && (
            <div className="mb-3">
              <IntentionCard
                intent={newIntention}
                contexts={contexts}
                items={items}
                collections={collections}
                onUpdate={handleSaveNewIntention}
                onSchedule={onSchedule}
                getIntentDisplay={getIntentDisplay}
                showScheduling={true}
                isEditing={true}
                onCancel={() => setShowAddIntentionForm(false)}
                onDirtyChange={onDirtyChange}
              />
            </div>
          )}

          {intentionsExpanded && (
            <>
              {intents.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No intentions in this context
                </p>
              ) : (
                <div className="space-y-2">
                  {intents.map((intent) => (
                    <IntentionCard
                      key={intent.id}
                      intent={intent}
                      contexts={contexts}
                      items={items}
                      collections={collections}
                      getIntentDisplay={getIntentDisplay}
                      onUpdate={onUpdateIntent}
                      onSchedule={onSchedule}
                      onStartNow={onStartNow}
                      showScheduling={true}
                      onViewDetail={onViewIntentionDetail}
                      events={events}
                      onUpdateEvent={onUpdateEvent}
                      onActivate={onActivate}
                      executions={executions}
                      onOpenExecution={onOpenExecution}
                      onCancelExecution={onCancelExecution}
                      onArchive={onArchiveIntention}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Collections Section */}
        <div>
          <h3 className="text-base sm:text-lg font-medium mb-3">
            Collections ({collections.filter((c) => c.contextId === contextId).length})
          </h3>
          {(() => {
            const contextCollections = collections.filter((c) => c.contextId === contextId);
            if (contextCollections.length === 0) {
              return (
                <p className="text-muted-foreground text-sm">
                  No collections in this context
                </p>
              );
            }
            return (
              <div className="space-y-2">
                {contextCollections.map((coll) => (
                  <CollectionCard
                    key={coll.id}
                    collection={coll}
                    memberCount={(collectionMembers[coll.id] || []).length}
                    // Every row here already shares this context, so the chip
                    // would repeat the page heading. This is the one difference
                    // between the three sites that was adaptation, not drift.
                    showContextBadge={false}
                    onOpen={() => onViewCollection && onViewCollection(coll.id)}
                    onArchive={onArchiveCollection}
                  />
                ))}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

function IntentionDetailView({
  intention,
  events,
  contexts,
  items,
  onBack,
  onUpdateIntention,
  onEditIntention,
  onUpdateEvent,
  onUpdateItem,
  onActivate,
  getIntentDisplay,
  onViewItemDetail,
  executions = [],
  onOpenExecution,
  onCancelExecution,
  onArchiveIntention,
  onSchedule,
  onStartNow,
  collections = [],
  onDirtyChange,
}) {
  const [isEditing, setIsEditing] = useState(false);

  if (!intention) return null;

  // Filter events for this intention that aren't archived
  const intentionEvents = events.filter(
    (e) => e.intentId === intention.id && !e.archived,
  );

  // `executions` is allLiveExecutions — active plus paused, which is exactly
  // the set IntentionCard's own guard queries the database for. Same rule,
  // no round trip.
  const hasActiveExecutions = executions.some(
    (ex) => ex.intentId === intention.id,
  );

  // Get context name for badge
  const contextName =
    intention.contextId && contexts
      ? contexts.find((c) => c.id === intention.contextId)?.name
      : null;

  // If editing, show the IntentionCard in edit mode
  if (isEditing) {
    return (
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <IntentionCard
          intent={intention}
          contexts={contexts}
          items={items}
          collections={collections}
          onUpdate={(id, updates, scheduledDate) => {
            onUpdateIntention(id, updates, scheduledDate);
            setIsEditing(false);
          }}
          onSchedule={(id, date) => {
            // Don't need to schedule here, just close edit mode
            setIsEditing(false);
          }}
          getIntentDisplay={getIntentDisplay}
          showScheduling={true}
          isEditing={true}
          onCancel={() => setIsEditing(false)}
          onArchive={onArchiveIntention}
          // Required as of Step 8a: the card's archive guard is derived from
          // this prop now rather than from its own query, and this was the one
          // onArchive site that did not pass it. Without it the guard silently
          // reads "no executions" and Archive stays enabled mid-execution.
          executions={executions}
          onDirtyChange={onDirtyChange}
          // Same reasoning as item detail: alone on the page.
          stickyFooter
        />
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="mb-4 sm:mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-2">
          <div className="flex-1">
            <h2 className="text-xl sm:text-2xl font-bold">{intention.text}</h2>
            {contextName && (
              <span className="inline-block mt-2 text-xs bg-warning-light text-foreground px-2 py-0.5 rounded">
                {contextName}
              </span>
            )}
          </div>
          {/* Record actions, top right, in the spec's order:
              Do Today · Schedule Later · Start Now · Edit · Archive.

              Do Today and Start Now are gated on having no events, matching
              IntentionCard: once something is scheduled, scheduling it again
              from the same screen is not the action anyone wants. */}
          <div className="flex flex-wrap justify-end gap-2 shrink-0">
            {/* The slot Step 5 left open. No form to save here, so these commit
                the schedule directly. Opening downward — this bar is at the top
                of the page. */}
            {onSchedule && intentionEvents.length === 0 && (
              <>
                <SchedulePopover
                  label="Do Today"
                  initialDate={getTodayDate()}
                  onPick={(date) => onSchedule(intention.id, date)}
                  className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
                />
                <SchedulePopover
                  label="Schedule Later"
                  onPick={(date) => onSchedule(intention.id, date)}
                  className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
                />
              </>
            )}
            {onStartNow && intentionEvents.length === 0 && (
              <button
                onClick={() => onStartNow(intention.id)}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Play className="w-4 h-4" />
                Start Now
              </button>
            )}
            <button
              onClick={() => setIsEditing(true)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">Edit Intention</span>
              <span className="sm:hidden">Edit</span>
            </button>
            {/* Archive was previously reachable only from inside the edit form.
                The same active-execution guard IntentionCard applies, but read
                from the `executions` prop already in hand rather than with a
                fresh query — the card does its own round trip, which this page
                does not need. */}
            {onArchiveIntention && (
              <button
                onClick={() => onArchiveIntention(intention.id)}
                disabled={hasActiveExecutions}
                title={
                  hasActiveExecutions
                    ? "Cannot archive: active execution in progress"
                    : "Archive this intention and all related events"
                }
                className={`flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base ${
                  hasActiveExecutions
                    ? "bg-secondary text-muted-foreground cursor-not-allowed"
                    : "bg-destructive hover:bg-destructive-hover text-white"
                }`}
              >
                <Archive className="w-4 h-4" />
                <span className="hidden sm:inline">Archive</span>
              </button>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Recurrence: {getRecurrenceDisplayString(getRecurrenceConfig(intention), intention.endDate)}
        </p>
      </div>

      {/* Linked Item Section */}
      {intention.itemId && items && (
        <div className="mb-6">
          <h3 className="text-lg font-medium mb-3">Linked Item</h3>
          {(() => {
            const linkedItem = items.find((i) => i.id === intention.itemId);
            return linkedItem ? (
              <ItemCard
                item={linkedItem}
                contexts={contexts}
                onUpdate={onUpdateItem}
                onViewDetail={onViewItemDetail}
                executions={executions.filter((ex) => ex.itemIds?.includes(linkedItem.id))}
                intents={[intention]}
                getIntentDisplay={getIntentDisplay}
                onOpenExecution={onOpenExecution}
              />
            ) : (
              <p className="text-muted-foreground text-sm">Item not found</p>
            );
          })()}
        </div>
      )}

      <div>
        <h3 className="text-lg font-medium mb-3">
          Scheduled Events ({intentionEvents.length})
        </h3>
        {intentionEvents.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No events scheduled for this intention
          </p>
        ) : (
          <div className="space-y-2">
            {intentionEvents.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                intent={intention}
                contexts={contexts}
                onUpdate={onUpdateEvent}
                onActivate={onActivate}
                getIntentDisplay={getIntentDisplay}
                executions={executions}
                onOpenExecution={onOpenExecution}
                onCancelExecution={onCancelExecution}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ItemDetailView({
  item,
  intents,
  events,
  contexts,
  items,
  onBack,
  onAddToCollection,
  onUpdateItem,
  onEditItem,
  onUpdateIntent,
  onSchedule,
  getIntentDisplay,
  executions = [],
  onOpenExecution,
  onStartNow,
  onUpdateEvent,
  onActivate,
  onAddIntention,
  onCancelExecution,
  onStartNowIntention,
  onArchiveIntention,
  onViewItem,
  onViewIntentionDetail,
  onClone,
  collections = [],
  onDirtyChange,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [showAddIntentionForm, setShowAddIntentionForm] = useState(false);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [cloneName, setCloneName] = useState("");

  if (!item) return null;

  function copyElementToClipboard(el) {
    const linkedItem = (el.itemId || el.item_id) ? items.find((i) => i.id === (el.itemId || el.item_id)) : null;
    let text = el.name;
    if (el.description) text += " " + el.description;
    if (el.quantity) text += " qty:" + el.quantity;
    if (linkedItem) text += " related item:" + linkedItem.name;
    navigator.clipboard.writeText(text);
  }

  // Find all non-archived intentions linked to this item
  const itemIntentions = intents.filter(
    (i) => i.itemId === item.id && !i.archived,
  );

  // Get context name for badge
  const contextName =
    item.contextId && contexts
      ? contexts.find((c) => c.id === item.contextId)?.name
      : null;

  // If editing, show the ItemCard in edit mode
  if (isEditing) {
    return (
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <ItemCard
          item={item}
          contexts={contexts}
          onUpdate={(id, updates) => {
            onUpdateItem(id, updates);
            if (updates.archived) {
              onBack();
            } else {
              setIsEditing(false);
            }
          }}
          isEditing={true}
          onCancel={() => setIsEditing(false)}
          allItems={items}
          onDirtyChange={onDirtyChange}
          // This card IS the page here — nothing else renders alongside it, so
          // the objection to sticky footers inside lists does not apply. A long
          // recipe puts Save thousands of pixels below the fold; this is the
          // case the phase started from.
          stickyFooter
        />
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="mb-4 sm:mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-2">
          <div className="flex-1">
            <h2 className="text-xl sm:text-2xl font-bold">{item.name}</h2>
            {contextName && (
              <span className="inline-block mt-2 text-xs bg-warning-light text-foreground px-2 py-0.5 rounded">
                {contextName}
              </span>
            )}
          </div>
          {/* Record actions, top right, in the spec's order:
              Start Now · Clone · Edit · Archive. flex-wrap because four
              buttons no longer fit one line on a narrow screen. */}
          <div className="flex flex-wrap justify-end gap-2">
            {onStartNow && (
              // bg-primary, not bg-success. Item detail was the only site using
              // success for this verb; the other three — intention detail,
              // IntentionCard's row, and EventCard's "Start" — are all primary,
              // and EventCard's "Start" is literally the same action.
              //
              // The deciding argument is what success already means: it carries
              // "Do Today" and "Complete". On intention detail Do Today sits two
              // buttons from Start Now, so giving them the same fill would erase
              // the only visual difference between "schedule it for later today"
              // and "begin it right now" — the two actions most easily confused.
              <button
                onClick={() => onStartNow(item.id)}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Play className="w-4 h-4" />
                Start Now
              </button>
            )}
            {onClone && (
              <button
                onClick={() => {
                  setCloneName(item.name + " (Copy)");
                  setShowCloneDialog(true);
                }}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Copy className="w-4 h-4" />
                <span className="hidden sm:inline">Clone</span>
              </button>
            )}
            <button
              onClick={() => setIsEditing(true)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">Edit Item</span>
              <span className="sm:hidden">Edit</span>
            </button>
            {/* Fifth button. Sits before Archive, not after it: the documented
                order puts the destructive action last, and that convention
                outranks "append the new one at the end". Present on every item,
                not just recipes — `collectable` is a generic flag and a packing
                list should work the same way. */}
            {onAddToCollection && (
              <button
                onClick={onAddToCollection}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <ClipboardList className="w-4 h-4" />
                <span className="hidden sm:inline">Add to Collection</span>
                <span className="sm:hidden">Collect</span>
              </button>
            )}
            {/* New here. Archiving was previously reachable only from inside the
                edit form, which broke governing rule 4 — a state change hidden
                behind a content-editing surface. `onUpdateItem` already offers
                the Undo, so there is no confirmation and nothing to add.
                Leaves the page because it is showing the record just archived. */}
            <button
              onClick={() => {
                onUpdateItem(item.id, { archived: true });
                onBack();
              }}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-destructive hover:bg-destructive-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Archive className="w-4 h-4" />
              <span className="hidden sm:inline">Archive</span>
            </button>
          </div>
        </div>
      </div>

      {/* Clone Dialog */}
      {showCloneDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-medium mb-4">Clone Item</h3>
            <label className="block text-sm font-medium text-foreground mb-1">Name for clone</label>
            <input
              type="text"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && cloneName.trim()) {
                  setShowCloneDialog(false);
                  onClone(item.id, cloneName.trim());
                }
              }}
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowCloneDialog(false)}
                className="px-4 py-2 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (cloneName.trim()) {
                    setShowCloneDialog(false);
                    onClone(item.id, cloneName.trim());
                  }
                }}
                className="px-4 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg"
              >
                Clone
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Item Description */}
      {item.description && (
        <div className="mb-6">
          <p className="text-muted-foreground">{item.description}</p>
        </div>
      )}

      {/* Capture Target Badge */}
      {item.isCaptureTarget && (
        <div className="mb-4">
          <span className="inline-block text-xs bg-success-light text-foreground px-2 py-1 rounded">
            📍 Capture Target
          </span>
        </div>
      )}

      {/* Elements Section */}
      {(item.elements || item.components) &&
        (item.elements || item.components).length > 0 && (
          <div className="mb-6">
            <h3 className="text-lg font-medium mb-3">Elements</h3>
            <div className="space-y-2">
              {(() => {
                let stepCounter = 0;
                return (item.elements || item.components).map((element, index) => {
                  const el =
                    typeof element === "string"
                      ? { name: element, displayType: "step" }
                      : {
                          ...element,
                          displayType: element.displayType || element.display_type || "step",
                          itemId: element.itemId || element.item_id,
                        };

                  const linkedItem = el.itemId ? items.find((i) => i.id === el.itemId) : null;

                  if (el.displayType === "header") {
                    return (
                      <div key={index}>
                        <div className="mt-4 mb-2">
                          <div className="flex items-center gap-2">
                            <h4 className="text-md font-bold text-foreground">
                              {el.name}
                            </h4>
                            <button
                              onClick={() => copyElementToClipboard(el)}
                              className="text-muted-foreground hover:text-foreground flex-shrink-0"
                              title="Copy element"
                            >
                              <Copy className="w-3 h-3" />
                            </button>
                          </div>
                          {el.description && (
                            <p className="text-sm text-muted-foreground mt-1">
                              {el.description}
                            </p>
                          )}
                        </div>
                        {linkedItem && (
                          <button
                            onClick={() => onViewItem(linkedItem.id, "item-detail")}
                            className="ml-0 flex items-center gap-2 text-sm text-primary hover:text-primary-hover mb-2"
                          >
                            <span>→</span>
                            <span>{linkedItem.name}</span>
                          </button>
                        )}
                      </div>
                    );
                  }

                  if (el.displayType === "bullet") {
                    return (
                      <div key={index}>
                        <div className="ml-4 flex items-start gap-2">
                          <span className="text-muted-foreground mt-1">•</span>
                          <div className="flex-1">
                            <span className="text-foreground">
                              {el.quantity && (
                                <span className="font-medium">{el.quantity} </span>
                              )}
                              {el.name}
                            </span>
                            {el.description && (
                              <p className="text-sm text-muted-foreground mt-1">
                                {el.description}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => copyElementToClipboard(el)}
                            className="text-muted-foreground hover:text-foreground flex-shrink-0 mt-1"
                            title="Copy element"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                        </div>
                        {linkedItem && (
                          <button
                            onClick={() => onViewItem(linkedItem.id, "item-detail")}
                            className="ml-6 flex items-center gap-2 text-sm text-primary hover:text-primary-hover mt-1"
                          >
                            <span>→</span>
                            <span>{linkedItem.name}</span>
                          </button>
                        )}
                      </div>
                    );
                  }

                  // Default: step
                  stepCounter++;
                  const stepNum = stepCounter;
                  return (
                    <div key={index}>
                      <div className="flex items-start gap-3">
                        <span className="text-muted-foreground font-medium min-w-[24px]">
                          {stepNum}.
                        </span>
                        <div className="flex-1">
                          <span className="text-foreground">
                            {el.quantity && (
                              <span className="font-medium">{el.quantity} </span>
                            )}
                            {el.name}
                          </span>
                          {el.description && (
                            <p className="text-sm text-muted-foreground mt-1">
                              {el.description}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => copyElementToClipboard(el)}
                          className="text-muted-foreground hover:text-foreground flex-shrink-0 mt-1"
                          title="Copy element"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </div>
                      {linkedItem && (
                        <button
                          onClick={() => onViewItem(linkedItem.id, "item-detail")}
                          className="ml-9 flex items-center gap-2 text-sm text-primary hover:text-primary-hover mt-1"
                        >
                          <span>→</span>
                          <span>{linkedItem.name}</span>
                        </button>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

      {/* Used In Section - items that reference this item */}
      {(() => {
        const parents = items.filter(
          (i) => i.id !== item.id && !i.archived && (i.elements || []).some((el) => (el.itemId || el.item_id) === item.id)
        );
        if (parents.length === 0) return null;
        return (
          <div className="mb-6">
            <h3 className="text-lg font-medium mb-3">Used In ({parents.length})</h3>
            <div className="space-y-1">
              {parents.map((parent) => (
                <button
                  key={parent.id}
                  onClick={() => onViewItem(parent.id, "item-detail")}
                  className="flex items-center gap-2 w-full text-left px-3 py-2 rounded hover:bg-secondary/50 text-primary hover:text-primary-hover"
                >
                  <span>←</span>
                  <span>{parent.name}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Active/Paused Executions Section */}
      {executions.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-medium mb-3">
            Executions ({executions.length})
          </h3>
          <div className="space-y-2">
            {executions.map((exec) => (
              <ExecutionBadge
                key={exec.id}
                exec={exec}
                intents={intents}
                contexts={contexts}
                getIntentDisplay={getIntentDisplay}
                onOpen={onOpenExecution}
              />
            ))}
          </div>
        </div>
      )}

      {/* Related Intentions Section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-medium">
            Related Intentions ({itemIntentions.length})
          </h3>
          {onAddIntention && (
            <button
              onClick={() => setShowAddIntentionForm(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              <Plus className="w-4 h-4" />
              Create Intention
            </button>
          )}
        </div>

        {showAddIntentionForm && (
          <div className="mb-3">
            <IntentionCard
              intent={{
                id: null,
                text: item.name,
                contextId: item.contextId || null,
                isIntention: true,
                isItem: false,
                archived: false,
                itemId: item.id,
              }}
              contexts={contexts}
              items={items}
              collections={collections}
              onUpdate={async (_, updates, scheduledDate) => {
                const newIntentId = await onAddIntention(
                  updates.text,
                  updates.contextId !== undefined ? updates.contextId : item.contextId,
                  updates.itemId !== undefined ? updates.itemId : item.id,
                  updates.collectionId || null,
                  updates.recurrenceConfig || null,
                );
                if (scheduledDate && onSchedule && newIntentId) {
                  onSchedule(newIntentId, scheduledDate);
                }
                setShowAddIntentionForm(false);
              }}
              onSchedule={onSchedule}
              getIntentDisplay={getIntentDisplay}
              showScheduling={true}
              isEditing={true}
              onCancel={() => setShowAddIntentionForm(false)}
              onDirtyChange={onDirtyChange}
            />
          </div>
        )}

        {itemIntentions.length === 0 && !showAddIntentionForm ? (
          <p className="text-muted-foreground text-sm">
            No intentions linked to this item
          </p>
        ) : (
          <div className="space-y-2">
            {itemIntentions.map((intent) => (
              <IntentionCard
                key={intent.id}
                intent={intent}
                contexts={contexts}
                items={items}
                collections={collections}
                onUpdate={onUpdateIntent}
                onSchedule={onSchedule}
                onStartNow={onStartNowIntention}
                getIntentDisplay={getIntentDisplay}
                showScheduling={true}
                // Without onViewDetail this card fell through to inline edit —
                // the only edit surface in the app with no dirty guard behind
                // it. Navigating matches the other two list sites and removes
                // the unguarded form rather than guarding it.
                onViewDetail={onViewIntentionDetail}
                events={events}
                onUpdateEvent={onUpdateEvent}
                onActivate={onActivate}
                executions={executions}
                onOpenExecution={onOpenExecution}
                onCancelExecution={onCancelExecution}
                onArchive={onArchiveIntention}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ExecutionDetailView({
  execution,
  intent,
  event,
  items,
  contexts,
  collections,
  collectionMembers = {},
  onToggleElement,
  onUpdateElement,
  onToggleCollectionItem,
  onUpdateCollectionItemQty,
  onRefreshCollection,
  onUpdateNotes,
  onComplete,
  onPause,
  onMakeActive,
  onCancel,
  onBack,
  getIntentDisplay,
}) {
  const [localNotes, setLocalNotes] = useState(execution.notes || "");
  const [, setTick] = useState(0);

  // Poll collection every 5 seconds for collection-based executions
  useEffect(() => {
    if (!execution.collectionId || !onRefreshCollection) return;
    onRefreshCollection(execution.collectionId);
    const interval = setInterval(() => {
      onRefreshCollection(execution.collectionId);
    }, 5000);
    return () => clearInterval(interval);
  }, [execution.collectionId, onRefreshCollection]);

  // Timer tick for in-progress elements
  useEffect(() => {
    const hasInProgress = execution.elements?.some((el) => el.inProgress);
    if (!hasInProgress) return;
    const interval = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(interval);
  }, [execution.elements]);

  function formatElapsed(startedAt) {
    if (!startedAt) return "";
    const startMs = typeof startedAt === 'string' ? new Date(startedAt).getTime() : startedAt;
    const seconds = Math.floor((Date.now() - startMs) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
  }

  const contextName =
    execution.contextId && contexts
      ? contexts.find((c) => c.id === execution.contextId)?.name
      : null;

  const displayName = intent ? getIntentDisplay(intent) : "Execution";
  const dateDisplay = event?.time ? formatEventDate(event.time) : "";

  return (
    <div>
      <button
        onClick={() => {
          onUpdateNotes(localNotes);
          onBack();
        }}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="mb-4 sm:mb-6">
        <h2 className="text-xl sm:text-2xl font-bold text-foreground">{displayName}</h2>
        <div className="flex items-center gap-2 mt-1">
          {contextName && (
            <span className="text-xs bg-success-light text-foreground px-2 py-0.5 rounded">
              {contextName}
            </span>
          )}
          {dateDisplay && (
            <span className="text-sm text-muted-foreground">{dateDisplay}</span>
          )}
        </div>
      </div>

      {/* Collection-based execution view */}
      {execution.collectionId && (() => {
        const coll = collections?.find((c) => c.id === execution.collectionId);
        // Step 3b: checklist membership is read from collection_items. The
        // completion handler still clears items out of the jsonb until Step 4.
        const collItems = collectionMembers[execution.collectionId] || [];
        const completedIds = execution.completedItemIds || [];
        const completedCount = collItems.filter((ci) => completedIds.includes(ci.itemId)).length;

        return (
          <div className="mb-6">
            <div className="border-t border-border pt-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-medium">
                  {coll ? coll.name : "Collection"} ({completedCount}/{collItems.length})
                </h3>
              </div>
              {collItems.length === 0 ? (
                <p className="text-muted-foreground text-sm py-4 text-center">No items in collection</p>
              ) : (
                <div className="space-y-1">
                  {collItems.map((collItem) => {
                    const linkedItem = items.find((i) => i.id === collItem.itemId);
                    const isChecked = completedIds.includes(collItem.itemId);
                    return (
                      <div
                        key={collItem.itemId}
                        className="flex items-center gap-3 py-2 px-3 rounded hover:bg-secondary/50"
                      >
                        <span
                          onClick={() => onToggleCollectionItem(collItem.itemId)}
                          className={`w-5 h-5 flex-shrink-0 rounded border-2 flex items-center justify-center cursor-pointer ${
                            isChecked
                              ? "bg-primary border-primary"
                              : "bg-white border-border"
                          }`}
                        >
                          {isChecked && (
                            <Check className="w-3 h-3 text-white" />
                          )}
                        </span>
                        <div className="flex-1 min-w-0">
                          <span className={isChecked ? "line-through text-muted-foreground" : "text-foreground"}>
                            <ItemNameLabel name={linkedItem?.name} />
                          </span>
                        </div>
                        {/* Same call as the detail list: quantity disabled while
                            the item cannot be shown, but the checkbox stays live.
                            Ticking it is the first half of clearing the row on
                            completion, which is the same legitimate act as the X
                            button in the detail view. */}
                        <input
                          type="text"
                          value={collItem.quantity || ""}
                          disabled={!linkedItem}
                          title={linkedItem ? undefined : "This item cannot be shown, so its quantity cannot be edited"}
                          onChange={(e) => {
                            onUpdateCollectionItemQty(execution.collectionId, collItem.itemId, e.target.value);
                          }}
                          placeholder="Qty"
                          className="w-20 sm:w-24 px-2 py-2 border border-border rounded text-base disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Element-based execution view */}
      {!execution.collectionId && execution.elements && execution.elements.length > 0 && (
        <div className="mb-6">
          <div className="border-t border-border pt-4 space-y-2">
            {(() => {
              let stepCounter = 0;
              return execution.elements.map((el, index) => {
                const indent = el.indent || 0;
                const indentPx = indent * 24;

                if (el.missing) {
                  return (
                    <div key={index} className="flex items-center gap-2 py-1 text-muted-foreground italic" style={{ marginLeft: indentPx }}>
                      <span>⚠ {el.name} (item deleted)</span>
                    </div>
                  );
                }

                if (el.circular) {
                  return (
                    <div key={index} className="flex items-center gap-2 py-1 text-muted-foreground italic" style={{ marginLeft: indentPx }}>
                      <span>↻ {el.name} (circular ref)</span>
                    </div>
                  );
                }

                if (el.displayType === "header") {
                  return (
                    <div key={index} className="mt-4 mb-2" style={{ marginLeft: indentPx }}>
                      <h4 className="text-md font-bold text-foreground uppercase tracking-wide">
                        {el.name}
                      </h4>
                    </div>
                  );
                }

                if (el.displayType === "bullet") {
                  return (
                    <div key={index} className="flex items-start gap-2 py-1" style={{ marginLeft: indentPx + 16 }}>
                      <span className="text-muted-foreground mt-0.5">•</span>
                      <div className="flex-1">
                        <span className="text-foreground">
                          {el.quantity && (
                            <span className="font-medium">{el.quantity} · </span>
                          )}
                          {el.name}
                        </span>
                        {el.description && (
                          <p className="text-sm text-muted-foreground">{el.description}</p>
                        )}
                      </div>
                    </div>
                  );
                }

                // step or any other displayType
                stepCounter++;
                const stepNum = stepCounter;
                return (
                  <div key={index} style={{ marginLeft: indentPx }}>
                    <div
                      className="flex items-start gap-3 py-2 px-3 rounded hover:bg-secondary/50"
                    >
                      <span className={`font-medium min-w-[24px] mt-0.5 ${el.isCompleted ? "text-muted-foreground" : "text-muted-foreground"}`}>
                        {stepNum}.
                      </span>
                      <span
                        onClick={() => onToggleElement(index)}
                        className={`mt-1 w-5 h-5 flex-shrink-0 rounded border-2 flex items-center justify-center cursor-pointer ${
                          el.isCompleted
                            ? "bg-primary border-primary"
                            : el.inProgress
                              ? "bg-white border-primary"
                              : "bg-white border-border"
                        }`}
                      >
                        {el.isCompleted && (
                          <Check className="w-3 h-3 text-white" />
                        )}
                      </span>
                      <div className="flex-1">
                        <span
                          className={
                            el.isCompleted
                              ? "line-through text-muted-foreground"
                              : el.inProgress
                                ? "text-primary font-medium"
                                : "text-foreground"
                          }
                        >
                          {el.name}
                        </span>
                        {(el.quantity || el.description) && (
                          <p
                            className={`text-sm ${el.isCompleted ? "text-muted-foreground" : "text-muted-foreground"}`}
                          >
                            {[el.quantity, el.description]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                      </div>
                      {!el.isCompleted && !el.inProgress && (
                        <button
                          onClick={() => onUpdateElement(index, { inProgress: true, startedAt: new Date().toISOString() })}
                          className="text-sm text-primary hover:text-primary-hover whitespace-nowrap"
                        >
                          Start
                        </button>
                      )}
                      {el.inProgress && !el.isCompleted && (
                        <button
                          onClick={() => onUpdateElement(index, { inProgress: false, startedAt: null })}
                          className="text-sm text-muted-foreground hover:text-muted-foreground whitespace-nowrap"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                    {el.inProgress && el.startedAt && !el.isCompleted && (
                      <div className="ml-16 pb-1 text-xs text-primary">
                        <Timer className="w-3.5 h-3.5 inline" /> Started {formatElapsed(el.startedAt)}
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      <div className="mb-6">
        <div className="border-t border-border pt-4">
          <label className="block text-sm font-medium text-foreground mb-2">
            Notes
          </label>
          <textarea
            value={localNotes}
            onChange={(e) => setLocalNotes(e.target.value)}
            onBlur={() => onUpdateNotes(localNotes)}
            placeholder="Add notes about this execution..."
            className="w-full px-3 py-2 border border-border rounded min-h-[120px]"
          />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-0 pt-4 border-t border-border">
        <button
          onClick={onCancel}
          className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
        >
          <X className="w-4 h-4" />
          Cancel
        </button>
        {execution.status === "paused" ? (
          <button
            onClick={onMakeActive}
            className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
          >
            <Play className="w-4 h-4" />
            Make Active
          </button>
        ) : (
          <button
            onClick={onPause}
            className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-warning hover:bg-warning-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
          >
            <Pause className="w-4 h-4" />
            Pause
          </button>
        )}
        <button
          onClick={onComplete}
          className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
        >
          <Check className="w-5 h-5" />
          Complete
        </button>
      </div>
    </div>
  );
}

function ExecutionBadge({ exec, intents, contexts, getIntentDisplay, onOpen }) {
  const intent = intents.find((i) => i.id === exec.intentId);
  const isActive = exec.status === "active";

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onOpen(exec);
      }}
      className={`p-3 sm:p-4 rounded cursor-pointer shadow-sm hover:shadow-md transition-shadow duration-200 min-h-[44px] ${
        isActive
          ? "bg-primary-light border-2 border-primary"
          : "bg-warning-light border-2 border-warning"
      }`}
    >
      <p className="font-medium text-foreground">
        {intent ? getIntentDisplay(intent) : "Execution"}
      </p>
      {exec.contextId && (
        <p className="text-sm text-foreground">
          {contexts.find((c) => c.id === exec.contextId)?.name}
        </p>
      )}
      {isActive && (
        <p className="text-xs text-foreground mt-1 flex items-center gap-1">
          <Play className="w-3 h-3" />
          In progress
        </p>
      )}
      {!isActive && (
        <p className="text-xs text-warning mt-1 flex items-center gap-1">
          <Pause className="w-3 h-3" />
          Paused — click to resume
        </p>
      )}
    </div>
  );
}

function ItemCard({
  item,
  contexts,
  onUpdate,
  isEditing: initialEditing = false,
  onCancel,
  onViewDetail,
  allItems = [],
  executions = [],
  intents = [],
  getIntentDisplay,
  onOpenExecution,
  onDirtyChange,
  // True only where this card IS the page — item detail's edit mode. Inside a
  // list it must stay false: sibling cards can be open at once, and several
  // footers each pinned to the same strip of viewport is nonsense.
  stickyFooter = false,
}) {
  const [isEditing, setIsEditing] = useState(initialEditing);
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description || "");
  const [contextId, setContextId] = useState(item.contextId || "");
  const [elements, setElements] = useState(
    (item.elements || item.components || []).map((el) =>
      typeof el === "string"
        ? { name: el, displayType: "step", quantity: "", description: "" }
        : {
            name: el.name || "",
            displayType: el.displayType || el.display_type || "step",
            quantity: el.quantity || "",
            description: el.description || "",
            ...(el.itemId || el.item_id ? { itemId: el.itemId || el.item_id } : {}),
            ...(el.collectable ? { collectable: true } : {}),
            ...offsetPatch(el),
          },
    ),
  );
  const [tags, setTags] = useState(item.tags || []);
  const [isCaptureTarget, setIsCaptureTarget] = useState(
    item.isCaptureTarget || false,
  );
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [linkingElementIndex, setLinkingElementIndex] = useState(null);
  const [linkSearch, setLinkSearch] = useState("");
  const elementDescRefs = useRef([]);
  const itemDescRef = useRef(null);

  useEffect(() => {
    if (!isEditing || !onDirtyChange) return;
    const originalElements = (item.elements || item.components || []).map((el) =>
      typeof el === "string"
        ? { name: el, displayType: "step", quantity: "", description: "" }
        : {
            name: el.name || "",
            displayType: el.displayType || el.display_type || "step",
            quantity: el.quantity || "",
            description: el.description || "",
            ...(el.itemId || el.item_id ? { itemId: el.itemId || el.item_id } : {}),
            ...(el.collectable ? { collectable: true } : {}),
            ...offsetPatch(el),
          }
    );
    const isDirty =
      name !== item.name ||
      description !== (item.description || "") ||
      contextId !== (item.contextId || "") ||
      JSON.stringify(tags) !== JSON.stringify(item.tags || []) ||
      isCaptureTarget !== (item.isCaptureTarget || false) ||
      JSON.stringify(elements) !== JSON.stringify(originalElements);
    onDirtyChange(isDirty, "this item");
  }, [isEditing, name, description, contextId, elements, tags, isCaptureTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { if (onDirtyChange) onDirtyChange(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSave() {
    if (!name.trim()) {
      // Name is required - just return without saving
      return;
    }
    if (onDirtyChange) onDirtyChange(false);
    const finalContextId = contextId === "" ? null : contextId;
    onUpdate(item.id, {
      name,
      description,
      contextId: finalContextId,
      elements,
      tags,
      isCaptureTarget,
    });
    if (!onCancel) {
      // Only control isEditing state if we're not in add mode
      setIsEditing(false);
    }
  }

  function handleCancel() {
    if (onDirtyChange) onDirtyChange(false);
    if (onCancel) {
      onCancel();
    } else {
      setName(item.name);
      setDescription(item.description || "");
      setContextId(item.contextId || "");
      setElements(
        (item.elements || item.components || []).map((el) =>
          typeof el === "string"
            ? { name: el, displayType: "step", quantity: "", description: "" }
            : { ...el },
        ),
      );
      setTags(item.tags || []);
      setIsCaptureTarget(item.isCaptureTarget || false);
      setIsEditing(false);
    }
  }

  function addElement() {
    setElements([
      ...elements,
      { name: "", displayType: "step", quantity: "", description: "" },
    ]);
    setTimeout(() => {
      const inputs = document.querySelectorAll('.element-input');
      if (inputs.length) {
        inputs[inputs.length - 1].scrollIntoView({ block: 'nearest' });
        inputs[inputs.length - 1].focus();
      }
    }, 50);
  }

  function insertElementAbove(index) {
    const newElements = [...elements];
    newElements.splice(index, 0, {
      name: "",
      displayType: "step",
      quantity: "",
      description: "",
    });
    setElements(newElements);
    setTimeout(() => {
      const inputs = document.querySelectorAll('.element-input');
      if (inputs[index]) {
        inputs[index].scrollIntoView({ block: 'nearest' });
        inputs[index].focus();
      }
    }, 50);
  }

  function updateElement(index, field, value) {
    const newElements = [...elements];
    const next = { ...newElements[index], [field]: value };
    // `collectable` means "this is a thing you can buy" and only applies to
    // bullets. Changing a row away from bullet drops the flag rather than
    // leaving it set on a row whose checkbox is no longer rendered: an
    // invisible flag would still surface the row in Add to Collection.
    if (field === "displayType" && value !== "bullet") delete next.collectable;
    // Same reasoning for the scheduling gap, which only applies to steps.
    if (field === "displayType" && value !== "step") delete next.offsetMinutes;
    newElements[index] = next;
    setElements(newElements);
  }

  function handleItemNameChange(newName) {
    const OVERFLOW_THRESHOLD = 50;
    if (description && description.trim().length > 0) {
      setName(newName);
      return;
    }
    if (newName.length > OVERFLOW_THRESHOLD) {
      const textUpToThreshold = newName.substring(0, OVERFLOW_THRESHOLD);
      const lastSpaceIndex = textUpToThreshold.lastIndexOf(' ');
      if (lastSpaceIndex > 0) {
        const nameText = newName.substring(0, lastSpaceIndex).trim();
        const overflowText = newName.substring(lastSpaceIndex + 1).trim();
        setName(nameText);
        setDescription(overflowText);
        setTimeout(() => {
          if (itemDescRef.current) {
            itemDescRef.current.focus();
            itemDescRef.current.setSelectionRange(overflowText.length, overflowText.length);
          }
        }, 0);
        return;
      }
    }
    setName(newName);
  }

  function handleElementNameChange(index, newName, currentDescription) {
    const OVERFLOW_THRESHOLD = 30;
    if (currentDescription && currentDescription.trim().length > 0) {
      updateElement(index, 'name', newName);
      return;
    }
    if (newName.length > OVERFLOW_THRESHOLD) {
      const textUpToThreshold = newName.substring(0, OVERFLOW_THRESHOLD);
      const lastSpaceIndex = textUpToThreshold.lastIndexOf(' ');
      if (lastSpaceIndex > 0) {
        const nameText = newName.substring(0, lastSpaceIndex).trim();
        const overflowText = newName.substring(lastSpaceIndex + 1).trim();
        const updatedElements = [...elements];
        updatedElements[index] = { ...updatedElements[index], name: nameText, description: overflowText };
        setElements(updatedElements);
        setTimeout(() => {
          const descField = elementDescRefs.current[index];
          if (descField) {
            descField.focus();
            descField.setSelectionRange(overflowText.length, overflowText.length);
          }
        }, 0);
        return;
      }
    }
    updateElement(index, 'name', newName);
  }

  function copyElementToClipboard(el, itemsList) {
    const linkedItem = (el.itemId || el.item_id) ? itemsList.find((i) => i.id === (el.itemId || el.item_id)) : null;
    let text = el.name;
    if (el.description) text += " " + el.description;
    if (el.quantity) text += " qty:" + el.quantity;
    if (linkedItem) text += " related item:" + linkedItem.name;
    navigator.clipboard.writeText(text);
  }

  function deleteElement(index) {
    setElements(elements.filter((_, i) => i !== index));
  }

  function handleKeyPress(e, index) {
    if (e.key === "Enter") {
      e.preventDefault();
      insertElementAbove(index + 1);
      setTimeout(() => {
        const inputs = document.querySelectorAll(".element-input");
        if (inputs[index + 1]) {
          inputs[index + 1].focus();
        }
      }, 50);
    }
  }

  function handleDragStart(e, index) {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e, index) {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const newElements = [...elements];
    const draggedItem = newElements[draggedIndex];
    newElements.splice(draggedIndex, 1);
    newElements.splice(index, 0, draggedItem);

    setElements(newElements);
    setDraggedIndex(index);
  }

  function handleDragEnd() {
    setDraggedIndex(null);
  }

  if (isEditing) {
    return (
      <div className="p-3 sm:p-4 bg-card border-2 border-primary rounded-lg shadow-md">
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Name
            </label>
            <div className="relative">
              <input
                type="text"
                value={name}
                onChange={(e) => handleItemNameChange(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded text-base"
                autoFocus
              />
              {name.length > 45 && name.length <= 50 && (!description || !description.trim()) && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-warning">
                  {50 - name.length}
                </span>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Description
            </label>
            <textarea
              ref={itemDescRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description for this item"
              className="w-full px-3 py-2 border border-border rounded text-base"
              rows="2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Tags
            </label>
            <TagInput value={tags} onChange={setTags} />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isCaptureTarget}
              onChange={(e) => setIsCaptureTarget(e.target.checked)}
              className="rounded accent-primary"
            />
            <span className="text-sm">
              Use as capture target (available in quick capture)
            </span>
          </label>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Context
            </label>
            <select
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded text-base"
            >
              <option value="">No context</option>
              {contexts.filter((c) => !c.archived).map((ctx) => (
                <option key={ctx.id} value={ctx.id}>
                  {ctx.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Elements
            </label>
            <div className="space-y-2">
              {elements.map((element, index) => (
                <div key={index}>
                  <div
                    className={`space-y-2 p-3 border border-border rounded ${draggedIndex === index ? "opacity-50" : ""}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDragEnd={handleDragEnd}
                  >
                    <div className="flex items-center gap-2">
                      <GripVertical
                        className="w-4 h-4 text-muted-foreground cursor-move flex-shrink-0"
                        title="Drag to reorder"
                      />
                      <div className="relative flex-1 min-w-0">
                        <input
                          type="text"
                          value={element.name}
                          onChange={(e) =>
                            handleElementNameChange(index, e.target.value, element.description)
                          }
                          onKeyPress={(e) => handleKeyPress(e, index)}
                          placeholder="Element name"
                          className="element-input w-full px-3 py-2 border border-border rounded"
                        />
                        {element.name.length > 25 && element.name.length <= 30 && (!element.description || !element.description.trim()) && (
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-warning">
                            {30 - element.name.length}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => copyElementToClipboard(element, allItems)}
                        className="text-muted-foreground hover:text-foreground flex-shrink-0"
                        title="Copy element"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => deleteElement(index)}
                        className="text-destructive hover:text-destructive-hover flex-shrink-0"
                        title="Delete"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>

                    <textarea
                      ref={(el) => (elementDescRefs.current[index] = el)}
                      value={element.description || ""}
                      onChange={(e) =>
                        updateElement(index, "description", e.target.value)
                      }
                      placeholder="Description (optional)"
                      className="w-full px-3 py-2 border border-border rounded text-sm"
                      rows="2"
                    />

                    <div className="flex items-center gap-2">
                      <select
                        value={element.displayType || "step"}
                        onChange={(e) =>
                          updateElement(index, "displayType", e.target.value)
                        }
                        className="px-2 py-2 border border-border rounded text-sm"
                      >
                        <option value="header">Header</option>
                        <option value="bullet">Bullet</option>
                        <option value="step">Step</option>
                      </select>
                      <input
                        type="text"
                        value={element.quantity || ""}
                        onChange={(e) =>
                          updateElement(index, "quantity", e.target.value)
                        }
                        placeholder="Qty"
                        className="w-16 px-2 py-2 border border-border rounded text-sm"
                      />
                      {(element.displayType || "step") === "step" && (
                        <label
                          className="flex items-center gap-1"
                          title="Minutes to wait after the previous step is completed."
                        >
                          <span className="text-sm text-muted-foreground whitespace-nowrap">
                            after
                          </span>
                          <input
                            type="number"
                            min={0}
                            inputMode="numeric"
                            value={element.offsetMinutes ?? ""}
                            onChange={(e) => {
                              const raw = e.target.value;
                              const parsed = parseInt(raw, 10);
                              updateElement(
                                index,
                                "offsetMinutes",
                                raw === "" || Number.isNaN(parsed) ? undefined : Math.max(0, parsed),
                              );
                            }}
                            placeholder="—"
                            className="w-16 px-2 py-2 border border-border rounded text-sm"
                          />
                          <span className="text-sm text-muted-foreground">min</span>
                          {/* Alongside the input, never in place of it. The value stays
                              authorable at position one so a step created at the top can be
                              given a gap and carry it when dragged down — which is the whole
                              reason the offset lives on the element rather than on the item. */}
                          {isFirstStep(elements, index) && (
                            <span
                              className="text-xs text-muted-foreground italic whitespace-nowrap"
                              title="Not used while this step is first — the first step is scheduled when the execution starts. It applies if you move this step below another one."
                            >
                              at start
                            </span>
                          )}
                        </label>
                      )}
                      {(element.displayType || "step") === "bullet" && (
                        <label
                          className="flex items-center gap-2 min-h-[44px] cursor-pointer"
                          title="This is something you can buy, so it can be added to a shopping collection."
                        >
                          <input
                            type="checkbox"
                            checked={element.collectable === true}
                            onChange={(e) =>
                              updateElement(
                                index,
                                "collectable",
                                e.target.checked ? true : undefined,
                              )
                            }
                            className="rounded accent-primary"
                          />
                          <span className="text-sm whitespace-nowrap">Can buy</span>
                        </label>
                      )}
                    </div>

                    {/* Item reference link */}
                    {(element.itemId || element.item_id) ? (
                      <div className="flex items-center gap-2 px-2 py-1 bg-warning-light border border-accent rounded text-sm">
                        <span className="text-primary">
                          → {allItems.find((i) => i.id === (element.itemId || element.item_id))?.name || (element.itemId || element.item_id)}
                        </span>
                        <button
                          onClick={() => updateElement(index, "itemId", undefined)}
                          className="text-primary hover:text-primary ml-auto"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : linkingElementIndex === index ? (
                      <div className="space-y-1">
                        <input
                          type="text"
                          value={linkSearch}
                          onChange={(e) => setLinkSearch(e.target.value)}
                          placeholder="Search for an item to link..."
                          className="w-full px-2 py-1 border border-border rounded text-sm"
                          autoFocus
                        />
                        <div className="max-h-32 overflow-y-auto border border-border rounded">
                          {allItems
                            .filter((i) => !i.archived && i.id !== item.id && i.name.toLowerCase().includes(linkSearch.toLowerCase()))
                            .slice(0, 8)
                            .map((i) => (
                              <button
                                key={i.id}
                                onClick={() => {
                                  updateElement(index, "itemId", i.id);
                                  setLinkingElementIndex(null);
                                  setLinkSearch("");
                                }}
                                className="w-full text-left px-2 py-1.5 text-sm hover:bg-background border-b border-border last:border-b-0"
                              >
                                {i.name}
                              </button>
                            ))}
                          {allItems.filter((i) => !i.archived && i.id !== item.id && i.name.toLowerCase().includes(linkSearch.toLowerCase())).length === 0 && (
                            <p className="text-xs text-muted-foreground px-2 py-1">No matching items</p>
                          )}
                        </div>
                        <button
                          onClick={() => { setLinkingElementIndex(null); setLinkSearch(""); }}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setLinkingElementIndex(index)}
                        className="text-xs text-primary hover:text-primary-hover"
                      >
                        Link to Item →
                      </button>
                    )}
                  </div>

                  {index < elements.length - 1 && (
                    <div className="flex justify-center -my-1">
                      <button
                        onClick={() => insertElementAbove(index + 1)}
                        className="text-success hover:text-success-hover text-lg"
                        title="Insert element below"
                      >
                        +
                      </button>
                    </div>
                  )}
                </div>
              ))}
              <button
                onClick={addElement}
                className="w-full px-4 py-2.5 border-2 border-dashed border-border rounded-lg text-muted-foreground hover:border-primary hover:text-primary transition-all duration-200"
              >
                + Add Element
              </button>
            </div>
          </div>

          <div
            className={"flex flex-wrap gap-2 pt-2 " +
              (stickyFooter
                ? "sticky bottom-28 sm:bottom-32 -mx-3 sm:-mx-4 px-3 sm:px-4 pb-3 bg-card border-t border-border"
                : "")}
          >
            <button
              onClick={handleSave}
              className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Save
            </button>
            <button
              onClick={handleCancel}
              className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Cancel
            </button>
            {/* Add mode has no record to archive. Without this guard the click
                reached onUpdate(null, …), which the add-form handlers treat as a
                save and which created a real archived item named "New Item".
                Same guard shape IntentionCard already uses for its Archive. */}
            {item.id && (
              <button
                onClick={() => {
                  onUpdate(item.id, { archived: true });
                  setIsEditing(false);
                }}
                className="px-4 py-2.5 min-h-[44px] bg-destructive hover:bg-destructive-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 ml-auto"
              >
                Archive
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow"
      onClick={() => {
        if (onViewDetail) {
          onViewDetail(item.id);
        } else {
          setIsEditing(true);
        }
      }}
    >
      <p className="font-medium mb-2">{item.name}</p>
      {item.tags && item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {item.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="px-2 py-0.5 bg-warning-light text-accent-foreground text-xs rounded-full">
              {tag}
            </span>
          ))}
          {item.tags.length > 3 && (
            <span className="px-2 py-0.5 bg-secondary/50 text-muted-foreground text-xs rounded-full">
              +{item.tags.length - 3} more
            </span>
          )}
        </div>
      )}
      {item.description && (
        <p className="text-sm text-muted-foreground mt-1">
          {item.description.length > 80
            ? item.description.substring(0, 80) + "..."
            : item.description}
        </p>
      )}
      {((item.elements || item.components)?.length > 0 || item.updatedAt) && (
          <span className="text-xs text-muted-foreground mt-1 block">
            {(item.elements || item.components)?.length > 0 && `${(item.elements || item.components).length} elements`}
            {(item.elements || item.components)?.length > 0 && item.updatedAt && ' · '}
            {item.updatedAt && `last updated: ${new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`}
          </span>
        )}
      {executions.length > 0 && onOpenExecution && (
        <div className="mt-2 space-y-1">
          {executions.map((exec) => (
            <ExecutionBadge
              key={exec.id}
              exec={exec}
              intents={intents}
              contexts={contexts}
              getIntentDisplay={getIntentDisplay}
              onOpen={onOpenExecution}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Custom recurrence dialog — Google Calendar-style fixed schedule builder.
 * Supports daily/weekly/monthly frequency, interval, day-of-week toggles,
 * monthly mode (day-of-month vs ordinal weekday), end date, and anchor date.
 */
function CustomRecurrenceDialog({ initialConfig, onDone, onCancel }) {
  const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"]; // Mon–Sun
  const DAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const ORDINALS = ["first", "second", "third", "fourth", "last"];

  // Parse initialConfig into local state
  const init = initialConfig && initialConfig.type === "fixed" ? initialConfig : null;
  const [frequency, setFrequency] = useState(init?.frequency || "week");
  const [interval, setInterval] = useState(init?.interval || 1);
  const [daysOfWeek, setDaysOfWeek] = useState(init?.daysOfWeek || []);
  const [monthlyMode, setMonthlyMode] = useState(init?.ordinal ? "ordinal" : "dayOfMonth");
  const [dayOfMonth, setDayOfMonth] = useState(init?.dayOfMonth || new Date().getDate());
  const [ordinal, setOrdinal] = useState(init?.ordinal || "first");
  const [dayOfWeek, setDayOfWeek] = useState(init?.dayOfWeek || 1);
  const [endMode, setEndMode] = useState("never");
  const [endDate, setEndDate] = useState("");
  const [anchorDate, setAnchorDate] = useState(init?.anchorDate || "");

  // Map frequency display name
  const freqToLabel = { day: "day", week: "week", month: "month" };
  const freqOptions = ["day", "week", "month"];

  // Map internal frequency to config frequency
  const freqToConfig = { day: "daily", week: "weekly", month: "monthly" };

  // Initialise frequency from config
  useEffect(() => {
    if (init?.frequency === "daily") setFrequency("day");
    else if (init?.frequency === "weekly") setFrequency("week");
    else if (init?.frequency === "monthly") setFrequency("month");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleDay(isoDay) {
    setDaysOfWeek((prev) =>
      prev.includes(isoDay) ? prev.filter((d) => d !== isoDay) : [...prev, isoDay].sort((a, b) => a - b)
    );
  }

  function handleDone() {
    const config = { type: "fixed", frequency: freqToConfig[frequency], interval };

    if (frequency === "week") {
      config.daysOfWeek = daysOfWeek.length > 0 ? daysOfWeek : [];
      if (interval > 1 && anchorDate) {
        config.anchorDate = anchorDate;
      }
    }

    if (frequency === "month") {
      if (monthlyMode === "dayOfMonth") {
        config.dayOfMonth = dayOfMonth;
      } else {
        config.ordinal = ordinal;
        config.dayOfWeek = dayOfWeek;
      }
    }

    onDone(config, endMode === "on" && endDate ? endDate : null);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-4">Custom recurrence</h3>

        {/* Repeat every [N] [frequency] */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm">Repeat every</span>
          <input
            type="number"
            min={1}
            max={99}
            value={interval}
            onChange={(e) => setInterval(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-16 px-2 py-1 border border-border rounded text-center text-sm"
          />
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            className="px-2 py-1 border border-border rounded text-sm"
          >
            {freqOptions.map((f) => (
              <option key={f} value={f}>
                {interval > 1 ? freqToLabel[f] + "s" : freqToLabel[f]}
              </option>
            ))}
          </select>
        </div>

        {/* Weekly: day-of-week toggles */}
        {frequency === "week" && (
          <div className="mb-4">
            <span className="text-sm text-muted-foreground block mb-2">Repeat on</span>
            <div className="flex gap-1">
              {DAY_LABELS.map((label, i) => {
                const isoDay = i + 1; // 1=Mon, 7=Sun
                const active = daysOfWeek.includes(isoDay);
                return (
                  <button
                    key={isoDay}
                    type="button"
                    onClick={() => toggleDay(isoDay)}
                    className={`w-9 h-9 rounded-full text-xs font-medium transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Weekly + interval > 1: anchor date */}
        {frequency === "week" && interval > 1 && (
          <div className="mb-4">
            <label className="text-sm text-muted-foreground block mb-1">
              Anchor week of
            </label>
            <input
              type="date"
              value={anchorDate}
              onChange={(e) => setAnchorDate(e.target.value)}
              className="w-full px-2 py-1 border border-border rounded text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">Determines which week is "on"</p>
          </div>
        )}

        {/* Monthly: day-of-month vs ordinal weekday */}
        {frequency === "month" && (
          <div className="mb-4 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="monthlyMode"
                checked={monthlyMode === "dayOfMonth"}
                onChange={() => setMonthlyMode("dayOfMonth")}
              />
              <span>On day</span>
              <input
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(Math.min(31, Math.max(1, parseInt(e.target.value) || 1)))}
                className="w-14 px-2 py-1 border border-border rounded text-center text-sm"
                disabled={monthlyMode !== "dayOfMonth"}
              />
            </label>
            <label className="flex items-center gap-2 text-sm flex-wrap">
              <input
                type="radio"
                name="monthlyMode"
                checked={monthlyMode === "ordinal"}
                onChange={() => setMonthlyMode("ordinal")}
              />
              <span>On the</span>
              <select
                value={ordinal}
                onChange={(e) => setOrdinal(e.target.value)}
                className="px-2 py-1 border border-border rounded text-sm"
                disabled={monthlyMode !== "ordinal"}
              >
                {ORDINALS.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
              <select
                value={dayOfWeek}
                onChange={(e) => {
                  const v = e.target.value;
                  setDayOfWeek(v === "weekday" ? "weekday" : parseInt(v));
                }}
                className="px-2 py-1 border border-border rounded text-sm"
                disabled={monthlyMode !== "ordinal"}
              >
                {DAY_FULL.map((name, i) => (
                  <option key={i + 1} value={i + 1}>{name}</option>
                ))}
                <option value="weekday">Weekday (Mon–Fri)</option>
              </select>
            </label>
          </div>
        )}

        {/* End date */}
        <div className="mb-4 space-y-2">
          <span className="text-sm text-muted-foreground block">Ends</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="endMode"
              checked={endMode === "never"}
              onChange={() => setEndMode("never")}
            />
            Never
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="endMode"
              checked={endMode === "on"}
              onChange={() => setEndMode("on")}
            />
            <span>On</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-2 py-1 border border-border rounded text-sm"
              disabled={endMode !== "on"}
            />
          </label>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-border rounded hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDone}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:opacity-90 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Interval-from-completion dialog — schedule next event N days/weeks/months after done.
 */
function IntervalRecurrenceDialog({ initialConfig, onDone, onCancel }) {
  const init = initialConfig && initialConfig.type === "interval" ? initialConfig : null;
  const [every, setEvery] = useState(init?.every || 2);
  const [unit, setUnit] = useState(init?.unit || "days");
  const [endMode, setEndMode] = useState("never");
  const [endDate, setEndDate] = useState("");

  function handleDone() {
    const config = { type: "interval", every, unit };
    onDone(config, endMode === "on" && endDate ? endDate : null);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-4">Repeat after completion</h3>

        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm">Schedule next event</span>
          <input
            type="number"
            min={1}
            max={99}
            value={every}
            onChange={(e) => setEvery(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-16 px-2 py-1 border border-border rounded text-center text-sm"
          />
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="px-2 py-1 border border-border rounded text-sm"
          >
            <option value="days">{every > 1 ? "days" : "day"}</option>
            <option value="weeks">{every > 1 ? "weeks" : "week"}</option>
            <option value="months">{every > 1 ? "months" : "month"}</option>
          </select>
          <span className="text-sm">after done</span>
        </div>

        <div className="mb-4 space-y-2">
          <span className="text-sm text-muted-foreground block">Ends</span>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="intervalEndMode" checked={endMode === "never"} onChange={() => setEndMode("never")} />
            Never
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="intervalEndMode" checked={endMode === "on"} onChange={() => setEndMode("on")} />
            <span>On</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-2 py-1 border border-border rounded text-sm"
              disabled={endMode !== "on"}
            />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm border border-border rounded hover:bg-muted transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleDone} className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:opacity-90 transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A trigger button that opens a small date popover and schedules on confirm.
 * Step 6 of docs/technical-spec-ui-standardization.md.
 *
 * This exists to make "Do Today" and "Schedule Later" the same kind of thing.
 * They used to be opposites: Do Today wrote an event and threw you to the
 * Schedule page, while Schedule Later wrote nothing at all — it toggled a date
 * input whose value was only applied if you afterwards remembered to press
 * Save. Two buttons side by side, one committing and one not, is the whole of
 * the "feels off" complaint.
 *
 * Now both open this control and both commit. The only difference is where the
 * date starts: `initialDate` is today for Do Today and empty for Schedule
 * Later. A confirm button rather than committing on the input's change event —
 * `<input type="date">` fires change per keystroke during keyboard entry in
 * some browsers, so committing on change would write a half-typed year.
 *
 * `placement` because the two surfaces sit at opposite ends of the screen: the
 * edit-form footer opens upward (downward would land under the fixed Capture
 * bar), the detail-page header opens downward.
 */
function SchedulePopover({
  label,
  icon = null,
  initialDate = "",
  onPick,
  className = "",
  placement = "bottom",
  disabled = false,
  confirmLabel = "Schedule",
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(initialDate);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function toggle() {
    setOpen((wasOpen) => {
      // Reset on every open, so Do Today always offers today even after the
      // popover was left holding some other date from a previous visit.
      if (!wasOpen) setDate(initialDate);
      return !wasOpen;
    });
  }

  function commit() {
    if (!date) return;
    setOpen(false);
    onPick(date);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={className}
      >
        {icon}
        {label}
      </button>
      {open && (
        <div
          className={`absolute right-0 z-30 w-60 p-3 bg-card border border-border rounded-lg shadow-lg ${
            placement === "top" ? "bottom-full mb-2" : "top-full mt-2"
          }`}
        >
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Schedule for
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            className="w-full px-3 py-2 min-h-[44px] border border-border rounded text-base mb-2"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={commit}
              disabled={!date}
              className="flex-1 px-3 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 py-2 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Quick-select recurrence dropdown — replaces the old 4-option <select>.
 * Shows dynamic labels based on today's date (e.g., "Weekly on Friday").
 * "Custom..." opens the CustomRecurrenceDialog inline.
 * "After completion..." opens the interval dialog (Step 8).
 */
function RecurrenceQuickSelect({ value, onChange, onOpenInterval, onEndDateChange, className = "" }) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [showInterval, setShowInterval] = useState(false);
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Dynamic labels based on today
  const today = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const todayName = dayNames[today.getDay()];
  const todayIsoDay = today.getDay() === 0 ? 7 : today.getDay();
  const todayDom = today.getDate();

  function suffix(n) {
    const m = n % 100;
    if (m >= 11 && m <= 13) return `${n}th`;
    switch (n % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  }

  const options = [
    {
      label: "Does not repeat",
      config: { type: "once" },
    },
    {
      label: "Daily",
      config: { type: "fixed", frequency: "daily", interval: 1 },
    },
    {
      label: `Weekly on ${todayName}`,
      config: { type: "fixed", frequency: "weekly", interval: 1, daysOfWeek: [todayIsoDay] },
    },
    {
      label: `Monthly on the ${suffix(todayDom)}`,
      config: { type: "fixed", frequency: "monthly", interval: 1, dayOfMonth: todayDom },
    },
    {
      label: "Every weekday (Mon\u2013Fri)",
      config: { type: "fixed", frequency: "weekly", interval: 1, daysOfWeek: [1, 2, 3, 4, 5] },
    },
  ];

  // Determine display label from current value
  function getDisplayLabel() {
    if (!value || value.type === "once") return "Does not repeat";
    // Check if it matches a quick option (use quick label for those)
    if (value.type === "fixed") {
      const match = options.find((o) =>
        o.config.type === value.type &&
        o.config.frequency === value.frequency &&
        o.config.interval === value.interval &&
        JSON.stringify(o.config.daysOfWeek || null) === JSON.stringify(value.daysOfWeek || null) &&
        (o.config.dayOfMonth || null) === (value.dayOfMonth || null)
      );
      if (match) return match.label;
    }
    // For custom configs and interval configs, use the display string helper
    return getRecurrenceDisplayString(value);
  }

  function select(option) {
    onChange(option.config);
    setOpen(false);
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 border border-border rounded text-base text-left bg-background flex items-center justify-between"
      >
        <span>{getDisplayLabel()}</span>
        <ChevronDown className="w-4 h-4 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-background border border-border rounded shadow-lg">
          {options.map((option, i) => (
            <button
              key={i}
              type="button"
              onClick={() => select(option)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
            >
              {option.label}
            </button>
          ))}
          <div className="border-t border-border" />
          <button
            type="button"
            onClick={() => { setOpen(false); setShowCustom(true); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors text-muted-foreground"
          >
            Custom…
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); setShowInterval(true); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors text-muted-foreground"
          >
            After completion…
          </button>
        </div>
      )}

      {/* Custom fixed schedule dialog */}
      {showCustom && (
        <CustomRecurrenceDialog
          initialConfig={value && value.type === "fixed" ? value : null}
          onDone={(config, endDateVal) => {
            onChange(config);
            if (onEndDateChange && endDateVal) onEndDateChange(endDateVal);
            setShowCustom(false);
          }}
          onCancel={() => setShowCustom(false)}
        />
      )}

      {/* Interval dialog placeholder — implemented in Step 8 */}
      {showInterval && (
        <IntervalRecurrenceDialog
          initialConfig={value && value.type === "interval" ? value : null}
          onDone={(config, endDateVal) => {
            onChange(config);
            if (onEndDateChange && endDateVal) onEndDateChange(endDateVal);
            setShowInterval(false);
          }}
          onCancel={() => setShowInterval(false)}
        />
      )}
    </div>
  );
}

function IntentionCard({
  intent,
  contexts,
  items,
  onUpdate,
  onSchedule,
  onStartNow,
  getIntentDisplay,
  showScheduling = false,
  isEditing: initialEditing = false,
  onCancel,
  onViewDetail,
  events = [],
  onUpdateEvent,
  onActivate,
  executions = [],
  onOpenExecution,
  onCancelExecution,
  onArchive,
  collections = [],
  onDirtyChange,
  // See ItemCard — true only on intention detail, where this card is the page.
  stickyFooter = false,
}) {
  const [isEditing, setIsEditing] = useState(initialEditing);
  const [name, setName] = useState(intent.text);
  const [recurrenceConfig, setRecurrenceConfig] = useState(intent.recurrenceConfig || null);
  const [intentEndDate, setIntentEndDate] = useState(intent.endDate || null);
  const [targetStartDate, setTargetStartDate] = useState(intent.targetStartDate || null);
  const [itemSearch, setItemSearch] = useState("");
  const [showItemPicker, setShowItemPicker] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState(intent.itemId || "");
  const [selectedCollectionId, setSelectedCollectionId] = useState(intent.collectionId || "");
  const [tags, setTags] = useState(intent.tags || []);
  const [selectedContextId, setSelectedContextId] = useState(intent.contextId || "");
  const [contextSearch, setContextSearch] = useState("");
  const [showContextPicker, setShowContextPicker] = useState(false);

  // Was a per-card query on mount asking
  // `intent_id = … AND closed_at IS NULL` — one round trip per row on the
  // Intentions list. `executions` already carries allLiveExecutions, which is
  // that exact set, so the answer was in hand the whole time. Every site that
  // passes `onArchive` also passes `executions` (checked; intention detail's
  // edit mode had to be given it).
  const hasActiveExecutions = executions.some(
    (ex) => ex.intentId === intent.id,
  );

  useEffect(() => {
    if (!isEditing || !onDirtyChange) return;
    const isDirty =
      name !== intent.text ||
      JSON.stringify(recurrenceConfig) !== JSON.stringify(intent.recurrenceConfig || null) ||
      selectedItemId !== (intent.itemId || "") ||
      selectedCollectionId !== (intent.collectionId || "") ||
      selectedContextId !== (intent.contextId || "") ||
      JSON.stringify(tags) !== JSON.stringify(intent.tags || []);
    onDirtyChange(isDirty, "this intention");
  }, [isEditing, name, recurrenceConfig, selectedItemId, selectedCollectionId, selectedContextId, tags]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { if (onDirtyChange) onDirtyChange(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Autocomplete search logic
  const filteredContexts =
    contexts && contextSearch.trim()
      ? contexts
          .filter((c) =>
            !c.archived &&
            c.name.toLowerCase().includes(contextSearch.toLowerCase()),
          )
          .slice(0, 10)
      : [];

  const filteredItems =
    items && itemSearch.trim()
      ? items
          .filter((item) =>
            item.name.toLowerCase().includes(itemSearch.toLowerCase()),
          )
          .slice(0, 10)
      : [];

  function handleSave(scheduledDate) {
    if (!name.trim()) {
      // Name is required - just return without saving
      return;
    }
    if (onDirtyChange) onDirtyChange(false);
    if (onUpdate) {
      const updates = showScheduling
        ? { text: name, recurrenceConfig, endDate: intentEndDate, targetStartDate, itemId: selectedItemId || null, contextId: selectedContextId || null, tags, collectionId: selectedCollectionId || null }
        : { text: name, itemId: selectedItemId || null, contextId: selectedContextId || null, tags, collectionId: selectedCollectionId || null };
      onUpdate(intent.id, updates, scheduledDate);
    }
    if (!onCancel) {
      // Only control isEditing state if we're not in add mode
      setIsEditing(false);
    }
  }

  function handleCancel() {
    if (onDirtyChange) onDirtyChange(false);
    if (onCancel) {
      onCancel();
    } else {
      setName(intent.text);
      setRecurrenceConfig(intent.recurrenceConfig || null);
      setIntentEndDate(intent.endDate || null);
      setTargetStartDate(intent.targetStartDate || null);
      setTags(intent.tags || []);
      setSelectedItemId(intent.itemId || "");
      setSelectedCollectionId(intent.collectionId || "");
      setItemSearch("");
      setSelectedContextId(intent.contextId || "");
      setContextSearch("");
      setIsEditing(false);
    }
  }

  // Get context name for badge
  const contextName =
    intent.contextId && contexts
      ? contexts.find((c) => c.id === intent.contextId)?.name
      : null;

  const relatedEvents = events.filter(
    (e) => e.intentId === intent.id && !e.archived,
  );

  if (isEditing) {
    return (
      <div className="p-3 sm:p-4 bg-card border-2 border-primary rounded-lg shadow-md">
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded text-base"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Linked Context (optional)
            </label>
            <div className="relative">
              <input
                type="text"
                value={contextSearch}
                onChange={(e) => {
                  setContextSearch(e.target.value);
                  setShowContextPicker(true);
                }}
                onFocus={() => setShowContextPicker(true)}
                onBlur={() => setTimeout(() => setShowContextPicker(false), 200)}
                placeholder="Search for a context..."
                className="w-full px-3 py-2 border border-border rounded text-base"
              />
              {selectedContextId && !contextSearch && contexts && (
                <div className="mt-1 text-sm text-muted-foreground">
                  Selected: {contexts.find((c) => c.id === selectedContextId)?.name}
                  <button
                    onClick={() => {
                      setSelectedContextId("");
                      setContextSearch("");
                    }}
                    className="ml-2 text-destructive hover:text-destructive-hover"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
              {showContextPicker && contextSearch && filteredContexts.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {filteredContexts.map((ctx) => (
                    <button
                      key={ctx.id}
                      onClick={() => {
                        setSelectedContextId(ctx.id);
                        setContextSearch(ctx.name);
                        setShowContextPicker(false);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-background border-b border-border last:border-b-0"
                    >
                      <div className="font-medium">{ctx.name}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Linked Item (optional)
            </label>
            <div className="relative">
              <input
                type="text"
                value={itemSearch}
                onChange={(e) => {
                  setItemSearch(e.target.value);
                  setShowItemPicker(true);
                }}
                onFocus={() => setShowItemPicker(true)}
                onBlur={() => setTimeout(() => setShowItemPicker(false), 200)}
                placeholder="Search for an item..."
                className="w-full px-3 py-2 border border-border rounded text-base"
              />
              {selectedItemId && !itemSearch && items && (
                <div className="mt-1 text-sm text-muted-foreground">
                  Selected: {items.find((i) => i.id === selectedItemId)?.name}
                  <button
                    onClick={() => {
                      setSelectedItemId("");
                      setItemSearch("");
                    }}
                    className="ml-2 text-destructive hover:text-destructive-hover"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
              {showItemPicker && itemSearch && filteredItems.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {filteredItems.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        setSelectedItemId(item.id);
                        setItemSearch(item.name);
                        setShowItemPicker(false);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-background border-b border-border last:border-b-0"
                    >
                      <div className="font-medium">{item.name}</div>
                      {item.contextId && contexts && (
                        <div className="text-xs text-muted-foreground">
                          {contexts.find((c) => c.id === item.contextId)?.name}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {collections.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Linked Collection (optional)
              </label>
              <select
                value={selectedCollectionId}
                onChange={(e) => setSelectedCollectionId(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded text-base"
              >
                <option value="">None</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Tags
            </label>
            <TagInput value={tags} onChange={setTags} />
          </div>

          {showScheduling && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Recurrence
              </label>
              <RecurrenceQuickSelect
                value={recurrenceConfig}
                onChange={(config) => {
                  setRecurrenceConfig(config);
                }}
                onEndDateChange={setIntentEndDate}
              />
            </div>
          )}

          {showScheduling && (
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-sm font-medium text-foreground mb-1">
                  Target Start Date
                </label>
                <input
                  type="date"
                  value={targetStartDate || ""}
                  onChange={(e) => setTargetStartDate(e.target.value || null)}
                  className="w-full px-3 py-2 border border-border rounded text-base"
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-foreground mb-1">
                  End Date
                </label>
                <input
                  type="date"
                  value={intentEndDate || ""}
                  onChange={(e) => setIntentEndDate(e.target.value || null)}
                  className="w-full px-3 py-2 border border-border rounded text-base"
                />
              </div>
            </div>
          )}

          <div
            className={
              "flex gap-2 flex-wrap " +
              (stickyFooter
                ? "sticky bottom-28 sm:bottom-32 -mx-3 sm:-mx-4 px-3 sm:px-4 pt-2 pb-3 bg-card border-t border-border"
                : "")
            }
          >
            {/* Both go through handleSave, so each still saves the form AND
                schedules in one action — which is what the old Do Today did and
                the old Schedule Later did not. The popover only supplies the
                date; the asymmetry being fixed is that one committed and the
                other quietly waited for Save.

                Opening upward: this footer sits at the bottom of the card, and
                a downward popover would open under the fixed Capture bar. */}
            {showScheduling && onSchedule && relatedEvents.length === 0 && (
              <>
                <SchedulePopover
                  label="Do Today"
                  initialDate={getTodayDate()}
                  onPick={(date) => handleSave(date)}
                  placement="top"
                  className="px-3 sm:px-4 py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
                />
                <SchedulePopover
                  label="Schedule Later"
                  onPick={(date) => handleSave(date)}
                  placement="top"
                  className="px-3 sm:px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
                />
              </>
            )}

            <button
              onClick={() => handleSave(null)}
              className="px-3 sm:px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              Save Changes
            </button>

            <button
              onClick={handleCancel}
              className="px-3 sm:px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              Cancel
            </button>

            {onArchive && intent.id && (
              <button
                onClick={() => onArchive(intent.id)}
                disabled={hasActiveExecutions}
                className={`px-3 sm:px-4 py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base ml-auto ${hasActiveExecutions ? 'bg-secondary text-muted-foreground cursor-not-allowed' : 'bg-destructive hover:bg-destructive-hover text-white'}`}
                title={hasActiveExecutions ? 'Cannot archive: active execution in progress' : 'Archive this intention and all related events'}
              >
                Archive
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow"
      onClick={() => {
        if (onViewDetail) {
          onViewDetail(intent.id);
        } else {
          setIsEditing(true);
        }
      }}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-medium">{getIntentDisplay(intent)}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {showScheduling && (
              <span className="text-sm text-muted-foreground">
                {getRecurrenceDisplayString(getRecurrenceConfig(intent), intent.endDate)}
              </span>
            )}
            {contextName && (
              <span className="text-xs bg-warning-light text-foreground px-2 py-0.5 rounded">
                {contextName}
              </span>
            )}
            {intent.tags && intent.tags.length > 0 && intent.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="px-2 py-0.5 bg-warning-light text-accent-foreground text-xs rounded-full">
                {tag}
              </span>
            ))}
            {intent.tags && intent.tags.length > 3 && (
              <span className="px-2 py-0.5 bg-secondary/50 text-muted-foreground text-xs rounded-full">
                +{intent.tags.length - 3} more
              </span>
            )}
          </div>
        </div>
        {/* Display mode — a list row, not one of Step 6's two surfaces. This
            stays a single-click commit rather than a popover: it is a quick
            action sitting next to Start Now, there is no Schedule Later beside
            it to be asymmetric with, and making the common case two clicks on
            a row you are scanning past would be a worse trade. It does pick up
            the rest of Step 6 for free — it no longer navigates, and it now
            reports the date through the message. */}
        {showScheduling && relatedEvents.length === 0 && (
          <div className="flex gap-2 shrink-0">
            {onSchedule && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSchedule(intent.id, "today");
                }}
                className="px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                Do Today
              </button>
            )}
            {onStartNow && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStartNow(intent.id);
                }}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Play className="w-4 h-4" />
                Start Now
              </button>
            )}
          </div>
        )}
      </div>
      {relatedEvents.length > 0 && (
        <div className="mt-2 space-y-2">
          {relatedEvents.map((ev) => (
            <EventCard
              key={ev.id}
              event={ev}
              intent={intent}
              contexts={contexts}
              onUpdate={onUpdateEvent}
              onActivate={onActivate}
              getIntentDisplay={getIntentDisplay}
              executions={executions}
              onOpenExecution={onOpenExecution}
              onCancelExecution={onCancelExecution}
              nested
              items={[]}
              collections={[]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EventCard({
  event,
  intent,
  contexts,
  onUpdate,
  onActivate,
  getIntentDisplay,
  executions = [],
  onOpenExecution,
  onCancelExecution,
  nested = false,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(event.time);
  const [eventName, setEventName] = useState(event.text || intent?.text || "");

  function handleSave() {
    onUpdate(event.id, { time: scheduledDate, text: eventName });
    setIsEditing(false);
  }

  async function handleCancelEvent() {
    // Double-check for active execution
    const { data: activeExecs } = await supabase
      .from('executions')
      .select('id')
      .eq('event_id', event.id)
      .is('closed_at', null);

    if (activeExecs && activeExecs.length > 0) {
      alert('Cannot archive: this event has an active execution. Complete or cancel it first.');
      return;
    }

    // Delete the execution if one exists for this event
    if (onCancelExecution) {
      await onCancelExecution(event.id);
    }
    // Archive the event
    onUpdate(event.id, { archived: true });
    setIsEditing(false);
  }

  const execution = executions.find((ex) => ex.eventId === event.id);

  // Was a per-row `supabase.from('executions')` query on mount, which on the
  // Schedule page meant one round trip per event. It asked
  // `event_id = … AND closed_at IS NULL` — which is precisely the set the
  // `executions` prop already holds, because callers pass allLiveExecutions
  // (active + paused, both closed_at null). So `execution` above had already
  // answered the question the query was asking.
  //
  // `handleCancelEvent`'s own check stays: that one runs at the moment of the
  // write and guards against a stale client, which is a different job from
  // deciding whether to grey a button out.
  const hasActiveExecution = Boolean(execution);

  // Show editable form when there's no execution
  if (isEditing) {
    return (
      <div className="p-3 sm:p-4 bg-card border-2 border-primary rounded-lg shadow-md">
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Event Name
            </label>
            <input
              type="text"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              className="w-full px-3 py-2 min-h-[44px] border border-border rounded text-base"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Scheduled Date
            </label>
            <input
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
              className="w-full px-3 py-2 min-h-[44px] border border-border rounded"
            />
          </div>

          {/* Standard footer order: primary, Cancel, gap, Archive pushed right.
              This was Save · Archive · Close, with the destructive action sitting
              between the two safe ones — the only footer in the app where a
              mis-tap on the button next to Save archived the record. The third
              button is also renamed: it resets the fields and leaves, which is
              Cancel, and calling it Close made it read like a fourth kind of
              thing next to three cards that all say Cancel. */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSave}
              className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Save
            </button>
            <button
              onClick={() => {
                setScheduledDate(event.time);
                setEventName(event.text || intent?.text || "");
                setIsEditing(false);
              }}
              className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Cancel
            </button>
            <button
              onClick={handleCancelEvent}
              disabled={hasActiveExecution}
              className={`px-4 py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 ml-auto ${hasActiveExecution ? 'bg-secondary text-muted-foreground cursor-not-allowed' : 'bg-destructive hover:bg-destructive-hover text-white'}`}
              title={hasActiveExecution ? 'Cannot archive: active execution in progress' : 'Archive this event'}
            >
              Archive Event
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    // Whole-card clickable, like ItemCard and IntentionCard. Previously only the
    // title column responded, leaving the padding and the gap beside the
    // Start/Continue button dead.
    //
    // The stopPropagation moved up here with the handler, and still matters for
    // the same reason it did on the title block: IntentionCard renders its
    // related events nested INSIDE its own onClick div, so without it a click
    // runs this handler and the parent's together (defect 0.3). Inert at the
    // four top-level sites, load-bearing at the nested one.
    <div
      onClick={(e) => {
        e.stopPropagation();
        if (execution && onOpenExecution) {
          onOpenExecution(execution);
        } else {
          setIsEditing(true);
        }
      }}
      className={`p-3 bg-card border border-border rounded-lg cursor-pointer shadow-sm hover:shadow-md transition-shadow duration-200 ${
        // Deferred from Step 3, settled here. Every other whole-card-clickable
        // card has hover:border-primary; EventCard could not take it because it
        // also renders NESTED inside IntentionCard, whose own hover already
        // fires on the nested child — a second border would light two cards for
        // one click target that stopPropagation resolves to the inner one.
        //
        // Suppressing the parent's highlight instead would need a has-[…]
        // variant (available in Tailwind 3.4) reaching into a child's hover
        // state, which is a fragile selector to leave behind for one row type.
        // Gating on `nested` is the same outcome in a prop that already exists.
        //
        // The nested row does not lose its affordance: as of Step 8a every
        // EventCard carries always-visible Start/Continue and Archive buttons,
        // so interactivity is advertised by controls rather than by hover.
        nested ? "" : "hover:border-primary"
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-foreground hover:text-primary">
            {nested ? `Event: ${event.text || getIntentDisplay(intent)}` : (event.text || getIntentDisplay(intent))}
          </p>
          <p className="text-sm text-muted-foreground">
            {formatEventDate(event.time)} • {execution ? (execution.status === "active" ? "In progress" : "Paused") : "Not started"}
          </p>
          {event.contextId && (
            <span className="inline-block mt-1 text-xs bg-warning-light text-foreground px-2 py-0.5 rounded">
              {contexts.find((c) => c.id === event.contextId)?.name}
            </span>
          )}
        </div>
        {/* Row action strip: Start/Continue then Archive, right-aligned and
            always visible — never hover-revealed, because the primary device is
            a touchscreen. No Edit button: clicking the row already opens the
            edit form, and a row action never duplicates the row click.

            Every button here stops propagation. They are descendants of the
            card's own onClick as of Step 3, so without it each would fire its
            action AND open the edit form. */}
        {/* gap-3 not gap-2: 8px is Material's documented FLOOR for adjacent
            targets, not a comfortable value, and the neighbour here is
            destructive. On a touchscreen a thumb landing between Start and
            Archive was a coin flip.

            self-end because below the sm breakpoint the parent is `flex-col`,
            where justify-between governs the VERTICAL axis and does nothing
            horizontally — so the "right-aligned" strip was left-aligned on
            exactly the device this app is built for. */}
        <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
          {execution ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (onOpenExecution) onOpenExecution(execution);
            }}
            className={`flex items-center justify-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 shrink-0 text-sm sm:text-base ${
              execution.status === "active"
                ? "bg-primary hover:bg-primary-hover text-white"
                : "bg-warning hover:bg-warning-hover text-white"
            }`}
          >
            {execution.status === "active" ? (
              <>
                <Play className="w-3 h-3" />
                Continue
              </>
            ) : (
              <>
                <Pause className="w-3 h-3" />
                Paused
              </>
            )}
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onActivate(event.id);
            }}
            className="flex items-center justify-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 shrink-0 text-sm sm:text-base"
          >
            <Play className="w-3 h-3" />
            Start
          </button>
        )}
        {/* Archive lived only inside the edit form, which governing rule 4
            forbids: archiving changes the record's state, not its content, so
            it belongs on the row. Disabled while an execution is open, the same
            rule the form applies. `onUpdate` routes to updateEvent, which
            already offers the Undo. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleCancelEvent();
          }}
          disabled={hasActiveExecution}
          title={
            hasActiveExecution
              ? "Cannot archive: active execution in progress"
              : "Archive this event"
          }
          className={`flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg transition-colors shrink-0 ${
            hasActiveExecution
              ? "text-muted-foreground/40 cursor-not-allowed"
              : "text-muted-foreground hover:text-destructive hover:bg-secondary"
          }`}
        >
            <Archive className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
