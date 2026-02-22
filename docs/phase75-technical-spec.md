# Phase 7.5: UI Visual Redesign — Technical Specification

## Overview

Migrate Alfred v5's visual identity from the current teal/mint color scheme to the warm earth-tone Figma design system. This is a visual-only change — no functionality changes, no React architecture changes, no new dependencies. The app stays as a single `Alfred.jsx` file using Tailwind CSS utility classes.

## Design System Source

All design tokens come from the Figma export at `docs/figma-reference/styles/theme.css`. The design system uses CSS custom properties mapped through Tailwind's `@theme inline` directive.

## Color Token Mapping

### Current → New Color Map

| Semantic Use | Current Tailwind Class | Current Hex | New CSS Variable | New Hex | New Tailwind Class |
|---|---|---|---|---|---|
| **Primary action** | `bg-primary` | `#16A085` (teal) | `--primary` | `#8B5D43` (warm brown) | `bg-primary` |
| **Primary hover** | `hover:bg-primary-hover` | `#138D75` | `--primary-hover` | `#6B4532` | `hover:bg-primary-hover` |
| **Primary light/accent** | `bg-primary-light` | `#a2d8c8` | `--primary-light` | `#D4B8A8` | `bg-primary-light` |
| **Page background** | `bg-primary-bg` | `#F8FFFE` | `--background` | `#FAFAF8` | `bg-background` |
| **Card background** | `bg-white` | `#FFFFFF` | `--card` | `#FFFFFF` | `bg-card` |
| **Success** | `bg-success` | `#26A69A` (teal-green) | `--success` | `#7A9B9B` (muted sage) | `bg-success` |
| **Success hover** | `hover:bg-success-hover` | `#00897B` | `--success-hover` | `#5F7E7E` | `hover:bg-success-hover` |
| **Success light** | `bg-success-light` | `#B2DFDB` | `--success-light` | `#B5D4CF` | `bg-success-light` |
| **Danger/destructive** | `bg-danger` | `#E74C3C` | `--destructive` | `#C85A54` | `bg-destructive` |
| **Danger hover** | `hover:bg-danger-hover` | `#C0392B` | `--destructive-hover` | `#A64842` | `hover:bg-destructive-hover` |
| **Danger light** | `bg-danger-light` | `#FADBD8` | `--destructive-light` | `#F5D9D6` | `bg-destructive-light` |
| **Warning/pause** | `bg-warning` | `#95A5A6` (gray) | `--warning` | `#9B7E6E` (warm taupe) | `bg-warning` |
| **Warning hover** | `hover:bg-warning-hover` | `#7F8C8D` | `--warning-hover` | `#7F6B5C` | `hover:bg-warning-hover` |
| **Warning light** | `bg-warning-light` | `#ECF0F1` | `--warning-light` | `#E4D2C3` | `bg-warning-light` |
| **Primary text** | `text-dark` | `#2C3E50` | `--foreground` | `#2A2520` | `text-foreground` |
| **Muted text** | `text-muted` | `#7F8C8D` | `--muted-foreground` | `#6B6660` | `text-muted-foreground` |
| **Borders** | `border-gray-200` | various grays | `--border` | `#E0D6CC` | `border-border` |
| **Secondary bg** | `bg-gray-200` | Tailwind gray | `--secondary` | `#E4D2C3` | `bg-secondary` |
| **Input background** | N/A | white | `--input-background` | `#ffffff` | `bg-input-background` |
| **Ring/focus** | `ring-primary` | teal | `--ring` | `#8B5D43` | `ring-ring` |

### Hardcoded Colors to Remove

These appear as inline Tailwind classes or one-off colors that must be replaced:

| Pattern to Find | Replace With |
|---|---|
| `bg-teal-100`, `bg-teal-600`, `text-teal-700`, `text-teal-600` | `bg-accent`, `bg-primary`, `text-primary`, `text-primary` |
| `bg-purple-600`, `hover:bg-purple-700` | `bg-primary`, `hover:bg-primary-hover` (enrich buttons) |
| `bg-amber-50`, `text-amber-700`, `bg-amber-400` | `bg-warning-light`, `text-warning`, `bg-warning` |
| `bg-green-50`, `text-green-700`, `bg-green-500` | `bg-success-light`, `text-success`, `bg-success` |
| `bg-red-500`, `text-red-500` | `bg-destructive`, `text-destructive` |
| `text-gray-400`, `text-gray-500`, `text-gray-600`, `text-gray-700`, `text-gray-800` | `text-muted-foreground` or `text-foreground` (context-dependent) |
| `bg-gray-50`, `bg-gray-100`, `bg-gray-200`, `bg-gray-300` | `bg-secondary`, `bg-muted`, `bg-secondary` (context-dependent) |
| `border-gray-200`, `border-gray-300` | `border-border` |
| `hover:bg-gray-100`, `hover:bg-gray-50` | `hover:bg-secondary/50` |
| `accent-primary` (checkbox accent) | Remove — use proper checkbox styling |
| `style={{ ... }}` with any color values | Replace with Tailwind class equivalents |

### Tag Badge Colors

Current uses `bg-teal-100 text-teal-700` for tag pills. New design uses:
- Tags in Intention sections: `bg-accent text-accent-foreground` 
- Tags in Item sections: `bg-success-light text-success-hover`
- Tag filter pills (active): `bg-primary text-primary-foreground`
- Tag filter pills (inactive): `bg-accent text-accent-foreground`

## Tailwind Configuration Changes

### Current: `tailwind.config.js` with `theme.extend.colors`

The current setup uses a JavaScript config with hardcoded hex values mapped to semantic names like `primary`, `success`, `danger`, `warning`, `dark`, `muted`.

### New: CSS Custom Properties via `theme.css`

The new system uses CSS custom properties defined in `theme.css` and mapped to Tailwind via `@theme inline`. This is the modern Tailwind v4 approach.

**Required changes to `tailwind.config.js`:**
Remove all custom color definitions from `theme.extend.colors`. The CSS variables in `theme.css` + `@theme inline` block handle everything.

Add these missing semantic tokens to `theme.css` that the current codebase uses but the Figma export doesn't define:

```css
/* Add to :root in theme.css */
--primary-bg: #FAFAF8;        /* alias for --background, used by current code */
--success-foreground: #ffffff; /* white text on success buttons */
--warning-foreground: #ffffff; /* white text on warning buttons */
```

And add to the `@theme inline` block:
```css
--color-primary-hover: var(--primary-hover);
--color-primary-light: var(--primary-light);
--color-primary-dark: var(--primary-dark);
--color-success: var(--success);
--color-success-hover: var(--success-hover);
--color-success-light: var(--success-light);
--color-destructive-hover: var(--destructive-hover);
--color-destructive-light: var(--destructive-light);
--color-warning: var(--warning);
--color-warning-hover: var(--warning-hover);
--color-warning-light: var(--warning-light);
```

## Icon Standardization

All buttons should use Lucide React icons consistently. The codebase already imports from `lucide-react`. This is about ensuring EVERY action button has an icon, not just some.

### Icon → Action Mapping

| Action | Icon | Current State |
|---|---|---|
| Add/Create | `<Plus />` | ✅ Already used |
| Start/Resume/Play | `<Play />` | ✅ Already used |
| Complete/Done | `<Check />` | ✅ Already used |
| Cancel/Close | `<X />` | ✅ Already used |
| Pause | `<Pause />` | ✅ Already used |
| Archive/Delete | `<Trash2 />` or `<Archive />` | ⚠️ Inconsistent — some archive buttons are text-only |
| Edit/Settings | `<Settings />` or `<Pencil />` | ⚠️ Currently uses emoji ⚙️ |
| Back | `<ArrowLeft />` | ✅ Already used |
| Expand/Collapse | `<ChevronDown />` / `<ChevronUp />` | ⚠️ Currently uses ▾/▸ text arrows |
| Drag handle | `<GripVertical />` | ⚠️ Currently uses ☰ text character |
| Share | `<Share2 />` | ✅ Already used |
| Copy/Clone | `<Copy />` | ✅ Already used |
| Enrich (AI) | `<Sparkles />` | ⚠️ Not used — enrich buttons have no icon |
| Connection status | `<Wifi />` / `<WifiOff />` | ⚠️ Currently uses colored dots only |

### New Imports Needed

Add to the existing Lucide import:
```javascript
import { 
  Plus, Share2, Play, Pause, Check, X, Trash2, ArrowLeft, Menu, Copy,
  // NEW:
  ChevronDown, ChevronUp, GripVertical, Pencil, Settings, Archive, 
  Sparkles, Wifi, WifiOff
} from "lucide-react";
```

## Component Polish Priorities

### Session 3 Focus: Key Components

These components get the most user interaction time and need the most attention:

1. **InboxCard** — The triage accordion is the most complex UI surface
2. **ExecutionDetailView** — Users spend active task time here  
3. **IntentionCard / EventCard** — Shown in multiple views
4. **ContextCard / ItemCard** — Used everywhere

### Style Patterns to Apply Globally

**Cards:**
- `bg-card text-card-foreground border border-border rounded-lg` (replaces `bg-white border border-gray-200 rounded`)
- Hover: `hover:border-primary transition-colors`
- Active/selected: `border-primary border-2`

**Buttons (consistent sizing):**
- Standard: `px-4 py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200`
- All primary actions: `bg-primary hover:bg-primary-hover text-primary-foreground`
- All success actions: `bg-success hover:bg-success-hover text-white`
- All destructive actions: `bg-destructive hover:bg-destructive-hover text-white`
- All secondary actions: `bg-secondary hover:bg-secondary/80 text-secondary-foreground`

**Form Inputs:**
- `bg-input-background border-border` (replaces `border border-gray-300`)
- Focus: `focus:outline-none focus:ring-2 focus:ring-ring`

**Typography:**
- Primary text: `text-foreground` (replaces `text-dark`)
- Secondary text: `text-muted-foreground` (replaces `text-muted`)
- Section headers: `text-lg font-medium` (Figma uses medium weight, not semibold)

## Success Criteria

1. **Zero hardcoded colors** — `grep` for hex values, `bg-teal-`, `bg-green-`, `bg-red-`, `bg-amber-`, `bg-purple-`, `text-gray-` in Alfred.jsx returns nothing
2. **Zero emoji icons** — No ⚙️, ☰, ▾, ▸, 📌, 📥, 📁, 📅, 💡, ⭐, 📋, 🎹 used as functional UI icons (decorative emoji in empty states are acceptable)
3. **All colors from CSS variables** — Every color class uses semantic tokens that resolve to `theme.css` variables
4. **Visual consistency** — Cards, buttons, inputs, and text look cohesive across all views
5. **No functionality changes** — All existing features work identically
