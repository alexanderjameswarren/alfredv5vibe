# Alfred - Project Setup

## Tech Stack
- React (Create React App)
- Supabase (Database)
- Vercel (Hosting)
- Tailwind CSS (Styling)

## Local Development

### Prerequisites
- Node.js installed
- Supabase CLI installed (`supabase --version` should work)

### Getting Started
```bash
npm install
npm start
```

Runs at http://localhost:3000

### Environment
Uses Supabase cloud database:
- URL: https://zuqjyfqnvhddnchhpbcz.supabase.co
- Credentials in `src/supabaseClient.js`

## Database Schema Changes

### Using Supabase CLI
Project is linked to Supabase cloud.

**Create a migration:**
```bash
supabase migration new description_of_change
```

**Edit the generated file in** `supabase/migrations/`

**Push to cloud:**
```bash
supabase db push
```

**Commit the migration:**
```bash
git add supabase/migrations/
git commit -m "Add migration: description"
git push
```

## Deployment

### Automatic
Every push to `main` branch auto-deploys to Vercel.

**Live URL:** https://alfredv5vibe.vercel.app

### Manual (if needed)
```bash
git push
```
Wait ~2 minutes for Vercel to build and deploy.

## Data Model

### Tables
- **contexts** - Work/life contexts with privacy settings
- **items** - Reference items with elements (steps/bullets/headers)
- **intents** - Captured thoughts, triaged into intentions or items
- **events** - Scheduled instances of intentions
- **executions** - Active execution tracking with progress
- **inbox** - Captured items awaiting triage with AI suggestions (future)

### Key Relationships
- Items can link to contexts
- Intentions can link to items and contexts
- Events link to intentions
- Executions track event completion

## Code Structure

- `src/Alfred.jsx` - Main application component (2,360 lines)
- `src/supabaseClient.js` - Supabase configuration
- `src/App.js` - Root component wrapper
- `supabase/migrations/` - Database schema versions

## For Claude Code

When making database changes:
1. Use `supabase migration new [name]` to create migration file
2. Edit the SQL file
3. Run `supabase db push` to apply
4. Commit the migration file

When adding features:
- Main logic in `src/Alfred.jsx`
- Data structure uses camelCase (JavaScript) / snake_case (database)
- Storage adapter handles conversion automatically