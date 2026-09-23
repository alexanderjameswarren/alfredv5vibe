---
name: alfred-enrich
description: "Enrich Alfred inbox items with AI-powered suggestions for organizing captures into the GTD system. Use this skill whenever the user asks to enrich, process, triage, or organize their Alfred inbox items — including \"enrich my inbox\", \"process inbox\", \"re-enrich with Opus\", or references to inbox items needing AI suggestions. Also trigger when the user asks Claude to analyze a captured item and suggest how to organize it in Alfred."
---

# Alfred Inbox Enrichment

This skill defines how to analyze Alfred inbox captures and write structured suggestions back using the `update_inbox_item` MCP tool.

## CRITICAL: How to Execute

**Always use the Alfred MCP tools directly in the conversation.** Call `get_inbox`, `get_contexts`, `get_tags`, `get_collections`, `search_items`, and `update_inbox_item` as direct tool calls.

**NEVER** create code artifacts, React apps, scripts, or any other programmatic wrapper to perform enrichment. The MCP tools are already available as conversation-level tools — just call them.

## When to Use

- User says "enrich my inbox", "process my inbox", or "parse my inbox"
- User asks to re-enrich inbox items (upgrade with deeper analysis)
- User references specific inbox items needing organization suggestions
- User captures something and wants AI help categorizing it

## Enrichment Workflow

### Step 1: Identify Target Items

**For initial enrichment:**
- Use `get_inbox` with `ai_status: "not_started"` to find unenriched items
- Process each item sequentially

**For re-enrichment:**
- Use `get_inbox` (no ai_status filter) and select items where `ai_status` is `enriched` or `re_enriched` AND `archived` is `false`
- Read the existing suggestions on each item before re-analyzing
- Your goal is to improve on the previous suggestions

### Step 2: Research Before Suggesting

**Always do this research for EVERY item before writing suggestions.** Do not guess — look up real data.

1. **Call `get_contexts` first** to understand the user's organizational structure
2. **Search for existing items** via `search_items` to avoid creating duplicates. If the captured text references something that already exists (like "make chicken tikka tonight"), find the existing item and use `suggested_item_id` to link to it rather than creating a new one
3. **Check `get_tags`** and reuse the existing taxonomy. Read the counts as well as the names — a tag used many times is a real axis the user filters on; a tag used once is a mistake waiting to be cleaned up, not a precedent to follow
4. **Check `get_collections`** to see if the capture belongs in a collection (like a grocery list or shopping list). Collections with `is_capture_target: true` are frequently used for quick capture — prioritize these
5. **If the captured text contains a URL**, note this in your reasoning (you can't fetch URLs via MCP, but flag it for the user)

### Step 3: Analyze and Suggest

For each inbox item, determine:

**Context**: Which existing context does this belong to? Always map to an existing context.

**Item vs. Intent vs. Both**:
- **Item** (`suggest_item: true`): Reusable reference material — recipes, checklists, project notes, how-tos. Things you'd want to find and use again.
- **Intent** (`suggest_intent: true`): Action items, tasks, things to do. "Call the plumber", "buy groceries", "cook dinner tonight".
- **Both**: Often the right answer. A recipe (item) + "cook this tonight" (intent). A checklist (item) + "pack for trip" (intent).

**Event**: If there's a specific date mentioned (or implied by "tomorrow", "next Tuesday", etc.), set `suggest_event: true` and resolve the date to `YYYY-MM-DD` format. Use today's date for reference.

**Recurrence**: For intents, set the recurrence pattern — `once` for one-time tasks, or `daily`/`weekly`/`monthly`/`yearly` for recurring ones.

**Collection**: If the capture mentions adding something to a list (groceries, shopping, packing), find the matching collection via `get_collections` and set `suggested_collection_id`.

**Existing Item Link**: If the capture references something that already exists as an item (like a known recipe or checklist), set `suggested_item_id` to link to it instead of creating a new item.

**Tags**: see the section below. Tags have their own rules and they are stricter than everything else in this skill.

### Step 3a: Tags

Format: lowercase, with spaces between words, and no punctuation — e.g. `whole foods`, `stir fry`, NOT `Whole_Foods` or `stir-fry`. Tags are normalised on save, so anything else is silently rewritten.

**Reuse first, and treat that as a hard default.** Call `get_tags` and find the closest existing tag before considering a new one. A tag that lands on a single item is not a tag, it is a note — it clutters every filter bar and helps nobody find anything. A tag earns its place by being the thing someone would filter on to find this item later, or to decide what to do.

**A new tag must fit one of the shapes already in use.** Before suggesting one, name which shape it is. If you can't name the shape, don't suggest the tag.

For recipes and food, the shapes are:

1. **Cuisine** — italian, mexican, indian, chinese, middle eastern
2. **Protein** — chicken, beef, pork, beans, lentils, tofu, fish
3. **Core carb** — pasta, rice, potato
4. **Dish role** — soup, salad, side, dessert, sauce, stir fry

Those four exist because of how the tags actually get used: finding a recipe fast, or deciding what to make. Those decisions run on cuisine, protein, core carb and dish role. Nothing else.

**Do not tag** cooking method, equipment, source or author, season, difficulty, or incidental ingredients. `corn`, `squash`, `mushroom` and `cheese` were each considered and deliberately rejected — nobody decides what to cook based on them, so they add noise to the filter bar without adding a way in.

Outside food, the same test applies even though the shapes differ: would the user filter on this to find things later? Development work uses shapes like `bug`, `ui`, `routing`, `mcp`, `ai`, and app names like `sam`. Health and wellbeing use `health`, `mobility`, `nervous system`. Match the shape you find in `get_tags` — don't invent a new axis.

**Never tag what the context already says.** An item in the Recipes context does not need a `recipe` tag. That tag existed, sat on fifteen items, and was deleted precisely because it told nobody anything.

Two or three good tags beat six. If nothing fits, suggest none — an untagged item is easier to fix later than a taxonomy full of singletons.

### Step 4: Structure Elements (for Items)

Element types are exactly three: `header`, `bullet`, `step`. There is no
`ingredient` type — an unknown type renders as a numbered step and corrupts the
item's step numbering.

Ingredient bullets carry `"collectable": true`. That flag is what lets the user
add the line to a shopping list, so a recipe without it is a recipe you can't
shop from.

**Recipes:**
```json
[
  {"type": "header", "text": "Ingredients"},
  {"type": "bullet", "text": "2 cups flour", "collectable": true},
  {"type": "bullet", "text": "1 tsp salt", "collectable": true},
  {"type": "bullet", "text": "1/2 cup butter, cold and cubed", "collectable": true},
  {"type": "header", "text": "Steps"},
  {"type": "step", "text": "Preheat oven to 350°F"},
  {"type": "step", "text": "Cut in butter until pea-sized crumbles form"},
  {"type": "header", "text": "Notes"},
  {"type": "bullet", "text": "Dough can be made a day ahead."}
]
```

**One purchasable product per ingredient bullet.** The shopping list maps each
bullet to a single item, so a bundled line can never be shopped:

- "Salt and pepper" → two bullets
- "Stage 1 herbs: 6 sprigs thyme, 2 sprigs rosemary, 2 bay leaves" → three bullets
- "Butter or neutral oil" → one bullet (a choice at the store, not two purchases)
- "1 small onion, finely diced" → one bullet (preparation stays attached)

**Sections are real headers.** Never fake one with a bullet like
`--- Dressing ---`. A recipe may have several ingredient headers
("Ingredients — Dressing", "Ingredients — Toppings"); bullets under all of them
are collectable. Notes bullets are not.

**Checklists and grouped content** work as before — bullets, with headers to
group them. Only mark `collectable` on things the user would buy.

### Step 5: Set Confidence and Reasoning

**`ai_confidence`** (0.0 to 1.0):
- **0.9-1.0**: Exact match to existing item, clear intent, unambiguous context
- **0.7-0.8**: Good match, confident about context and type, minor ambiguity
- **0.5-0.6**: Reasonable guess, multiple contexts could apply, or captured text is vague
- **Below 0.5**: Unclear what the user wants, flagging for manual review

**`ai_reasoning`**: A brief sentence explaining your suggestions. This is displayed to the user during triage. Examples:
- "Matched to existing 'Chicken Tikka Masala' recipe. Suggesting cook tonight as intent."
- "Looks like a grocery list addition. Routing to Grocery List collection in Home context."
- "URL appears to be a recipe page. Created new item with parsed ingredients and steps."
- "Ambiguous — could be a task or a note. Defaulted to intent in Home context."

If you suggested a tag that doesn't already exist, say so in the reasoning and name which shape it fits. That gives the user a one-line reason to accept or reject it, rather than a tag appearing with no explanation.

### Step 6: Write Suggestions

Call `update_inbox_item` with the inbox item's ID and all suggestion fields. Set `ai_status` to:
- `"enriched"` for initial enrichment
- `"re_enriched"` for re-enrichment

## Re-Enrichment Protocol

When re-enriching items that already have suggestions:

1. Read the existing suggestions on the inbox record
2. Consider what might have been wrong — the user may have edited the `captured_text` to provide more clarity
3. Do deeper research: check more items, look at execution history for related items, examine element structures of similar items
4. Provide improved suggestions with updated reasoning explaining what changed

Re-enrichment is also a chance to drop a tag the first pass shouldn't have suggested. Don't carry a previous suggestion forward just because it's there — re-test it against Step 3a.

## Key Principles

- **Suggest generously, except with tags**: The user reviews and approves everything before it's created, so it's easier for them to remove a suggested context, item or collection than to add a missing one. Tags are the exception. An unwanted tag isn't removed during triage — it's accepted, and then it sits in every filter bar from then on. Be sparing there and generous everywhere else.
- **Prefer existing over new**: Always try to link to existing contexts, items, tags, and collections rather than suggesting new ones.
- **Items with `is_capture_target: true`** are frequently referenced — prioritize linking to these.
- **Collections with `is_capture_target: true`** are frequently used for quick capture — prioritize routing to these.
- **Every field is optional** except `ai_confidence` and `ai_reasoning`. Only set fields that are relevant.

## Batch Processing

When enriching multiple items:
- Research contexts and tags once, then reuse across items (no need to call `get_contexts` and `get_tags` for every single item)
- Do item-specific searches (like `search_items`) per item
- Report progress as you go: "Enriched 3 of 7 items..."
- If an item is genuinely unclear, set low confidence and move on rather than getting stuck
- Watch for a new tag you suggested on an earlier item in the batch. If it was right, it should fit later items too; if it fits only the one, it was a note, not a tag — drop it.
