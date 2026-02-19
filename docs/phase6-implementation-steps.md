# Alfred v5 - Phase 6 Implementation Steps
## Discrete Execution Blocks for Claude CLI

**Version:** 1.0  
**Date:** February 18, 2026  
**Estimated Total Time:** 15-20 hours  
**Total Steps:** 42

---

## How to Use This Document

Each step is designed to be:
- **Discrete:** 15-30 minutes of focused work
- **Verifiable:** Clear success criteria you can check
- **Ordered:** Dependencies respected
- **Handoff-ready:** Copy step to Claude CLI and execute

**Workflow:**
1. Read step description
2. Copy requirement to Claude CLI
3. Claude implements
4. You verify using provided criteria
5. Mark step complete in Alfred (if you're tracking this work in Alfred!)
6. Move to next step

---

## Database Schema Steps (Steps 1-12)

### Step 1: Create item_collections table

**Requirement:**
Create a new table `item_collections` with the following schema:
- id (TEXT, primary key)
- user_id (TEXT, not null)
- name (TEXT, not null)
- context_id (TEXT, nullable)
- shared (BOOLEAN, default false)
- is_capture_target (BOOLEAN, default false)
- items (JSONB, default empty array)
- created_at (TIMESTAMPTZ, default now())

Create indexes on: user_id, context_id, shared

**Verification:**
```sql
-- Run in Supabase SQL editor
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'item_collections'
ORDER BY ordinal_position;

-- Should show all 8 columns with correct types

-- Verify indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'item_collections';

-- Should show 4 indexes (primary key + 3 custom)
```

---

### Step 2: Add RLS policies to item_collections

**Requirement:**
Enable Row Level Security on item_collections and create 4 policies:
1. "Users can view their own collections" (SELECT, user_id = auth.uid())
2. "Users can view shared collections" (SELECT, shared = true)
3. "Users can modify their own collections" (ALL, user_id = auth.uid())
4. "Users can modify shared collections" (UPDATE, shared = true )

**Verification:**
```sql
-- Check RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename = 'item_collections';
-- Should show rowsecurity = true

-- Check policies exist
SELECT policyname, cmd, qual
FROM pg_policies
WHERE tablename = 'item_collections';
-- Should show 4 policies with correct names
```

---

### Step 3: Add tags column to items table

**Requirement:**
Add a `tags` column to the `items` table:
- Column name: tags
- Type: JSONB
- Default: empty array '[]'::jsonb
- Not null

Create a GIN index on the tags column for fast JSONB queries.

**Verification:**
```sql
-- Check column exists
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'items' AND column_name = 'tags';
-- Should show: tags | jsonb | '[]'::jsonb

-- Check index exists
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'items' AND indexname = 'idx_items_tags';
-- Should show GIN index on tags column
```

---

### Step 4: Add tags column to intents table

**Requirement:**
Add a `tags` column to the `intents` table:
- Column name: tags
- Type: JSONB
- Default: empty array '[]'::jsonb
- Not null

Create a GIN index on the tags column.

**Verification:**
```sql
-- Check column exists
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'intents' AND column_name = 'tags';
-- Should show: tags | jsonb | '[]'::jsonb

-- Check index exists
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'intents' AND indexname = 'idx_intents_tags';
-- Should show GIN index on tags column
```

---

### Step 5: Add tags column to contexts table

**Requirement:**
Add a `tags` column to the `contexts` table:
- Column name: tags
- Type: JSONB
- Default: empty array '[]'::jsonb
- Not null

Create a GIN index on the tags column.

**Verification:**
```sql
-- Check column exists
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'contexts' AND column_name = 'tags';
-- Should show: tags | jsonb | '[]'::jsonb

-- Check index exists
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'contexts' AND indexname = 'idx_contexts_tags';
-- Should show GIN index on tags column
```

---

### Step 6: Add collection_id to intents table

**Requirement:**
Add a `collection_id` column to the `intents` table:
- Column name: collection_id
- Type: TEXT
- Nullable (not all intents reference collections)

Create an index on collection_id for fast lookups.

**Verification:**
```sql
-- Check column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'intents' AND column_name = 'collection_id';
-- Should show: collection_id | text | YES

-- Check index exists
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'intents' AND indexname = 'idx_intents_collection_id';
-- Should show index on collection_id
```

---

### Step 7: Add collection_id to events table

**Requirement:**
Add a `collection_id` column to the `events` table:
- Column name: collection_id
- Type: TEXT
- Nullable

Create an index on collection_id.

**Verification:**
```sql
-- Check column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'events' AND column_name = 'collection_id';
-- Should show: collection_id | text | YES

-- Check index exists
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'events' AND indexname = 'idx_events_collection_id';
-- Should show index on collection_id
```

---

### Step 8: Add collection_id to executions table

**Requirement:**
Add a `collection_id` column to the `executions` table:
- Column name: collection_id
- Type: TEXT
- Nullable

Create an index on collection_id.

**Verification:**
```sql
-- Check column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'executions' AND column_name = 'collection_id';
-- Should show: collection_id | text | YES

-- Check index exists
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'executions' AND indexname = 'idx_executions_collection_id';
-- Should show index on collection_id
```

---

### Step 9: Add completed_item_ids to executions table

**Requirement:**
Add a `completed_item_ids` column to the `executions` table:
- Column name: completed_item_ids
- Type: JSONB
- Default: empty array '[]'::jsonb
- Not null
- Purpose: Track which items in a collection were marked complete during execution

**Verification:**
```sql
-- Check column exists
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'executions' AND column_name = 'completed_item_ids';
-- Should show: completed_item_ids | jsonb | '[]'::jsonb
```

---

### Step 10: Test item_collections table (manual data)

**Requirement:**
Manually insert a test item_collection record to verify table works correctly. Use Supabase SQL editor:

```sql
-- Insert test collection
INSERT INTO item_collections (id, user_id, name, items)
VALUES (
  'test_collection_1',
  (SELECT user_id FROM allowed_emails LIMIT 1),
  'Test Grocery List',
  '[{"item_id": "test_item_1", "quantity": "2 gallons"}]'::jsonb
);

-- Verify it was inserted
SELECT * FROM item_collections WHERE id = 'test_collection_1';

-- Clean up
DELETE FROM item_collections WHERE id = 'test_collection_1';
```

**Verification:**
- INSERT succeeds without errors
- SELECT returns the record with correct JSONB structure
- DELETE succeeds

---

### Step 11: Test tag columns (manual data)

**Requirement:**
Manually test that tag columns work correctly on items, intents, and contexts:

```sql
-- Test items.tags
UPDATE items 
SET tags = '["test_tag", "another_tag"]'::jsonb 
WHERE id = (SELECT id FROM items LIMIT 1);

SELECT id, name, tags FROM items WHERE tags @> '["test_tag"]';
-- Should return the item you just updated

-- Test intents.tags
UPDATE intents 
SET tags = '["urgent", "dani"]'::jsonb 
WHERE id = (SELECT id FROM intents LIMIT 1);

SELECT id, text, tags FROM intents WHERE tags @> '["urgent"]';
-- Should return the intent you just updated

-- Test contexts.tags
UPDATE contexts 
SET tags = '["home", "remodel"]'::jsonb 
WHERE id = (SELECT id FROM contexts LIMIT 1);

SELECT id, name, tags FROM contexts WHERE tags @> '["home"]';
-- Should return the context you just updated
```

**Verification:**
- All UPDATEs succeed
- All tag queries return correct results using GIN index
- JSONB operators (@>) work correctly

---

### Step 12: Test collection references in intents/events/executions

**Requirement:**
Verify foreign key columns work by manually setting collection_id values:

```sql
-- Create a test collection
INSERT INTO item_collections (id, user_id, name, items)
VALUES (
  'test_coll_ref',
  (SELECT user_id FROM allowed_emails LIMIT 1),
  'Reference Test',
  '[]'::jsonb
);

-- Test intent reference
UPDATE intents 
SET collection_id = 'test_coll_ref'
WHERE id = (SELECT id FROM intents LIMIT 1);

SELECT id, text, collection_id FROM intents WHERE collection_id = 'test_coll_ref';
-- Should return intent

-- Test event reference  
UPDATE events 
SET collection_id = 'test_coll_ref'
WHERE id = (SELECT id FROM events LIMIT 1);

SELECT id, collection_id FROM events WHERE collection_id = 'test_coll_ref';
-- Should return event

-- Test execution reference
UPDATE executions 
SET collection_id = 'test_coll_ref'
WHERE id = (SELECT id FROM executions LIMIT 1);

SELECT id, collection_id FROM executions WHERE collection_id = 'test_coll_ref';
-- Should return execution

-- Clean up
DELETE FROM item_collections WHERE id = 'test_coll_ref';
```

**Verification:**
- All references set successfully
- Queries return correct records
- No foreign key errors (columns are TEXT, not enforced FK)

---

## Storage Adapter Updates (Steps 13-15)

### Step 13: Add item_collections storage adapter methods

**Requirement:**
Add CRUD methods to the storage adapter for item_collections. The adapter should handle camelCase ↔ snake_case conversion for:
- item_collections table name
- user_id, context_id, is_capture_target, created_at fields

Follow the existing pattern in Alfred.jsx for other tables.

Key methods needed:
- `storage.set('item_collections:id', data)` - Create/update
- `storage.get('item_collections:id')` - Retrieve
- `storage.list('item_collections:user_id:')` - List all for user
- `storage.delete('item_collections:id')` - Delete

**Verification:**
Test in browser console after starting Alfred:
```javascript
// Create
await storage.set('item_collections:test123', {
  userId: 'current_user_id',
  name: 'Test List',
  items: [{itemId: 'milk', quantity: '2 gallons'}],
  shared: false
});

// Retrieve
const coll = await storage.get('item_collections:test123');
console.log(coll); // Should show camelCase fields

// List
const all = await storage.list('item_collections:current_user_id:');
console.log(all); // Should include test123

// Delete
await storage.delete('item_collections:test123');
const check = await storage.get('item_collections:test123');
console.log(check); // Should be null
```

---

### Step 14: Update storage adapter to handle tags field

**Requirement:**
Ensure the storage adapter correctly handles the `tags` JSONB array field on items, intents, and contexts. No field name conversion needed (tags = tags), but verify JSONB arrays are preserved.

**Verification:**
Test in browser console:
```javascript
// Test item tags
const testItem = await storage.get('items:some_existing_id');
testItem.tags = ['test', 'another'];
await storage.set(`items:${testItem.id}`, testItem);

const retrieved = await storage.get(`items:${testItem.id}`);
console.log(retrieved.tags); // Should be ['test', 'another']

// Test intent tags
const testIntent = await storage.get('intents:some_existing_id');
testIntent.tags = ['urgent'];
await storage.set(`intents:${testIntent.id}`, testIntent);

const retrievedIntent = await storage.get(`intents:${testIntent.id}`);
console.log(retrievedIntent.tags); // Should be ['urgent']
```

---

### Step 15: Update storage adapter to handle collection_id fields

**Requirement:**
Ensure storage adapter correctly handles collectionId ↔ collection_id conversion on intents, events, and executions tables.

**Verification:**
Test in browser console:
```javascript
// Create test collection first
await storage.set('item_collections:coll_test', {
  userId: 'current_user_id',
  name: 'Test',
  items: []
});

// Test intent with collection
const intent = await storage.get('intents:some_id');
intent.collectionId = 'coll_test';
await storage.set(`intents:${intent.id}`, intent);

const retrieved = await storage.get(`intents:${intent.id}`);
console.log(retrieved.collectionId); // Should be 'coll_test'

// Verify in database (Supabase SQL editor)
SELECT id, collection_id FROM intents WHERE id = 'some_id';
-- Should show collection_id = 'coll_test' (snake_case in DB)
```

---

## Tag UI Components (Steps 16-20)

### Step 16: Create TagInput component

**Requirement:**
Create a reusable TagInput component in Alfred.jsx with the following features:
- Input field for comma-separated tags
- Display tags as removable pills below input
- Normalize tags to lowercase on save
- Remove duplicates
- Props: `value` (array), `onChange` (callback)

**Component API:**
```jsx
<TagInput 
  value={['dani', 'urgent']}
  onChange={(newTags) => setTags(newTags)}
/>
```

**Verification:**
1. Add TagInput to a test component
2. Type "Test, Another, test" in input
3. Press Enter or blur
4. Verify pills show: "test", "another" (lowercase, deduped)
5. Click X on a pill
6. Verify tag is removed

---

### Step 17: Add tag input to ItemEditor

**Requirement:**
Add TagInput component to the ItemEditor component (where you edit items). Place it after the description field, before the elements section.

Label: "Tags"
Placeholder: "Add tags (comma separated)"

Save tags to item.tags array when saving the item.

**Verification:**
1. Open an existing item for editing
2. Verify TagInput appears with current tags (if any)
3. Add tags: "test, recipe, dinner"
4. Save item
5. Reopen item
6. Verify tags are displayed in TagInput
7. Check database:
```sql
SELECT id, name, tags FROM items WHERE id = 'your_test_item_id';
-- Should show tags array
```

---

### Step 18: Add tag input to IntentionTriage (inbox)

**Requirement:**
Add TagInput component to the IntentionTriage component (when triaging inbox items to create intentions). Place it in the intention creation form.

Label: "Tags"
Save tags to intention.tags array when creating the intention from inbox.

**Verification:**
1. Capture text in inbox
2. Triage → Create Intention
3. Verify TagInput appears in intention form
4. Add tags: "urgent, dani"
5. Save intention
6. Verify intention has tags in database:
```sql
SELECT id, text, tags FROM intents WHERE id = 'new_intention_id';
-- Should show tags array
```

---

### Step 19: Add tag display to ItemCard and IntentionCard

**Requirement:**
Display tags as small pills in ItemCard and IntentionCard components (the cards shown in lists).

Styling:
- Pills should be small (text-xs)
- Teal background (bg-teal-100)
- Teal text (text-teal-700)
- Rounded (rounded-full)
- Padding (px-2 py-0.5)

Show max 3 tags, then "+N more" if more exist.

**Verification:**
1. Add tags to an item: ["recipe", "dinner", "vegetarian"]
2. View item list
3. Verify tags display as pills on the card
4. Add more tags (5 total)
5. Verify only 3 show, with "+2 more"

---
### Step 19.5: Implement tag input validation

**Requirement:**
Add validation function for tag input that enforces:
- Alphanumeric characters, underscore, hyphen only
- No special characters (!, @, #, etc.)
- Max 50 characters per tag
- Lowercase normalization
- Trim whitespace
- Maximum 20 tags per entity

Create function:
```javascript
function validateAndNormalizeTags(tags) {
  const validTagPattern = /^[a-z0-9_-]+$/;
  
  return tags
    .map(tag => tag.toLowerCase().trim())
    .filter(tag => tag.length > 0 && tag.length <= 50)
    .filter(tag => validTagPattern.test(tag))
    .filter((tag, index, self) => self.indexOf(tag) === index) // dedup
    .slice(0, 20); // max 20 tags
}
```

Apply validation in TagInput component before saving.
Show error message if invalid tags detected.

**Verification:**
1. Try to add tag "urgent!" → gets rejected or cleaned to "urgent"
2. Try to add tag "URGENT" → saved as "urgent"
3. Try to add 25 tags → only first 20 saved
4. Try to add tag with 60 characters → rejected
5. Try to add tag "my tag" (with space) → rejected or cleaned to "my-tag"

---



### Step 20: Create TagFilter component

**Requirement:**
Create a TagFilter component that:
- Shows all unique tags from items/intents (with counts)
- Allows clicking to filter by tag
- Shows active filter clearly
- Has "Clear" button to remove filter

Place this above ItemList and IntentionList components.

**Verification:**
1. Navigate to Items view
2. Verify TagFilter shows all tags with counts (e.g., "recipe (5)")
3. Click "recipe" tag
4. Verify item list filters to only items with "recipe" tag
5. Click "Clear" or click tag again
6. Verify filter is removed, all items show

---

## Item Collection CRUD (Steps 21-25)

### Step 21: Create ItemCollectionList view

**Requirement:**
Create a new view component ItemCollectionList that displays all collections for the current user. Show:
- Collection name
- Item count
- Context (if any)
- Shared indicator (icon)
- Click to view/edit

Add navigation to this view from the main menu.

**Verification:**
1. Click "Collections" in navigation menu
2. Verify view shows list of collections (or "No collections" if empty)
3. Verify each collection shows name, count, context
4. Create a test collection manually in database to verify display
```sql
INSERT INTO item_collections (id, user_id, name, items)
VALUES ('test_coll', 'your_user_id', 'Test List', '[{"item_id": "test", "quantity": "1"}]'::jsonb);
```
5. Refresh, verify "Test List (1 item)" appears

---

### Step 22: Create ItemCollectionDetail view

**Requirement:**
Create ItemCollectionDetail view that shows a single collection with:
- Collection name (editable)
- Context selector
- Shared toggle
- List of items in collection (with quantities)
- Remove button for each item
- "Add Items" button

Add validation in addItemToCollection function:
- Check collection.items.length before adding
- If >= 200, show error and prevent add
- If >= 50, show warning but allow add

Route: When clicking collection in list, navigate to detail view.

**Verification:**
1. Click on a collection in the list
2. Verify detail view opens
3. Verify collection name is editable (inline or edit button)
4. Verify context selector works
5. Verify shared toggle works
6. Verify items list shows with quantities
7. Click remove on an item
8. Verify item is removed from collection
9. Check database to confirm removal

---

### Step 23: Create ItemCollectionEditor (add items to collection)

**Requirement:**
Create a modal/dialog component for adding items to a collection. Show:
- Search/filter items by name or tag
- List of items (with context)
- Checkbox to select multiple items
- Quantity input for each selected item
- "Add to Collection" button

Open this when clicking "Add Items" in ItemCollectionDetail.

**Verification:**
1. In ItemCollectionDetail, click "Add Items"
2. Verify modal opens with item list
3. Search for an item by name
4. Verify search filters list
5. Select 2 items
6. Add quantities: "2 lbs" and "1 gallon"
7. Click "Add to Collection"
8. Verify modal closes
9. Verify items appear in collection with quantities

---

### Step 24: Implement quantity editing in collection

**Requirement:**
In ItemCollectionDetail, make quantities editable inline. When user changes quantity:
- Debounce save (300ms)
- Update collection.items in database
- Show save indicator (optional)

**Verification:**
1. Open ItemCollectionDetail
2. Click on a quantity field
3. Change value from "2 lbs" to "3 lbs"
4. Wait 300ms
5. Refresh page
6. Verify quantity persisted as "3 lbs"
7. Check database:
```sql
SELECT items FROM item_collections WHERE id = 'collection_id';
-- Verify quantity is "3 lbs"
```

---

### Step 25: Implement collection sharing

**Requirement:**
In ItemCollectionDetail, implement the shared toggle. When toggled:
- Update collection.shared in database
- Show confirmation message
- Verify RLS policies work (other user can see shared collection)

**Verification:**
1. Open a collection
2. Toggle "Shared" to ON
3. Verify database updates:
```sql
SELECT id, name, shared FROM item_collections WHERE id = 'collection_id';
-- Should show shared = true
```
4. Log in as second allowed user
5. Navigate to Collections
6. Verify shared collection appears in list
7. Open shared collection
8. Verify you can view items
9. Edit a quantity
10. Verify changes save (both users can modify)

---
### Step 25.5: Write unit tests for element flattening algorithm

**Requirement:**
Before implementing flatten algorithm, write test cases covering:

Test cases to implement:
1. **Simple reference:** Item A references Item B (depth 1)
   - Expected: A's elements + B's elements flattened
2. **Nested reference:** Item A → Item B → Item C (depth 2)
   - Expected: All elements flattened
3. **Max depth:** Item A → B → C → D (depth 3)
   - Expected: Stop at D, show warning
4. **Circular reference:** Item A → B → A
   - Expected: Detect cycle, stop, show error
5. **Deleted child:** Item A references Item B (B deleted)
   - Expected: Skip B, show placeholder or error
6. **Missing child:** Item A references non-existent ID
   - Expected: Skip, show placeholder
7. **Multiple references:** Item A references B and C
   - Expected: Both B and C flattened in order

Create test function that runs these cases and logs results.
Run manually before implementing Step 26.

**Verification:**
All 7 test cases pass with expected behavior.


## Item References (Steps 26-29)

### Step 26: Update ItemEditor to support item references

**Requirement:**
Enhance ItemEditor to allow adding item references to elements. Add a button "Link to Item" for each element that:
- Opens item picker dialog
- User selects an item
- Element gets itemId field
- Display linked elements in teal with arrow (→)

**Verification:**
1. Edit an item
2. Click "Link to Item" for an element
3. Verify item picker opens
4. Select an item
5. Verify element shows "→ Item Name" in teal
6. Verify element has itemId in data
7. Save item
8. Reopen item
9. Verify linked item still shows correctly
10. Check database:
```sql
SELECT elements FROM items WHERE id = 'your_item_id';
-- Verify element has itemId field
```

---




### Step 27: Implement item reference flattening

**Requirement:**
Create a function `flattenElements(elements)` that:
- Takes an array of elements
- For each element with itemId, fetches that item
- Recursively flattens child elements
- Returns flat array with indent field
- Handles circular references (max depth 3)
- Handles deleted items gracefully

Place in Alfred.jsx as utility function.

**Verification:**
Test in browser console:
```javascript
// Create test items
const parent = {
  elements: [
    { name: "First Course", displayType: "header" },
    { name: "Shrimp", displayType: "bullet", itemId: "child_item_id" }
  ]
};

const child = {
  elements: [
    { name: "Peel shrimp", displayType: "step" },
    { name: "Make sauce", displayType: "step" }
  ]
};

// Mock storage
window.testStorage = {
  'items:child_item_id': child
};

const flattened = await flattenElements(parent.elements);
console.log(flattened);
// Should show:
// [
//   { name: "First Course", displayType: "header", indent: 0 },
//   { name: "Shrimp", displayType: "header", indent: 1 },
//   { name: "Peel shrimp", displayType: "step", indent: 2 },
//   { name: "Make sauce", displayType: "step", indent: 2 }
// ]
```

---

### Step 28: Update execution start to use flattening

**Requirement:**
When starting an execution from an item that has item references:
- Call flattenElements() on item.elements
- Store flattened result in execution.elements
- Display with proper indentation in execution view

**Verification:**
1. Create an item with a child item reference
2. Create intention from that item
3. Create event
4. Start execution
5. Verify execution view shows flattened elements with indentation
6. Verify child item steps are visible as checkable steps
7. Check off a child step
8. Verify it saves correctly

---

### Step 29: Add "Used In" and "References" sections to ItemDetailView

**Requirement:**
In ItemDetailView, add two new sections:
1. "Used In (N)" - Show items that reference this item (parents)
2. "References (N)" - Show items this item references (children)

Both sections should show clickable links to navigate.

Calculate by scanning all items' elements for itemId references.

**Verification:**
1. Create item A with reference to item B
2. View item B detail
3. Verify "Used In (1)" section shows item A
4. Click item A link
5. Verify navigates to item A
6. Verify "References (1)" section shows item B
7. Create item C that references item A
8. View item A
9. Verify "Used In (1)" shows item C
10. Verify "References (1)" shows item B

---

## Deep Clone (Steps 30-31)

### Step 30: Implement deepCloneItem function

**Requirement:**
Create async function `deepCloneItem(sourceItemId, newName, userId)` that:
- Clones the source item
- Recursively clones all referenced child items
- Updates element itemId references to point to clones
- Returns the new cloned item
- Prevents circular references

**Verification:**
Test in browser console:
```javascript
// Create test hierarchy
await storage.set('items:parent', {
  userId: 'user1',
  name: 'Parent',
  elements: [
    { name: "Step 1", displayType: "step" },
    { name: "Child", displayType: "bullet", itemId: 'child' }
  ]
});

await storage.set('items:child', {
  userId: 'user1',
  name: 'Child',
  elements: [
    { name: "Child step", displayType: "step" }
  ]
});

// Clone
const clone = await deepCloneItem('parent', 'Parent Clone', 'user1');
console.log(clone);

// Verify clone exists
const clonedParent = await storage.get(`items:${clone.id}`);
console.log(clonedParent);
// Verify child was cloned (check itemId in elements)

const childRef = clonedParent.elements.find(el => el.itemId);
const clonedChild = await storage.get(`items:${childRef.itemId}`);
console.log(clonedChild);
// Should show cloned child with new ID
```
**Verification:**
1. Clone item in Context A
2. Verify clone dialog appears
3. Enter name for clone
4. Click "Clone"
5. **Verify clone is created in SAME context as original** (context_id copied)
6. Verify clone has different ID
7. Open clone editor
8. Edit clone name
9. Verify original item unchanged
10. If original has item references, verify clone has NEW copies of children (not same references)


---

### Step 31: Add Clone button to ItemDetailView

**Requirement:**
Add "Clone" button to ItemDetailView. When clicked:
- Show dialog with name input
- User enters new name
- Call deepCloneItem()
- Navigate to cloned item in edit mode
- Show success message

**Verification:**
1. Open an item detail view
2. Click "Clone" button
3. Verify dialog opens
4. Enter name "My Clone"
5. Click "Clone" button in dialog
6. Verify dialog closes
7. Verify navigates to cloned item editor
8. Verify item name is "My Clone"
9. Verify all elements copied
10. Verify item references are to new cloned children (not originals)
11. Edit clone, save
12. Open original item
13. Verify original unchanged

---

## Three-State Execution Steps (Steps 32-34)

### Step 32: Add inProgress and startedAt fields to element state

**Requirement:**
Update execution element handling to support:
- inProgress (boolean)
- startedAt (timestamp)

These fields should be initialized to false/null when creating execution elements.

**Verification:**
1. Create execution from an item
2. Check execution.elements in database:
```sql
SELECT elements FROM executions WHERE id = 'execution_id';
```
3. Verify each step element has:
   - isCompleted: false
   - inProgress: false
   - startedAt: null

---

### Step 33: Create enhanced StepRow component

**Requirement:**
Update StepRow component in execution view to show:
- Checkbox (left) - marks complete
- Element name (middle)
  - Normal weight if not started
  - Teal and medium weight if in progress
  - Gray strikethrough if complete
- "Start" / "Reset" link (right)
  - Show "Start" if not started and not complete
  - Show "Reset" if in progress
  - Hide if complete
- Timer display (below, indented) if in progress
  - Format: "⏱ Started Xm ago"

Interaction:
- Click "Start" → set inProgress: true, startedAt: now
- Click "Reset" → set inProgress: false, startedAt: null
- Click checkbox → set isCompleted: true, inProgress: false

**Verification:**
1. Start an execution
2. Verify step shows checkbox and "Start" link
3. Click "Start"
4. Verify "Start" changes to "Reset"
5. Verify timer appears showing "Started 0s ago"
6. Wait 30 seconds
7. Verify timer updates to "Started 30s ago"
8. Click checkbox
9. Verify step becomes strikethrough, "Reset" disappears
10. Verify timer shows "Completed Xs ago"

---

### Step 34: Test three-state flow end-to-end

**Requirement:**
Create a test execution and verify full three-state lifecycle works correctly.

**Verification:**
1. Create item with 5 steps
2. Create intention → event → start execution
3. For step 1:
   - Click "Start"
   - Wait 10 seconds
   - Click checkbox
   - Verify moves to complete
4. For step 2:
   - Click "Start"
   - Click "Reset"
   - Verify back to not started
   - Click "Start" again
   - Click checkbox
   - Verify complete
5. For step 3:
   - Don't start, just check checkbox
   - Verify moves directly to complete (skip in-progress)
6. Pause execution
7. Resume execution
8. Verify in-progress state persisted (step 4 shows timer if was started)
9. Complete remaining steps
10. Close execution
11. Reopen execution (view history)
12. Verify all step states preserved

---

## Collection-Based Execution (Steps 35-38)

### Step 35: Update intention/event creation to support collections

**Requirement:**
Modify intention and event creation flows to allow selecting a collection (in addition to existing item selection).

Add collection selector to:
- IntentionCard (when creating intention)
- Event creation dialog

Store collectionId in intention/event records.

**Verification:**
1. Create new intention
2. Verify collection selector appears (dropdown)
3. Select a collection
4. Save intention
5. Verify intention.collectionId in database:
```sql
SELECT id, text, collection_id FROM intents WHERE id = 'intention_id';
```
6. Create event from that intention
7. Verify event.collectionId copied from intention
8. Check database:
```sql
SELECT id, collection_id FROM events WHERE id = 'event_id';
```

---

### Step 36: Implement collection-based execution start

**Requirement:**
When starting execution from event with collectionId:
- Fetch collection from database
- Set execution.collectionId
- Initialize execution.completedItemIds to empty array
- Do NOT copy items to execution (read from collection dynamically)

**Verification:**
1. Create collection with 3 items
2. Create intention with that collection
3. Create event
4. Start execution
5. Verify execution record:
```sql
SELECT collection_id, completed_item_ids FROM executions WHERE id = 'exec_id';
-- Should show collection_id set, completed_item_ids = []
```
6. Verify execution view shows items from collection

---

### Step 37: Implement collection execution view

**Requirement:**
Create execution view for collection-based executions that:
- Fetches collection items in real-time (poll every 5 seconds)
- Shows each item as checkable row
- Shows quantity (editable inline)
- Tracks completion in execution.completedItemIds
- Updates collection.items when quantity edited

**Verification:**
1. Start collection execution
2. Verify items display with quantities
3. Edit quantity on an item
4. Verify quantity updates in collection (check database)
5. Open second browser (as same user)
6. Start another execution on same collection
7. Verify both executions see same items
8. In execution 1, edit quantity
9. Wait 5 seconds
10. Verify execution 2 shows updated quantity
11. In execution 1, check off item
12. Verify execution 1's completedItemIds includes that item
13. Verify execution 2 still shows item (not affected)
14. **Test race condition scenario:**
    - User A starts execution (sees: milk, eggs)
    - User B adds "cheese" to collection (via collection editor, not execution)
    - Wait 5 seconds for poll
    - Verify User A's execution now shows: milk, eggs, cheese
    - User A checks off milk, eggs (leaves cheese unchecked)
    - User A closes execution
    - Verify collection now contains only: cheese
    - Verify milk and eggs were removed (even though User A didn't explicitly add cheese)
---

### Step 38: Implement collection mutation on execution close

**Requirement:**
When closing collection-based execution:
- Remove items in execution.completedItemIds from collection.items
- Keep unchecked items in collection

**Verification:**
1. Create collection with items: milk, eggs, bread
2. Start execution
3. Check off: milk, eggs (leave bread unchecked)
4. Close execution
5. Verify collection now only has bread:
```sql
SELECT items FROM item_collections WHERE id = 'collection_id';
-- Should show only bread in items array
```
6. View collection in UI
7. Verify only bread shows
8. Start new execution
9. Verify only bread appears in execution

10. Query closed execution:
```sql
SELECT completed_item_ids FROM executions WHERE id = 'exec_id';
-- Should still show ["milk_id", "eggs_id"] even though removed from collection
```
11. View execution history in UI
12. Verify shows "Completed: milk (2 gallons), eggs (1 dozen)"

---

## Context Menu and Navigation (Steps 39-40)

### Step 39: Add Collections to main navigation

**Requirement:**
Add "Collections" link to main navigation menu (alongside Items, Intents, Events, etc.)

Route to ItemCollectionList view.

**Verification:**
1. Check main navigation menu
2. Verify "Collections" link appears
3. Click "Collections"
4. Verify navigates to ItemCollectionList view
5. Test on mobile (hamburger menu)
6. Verify "Collections" appears in mobile menu

---

### Step 40: Add context switcher to collection views

**Requirement:**
In ItemCollectionList view, add context filter dropdown that filters collections by context (similar to Items view).

**Verification:**
1. Create collections in different contexts
2. Navigate to Collections view
3. Verify context filter appears
4. Select a context
5. Verify list filters to only collections in that context
6. Select "All contexts"
7. Verify all collections show

---

## Polish and Mobile (Steps 41-42)

### Step 41: Mobile responsive - collections and tags

**Requirement:**
Ensure all new components are mobile responsive:
- ItemCollectionList (card layout on mobile)
- ItemCollectionDetail (stacked layout)
- TagInput (full width on mobile)
- TagFilter (wrap on mobile)
- Collection execution view (full width items)



**Verification:**
Test at these specific breakpoints using Chrome DevTools Device Mode:

**360px width (Galaxy S8):**
1. Navigate to Collections → verify readable, no horizontal scroll
2. Open collection → verify items stack vertically
3. Edit quantity → verify keyboard doesn't obscure input

**390px width (iPhone 13):**
1. Navigate to Items → verify tag pills wrap nicely
2. Open item with references → verify navigation works

**768px width (iPad):**
1. Verify desktop-like layout starts appearing
2. Verify hamburger menu switches to full nav bar
3. Verify collection grid shows 2 columns

Test gestures:
- Swipe to delete (if implemented)
- Tap targets at least 44px height
- Forms don't zoom on input focus

---

### Step 42: End-to-end integration test

**Requirement:**
Perform complete workflow test covering all new features:
1. Create item with tags
2. Create another item that references first item
3. Create collection, add items with quantities
4. Create intention with collection
5. Schedule event
6. Start execution (collection-based)
7. Edit quantity during execution
8. Mark items complete
9. Close execution
10. Verify collection updated
11. Clone an item (with references)
12. Verify clone is independent
13. Test three-state steps in execution
14. Filter items by tag
15. Share a collection, verify other user can see/edit

**Verification:**
Complete checklist:
- [ ] Item tags save and display
- [ ] Item references work in editor and execution
- [ ] Collection CRUD works
- [ ] Collection quantity editing works
- [ ] Collection sharing works (RLS)
- [ ] Collection-based execution works
- [ ] Execution mutates collection on close
- [ ] Three-state steps work (not started / in progress / complete)
- [ ] Deep clone works (items + children)
- [ ] Tag filtering works across items/intents
- [ ] Mobile responsive works
- [ ] No console errors
- [ ] All data persists correctly in Supabase

---

## Summary

**Total Steps:** 45 (was 42, added 3)
- Added Step 19.5 (tag validation)
- Added Step 25.5 (flatten tests)
- Step 33 enhanced (checkbox confirmation)
**Estimated Time:** 16-22 hours (was 15-20)
**Database Steps:** 12  
**Storage Adapter Steps:** 3  
**UI Component Steps:** 27  

**Dependencies:**
- Steps 1-12 must complete before storage adapter work
- Steps 13-15 must complete before UI work
- Tag UI (16-20) can proceed in parallel with collections (21-25)
- Item references (26-29) independent of collections
- Three-state steps (32-34) independent of collections
- Collection execution (35-38) depends on collections (21-25) completing

**Success Criteria:**
All 42 steps verified ✓

---

**End of Implementation Steps**
