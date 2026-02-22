# Project Context
Alfred v5 is a React household management app. We're migrating the visual identity from a teal/mint color scheme to a warm earth-tone design system created in Figma. This is Session 1 of 3: Color Scheme Migration.

This is a VISUAL ONLY change. No functionality changes. No new components. No architecture changes.

# Reference Documents
- Technical spec: docs/phase75-technical-spec.md
- Progress tracking: docs/progress-phase75-ui-redesign.md
- Figma design tokens: docs/figma-reference/styles/theme.css (THIS IS THE SOURCE OF TRUTH FOR ALL COLORS)
- Figma reference components: docs/figma-reference/app/components/ui/ (shows how new design tokens are used)
- Figma reference pages: docs/figma-reference/app/pages/ (shows real page implementations)

# Critical Constraints
1. Alfred.jsx is the ONLY file you modify for color classes (it's the entire app UI)
2. You will ALSO update tailwind.config.js and the CSS files to wire up the new design tokens
3. Do NOT change any JavaScript logic, state management, event handlers, or component structure
4. Do NOT add or remove any React components
5. Do NOT change any function signatures or prop interfaces
6. ONLY change: CSS class strings, Tailwind config, and CSS variable definitions

# Your Task
1. Read the technical specification (docs/phase75-technical-spec.md) — pay special attention to the Color Token Mapping table
2. Read the Figma theme.css (docs/figma-reference/styles/theme.css) — these are the target color values
3. Read the progress tracking file (docs/progress-phase75-ui-redesign.md) — Session 1 steps
4. Execute each step in order, updating the progress file after each

# Step-by-Step Execution

## Step 1.1: Set up the new CSS theme
Copy the Figma theme.css content into the project's CSS. The existing tailwind config uses JavaScript-based color tokens. The new system uses CSS custom properties with @theme inline. You need to:
- Create or update the project's CSS to include the `:root` variables and `@theme inline` block from the Figma theme.css
- Make sure the CSS is imported in the app's entry point

## Step 1.2: Add missing semantic tokens
The Figma export doesn't include all the tokens the current codebase needs. Add these CSS variables to `:root` and map them in `@theme inline`:
- `--color-primary-hover`, `--color-primary-light`, `--color-primary-dark`
- `--color-success`, `--color-success-hover`, `--color-success-light`  
- `--color-destructive-hover`, `--color-destructive-light`
- `--color-warning`, `--color-warning-hover`, `--color-warning-light`
These are already defined as `--success`, `--warning`, etc. in the Figma `:root` — they just need the `--color-` prefix mappings in `@theme inline`.

## Step 1.3: Clean up tailwind.config.js
Remove ALL hardcoded color hex values from `theme.extend.colors`. The CSS variables now handle all color definitions. Keep any non-color config (content paths, plugins, etc.).

## Steps 1.4–1.11: Migrate Alfred.jsx colors
Work through the Alfred.jsx file systematically, replacing color classes per the mapping table in the tech spec. Do this in logical groups:
- Background colors (Step 1.4)
- Text colors (Step 1.5)  
- Border colors (Step 1.6)
- Semantic action colors — danger→destructive (Step 1.7)
- Tag/badge colors — teal→accent (Step 1.8)
- One-off hardcoded colors — purple, amber, etc. (Step 1.9)
- Hover/focus states (Step 1.10)
- Inline style attributes (Step 1.11)

## Step 1.12: Verification
Run these grep commands and report results:
```bash
grep -n "bg-teal-\|bg-green-\|bg-red-\|bg-amber-\|bg-purple-\|text-teal-\|text-green-\|text-red-\|text-amber-" src/Alfred.jsx
grep -n "bg-danger\|hover:bg-danger\|text-danger" src/Alfred.jsx  
grep -n "text-dark\b" src/Alfred.jsx
grep -n "bg-primary-bg" src/Alfred.jsx
```
All should return zero results.

# Verification Pattern
After completing all steps, ask me to:
1. Run `npm start` and open the app
2. Check the Home view — should see warm browns/taupes instead of teals
3. Navigate to Inbox → expand an item → check form colors
4. Navigate to Intentions → check button and badge colors
5. Check that all text is readable and no colors are missing/broken

Wait for my verification before we start Session 2 (Icons).

# Important
- Update the progress file after each step group
- Add notes about any decisions or edge cases encountered
- If a color class doesn't have an obvious mapping, add a note and ask
- The goal is ZERO hardcoded colors — every color must come from CSS variables
- When in doubt, check docs/figma-reference/app/pages/Inbox.tsx to see how the Figma design uses the tokens
