import React, { useState, useEffect, useRef } from "react";
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
} from "lucide-react";
import { supabase, supabaseUrl } from "./supabaseClient";
import { calculateNextEventDate, getRecurrenceConfig } from "./utils/recurrence";
import { getRecurrenceDisplayString } from "./utils/recurrenceDisplay";
import SamPlayer from "./sam/SamPlayer";

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

  // Convert camelCase to snake_case for database
  toSnakeCase(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((item) => this.toSnakeCase(item));

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      const snakeKey = key.replace(
        /[A-Z]/g,
        (letter) => `_${letter.toLowerCase()}`,
      );
      result[snakeKey] =
        typeof value === "object" && value !== null
          ? this.toSnakeCase(value)
          : value;
    }
    return result;
  },

  // Convert snake_case to camelCase from database
  toCamelCase(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((item) => this.toCamelCase(item));

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
        letter.toUpperCase(),
      );
      result[camelKey] =
        typeof value === "object" && value !== null
          ? this.toCamelCase(value)
          : value;
    }
    return result;
  },

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

function getTodayDate() {
  return new Date().toISOString().split("T")[0];
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

function LoginScreen() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleGoogleLogin() {
    setLoading(true);
    setError('');

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin
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

      <div className="flex gap-2">
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

export default function Alfred() {
  const [view, setView] = useState("home");
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

  // Unsaved changes guard
  const unsavedChangesRef = useRef(false);
  const unsavedChangesLabelRef = useRef("");

  function setUnsavedChanges(dirty, label = "") {
    unsavedChangesRef.current = dirty;
    unsavedChangesLabelRef.current = label;
  }

  function guardedSetView(newView) {
    if (unsavedChangesRef.current) {
      const label = unsavedChangesLabelRef.current || "this form";
      if (!window.confirm(`You have unsaved changes to ${label}. Discard and navigate away?`)) {
        return;
      }
      unsavedChangesRef.current = false;
      unsavedChangesLabelRef.current = "";
    }
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
  }, [user]);

  useEffect(() => {
    setFilterTag(null);
  }, [view]);

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
        case "songs": table = "sam_songs"; updates = { archived: false }; break;
        case "snippets": table = "sam_snippets"; updates = { archived: false }; break;
        default: return;
      }

      const { error } = await supabase.from(table).update(updates).eq("id", id);
      if (error) throw error;

      setRecycleData(prev => prev.filter(r => r.id !== id));

      if (["items", "intents", "events"].includes(tab)) {
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
    if (!window.confirm("Permanently delete this record? This cannot be undone.")) return;
    setRecycleLoading(true);
    try {
      let table;
      switch (tab) {
        case "items": table = "items"; break;
        case "intents": table = "intents"; break;
        case "events": table = "events"; break;
        case "executions": table = "executions"; break;
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
        case "songs": table = "sam_songs"; updates = { archived: false }; break;
        case "snippets": table = "sam_snippets"; updates = { archived: false }; break;
        default: return;
      }

      const ids = Array.from(recycleSelected);
      const { error } = await supabase.from(table).update(updates).in("id", ids);
      if (error) throw error;

      setRecycleData(prev => prev.filter(r => !recycleSelected.has(r.id)));
      setRecycleSelected(new Set());

      if (["items", "intents", "events"].includes(recycleTab)) {
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
    if (!window.confirm(`Permanently delete ${recycleSelected.size} record${recycleSelected.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    setRecycleLoading(true);
    try {
      let table;
      switch (recycleTab) {
        case "items": table = "items"; break;
        case "intents": table = "intents"; break;
        case "events": table = "events"; break;
        case "executions": table = "executions"; break;
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

  async function archiveInboxItem(inboxItemId) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    return withLoading('Archiving...', async () => {
      const updated = { ...inboxItem, archived: true, triagedAt: new Date().toISOString() };
      await storage.set(`inbox:${inboxItem.id}`, updated);
      setInboxItems(inboxItems.filter((i) => i.id !== inboxItemId));
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
        await storage.set(`item:${newItem.id}`, newItem, isShared);
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
        await storage.set(`intent:${newIntent.id}`, newIntent);
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
          await storage.set(`event:${newEvent.id}`, newEvent);
          setEvents((prev) => [...prev, newEvent]);
        }
      }

      // Add to collection if Collection section was open
      if (triageData.addToCollection && triageData.collectionData) {
        const targetItemId = triageData.collectionData.itemId || createdItemId;
        if (targetItemId && triageData.collectionData.collectionId) {
          const collection = collections.find(
            (c) => c.id === triageData.collectionData.collectionId
          );
          if (collection) {
            const updatedItems = [
              ...(collection.items || []),
              {
                itemId: targetItemId,
                quantity: triageData.collectionData.quantity || '1',
                addedAt: new Date().toISOString(),
              },
            ];
            const updatedCollection = { ...collection, items: updatedItems };
            await storage.set(`item_collections:${collection.id}`, updatedCollection);
            setCollections((prev) =>
              prev.map((c) => (c.id === collection.id ? updatedCollection : c))
            );
          }
        }
      }

      // Archive inbox item
      const updated = { ...inboxItem, archived: true, triagedAt: new Date().toISOString() };
      await storage.set(`inbox:${inboxItem.id}`, updated);
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
      if (scheduledDate === "today") {
        setView("schedule");
      }
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

      // Navigate back to previous view
      setSelectedIntentionId(null);
      setView(previousView);
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
      if (updates.archived === true && event.intentId) {
        await triggerRecurrence(event.intentId, event);
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
        setActiveExecution(execution);
        setActiveExecutions((prev) => [execution, ...prev]);
        setPreviousView(view);
        setView("execution-detail");
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
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      setView("execution-detail");
    });
  }

  /**
   * Creates the next recurring event for an intent after an event is archived.
   * Shared by closeExecution (completion) and manual event archive (skip).
   */
  async function triggerRecurrence(intentId, archivedEvent) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;

    const config = getRecurrenceConfig(intent);
    if (config.type === "once") return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDate = calculateNextEventDate(config, today);

    if (nextDate && (!intent.endDate || nextDate <= new Date(intent.endDate + "T23:59:59"))) {
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: intent.id,
        time: nextDate.toISOString().split("T")[0],
        itemIds: archivedEvent?.itemIds || [],
        contextId: intent.contextId,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      await storage.set(`event:${newEvent.id}`, newEvent);
      setEvents((prev) => [...prev, newEvent]);
    }
  }

  async function closeExecution(outcome) {
    if (!activeExecution) return;
    return withLoading('Completing...', async () => {
      // Cancel = Delete: just remove active execution, don't archive anything
      if (outcome === "cancelled") {
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

      // Remove completed items from collection
      if (outcome === "done" && activeExecution.collectionId) {
        const completedIds = activeExecution.completedItemIds || [];
        if (completedIds.length > 0) {
          const coll = collections.find((c) => c.id === activeExecution.collectionId);
          if (coll) {
            const remainingItems = (coll.items || []).filter(
              (ci) => !completedIds.includes(ci.itemId)
            );
            const updatedColl = { ...coll, items: remainingItems };
            await storage.set(`item_collections:${coll.id}`, updatedColl);
            setCollections(collections.map((c) =>
              c.id === coll.id ? updatedColl : c
            ));
          }
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

  async function updateCollectionItemQty(collectionId, itemId, quantity) {
    const coll = collections.find((c) => c.id === collectionId);
    if (!coll) return;
    const newItems = (coll.items || []).map((ci) =>
      ci.itemId === itemId ? { ...ci, quantity } : ci
    );
    const updated = { ...coll, items: newItems };
    await storage.set(`item_collections:${coll.id}`, updated);
    setCollections(collections.map((c) => (c.id === collectionId ? updated : c)));
  }

  async function refreshCollection(collectionId) {
    const coll = await storage.get(`item_collections:${collectionId}`);
    if (coll) {
      setCollections((prev) =>
        prev.map((c) => (c.id === collectionId ? coll : c))
      );
    }
  }

  async function saveContext(
    name,
    shared = false,
    keywords = "",
    description = "",
    pinned = false,
  ) {
    return withLoading('Saving context...', async () => {
      const context = editingContext
        ? {
            ...editingContext,
            name,
            shared,
            keywords,
            description,
            pinned,
          }
        : {
            id: uid(),
            user_id: user.id,
            name,
            shared,
            keywords,
            description,
            pinned,
            createdAt: new Date().toISOString(),
          };

      await storage.set(`context:${context.id}`, context, shared);

      if (editingContext) {
        setContexts(contexts.map((c) => (c.id === context.id ? context : c)));
      } else {
        setContexts([...contexts, context]);
      }

      setShowContextForm(false);
      setEditingContext(null);
    });
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

  function handleEditContextFromDetail() {
    const context = contexts.find((c) => c.id === selectedContextId);
    if (context) {
      setEditingContext(context);
      setShowContextForm(true);
      setView("contexts");
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
        items: [],
        createdAt: new Date().toISOString(),
      };
      await storage.set(`item_collections:${newColl.id}`, newColl);
      setCollections([...collections, newColl]);
      return newColl.id;
    });
  }

  async function updateCollection(collId, updates, silent = false) {
    const coll = collections.find((c) => c.id === collId);
    if (!coll) return;
    const doSave = async () => {
      const updated = { ...coll, ...updates };
      await storage.set(`item_collections:${coll.id}`, updated);
      setCollections(collections.map((c) => (c.id === collId ? updated : c)));
    };
    if (silent) {
      try { await doSave(); } catch (e) { console.error('Collection save error:', e); }
    } else {
      return withLoading('Saving...', doSave);
    }
  }

  async function deleteCollection(collId) {
    return withLoading('Deleting...', async () => {
      await storage.delete(`item_collections:${collId}`);
      setCollections(collections.filter((c) => c.id !== collId));
    });
  }

  // Filter events to only show those with valid, non-archived intents
  const validEvents = events.filter((e) => {
    if (e.archived) return false;
    const intent = intents.find((i) => i.id === e.intentId);
    return intent && !intent.archived;
  });

  const todayEvents = validEvents
    .filter((e) => {
      const today = getTodayDate();
      // Include all events that are today or in the past (validEvents already excludes archived)
      return e.time <= today;
    })
    .sort((a, b) => a.time.localeCompare(b.time)); // Sort by oldest date first
  const allNonArchivedEvents = validEvents;
  const pinnedContexts = contexts.filter((c) => c.pinned);
  const pinnedCollections = collections.filter((c) => c.pinned);
  const allLiveExecutions = [...activeExecutions, ...pausedExecutions];

  function openExecution(exec) {
    setPreviousView(view);
    setActiveExecution(exec);
    setView("execution-detail");
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
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      setView("execution-detail");
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
        setActiveExecution(execution);
        setActiveExecutions((prev) => [execution, ...prev]);
        setPreviousView(view);
        setView("execution-detail");
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
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      setView("execution-detail");
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
          <a href="/" className="text-lg font-bold text-foreground hover:text-foreground">Alfred v5</a>
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
                { key: "sam", label: "Sam", icon: <Music className="w-4 h-4" /> },
              ].map((item) => (
                <button
                  key={item.key}
                  onClick={() => {
                    if (unsavedChangesRef.current) {
                      const label = unsavedChangesLabelRef.current || "this form";
                      if (!window.confirm(`You have unsaved changes to ${label}. Discard and navigate away?`)) return;
                      unsavedChangesRef.current = false;
                      unsavedChangesLabelRef.current = "";
                    }
                    if (item.key === "sam") setPreviousView(view);
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
              <a href="/" className="text-2xl font-bold text-foreground hover:text-foreground">Alfred v5</a>
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
            <button
              onClick={() => guardedSetView("home")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "home"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Home
            </button>
            <button
              onClick={() => guardedSetView("inbox")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "inbox"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Inbox {inboxItems.length > 0 && `(${inboxItems.length})`}
            </button>
            <button
              onClick={() => guardedSetView("contexts")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "contexts"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Contexts
            </button>
            <button
              onClick={() => guardedSetView("schedule")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "schedule"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Schedule{" "}
              {allNonArchivedEvents.length > 0 &&
                `(${allNonArchivedEvents.length})`}
            </button>
            <button
              onClick={() => guardedSetView("intentions")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "intentions"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Intentions
            </button>
            <button
              onClick={() => guardedSetView("memories")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "memories"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Memories
            </button>
            <button
              onClick={() => guardedSetView("collections")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "collections"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Collections
            </button>
            <button
              onClick={() => {
                if (unsavedChangesRef.current) {
                  const label = unsavedChangesLabelRef.current || "this form";
                  if (!window.confirm(`You have unsaved changes to ${label}. Discard and navigate away?`)) return;
                  unsavedChangesRef.current = false;
                  unsavedChangesLabelRef.current = "";
                }
                setPreviousView(view);
                setView("sam");
              }}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "sam"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-foreground border border-border hover:border-primary"
              }`}
            >
              Sam
            </button>
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
                  {todayEvents.length > 0 ? (
                    todayEvents.map((event) => {
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
                  {pinnedCollections.map((coll) => {
                    const contextName = coll.contextId && contexts
                      ? contexts.find((c) => c.id === coll.contextId)?.name
                      : null;
                    return (
                      <div
                        key={coll.id}
                        onClick={() => {
                          setPreviousView("home");
                          setSelectedCollectionId(coll.id);
                          setView("collection-detail");
                        }}
                        className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <Pin className="w-4 h-4 text-muted-foreground" />
                              <p className="font-medium">{coll.name}</p>
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-sm text-muted-foreground">
                                {coll.items ? coll.items.length : 0} {coll.items && coll.items.length === 1 ? "item" : "items"}
                              </span>
                              {contextName && (
                                <span className="text-xs bg-warning-light text-foreground px-2 py-0.5 rounded">
                                  {contextName}
                                </span>
                              )}
                              {coll.shared && (
                                <span className="text-xs text-primary flex items-center gap-1">
                                  <Share2 className="w-3 h-3" />
                                  Shared
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
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
            {inboxItems.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>Empty inbox.</p>
                <p className="text-sm mt-2">This is success, not failure.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {inboxItems.map((inboxItem) => (
                  <InboxCard
                    key={inboxItem.id}
                    inboxItem={inboxItem}
                    contexts={contexts}
                    items={items}
                    collections={collections}
                    onSave={handleInboxSave}
                    onArchive={archiveInboxItem}
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
                onSave={saveContext}
                onCancel={() => {
                  setShowContextForm(false);
                  setEditingContext(null);
                }}
                onDirtyChange={setUnsavedChanges}
              />
            ) : contexts.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No contexts yet.</p>
                <p className="text-sm mt-2">
                  Add a context to define how things get done.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {[...contexts].sort((a, b) => a.name.localeCompare(b.name)).map((context) => (
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
            onEditContext={handleEditContextFromDetail}
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
            collections={collections}
            onViewCollection={(id) => {
              setPreviousView("context-detail");
              setSelectedCollectionId(id);
              setView("collection-detail");
            }}
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
            collections={collections}
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
            onClone={async (itemId, newName) => {
              const cloned = await deepCloneItem(itemId, newName);
              if (cloned) {
                viewItemDetail(cloned.id, "item-detail");
              }
            }}
            collections={collections}
            onDirtyChange={setUnsavedChanges}
          />
        )}

        {/* Execution Detail View */}
        {view === "execution-detail" && activeExecution && (
          <ExecutionDetailView
            execution={activeExecution}
            intent={intents.find((i) => i.id === activeExecution.intentId)}
            event={events.find((e) => e.id === activeExecution.eventId)}
            items={items}
            contexts={contexts}
            collections={collections}
            onToggleElement={toggleExecutionElement}
            onUpdateElement={updateExecutionElement}
            onToggleCollectionItem={toggleCollectionItem}
            onUpdateCollectionItemQty={updateCollectionItemQty}
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
            {allNonArchivedEvents.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No scheduled events.</p>
                <p className="text-sm mt-2">This is a valid state.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {allNonArchivedEvents.map((event) => {
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
                  collections={collections}
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
                    collections={collections}
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
              const filtered = collections.filter((coll) => {
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
                {filtered.map((coll) => {
                  const contextName = coll.contextId && contexts
                    ? contexts.find((c) => c.id === coll.contextId)?.name
                    : null;
                  return (
                    <div
                      key={coll.id}
                      onClick={() => {
                        setPreviousView("collections");
                        setSelectedCollectionId(coll.id);
                        setView("collection-detail");
                      }}
                      className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            {coll.pinned && <Pin className="w-4 h-4 text-muted-foreground" />}
                            <p className="font-medium">{coll.name}</p>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-sm text-muted-foreground">
                              {coll.items ? coll.items.length : 0} {coll.items && coll.items.length === 1 ? "item" : "items"}
                            </span>
                            {contextName && (
                              <span className="text-xs bg-warning-light text-foreground px-2 py-0.5 rounded">
                                {contextName}
                              </span>
                            )}
                            {coll.shared && (
                              <span className="text-xs text-primary flex items-center gap-1">
                                <Share2 className="w-3 h-3" />
                                Shared
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              );
            })()}
          </div>
        )}

        {/* Collection Detail View */}
        {view === "collection-detail" && (() => {
          const coll = collections.find((c) => c.id === selectedCollectionId);
          if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
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
                    {contexts.map((ctx) => (
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

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-base font-medium">
                      Items ({coll.items ? coll.items.length : 0})
                    </h3>
                    <button
                      onClick={() => setView("collection-add-items")}
                      className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm"
                    >
                      <Plus className="w-4 h-4" />
                      Add Items
                    </button>
                  </div>

                  {coll.items && coll.items.length >= 50 && coll.items.length < 200 && (
                    <p className="text-xs text-warning mb-2">Warning: {coll.items.length} items. Performance may degrade above 200.</p>
                  )}
                  {coll.items && coll.items.length >= 200 && (
                    <p className="text-xs text-destructive mb-2">Maximum 200 items reached.</p>
                  )}

                  {(!coll.items || coll.items.length === 0) ? (
                    <p className="text-muted-foreground text-sm py-4 text-center">No items in this collection</p>
                  ) : (
                    <div className="space-y-2">
                      {coll.items.map((collItem, index) => {
                        const linkedItem = items.find((i) => i.id === collItem.itemId);
                        return (
                          <div
                            key={collItem.itemId || index}
                            className={`flex items-center gap-2 p-3 bg-card border border-border rounded-lg ${collDragIdx === index ? "opacity-50" : ""}`}
                            draggable
                            onDragStart={(e) => { setCollDragIdx(index); e.dataTransfer.effectAllowed = "move"; }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              if (collDragIdx === null || collDragIdx === index) return;
                              const newItems = [...coll.items];
                              const dragged = newItems[collDragIdx];
                              newItems.splice(collDragIdx, 1);
                              newItems.splice(index, 0, dragged);
                              setCollections(collections.map((c) => (c.id === coll.id ? { ...coll, items: newItems } : c)));
                              setCollDragIdx(index);
                            }}
                            onDragEnd={() => {
                              setCollDragIdx(null);
                              updateCollection(coll.id, { items: coll.items }, true);
                            }}
                          >
                            <GripVertical className="w-4 h-4 text-muted-foreground cursor-move flex-shrink-0" title="Drag to reorder" />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate">
                                {linkedItem ? linkedItem.name : collItem.itemId}
                              </p>
                            </div>
                            <input
                              type="text"
                              value={collItem.quantity || ""}
                              onChange={(e) => {
                                const newItems = [...coll.items];
                                newItems[index] = { ...newItems[index], quantity: e.target.value };
                                setCollections(collections.map((c) => (c.id === coll.id ? { ...coll, items: newItems } : c)));
                              }}
                              onBlur={() => updateCollection(coll.id, { items: coll.items }, true)}
                              placeholder="Qty"
                              className="w-20 sm:w-24 px-2 py-2 border border-border rounded text-base"
                            />
                            <button
                              onClick={() => {
                                const newItems = coll.items.filter((_, i) => i !== index);
                                updateCollection(coll.id, { items: newItems });
                              }}
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

                <div className="pt-4 border-t border-border">
                  <button
                    onClick={() => {
                      if (window.confirm("Delete this collection?")) {
                        deleteCollection(coll.id);
                        setSelectedCollectionId(null);
                        setView("collections");
                      }
                    }}
                    className="px-4 py-2.5 min-h-[44px] bg-destructive hover:bg-destructive-hover text-white rounded-lg text-sm"
                  >
                    Delete Collection
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Collection Add Items View */}
        {view === "collection-add-items" && (() => {
          const coll = collections.find((c) => c.id === selectedCollectionId);
          if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
          const existingItemIds = new Set((coll.items || []).map((ci) => ci.itemId));
          const availableItems = items.filter((i) => !i.archived && !existingItemIds.has(i.id) && (!coll.contextId || i.contextId === coll.contextId));

          return (
            <CollectionAddItems
              availableItems={availableItems}
              contexts={contexts}
              collection={coll}
              onAdd={(selectedItems) => {
                const newItems = [...(coll.items || []), ...selectedItems];
                updateCollection(coll.id, { items: newItems });
                setView("collection-detail");
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
                const newCollectionItem = { itemId: newItem.id, quantity: '' };
                const updatedItems = [...(coll.items || []), newCollectionItem];
                updateCollection(coll.id, { items: updatedItems });

                // Close dialog
                setView("collection-detail");
              }}
              onCancel={() => setView("collection-detail")}
              maxItems={200 - (coll.items ? coll.items.length : 0)}
            />
          );
        })()}

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

      {/* Capture bar - fixed at bottom */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border shadow-lg z-20">
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
  );
}

// Helper functions for InboxCard
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
  onArchive,
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
        description: el.description || ''
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
            description: el.description || ''
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
            description: el.description || ''
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
    newElements[index] = { ...newElements[index], [field]: value };
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
        description: el.description || ''
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
                {contexts.map((ctx) => (
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
        <button
          onClick={() => { if (onDirtyChange) onDirtyChange(false); onArchive(inboxItem.id); }}
          className="min-h-[44px] text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
        >
          <Archive className="w-4 h-4" /> Archive
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

function ContextForm({ editing, onSave, onCancel, onDirtyChange }) {
  const [name, setName] = useState(editing?.name || "");
  const [shared, setShared] = useState(editing?.shared || false);
  const [keywords, setKeywords] = useState(editing?.keywords || "");
  const [description, setDescription] = useState(editing?.description || "");
  const [pinned, setPinned] = useState(editing?.pinned || false);

  useEffect(() => {
    if (!onDirtyChange) return;
    const isDirty =
      name !== (editing?.name || "") ||
      shared !== (editing?.shared || false) ||
      keywords !== (editing?.keywords || "") ||
      description !== (editing?.description || "") ||
      pinned !== (editing?.pinned || false);
    onDirtyChange(isDirty, "this context");
  }, [name, shared, keywords, description, pinned]); // eslint-disable-line react-hooks/exhaustive-deps

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

        <div className="flex gap-2 pt-2">
          <button
            onClick={() => {
              if (name.trim()) {
                if (onDirtyChange) onDirtyChange(false);
                onSave(name, shared, keywords, description, pinned);
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
    <div className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow duration-200">
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0" onClick={onClick}>
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
  onEditContext,
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
  onViewCollection,
  onDirtyChange,
}) {
  const [showAddItemForm, setShowAddItemForm] = useState(false);
  const [showAddIntentionForm, setShowAddIntentionForm] = useState(false);
  const [itemsExpanded, setItemsExpanded] = useState(true);
  const [intentionsExpanded, setIntentionsExpanded] = useState(true);

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

      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h2 className="text-xl sm:text-2xl font-bold">{context.name}</h2>
          <button
            onClick={onEditContext}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base shrink-0"
          >
            <Settings className="w-4 h-4" />
            <span className="hidden sm:inline">Edit Context</span>
            <span className="sm:hidden">Edit</span>
          </button>
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
                  <div
                    key={coll.id}
                    onClick={() => onViewCollection && onViewCollection(coll.id)}
                    className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          {coll.pinned && <Pin className="w-4 h-4 text-muted-foreground" />}
                          <p className="font-medium">{coll.name}</p>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-sm text-muted-foreground">
                            {coll.items ? coll.items.length : 0} {coll.items && coll.items.length === 1 ? "item" : "items"}
                          </span>
                          {coll.shared && (
                            <span className="text-xs text-primary flex items-center gap-1">
                              <Share2 className="w-3 h-3" />
                              Shared
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
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
  collections = [],
  onDirtyChange,
}) {
  const [isEditing, setIsEditing] = useState(false);

  if (!intention) return null;

  // Filter events for this intention that aren't archived
  const intentionEvents = events.filter(
    (e) => e.intentId === intention.id && !e.archived,
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
          onDirtyChange={onDirtyChange}
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
          <button
            onClick={() => setIsEditing(true)}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base shrink-0"
          >
            <Settings className="w-4 h-4" />
            <span className="hidden sm:inline">Edit Intention</span>
            <span className="sm:hidden">Edit</span>
          </button>
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
          <div className="flex gap-2">
            {onStartNow && (
              <button
                onClick={() => onStartNow(item.id)}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
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
        const collItems = coll?.items || [];
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
                            {linkedItem ? linkedItem.name : collItem.itemId}
                          </span>
                        </div>
                        <input
                          type="text"
                          value={collItem.quantity || ""}
                          onChange={(e) => {
                            onUpdateCollectionItemQty(execution.collectionId, collItem.itemId, e.target.value);
                          }}
                          placeholder="Qty"
                          className="w-20 sm:w-24 px-2 py-2 border border-border rounded text-base"
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
    newElements[index] = { ...newElements[index], [field]: value };
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
              {contexts.map((ctx) => (
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

          <div className="flex flex-wrap gap-2 pt-2">
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
            <button
              onClick={() => {
                onUpdate(item.id, { archived: true });
                setIsEditing(false);
              }}
              className="px-4 py-2.5 min-h-[44px] bg-destructive hover:bg-destructive-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 ml-auto"
            >
              Archive
            </button>
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
}) {
  const [isEditing, setIsEditing] = useState(initialEditing);
  const [name, setName] = useState(intent.text);
  const [recurrenceConfig, setRecurrenceConfig] = useState(intent.recurrenceConfig || null);
  const [intentEndDate, setIntentEndDate] = useState(intent.endDate || null);
  const [targetStartDate, setTargetStartDate] = useState(intent.targetStartDate || null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [showItemPicker, setShowItemPicker] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState(intent.itemId || "");
  const [selectedCollectionId, setSelectedCollectionId] = useState(intent.collectionId || "");
  const [tags, setTags] = useState(intent.tags || []);
  const [selectedContextId, setSelectedContextId] = useState(intent.contextId || "");
  const [contextSearch, setContextSearch] = useState("");
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [hasActiveExecutions, setHasActiveExecutions] = useState(false);

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

  useEffect(() => {
    if (!intent.id || !onArchive) return;
    async function checkActiveExecutions() {
      const { data } = await supabase
        .from('executions')
        .select('id')
        .eq('intent_id', intent.id)
        .is('closed_at', null);
      setHasActiveExecutions(data && data.length > 0);
    }
    checkActiveExecutions();
  }, [intent.id, onArchive]);

  // Autocomplete search logic
  const filteredContexts =
    contexts && contextSearch.trim()
      ? contexts
          .filter((c) =>
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

  /**
  function handleScheduleLater() {
    if (selectedDate && onSchedule) {
      onSchedule(intent.id, selectedDate);
      setShowDatePicker(false);
      setSelectedDate("");
    }
  }
 */
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

          <div className="flex gap-2 flex-wrap">
            {showScheduling && onSchedule && relatedEvents.length === 0 && (
              <>
                <button
                  onClick={() => handleSave("today")}
                  className="px-3 sm:px-4 py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
                >
                  Do Today
                </button>

                <button
                  onClick={() => setShowDatePicker(!showDatePicker)}
                  className="px-3 sm:px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
                >
                  Schedule Later
                </button>

                {showDatePicker && (
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="px-3 py-2 min-h-[44px] border border-border rounded"
                  />
                )}
              </>
            )}

            <button
              onClick={() =>
                handleSave(showDatePicker && selectedDate ? selectedDate : null)
              }
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
                className={`px-3 sm:px-4 py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base ${hasActiveExecutions ? 'bg-secondary text-muted-foreground cursor-not-allowed' : 'bg-destructive hover:bg-destructive-hover text-white'}`}
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
  const [hasActiveExecution, setHasActiveExecution] = useState(false);

  useEffect(() => {
    if (!event.id) return;
    async function checkActiveExecution() {
      const { data } = await supabase
        .from('executions')
        .select('id')
        .eq('event_id', event.id)
        .is('closed_at', null);
      setHasActiveExecution(data && data.length > 0);
    }
    checkActiveExecution();
  }, [event.id]);

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

          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSave}
              className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Save
            </button>
            <button
              onClick={handleCancelEvent}
              disabled={hasActiveExecution}
              className={`px-4 py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 ${hasActiveExecution ? 'bg-secondary text-muted-foreground cursor-not-allowed' : 'bg-destructive hover:bg-destructive-hover text-white'}`}
              title={hasActiveExecution ? 'Cannot archive: active execution in progress' : 'Archive this event'}
            >
              Archive Event
            </button>
            <button
              onClick={() => {
                setScheduledDate(event.time);
                setEventName(event.text || intent?.text || "");
                setIsEditing(false);
              }}
              className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 bg-card border border-border rounded-lg shadow-sm hover:shadow-md transition-shadow duration-200">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex-1 min-w-0" onClick={() => {
          if (execution && onOpenExecution) {
            onOpenExecution(execution);
          } else {
            setIsEditing(true);
          }
        }}>
          <p className="font-medium text-foreground cursor-pointer hover:text-primary">
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
      </div>
    </div>
  );
}
