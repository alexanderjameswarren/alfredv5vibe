# Phase 7.2.1 Progress — Inbox UI: AI Enrichment & Triage Redesign

## Status: ✅ Complete

| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 1 | Export supabaseUrl from supabaseClient.js | ✅ | Exported and imported in Alfred.jsx |
| 2 | Update handleCapture with new default fields | ✅ | Added aiStatus, sourceType, etc. |
| 3 | Collapsed InboxCard — metadata row, badges, helpers | ✅ | Added helpers and updated collapsed view |
| 4 | Sort inbox list oldest first | ✅ | Updated sort in load and capture |
| 5 | Expanded triage view — header and AI info panel | ✅ | Added metadata row and AI info panel |
| 6 | Accordion section — Intention (with Event & Tags) | ✅ | Replaced checkbox with accordion |
| 7 | Accordion section — Item (with Tags) | ✅ | Added accordion with tags and elements |
| 8 | Accordion section — Add to Collection | ✅ | Added accordion with item picker |
| 9 | Enrich / Re-enrich button | ✅ | Added buttons and handlers with camelCase conversion |
| 10 | Update handleSave for new triage data | ✅ | Updated to use accordion state + added collection/tags |
| 11 | Update InboxCard state when enrichment arrives | ✅ | Added useEffect to sync on enrichment |
| 12 | Cleanup — remove old checkbox UI remnants | ✅ | Removed old checkbox state variables |
| 13 | Handle camelCase ↔ snake_case for enrich response | ✅ | Included in Step 9 handleEnrich |

## Legend

- ⬜ Not started
- 🔄 In progress
- ✅ Complete
- ⏭️ Skipped
- ❌ Blocked

## Verification Log

Record test results here as steps are completed:

### Step 1
- [ ] App loads without import errors

### Step 2
- [ ] New inbox item captured without console errors
- [ ] Supabase `inbox` table shows new columns with defaults

### Step 3
- [ ] Collapsed cards show truncated text (100 char limit)
- [ ] Friendly dates display correctly (Today, Yesterday, weekday)
- [ ] AI status badges render with correct colors
- [ ] Source icons display

### Step 4
- [ ] Oldest inbox items appear at top of list

### Step 5
- [ ] Expanded card shows full captured text
- [ ] Metadata row shows date + AI status badge
- [ ] ℹ️ button toggles AI detail panel
- [ ] Confidence bar renders proportionally
- [ ] AI reasoning text displays

### Step 6
- [ ] Intention section auto-opens when suggestIntent is true
- [ ] Name, Context, Recurrence pre-fill from suggestions
- [ ] Linked Item field pre-fills from suggestedItemId
- [ ] Linked Item field disables when Item section is open
- [ ] Tags display as removable chips, Enter key adds new tag
- [ ] Schedule Event sub-accordion works with date picker
- [ ] Cancel resets all fields to suggestion defaults

### Step 7
- [ ] Item section auto-opens when suggestItem is true
- [ ] Name, Description, Context, Elements pre-fill from suggestions
- [ ] Elements drag/drop still works
- [ ] Tags display and edit correctly
- [ ] Opening Item disables Linked Item in Intention section

### Step 8
- [ ] Collection section auto-opens when suggestedCollectionId is set
- [ ] Collection dropdown shows available collections
- [ ] Item field disables when Item section is open
- [ ] Quantity defaults to "1"

### Step 9
- [ ] Un-enriched item shows "Enrich (Sonnet)" button
- [ ] Clicking Enrich shows "Enriching..." disabled state
- [ ] On success, suggestions populate and sections auto-open
- [ ] Enriched item shows "Re-enrich (Opus)" button
- [ ] Re-enrich saves form edits before calling enrich
- [ ] On error, alert shows and button reverts

### Step 10
- [ ] Intention only → creates intent (+ event if scheduled)
- [ ] Item only → creates item with tags
- [ ] Item + Intention → item created first, intent linked to new item
- [ ] Collection + Item → item created, added to collection
- [ ] Collection only + existing item → adds existing item to collection
- [ ] All three sections → creates item, intent linked, item added to collection
- [ ] No sections open → Save disabled
- [ ] Inbox item archived after save

### Step 11
- [ ] Enrichment updates sections without closing/reopening card
- [ ] Fields populate after enrich completes

### Step 12
- [ ] No console errors or unused variable warnings
- [ ] Full flow: capture → expand → enrich → edit → save
- [ ] Cancel resets properly
- [ ] Archive works from expanded view

### Step 13
- [ ] Enrich response snake_case converted to camelCase
- [ ] Form fields populate correctly after enrichment
