# Progress: Phase 7.5 — UI Visual Redesign

## Status: Not Started

---

## Session 1: Color Scheme Migration

### Development Steps
- [ ] Step 1.1: Copy Figma theme.css into project (create `src/styles/theme.css` or update existing CSS)
- [ ] Step 1.2: Add missing semantic tokens to theme.css (primary-hover, success, warning, destructive variants mapped to @theme inline)
- [ ] Step 1.3: Update tailwind.config.js — remove all hardcoded color hex values from theme.extend.colors (CSS variables handle everything now)
- [ ] Step 1.4: Replace ALL background color classes in Alfred.jsx (bg-white → bg-card, bg-primary-bg → bg-background, bg-gray-* → bg-secondary/bg-muted)
- [ ] Step 1.5: Replace ALL text color classes (text-dark → text-foreground, text-muted → text-muted-foreground, text-gray-* → text-muted-foreground or text-foreground)
- [ ] Step 1.6: Replace ALL border color classes (border-gray-200/300 → border-border)
- [ ] Step 1.7: Replace ALL semantic action colors (bg-danger → bg-destructive, hover:bg-danger-hover → hover:bg-destructive-hover, bg-danger-light → bg-destructive-light)
- [ ] Step 1.8: Replace ALL tag/badge colors (bg-teal-100 text-teal-700 → bg-accent text-accent-foreground, bg-teal-600 → bg-primary)
- [ ] Step 1.9: Replace ALL one-off hardcoded colors (bg-purple-600, bg-amber-*, bg-green-50, text-red-500, etc.)
- [ ] Step 1.10: Replace ALL hover/focus states (hover:bg-gray-100 → hover:bg-secondary/50, ring-primary → ring-ring, accent-primary → remove)
- [ ] Step 1.11: Remove any inline `style={{ color: ... }}` or `style={{ background: ... }}` attributes
- [ ] Step 1.12: Verify — run grep to confirm zero hardcoded colors remain

### Verification
```bash
# Should return NO results:
grep -n "bg-teal-\|bg-green-\|bg-red-\|bg-amber-\|bg-purple-\|text-teal-\|text-green-\|text-red-\|text-amber-" src/Alfred.jsx
grep -n "bg-danger\|hover:bg-danger\|bg-danger-light\|text-danger" src/Alfred.jsx
grep -n "#[0-9a-fA-F]\{3,6\}" src/Alfred.jsx
grep -n "text-dark\b" src/Alfred.jsx
grep -n "bg-primary-bg" src/Alfred.jsx
```

### Notes
[Space for notes during execution]

---

## Session 2: Icon Standardization

### Development Steps
- [ ] Step 2.1: Add new Lucide imports (ChevronDown, ChevronUp, GripVertical, Pencil, Settings, Archive, Sparkles, Wifi, WifiOff)
- [ ] Step 2.2: Replace all emoji ⚙️ settings/edit icons with `<Settings />` or `<Pencil />` Lucide component
- [ ] Step 2.3: Replace all ▾/▸ accordion indicators with `<ChevronDown />` / `<ChevronUp />` (InboxCard accordions, all expand/collapse toggles)
- [ ] Step 2.4: Replace ☰ drag handles with `<GripVertical />` (element reorder in ItemCard and InboxCard)
- [ ] Step 2.5: Replace ✕ text close buttons with `<X />` Lucide component (tag removal, linked item clear, element delete)
- [ ] Step 2.6: Add `<Sparkles />` icon to Enrich/Re-enrich buttons in InboxCard
- [ ] Step 2.7: Add `<Archive />` icon to all Archive buttons/links that currently have no icon
- [ ] Step 2.8: Replace connection status colored dots with `<Wifi />` / `<WifiOff />` icons (keep color indicator alongside)
- [ ] Step 2.9: Replace 📌 pin emoji with a Lucide `<Pin />` icon in ContextCard
- [ ] Step 2.10: Remove menu emoji icons (🏠📥📁📅💡⭐📋🎹) from mobile slide-out menu — use text labels only or add appropriate Lucide icons
- [ ] Step 2.11: Verify — grep for remaining emoji patterns used as functional UI

### Verification
```bash
# Should return NO results for functional emoji (decorative empty-state emoji are OK):
grep -n "⚙️\|☰\|▾\|▸\|✕\|📌" src/Alfred.jsx
# Verify new icons render:
# Open app → check Settings buttons, accordion arrows, drag handles, enrich buttons
```

### Notes
[Space for notes during execution]

---

## Session 3: Component Polish

### Development Steps
- [ ] Step 3.1: Polish card containers globally — `bg-card text-card-foreground border border-border rounded-lg` pattern for ALL card-style divs
- [ ] Step 3.2: Standardize button sizes — ensure ALL action buttons use `min-h-[44px]` and consistent padding
- [ ] Step 3.3: Standardize form inputs — `bg-input-background border-border rounded-md` and consistent focus rings `focus:ring-ring`
- [ ] Step 3.4: Polish InboxCard — Update collapsed card, expanded accordion borders, AI status badges, action button row
- [ ] Step 3.5: Polish ExecutionDetailView — Card styling, element checkboxes, notes area, action button bar
- [ ] Step 3.6: Polish IntentionCard / EventCard — Consistent card borders, context badges using `bg-accent`, scheduling buttons
- [ ] Step 3.7: Polish ContextCard / ItemCard — Card hover states, tag display, element list styling
- [ ] Step 3.8: Polish header and navigation — Tab active/inactive states using new palette, connection status display
- [ ] Step 3.9: Polish capture bar — Bottom-fixed bar matches card styling
- [ ] Step 3.10: Polish mobile menu — Slide-out nav uses new color tokens
- [ ] Step 3.11: Typography pass — Ensure font-weight-medium on headings, text-foreground on primary text, text-muted-foreground on secondary everywhere
- [ ] Step 3.12: Final cross-view verification — Walk through every view checking visual consistency

### Verification
- Open app → navigate to every view (Home, Inbox, Contexts, Schedule, Intentions, Memories, Collections)
- Expand an inbox item → verify accordion styling
- Start an execution → verify detail view styling
- Edit an intention → verify form styling
- Check mobile viewport (360px) → verify responsive layout
- Verify all hover states work

### Notes
[Space for notes during execution]

---

## Figma Reference Files
- `docs/figma-reference/styles/theme.css` — Color tokens and CSS variables (SOURCE OF TRUTH)
- `docs/figma-reference/app/components/ui/button.tsx` — Button variant patterns
- `docs/figma-reference/app/components/ui/card.tsx` — Card component pattern
- `docs/figma-reference/app/components/ui/badge.tsx` — Badge/tag variant patterns
- `docs/figma-reference/app/components/ui/checkbox.tsx` — Checkbox styling
- `docs/figma-reference/app/components/ui/input.tsx` — Input field styling
- `docs/figma-reference/app/components/ui/accordion.tsx` — Accordion expand/collapse pattern
- `docs/figma-reference/app/pages/Inbox.tsx` — Reference implementation of inbox triage UI
- `docs/figma-reference/app/components/Header.tsx` — Reference implementation of header/nav
