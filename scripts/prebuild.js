const fs = require('fs');
const path = require('path');

const lines = [
  `REACT_APP_BUILD_TIMESTAMP=${new Date().toISOString()}`,
  `REACT_APP_COMMIT_SHA=${process.env.VERCEL_GIT_COMMIT_SHA || 'local'}`,
];

fs.writeFileSync('.env.production.local', lines.join('\n') + '\n');

// Copy the canonical SAM song/drill JSON Schema from the repo root into src/
// so CRA can `import` it (CRA blocks imports outside src/). The Edge Function
// gets its own copy in supabase/functions/_shared/ once the MCP authoring
// tools land (Step 4). Master lives at repo root; copies are regenerated on
// every build/start so they cannot drift.
const schemaMaster = path.join(__dirname, '..', 'sam-drill-format.schema.json');
const copies = [
  // For CRA (React) — cannot import outside src/.
  path.join(__dirname, '..', 'src', 'sam', 'lib', 'sam-drill-format.schema.json'),
  // For the Edge Function (Deno) — bundled with the mcp function so
  // append_sam_measures can validate authored measures. Run prebuild before
  // `supabase functions deploy mcp` or the tool file's import 404s at
  // runtime.
  path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'sam-drill-format.schema.json'),
];

if (fs.existsSync(schemaMaster)) {
  const content = fs.readFileSync(schemaMaster);
  for (const dest of copies) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
} else {
  console.warn(
    `[prebuild] ${schemaMaster} not found — schema copy skipped. ` +
      `Validator imports will fail if the copy doesn't already exist.`
  );
}
