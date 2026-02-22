Read docs/phase7-progress.md and identify the first step with status "⬜ Not Started".
Update that step to "🟡 In Progress" and update the Last Updated timestamp.
Then read docs/phase7-implementation-steps.md and find the corresponding step number. Follow the requirements exactly.

CONTEXT: This is Phase 7 of Alfred v5 — building an MCP server on Supabase Edge Functions. Read docs/Alfred_Phase7_Implementation_Plan_v3.md for full architecture context if you need to understand the bigger picture.

IMPORTANT: For any database changes (SQL):
- Generate the complete SQL statements
- Format them as copy-paste ready
- DO NOT execute them yourself
- Present them to me to run in Supabase SQL Editor

For Supabase Edge Function code:
- Edge Functions use Deno runtime (TypeScript, no node_modules)
- Dependencies are imported via npm: specifiers or jsr: specifiers
- Shared code goes in supabase/functions/_shared/
- Each function has its own deno.json for dependencies
- Environment variables accessed via Deno.env.get()
- SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are auto-available

For React app code changes:
- Implement in existing src/ files or create new components
- Follow existing patterns and conventions (Tailwind CSS, teal color palette)
- The app uses React Router, @supabase/supabase-js, and is deployed on Vercel

For terminal/CLI commands:
- Present them clearly and tell me to run them myself
- DO NOT execute system commands

After implementation, tell me what to verify. I will test and confirm when it's working, then I'll update the step to "✅ Complete".
