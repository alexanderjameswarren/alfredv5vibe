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
    inbox: "inbox",
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

function getTodayDate() {
  return new Date().toISOString().split("T")[0];
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

  const captureRef = useRef(null);
  const [executionTab, setExecutionTab] = useState("active");
  const [captureText, setCaptureText] = useState("");
  const [showContextForm, setShowContextForm] = useState(false);
  const [editingContext, setEditingContext] = useState(null);
  const [selectedContextId, setSelectedContextId] = useState(null);
  const [selectedIntentionId, setSelectedIntentionId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [previousView, setPreviousView] = useState("home");
  const [showAddIntentionForm, setShowAddIntentionForm] = useState(false);

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

    const inboxKeys = await storage.list("inbox:");
    const inboxData = await Promise.all(
      inboxKeys.map((key) => storage.get(key))
    );
    setInboxItems(
      inboxData
        .filter((item) => item && !item.archived)
        .sort((a, b) => b.createdAt - a.createdAt)
    );

    try {
      const { data } = await supabase
        .from("executions")
        .select("*")
        .eq("status", "active")
        .order("started_at", { ascending: false });
      if (data && data.length > 0) {
        setActiveExecutions(data.map((d) => storage.toCamelCase(d)));
      } else {
        setActiveExecutions([]);
      }
    } catch (e) {
      // No active executions - this is fine
    }

    try {
      const { data: pausedData } = await supabase
        .from("executions")
        .select("*")
        .eq("status", "paused")
        .order("started_at", { ascending: false });
      if (pausedData && pausedData.length > 0) {
        setPausedExecutions(pausedData.map((d) => storage.toCamelCase(d)));
      } else {
        setPausedExecutions([]);
      }
    } catch (e) {
      // No paused executions - this is fine
    }
  }

  async function handleCapture() {
    if (!captureText.trim()) return;

    const inboxItem = {
      id: uid(),
      capturedText: captureText.trim(),
      createdAt: Date.now(),
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
    };

    await storage.set(`inbox:${inboxItem.id}`, inboxItem);
    setInboxItems([inboxItem, ...inboxItems]);
    setCaptureText("");
    if (captureRef.current) {
      captureRef.current.style.height = "auto";
    }
    setView("inbox");
  }

  async function archiveInboxItem(inboxItemId) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    const updated = { ...inboxItem, archived: true, triagedAt: Date.now() };
    await storage.set(`inbox:${inboxItem.id}`, updated);
    setInboxItems(inboxItems.filter((i) => i.id !== inboxItemId));
  }

  async function handleInboxSave(inboxItemId, triageData) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;

    let createdItemId = null;

    // Create item if checked
    if (triageData.createItem && triageData.itemData) {
      const newItem = {
        id: uid(),
        name: triageData.itemData.name,
        description: triageData.itemData.description || "",
        contextId: triageData.itemData.contextId,
        elements: triageData.itemData.elements || [],
        isCaptureTarget: false,
        createdAt: Date.now(),
      };

      const context = contexts.find((c) => c.id === newItem.contextId);
      const isShared = context?.shared || false;
      await storage.set(`item:${newItem.id}`, newItem, isShared);
      setItems((prev) => [...prev, newItem]);
      createdItemId = newItem.id;
    }

    // Create intention if checked
    if (triageData.createIntention && triageData.intentionData) {
      const intentionItemId =
        triageData.intentionData.itemId || createdItemId;
      const newIntent = {
        id: uid(),
        text: triageData.intentionData.text,
        createdAt: Date.now(),
        isIntention: true,
        isItem: !!intentionItemId,
        archived: false,
        itemId: intentionItemId,
        contextId: triageData.intentionData.contextId,
        recurrence: triageData.intentionData.recurrence || "once",
      };
      await storage.set(`intent:${newIntent.id}`, newIntent);
      setIntents((prev) => [...prev, newIntent]);
    }

    // Archive inbox item
    const updated = { ...inboxItem, archived: true, triagedAt: Date.now() };
    await storage.set(`inbox:${inboxItem.id}`, updated);
    setInboxItems((prev) => prev.filter((i) => i.id !== inboxItemId));
  }

  async function moveToPlanner(intentId, scheduledDate = "today") {
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
      intentId,
      time: eventDate,
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

    const itemElements = [];
    if (event.itemIds && event.itemIds.length > 0) {
      for (const itemId of event.itemIds) {
        const item = items.find((i) => i.id === itemId);
        if (item && (item.elements || item.components)) {
          const els = (item.elements || item.components).map((el) => {
            const element =
              typeof el === "string"
                ? { name: el, displayType: "step", quantity: "", description: "" }
                : { ...el };
            return {
              ...element,
              isCompleted: false,
              completedAt: null,
              sourceItemId: itemId,
            };
          });
          itemElements.push(...els);
        }
      }
    }

    const execution = {
      id: uid(),
      eventId,
      intentId: event.intentId,
      contextId: event.contextId,
      itemIds: event.itemIds,
      startedAt: Date.now(),
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
  }

  async function closeExecution(outcome) {
    if (!activeExecution) return;

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
      closedAt: Date.now(),
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

    // If intent is one-time and outcome is 'done', archive it
    const intent = intents.find((i) => i.id === activeExecution.intentId);
    if (intent && intent.recurrence === "once" && outcome === "done") {
      const archivedIntent = { ...intent, archived: true };
      await storage.set(`intent:${intent.id}`, archivedIntent);
      setIntents(intents.map((i) => (i.id === intent.id ? archivedIntent : i)));
    }

    setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
    setActiveExecution(null);
    setView(previousView);
  }

  async function cancelExecutionForEvent(eventId) {
    const exec =
      activeExecutions.find((e) => e.eventId === eventId) ||
      pausedExecutions.find((e) => e.eventId === eventId);
    if (!exec) return;
    await storage.delete(`execution:${exec.id}`);
    setActiveExecutions((prev) => prev.filter((e) => e.id !== exec.id));
    setPausedExecutions((prev) => prev.filter((e) => e.id !== exec.id));
    if (activeExecution && activeExecution.id === exec.id) {
      setActiveExecution(null);
    }
  }

  async function pauseExecution() {
    if (!activeExecution) return;
    const paused = { ...activeExecution, status: "paused" };
    await storage.set(`execution:${paused.id}`, paused);
    setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
    setPausedExecutions((prev) => [paused, ...prev]);
    setActiveExecution(null);
    setView("home");
  }

  async function makeExecutionActive() {
    if (!activeExecution) return;
    const activated = { ...activeExecution, status: "active" };
    await storage.set(`execution:${activated.id}`, activated);
    setPausedExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
    setActiveExecutions((prev) => [activated, ...prev]);
    setActiveExecution(activated);
  }

  async function toggleExecutionElement(elementIndex) {
    if (!activeExecution) return;
    const updatedElements = [...activeExecution.elements];
    const el = updatedElements[elementIndex];
    updatedElements[elementIndex] = {
      ...el,
      isCompleted: !el.isCompleted,
      completedAt: !el.isCompleted ? Date.now() : null,
    };
    const updated = { ...activeExecution, elements: updatedElements };
    await storage.set(`execution:${updated.id}`, updated);
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
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
    itemId = null,
  ) {
    const newIntent = {
      id: uid(),
      text: text || "New Intention",
      createdAt: Date.now(),
      isIntention: true,
      isItem: false,
      archived: false,
      itemId: itemId,
      contextId: contextId,
      recurrence: recurrence,
    };

    await storage.set(`intent:${newIntent.id}`, newIntent);
    setIntents([...intents, newIntent]);
    return newIntent.id; // Return the ID so it can be scheduled
  }


  // Filter events to only show those with valid, non-archived intents
  const validEvents = events.filter((e) => {
    if (e.archived) return false;
    const intent = intents.find((i) => i.id === e.intentId);
    return intent && !intent.archived;
  });

  const todayEvents = validEvents.filter((e) => e.time === getTodayDate());
  const allNonArchivedEvents = validEvents;
  const pinnedContexts = contexts.filter((c) => c.pinned);
  const allLiveExecutions = [...activeExecutions, ...pausedExecutions];

  function openExecution(exec) {
    setPreviousView(view);
    setActiveExecution(exec);
    setView("execution-detail");
  }

  async function startNowFromItem(itemId) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    // Create intention linked to this item
    const newIntent = {
      id: uid(),
      text: item.name,
      createdAt: Date.now(),
      isIntention: true,
      isItem: false,
      archived: false,
      itemId: item.id,
      contextId: item.contextId || null,
      recurrence: "once",
    };
    await storage.set(`intent:${newIntent.id}`, newIntent);
    setIntents((prev) => [...prev, newIntent]);

    // Create event for today
    const newEvent = {
      id: uid(),
      intentId: newIntent.id,
      time: getTodayDate(),
      itemIds: [item.id],
      contextId: item.contextId || null,
      archived: false,
      createdAt: Date.now(),
    };
    await storage.set(`event:${newEvent.id}`, newEvent);
    setEvents((prev) => [...prev, newEvent]);

    // Build execution inline (can't call activate — state hasn't updated yet)
    const itemElements = [];
    if (item.elements || item.components) {
      const els = (item.elements || item.components).map((el) => {
        const element =
          typeof el === "string"
            ? { name: el, displayType: "step", quantity: "", description: "" }
            : { ...el };
        return {
          ...element,
          isCompleted: false,
          completedAt: null,
          sourceItemId: item.id,
        };
      });
      itemElements.push(...els);
    }

    const execution = {
      id: uid(),
      eventId: newEvent.id,
      intentId: newIntent.id,
      contextId: item.contextId || null,
      itemIds: [item.id],
      startedAt: Date.now(),
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
  }

  async function startNowFromIntention(intentId) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;

    // Find linked item if any
    const linkedItem = intent.itemId
      ? items.find((i) => i.id === intent.itemId)
      : null;

    // Create event for today
    const newEvent = {
      id: uid(),
      intentId: intent.id,
      time: getTodayDate(),
      itemIds: linkedItem ? [linkedItem.id] : [],
      contextId: intent.contextId || null,
      archived: false,
      createdAt: Date.now(),
    };
    await storage.set(`event:${newEvent.id}`, newEvent);
    setEvents((prev) => [...prev, newEvent]);

    // Build execution elements from linked item
    const itemElements = [];
    if (linkedItem && (linkedItem.elements || linkedItem.components)) {
      const els = (linkedItem.elements || linkedItem.components).map((el) => {
        const element =
          typeof el === "string"
            ? { name: el, displayType: "step", quantity: "", description: "" }
            : { ...el };
        return {
          ...element,
          isCompleted: false,
          completedAt: null,
          sourceItemId: linkedItem.id,
        };
      });
      itemElements.push(...els);
    }

    const execution = {
      id: uid(),
      eventId: newEvent.id,
      intentId: intent.id,
      contextId: intent.contextId || null,
      itemIds: linkedItem ? [linkedItem.id] : [],
      startedAt: Date.now(),
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
  }

  // Intentions: Marked as intentions, not archived, no active event
  const intentionsWithoutActiveEvent = intents.filter((i) => {
    if (!i.isIntention || i.archived) return false;
    const hasActiveEvent = validEvents.some((e) => e.intentId === i.id);
    return !hasActiveEvent;
  });

  const memoriesWithoutContext = items.filter((i) => !i.contextId && !i.archived);

  return (
    <div className="min-h-screen bg-primary-bg">
      {/* Mobile header with hamburger */}
      <header className="sm:hidden sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
        <div className="px-3 py-3 flex items-center justify-between">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-dark"
          >
            <Menu className="w-6 h-6" />
          </button>
          <h1 className="text-lg font-bold text-dark">Alfred v5</h1>
          <div className="flex gap-1">
            <button
              onClick={() => setView("settings")}
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-600 hover:text-dark"
              title="Settings"
            >
              <span className="text-xl">⚙️</span>
            </button>
            <button
              onClick={() => setView("recycle")}
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-600 hover:text-dark"
              title="Recycle Bin"
            >
              <Trash2 className="w-5 h-5" />
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
            <div className="p-4 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-dark">Menu</h2>
                <button
                  onClick={() => setMenuOpen(false)}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-600 hover:text-dark"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-2">
              {[
                { key: "home", label: "Home", icon: "🏠" },
                { key: "inbox", label: `Inbox${inboxItems.length > 0 ? ` (${inboxItems.length})` : ""}`, icon: "📥" },
                { key: "contexts", label: "Contexts", icon: "📁" },
                { key: "schedule", label: `Schedule${allNonArchivedEvents.length > 0 ? ` (${allNonArchivedEvents.length})` : ""}`, icon: "📅" },
                { key: "intentions", label: "Intentions", icon: "💡" },
                { key: "memories", label: "Memories", icon: "⭐" },
              ].map((item) => (
                <button
                  key={item.key}
                  onClick={() => {
                    setView(item.key);
                    setMenuOpen(false);
                  }}
                  className={`w-full text-left px-4 py-3 rounded-lg mb-1 ${
                    view === item.key
                      ? "bg-primary-light text-dark font-medium"
                      : "text-dark hover:bg-gray-100"
                  }`}
                >
                  {item.icon} {item.label}
                </button>
              ))}
            </div>
          </nav>
        </>
      )}

      {/* Desktop header with tabs */}
      <div className="hidden sm:block sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-dark">Alfred v5</h1>
              <p className="text-sm text-muted mt-1">
                Capture decisions. Hold intent. Execute with focus.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setView("settings")}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-600 hover:text-dark"
                title="Settings"
              >
                <span className="text-xl">⚙️</span>
              </button>
              <button
                onClick={() => setView("recycle")}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-600 hover:text-dark"
                title="Recycle Bin"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Desktop navigation tabs */}
          <nav className="flex gap-2 mt-3 pb-1">
            <button
              onClick={() => setView("home")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "home"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-gray-700 border border-gray-300 hover:border-primary-light"
              }`}
            >
              Home
            </button>
            <button
              onClick={() => setView("inbox")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "inbox"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-gray-700 border border-gray-300 hover:border-primary-light"
              }`}
            >
              Inbox {inboxItems.length > 0 && `(${inboxItems.length})`}
            </button>
            <button
              onClick={() => setView("contexts")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "contexts"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-gray-700 border border-gray-300 hover:border-primary-light"
              }`}
            >
              Contexts
            </button>
            <button
              onClick={() => setView("schedule")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "schedule"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-gray-700 border border-gray-300 hover:border-primary-light"
              }`}
            >
              Schedule{" "}
              {allNonArchivedEvents.length > 0 &&
                `(${allNonArchivedEvents.length})`}
            </button>
            <button
              onClick={() => setView("intentions")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "intentions"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-gray-700 border border-gray-300 hover:border-primary-light"
              }`}
            >
              Intentions
            </button>
            <button
              onClick={() => setView("memories")}
              className={`px-4 py-2 rounded whitespace-nowrap min-h-[44px] ${
                view === "memories"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white text-gray-700 border border-gray-300 hover:border-primary-light"
              }`}
            >
              Memories
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
              <div className="flex gap-6 border-b border-gray-200 mb-4">
                <button
                  onClick={() => setExecutionTab("active")}
                  className={`pb-2 border-b-2 cursor-pointer transition-colors ${
                    executionTab === "active"
                      ? "border-primary text-primary font-medium"
                      : "border-transparent text-muted hover:text-dark hover:border-gray-300"
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
                        : "border-transparent text-muted hover:text-dark hover:border-gray-300"
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
                      : "border-transparent text-muted hover:text-dark hover:border-gray-300"
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
                    <p className="text-muted text-sm">No active executions.</p>
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
                    <p className="text-muted text-sm">No paused executions.</p>
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
                    <p className="text-muted text-sm">No events scheduled for today.</p>
                  )}
                </div>
              )}
            </div>

            {/* Pinned Contexts Section */}
            <div>
              <h3 className="text-lg font-semibold mb-3 text-dark">Pinned Contexts</h3>
              {pinnedContexts.length === 0 ? (
                <p className="text-muted text-sm">
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
            <h2 className="text-lg sm:text-xl font-semibold mb-3 sm:mb-4">Inbox</h2>
            {inboxItems.length === 0 ? (
              <div className="text-center py-12 text-muted">
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
                    onSave={handleInboxSave}
                    onArchive={archiveInboxItem}
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
              <h2 className="text-lg sm:text-xl font-semibold">Contexts</h2>
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
              />
            ) : contexts.length === 0 ? (
              <div className="text-center py-12 text-muted">
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
            items={items.filter((i) => i.contextId === selectedContextId && !i.archived)}
            intents={intents.filter((i) => i.contextId === selectedContextId && !(i.isIntention && i.archived))}
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
            executions={allLiveExecutions}
            onOpenExecution={openExecution}
            events={events}
            onUpdateEvent={updateEvent}
            onActivate={activate}
            onCancelExecution={cancelExecutionForEvent}
            onStartNow={startNowFromIntention}
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
            onToggleElement={toggleExecutionElement}
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
            <h2 className="text-lg sm:text-xl font-semibold mb-3 sm:mb-4">Schedule</h2>
            {allNonArchivedEvents.length === 0 ? (
              <div className="text-center py-12 text-muted">
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
              <h2 className="text-lg sm:text-xl font-semibold">Intentions</h2>
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
                    recurrence: "once",
                    isIntention: true,
                    isItem: false,
                    archived: false,
                    itemId: null,
                  }}
                  contexts={contexts}
                  items={items}
                  onUpdate={async (_, updates, scheduledDate) => {
                    const newIntentId = await handleAddIntentionToContext(
                      updates.text,
                      updates.contextId || null,
                      updates.recurrence || "once",
                      updates.itemId || null,
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
                />
              </div>
            )}

            {intentionsWithoutActiveEvent.length === 0 && !showAddIntentionForm ? (
              <div className="text-center py-12 text-muted">
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
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Memories View */}
        {view === "memories" && (
          <div>
            <h2 className="text-lg sm:text-xl font-semibold mb-3 sm:mb-4">Memories</h2>
            {memoriesWithoutContext.length === 0 ? (
              <div className="text-center py-12 text-muted">
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

        {/* Settings View */}
        {view === "settings" && (
          <div>
            <h2 className="text-lg sm:text-xl font-semibold mb-3 sm:mb-4">Settings</h2>
            <div className="p-4 sm:p-6 bg-white border border-gray-200 rounded">
              <p className="text-muted">Settings coming soon...</p>
            </div>
          </div>
        )}

        {/* Recycle Bin View */}
        {view === "recycle" && (
          <div>
            <h2 className="text-lg sm:text-xl font-semibold mb-3 sm:mb-4">Recycle Bin</h2>
            <div className="p-4 sm:p-6 bg-white border border-gray-200 rounded">
              <p className="text-muted">Recycle bin coming soon...</p>
            </div>
          </div>
        )}
      </div>

      {/* Capture bar - fixed at bottom */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-20">
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
              className="flex-1 px-3 sm:px-4 py-2.5 sm:py-3 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary resize-none overflow-hidden min-h-[44px] max-h-[50vh] text-base"
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

function InboxCard({
  inboxItem,
  contexts,
  items,
  onSave,
  onArchive,
}) {
  const [expanded, setExpanded] = useState(false);

  // Triage checkboxes
  const [createIntention, setCreateIntention] = useState(false);
  const [createItem, setCreateItem] = useState(false);

  // Intention form state
  const [intentText, setIntentText] = useState(inboxItem.capturedText);
  const [intentRecurrence, setIntentRecurrence] = useState("once");
  const [intentContextId, setIntentContextId] = useState("");
  const [intentContextSearch, setIntentContextSearch] = useState("");
  const [showIntentContextPicker, setShowIntentContextPicker] = useState(false);
  const [intentItemId, setIntentItemId] = useState("");
  const [intentItemSearch, setIntentItemSearch] = useState("");
  const [showIntentItemPicker, setShowIntentItemPicker] = useState(false);

  // Item form state
  const [itemName, setItemName] = useState(inboxItem.capturedText);
  const [itemDescription, setItemDescription] = useState("");
  const [itemContextId, setItemContextId] = useState("");
  const [itemElements, setItemElements] = useState([]);
  const [draggedIndex, setDraggedIndex] = useState(null);

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

  // Item element helpers
  function addElement() {
    setItemElements([
      ...itemElements,
      { name: "", displayType: "step", quantity: "", description: "" },
    ]);
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
  }

  function updateElement(index, field, value) {
    const newElements = [...itemElements];
    newElements[index] = { ...newElements[index], [field]: value };
    setItemElements(newElements);
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

  function handleSave() {
    if (!createIntention && !createItem) return;
    if (createIntention && !intentText.trim()) return;
    if (createItem && !itemName.trim()) return;

    onSave(inboxItem.id, {
      createIntention,
      intentionData: createIntention
        ? {
            text: intentText,
            contextId: intentContextId || null,
            recurrence: intentRecurrence,
            itemId: intentItemId || null,
          }
        : null,
      createItem,
      itemData: createItem
        ? {
            name: itemName,
            description: itemDescription,
            contextId: itemContextId || null,
            elements: itemElements,
          }
        : null,
    });
  }

  function handleCancel() {
    setExpanded(false);
    setCreateIntention(false);
    setCreateItem(false);
    setIntentText(inboxItem.capturedText);
    setIntentRecurrence("once");
    setIntentContextId("");
    setIntentContextSearch("");
    setIntentItemId("");
    setIntentItemSearch("");
    setItemName(inboxItem.capturedText);
    setItemDescription("");
    setItemContextId("");
    setItemElements([]);
  }

  // Collapsed display
  if (!expanded) {
    const textLines = inboxItem.capturedText.split("\n");
    const preview =
      textLines.length > 2
        ? textLines.slice(0, 2).join("\n") + "..."
        : inboxItem.capturedText;

    return (
      <div
        className="p-3 sm:p-4 bg-white border border-gray-200 rounded cursor-pointer hover:border-primary transition-colors"
        onClick={() => setExpanded(true)}
      >
        <p className="whitespace-pre-wrap text-dark">{preview}</p>
      </div>
    );
  }

  // Expanded triage view
  return (
    <div className="p-3 sm:p-4 bg-white border-2 border-primary rounded">
      {/* Captured text at top */}
      <p className="text-lg text-dark mb-4 whitespace-pre-wrap">
        {inboxItem.capturedText}
      </p>

      {/* Checkboxes */}
      <div className="space-y-2 mb-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={createIntention}
            onChange={(e) => setCreateIntention(e.target.checked)}
            className="accent-primary"
          />
          <span>Create Intention</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={createItem}
            onChange={(e) => setCreateItem(e.target.checked)}
            className="accent-primary"
          />
          <span>Create Item</span>
        </label>
      </div>

      {/* Intention form */}
      {createIntention && (
        <div className="mb-4 p-4 border border-gray-200 rounded">
          <h4 className="font-medium mb-3">Intention</h4>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                type="text"
                value={intentText}
                onChange={(e) => setIntentText(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
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
                  className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                />
                {intentContextId && !intentContextSearch && contexts && (
                  <div className="mt-1 text-sm text-gray-600">
                    Selected:{" "}
                    {contexts.find((c) => c.id === intentContextId)?.name}
                    <button
                      onClick={() => {
                        setIntentContextId("");
                        setIntentContextSearch("");
                      }}
                      className="ml-2 text-danger hover:text-danger-hover"
                    >
                      ✕
                    </button>
                  </div>
                )}
                {showIntentContextPicker &&
                  intentContextSearch &&
                  filteredIntentContexts.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded shadow-lg max-h-60 overflow-y-auto">
                      {filteredIntentContexts.map((ctx) => (
                        <button
                          key={ctx.id}
                          onClick={() => {
                            setIntentContextId(ctx.id);
                            setIntentContextSearch(ctx.name);
                            setShowIntentContextPicker(false);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-primary-bg border-b border-gray-200 last:border-b-0"
                        >
                          <div className="font-medium">{ctx.name}</div>
                        </button>
                      ))}
                    </div>
                  )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Linked Item (optional)
              </label>
              <div className="relative">
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
                  className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                />
                {intentItemId && !intentItemSearch && items && (
                  <div className="mt-1 text-sm text-gray-600">
                    Selected:{" "}
                    {items.find((i) => i.id === intentItemId)?.name}
                    <button
                      onClick={() => {
                        setIntentItemId("");
                        setIntentItemSearch("");
                      }}
                      className="ml-2 text-danger hover:text-danger-hover"
                    >
                      ✕
                    </button>
                  </div>
                )}
                {showIntentItemPicker &&
                  intentItemSearch &&
                  filteredIntentItems.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded shadow-lg max-h-60 overflow-y-auto">
                      {filteredIntentItems.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => {
                            setIntentItemId(item.id);
                            setIntentItemSearch(item.name);
                            setShowIntentItemPicker(false);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-primary-bg border-b border-gray-200 last:border-b-0"
                        >
                          <div className="font-medium">{item.name}</div>
                          {item.contextId && contexts && (
                            <div className="text-xs text-muted">
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
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Recurrence
              </label>
              <select
                value={intentRecurrence}
                onChange={(e) => setIntentRecurrence(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              >
                <option value="once">One time</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Item form */}
      {createItem && (
        <div className="mb-4 p-4 border border-gray-200 rounded">
          <h4 className="font-medium mb-3">Item</h4>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                type="text"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                value={itemDescription}
                onChange={(e) => setItemDescription(e.target.value)}
                placeholder="Optional description"
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                rows="2"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Context
              </label>
              <select
                value={itemContextId}
                onChange={(e) => setItemContextId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
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
                {itemElements.map((element, index) => (
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
                          className="text-sm text-muted cursor-move"
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
                          onKeyPress={(e) => handleElementKeyPress(e, index)}
                          placeholder="Element name"
                          className="inbox-element-input flex-1 px-3 py-2 border border-gray-300 rounded"
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
                          className="text-danger hover:text-danger-hover"
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
                  className="w-full px-4 py-2.5 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-primary hover:text-primary transition-all duration-200"
                >
                  + Add Element
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={!createIntention && !createItem}
            className={`px-4 py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 ${
              createIntention || createItem
                ? "bg-primary hover:bg-primary-hover text-white"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            Save
          </button>
          <button
            onClick={handleCancel}
            className="px-4 py-2.5 min-h-[44px] bg-gray-200 hover:bg-gray-300 text-dark rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
          >
            Cancel
          </button>
        </div>
        <button
          onClick={() => onArchive(inboxItem.id)}
          className="min-h-[44px] text-muted hover:text-danger transition-colors"
        >
          Archive
        </button>
      </div>
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
    <div className="mb-4 sm:mb-6 p-4 sm:p-6 bg-white border-2 border-primary rounded-lg shadow-lg">
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
            className="w-full px-3 py-2 border border-gray-300 rounded text-base"
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
            className="w-full px-3 py-2 border border-gray-300 rounded text-base"
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
            className="w-full px-3 py-2 border border-gray-300 rounded text-base"
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
            onClick={() =>
              name.trim() && onSave(name, shared, keywords, description, pinned)
            }
            className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
          >
            Save
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2.5 min-h-[44px] bg-gray-200 hover:bg-gray-300 text-dark rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
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
    <div className="p-3 sm:p-4 bg-white border border-gray-200 rounded cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow duration-200">
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0" onClick={onClick}>
          <div className="flex items-center gap-2">
            {context.pinned && <span className="text-gray-400">📌</span>}
            <h3 className="font-semibold text-dark">{context.name}</h3>
          </div>
          {context.description && (
            <p className="text-sm text-muted mt-1">{context.description}</p>
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
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-muted hover:text-dark"
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
  executions = [],
  onOpenExecution,
  events = [],
  onUpdateEvent,
  onActivate,
  onCancelExecution,
  onStartNow,
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
            className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-gray-200 hover:bg-gray-300 text-dark rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base shrink-0"
          >
            <span>⚙️</span>
            <span className="hidden sm:inline">Edit Context</span>
            <span className="sm:hidden">Edit</span>
          </button>
        </div>
        {context.description && (
          <p className="text-gray-600">{context.description}</p>
        )}
        {context.keywords && (
          <p className="text-sm text-muted mt-1">
            Keywords: {context.keywords}
          </p>
        )}
      </div>

      <div className="space-y-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base sm:text-lg font-semibold">Items ({items.length})</h3>
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
              />
            </div>
          )}

          {items.length === 0 ? (
            <p className="text-muted text-sm">No items in this context</p>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  contexts={contexts}
                  onUpdate={onUpdateItem}
                  onViewDetail={onViewItemDetail}
                  executions={executions.filter((ex) => ex.itemIds?.includes(item.id))}
                  intents={intents}
                  getIntentDisplay={getIntentDisplay}
                  onOpenExecution={onOpenExecution}
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base sm:text-lg font-semibold">
              Intentions ({intents.length})
            </h3>
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
            <p className="text-muted text-sm">
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
                  onStartNow={onStartNow}
                  showScheduling={true}
                  onViewDetail={onViewIntentionDetail}
                  events={events}
                  onUpdateEvent={onUpdateEvent}
                  onActivate={onActivate}
                  executions={executions}
                  onOpenExecution={onOpenExecution}
                  onCancelExecution={onCancelExecution}
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
  executions = [],
  onOpenExecution,
  onCancelExecution,
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
              <span className="inline-block mt-2 text-xs bg-primary-light text-dark px-2 py-0.5 rounded">
                {contextName}
              </span>
            )}
          </div>
          <button
            onClick={() => setIsEditing(true)}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-gray-200 hover:bg-gray-300 text-dark rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base shrink-0"
          >
            <span>⚙️</span>
            <span className="hidden sm:inline">Edit Intention</span>
            <span className="sm:hidden">Edit</span>
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
                executions={executions.filter((ex) => ex.itemIds?.includes(linkedItem.id))}
                intents={[intention]}
                getIntentDisplay={getIntentDisplay}
                onOpenExecution={onOpenExecution}
              />
            ) : (
              <p className="text-muted text-sm">Item not found</p>
            );
          })()}
        </div>
      )}

      <div>
        <h3 className="text-lg font-semibold mb-3">
          Scheduled Events ({intentionEvents.length})
        </h3>
        {intentionEvents.length === 0 ? (
          <p className="text-muted text-sm">
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
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [showAddIntentionForm, setShowAddIntentionForm] = useState(false);

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
              <span className="inline-block mt-2 text-xs bg-primary-light text-dark px-2 py-0.5 rounded">
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
            <button
              onClick={() => setIsEditing(true)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-gray-200 hover:bg-gray-300 text-dark rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <span>⚙️</span>
              <span className="hidden sm:inline">Edit Item</span>
              <span className="sm:hidden">Edit</span>
            </button>
          </div>
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
          <span className="inline-block text-xs bg-success-light text-dark px-2 py-1 rounded">
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
              {(() => {
                let stepCounter = 0;
                return (item.elements || item.components).map((element, index) => {
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
                  stepCounter++;
                  const stepNum = stepCounter;
                  return (
                    <div key={index} className="flex items-start gap-3">
                      <span className="text-gray-600 font-medium min-w-[24px]">
                        {stepNum}.
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
                });
              })()}
            </div>
          </div>
        )}

      {/* Active/Paused Executions Section */}
      {executions.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3">
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
          <h3 className="text-lg font-semibold">
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
                recurrence: "once",
                isIntention: true,
                isItem: false,
                archived: false,
                itemId: item.id,
              }}
              contexts={contexts}
              items={items}
              onUpdate={async (_, updates, scheduledDate) => {
                const newIntentId = await onAddIntention(
                  updates.text,
                  updates.contextId !== undefined ? updates.contextId : item.contextId,
                  updates.recurrence || "once",
                  updates.itemId !== undefined ? updates.itemId : item.id,
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
            />
          </div>
        )}

        {itemIntentions.length === 0 && !showAddIntentionForm ? (
          <p className="text-muted text-sm">
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
                onStartNow={onStartNowIntention}
                getIntentDisplay={getIntentDisplay}
                showScheduling={true}
                events={events}
                onUpdateEvent={onUpdateEvent}
                onActivate={onActivate}
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

function ExecutionDetailView({
  execution,
  intent,
  event,
  items,
  contexts,
  onToggleElement,
  onUpdateNotes,
  onComplete,
  onPause,
  onMakeActive,
  onCancel,
  onBack,
  getIntentDisplay,
}) {
  const [localNotes, setLocalNotes] = useState(execution.notes || "");

  const contextName =
    execution.contextId && contexts
      ? contexts.find((c) => c.id === execution.contextId)?.name
      : null;

  const displayName = intent ? getIntentDisplay(intent) : "Execution";
  const dateDisplay = event?.time || "";

  return (
    <div>
      <button
        onClick={() => {
          onUpdateNotes(localNotes);
          onBack();
        }}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-gray-600 hover:text-gray-800"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="mb-4 sm:mb-6">
        <h2 className="text-xl sm:text-2xl font-bold text-dark">{displayName}</h2>
        <div className="flex items-center gap-2 mt-1">
          {contextName && (
            <span className="text-xs bg-success-light text-dark px-2 py-0.5 rounded">
              {contextName}
            </span>
          )}
          {dateDisplay && (
            <span className="text-sm text-muted">{dateDisplay}</span>
          )}
        </div>
      </div>

      {execution.elements && execution.elements.length > 0 && (
        <div className="mb-6">
          <div className="border-t border-gray-200 pt-4 space-y-2">
            {(() => {
              let stepCounter = 0;
              return execution.elements.map((el, index) => {
                if (el.displayType === "header") {
                  return (
                    <div key={index} className="mt-4 mb-2">
                      <h4 className="text-md font-bold text-gray-800 uppercase tracking-wide">
                        {el.name}
                      </h4>
                    </div>
                  );
                }

                if (el.displayType === "bullet") {
                  return (
                    <div key={index} className="ml-4 flex items-start gap-2 py-1">
                      <span className="text-muted mt-0.5">•</span>
                      <div className="flex-1">
                        <span className="text-gray-700">
                          {el.quantity && (
                            <span className="font-medium">{el.quantity} · </span>
                          )}
                          {el.name}
                        </span>
                        {el.description && (
                          <p className="text-sm text-muted">{el.description}</p>
                        )}
                      </div>
                    </div>
                  );
                }

                // step or any other displayType
                stepCounter++;
                const stepNum = stepCounter;
                return (
                  <div
                    key={index}
                    onClick={() => onToggleElement(index)}
                    className="flex items-start gap-3 py-2 px-3 rounded cursor-pointer hover:bg-gray-50"
                  >
                    <span className={`font-medium min-w-[24px] mt-0.5 ${el.isCompleted ? "text-gray-400" : "text-gray-600"}`}>
                      {stepNum}.
                    </span>
                    <span className={`mt-1 w-5 h-5 flex-shrink-0 rounded border-2 flex items-center justify-center ${
                      el.isCompleted
                        ? "bg-primary border-primary"
                        : "bg-white border-gray-300"
                    }`}>
                      {el.isCompleted && (
                        <Check className="w-3 h-3 text-white" />
                      )}
                    </span>
                    <div className="flex-1">
                      <span
                        className={
                          el.isCompleted
                            ? "line-through text-gray-400"
                            : "text-gray-800"
                        }
                      >
                        {el.name}
                      </span>
                      {(el.quantity || el.description) && (
                        <p
                          className={`text-sm ${el.isCompleted ? "text-gray-300" : "text-muted"}`}
                        >
                          {[el.quantity, el.description]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      <div className="mb-6">
        <div className="border-t border-gray-200 pt-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Notes
          </label>
          <textarea
            value={localNotes}
            onChange={(e) => setLocalNotes(e.target.value)}
            onBlur={() => onUpdateNotes(localNotes)}
            placeholder="Add notes about this execution..."
            className="w-full px-3 py-2 border border-gray-300 rounded min-h-[120px]"
          />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-0 pt-4 border-t border-gray-200">
        <button
          onClick={onCancel}
          className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-gray-200 hover:bg-gray-300 text-dark rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
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
      <p className="font-medium text-dark">
        {intent ? getIntentDisplay(intent) : "Execution"}
      </p>
      {exec.contextId && (
        <p className="text-sm text-gray-700">
          {contexts.find((c) => c.id === exec.contextId)?.name}
        </p>
      )}
      {isActive && (
        <p className="text-xs text-dark mt-1 flex items-center gap-1">
          <Play className="w-3 h-3" />
          Active
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
  executions = [],
  intents = [],
  getIntentDisplay,
  onOpenExecution,
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
      <div className="p-3 sm:p-4 bg-white border-2 border-primary rounded">
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-base"
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
              className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              rows="2"
            />
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Context
            </label>
            <select
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-base"
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
                        className="text-sm text-muted cursor-move"
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
                        className="text-danger hover:text-danger-hover"
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
                className="w-full px-4 py-2.5 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-primary hover:text-primary transition-all duration-200"
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
              className="px-4 py-2.5 min-h-[44px] bg-gray-200 hover:bg-gray-300 text-dark rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onUpdate(item.id, { archived: true });
                setIsEditing(false);
              }}
              className="px-4 py-2.5 min-h-[44px] bg-danger hover:bg-danger-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 ml-auto"
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
      className="p-3 sm:p-4 bg-white border border-gray-200 rounded cursor-pointer hover:border-primary"
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
}) {
  const [isEditing, setIsEditing] = useState(initialEditing);
  const [name, setName] = useState(intent.text);
  const [recurrence, setRecurrence] = useState(intent.recurrence || "once");
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [showItemPicker, setShowItemPicker] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState(intent.itemId || "");
  const [selectedContextId, setSelectedContextId] = useState(intent.contextId || "");
  const [contextSearch, setContextSearch] = useState("");
  const [showContextPicker, setShowContextPicker] = useState(false);

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
    if (onUpdate) {
      const updates = showScheduling
        ? { text: name, recurrence, itemId: selectedItemId || null, contextId: selectedContextId || null }
        : { text: name, itemId: selectedItemId || null, contextId: selectedContextId || null };
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
      <div className="p-3 sm:p-4 bg-white border-2 border-primary rounded">
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
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
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              />
              {selectedContextId && !contextSearch && contexts && (
                <div className="mt-1 text-sm text-gray-600">
                  Selected: {contexts.find((c) => c.id === selectedContextId)?.name}
                  <button
                    onClick={() => {
                      setSelectedContextId("");
                      setContextSearch("");
                    }}
                    className="ml-2 text-danger hover:text-danger-hover"
                  >
                    ✕
                  </button>
                </div>
              )}
              {showContextPicker && contextSearch && filteredContexts.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded shadow-lg max-h-60 overflow-y-auto">
                  {filteredContexts.map((ctx) => (
                    <button
                      key={ctx.id}
                      onClick={() => {
                        setSelectedContextId(ctx.id);
                        setContextSearch(ctx.name);
                        setShowContextPicker(false);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-primary-bg border-b border-gray-200 last:border-b-0"
                    >
                      <div className="font-medium">{ctx.name}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              />
              {selectedItemId && !itemSearch && items && (
                <div className="mt-1 text-sm text-gray-600">
                  Selected: {items.find((i) => i.id === selectedItemId)?.name}
                  <button
                    onClick={() => {
                      setSelectedItemId("");
                      setItemSearch("");
                    }}
                    className="ml-2 text-danger hover:text-danger-hover"
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
                      className="w-full text-left px-3 py-2 hover:bg-primary-bg border-b border-gray-200 last:border-b-0"
                    >
                      <div className="font-medium">{item.name}</div>
                      {item.contextId && contexts && (
                        <div className="text-xs text-muted">
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
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              >
                <option value="once">One time</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
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
                    className="px-3 py-2 min-h-[44px] border border-gray-300 rounded"
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
              className="px-3 sm:px-4 py-2.5 min-h-[44px] bg-gray-200 hover:bg-gray-300 text-dark rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
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
      className="p-3 sm:p-4 bg-white border border-gray-200 rounded cursor-pointer hover:border-primary"
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
              <span className="text-sm text-muted capitalize">
                {intent.recurrence || "once"}
              </span>
            )}
            {contextName && (
              <span className="text-xs bg-primary-light text-dark px-2 py-0.5 rounded">
                {contextName}
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
    // Delete the execution if one exists for this event
    if (onCancelExecution) {
      await onCancelExecution(event.id);
    }
    // Archive the event
    onUpdate(event.id, { archived: true });
    setIsEditing(false);
  }

  if (isEditing) {
    return (
      <div className="p-3 sm:p-4 bg-white border-2 border-primary rounded">
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Event Name
            </label>
            <input
              type="text"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              className="w-full px-3 py-2 min-h-[44px] border border-gray-300 rounded text-base"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Scheduled Date
            </label>
            <input
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
              className="w-full px-3 py-2 min-h-[44px] border border-gray-300 rounded"
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
              className="px-4 py-2.5 min-h-[44px] bg-danger hover:bg-danger-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Cancel Event
            </button>
            <button
              onClick={() => {
                setScheduledDate(event.time);
                setEventName(event.text || intent?.text || "");
                setIsEditing(false);
              }}
              className="px-4 py-2.5 min-h-[44px] bg-gray-200 hover:bg-gray-300 text-dark rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const execution = executions.find((ex) => ex.eventId === event.id);

  return (
    <div className="p-3 bg-white border border-gray-200 rounded shadow-sm hover:shadow-md transition-shadow duration-200">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex-1 min-w-0" onClick={() => setIsEditing(true)}>
          <p className="font-medium text-dark cursor-pointer hover:text-primary">
            {nested ? `Event: ${event.text || getIntentDisplay(intent)}` : (event.text || getIntentDisplay(intent))}
          </p>
          <p className="text-sm text-muted">{event.time}</p>
          {event.contextId && (
            <span className="inline-block mt-1 text-xs bg-primary-light text-dark px-2 py-0.5 rounded">
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
                Active
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
