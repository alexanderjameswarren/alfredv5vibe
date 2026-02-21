# Phase 7.2.1 — Inbox UI: AI Enrichment & Triage Redesign

## Overview

Redesign the Alfred inbox to surface AI enrichment suggestions, add enrich/re-enrich functionality, and introduce accordion-based triage sections for Intention, Item, and Add to Collection.

**Key files:**
- `src/Alfred.jsx` — Main app component (InboxCard, handleCapture, handleInboxSave)
- `src/supabaseClient.js` — Supabase client config

**Schema reference:** `public.inbox` table contains all `suggested_*`, `ai_status`, `ai_confidence`, `ai_reasoning`, `source_type`, `source_metadata`, `suggested_tags`, `suggested_item_id`, `suggested_collection_id` columns.

---

## Step 1: Export supabaseUrl from supabaseClient.js

**File:** `src/supabaseClient.js`

Export the Supabase project URL so it can be used for Edge Function calls.

```js
// Before:
const supabase = createClient('https://your-project.supabase.co', 'your-anon-key');
export { supabase };

// After:
export const supabaseUrl = 'https://your-project.supabase.co';
const supabase = createClient(supabaseUrl, 'your-anon-key');
export { supabase };
```

Update the import in `Alfred.jsx`:

```js
// Before:
import { supabase } from "./supabaseClient";

// After:
import { supabase, supabaseUrl } from "./supabaseClient";
```

**Verification:** App loads without errors. Console shows no import warnings.

---

## Step 2: Update handleCapture with new default fields

**File:** `src/Alfred.jsx` — `handleCapture` function (~line 834)

Add missing fields to the inbox item object created on capture:

```js
const inboxItem = {
  id: uid(),
  user_id: user.id,
  capturedText: captureText.trim(),
  createdAt: Date.now(),
  archived: false,
  triagedAt: null,
  // Existing suggestion fields
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
  // NEW fields
  aiStatus: 'not_started',
  sourceType: 'manual',
  sourceMetadata: {},
  aiConfidence: null,
  aiReasoning: null,
  suggestedTags: [],
  suggestedItemId: null,
  suggestedCollectionId: null,
};
```

**Verification:** Capture a new inbox item. Expand it — no console errors. Check Supabase `inbox` table — new columns populated with defaults.

---

## Step 3: Collapsed InboxCard — add metadata row

**File:** `src/Alfred.jsx` — `InboxCard` component, collapsed view (~line 2984)

Replace the current collapsed card with one that shows:
- Captured text truncated to ~100 chars with ellipsis
- Metadata row: friendly date | AI status badge
- Sort order is oldest first (this is handled in the parent, see Step 4)

### Friendly date helper

Add this helper function above the InboxCard component:

```js
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
```

### AI status badge helper

```js
function AiStatusBadge({ status }) {
  const config = {
    not_started: { label: 'Not enriched', bg: 'bg-gray-100', text: 'text-gray-500', dot: 'bg-gray-400' },
    in_progress: { label: 'Enriching...', bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-400 animate-pulse' },
    enriched: { label: 'Enriched (Sonnet)', bg: 'bg-green-50', text: 'text-green-700', dot: 'bg-green-500' },
    re_enriched: { label: 'Re-enriched (Opus)', bg: 'bg-purple-50', text: 'text-purple-700', dot: 'bg-purple-500' },
  };
  const c = config[status] || config.not_started;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  );
}
```

### Source icon helper

```js
function SourceIcon({ sourceType }) {
  const icons = { manual: '✏️', mcp: '🤖', email: '✉️' };
  return <span title={`Source: ${sourceType || 'manual'}`}>{icons[sourceType] || icons.manual}</span>;
}
```

### Updated collapsed card JSX

```jsx
if (!expanded) {
  const truncated = inboxItem.capturedText.length > 100
    ? inboxItem.capturedText.substring(0, 100) + '...'
    : inboxItem.capturedText;

  return (
    <div
      className="p-3 sm:p-4 bg-white border border-gray-200 rounded cursor-pointer hover:border-primary transition-colors"
      onClick={() => setExpanded(true)}
    >
      <p className="text-dark mb-2">{truncated}</p>
      <div className="flex items-center justify-between text-xs text-muted">
        <span>Captured: {friendlyDate(inboxItem.createdAt)}</span>
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
```

**Verification:** Inbox list shows truncated text, friendly dates, status badges. Long captured text truncates with ellipsis.

---

## Step 4: Sort inbox list oldest first

**File:** `src/Alfred.jsx` — inbox loading (~line 788) and anywhere `setInboxItems` sorts.

Change sort to ascending (oldest first):

```js
// Before:
.sort((a, b) => b.createdAt - a.createdAt)

// After:
.sort((a, b) => a.createdAt - b.createdAt)
```

**Verification:** Oldest inbox items appear at the top of the list.

---

## Step 5: Expanded triage view — header and info panel

**File:** `src/Alfred.jsx` — InboxCard expanded view (~line 3002)

Replace the top section of the expanded card. Show captured text (full, not truncated), metadata row with ℹ️ toggle, and collapsible AI info panel.

Add state for the info panel:

```js
const [showAiInfo, setShowAiInfo] = useState(false);
```

Updated top section of expanded card:

```jsx
<div className="p-3 sm:p-4 bg-white border-2 border-primary rounded">
  {/* Captured text */}
  <p className="text-lg text-dark mb-2 whitespace-pre-wrap">
    {inboxItem.capturedText}
  </p>

  {/* Metadata row */}
  <div className="flex items-center justify-between text-xs text-muted mb-3">
    <span>Captured: {friendlyDate(inboxItem.createdAt)}</span>
    <div className="flex items-center gap-2">
      <AiStatusBadge status={inboxItem.aiStatus} />
      {(inboxItem.aiStatus === 'enriched' || inboxItem.aiStatus === 're_enriched') && (
        <button
          onClick={() => setShowAiInfo(!showAiInfo)}
          className="text-muted hover:text-dark transition-colors"
          title="Enrichment details"
        >
          ℹ️
        </button>
      )}
    </div>
  </div>

  {/* AI info panel (collapsible) */}
  {showAiInfo && (inboxItem.aiStatus === 'enriched' || inboxItem.aiStatus === 're_enriched') && (
    <div className="mb-3 p-3 bg-gray-50 border border-gray-200 rounded text-sm">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-muted">Source:</span>
        <SourceIcon sourceType={inboxItem.sourceType} />
        <span>{inboxItem.sourceType || 'manual'}</span>
      </div>
      {inboxItem.aiConfidence != null && (
        <div className="flex items-center gap-2 mb-1">
          <span className="text-muted">Confidence:</span>
          <span>{Math.round(inboxItem.aiConfidence * 100)}%</span>
          <div className="flex-1 max-w-[120px] h-1.5 bg-gray-200 rounded-full">
            <div
              className="h-full bg-primary rounded-full"
              style={{ width: `${inboxItem.aiConfidence * 100}%` }}
            />
          </div>
        </div>
      )}
      {inboxItem.aiReasoning && (
        <div>
          <span className="text-muted">Reasoning:</span>
          <p className="mt-1 text-dark">{inboxItem.aiReasoning}</p>
        </div>
      )}
    </div>
  )}

  <hr className="mb-4 border-gray-200" />

  {/* Accordion sections go here (Steps 6-8) */}
```

**Verification:** Expand an enriched inbox item. Metadata row shows. ℹ️ button toggles the detail panel. Confidence bar renders proportionally.

---

## Step 6: Accordion section — Intention (with Schedule Event and Tags)

**File:** `src/Alfred.jsx` — InboxCard component

### State changes

Replace the checkbox-based state with accordion state. Add these new state variables and update existing ones:

```js
// Section open/closed state — auto-open if suggestions exist
const [intentionOpen, setIntentionOpen] = useState(!!inboxItem.suggestIntent);
const [itemOpen, setItemOpen] = useState(!!inboxItem.suggestItem);
const [collectionOpen, setCollectionOpen] = useState(!!inboxItem.suggestedCollectionId);

// Schedule Event sub-accordion (inside Intention)
const [scheduleEventOpen, setScheduleEventOpen] = useState(!!inboxItem.suggestEvent);
const [eventDate, setEventDate] = useState(inboxItem.suggestedEventDate || '');

// Tags (shared suggestions applied to whichever sections are open)
const [intentTags, setIntentTags] = useState(inboxItem.suggestedTags || []);
const [intentTagInput, setIntentTagInput] = useState('');
```

Update existing initial state to pre-fill from suggestions:

```js
const [intentText, setIntentText] = useState(
  inboxItem.suggestedIntentText || inboxItem.capturedText
);
const [intentRecurrence, setIntentRecurrence] = useState(
  inboxItem.suggestedIntentRecurrence || 'once'
);
const [intentContextId, setIntentContextId] = useState(
  inboxItem.suggestedContextId || ''
);
const [intentItemId, setIntentItemId] = useState(
  inboxItem.suggestedItemId || ''
);
const [intentItemSearch, setIntentItemSearch] = useState(
  // Pre-fill the search field with the existing item's name if suggested
  (inboxItem.suggestedItemId && items?.find(i => i.id === inboxItem.suggestedItemId)?.name) || ''
);
```

### Linked Item disable logic

The Linked Item field in the Intention section should be disabled when "Create Item" section is open (expanded), because the newly created item will auto-link:

```jsx
<div>
  <label className="block text-sm font-medium text-gray-700 mb-1">
    Linked Item (optional)
    {itemOpen && (
      <span className="text-xs text-muted ml-2">— new item will auto-link</span>
    )}
  </label>
  <div className={`relative ${itemOpen ? 'opacity-50 pointer-events-none' : ''}`}>
    {/* existing item search/picker */}
  </div>
</div>
```

### Tags UI

Add a tag input component inside the Intention section:

```jsx
<div>
  <label className="block text-sm font-medium text-gray-700 mb-1">Tags</label>
  <div className="flex flex-wrap items-center gap-1.5 p-2 border border-gray-300 rounded min-h-[40px]">
    {intentTags.map((tag, i) => (
      <span
        key={i}
        className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-bg text-primary text-xs rounded-full"
      >
        {tag}
        <button
          onClick={() => setIntentTags(intentTags.filter((_, idx) => idx !== i))}
          className="hover:text-danger"
        >
          ✕
        </button>
      </span>
    ))}
    <input
      type="text"
      value={intentTagInput}
      onChange={(e) => setIntentTagInput(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && intentTagInput.trim()) {
          e.preventDefault();
          const newTag = intentTagInput.trim().toLowerCase().replace(/\s+/g, '_');
          if (!intentTags.includes(newTag)) {
            setIntentTags([...intentTags, newTag]);
          }
          setIntentTagInput('');
        }
      }}
      placeholder="+ add tag"
      className="flex-1 min-w-[80px] text-sm outline-none border-none bg-transparent"
    />
  </div>
</div>
```

### Schedule Event sub-section

Inside the Intention accordion, after tags:

```jsx
{/* Schedule Event sub-accordion */}
<div className="mt-3">
  <button
    onClick={() => setScheduleEventOpen(!scheduleEventOpen)}
    className={`flex items-center gap-2 w-full text-left text-sm font-medium py-2 ${
      scheduleEventOpen ? 'text-dark' : 'text-muted'
    }`}
  >
    <span>{scheduleEventOpen ? '▾' : '▸'}</span>
    Schedule Event
  </button>
  {scheduleEventOpen && (
    <div className="ml-4 mt-1">
      <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
      <input
        type="date"
        value={eventDate}
        onChange={(e) => setEventDate(e.target.value)}
        className="px-3 py-2 border border-gray-300 rounded text-base"
      />
    </div>
  )}
</div>
```

### Accordion wrapper pattern

Use this pattern for each top-level section. Expanded = full color border + form visible. Collapsed = greyed out, single row:

```jsx
{/* Intention accordion */}
<div className={`border rounded mb-3 ${intentionOpen ? 'border-primary bg-white' : 'border-gray-200 bg-gray-50'}`}>
  <button
    onClick={() => setIntentionOpen(!intentionOpen)}
    className={`flex items-center gap-2 w-full text-left px-4 py-3 font-medium ${
      intentionOpen ? 'text-dark' : 'text-muted'
    }`}
  >
    <span>{intentionOpen ? '▾' : '▸'}</span>
    Intention
  </button>
  {intentionOpen && (
    <div className="px-4 pb-4 space-y-3">
      {/* Name, Context, Linked Item, Recurrence, Tags, Schedule Event fields */}
    </div>
  )}
</div>
```

### handleCancel updates

Update `handleCancel` to reset accordion states:

```js
function handleCancel() {
  setExpanded(false);
  setIntentionOpen(!!inboxItem.suggestIntent);
  setItemOpen(!!inboxItem.suggestItem);
  setCollectionOpen(!!inboxItem.suggestedCollectionId);
  setScheduleEventOpen(!!inboxItem.suggestEvent);
  setEventDate(inboxItem.suggestedEventDate || '');
  setIntentText(inboxItem.suggestedIntentText || inboxItem.capturedText);
  setIntentRecurrence(inboxItem.suggestedIntentRecurrence || 'once');
  setIntentContextId(inboxItem.suggestedContextId || '');
  setIntentContextSearch('');
  setIntentItemId(inboxItem.suggestedItemId || '');
  setIntentItemSearch(
    (inboxItem.suggestedItemId && items?.find(i => i.id === inboxItem.suggestedItemId)?.name) || ''
  );
  setIntentTags(inboxItem.suggestedTags || []);
  setIntentTagInput('');
  setItemName(inboxItem.suggestedItemText || inboxItem.capturedText);
  setItemDescription(inboxItem.suggestedItemDescription || '');
  setItemContextId(inboxItem.suggestedContextId || '');
  setItemElements(inboxItem.suggestedItemElements || []);
}
```

**Verification:**
1. Create a new inbox item — all sections collapsed/greyed since no suggestions.
2. Manually expand Intention — form appears with full color border.
3. Collapse it — greys out.
4. If an enriched item has `suggestIntent: true`, Intention section auto-opens with pre-filled values.
5. Tags can be added/removed. Enter key adds tag.
6. Schedule Event expands inside Intention with date picker.
7. Cancel resets everything back to suggestion defaults (or blank if no suggestions).

---

## Step 7: Accordion section — Item (with Tags)

**File:** `src/Alfred.jsx` — InboxCard component

### State updates

Update Item section initial state to pre-fill from suggestions:

```js
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
  inboxItem.suggestedItemElements || []
);
const [itemTags, setItemTags] = useState(inboxItem.suggestedTags || []);
const [itemTagInput, setItemTagInput] = useState('');
```

### Item accordion JSX

Same accordion wrapper pattern as Intention. Include Name, Description, Context (dropdown), Elements (existing drag/drop editor), and Tags (same chip input pattern as Intention section).

```jsx
{/* Item accordion */}
<div className={`border rounded mb-3 ${itemOpen ? 'border-primary bg-white' : 'border-gray-200 bg-gray-50'}`}>
  <button
    onClick={() => setItemOpen(!itemOpen)}
    className={`flex items-center gap-2 w-full text-left px-4 py-3 font-medium ${
      itemOpen ? 'text-dark' : 'text-muted'
    }`}
  >
    <span>{itemOpen ? '▾' : '▸'}</span>
    Item
  </button>
  {itemOpen && (
    <div className="px-4 pb-4 space-y-3">
      {/* Name input */}
      {/* Description textarea */}
      {/* Context dropdown */}
      {/* Elements editor (existing code, move from current Item form) */}
      {/* Tags chip input (same pattern as Intention tags, using itemTags/setItemTags) */}
    </div>
  )}
</div>
```

The elements editor is the existing drag-and-drop element builder — move it from the old checkbox-revealed form into this accordion body unchanged.

**Verification:**
1. Item section auto-opens when `suggestItem: true` with pre-filled name/description/elements.
2. Elements drag/drop still works.
3. Tags can be added/removed.
4. Opening Item section disables the Linked Item field in the Intention section.
5. Closing Item section re-enables the Linked Item field.

---

## Step 8: Accordion section — Add to Collection

**File:** `src/Alfred.jsx` — InboxCard component

### New props

InboxCard needs access to collections. Update the component signature and the parent call:

```jsx
// Component signature:
function InboxCard({
  inboxItem,
  contexts,
  items,
  collections,  // NEW
  onSave,
  onArchive,
}) {

// Parent call (~line 2170):
<InboxCard
  key={inboxItem.id}
  inboxItem={inboxItem}
  contexts={contexts}
  items={items}
  collections={collections}  // NEW
  onSave={handleInboxSave}
  onArchive={archiveInboxItem}
/>
```

### State

```js
const [collectionOpen, setCollectionOpen] = useState(!!inboxItem.suggestedCollectionId);
const [selectedCollectionId, setSelectedCollectionId] = useState(
  inboxItem.suggestedCollectionId || ''
);
const [collectionItemId, setCollectionItemId] = useState(
  inboxItem.suggestedItemId || ''
);
const [collectionItemSearch, setCollectionItemSearch] = useState(
  (inboxItem.suggestedItemId && items?.find(i => i.id === inboxItem.suggestedItemId)?.name) || ''
);
const [collectionQuantity, setCollectionQuantity] = useState('1');
```

### Collection accordion JSX

```jsx
{/* Add to Collection accordion */}
<div className={`border rounded mb-3 ${collectionOpen ? 'border-primary bg-white' : 'border-gray-200 bg-gray-50'}`}>
  <button
    onClick={() => setCollectionOpen(!collectionOpen)}
    className={`flex items-center gap-2 w-full text-left px-4 py-3 font-medium ${
      collectionOpen ? 'text-dark' : 'text-muted'
    }`}
  >
    <span>{collectionOpen ? '▾' : '▸'}</span>
    Add to Collection
  </button>
  {collectionOpen && (
    <div className="px-4 pb-4 space-y-3">
      {/* Collection dropdown */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Collection</label>
        <select
          value={selectedCollectionId}
          onChange={(e) => setSelectedCollectionId(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded text-base"
        >
          <option value="">Select collection...</option>
          {collections.map((col) => (
            <option key={col.id} value={col.id}>{col.name}</option>
          ))}
        </select>
      </div>

      {/* Item — disabled if Create Item section is open */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Item
          {itemOpen && (
            <span className="text-xs text-muted ml-2">— new item will be added</span>
          )}
        </label>
        <div className={`relative ${itemOpen ? 'opacity-50 pointer-events-none' : ''}`}>
          {/* Item search/autocomplete picker — same pattern as Intention's Linked Item */}
        </div>
      </div>

      {/* Quantity */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
        <input
          type="text"
          value={collectionQuantity}
          onChange={(e) => setCollectionQuantity(e.target.value)}
          className="w-32 px-3 py-2 border border-gray-300 rounded text-base"
        />
      </div>
    </div>
  )}
</div>
```

**Verification:**
1. Add to Collection section auto-opens when `suggestedCollectionId` is set.
2. Collection dropdown shows available collections.
3. Item field is disabled when Item section is expanded.
4. Item field re-enables when Item section is collapsed.
5. Quantity defaults to "1".

---

## Step 9: Enrich / Re-enrich button

**File:** `src/Alfred.jsx` — InboxCard component

### State

```js
const [enriching, setEnriching] = useState(false);
```

### Enrich function

Add inside InboxCard:

```js
async function handleEnrich() {
  setEnriching(true);

  // Optimistically update AI status
  const previousStatus = inboxItem.aiStatus;

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

    if (!response.ok) {
      throw new Error(`Enrich failed: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      // Update the inbox item in parent state with new suggestions
      const updatedItem = {
        ...inboxItem,
        aiStatus: result.status,
        ...result.suggestions,
      };
      onEnrich(inboxItem.id, updatedItem);
    } else {
      throw new Error(result.error || 'Enrichment failed');
    }
  } catch (error) {
    console.error('Enrich error:', error);
    alert('Enrichment failed: ' + error.message);
    // Status resets — the Edge Function handles DB reset, we just revert local state
  } finally {
    setEnriching(false);
  }
}
```

### New prop: onEnrich

InboxCard needs a new `onEnrich` callback to update the parent's inbox state:

```jsx
function InboxCard({
  inboxItem,
  contexts,
  items,
  collections,
  onSave,
  onArchive,
  onEnrich,  // NEW
}) {
```

In the parent component, add the handler and pass it:

```js
function handleInboxEnrich(inboxItemId, updatedItem) {
  setInboxItems((prev) =>
    prev.map((item) => (item.id === inboxItemId ? updatedItem : item))
  );
}

// In JSX:
<InboxCard
  ...
  onEnrich={handleInboxEnrich}
/>
```

### Re-enrich: save edits before enriching

When Re-enrich is clicked, we need to save the user's edits back to the inbox record first (so the Edge Function can use them as context), then call enrich:

```js
async function handleReEnrich() {
  // Save current form state back to inbox record
  const updatedInbox = {
    ...inboxItem,
    capturedText: inboxItem.capturedText, // captured text doesn't change
    suggestedContextId: intentContextId || null,
    suggestIntent: intentionOpen,
    suggestedIntentText: intentText,
    suggestedIntentRecurrence: intentRecurrence,
    suggestItem: itemOpen,
    suggestedItemText: itemName,
    suggestedItemDescription: itemDescription,
    suggestedItemElements: itemElements.length > 0 ? itemElements : null,
    suggestEvent: scheduleEventOpen,
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
```

### Button JSX

In the action buttons area at the bottom of the expanded card:

```jsx
<div className="flex items-center justify-between mt-4">
  <div className="flex gap-2">
    {/* Enrich / Re-enrich button */}
    {inboxItem.aiStatus !== 'in_progress' && !enriching && (
      <button
        onClick={inboxItem.aiStatus === 'not_started' ? handleEnrich : handleReEnrich}
        className="px-4 py-2.5 min-h-[44px] bg-purple-600 hover:bg-purple-700 text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
      >
        {inboxItem.aiStatus === 'not_started'
          ? 'Enrich (Sonnet)'
          : 'Re-enrich (Opus)'}
      </button>
    )}
    {(inboxItem.aiStatus === 'in_progress' || enriching) && (
      <button
        disabled
        className="px-4 py-2.5 min-h-[44px] bg-amber-100 text-amber-700 rounded-lg cursor-not-allowed"
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
          ? 'bg-primary hover:bg-primary-hover text-white'
          : 'bg-gray-200 text-gray-400 cursor-not-allowed'
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
```

**Verification:**
1. New inbox item shows "Enrich (Sonnet)" button.
2. Clicking Enrich shows "Enriching..." disabled state.
3. On success, suggestions populate and sections auto-open.
4. Enriched item shows "Re-enrich (Opus)" button.
5. Re-enrich saves current form edits, then calls enrich.
6. On error, alert shows and button returns to previous state.

---

## Step 10: Update handleSave for new triage data

**File:** `src/Alfred.jsx` — InboxCard `handleSave` and parent `handleInboxSave`

### Updated handleSave in InboxCard

Replace the old checkbox-based logic. Now accordion open state determines what gets created:

```js
function handleSave() {
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
          recurrence: intentRecurrence,
          itemId: intentItemId || null,
          tags: intentTags,
          createEvent: scheduleEventOpen,
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
```

### Updated handleInboxSave in parent

```js
async function handleInboxSave(inboxItemId, triageData) {
  const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
  if (!inboxItem) return;
  return withLoading('Saving...', async () => {
    let createdItemId = null;

    // Create item if section was open
    if (triageData.createItem && triageData.itemData) {
      const newItem = {
        id: uid(),
        user_id: user.id,
        name: triageData.itemData.name,
        description: triageData.itemData.description || '',
        contextId: triageData.itemData.contextId,
        elements: triageData.itemData.elements || [],
        tags: triageData.itemData.tags || [],
        isCaptureTarget: false,
        createdAt: Date.now(),
      };

      const context = contexts.find((c) => c.id === newItem.contextId);
      const isShared = context?.shared || false;
      await storage.set(`item:${newItem.id}`, newItem, isShared);
      setItems((prev) => [...prev, newItem]);
      createdItemId = newItem.id;
    }

    // Create intention if section was open
    if (triageData.createIntention && triageData.intentionData) {
      const intentionItemId =
        triageData.intentionData.itemId || createdItemId;
      const newIntent = {
        id: uid(),
        user_id: user.id,
        text: triageData.intentionData.text,
        createdAt: Date.now(),
        isIntention: true,
        isItem: !!intentionItemId,
        archived: false,
        itemId: intentionItemId,
        contextId: triageData.intentionData.contextId,
        recurrence: triageData.intentionData.recurrence || 'once',
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
          createdAt: Date.now(),
          text: triageData.intentionData.text,
        };
        await storage.set(`event:${newEvent.id}`, newEvent);
        setEvents((prev) => [...prev, newEvent]);
      }
    }

    // Add to collection if section was open
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
              addedAt: Date.now(),
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
    const updated = { ...inboxItem, archived: true, triagedAt: Date.now() };
    await storage.set(`inbox:${inboxItem.id}`, updated);
    setInboxItems((prev) => prev.filter((i) => i.id !== inboxItemId));
  });
}
```

**Verification:**
1. Open Intention only → Save creates intent (and event if scheduled). No item or collection.
2. Open Item only → Save creates item with tags. No intent.
3. Open Item + Intention → Save creates item first, then intent linked to new item.
4. Open Add to Collection + Item → Save creates item, adds it to collection.
5. Open Add to Collection only with existing item → Save adds existing item to collection.
6. All three open → Save creates item, creates intent linked to new item, adds new item to collection.
7. No sections open → Save button disabled.
8. After Save, inbox item disappears from list (archived).

---

## Step 11: Update InboxCard state when enrichment response arrives

**File:** `src/Alfred.jsx` — InboxCard component

When `onEnrich` updates the parent's `inboxItems` state, the InboxCard receives a new `inboxItem` prop. But the local form state has already been initialized from the old prop values. We need a `useEffect` to update local state when suggestions arrive:

```js
// Re-sync local state when enrichment populates suggestions
useEffect(() => {
  if (inboxItem.aiStatus === 'enriched' || inboxItem.aiStatus === 're_enriched') {
    // Open sections based on suggestions
    if (inboxItem.suggestIntent) {
      setIntentionOpen(true);
      setIntentText(inboxItem.suggestedIntentText || inboxItem.capturedText);
      setIntentRecurrence(inboxItem.suggestedIntentRecurrence || 'once');
      setIntentContextId(inboxItem.suggestedContextId || '');
      setIntentTags(inboxItem.suggestedTags || []);
    }
    if (inboxItem.suggestItem) {
      setItemOpen(true);
      setItemName(inboxItem.suggestedItemText || inboxItem.capturedText);
      setItemDescription(inboxItem.suggestedItemDescription || '');
      setItemContextId(inboxItem.suggestedContextId || '');
      setItemElements(inboxItem.suggestedItemElements || []);
      setItemTags(inboxItem.suggestedTags || []);
    }
    if (inboxItem.suggestedCollectionId) {
      setCollectionOpen(true);
      setSelectedCollectionId(inboxItem.suggestedCollectionId);
    }
    if (inboxItem.suggestEvent) {
      setScheduleEventOpen(true);
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
}, [inboxItem.aiStatus]);
```

**Verification:**
1. Expand an un-enriched inbox item.
2. Click "Enrich (Sonnet)".
3. After enrichment completes, sections auto-open and fields populate without needing to close/reopen the card.

---

## Step 12: Cleanup — remove old checkbox UI remnants

**File:** `src/Alfred.jsx` — InboxCard component

Remove:
- Old `createIntention` / `createItem` state variables (replaced by `intentionOpen` / `itemOpen`)
- Old checkbox JSX (the `<label className="flex items-center gap-2">` blocks)
- Old conditional form rendering that depended on `createIntention` / `createItem`

Ensure all references to `createIntention` / `createItem` in `handleSave` and `handleCancel` now use the accordion state variables (`intentionOpen` / `itemOpen` / `collectionOpen`).

**Verification:**
1. Full regression test: capture → expand → sections work → enrich → suggestions populate → edit → save.
2. No console errors or warnings about unused variables.
3. Cancel resets all fields properly.
4. Archive still works from expanded view.

---

## Step 13: Handle camelCase ↔ snake_case for new suggestion fields from enrich response

**File:** `src/Alfred.jsx` — `handleEnrich` function in InboxCard

The Edge Function returns snake_case field names in `result.suggestions` (e.g., `suggested_context_id`), but the app uses camelCase internally. Use the storage adapter's `toCamelCase` to convert:

```js
if (result.success) {
  const camelSuggestions = storage.toCamelCase(result.suggestions);
  const updatedItem = {
    ...inboxItem,
    aiStatus: result.status,
    ...camelSuggestions,
  };
  onEnrich(inboxItem.id, updatedItem);
}
```

Note: `storage` is defined at module scope, so it's accessible inside InboxCard. If not, pass `toCamelCase` as a prop or extract it to a standalone utility.

**Verification:** After enrichment, field names in state are camelCase (e.g., `suggestedContextId` not `suggested_context_id`). Form fields populate correctly.
