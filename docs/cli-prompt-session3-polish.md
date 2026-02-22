# Project Context
Alfred v5 UI redesign — Session 3 of 3: Component Polish. Sessions 1 (colors) and 2 (icons) are complete. Now we ensure consistent card styling, button sizing, input styling, and typography across all components.

This is a VISUAL ONLY change. No functionality changes.

# Reference Documents
- Technical spec: docs/phase75-technical-spec.md (see "Component Polish Priorities" section)
- Progress tracking: docs/progress-phase75-ui-redesign.md (see Session 3 steps)
- Figma card pattern: docs/figma-reference/app/components/ui/card.tsx
- Figma button pattern: docs/figma-reference/app/components/ui/button.tsx
- Figma badge pattern: docs/figma-reference/app/components/ui/badge.tsx
- Figma input pattern: docs/figma-reference/app/components/ui/input.tsx
- Figma inbox page: docs/figma-reference/app/pages/Inbox.tsx (reference implementation)

# Critical Constraints
1. Alfred.jsx is the ONLY file you modify
2. Do NOT change any JavaScript logic, state management, or component structure
3. ONLY change: CSS class strings within JSX
4. Every component must look consistent with the Figma reference patterns

# Design Patterns to Apply

## Card Pattern
All card-like containers should use:
```
bg-card text-card-foreground border border-border rounded-lg
```
Hover state (if clickable): `hover:border-primary transition-colors`
Active/editing state: `border-primary border-2`
Shadow: `shadow-sm hover:shadow-md transition-shadow duration-200` (only on clickable cards)

## Button Pattern  
All buttons should follow consistent sizing:
- Touch target: `min-h-[44px]` on ALL buttons
- Padding: `px-4 py-2.5` (standard), `px-3 py-2` (compact/inline)
- Shape: `rounded-lg`
- Transition: `transition-all duration-200`
- Shadow: `shadow-sm hover:shadow-md` (on primary/success/destructive only)

Color by action type:
- Primary actions (Add, Save, Capture, Start): `bg-primary hover:bg-primary-hover text-primary-foreground`
- Success actions (Complete, Do Today): `bg-success hover:bg-success-hover text-white`
- Destructive actions (Delete, Archive permanently): `bg-destructive hover:bg-destructive-hover text-white`
- Warning actions (Pause): `bg-warning hover:bg-warning-hover text-white`
- Secondary/neutral actions (Cancel, Close, Back): `bg-secondary hover:bg-secondary/80 text-secondary-foreground`
- Ghost actions (Sign out, Archive link): `text-muted-foreground hover:text-foreground`

## Input Pattern
All form inputs (text, textarea, select, date):
```
bg-input-background border border-border rounded-md px-3 py-2 text-base
focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring
```

## Badge/Tag Pattern
- Context badges: `bg-accent text-accent-foreground text-xs px-2 py-0.5 rounded-md`
- Tag pills: `bg-accent text-accent-foreground text-xs px-2 py-0.5 rounded-full`
- Active tag filter: `bg-primary text-primary-foreground`
- AI status badges: use semantic colors (success-light, warning-light, etc.) with border-transparent

## Typography
- Page titles (h2): `text-2xl font-medium text-foreground`
- Section headers (h3): `text-lg font-medium text-foreground`  
- Card titles: `font-medium text-foreground`
- Body text: `text-foreground`
- Secondary/helper text: `text-sm text-muted-foreground`
- Note: Figma uses `font-weight: 500` (medium), NOT semibold (600). Replace `font-semibold` with `font-medium` globally.

# Your Task
1. Read the progress tracking file — Session 3 steps
2. Execute each step, focusing on visual consistency

# Step-by-Step Execution

## Step 3.1: Card containers
Search for all `bg-white border border-gray-` card patterns. Replace with the standard card pattern. Pay attention to:
- InboxCard (collapsed): should be `bg-card border border-border rounded-lg`
- InboxCard (expanded): should be `bg-card border-2 border-primary rounded-lg`
- IntentionCard, EventCard, ItemCard, ContextCard: all should use same base card style
- ExecutionBadge: keep distinct styling but use new tokens

## Step 3.2: Button sizes
Audit ALL `<button>` elements. Ensure every interactive button has `min-h-[44px]` for touch targets. Check particularly:
- Inline action buttons (tag remove, element delete)
- Modal buttons
- Form submit/cancel buttons

## Step 3.3: Form inputs
Find all `<input>`, `<textarea>`, `<select>` elements. Apply consistent:
- Background: `bg-input-background`
- Border: `border border-border`
- Focus: `focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring`
- Rounding: `rounded-md`

## Step 3.4: Polish InboxCard
This is the most complex component. Ensure:
- Collapsed state: clean card with `bg-card border-border`
- Expanded state: `border-2 border-primary`
- Accordion section headers: consistent text styling, chevron icons
- Accordion section borders: `border border-border rounded-lg` when open, `border border-border bg-secondary/30` when closed
- AI status badge: uses new semantic colors
- Action button row: consistent button sizing and spacing, `border-t border-border` separator
- Metadata row: `text-muted-foreground` for dates and source info

## Step 3.5: Polish ExecutionDetailView
- Title area: `text-2xl font-medium`
- Context badge: `bg-accent text-accent-foreground`
- Element list: checkboxes use `bg-primary border-primary` when checked, `bg-input-background border-border` when unchecked
- In-progress elements: use `text-primary font-medium` instead of custom teal
- Notes textarea: consistent input styling
- Bottom action bar: `border-t border-border pt-4`, consistent button pattern

## Step 3.6: Polish IntentionCard / EventCard
- Card base: `bg-card border border-border rounded-lg`
- Clickable cards: `cursor-pointer hover:border-primary transition-colors`
- Context badges: `bg-accent text-accent-foreground`
- Scheduling buttons: standard button pattern
- EventCard date display: `text-muted-foreground`
- Execution badges inline: keep distinct but use new tokens

## Step 3.7: Polish ContextCard / ItemCard
- Card base: consistent with all other cards
- ContextCard shared indicator: use `text-primary` with Share2 icon
- ItemCard element list: `text-muted-foreground` for numbered steps
- Edit mode: `border-2 border-primary` (same as expanded inbox)
- Archive button: consistent destructive styling

## Step 3.8: Polish header and navigation
- Desktop header: `bg-card border-b border-border`
- Tab buttons active: `bg-primary text-primary-foreground`
- Tab buttons inactive: `bg-card text-foreground border border-border hover:border-primary`
- Connection status: alongside wifi icon from Session 2

## Step 3.9: Polish capture bar
- Background: `bg-card border-t border-border shadow-lg`
- Input: `bg-input-background border-border`
- Capture button: `bg-primary hover:bg-primary-hover text-primary-foreground`

## Step 3.10: Polish mobile menu
- Overlay: `bg-black/50`
- Menu panel: `bg-card shadow-xl`
- Active item: `bg-accent text-foreground font-medium`
- Inactive item: `text-foreground hover:bg-secondary/50`

## Step 3.11: Typography pass
Do a GLOBAL find-and-replace:
- `font-semibold` → `font-medium` (Figma design uses medium weight consistently)
- Verify all page titles are `text-2xl font-medium`
- Verify all section headers are `text-lg font-medium`

## Step 3.12: Final verification
Walk through EVERY view in the app. Check:
- Home: execution badges, today events, pinned contexts
- Inbox: collapsed cards, expanded triage, action buttons
- Contexts: context list, add form
- Context Detail: items list, intentions list, add forms
- Schedule: event cards
- Intentions: intention cards with events
- Memories: item cards
- Collections: collection list, collection detail, add items
- Execution Detail: elements, notes, action bar
- Item Detail: elements, references, related intentions
- Intention Detail: edit form, linked item, events

# Verification Pattern
After completing all steps, ask me to:
1. Open the app on desktop — check every view listed above
2. Open Chrome DevTools → toggle mobile viewport (375px width) → check same views
3. Specifically test: expand an inbox item, start an execution, edit an intention
4. Check that no visual artifacts remain (missing colors, broken borders, inconsistent buttons)

# Important
- Update the progress file after each step
- The Figma reference files show the TARGET aesthetic — aim for that feel
- font-semibold → font-medium is a global change, do it carefully
- If any component looks broken after changes, note it and fix before moving on
- Final result should feel warm, calm, and professional — like the Figma mockup
