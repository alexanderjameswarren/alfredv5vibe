import React, { useState, useEffect } from "react";
import {
  Plus,
  Share2,
  Play,
  Pause,
  Check,
  X,
  Trash2,
  ArrowLeft,
} from "lucide-react";
import { supabase } from "./supabaseClient";

const storage = {
  // Map key prefixes to table names
  tableMap: {
    context: "contexts",
    item: "items",
    intent: "intents",
    event: "events",
    execution: "executions",
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
      const [prefix] = key.split(":");
      const table = this.tableMap[prefix];

      if (!table) {
        console.error("Invalid key prefix:", prefix);
        return false;
      }

      const dbValue = this.toSnakeCase(value);

      const { error } = await supabase.from(table).upsert(dbValue);

      if (error) throw error;
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

export default function Alfred() {
  const [view, setView] = useState("home");
  const [contexts, setContexts] = useState([]);
  const [items, setItems] = useState([]);
  const [intents, setIntents] = useState([]);
  const [events, setEvents] = useState([]);
  const [activeExecution, setActiveExecution] = useState(null);

  const [captureText, setCaptureText] = useState("");
  const [showContextForm, setShowContextForm] = useState(false);
  const [editingContext, setEditingContext] = useState(null);
  const [selectedContextId, setSelectedContextId] = useState(null);
  const [selectedIntentionId, setSelectedIntentionId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [previousView, setPreviousView] = useState("home");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const privateContextKeys = await storage.list("context:");
    const sharedContextKeys = await storage.list("context:", true);

    const allContexts = [];
    const seenContextIds = new Set();

    for (const key of [
      ...new Set([...privateContextKeys, ...sharedContextKeys]),
    ]) {
      const ctx = (await storage.get(key)) || (await storage.get(key, true));
      if (ctx && !seenContextIds.has(ctx.id)) {
        allContexts.push(ctx);
        seenContextIds.add(ctx.id);
      }
    }
    setContexts(allContexts);

    const itemKeys = await storage.list("item:");
    const sharedItemKeys = await storage.list("item:", true);
    const allItems = [];
    const seenItemIds = new Set();

    for (const key of [...new Set([...itemKeys, ...sharedItemKeys])]) {
      const item = (await storage.get(key)) || (await storage.get(key, true));
      if (item && !seenItemIds.has(item.id)) {
        allItems.push(item);
        seenItemIds.add(item.id);
      }
    }
    setItems(allItems);

    const intentKeys = await storage.list("intent:");
    const allIntents = [];
    for (const key of intentKeys) {
      const intent = await storage.get(key);
      if (intent) allIntents.push(intent);
    }
    setIntents(allIntents);

    const eventKeys = await storage.list("event:");
    const sharedEventKeys = await storage.list("event:", true);
    const allEvents = [];
    const seenEventIds = new Set();

    for (const key of [...new Set([...eventKeys, ...sharedEventKeys])]) {
      const event = (await storage.get(key)) || (await storage.get(key, true));
      if (event && !seenEventIds.has(event.id)) {
        allEvents.push(event);
        seenEventIds.add(event.id);
      }
    }
    setEvents(allEvents);

    try {
      const execution = await storage.get("execution:active");
      if (execution) setActiveExecution(execution);
    } catch (e) {
      // No active execution - this is fine
    }
  }

  async function handleCapture() {
    if (!captureText.trim()) return;

    const intent = {
      id: uid(),
      text: captureText,
      createdAt: Date.now(),
      isIntention: false,
      isItem: false,
      archived: false,
      itemId: null,
      contextId: null,
      recurrence: "once",
    };

    await storage.set(`intent:${intent.id}`, intent);
    setIntents([...intents, intent]);
    setCaptureText("");
  }

  async function discardIntent(intentId) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;

    const updated = {
      id: intent.id,
      text: intent.text,
      createdAt: intent.createdAt,
      isIntention: intent.isIntention || false,
      isItem: intent.isItem || false,
      archived: true,
      itemId: intent.itemId || null,
      contextId: intent.contextId || null,
      recurrence: intent.recurrence || "once",
    };

    await storage.set(`intent:${intent.id}`, updated);
    setIntents(intents.map((i) => (i.id === intentId ? updated : i)));
  }

  async function makeIntention(
    intentId,
    contextId = null,
    recurrence = "once",
  ) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;

    const updated = {
      id: intent.id,
      text: intent.text,
      createdAt: intent.createdAt,
      isIntention: true,
      isItem: intent.isItem || false,
      archived: false,
      itemId: intent.itemId || null,
      contextId,
      recurrence,
    };

    await storage.set(`intent:${intent.id}`, updated);
    setIntents(intents.map((i) => (i.id === intentId ? updated : i)));
  }

  async function saveAsItem(
    intentId,
    contextId = null,
    alsoMakeIntention = false,
    recurrence = "once",
  ) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;

    // Create the item
    const item = {
      id: uid(),
      name: intent.text,
      description: "",
      contextId,
      elements: [],
      isCaptureTarget: false,
      createdAt: Date.now(),
    };

    const context = contexts.find((c) => c.id === contextId);
    const isShared = context?.shared || false;
    await storage.set(`item:${item.id}`, item, isShared);
    setItems([...items, item]);

    // Update the intent
    const updated = {
      id: intent.id,
      text: intent.text,
      createdAt: intent.createdAt,
      isIntention: alsoMakeIntention,
      isItem: true,
      archived: false,
      itemId: item.id,
      contextId: alsoMakeIntention ? contextId : null,
      recurrence: alsoMakeIntention ? recurrence : "once",
    };

    await storage.set(`intent:${intent.id}`, updated);
    setIntents(intents.map((i) => (i.id === intentId ? updated : i)));
  }

  async function moveToPlanner(intentId, scheduledDate = "today") {
    let intent = intents.find((i) => i.id === intentId);

    // If intent not found in state, try loading from storage
    // (this handles the case where a new intent was just created and state hasn't updated yet)
    if (!intent) {
      intent = await storage.get(`intent:${intentId}`);
    }

    if (!intent) {
      console.error("Intent not found:", intentId);
      return;
    }

    // Create event for this intent
    const event = {
      id: uid(),
      intentId,
      time: scheduledDate,
      itemIds: intent.itemId ? [intent.itemId] : [],
      contextId: intent.contextId,
      archived: false,
      createdAt: Date.now(),
    };

    await storage.set(`event:${event.id}`, event);
    setEvents([...events, event]);
    if (scheduledDate === "today") {
      setView("schedule");
    }
  }

  async function updateIntent(intentId, updates, scheduledDate) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;

    // Be explicit about what we're storing
    const updated = {
      id: intent.id,
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
      recurrence:
        updates.recurrence !== undefined
          ? updates.recurrence
          : intent.recurrence || "once",
    };

    await storage.set(`intent:${intent.id}`, updated);
    setIntents(intents.map((i) => (i.id === intentId ? updated : i)));

    // If scheduledDate provided, create an event
    if (scheduledDate) {
      await moveToPlanner(intentId, scheduledDate);
    }
  }

  async function updateItem(itemId, updates) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    const updated = {
      id: item.id,
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
      isCaptureTarget:
        updates.isCaptureTarget !== undefined
          ? updates.isCaptureTarget
          : item.isCaptureTarget || false,
      createdAt: item.createdAt,
    };

    const context = contexts.find((c) => c.id === updated.contextId);
    const isShared = context?.shared || false;

    await storage.set(`item:${item.id}`, updated, isShared);
    setItems(items.map((i) => (i.id === itemId ? updated : i)));
  }

  async function updateEvent(eventId, updates) {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;

    const updated = { ...event, ...updates };
    await storage.set(`event:${event.id}`, updated);
    setEvents(events.map((e) => (e.id === eventId ? updated : e)));
  }

  async function activate(eventId) {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;

    if (!event.contextId && !event.itemIds.length) {
      // Event needs either a Context or an Item to activate
      return;
    }

    const execution = {
      id: uid(),
      eventId,
      intentId: event.intentId,
      contextId: event.contextId,
      itemIds: event.itemIds,
      startedAt: Date.now(),
      status: "active",
      progress: [],
    };

    await storage.set("execution:active", execution);
    setActiveExecution(execution);
    setView("home");
  }

  async function closeExecution(outcome) {
    if (!activeExecution) return;

    const closed = {
      ...activeExecution,
      closedAt: Date.now(),
      outcome,
      status: "closed",
    };

    // Archive the execution
    await storage.set(`execution:${closed.id}`, closed);
    await storage.delete("execution:active");

    // Archive the event
    const event = events.find((e) => e.id === activeExecution.eventId);
    if (event) {
      const archivedEvent = { ...event, archived: true };
      await storage.set(`event:${event.id}`, archivedEvent);
      setEvents(events.map((e) => (e.id === event.id ? archivedEvent : e)));
    }

    // If intent is one-time and outcome is 'done', archive it
    const intent = intents.find((i) => i.id === activeExecution.intentId);
    if (intent && intent.recurrence === "once" && outcome === "done") {
      const archivedIntent = { ...intent, archived: true };
      await storage.set(`intent:${intent.id}`, archivedIntent);
      setIntents(intents.map((i) => (i.id === intent.id ? archivedIntent : i)));
    }

    setActiveExecution(null);
    setView("schedule");
  }

  async function saveContext(
    name,
    shared = false,
    keywords = "",
    description = "",
    pinned = false,
  ) {
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
          name,
          shared,
          keywords,
          description,
          pinned,
          createdAt: Date.now(),
        };

    await storage.set(`context:${context.id}`, context, shared);

    if (editingContext) {
      setContexts(contexts.map((c) => (c.id === context.id ? context : c)));
    } else {
      setContexts([...contexts, context]);
    }

    setShowContextForm(false);
    setEditingContext(null);
  }

  function getIntentDisplay(intent) {
    if (intent.itemId) {
      const item = items.find((i) => i.id === intent.itemId);
      return item?.name || intent.text;
    }
    return intent.text;
  }

  function viewContextDetail(contextId) {
    setPreviousView(view);
    setSelectedContextId(contextId);
    setView("context-detail");
  }

  function viewIntentionDetail(intentionId, fromView) {
    setSelectedIntentionId(intentionId);
    setPreviousView(fromView || view);
    setView("intention-detail");
  }

  function handleBackFromIntentionDetail() {
    setSelectedIntentionId(null);
    setView(previousView);
  }

  function viewItemDetail(itemId, fromView) {
    setSelectedItemId(itemId);
    setPreviousView(fromView || view);
    setView("item-detail");
  }

  function handleBackFromItemDetail() {
    setSelectedItemId(null);
    setView(previousView);
  }

  function handleEditContextFromDetail() {
    const context = contexts.find((c) => c.id === selectedContextId);
    if (context) {
      setEditingContext(context);
      setShowContextForm(true);
    }
  }

  async function handleAddItemToContext(
    name,
    elements,
    contextId,
    description = "",
    isCaptureTarget = false,
  ) {
    const newItem = {
      id: uid(),
      name: name || "New Item",
      description: description || "",
      contextId: contextId,
      elements: elements || [],
      isCaptureTarget: isCaptureTarget || false,
      createdAt: Date.now(),
    };

    const context = contexts.find((c) => c.id === contextId);
    const isShared = context?.shared || false;

    await storage.set(`item:${newItem.id}`, newItem, isShared);
    setItems([...items, newItem]);
  }

  async function handleAddIntentionToContext(
    text,
    contextId,
    recurrence = "once",
  ) {
    const newIntent = {
      id: uid(),
      text: text || "New Intention",
      createdAt: Date.now(),
      isIntention: true,
      isItem: false,
      archived: false,
      itemId: null,
      contextId: contextId,
      recurrence: recurrence,
    };

    await storage.set(`intent:${newIntent.id}`, newIntent);
    setIntents([...intents, newIntent]);
    return newIntent.id; // Return the ID so it can be scheduled
  }

  // Inbox: Not yet triaged (not intention, not item, not archived)
  const inboxIntents = intents.filter(
    (i) => !i.isIntention && !i.isItem && !i.archived,
  );

  // Filter events to only show those with valid, non-archived intents
  const validEvents = events.filter((e) => {
    if (e.archived) return false;
    const intent = intents.find((i) => i.id === e.intentId);
    return intent && !intent.archived;
  });

  const todayEvents = validEvents.filter((e) => e.time === "today");
  const allNonArchivedEvents = validEvents;
  const pinnedContexts = contexts.filter((c) => c.pinned);

  // Intentions: Marked as intentions, not archived, no active event
  const intentionsWithoutActiveEvent = intents.filter((i) => {
    if (!i.isIntention || i.archived) return false;
    const hasActiveEvent = validEvents.some((e) => e.intentId === i.id);
    return !hasActiveEvent;
  });

  const memoriesWithoutContext = items.filter((i) => !i.contextId);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-gray-900">Alfred v5 (vibe)</h1>
          <p className="text-sm text-gray-500 mt-1">
            Capture decisions. Hold intent. Execute with focus.
          </p>
        </div>
      </div>

      {/* Navigation */}
      <div className="max-w-4xl mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={() => setView("home")}
              className={`px-4 py-2 rounded ${
                view === "home"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-300"
              }`}
            >
              Home
            </button>
            <button
              onClick={() => setView("inbox")}
              className={`px-4 py-2 rounded ${
                view === "inbox"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-300"
              }`}
            >
              Inbox {inboxIntents.length > 0 && `(${inboxIntents.length})`}
            </button>
            <button
              onClick={() => setView("contexts")}
              className={`px-4 py-2 rounded ${
                view === "contexts"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-300"
              }`}
            >
              Contexts
            </button>
            <button
              onClick={() => setView("schedule")}
              className={`px-4 py-2 rounded ${
                view === "schedule"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-300"
              }`}
            >
              Schedule{" "}
              {allNonArchivedEvents.length > 0 &&
                `(${allNonArchivedEvents.length})`}
            </button>
            <button
              onClick={() => setView("intentions")}
              className={`px-4 py-2 rounded ${
                view === "intentions"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-300"
              }`}
            >
              Intentions
            </button>
            <button
              onClick={() => setView("memories")}
              className={`px-4 py-2 rounded ${
                view === "memories"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-300"
              }`}
            >
              Memories
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setView("settings")}
              className="p-2 text-gray-600 hover:text-gray-900"
              title="Settings"
            >
              <span className="text-xl">⚙️</span>
            </button>
            <button
              onClick={() => setView("recycle")}
              className="p-2 text-gray-600 hover:text-gray-900"
              title="Recycle Bin"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-4xl mx-auto px-4 py-6 pb-32">
        {/* Home View */}
        {view === "home" && (
          <div>
            <h2 className="text-xl font-semibold mb-4">Home</h2>

            {/* Active Execution Section */}
            {activeExecution && (
              <div className="mb-8">
                <h3 className="text-lg font-semibold mb-3">Active</h3>
                <div className="p-6 bg-green-50 border-2 border-green-500 rounded">
                  <div className="mb-6">
                    <p className="text-lg font-medium mb-2">
                      {(() => {
                        const intent = intents.find(
                          (i) => i.id === activeExecution.intentId,
                        );
                        return intent ? getIntentDisplay(intent) : "Execution";
                      })()}
                    </p>
                    {activeExecution.contextId && (
                      <p className="text-sm text-gray-600">
                        {
                          contexts.find(
                            (c) => c.id === activeExecution.contextId,
                          )?.name
                        }
                      </p>
                    )}
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={() => closeExecution("done")}
                      className="flex items-center gap-2 px-6 py-3 bg-green-600 text-white rounded hover:bg-green-700"
                    >
                      <Check className="w-5 h-5" />
                      Done
                    </button>
                    <button
                      onClick={() => closeExecution("paused")}
                      className="flex items-center gap-2 px-6 py-3 bg-yellow-600 text-white rounded hover:bg-yellow-700"
                    >
                      <Pause className="w-5 h-5" />
                      Pause
                    </button>
                    <button
                      onClick={() => closeExecution("cancelled")}
                      className="flex items-center gap-2 px-6 py-3 bg-red-600 text-white rounded hover:bg-red-700"
                    >
                      <X className="w-5 h-5" />
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Today's Events Section */}
            <div className="mb-8">
              <h3 className="text-lg font-semibold mb-3">
                Events Today ({todayEvents.length})
              </h3>
              {todayEvents.length === 0 ? (
                <p className="text-gray-500 text-sm">
                  No events scheduled for today.
                </p>
              ) : (
                <div className="space-y-2">
                  {todayEvents.map((event) => {
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
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {/* Pinned Contexts Section */}
            <div>
              <h3 className="text-lg font-semibold mb-3">Pinned Contexts</h3>
              {pinnedContexts.length === 0 ? (
                <p className="text-gray-500 text-sm">
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
            <h2 className="text-xl font-semibold mb-4">Inbox</h2>
            {inboxIntents.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <p>Empty inbox.</p>
                <p className="text-sm mt-2">This is success, not failure.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {inboxIntents.map((intent) => (
                  <InboxCard
                    key={intent.id}
                    intent={intent}
                    contexts={contexts}
                    onDiscard={discardIntent}
                    onMakeIntention={makeIntention}
                    onSaveAsItem={saveAsItem}
                    onUpdate={updateIntent}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Contexts View */}
        {view === "contexts" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">Contexts</h2>
              <button
                onClick={() => {
                  setEditingContext(null);
                  setShowContextForm(true);
                }}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
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
              />
            ) : contexts.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <p>No contexts yet.</p>
                <p className="text-sm mt-2">
                  Add a context to define how things get done.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {contexts.map((context) => (
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
            items={items.filter((i) => i.contextId === selectedContextId)}
            intents={intents.filter((i) => i.contextId === selectedContextId)}
            contexts={contexts}
            onBack={() => {
              setSelectedContextId(null);
              setView(previousView);
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
          />
        )}

        {/* Schedule View */}
        {view === "schedule" && (
          <div>
            <h2 className="text-xl font-semibold mb-4">Schedule</h2>
            {allNonArchivedEvents.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
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
            <h2 className="text-xl font-semibold mb-4">Intentions</h2>
            {intentionsWithoutActiveEvent.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <p>No available intentions.</p>
                <p className="text-sm mt-2">
                  All intentions are currently scheduled.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {intentionsWithoutActiveEvent.map((intent) => (
                  <IntentionCard
                    key={intent.id}
                    intent={intent}
                    contexts={contexts}
                    items={items}
                    onUpdate={updateIntent}
                    onSchedule={moveToPlanner}
                    getIntentDisplay={getIntentDisplay}
                    showScheduling={true}
                    onViewDetail={(id) => viewIntentionDetail(id, "intentions")}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Memories View */}
        {view === "memories" && (
          <div>
            <h2 className="text-xl font-semibold mb-4">Memories</h2>
            {memoriesWithoutContext.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <p>No memories without context.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {memoriesWithoutContext.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    contexts={contexts}
                    onUpdate={updateItem}
                    onViewDetail={(id) => viewItemDetail(id, "memories")}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Settings View */}
        {view === "settings" && (
          <div>
            <h2 className="text-xl font-semibold mb-4">Settings</h2>
            <div className="p-6 bg-white border border-gray-200 rounded">
              <p className="text-gray-500">Settings coming soon...</p>
            </div>
          </div>
        )}

        {/* Recycle Bin View */}
        {view === "recycle" && (
          <div>
            <h2 className="text-xl font-semibold mb-4">Recycle Bin</h2>
            <div className="p-6 bg-white border border-gray-200 rounded">
              <p className="text-gray-500">Recycle bin coming soon...</p>
            </div>
          </div>
        )}
      </div>

      {/* Capture bar - fixed at bottom */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={captureText}
              onChange={(e) => setCaptureText(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleCapture()}
              placeholder="Capture anything..."
              className="flex-1 px-4 py-3 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleCapture}
              className="px-6 py-3 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Capture
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InboxCard({
  intent,
  contexts,
  onDiscard,
  onMakeIntention,
  onSaveAsItem,
  onUpdate,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState(intent.text);
  const [expanded, setExpanded] = useState(false);

  // Triage state
  const [showTriageOptions, setShowTriageOptions] = useState(false);
  const [selectedContext, setSelectedContext] = useState("");
  const [selectedRecurrence, setSelectedRecurrence] = useState("once");

  const textLines = intent.text.split("\n");
  const needsTruncation = textLines.length > 5;
  const displayText =
    expanded || !needsTruncation
      ? intent.text
      : textLines.slice(0, 5).join("\n");

  function saveEdit() {
    if (editedText !== intent.text) {
      onUpdate(intent.id, { text: editedText });
    }
  }

  function handleDiscard() {
    saveEdit();
    onDiscard(intent.id);
  }

  function handleMakeIntention() {
    saveEdit();
    onMakeIntention(intent.id, selectedContext || null, selectedRecurrence);
    setShowTriageOptions(false);
    setSelectedContext("");
  }

  function handleSaveAsItem() {
    saveEdit();
    onSaveAsItem(intent.id, selectedContext || null, false);
    setShowTriageOptions(false);
    setSelectedContext("");
  }

  function handleBoth() {
    saveEdit();
    onSaveAsItem(intent.id, selectedContext || null, true, selectedRecurrence);
    setShowTriageOptions(false);
    setSelectedContext("");
  }

  return (
    <div className="p-4 bg-white border border-gray-200 rounded">
      <div className="flex items-start gap-2 mb-3">
        {isEditing ? (
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            onBlur={saveEdit}
            className="flex-1 px-3 py-2 border border-gray-300 rounded min-h-[100px]"
            autoFocus
          />
        ) : (
          <p className="flex-1 whitespace-pre-wrap">{displayText}</p>
        )}
        <button
          onClick={() => setIsEditing(!isEditing)}
          className="text-gray-500 hover:text-gray-700"
          title="Edit"
        >
          ✏️
        </button>
      </div>

      {needsTruncation && !expanded && !isEditing && (
        <button
          onClick={() => setExpanded(true)}
          className="text-sm text-blue-600 hover:text-blue-700 mb-3"
        >
          Show more
        </button>
      )}
      {needsTruncation && expanded && !isEditing && (
        <button
          onClick={() => setExpanded(false)}
          className="text-sm text-blue-600 hover:text-blue-700 mb-3"
        >
          Show less
        </button>
      )}

      {!showTriageOptions ? (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handleDiscard}
            className="px-4 py-2 bg-gray-400 text-white rounded text-sm hover:bg-gray-500"
          >
            Discard
          </button>
          <button
            onClick={() => setShowTriageOptions(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            Triage →
          </button>
        </div>
      ) : (
        <div className="space-y-3 border-t pt-3">
          <div className="flex gap-2 items-center flex-wrap">
            <select
              value={selectedContext}
              onChange={(e) => setSelectedContext(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded text-sm"
            >
              <option value="">No Context</option>
              {contexts.map((ctx) => (
                <option key={ctx.id} value={ctx.id}>
                  {ctx.name}
                </option>
              ))}
            </select>

            <select
              value={selectedRecurrence}
              onChange={(e) => setSelectedRecurrence(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded text-sm"
            >
              <option value="once">One time</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handleMakeIntention}
              className="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700"
            >
              Make Intention
            </button>
            <button
              onClick={handleSaveAsItem}
              className="px-4 py-2 bg-purple-600 text-white rounded text-sm hover:bg-purple-700"
            >
              Save as Item
            </button>
            <button
              onClick={handleBoth}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
            >
              Both
            </button>
            <button
              onClick={() => {
                setShowTriageOptions(false);
                setSelectedContext("");
                setSelectedRecurrence("once");
              }}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ContextForm({ editing, onSave, onCancel }) {
  const [name, setName] = useState(editing?.name || "");
  const [shared, setShared] = useState(editing?.shared || false);
  const [keywords, setKeywords] = useState(editing?.keywords || "");
  const [description, setDescription] = useState(editing?.description || "");
  const [pinned, setPinned] = useState(editing?.pinned || false);

  return (
    <div className="mb-6 p-6 bg-white border-2 border-blue-500 rounded-lg shadow-lg">
      <h3 className="font-semibold text-lg mb-4">
        {editing ? "Edit Context" : "New Context"}
      </h3>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Context name"
            className="w-full px-3 py-2 border border-gray-300 rounded"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Keywords
          </label>
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="Keywords (comma separated)"
            className="w-full px-3 py-2 border border-gray-300 rounded"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded"
          />
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
            className="rounded"
          />
          <span className="text-sm">Share this context</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
            className="rounded"
          />
          <span className="text-sm">Pin to home</span>
        </label>

        <div className="flex gap-2 pt-2">
          <button
            onClick={() =>
              name.trim() && onSave(name, shared, keywords, description, pinned)
            }
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Save
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
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
    <div className="p-4 bg-white border border-gray-200 rounded cursor-pointer hover:border-blue-500 transition-colors">
      <div className="flex items-center justify-between">
        <div className="flex-1" onClick={onClick}>
          <div className="flex items-center gap-2">
            {context.pinned && <span className="text-gray-400">📌</span>}
            <h3 className="font-semibold">{context.name}</h3>
          </div>
          {context.description && (
            <p className="text-sm text-gray-500 mt-1">{context.description}</p>
          )}
          <div className="flex items-center gap-2 mt-1">
            {context.shared && (
              <span className="text-xs text-blue-600 flex items-center gap-1">
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
            className="text-gray-500 hover:text-gray-700"
          >
            <span className="text-lg">⚙️</span>
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
}) {
  const [showAddItemForm, setShowAddItemForm] = useState(false);
  const [showAddIntentionForm, setShowAddIntentionForm] = useState(false);

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
    recurrence: "once",
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
      updates.recurrence,
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
        className="flex items-center gap-2 mb-4 text-blue-600 hover:text-blue-700"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="mb-6">
        <div className="flex items-start justify-between mb-2">
          <h2 className="text-2xl font-bold">{context.name}</h2>
          <button
            onClick={onEditContext}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            <span>⚙️</span>
            Edit Context
          </button>
        </div>
        {context.description && (
          <p className="text-gray-600">{context.description}</p>
        )}
        {context.keywords && (
          <p className="text-sm text-gray-500 mt-1">
            Keywords: {context.keywords}
          </p>
        )}
      </div>

      <div className="space-y-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold">Items ({items.length})</h3>
            <button
              onClick={() => setShowAddItemForm(true)}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
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
              />
            </div>
          )}

          {items.length === 0 ? (
            <p className="text-gray-500 text-sm">No items in this context</p>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  contexts={contexts}
                  onUpdate={onUpdateItem}
                  onViewDetail={onViewItemDetail}
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold">
              Intentions ({intents.length})
            </h3>
            <button
              onClick={() => setShowAddIntentionForm(true)}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
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
                onUpdate={handleSaveNewIntention}
                onSchedule={onSchedule}
                getIntentDisplay={getIntentDisplay}
                showScheduling={true}
                isEditing={true}
                onCancel={() => setShowAddIntentionForm(false)}
              />
            </div>
          )}

          {intents.length === 0 ? (
            <p className="text-gray-500 text-sm">
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
                  getIntentDisplay={getIntentDisplay}
                  onUpdate={onUpdateIntent}
                  onSchedule={onSchedule}
                  showScheduling={true}
                  onViewDetail={onViewIntentionDetail}
                />
              ))}
            </div>
          )}
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
          className="flex items-center gap-2 mb-4 text-blue-600 hover:text-blue-700"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <IntentionCard
          intent={intention}
          contexts={contexts}
          items={items}
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
        />
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-4 text-blue-600 hover:text-blue-700"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="mb-6">
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1">
            <h2 className="text-2xl font-bold">{intention.text}</h2>
            {contextName && (
              <span className="inline-block mt-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                {contextName}
              </span>
            )}
          </div>
          <button
            onClick={() => setIsEditing(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            <span>⚙️</span>
            Edit Intention
          </button>
        </div>
        <p className="text-sm text-gray-600 capitalize">
          Recurrence: {intention.recurrence || "once"}
        </p>
      </div>

      {/* Linked Item Section */}
      {intention.itemId && items && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3">Linked Item</h3>
          {(() => {
            const linkedItem = items.find((i) => i.id === intention.itemId);
            return linkedItem ? (
              <ItemCard
                item={linkedItem}
                contexts={contexts}
                onUpdate={onUpdateItem}
                onViewDetail={onViewItemDetail}
              />
            ) : (
              <p className="text-gray-500 text-sm">Item not found</p>
            );
          })()}
        </div>
      )}

      <div>
        <h3 className="text-lg font-semibold mb-3">
          Scheduled Events ({intentionEvents.length})
        </h3>
        {intentionEvents.length === 0 ? (
          <p className="text-gray-500 text-sm">
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
}) {
  const [isEditing, setIsEditing] = useState(false);

  if (!item) return null;

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
          className="flex items-center gap-2 mb-4 text-blue-600 hover:text-blue-700"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <ItemCard
          item={item}
          contexts={contexts}
          onUpdate={(id, updates) => {
            onUpdateItem(id, updates);
            setIsEditing(false);
          }}
          isEditing={true}
          onCancel={() => setIsEditing(false)}
        />
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-4 text-blue-600 hover:text-blue-700"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="mb-6">
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1">
            <h2 className="text-2xl font-bold">{item.name}</h2>
            {contextName && (
              <span className="inline-block mt-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                {contextName}
              </span>
            )}
          </div>
          <button
            onClick={() => setIsEditing(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            <span>⚙️</span>
            Edit Item
          </button>
        </div>
      </div>

      {/* Item Description */}
      {item.description && (
        <div className="mb-6">
          <p className="text-gray-600">{item.description}</p>
        </div>
      )}

      {/* Capture Target Badge */}
      {item.isCaptureTarget && (
        <div className="mb-4">
          <span className="inline-block text-xs bg-green-100 text-green-700 px-2 py-1 rounded">
            📍 Capture Target
          </span>
        </div>
      )}

      {/* Elements Section */}
      {(item.elements || item.components) &&
        (item.elements || item.components).length > 0 && (
          <div className="mb-6">
            <h3 className="text-lg font-semibold mb-3">Elements</h3>
            <div className="space-y-2">
              {(item.elements || item.components).map((element, index) => {
                const el =
                  typeof element === "string"
                    ? { name: element, displayType: "step" }
                    : element;

                if (el.displayType === "header") {
                  return (
                    <div key={index} className="mt-4 mb-2">
                      <h4 className="text-md font-bold text-gray-800">
                        {el.name}
                      </h4>
                      {el.description && (
                        <p className="text-sm text-gray-600 mt-1">
                          {el.description}
                        </p>
                      )}
                    </div>
                  );
                }

                if (el.displayType === "bullet") {
                  return (
                    <div key={index} className="ml-4 flex items-start gap-2">
                      <span className="text-gray-600 mt-1">•</span>
                      <div className="flex-1">
                        <span className="text-gray-700">
                          {el.quantity && (
                            <span className="font-medium">{el.quantity} </span>
                          )}
                          {el.name}
                        </span>
                        {el.description && (
                          <p className="text-sm text-gray-600 mt-1">
                            {el.description}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                }

                // Default: step
                return (
                  <div key={index} className="flex items-start gap-3">
                    <span className="text-gray-600 font-medium min-w-[24px]">
                      {index + 1}.
                    </span>
                    <div className="flex-1">
                      <span className="text-gray-700">
                        {el.quantity && (
                          <span className="font-medium">{el.quantity} </span>
                        )}
                        {el.name}
                      </span>
                      {el.description && (
                        <p className="text-sm text-gray-600 mt-1">
                          {el.description}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      {/* Related Intentions Section */}
      <div>
        <h3 className="text-lg font-semibold mb-3">
          Related Intentions ({itemIntentions.length})
        </h3>
        {itemIntentions.length === 0 ? (
          <p className="text-gray-500 text-sm">
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
                onUpdate={onUpdateIntent}
                onSchedule={onSchedule}
                getIntentDisplay={getIntentDisplay}
                showScheduling={true}
              />
            ))}
          </div>
        )}
      </div>
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
            displayType: el.displayType || "step",
            quantity: el.quantity || "",
            description: el.description || "",
          },
    ),
  );
  const [isCaptureTarget, setIsCaptureTarget] = useState(
    item.isCaptureTarget || false,
  );
  const [draggedIndex, setDraggedIndex] = useState(null);

  function handleSave() {
    if (!name.trim()) {
      // Name is required - just return without saving
      return;
    }
    const finalContextId = contextId === "" ? null : contextId;
    onUpdate(item.id, {
      name,
      description,
      contextId: finalContextId,
      elements,
      isCaptureTarget,
    });
    if (!onCancel) {
      // Only control isEditing state if we're not in add mode
      setIsEditing(false);
    }
  }

  function handleCancel() {
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
      setIsCaptureTarget(item.isCaptureTarget || false);
      setIsEditing(false);
    }
  }

  function addElement() {
    setElements([
      ...elements,
      { name: "", displayType: "step", quantity: "", description: "" },
    ]);
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
  }

  function updateElement(index, field, value) {
    const newElements = [...elements];
    newElements[index] = { ...newElements[index], [field]: value };
    setElements(newElements);
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
      <div className="p-4 bg-white border-2 border-blue-500 rounded">
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description for this item"
              className="w-full px-3 py-2 border border-gray-300 rounded"
              rows="2"
            />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isCaptureTarget}
              onChange={(e) => setIsCaptureTarget(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm">
              Use as capture target (available in quick capture)
            </span>
          </label>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Context
            </label>
            <select
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded"
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
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Elements
            </label>
            <div className="space-y-2">
              {elements.map((element, index) => (
                <div key={index}>
                  <div
                    className={`space-y-2 p-3 border border-gray-200 rounded ${draggedIndex === index ? "opacity-50" : ""}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDragEnd={handleDragEnd}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="text-sm text-gray-500 cursor-move"
                        title="Drag to reorder"
                      >
                        ☰
                      </span>
                      <input
                        type="text"
                        value={element.name}
                        onChange={(e) =>
                          updateElement(index, "name", e.target.value)
                        }
                        onKeyPress={(e) => handleKeyPress(e, index)}
                        placeholder="Element name"
                        className="element-input flex-1 px-3 py-2 border border-gray-300 rounded"
                      />
                      <select
                        value={element.displayType || "step"}
                        onChange={(e) =>
                          updateElement(index, "displayType", e.target.value)
                        }
                        className="px-2 py-2 border border-gray-300 rounded text-sm"
                      >
                        <option value="header">Header</option>
                        <option value="bullet">Bullet</option>
                        <option value="step">Step</option>
                      </select>
                      <button
                        onClick={() => deleteElement(index)}
                        className="text-red-600 hover:text-red-800"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>

                    <input
                      type="text"
                      value={element.quantity || ""}
                      onChange={(e) =>
                        updateElement(index, "quantity", e.target.value)
                      }
                      placeholder="Quantity (optional)"
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                    />

                    <textarea
                      value={element.description || ""}
                      onChange={(e) =>
                        updateElement(index, "description", e.target.value)
                      }
                      placeholder="Description (optional)"
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                      rows="2"
                    />
                  </div>

                  {index < elements.length - 1 && (
                    <div className="flex justify-center -my-1">
                      <button
                        onClick={() => insertElementAbove(index + 1)}
                        className="text-green-600 hover:text-green-800 text-lg"
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
                className="w-full px-3 py-2 border-2 border-dashed border-gray-300 rounded text-gray-600 hover:border-blue-500 hover:text-blue-600"
              >
                + Add Element
              </button>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Save
            </button>
            <button
              onClick={handleCancel}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="p-4 bg-white border border-gray-200 rounded cursor-pointer hover:border-blue-500"
      onClick={() => {
        if (onViewDetail) {
          onViewDetail(item.id);
        } else {
          setIsEditing(true);
        }
      }}
    >
      <p className="font-medium mb-2">{item.name}</p>
      {(item.elements || item.components) &&
        (item.elements || item.components).length > 0 && (
          <ol className="text-sm text-gray-600 list-decimal list-inside space-y-1">
            {(item.elements || item.components).map((element, index) => {
              const el =
                typeof element === "string" ? { name: element } : element;
              return <li key={index}>{el.name}</li>;
            })}
          </ol>
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
  getIntentDisplay,
  showScheduling = false,
  isEditing: initialEditing = false,
  onCancel,
  onViewDetail,
}) {
  const [isEditing, setIsEditing] = useState(initialEditing);
  const [name, setName] = useState(intent.text);
  const [recurrence, setRecurrence] = useState(intent.recurrence || "once");
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [showItemPicker, setShowItemPicker] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState(intent.itemId || "");

  // Autocomplete search logic
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
    if (onUpdate) {
      const updates = showScheduling
        ? { text: name, recurrence, itemId: selectedItemId || null }
        : { text: name, itemId: selectedItemId || null };
      onUpdate(intent.id, updates, scheduledDate);
    }
    if (!onCancel) {
      // Only control isEditing state if we're not in add mode
      setIsEditing(false);
    }
  }

  function handleCancel() {
    if (onCancel) {
      onCancel();
    } else {
      setName(intent.text);
      setRecurrence(intent.recurrence || "once");
      setSelectedItemId(intent.itemId || "");
      setItemSearch("");
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

  if (isEditing) {
    return (
      <div className="p-4 bg-white border-2 border-blue-500 rounded">
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
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
                className="w-full px-3 py-2 border border-gray-300 rounded"
              />
              {selectedItemId && !itemSearch && items && (
                <div className="mt-1 text-sm text-gray-600">
                  Selected: {items.find((i) => i.id === selectedItemId)?.name}
                  <button
                    onClick={() => {
                      setSelectedItemId("");
                      setItemSearch("");
                    }}
                    className="ml-2 text-red-600 hover:text-red-800"
                  >
                    ✕
                  </button>
                </div>
              )}
              {showItemPicker && itemSearch && filteredItems.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded shadow-lg max-h-60 overflow-y-auto">
                  {filteredItems.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        setSelectedItemId(item.id);
                        setItemSearch(item.name);
                        setShowItemPicker(false);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b border-gray-200 last:border-b-0"
                    >
                      <div className="font-medium">{item.name}</div>
                      {item.contextId && contexts && (
                        <div className="text-xs text-gray-500">
                          {contexts.find((c) => c.id === item.contextId)?.name}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {showScheduling && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Recurrence
              </label>
              <select
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded"
              >
                <option value="once">One time</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            {showScheduling && onSchedule && (
              <>
                <button
                  onClick={() => handleSave("today")}
                  className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
                >
                  Do Today
                </button>

                <button
                  onClick={() => setShowDatePicker(!showDatePicker)}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  Schedule Later
                </button>

                {showDatePicker && (
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded"
                  />
                )}
              </>
            )}

            <button
              onClick={() =>
                handleSave(showDatePicker && selectedDate ? selectedDate : null)
              }
              className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
            >
              Save Changes
            </button>

            <button
              onClick={handleCancel}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="p-4 bg-white border border-gray-200 rounded cursor-pointer hover:border-blue-500"
      onClick={() => {
        if (onViewDetail) {
          onViewDetail(intent.id);
        } else {
          setIsEditing(true);
        }
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <p className="font-medium">{getIntentDisplay(intent)}</p>
          <div className="flex items-center gap-2 mt-1">
            {showScheduling && (
              <span className="text-sm text-gray-500 capitalize">
                {intent.recurrence || "once"}
              </span>
            )}
            {contextName && (
              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                {contextName}
              </span>
            )}
          </div>
        </div>
        {showScheduling && onSchedule && (
          <div className="flex gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSchedule(intent.id, "today");
              }}
              className="px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700"
            >
              Do Today
            </button>
          </div>
        )}
      </div>
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
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(event.time);
  const [eventName, setEventName] = useState(intent?.text || "");

  function handleSave() {
    // Update both event date and intent name
    onUpdate(event.id, { time: scheduledDate });
    if (intent && eventName !== intent.text) {
      // We need to update the intent too, but we don't have that function here
      // For now, just update the event
    }
    setIsEditing(false);
  }

  async function handleCancelEvent() {
    // Archive the event
    onUpdate(event.id, { archived: true });
    setIsEditing(false);
  }

  if (isEditing) {
    return (
      <div className="p-4 bg-white border-2 border-blue-500 rounded">
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Event Name
            </label>
            <input
              type="text"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Scheduled Date
            </label>
            <input
              type="date"
              value={
                scheduledDate === "today"
                  ? new Date().toISOString().split("T")[0]
                  : scheduledDate
              }
              onChange={(e) => setScheduledDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Save
            </button>
            <button
              onClick={handleCancelEvent}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Cancel Event
            </button>
            <button
              onClick={() => {
                setScheduledDate(event.time);
                setEventName(intent?.text || "");
                setIsEditing(false);
              }}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 bg-white border border-gray-200 rounded">
      <div className="flex items-center justify-between">
        <div className="flex-1" onClick={() => setIsEditing(true)}>
          <p className="font-medium cursor-pointer hover:text-blue-600">
            {getIntentDisplay(intent)}
          </p>
          <p className="text-sm text-gray-500">{event.time}</p>
          {event.contextId && (
            <p className="text-sm text-gray-500">
              {contexts.find((c) => c.id === event.contextId)?.name}
            </p>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onActivate(event.id);
          }}
          className="flex items-center gap-2 px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700"
        >
          <Play className="w-3 h-3" />
          Start
        </button>
      </div>
    </div>
  );
}
