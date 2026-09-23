// ============================================================================
// supabase/functions/_shared/tools/clipboard.ts
//
// Alfred Clipboard read tools. Spec: docs/technical-spec-clipboard.md § 4.2.
//
//   get_recent_clips    tier 1 — what was clipped lately, as TEXT. No images.
//   get_clip_slices     tier 1 — the screenshot of one clip, as image blocks.
//   archive_inbox_item  tier 2 — hide a handled inbox item; reversible.
//
// ---------------------------------------------------------------------------
// TEXT FIRST, PIXELS ON REQUEST
// ---------------------------------------------------------------------------
//
// These are deliberately two tools rather than one. A clip's text is cheap and
// answers most questions; its screenshot is expensive — base64 is 4/3 of the
// bytes and every image block lands in the model's context whether or not it
// gets looked at. So `get_recent_clips` never returns an image, and
// `get_clip_slices` exists for the cases where layout actually matters.
//
// ---------------------------------------------------------------------------
// THE HEAVY-COLUMN RULE, AND WHY THIS TOOL IS THE EXCEPTION
// ---------------------------------------------------------------------------
//
// The platform contract says list reads exclude heavy jsonb. `page_text` and
// `links` are exactly that, and `get_recent_clips` returns both, because
// delivering them IS the tool — excluding them would leave a list of titles
// nobody can act on.
//
// The obligation that comes with the exception is a bounded response, so both
// are capped PER CLIP in the payload, with a flag when the cap bites:
// RESPONSE_PAGE_TEXT_CHARS and RESPONSE_LINKS. These caps are about what one
// tool call returns, and are unrelated to `clips.text_truncated`, which records
// that the capture function cut the page on the way IN. A clip can have neither
// flag, either, or both, and they mean different things:
//
//   text_truncated                  the stored text is not the whole page
//   page_text_truncated_in_response the stored text is whole, this reply is not
// ============================================================================

import { clampLimit, defineTool, envelope, type Context } from "../platform.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const BUCKET = "clipboard";

/** Spec 4.2: default 5, then the platform ceiling. */
const DEFAULT_CLIP_LIMIT = 5;

/**
 * How many clips to examine before filtering out archived ones. Archived state
 * lives on the paired inbox row and `clips` has no foreign key to `inbox`
 * (deliberately — triage hard-deletes inbox rows), so PostgREST cannot embed
 * the join and the filter has to happen here. Over-fetch, filter, then cut to
 * `limit`. At a few clips a day this window is the whole history several times
 * over; it is a ceiling, not a page size.
 */
const ARCHIVE_SCAN_WINDOW = 50;

/** Per-clip response caps. See the header. */
const RESPONSE_PAGE_TEXT_CHARS = 60_000;
const RESPONSE_LINKS = 200;

/** Spec 4.2: at most 8 image blocks per call. */
const MAX_SLICE_BLOCKS = 8;

/**
 * Total base64 budget for one get_clip_slices reply. Real slices run 40-80 KB,
 * so eight of them are under a megabyte and this never bites. It exists for the
 * case where something has put 2 MB objects in the bucket: a reply that large
 * is worse than a reply that says it stopped.
 */
const MAX_SLICE_BASE64_BYTES = 12 * 1024 * 1024;

type McpBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Shared wording appended to both clip tools' descriptions, so the two cannot
 * drift on the one thing the model most needs to know. Spec 4.2.
 */
export const CLIP_VOCAB =
  "WHAT A CLIP IS: the WHOLE page, captured in one go — all of its text, every " +
  "link on it, and a screenshot sliced top to bottom. Nothing was extracted or " +
  "summarised on the way in, ON PURPOSE. So one clip often holds SEVERAL " +
  "DISTINCT ITEMS: a job board page is many postings, a search result page is " +
  "many results. Do not assume a clip is about one thing. Work out what is on " +
  "the page, say what you found, and ask which one Alex means if it is not " +
  "obvious. " +
  "READ THE TEXT FIRST. get_recent_clips gives you page_text and links and is " +
  "cheap. Call get_clip_slices only when the LAYOUT or the VISUALS actually " +
  "matter — a chart, a screenshot of an interface, a page whose meaning depends " +
  "on where things sit — or when the text came out thin, garbled or confusing. " +
  "A clip's `links` list is how you point Alex at the OTHER items on a page he " +
  "clipped without him having to clip each one.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function requireText(tool: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${tool}: ${field} is required and must be a non-empty string (got ${JSON.stringify(value)}).`,
    );
  }
  return value.trim();
}

/**
 * Which of these inbox ids are STILL LIVE — present in the table and not
 * archived?
 *
 * One query for the whole page of clips rather than one per clip.
 *
 * ⚠️ IT RETURNS THE LIVE SET, NOT THE ARCHIVED SET, AND THAT IS THE FIX FOR A
 * REAL BUG. It used to return the ids it found with `archived = true`, and a
 * clip whose inbox row had been DELETED was therefore absent from that set and
 * counted as live. Since deletion was exactly what the inbox trash can did, the
 * one action meant to make a clip go away made it permanent: it came back to
 * every new conversation, for ever, and nothing could stop it.
 *
 * Asking "which are live" makes both ways of leaving the inbox — archived, or
 * gone — fall on the same side of the test, because neither is in the answer.
 *
 * Step 5b makes the trash can archive rather than delete, so new rows will not
 * vanish like this. Rows deleted BEFORE that change still can, and this is what
 * covers them.
 */
async function readInboxState(
  ctx: Context,
  inboxIds: string[],
): Promise<{ live: Set<string>; notes: Map<string, string> }> {
  const live = new Set<string>();
  const notes = new Map<string, string>();
  if (inboxIds.length === 0) return { live, notes };

  // `source_metadata` comes along for the ride rather than in a second query:
  // the screenshot note lives in it, and this row is already being read.
  const { data, error } = await ctx.db
    .from("inbox")
    .select("id, archived, source_metadata")
    .in("id", inboxIds);
  if (error) throw new Error(`get_recent_clips: could not read inbox state: ${error.message}`);

  for (const r of (data ?? []) as Array<{
    id: string;
    archived: boolean | null;
    source_metadata: Record<string, unknown> | null;
  }>) {
    // `!== true` rather than `=== false`: archived is nullable, and a null there
    // means "never archived", same as false.
    if (r.archived !== true) live.add(r.id);
    const note = r.source_metadata?.screenshot_note;
    if (typeof note === "string" && note.length > 0) notes.set(r.id, note);
  }
  return { live, notes };
}

/** The screenshot note for one clip, or null. Used by get_clip_slices. */
async function screenshotNoteFor(ctx: Context, inboxId: string | null): Promise<string | null> {
  if (!inboxId) return null;
  const { data, error } = await ctx.db
    .from("inbox")
    .select("source_metadata")
    .eq("id", inboxId)
    .maybeSingle();
  // A missing note is not worth failing a slice read over — the images are the
  // point and the caller still gets told the screenshot is incomplete.
  if (error || !data) return null;
  const note = (data.source_metadata as Record<string, unknown> | null)?.screenshot_note;
  return typeof note === "string" && note.length > 0 ? note : null;
}

// ---------------------------------------------------------------------------
// get_recent_clips — tier 1
// ---------------------------------------------------------------------------

export const getRecentClipsTool = defineTool({
  name: "get_recent_clips",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_recent_clips";
    const LIMIT = clampLimit((args.limit as number | undefined) ?? DEFAULT_CLIP_LIMIT);

    const source = args.source === undefined || args.source === null
      ? null
      : String(args.source);
    if (source !== null && source !== "clipboard" && source !== "cli") {
      throw new Error(`${T}: source must be "clipboard" or "cli" (got ${JSON.stringify(args.source)}).`);
    }

    const sinceMinutes = args.since_minutes;
    if (sinceMinutes !== undefined && sinceMinutes !== null) {
      if (typeof sinceMinutes !== "number" || !Number.isFinite(sinceMinutes) || sinceMinutes <= 0) {
        throw new Error(`${T}: since_minutes must be a positive number (got ${JSON.stringify(sinceMinutes)}).`);
      }
    }

    const includeArchived = args.include_archived === true;

    // Over-fetch only when archived rows have to be filtered out here; when
    // they are included, `limit` is exact and the extra rows would be waste.
    const scan = includeArchived ? LIMIT : Math.min(ARCHIVE_SCAN_WINDOW, Math.max(LIMIT * 4, 20));

    let q = ctx.db
      .from("clips")
      .select(
        "id, source, url, title, captured_at, created_at, inbox_id, slice_count, " +
          "screenshot_truncated, text_truncated, page_width, page_height, page_text, links",
      )
      // created_at, not captured_at: created_at is server truth and never null,
      // while captured_at is whatever the client reported and may be skewed or
      // absent. "What did I just clip" is a question about when it ARRIVED.
      .order("created_at", { ascending: false })
      .limit(scan);

    if (source) q = q.eq("source", source);
    if (typeof sinceMinutes === "number") {
      q = q.gte("created_at", new Date(Date.now() - sinceMinutes * 60_000).toISOString());
    }

    const { data, error } = await q;
    if (error) throw new Error(`${T}: ${error.message}`);

    type Row = {
      id: string;
      source: string;
      url: string | null;
      title: string | null;
      captured_at: string | null;
      created_at: string;
      inbox_id: string | null;
      slice_count: number;
      screenshot_truncated: boolean;
      text_truncated: boolean;
      page_width: number | null;
      page_height: number | null;
      page_text: string;
      links: Array<{ text: string; href: string }> | null;
    };
    // `as unknown as` and not a bare `as`: supabase-js types a select's `data`
    // as a union that includes GenericStringError[], which does not overlap Row,
    // so the direct assertion is a compile error. The cast is still ours to own
    // -- the column list above is hand-typed and nothing verifies it matches.
    let rows = (data ?? []) as unknown as Row[];

    const { live, notes } = await readInboxState(
      ctx,
      rows.map((r) => r.inbox_id).filter((v): v is string => typeof v === "string"),
    );

    if (!includeArchived) {
      // A null inbox_id stays: it means the pairing update failed at capture
      // time (see clip-capture), so an inbox row DOES exist and is untriaged —
      // we just do not know which one. Treating that as handled would hide a
      // clip nobody has looked at.
      rows = rows.filter((r) => !r.inbox_id || live.has(r.inbox_id));
    }

    const matched = rows.length;
    const page = rows.slice(0, LIMIT);

    const clips = page.map((r) => {
      const links = Array.isArray(r.links) ? r.links : [];
      const textOverCap = r.page_text.length > RESPONSE_PAGE_TEXT_CHARS;
      const linksOverCap = links.length > RESPONSE_LINKS;
      return {
        id: r.id,
        source: r.source,
        url: r.url,
        title: r.title,
        captured_at: r.captured_at,
        created_at: r.created_at,
        inbox_id: r.inbox_id,
        slice_count: r.slice_count,
        screenshot_truncated: r.screenshot_truncated,
        text_truncated: r.text_truncated,
        // The ORIGINAL page size in CSS pixels, before the extension scaled it to
        // 1280 wide. Returned because Claude was otherwise estimating page height
        // from the slice count, which is a guess built on a guess.
        page_width: r.page_width,
        page_height: r.page_height,
        // What the screenshot actually is, and when it is incomplete, WHY —
        // composed by the extension at capture time, where the facts are. Null
        // for clips saved before this was recorded.
        screenshot_note: r.inbox_id ? notes.get(r.inbox_id) ?? null : null,
        page_text: textOverCap ? r.page_text.slice(0, RESPONSE_PAGE_TEXT_CHARS) : r.page_text,
        page_text_truncated_in_response: textOverCap,
        page_text_total_chars: r.page_text.length,
        links: linksOverCap ? links.slice(0, RESPONSE_LINKS) : links,
        links_truncated_in_response: linksOverCap,
        link_count: links.length,
      };
    });

    return envelope(clips, {
      limit_applied: LIMIT,
      truncated: matched > page.length,
      total: matched > page.length ? matched : undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// get_clip_slices — tier 1
// ---------------------------------------------------------------------------

export const getClipSlicesTool = defineTool({
  name: "get_clip_slices",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_clip_slices";
    const clipId = requireText(T, "clip_id", args.clip_id);

    const { data: clip, error } = await ctx.db
      .from("clips")
      .select("id, title, url, source, captured_at, slice_paths, slice_count, screenshot_truncated, inbox_id")
      .eq("id", clipId)
      .maybeSingle();

    if (error) throw new Error(`${T}: ${error.message}`);
    if (!clip) {
      throw new Error(
        `${T}: no clip with id ${clipId}. Use get_recent_clips to find the right id.`,
      );
    }

    const paths = (clip.slice_paths as string[] | null) ?? [];
    const total = paths.length;

    if (total === 0) {
      throw new Error(
        `${T}: clip ${clipId} ("${clip.title}") has no screenshot. ` +
          (clip.source === "cli"
            ? "It is a CLI report, which never has one — its text is in get_recent_clips."
            : "The capture saved text only. Its text is in get_recent_clips."),
      );
    }

    // `from`/`to` are 1-based slice numbers, inclusive, matching the file names
    // (slice-01.jpg is slice 1).
    const rawFrom = args.from === undefined || args.from === null ? 1 : Number(args.from);
    const rawTo = args.to === undefined || args.to === null ? total : Number(args.to);
    if (!Number.isInteger(rawFrom) || !Number.isInteger(rawTo)) {
      throw new Error(`${T}: from and to must be whole slice numbers.`);
    }
    if (rawFrom < 1 || rawFrom > total) {
      throw new Error(`${T}: from must be between 1 and ${total} (this clip has ${total} slices).`);
    }
    if (rawTo < rawFrom) {
      throw new Error(`${T}: to (${rawTo}) is before from (${rawFrom}).`);
    }

    const start = rawFrom;
    const end = Math.min(rawTo, total);
    const requested = end - start + 1;
    const capped = Math.min(requested, MAX_SLICE_BLOCKS);
    const lastReturned = start + capped - 1;

    const notes: string[] = [];
    if (requested > MAX_SLICE_BLOCKS) {
      notes.push(
        `Asked for ${requested} slices; ${MAX_SLICE_BLOCKS} is the per-call cap. ` +
          `Returning ${start}-${lastReturned}. For the rest, call again with ` +
          `from: ${lastReturned + 1}.`,
      );
    }
    if (clip.screenshot_truncated) {
      // ⚠️ THIS USED TO ASSERT THE 24-SLICE CAP, UNCONDITIONALLY, AND IT WAS
      // WRONG THREE TIMES OUT OF THREE. Pages of 6047, 6562 and 7829 CSS pixels
      // plan five to seven slices — nowhere near 24 — and every one of them was
      // told it had overrun a cap it never approached. The real reason (slices
      // that stopped following the page) was known by the extension and reached
      // nothing downstream.
      //
      // The reason now travels with the clip, on the paired inbox row. If it is
      // there, say it; if it is not, say only what is certain, which is that the
      // screenshot is incomplete. NEVER GUESS A CAUSE HERE.
      const stored = await screenshotNoteFor(ctx, clip.inbox_id as string | null);
      notes.push(
        stored
          ? `⚠️ SCREENSHOT INCOMPLETE. ${stored}`
          : `⚠️ This screenshot is INCOMPLETE — it does not show the whole page. ` +
            `The reason was not recorded for this clip (it predates the note being ` +
            `stored). The page TEXT is unaffected: read page_text from get_recent_clips.`,
      );
    }

    // ctx.db, so the download carries the caller's own token and the bucket's
    // folder-per-user read policy is what decides. Spec 4.2 is explicit about
    // this: the service role is not used for reads.
    const rows: Array<{ n: number; name: string; bytes: number }> = [];
    const images: Array<{ data: string; mimeType: string }> = [];
    let base64Total = 0;
    let stoppedForBudget = 0;

    for (let i = 0; i < capped; i++) {
      const n = start + i;
      const path = paths[n - 1];
      const { data: blob, error: dlError } = await ctx.db.storage.from(BUCKET).download(path);
      if (dlError || !blob) {
        throw new Error(
          `${T}: could not download slice ${n} (${path}): ${dlError?.message ?? "no body returned"}. ` +
            `The clip row lists it, so either the object was removed or the bucket's read policy ` +
            `does not cover it. This is an operational failure -- retrying after fixing it is fine.`,
        );
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const encoded = encodeBase64(bytes);
      if (base64Total + encoded.length > MAX_SLICE_BASE64_BYTES) {
        stoppedForBudget = capped - i;
        break;
      }
      base64Total += encoded.length;
      rows.push({ n, name: path.split("/").pop() ?? path, bytes: bytes.length });
      images.push({ data: encoded, mimeType: "image/jpeg" });
    }

    if (stoppedForBudget > 0) {
      notes.push(
        `⚠️ Stopped after ${rows.length} slice(s): the next one would take this reply past ` +
          `${kb(MAX_SLICE_BASE64_BYTES)} of base64. ${stoppedForBudget} slice(s) not shown.`,
      );
    }

    const rawTotal = rows.reduce((n, r) => n + r.bytes, 0);
    const shownLast = rows.length > 0 ? rows[rows.length - 1].n : start;

    const summary = [
      `${clip.title ?? "(untitled)"}${clip.url ? `\n${clip.url}` : ""}`,
      `Clip ${clipId}${clip.captured_at ? `, captured ${clip.captured_at}` : ""}`,
      ``,
      `Slices ${start}-${shownLast} of ${total}, in page order, top to bottom.`,
      `Consecutive slices overlap by 50px, so a line of text falling on a cut is`,
      `whole in one of the two neighbours — expect to see a little repetition.`,
      ``,
      ...rows.map((r) => `  ${String(r.n).padStart(2)}  ${r.name.padEnd(16)} ${kb(r.bytes).padStart(10)}`),
      ``,
      `Total: ${kb(rawTotal)}, ${kb(base64Total)} base64.`,
      ...(notes.length ? ["", ...notes] : []),
    ].join("\n");

    const content: McpBlock[] = [
      { type: "text", text: summary },
      ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
    ];

    // The content-block passthrough in mcp/index.ts. See the long note there.
    return envelope({ __mcp_content: content });
  },
});

// ---------------------------------------------------------------------------
// archive_inbox_item — tier 2
// ---------------------------------------------------------------------------
//
// TIER 2, NOT TIER 3, and spec decision 8 says why: archiving HIDES an item and
// is reversible in the same call with archived: false. Blast radius is one row
// that can be put back, which is the definition of tier 2. It is audited, so
// platform.rollback_audit_entry can undo it too.
//
// ⚠️ THIS REVIVES A COLUMN THE APP STOPPED WRITING. Human triage in the Alfred
// UI hard-deletes inbox rows (a capture that does not make it through never
// happened), which left `archived` and `triaged_at` written by nothing. Spec
// decision 9 deliberately reverses that FOR THIS ONE PURPOSE: Claude handling a
// clip should not destroy it, so it archives instead. Human triage is unchanged
// and still deletes.

export const archiveInboxItemTool = defineTool({
  name: "archive_inbox_item",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "archive_inbox_item";
    const inboxId = requireText(T, "inbox_id", args.inbox_id);

    if (args.archived !== undefined && args.archived !== null && typeof args.archived !== "boolean") {
      throw new Error(`${T}: archived must be true or false (got ${JSON.stringify(args.archived)}).`);
    }
    const archived = args.archived === undefined || args.archived === null
      ? true
      : (args.archived as boolean);

    // All three move together: stamped when hiding, cleared when putting back.
    // Leaving a stale timestamp or reason on an un-archived row would make it
    // look dispositioned while it sat in the inbox, and
    // inbox_archive_reason_needs_archived refuses that pairing anyway.
    //
    // 'processed' and not 'discarded': this tool is Claude tidying up after
    // dealing with something. The trash can in the app is what discards.
    const { data, error } = await ctx.db
      .from("inbox")
      .update({
        archived,
        triaged_at: archived ? new Date().toISOString() : null,
        archive_reason: archived ? "processed" : null,
      })
      .eq("id", inboxId)
      .select("id, source_type, captured_text, archived, triaged_at, archive_reason")
      .maybeSingle();

    if (error) throw new Error(`${T}: ${error.message}`);
    if (!data) {
      // RLS makes "not yours" and "not there" indistinguishable, and saying so
      // is better than implying the row definitely does not exist.
      throw new Error(
        `${T}: no inbox item ${inboxId} that you can write to — it may have been ` +
          `deleted by triage in the app, or it may not be yours. Nothing was changed.`,
      );
    }

    return {
      ...data,
      result: archived
        ? "Archived with reason 'processed'. It has left the Alfred inbox screen " +
          "immediately. Nothing was deleted — un-archive with archived: false."
        : "Un-archived: archived false, triaged_at and archive_reason cleared. " +
          "It is back in the Alfred inbox, untriaged.",
    };
  },
});
