import { supabase } from "../supabaseClient";

/**
 * Homer tab reads (homer-h4k phase F). Straight to PostgREST under owner RLS; read only.
 * Spec: docs/homer-spec-homer-h4k.md, phase F.
 */

export const READER_KEY = "alex";

const QUEUE_COLUMNS = "id, genre_id, kind, title, author, asin, why, on_kindle_unlimited, status, position";

function fail(what, error) {
  console.warn(`[homer] ${what}:`, error?.message); // eslint-disable-line no-console
  throw new Error(`${what}. Please try again.`);
}

/** The active plan's id and version, or null before calibration. */
export async function getActivePlan() {
  const { data, error } = await supabase.from("homer_plans").select("id, version")
    .eq("status", "active").maybeSingle();
  if (error) fail("Could not load Homer's plan", error);
  return data || null;
}

async function readerId(readerKey) {
  const reader = await supabase.from("homer_readers").select("id").eq("key", readerKey).maybeSingle();
  if (reader.error) fail("Could not load the reader", reader.error);
  return reader.data?.id || null;
}

const READ_COLUMNS =
  "id, started_on, finished_on, hours, completion, " +
  "homer_books(asin, title, author, series_position, homer_series(id, name, series_asin, author))";
const PAGE = 1000;

/** Every read of the reader, with its book and series, paged past PostgREST's row cap. */
export async function getReads(readerKey = READER_KEY) {
  const id = await readerId(readerKey);
  if (!id) return [];
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("homer_reads").select(READ_COLUMNS)
      .eq("reader_id", id).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) fail("Could not load the reading history", error);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

/** The reader's live queue items (not archived), in position order. */
export async function getQueue(readerKey = READER_KEY) {
  const id = await readerId(readerKey);
  if (!id) return [];
  const { data, error } = await supabase.from("homer_queue_items").select(QUEUE_COLUMNS)
    .eq("reader_id", id).is("archived_at", null).order("position", { ascending: true });
  if (error) fail("Could not load the reading queue", error);
  return data || [];
}

/** Genres that aren't archived, in sort order. */
export async function getGenres() {
  const { data, error } = await supabase.from("homer_genres").select("id, name, sort_order")
    .is("archived_at", null).order("sort_order", { ascending: true });
  if (error) fail("Could not load the genres", error);
  return data || [];
}

/** homer_quiet_series for the reader: liked, loved and tired series with quiet, gap and availability fields. */
export async function getQuietSeries(readerKey = READER_KEY) {
  const { data, error } = await supabase.rpc("homer_quiet_series", { p_reader_key: readerKey });
  if (error) fail("Could not load the series gone quiet", error);
  return data || [];
}
