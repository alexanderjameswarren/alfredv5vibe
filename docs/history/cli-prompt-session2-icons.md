# Project Context
Alfred v5 UI redesign — Session 2 of 3: Icon Standardization. Session 1 (color migration) is complete. Now we replace all emoji icons and text-character icons with proper Lucide React components.

This is a VISUAL ONLY change. No functionality changes.

# Reference Documents
- Technical spec: docs/phase75-technical-spec.md (see "Icon Standardization" section)
- Progress tracking: docs/progress-phase75-ui-redesign.md (see Session 2 steps)
- Figma reference header: docs/figma-reference/app/components/Header.tsx (shows Lucide icon usage pattern)

# Critical Constraints
1. Alfred.jsx is the ONLY file you modify
2. Do NOT change any JavaScript logic, state management, or component structure
3. ONLY change: import statements (adding new Lucide icons) and JSX markup (replacing emoji/text with icon components)
4. Every icon replacement must preserve the exact same click handler and surrounding element structure

# Your Task
1. Read the progress tracking file — Session 2 steps
2. Execute each step in order

# Step-by-Step Execution

## Step 2.1: Add new Lucide imports
Update the existing import from 'lucide-react' to include:
```javascript
import { 
  Plus, Share2, Play, Pause, Check, X, Trash2, ArrowLeft, Menu, Copy,
  ChevronDown, ChevronUp, GripVertical, Pencil, Settings, Archive, 
  Sparkles, Wifi, WifiOff, Pin
} from "lucide-react";
```

## Step 2.2: Replace ⚙️ emoji settings icons
Find all instances of `<span className="text-xl">⚙️</span>` or similar ⚙️ usage.
Replace with `<Settings className="w-5 h-5" />` (or `<Pencil />` for edit-specific actions).
Locations to check: mobile header, desktop header, ContextCard settings button, IntentionDetailView edit button, ItemDetailView edit button.

## Step 2.3: Replace ▾/▸ accordion indicators  
Find all instances of text arrows used for expand/collapse:
- `{intentionOpen ? '▾' : '▸'}` 
- `{itemOpen ? '▾' : '▸'}`
- `{collectionOpen ? '▾' : '▸'}`
- `{scheduleEventOpen ? '▾' : '▸'}`

Replace with:
```jsx
{intentionOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
```
Wait — actually the convention is ChevronDown when CLOSED (pointing down to expand) and rotated when open. Check the Figma accordion component: it uses `[&[data-state=open]>svg]:rotate-180`. For our manual implementation, use:
```jsx
<ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
```

## Step 2.4: Replace ☰ drag handles
Find all instances of `<span className="text-sm text-muted..." title="Drag to reorder">☰</span>`.
Replace with `<GripVertical className="w-4 h-4 text-muted-foreground cursor-move" />`.
Locations: ItemCard element editor, InboxCard element editor.

## Step 2.5: Replace ✕ text close buttons
Find all instances of bare `✕` text used for close/remove actions.
Replace with `<X className="w-3 h-3" />` (or `w-4 h-4` depending on context).
Locations: tag removal buttons, linked item clear buttons, element delete buttons.
Note: Some places already use `<X />` Lucide component — leave those alone.

## Step 2.6: Add Sparkles icon to Enrich buttons
Find the Enrich/Re-enrich buttons in InboxCard.
Add `<Sparkles className="w-4 h-4" />` before the button text:
```jsx
<Sparkles className="w-4 h-4" /> Enrich (Sonnet)
<Sparkles className="w-4 h-4" /> Re-enrich (Opus)
```

## Step 2.7: Add Archive icon to Archive buttons
Find all Archive buttons/links that currently have no icon (text-only "Archive").
Add `<Archive className="w-4 h-4" />` alongside the text.

## Step 2.8: Upgrade connection status indicator
Find the connection status dots in both mobile and desktop headers.
Replace the plain colored dot with an icon + dot:
```jsx
{realtimeStatus === 'connected' ? (
  <Wifi className="w-4 h-4 text-success" />
) : realtimeStatus === 'connecting' ? (
  <Wifi className="w-4 h-4 text-warning animate-pulse" />
) : (
  <WifiOff className="w-4 h-4 text-muted-foreground" />
)}
```

## Step 2.9: Replace 📌 pin emoji
Find `{context.pinned && <span className="text-gray-400">📌</span>}` in ContextCard.
Replace with `{context.pinned && <Pin className="w-4 h-4 text-muted-foreground" />}`.

## Step 2.10: Replace menu emoji icons
In the mobile slide-out menu, the nav items use emoji like 🏠📥📁📅💡⭐📋🎹.
Replace with appropriate Lucide icons:
- Home → `<Home className="w-4 h-4" />` (import Home from lucide-react)
- Inbox → `<Inbox className="w-4 h-4" />` (import Inbox)
- Contexts → `<FolderOpen className="w-4 h-4" />` (import FolderOpen)
- Schedule → `<Calendar className="w-4 h-4" />` (import Calendar)
- Intentions → `<Lightbulb className="w-4 h-4" />` (import Lightbulb)
- Memories → `<Star className="w-4 h-4" />` (import Star)
- Collections → `<ClipboardList className="w-4 h-4" />` (import ClipboardList)
- Sam → `<Music className="w-4 h-4" />` (import Music)

Update the imports accordingly.

## Step 2.11: Verification grep
```bash
grep -n "⚙️\|☰\|▾\|▸\|✕\|📌\|🏠\|📥\|📁\|📅\|💡\|⭐\|📋\|🎹" src/Alfred.jsx
```
Note: Some emoji may remain in empty state messages or status badges (like SourceIcon using ✏️🤖✉️). Those decorative uses are acceptable. Flag only functional/interactive emoji.

# Verification Pattern
After completing all steps, ask me to:
1. Open the app and check the mobile hamburger menu — should show Lucide icons
2. Check desktop header — Settings icon should be a gear icon, not emoji
3. Expand an inbox item — accordion arrows should be chevrons
4. Edit an item — drag handles should be grip dots
5. Check connection status in header — should show wifi icon

Wait for my verification before we start Session 3 (Component Polish).

# Important
- Update the progress file after each step
- If an emoji serves a purely decorative purpose (not interactive), note it but leave it
- Keep all `className` on replaced elements — only swap the content
- Test that click handlers still work after icon replacement
