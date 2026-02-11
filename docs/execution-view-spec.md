# Alfred Execution View — Implementation Spec

## Overview

The Execution View is Alfred's "doing mode." It turns Events into live sessions where users check off Item elements, take notes, and log completed work. Every Execution flows through the chain: **Intention → Event → Execution**. Items are optional — sometimes you're just going to the store.

### Core Principles

- **Alfred stores truth.** A cancelled execution is deleted, not marked abandoned.
- **"Now" means now.** Start Now creates the full chain and drops the user into ExecutionDetailView instantly.
- **Consistency over shortcuts.** Even ad-hoc executions from Items create an Intention + Event behind the scenes.
- **Elements are frozen at execution start.** The execution record snapshots Item elements so edits to the Item don't affect in-progress executions.

---

## Current State (What Exists)

### Data Structures

**Intent (intents table):**
```js
{
  id, text, createdAt, isIntention, isItem, archived,
  itemId,      // optional link to Item
  contextId,   // optional
  recurrence   // "once" | "daily" | "weekly" | "monthly"
}
```

**Event (events table):**
```js
{
  id, intentId, time, itemIds: [],  // array of item IDs
  contextId, archived, createdAt
}
```

**Item (items table):**
```js
{
  id, name, description, contextId,
  elements: [  // array of element objects
    { name, displayType, quantity?, description? }
    // displayType: "header" | "bullet" | "step" (default)
  ],
  isCaptureTarget, createdAt
}
```

**Execution (executions table) — current shape:**
```js
{
  id, eventId, intentId, contextId, itemIds: [],
  startedAt, status: "active", progress: []
}
```

### Existing Functions

- `activate(eventId)` — creates execution from event, sets as active
- `closeExecution(outcome)` — archives execution, archives event, optionally archives one-time intent
- `moveToPlanner(intentId, scheduledDate)` — creates an event from an intent
- Active execution stored at key `execution:active` (singleton pattern)

### Current Execution UI

The Home view shows an active execution card with Done/Pause/Cancel buttons. No element rendering, no notes, no checkboxes.

---

## Target State

### Updated Execution Data Structure

```js
{
  id: uid(),
  eventId: "...",
  intentId: "...",
  contextId: "...",       // optional
  itemIds: ["..."],       // optional — may be empty
  startedAt: Date.now(),
  status: "active",
  notes: "",              // NEW: execution-level notes (free text)
  elements: [             // NEW: frozen snapshot of Item elements at start
    {
      name: "Preheat oven to 375°F",
      displayType: "step",
      quantity: "",
      description: "",
      isCompleted: false,
      completedAt: null
    }
  ],
  progress: []            // keep for backward compat, unused going forward
}
```

**Key changes:**
- `notes` field (string) for execution-level notes
- `elements` array: frozen copy of Item elements at execution start, enriched with `isCompleted` and `completedAt` per element
- When execution has no Item, `elements` is an empty array

### Updated Execution Lifecycle

```
START (from Event):
  1. Create execution record with frozen elements snapshot
  2. Store at execution:active
  3. Navigate to execution-detail view

TOGGLE ELEMENT:
  1. Toggle isCompleted on the element
  2. Set/clear completedAt timestamp
  3. Save to execution:active

UPDATE NOTES:
  1. Update notes field
  2. Save to execution:active

COMPLETE:
  1. Set closedAt, status: "closed", outcome: "done"
  2. Archive execution to execution:{id}
  3. Delete execution:active
  4. Archive the Event (archived: true)
  5. If intent.recurrence === "once", archive intent
  6. Navigate to schedule view

CANCEL:
  1. Delete execution:active (no record kept — it never happened)
  2. Event remains unarchived (still on schedule)
  3. Navigate to schedule view
```

---

## Implementation Blocks

Each block below is a self-contained unit of work. Feed them to Claude CLI one at a time. They build on each other sequentially.

---

### Block 1: Update `activate()` to Snapshot Elements

**Goal:** When an execution starts, freeze the Item's elements into the execution record. Add notes field.

**Changes to `activate(eventId)` function (~line 452):**

1. Look up the event's `itemIds` array
2. For each itemId, find the Item and get its elements
3. Deep-copy elements into the execution, adding `isCompleted: false` and `completedAt: null` to each
4. Add `notes: ""` to the execution object
5. If event has no items (itemIds is empty), set `elements: []`

**Updated execution object shape:**
```js
const itemElements = [];
if (event.itemIds && event.itemIds.length > 0) {
  for (const itemId of event.itemIds) {
    const item = items.find(i => i.id === itemId);
    if (item && (item.elements || item.components)) {
      const els = (item.elements || item.components).map(el => {
        const element = typeof el === "string"
          ? { name: el, displayType: "step", quantity: "", description: "" }
          : { ...el };
        return {
          ...element,
          isCompleted: false,
          completedAt: null,
          sourceItemId: itemId  // track which item this came from
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
```

**Also:** Remove the guard that requires `contextId || itemIds.length` in the current `activate()`. Events without a context or item should still be executable (the "go to the store" case).

**Testing for Block 1:**
- Create an event with a linked item that has elements → Start → verify `execution:active` in Supabase has frozen elements with `isCompleted: false`
- Create an event with no linked item → Start → verify execution has `elements: []`
- Edit the source Item's elements after starting → verify execution elements are unchanged

---

### Block 2: Update `closeExecution()` for Cancel = Delete

**Goal:** Cancel deletes the execution record entirely. Complete saves it. Event stays unarchived on cancel.

**Changes to `closeExecution(outcome)` function (~line 477):**

```
If outcome === "cancelled":
  - Delete execution:active
  - Do NOT archive the event
  - Do NOT archive the intent
  - Set activeExecution to null
  - Navigate to schedule view
  - Return early

If outcome === "done":
  - (existing behavior) Archive execution, archive event, conditionally archive intent
  - Include notes and elements in the archived execution record

If outcome === "paused":
  - Keep existing behavior but preserve notes and elements state
```

**Important:** The `notes` field and current element completion state must be preserved when saving a completed execution. This is the historical record.

**Testing for Block 2:**
- Start an execution → Cancel → verify no execution record exists in Supabase, event is still unarchived
- Start an execution → Complete → verify execution record saved with `outcome: "done"`, event archived
- Start an execution with a recurring intent → Complete → verify event archived, intent NOT archived
- Start an execution with a one-time intent → Complete → verify both event and intent archived

---

### Block 3: Create `ExecutionDetailView` Component

**Goal:** Build the full-screen execution view with element checkboxes and notes.

**New component: `ExecutionDetailView`**

**Props:**
```js
{
  execution,        // the active execution object
  intent,           // the linked intent (for display name)
  event,            // the linked event (for date/context)
  items,            // all items (to look up item name)
  contexts,         // all contexts (for context badge)
  onToggleElement,  // (elementIndex) => void
  onUpdateNotes,    // (notes) => void
  onComplete,       // () => void
  onCancel,         // () => void
  getIntentDisplay, // existing helper
}
```

**Layout:**
```
┌─────────────────────────────────────┐
│ ← Back (cancels)                    │
│                                     │
│ [Intent Display Name]               │
│ Context Badge · Feb 10, 2026        │
│ ─────────────────────────────────── │
│                                     │
│ (if elements exist:)                │
│                                     │
│ HEADER ELEMENT              (bold)  │
│ ☑ Step element name      (strikethrough when checked)
│   quantity · description            │
│ ☐ Step element name                 │
│ • Bullet element name    (no checkbox)
│                                     │
│ ─────────────────────────────────── │
│ Notes                               │
│ ┌─────────────────────────────────┐ │
│ │ textarea...                     │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [Cancel]                 [Complete] │
└─────────────────────────────────────┘
```

**Element rendering rules:**
- `displayType: "header"` → Bold section divider, no checkbox
- `displayType: "step"` → Checkbox + name. When checked: strikethrough, green check, timestamp optional
- `displayType: "bullet"` → Bullet point, no checkbox (informational)
- Any other displayType → Treat as step (checkable)



**Styling guidance:**
- Full-width view (no sidebar distractions)
- Green accent for the execution state (consistent with existing active execution card)
- Checked elements get `line-through text-gray-400` treatment
- Cancel button: gray/subtle. Complete button: green/prominent
- Notes textarea: auto-expanding or generous height

**Testing for Block 3:**
- Visual: execution with mixed element types (headers, steps, bullets) renders correctly
- Visual: execution with no elements shows just the title, notes, and buttons
- Checking a step shows strikethrough immediately
- Unchecking a step removes strikethrough
- Notes field is editable and persists across re-renders

---

### Block 4: Wire ExecutionDetailView into the App

**Goal:** Add the `execution-detail` view to the app's view routing and connect all the handlers.

**Changes to the main `Alfred` component:**

1. **Add view state:** The app already has `view` state. Add `"execution-detail"` as a valid view value.

2. **Add handler functions:**

```js
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
  await storage.set("execution:active", updated);
  setActiveExecution(updated);
}

async function updateExecutionNotes(notes) {
  if (!activeExecution) return;
  const updated = { ...activeExecution, notes };
  await storage.set("execution:active", updated);
  setActiveExecution(updated);
}
```

3. **Update `activate()` to navigate to execution-detail:**
```js
// Change the last line of activate() from:
setView("home");
// To:
setView("execution-detail");
```

4. **Update `closeExecution()` navigation:**
```js
// After closing, go back to schedule (already does this)
setView("schedule");
```

5. **Add the view rendering in the main return:**
```jsx
{view === "execution-detail" && activeExecution && (
  <ExecutionDetailView
    execution={activeExecution}
    intent={intents.find(i => i.id === activeExecution.intentId)}
    event={events.find(e => e.id === activeExecution.eventId)}
    items={items}
    contexts={contexts}
    onToggleElement={toggleExecutionElement}
    onUpdateNotes={updateExecutionNotes}
    onComplete={() => closeExecution("done")}
    onCancel={() => closeExecution("cancelled")}
    getIntentDisplay={getIntentDisplay}
  />
)}
```

6. **Make the Home active execution card clickable:**
The existing active execution card on the Home view (~line 771) should navigate to `execution-detail` when clicked, so users can resume viewing their execution.

```jsx
// Add onClick to the active execution container div:
onClick={() => setView("execution-detail")}
className="... cursor-pointer"
```

7. **On app load, if there's an active execution, consider auto-showing it:**
In `loadData()`, after loading the active execution, if one exists, optionally set view to `execution-detail`. Or just show the resume banner on Home — your call. I'd recommend keeping it as the Home banner (current behavior) since auto-redirecting on load could be jarring.

**Testing for Block 4:**
- Click Start on an event → lands on ExecutionDetailView
- Check off elements → state persists (refresh page, execution:active still has checked elements)
- Type notes → state persists
- Click Complete → execution archived, event archived, returns to schedule
- Click Cancel → execution deleted, event still on schedule, returns to schedule
- From Home, click the active execution card → navigates to ExecutionDetailView
- Refresh page with active execution → Home shows the execution card, clicking it opens ExecutionDetailView

---

### Block 5: Add "Start Now" Flow from ItemDetailView

**Goal:** Add a "Start" button to ItemDetailView that creates Intention → Event → Execution in one motion and opens ExecutionDetailView.



---

### Block 6: Add "Create Intention" Button to ItemDetailView

**Goal:** Let users create an Intention linked to an Item, with options for recurrence and scheduling.

**UI Addition to ItemDetailView:**

Add a "Create Intention" button below the Related Intentions section. When clicked, show an inline form with:
- Recurrence selector (once / daily / weekly / monthly)
- Action buttons: "Start Now" | "Do Today" | "Schedule Later" | "Save Intention"

**New function in main Alfred component:**

```js
async function createIntentionFromItem(itemId, recurrence, action, scheduledDate) {
  const item = items.find(i => i.id === itemId);
  if (!item) return;

  // Create the Intention
  const intent = {
    id: uid(),
    text: item.name,
    createdAt: Date.now(),
    isIntention: true,
    isItem: true,
    archived: false,
    itemId: item.id,
    contextId: item.contextId,
    recurrence: recurrence || "once",
  };
  await storage.set(`intent:${intent.id}`, intent);
  setIntents(prev => [...prev, intent]);

  if (action === "start-now") {
    // Create event + execution and open ExecutionDetailView
    // Reuse the startNowFromItem logic but with existing intent
    const event = {
      id: uid(),
      intentId: intent.id,
      time: "today",
      itemIds: [item.id],
      contextId: item.contextId,
      archived: false,
      createdAt: Date.now(),
    };
    await storage.set(`event:${event.id}`, event);
    setEvents(prev => [...prev, event]);
    await activate(event.id);  // This creates execution and navigates
  } else if (action === "do-today") {
    await moveToPlanner(intent.id, "today");
  } else if (action === "schedule-later" && scheduledDate) {
    await moveToPlanner(intent.id, scheduledDate);
  }
  // If action is just "save", the intention exists but has no event yet
}
```

**Pass to ItemDetailView:**
```jsx
<ItemDetailView
  ...existing props...
  onStartNow={startNowFromItem}
  onCreateIntention={createIntentionFromItem}
/>
```

**Testing for Block 6:**
- Item detail → Create Intention with "once" → Save → intention appears in Related Intentions
- Item detail → Create Intention with "weekly" → Do Today → event appears on schedule
- Item detail → Create Intention → Start Now → execution begins immediately
- Item detail → Create Intention → Schedule Later (pick a date) → event appears with that date
- Verify the intention is properly linked to the item (itemId set)

---

### Block 7: Add "Do Now" Button to Event Cards and Intention Cards

**Goal:** Ensure the "Start" / "Do Now" flow is accessible from multiple entry points throughout the app.

**EventCard already has a Start button** — this just needs to navigate to `execution-detail` (handled by Block 4's changes to `activate()`). Verify it works.

**IntentionCard — add "Do Now" button:**

For intentions that don't have an active event, add a "Do Now" button that:
1. Creates an event for today
2. Immediately activates it (creates execution)
3. Opens ExecutionDetailView

This is essentially `moveToPlanner(intentId, "today")` followed by `activate(newEventId)`. You may need to chain these or create a combined function:

```js
async function doNowFromIntention(intentId) {
  const intent = intents.find(i => i.id === intentId);
  if (!intent) return;

  // Create today's event
  const event = {
    id: uid(),
    intentId,
    time: "today",
    itemIds: intent.itemId ? [intent.itemId] : [],
    contextId: intent.contextId,
    archived: false,
    createdAt: Date.now(),
  };
  await storage.set(`event:${event.id}`, event);
  setEvents(prev => [...prev, event]);

  // Immediately activate
  // (Need to pass items for element snapshot — activate() reads from items state)
  await activate(event.id);
}
```

**Pass to IntentionCard where used:**
```jsx
<IntentionCard
  ...existing props...
  onDoNow={doNowFromIntention}
/>
```

**Testing for Block 7:**
- Schedule view → click Start on an event → ExecutionDetailView opens
- Intentions view → click "Do Now" on an intention → event created, execution started, lands in ExecutionDetailView
- Intentions view → Do Now on an intention linked to an Item → elements appear in execution
- Intentions view → Do Now on an intention with no Item → execution has no elements, just title and notes
- Home → Today's events → Start → ExecutionDetailView opens

---

### Block 8: Update IntentionDetailView and ItemDetailView History Display

**Goal:** Show execution history on detail views so users can see past executions, notes, and patterns.

**IntentionDetailView changes:**

Currently shows events for the intention. Enhance to also show completed executions:

1. Load all executions for this intention (query executions where `intentId` matches)
2. Display under a "Past Executions" section
3. For each execution, show: date completed, time spent (calculated from startedAt → closedAt), notes (if any), element completion count

**Note:** Loading past executions requires querying the executions table by intentId. You may need to add a helper function:

```js
async function getExecutionsForIntent(intentId) {
  const { data, error } = await supabase
    .from('executions')
    .select('*')
    .eq('intent_id', intentId)
    .neq('id', 'active')
    .order('started_at', { ascending: false });
  return data ? data.map(d => storage.toCamelCase(d)) : [];
}
```

**ItemDetailView changes:**

Similar — show past executions linked to this item. Query where `item_ids` contains the item's ID. This is trickier since `itemIds` is a JSONB array. If querying JSONB is complex, you can load executions through the item's linked intentions instead:

```
Item → find all intents where itemId === item.id → for each intent, find executions
```

**Display format for execution history:**
```
Past Executions (3)
─────────────────
✓ Feb 8, 2026 · 23 min · "Doubled the recipe, worked great"
✓ Feb 1, 2026 · 18 min · (no notes)
✓ Jan 25, 2026 · 20 min · "Added extra garlic"
```

**Testing for Block 8:**
- Complete an execution → go to the Intention detail → see it in Past Executions
- Complete an execution linked to an Item → go to the Item detail → see it in execution history
- Execution with notes displays the notes
- Execution without notes shows "(no notes)" or just omits
- Multiple executions appear in reverse chronological order

---

## User Acceptance Testing Checklist

Run through each scenario end-to-end after all blocks are implemented.

### Flow 1: Execute from Event (no Item)
1. Create an intention "Go to grocery store"
2. Schedule it for today (Do Today)
3. Go to Home → see event in Today's Events
4. Click Start on the event
5. **Verify:** ExecutionDetailView opens with title, no elements, empty notes
6. Type a note: "Got everything on the list"
7. Click Complete
8. **Verify:** Returns to schedule, event is gone (archived), intention is archived (one-time)

### Flow 2: Execute from Event (with Item)
1. Create a context "Kitchen"
2. Create an item "Pasta Recipe" with elements:
   - Header: "Ingredients"
   - Bullet: "1 lb spaghetti"
   - Bullet: "4 eggs"
   - Header: "Steps"
   - Step: "Boil water"
   - Step: "Cook pasta 8 min"
   - Step: "Make sauce"
3. Create an intention linked to "Pasta Recipe", schedule for today
4. Go to Home → Start the event
5. **Verify:** ExecutionDetailView shows headers as dividers, bullets without checkboxes, steps with checkboxes
6. Check off "Boil water" → verify strikethrough
7. Uncheck "Boil water" → verify strikethrough removed
8. Check all steps, add note "Turned out great"
9. Click Complete
10. **Verify:** Event archived, execution saved with element completion timestamps

### Flow 3: Start Now from Item
1. Navigate to the "Pasta Recipe" item detail
2. Click "Start Now"
3. **Verify:** Immediately in ExecutionDetailView with elements
4. **Verify:** New intention and event created in Supabase
5. Complete the execution
6. Go back to Item detail
7. **Verify:** New intention appears in Related Intentions

### Flow 4: Create Intention from Item
1. Navigate to "Pasta Recipe" item detail
2. Click "Create Intention"
3. Set recurrence to "weekly"
4. Click "Do Today"
5. **Verify:** Intention created with weekly recurrence, event scheduled for today
6. Go to Schedule → see the event
7. Start and complete the execution
8. **Verify:** Event archived, intention NOT archived (it's recurring)

### Flow 5: Cancel Execution
1. Start any execution
2. Check off a few elements, type some notes
3. Click Cancel
4. **Verify:** Returns to schedule, event is still there (not archived)
5. **Verify:** No execution record in Supabase (deleted)
6. Start the same event again
7. **Verify:** All elements are unchecked (fresh start, since previous was cancelled)

### Flow 6: Do Now from Intention
1. Go to Intentions view
2. Click "Do Now" on an intention
3. **Verify:** Event created, execution started, ExecutionDetailView opens
4. Complete it

### Flow 7: Element Freeze Verification
1. Start an execution for an Item with elements
2. While execution is active, go to the Item and edit an element's name
3. Return to the execution (click active execution card on Home)
4. **Verify:** Execution still shows the ORIGINAL element names, not the edited ones

### Flow 8: Persistence Across Refresh
1. Start an execution
2. Check off 2 elements, type a note
3. Refresh the browser
4. **Verify:** Home shows the active execution card
5. Click it → ExecutionDetailView shows with 2 elements still checked and note preserved

### Flow 9: Prevent Double Execution
1. Start an execution
2. Try to start another event or click Start Now on an Item
3. **Verify:** Prevented with a message — "Complete or cancel your active execution first"

### Flow 10: Timer Display
1. Start an execution
2. **Verify:** Timer starts counting from 0:00
3. Wait 2 minutes
4. **Verify:** Timer shows approximately 2:00
5. Complete the execution
6. **Verify:** Archived execution has accurate time span (closedAt - startedAt)

### Flow 11: Execution History
1. Complete 2-3 executions for the same intention/item
2. View the Intention detail
3. **Verify:** Past Executions section shows all completed executions with dates, duration, and notes
4. View the Item detail
5. **Verify:** Execution history shows the same executions

### Flow 12: No-Item Event Lifecycle
1. Capture "Call dentist" in inbox
2. Triage to intention
3. Schedule for today
4. Start → no elements shown, just title and notes
5. Add note "Rescheduled to March"
6. Complete
7. **Verify:** Full lifecycle works without any Item involvement
