# Project Context
We're adding a standalone **Timer** tool to Alfred (React + Supabase + Vercel +
Tailwind + Lucide). It's a new top-level nav item to the LEFT of SAM that opens a page
where the user builds a looping, multi-phase timer (labeled phases with durations in
seconds) and runs it. First use case: a breathing timer, e.g. breathe in 4s / hold 4s /
breathe out 6s / hold 7s, looping until a total duration elapses.

This is a self-contained client-side tool. It is NOT an item element type and must NOT
touch the execution / freeze pipeline. No database migration, no new dependencies, no
persistence in this pass.

# Reference Documents
- Technical spec: docs/technical-spec-timer.md
- Progress tracking: docs/progress-timer.md

# Your Task
1. Read the technical specification fully.
2. Review the progress tracking file.
3. Before writing code, locate how **SAM** is wired as a nav item and top-level
   page/route, and follow that exact pattern for the new Timer nav item and route
   (Timer goes immediately to the LEFT of SAM, Lucide `Timer` icon).
4. Execute the first incomplete step in the progress file (Step 1: nav item + route +
   page shell).
5. Update docs/progress-timer.md to mark the step complete and add any notes.
6. Give me explicit verification instructions, then STOP and wait for my confirmation
   before moving to the next step.

# Verification Pattern
After each step, tell me exactly what to do in the running app to confirm it works
(which nav item to click, what to type, what to observe). For Step 1 that means:
"Timer" appears to the left of SAM in the nav, clicking it loads the (empty) Timer
page, and SAM plus the other nav items still work.

# Important
- Discover and match existing patterns (nav markup, routing, numeric inputs, earth-tone
  Tailwind styling, Lucide icons). Don't introduce new conventions.
- No new npm packages. Audio via Web Audio API; haptics via navigator.vibrate
  (feature-detected).
- Timestamp-based run engine (performance.now()), not naive setInterval counting.
- Mark steps complete in the progress file as you finish them; add notes on any
  decisions or issues.
- One step at a time. If anything is unclear, stop and ask before coding.
