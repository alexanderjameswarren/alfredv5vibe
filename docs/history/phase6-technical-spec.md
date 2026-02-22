# Alfred v5 - Phase 6 Technical Specification
## Collections, Tags, and Advanced Item Features

**Version:** 1.0  
**Date:** February 18, 2026  
**Scope:** Data model updates, UI enhancements, and core functionality (excludes AI parsing)

---

## Table of Contents

1. [Overview](#overview)
2. [Data Model Changes](#data-model-changes)
3. [Item Collections](#item-collections)
4. [Tags System](#tags-system)
5. [Item References (Composable Items)](#item-references-composable-items)
6. [Deep Clone Functionality](#deep-clone-functionality)
7. [Three-State Execution Steps](#three-state-execution-steps)
8. [UI Components](#ui-components)
9. [Business Logic](#business-logic)
10. [Migration Strategy](#migration-strategy)

---

## Overview

Phase 6 introduces four major feature sets to Alfred:

1. **Item Collections** - Lightweight, mutable lists of items (e.g., grocery lists, packing lists)
2. **Tags** - Cross-cutting classification system for items, intents, and contexts
3. **Composable Items** - Items can reference other items in their elements
4. **Enhanced Execution** - Three-state steps (not started / in progress / complete)

### Key Principles

- Collections represent **ephemeral working state** (what you currently need)
- Items remain the **permanent catalog** (reusable templates)
- Tags provide **cross-cutting views** across contexts
- Item references enable **composition and reuse**
- Deep cloning ensures **project independence**

---

## Data Model Changes

### New Tables

#### `item_collections`

```sql
CREATE TABLE item_collections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  context_id TEXT,
  shared BOOLEAN DEFAULT false,
  is_capture_target BOOLEAN DEFAULT false,
  items JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_item_collections_user_id ON item_collections(user_id);
CREATE INDEX idx_item_collections_context_id ON item_collections(context_id);
CREATE INDEX idx_item_collections_shared ON item_collections(shared);
```

**items JSONB structure:**
```json
[
  {
    "item_id": "milk_item_id",
    "quantity": "2 gallons"
  },
  {
    "item_id": "eggs_item_id",
    "quantity": ""
  }
]
```

**Notes:**
- `items` array stores objects (not just IDs) to support quantity field
- Order in array = display order
- `quantity` is freeform text (e.g., "2 lbs", "1 gallon", "")

ALTER TABLE item_collections ENABLE ROW LEVEL SECURITY;

-- Users can view their own collections
CREATE POLICY "Users can view their own collections"
  ON item_collections FOR SELECT
  USING (user_id = auth.uid()::TEXT);

-- Users can view shared collections (anyone authenticated can see shared collections)
CREATE POLICY "Users can view shared collections"
  ON item_collections FOR SELECT
  USING (shared = true);

-- Users can modify their own collections
CREATE POLICY "Users can modify their own collections"
  ON item_collections FOR ALL
  USING (user_id = auth.uid()::TEXT);

-- Users can modify shared collections (anyone can edit shared collections)
CREATE POLICY "Users can modify shared collections"
  ON item_collections FOR UPDATE
  USING (shared = true);
```

---

### Modified Tables

#### `items`

```sql
-- Add tags column
ALTER TABLE items 
ADD COLUMN tags JSONB DEFAULT '[]'::jsonb;

-- Add index for tag queries
CREATE INDEX idx_items_tags ON items USING gin(tags);
```

**tags structure:** Simple array of strings
```json
["vegetarian", "quick", "dinner"]
```

**elements structure (enhanced):** Elements can now reference other items
```json
[
  {
    "name": "Boil water",
    "displayType": "step",
    "quantity": "2 cups",
    "description": "Bring to rolling boil"
  },
  {
    "name": "Shrimp Cocktail",
    "displayType": "bullet",
    "itemId": "shrimp_cocktail_recipe_id"
  }
]
```

**New element fields:**
- `itemId` (optional) - Reference to another Item for composition

#### `intents`

```sql
-- Add tags and collection reference
ALTER TABLE intents 
ADD COLUMN tags JSONB DEFAULT '[]'::jsonb,
ADD COLUMN collection_id TEXT;

-- Add index for tag queries
CREATE INDEX idx_intents_tags ON intents USING gin(tags);
CREATE INDEX idx_intents_collection_id ON intents(collection_id);
```

#### `contexts`

```sql
-- Add tags
ALTER TABLE contexts 
ADD COLUMN tags JSONB DEFAULT '[]'::jsonb;

-- Add index for tag queries
CREATE INDEX idx_contexts_tags ON contexts USING gin(tags);
```

#### `events`

```sql
-- Add collection reference
ALTER TABLE events
ADD COLUMN collection_id TEXT;

CREATE INDEX idx_events_collection_id ON events(collection_id);
```

#### `executions`

```sql
-- Add collection support and execution state tracking
ALTER TABLE executions
ADD COLUMN collection_id TEXT,
ADD COLUMN completed_item_ids JSONB DEFAULT '[]'::jsonb;

CREATE INDEX idx_executions_collection_id ON executions(collection_id);
```

**elements structure (enhanced):** Steps can track in-progress state
```json
[
  {
    "name": "Add tags JSONB column",
    "displayType": "step",
    "isCompleted": false,
    "inProgress": false,
    "startedAt": null,
    "completedAt": null,
    "sourceItemId": "parent_item_id"
  }
]
```

**New element fields:**
- `inProgress` (boolean) - Step has been started but not completed
- `startedAt` (timestamp) - When step was started

---

## Item Collections

### Purpose

Item Collections represent **ephemeral, mutable lists** of items from the permanent catalog. Primary use cases:

- **Grocery shopping** - Weekly list of items to buy
- **Packing lists** - Trip-specific items to pack
- **To-do lists** - Transient tasks that get completed and removed

### Key Characteristics

- **Ephemeral membership** - Items added/removed frequently
- **Mutable during execution** - Collections change as work progresses
- **Quantity support** - Each item can have a quantity (freeform text)
- **Shareable** - Collections can be shared between household members

### Data Flow

```
Item Collection (working state)
    ↓ referenced by
Intention (planning)
    ↓ creates
Event (scheduling)
    ↓ creates
Execution (doing)
    ↓ on close, mutates
Item Collection (removes completed items)
```

### Collection Lifecycle

1. **Creation:** User creates collection "Weekly Groceries"
2. **Population:** Add items from catalog with quantities
   - Milk (2 gallons)
   - Eggs (1 dozen)
   - Bread (1 loaf)
3. **Intention:** Create intention "Grocery shopping" → references collection
4. **Event:** Schedule "Tuesday TJ's trip"
5. **Execution:** 
   - Start execution (reads collection items)
   - User checks off Milk, Eggs (leaves Bread unchecked)
   - User edits Milk quantity: 2 gallons → 1 gallon (updates collection immediately)
6. **Close Execution:**
   - Remove completed items (Milk, Eggs) from collection
   - Bread remains with original quantity

### Execution with Collections

**Schema:**
```javascript
execution: {
  collection_id: "weekly_groceries_id",
  completed_item_ids: ["milk_id", "eggs_id"],  // Items checked off
  status: "active"
}
```

**Key behavior:**
- Execution does NOT copy collection items
- Execution reads from collection in real-time (allows live updates)
- Execution tracks completed item IDs (simple array)
- On close, completed items are removed from collection

### Concurrent Editing

**Scenario:** User shopping at store, spouse adds item from home

**Flow:**
1. User starts execution (reads collection: milk, eggs)
2. Spouse adds "cheese" to collection
3. User's UI polls/subscribes and refreshes
4. "Cheese" appears on user's shopping list (unchecked)
5. User can buy cheese or leave it

**Implementation:** UI polls collection periodically or uses Supabase realtime subscriptions

---
### Collection Size Limits

To maintain performance and usability:

**Soft limit:** 50 items per collection
- Show warning when approaching: "This collection has 48 items. Consider splitting into multiple collections."
- Allow continuing to 200

**Hard limit:** 200 items per collection
- Prevent adding more items
- Show error: "Collection is at maximum capacity (200 items). Remove items or create a new collection."

**Rationale:**
- Collections are ephemeral working lists, not permanent storage
- Large collections indicate misuse (should be separate collections or items)
- Prevents performance issues with polling/rendering



## Tags System

### Purpose

Tags provide **cross-cutting classification** that spans contexts. They enable:

- **People-based views** - All tasks related to "Dani" (interior designer)
- **Client-based views** - All work for "ActBlue" across projects
- **Theme-based views** - All "urgent" items, all "quick" tasks
- **Multi-dimensional search** - Filter by tag combinations

### Tag Locations

Tags can be applied to:
- **Items** - Recipes, procedures, reference materials
- **Intents** - Tasks, reminders, projects
- **Contexts** - Organizational buckets
- **Executions** (inherited) - From items/intents during execution

### Tag Format

- **Lowercase** - All tags stored lowercase for consistency
- **Underscore separation** - Use `_` for multi-word tags (e.g., `interior_designer`)
- **No special characters** - Alphanumeric and underscore only
- **Array storage** - JSONB array in database

**Example:**
```json
["dani", "interior_designer", "bathroom", "urgent"]
```

### Tag Inheritance in Executions

When execution starts, it inherits tags from:
1. Source intent's tags
2. Source item(s) tags (if item-based execution)
3. Referenced items' tags (if composable item with children)

**Example:**
```javascript
// Intention
intention.tags = ["dga", "actblue"];

// Item
item.tags = ["salesforce", "technical"];

// Item references child item
childItem.tags = ["deployment", "production"];

// Resulting execution
execution.tags = ["dga", "actblue", "salesforce", "technical", "deployment", "production"];
```

### Tag-Based Views

**UI requirement:** Filter items/intents by selected tag(s)

**Examples:**
- View all intents tagged `#dani`
- View all items tagged `#actblue`
- View all items tagged `#vegetarian` AND `#quick`
- View all executions (historical) tagged `#dga` (for time tracking)

### Tag Display

- **In lists:** Show as pills (e.g., `dani` `bathroom` `urgent`)
- **In filters:** Show as clickable buttons with count (e.g., `#dani (5)`)
- **In references:** Use `#` prefix when displaying (e.g., "#dani")
- **In storage:** No `#` prefix in database (just the tag string)

---

## Item References (Composable Items)

### Purpose

Items can reference other items in their elements, enabling:

- **Meals** - Compose multiple recipes into a menu
- **Workflows** - Compose multiple procedures into a process
- **Templates** - Create reusable, composable structures

### Element Enhancement

Elements gain optional `itemId` field:

```javascript
{
  name: "Shrimp Cocktail",
  displayType: "bullet",
  itemId: "shrimp_cocktail_recipe_id",
  quantity: "serves 4"  // Optional override
}
```

### Flattening on Execution

When execution starts from a composable item, all referenced items are **flattened into a single element list**:

**Parent Item: "Dinner Party Menu"**
```javascript
elements: [
  { name: "First Course", displayType: "header" },
  { name: "Shrimp Cocktail", displayType: "bullet", itemId: "shrimp_recipe_id" },
  { name: "Second Course", displayType: "header" },
  { name: "Steak", displayType: "bullet", itemId: "steak_recipe_id" }
]
```

**Child Item: "Shrimp Cocktail"**
```javascript
elements: [
  { name: "Peel shrimp", displayType: "step" },
  { name: "Make cocktail sauce", displayType: "step" },
  { name: "Chill and serve", displayType: "step" }
]
```

**Flattened Execution Elements:**
```javascript
[
  { name: "First Course", displayType: "header", indent: 0 },
  { name: "Shrimp Cocktail", displayType: "header", sourceItemId: "shrimp_recipe_id", indent: 1 },
  { name: "Peel shrimp", displayType: "step", isCompleted: false, indent: 2 },
  { name: "Make cocktail sauce", displayType: "step", isCompleted: false, indent: 2 },
  { name: "Chill and serve", displayType: "step", isCompleted: false, indent: 2 },
  { name: "Second Course", displayType: "header", indent: 0 },
  { name: "Steak", displayType: "header", sourceItemId: "steak_recipe_id", indent: 1 },
  // ... steak steps
]
```

### Flattening Algorithm

```javascript
async function flattenElements(elements, depth = 0, visitedItemIds = new Set()) {
  const MAX_DEPTH = 3;
  const flattened = [];
  
  for (const element of elements) {
    if (element.itemId) {
      // Check for circular reference
      if (visitedItemIds.has(element.itemId)) {
        flattened.push({
          name: `${element.name} (circular reference)`,
          displayType: "bullet",
          indent: depth
        });
        continue;
      }
      
      // Check max depth
      if (depth >= MAX_DEPTH) {
        flattened.push({
          name: `${element.name} (max depth reached)`,
          displayType: "bullet",
          indent: depth
        });
        continue;
      }
      
      // Fetch referenced item
      const referencedItem = await storage.get(`items:${element.itemId}`);
      
      if (!referencedItem) {
        flattened.push({
          name: `${element.name} (item not found)`,
          displayType: "bullet",
          indent: depth
        });
        continue;
      }
      
      // Add header for referenced item
      flattened.push({
        name: element.name,
        displayType: "header",
        sourceItemId: element.itemId,
        indent: depth
      });
      
      // Recursively flatten child elements
      visitedItemIds.add(element.itemId);
      const childElements = await flattenElements(
        referencedItem.elements,
        depth + 1,
        visitedItemIds
      );
      flattened.push(...childElements);
      
    } else {
      // Regular element (no item reference)
      flattened.push({
        ...element,
        sourceItemId: null,
        isCompleted: element.displayType === "step" ? false : undefined,
        indent: depth
      });
    }
  }
  
  return flattened;
}
```

### Item Reference Display

**In Item Editor:**
- Elements with `itemId` should be visually distinct
- Use teal color: `text-teal-600`
- Show arrow: `→ Shrimp Cocktail`
- Clickable to navigate to referenced item

**In Item Detail View:**
- Show "References" section listing all child items
- Show "Used In" section listing all parent items
- Both should be clickable links

### Circular Reference Prevention

**Problem:** Item A references Item B, which references Item A

**Solution:** Track visited items during flattening, show error message if circular reference detected

---

## Deep Clone Functionality

### Purpose

Create complete, independent copies of items (including all referenced child items) for project-specific customization.

### Use Cases

- **Project templates** - Clone "Salesforce Fix Template" → "DGA Login Bug Fix"
- **Meal planning** - Clone "Standard Dinner" → "Anniversary Dinner" (customize)
- **Procedures** - Clone standard procedure, customize for specific client

### Clone Behavior

**Deep Clone (only option):**
- Copies the item
- Recursively copies all referenced child items
- Updates references to point to new copies
- Each clone is completely independent

### Clone UI

**Item Detail View:**
```
[Edit] [Clone] [Delete]
```

**Clone Dialog:**
```
┌─────────────────────────────────────┐
│ Clone: Salesforce Fix Template     │
├─────────────────────────────────────┤
│ New name: [                    ]   │
│                                     │
│ This will create a complete copy   │
│ of this item and all referenced    │
│ items (deep clone).                │
│                                     │
│ [Clone] [Cancel]                   │
└─────────────────────────────────────┘
```

### Clone Algorithm

```javascript
async function deepCloneItem(sourceItemId, newName, userId) {
  const sourceItem = await storage.get(`items:${sourceItemId}`);
  const clonedChildItems = new Map(); // sourceItemId → clonedItemId
  
  // Recursive function to clone children first
  async function cloneChildren(item, visitedIds = new Set()) {
    for (const element of item.elements) {
      if (element.itemId && !clonedChildItems.has(element.itemId)) {
        // Prevent infinite loops
        if (visitedIds.has(element.itemId)) continue;
        visitedIds.add(element.itemId);
        
        const childItem = await storage.get(`items:${element.itemId}`);
        if (!childItem) continue;
        
        // Clone child's children first (depth-first)
        await cloneChildren(childItem, visitedIds);
        
        // Clone this child
        const clonedChild = {
          id: generateId(),
          user_id: userId,
          name: childItem.name,
          description: childItem.description,
          context_id: childItem.context_id,
          tags: [...childItem.tags],
          elements: childItem.elements.map(el => {
            // Update references to point to cloned children
            if (el.itemId && clonedChildItems.has(el.itemId)) {
              return { ...el, itemId: clonedChildItems.get(el.itemId) };
            }
            return { ...el };
          }),
          created_at: Date.now()
        };
        
        await storage.set(`items:${clonedChild.id}`, clonedChild);
        clonedChildItems.set(element.itemId, clonedChild.id);
      }
    }
  }
  
  // Clone all children
  await cloneChildren(sourceItem);
  
  // Clone parent with updated references
  const clonedItem = {
    id: generateId(),
    user_id: userId,
    name: newName,
    description: sourceItem.description,
    context_id: sourceItem.context_id,
    tags: [...sourceItem.tags],
    elements: sourceItem.elements.map(el => {
      if (el.itemId && clonedChildItems.has(el.itemId)) {
        return { ...el, itemId: clonedChildItems.get(el.itemId) };
      }
      return { ...el };
    }),
    created_at: Date.now()
  };
  
  await storage.set(`items:${clonedItem.id}`, clonedItem);
  
  return clonedItem;
}
```

### Post-Clone Behavior

After cloning, automatically open the new clone in edit mode so user can immediately customize.

---

## Three-State Execution Steps

### Purpose

Track step execution state more precisely:
1. **Not Started** - Haven't begun
2. **In Progress** - Started but not verified/complete
3. **Complete** - Verified and done

### Use Cases

- **Claude CLI development** - Mark step as started, hand off to Claude, verify, mark complete
- **Cooking** - Mark "Chill 2 hours" as in progress when put in fridge
- **Long-running tasks** - Track what's actively happening vs waiting

### Element State

```javascript
{
  name: "Add tags JSONB column",
  displayType: "step",
  isCompleted: false,
  inProgress: false,      // NEW
  startedAt: null,        // NEW - timestamp
  completedAt: null
}
```

### UI Design

**Not Started:**
```
☐ Add tags JSONB column                           Start
```
- Checkbox (unchecked)
- Element name (normal)
- "Start" link (right, gray, underlined)

**In Progress:**
```
☐ Add tags JSONB column                           Reset
  ⏱ Started 15m ago
```
- Checkbox (unchecked)
- Element name (teal, medium weight)
- Timer indicator (below, indented, teal)
- "Reset" link (right, gray, underlined)

**Complete:**
```
☑ Add tags JSONB column
```
- Checkbox (checked)
- Element name (line-through, gray)
- No links

### Interaction Flow

**From Not Started:**
- Click "Start" → sets `inProgress: true`, `startedAt: Date.now()`
- Checkbox still unchecked

**From In Progress:**
- Click checkbox → sets `isCompleted: true`, `inProgress: false`, `completedAt: Date.now()`
- Click "Reset" → sets `inProgress: false`, `startedAt: null`

**From Complete:**
- Click checkbox → resets to Not Started (clears all state)

### Timer Display

```javascript
function formatRelativeTime(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
```

### Mobile Responsive

On mobile, maintain same interaction but optimize spacing:
- Stack elements vertically if needed
- Keep "Start"/"Reset" accessible
- Timer always below element name

---

## UI Components

### ItemCollectionList

**Purpose:** Display list of all collections

**Features:**
- Filter by context
- Show item count per collection
- Shared indicator (icon or badge)
- Click to view/edit

### ItemCollectionDetail

**Purpose:** View/edit a specific collection

**Features:**
- Add items from catalog (searchable)
- Remove items from collection
- Edit quantities inline
- Reorder items (drag and drop)
- Share/unshare collection

### ItemCollectionEditor

**Purpose:** Add items to collection

**Features:**
- Search items by name/tag/context
- Show item details on hover
- Add with optional quantity
- Bulk add (select multiple)

### TagFilter

**Purpose:** Filter items/intents by tag(s)

**Features:**
- Show all unique tags with counts
- Single or multi-select
- Clear all filters
- Search tags by name

### TagInput

**Purpose:** Add/remove tags from item/intent/context

**Features:**
- Comma-separated input
- Tag pills (removable)
- Autocomplete from existing tags
- Lowercase normalization

### ItemReferenceDisplay

**Purpose:** Show item references in different contexts

**Features:**
- Visual distinction (teal color, arrow)
- Clickable to navigate
- Show in element lists
- Show in "References" / "Used In" sections

### StepRow (Enhanced)

**Purpose:** Display execution step with three states

**Features:**
- Checkbox for completion
- "Start"/"Reset" link
- Timer display for in-progress
- Visual state indicators (color, weight)
- Mobile responsive

### CloneDialog

**Purpose:** Clone an item (deep copy)

**Features:**
- Name input for clone
- Explanation of deep clone behavior
- Cancel/Clone actions
- Post-clone navigation to editor

---

## Business Logic

### Collection Mutations During Execution

**Rule:** Only executions mutate collections

**When:**
- User edits quantity → immediate write to collection
- User marks item complete → tracked in `execution.completed_item_ids`
- Execution closes → completed items removed from collection

**Why this works:**
- Collection represents "current working state"
- Multiple executions can read same collection (with polling/subscriptions)
- Only close action modifies membership

### Tag Normalization

**Rule:** All tags stored lowercase

**Implementation:**
```javascript
function normalizeTags(tags) {
  return tags
    .map(tag => tag.toLowerCase().trim())
    .filter(tag => tag.length > 0)
    .filter((tag, index, self) => self.indexOf(tag) === index); // dedup
}
```

### Element Flattening Limits

**Rule:** Max depth = 3, prevent circular references

**Safety checks:**
- Track visited item IDs during recursion
- Stop at depth 3
- Show error messages for violations

### Execution Tag Collection

**Rule:** Collect tags from all sources

**Sources:**
1. Intent tags
2. Item tags (if item-based)
3. Collection item tags (if collection-based)
4. Referenced item tags (if composable)

**Implementation:** Use Set to deduplicate, convert to array

### Execution History Preservation

**Important:** completed_item_ids persists in closed executions for history.

Even after collection is mutated (items removed), the execution record shows:
- What items were completed
- When they were completed
- Original quantities at time of execution

This enables viewing "what did I buy last week?" even if collection changed.

---

## Migration Strategy

### Phase 1: Database Schema
1. Create `item_collections` table with RLS
2. Add `tags` columns to items, intents, contexts
3. Add GIN indexes for tag queries
4. Add `collection_id` to intents, events, executions
5. Add `completed_item_ids` to executions

### Phase 2: Core Functionality
1. Item collection CRUD operations
2. Tag input/display components
3. Tag filtering logic
4. Item reference support in elements
5. Flattening algorithm for composable items

### Phase 3: Execution Enhancements
1. Three-state step tracking (inProgress, startedAt)
2. Collection-based execution flow
3. Quantity editing during execution
4. Completed items removal on close

### Phase 4: Advanced Features
1. Deep clone functionality
2. Item reference navigation ("Used In" / "References")
3. Tag-based views and filtering
4. Mobile optimizations

### Phase 5: Polish
1. Drag-and-drop reordering
2. Keyboard shortcuts
3. Performance optimizations
4. Error handling refinements

---

## Testing Checklist

### Item Collections
- [ ] Create collection
- [ ] Add items with quantities
- [ ] Remove items from collection
- [ ] Edit quantities
- [ ] Share collection (verify RLS)
- [ ] Create intention from collection
- [ ] Execute collection
- [ ] Edit quantity during execution
- [ ] Complete items during execution
- [ ] Verify completed items removed on close
- [ ] Verify uncompleted items remain

### Tags
- [ ] Add tags to item
- [ ] Add tags to intent
- [ ] Add tags to context
- [ ] Filter items by tag
- [ ] Filter intents by tag
- [ ] Multi-tag filtering
- [ ] Tag normalization (lowercase)
- [ ] Tag deduplication
- [ ] Execution inherits tags from all sources

### Composable Items
- [ ] Create item with child item reference
- [ ] Execute composable item (verify flattening)
- [ ] Navigate from parent to child
- [ ] View "Used In" section
- [ ] View "References" section
- [ ] Circular reference handling
- [ ] Max depth handling
- [ ] Deleted child item handling

### Deep Clone
- [ ] Clone simple item (no references)
- [ ] Clone item with child references
- [ ] Clone item with nested references (depth 2)
- [ ] Verify clone independence (edit clone doesn't affect original)
- [ ] Verify clone independence (edit original doesn't affect clone)

### Three-State Steps
- [ ] Mark step as started
- [ ] Verify timer appears
- [ ] Mark in-progress step as complete
- [ ] Reset in-progress step
- [ ] Uncheck completed step (reset to not started)
- [ ] Mobile responsive behavior

---

## Performance Considerations

### Tag Queries
- GIN indexes on JSONB columns enable fast tag lookups
- Query: `WHERE tags @> '["vegetarian"]'` uses index

### Item Reference Navigation
- Calculate references on-demand (no caching in V1)
- Acceptable for typical catalog sizes (<1000 items)
- Future: Cache parent_item_ids if performance issues

### Collection Polling
- Poll every 5 seconds during active execution
- Use Supabase realtime subscriptions for production
- Debounce quantity edits (300ms)

### Element Flattening
- Cache flattened elements in execution record
- Recalculate only if user explicitly refreshes
- Max depth limit prevents runaway recursion

---

## Security Considerations

### RLS Policies
- All new tables use Row Level Security
- Shared collections visible to allowed_emails users
- Users can only modify their own data (or shared data)




### Input Validation
- Sanitize tag input (alphanumeric + underscore only)
- Validate item references exist before saving
- Prevent self-references in composable items
- Limit tag count per entity (reasonable limit: 20)

### Circular Reference Protection
- Track visited IDs during flattening
- Hard limit on recursion depth (3)
- Show error messages, don't crash

---

## Future Enhancements (Out of Scope)

These features are deferred to future phases:

1. **AI Tag Suggestions** - Claude analyzes captures and suggests tags
2. **Tag Relationships** - Parent/child tag hierarchies (DGA → ActBlue)
3. **Tag Aliases** - Multiple names for same tag (Dani = Designer)
4. **Bulk Tag Cleanup** - System button to analyze and update all tags
5. **MCP Integration** - Claude queries Alfred data via Model Context Protocol
6. **Item List Templates** - Predefined collection templates
7. **Smart Reordering** - AI suggests optimal item order in collections
8. **Collaborative Execution** - Multiple users working on same execution
9. **Execution History Analytics** - Time tracking, completion rates by tag

---

## Glossary

- **Item Collection** - Mutable list of items with quantities (e.g., grocery list)
- **Tag** - Cross-cutting classification label (e.g., "dani", "urgent")
- **Composable Item** - Item that references other items in its elements
- **Deep Clone** - Recursive copy of item and all referenced children
- **Element Flattening** - Converting nested item references into linear step list
- **Three-State Step** - Not Started / In Progress / Complete
- **Ephemeral** - Temporary, changing frequently (vs permanent catalog)

---

**End of Technical Specification**
