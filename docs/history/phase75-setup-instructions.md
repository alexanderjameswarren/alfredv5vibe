# Phase 7.5 Setup: Manual Prerequisites

Complete these steps BEFORE feeding any CLI prompts.

---

## Step 1: Create the Figma Reference Directory

In your project root, create a reference directory for the Figma design system files:

```bash
mkdir -p docs/figma-reference/styles
mkdir -p docs/figma-reference/app/components/ui
mkdir -p docs/figma-reference/app/components/figma
mkdir -p docs/figma-reference/app/pages
```

## Step 2: Copy Figma Files into Reference Directory

From the `src022226.zip` you uploaded, copy these files into your project:

```
docs/figma-reference/
├── styles/
│   ├── theme.css          ← SOURCE OF TRUTH for all colors
│   ├── index.css
│   ├── tailwind.css
│   └── fonts.css
├── app/
│   ├── components/
│   │   ├── ui/
│   │   │   ├── button.tsx     ← Button variant reference
│   │   │   ├── card.tsx       ← Card pattern reference
│   │   │   ├── badge.tsx      ← Badge/tag reference
│   │   │   ├── checkbox.tsx   ← Checkbox styling reference
│   │   │   ├── input.tsx      ← Input field reference
│   │   │   ├── accordion.tsx  ← Accordion expand/collapse reference
│   │   │   ├── select.tsx     ← Select dropdown reference
│   │   │   └── textarea.tsx   ← Textarea reference
│   │   ├── figma/
│   │   │   └── ImageWithFallback.tsx
│   │   └── Header.tsx         ← Header/nav reference
│   └── pages/
│       ├── Home.tsx
│       ├── Inbox.tsx          ← Inbox triage UI reference
│       ├── Contacts.tsx
│       ├── Schedule.tsx
│       ├── Intentions.tsx
│       ├── Memories.tsx
│       ├── Collections.tsx
│       └── Sam.tsx
```

These are READ-ONLY reference files. Claude CLI will read them to understand the target design language but will NOT modify them.

## Step 3: Copy Spec and Progress Files

Copy these files (from the CLI instruction package) into your project:

```bash
# From the downloaded files:
cp phase75-technical-spec.md docs/phase75-technical-spec.md
cp progress-phase75-ui-redesign.md docs/progress-phase75-ui-redesign.md
```

## Step 4: Save Session CLI Prompts

Save each session prompt where you can easily copy-paste from:

```
cli-prompt-session1-colors.md    → Session 1: Color migration
cli-prompt-session2-icons.md     → Session 2: Icon standardization  
cli-prompt-session3-polish.md    → Session 3: Component polish
```

## Step 5: Verify Project Structure

Your project should now look like:

```
alfred-v5/
├── docs/
│   ├── phase75-technical-spec.md
│   ├── progress-phase75-ui-redesign.md
│   └── figma-reference/
│       ├── styles/
│       │   └── theme.css          ← Color tokens
│       └── app/
│           ├── components/
│           │   ├── ui/            ← UI component references
│           │   └── Header.tsx     ← Header reference
│           └── pages/
│               └── Inbox.tsx      ← Inbox triage reference
├── src/
│   ├── Alfred.jsx                 ← Main file being modified
│   ├── supabaseClient.js
│   └── ...
├── tailwind.config.js             ← Will be updated in Session 1
└── package.json
```

## Step 6: Run Sessions

Feed each session prompt to Claude CLI in order:

1. **Session 1** (Colors): Paste `cli-prompt-session1-colors.md` content → verify → commit
2. **Session 2** (Icons): Paste `cli-prompt-session2-icons.md` content → verify → commit  
3. **Session 3** (Polish): Paste `cli-prompt-session3-polish.md` content → verify → commit

**Between each session:**
- Run `npm start` and test the app
- Commit working state: `git add . && git commit -m "Phase 7.5 Session N complete"`
- Only proceed to next session after verifying current session works

---

## Quick Reference: New Color Palette

| Role | Hex | Visual |
|---|---|---|
| Primary (actions) | `#8B5D43` | Warm brown |
| Primary hover | `#6B4532` | Dark brown |
| Primary light | `#D4B8A8` | Light tan |
| Background | `#FAFAF8` | Warm off-white |
| Card | `#FFFFFF` | White |
| Success | `#7A9B9B` | Muted sage |
| Destructive | `#C85A54` | Soft terracotta |
| Warning | `#9B7E6E` | Warm taupe |
| Text primary | `#2A2520` | Near black-brown |
| Text muted | `#6B6660` | Warm gray |
| Borders | `#E0D6CC` | Light tan border |
| Secondary bg | `#E4D2C3` | Warm beige |
| Accent | `#D4B8A8` | Light tan |
