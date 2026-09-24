/**
 * What a clipboard or CLI capture actually captured — Alfred Clipboard, Step 19.
 *
 * Rendered inside the inbox detail page's "Original capture" section. An inbox row
 * from the Chrome extension or the CLI is a one-line POINTER ("Clip: Title — url");
 * the page text, the links and the screenshot live in `public.clips` and were,
 * until now, visible only to Claude through `get_recent_clips` and
 * `get_clip_slices`.
 *
 * ── Its own file, and passed IN to the page rather than imported by it ───────
 *
 * `InboxDetailView` takes everything it needs as props and reads nothing global,
 * which is what lets its 60 tests mount it with four plain objects. This component
 * has to reach the database and Storage, so importing it there would put Supabase
 * behind every one of those tests. It arrives as a prop instead — the same
 * arrangement `renderRecurrence` already uses, and for the same reason.
 *
 * ── Reading slices ───────────────────────────────────────────────────────────
 *
 * Through the BROWSER CLIENT, which carries the signed-in user's own token, so the
 * `clipboard` bucket's folder-per-user read policy is what decides. Spec 4.2 is
 * explicit that reads never use the service role, and `get_clip_slices` follows
 * the same rule with `ctx.db`.
 *
 * Signed URLs rather than downloaded blobs: one `createSignedUrls` call covers all
 * the slices, the browser then fetches and caches the images itself, and there are
 * no object URLs to revoke. A blob-per-slice would mean up to 24 downloads held in
 * memory and a cleanup path to get wrong.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, ImageOff, Link2 } from "lucide-react";
import { supabase } from "./supabaseClient";
import {
  COLLAPSE_LINES,
  displayLinks,
  needsShowAll,
  screenshotCaveat,
} from "./utils/capturedClip";

const BUCKET = "clipboard";

/**
 * How long a slice URL stays valid.
 *
 * An hour: long enough that reading a long capture, going away and coming back
 * does not break the images, short enough that a URL copied out of the page is not
 * a lasting leak. The page re-signs on every mount, so this is never the thing a
 * user waits on.
 */
const SIGNED_URL_TTL_SECONDS = 3600;

function SectionLabel({ children, count }) {
  return (
    <h4 className="text-sm font-bold text-foreground">
      {children}
      {count !== undefined && <span className="ml-1.5 font-normal text-muted-foreground">({count})</span>}
    </h4>
  );
}

/**
 * One slice, with its own loading and failure state.
 *
 * Per-slice rather than per-screenshot, because the failure is per-slice: one
 * object can be missing from a set of nine, and a single banner over the lot would
 * either hide eight good images or claim all nine were fine.
 */
function Slice({ url, index, total }) {
  const [state, setState] = useState("loading");

  return (
    <figure className="m-0">
      <div className="relative bg-muted rounded overflow-hidden">
        {state === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center min-h-[80px]">
            <span className="text-xs text-muted-foreground animate-pulse">
              Loading {index} of {total}…
            </span>
          </div>
        )}
        {state === "error" ? (
          // Says what is missing and what it means, in a page where every OTHER
          // slice may have loaded fine. No retry button: a signed URL that 404s
          // will 404 again, and the fix is not something the reader can perform.
          <div className="flex items-start gap-2 p-3 text-sm text-muted-foreground">
            <ImageOff className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              Slice {index} of {total} could not be loaded. The clip lists it, so either the image
              was removed from storage or it is not covered by the bucket&apos;s read policy.
            </span>
          </div>
        ) : (
          <img
            src={url}
            alt={`Screenshot slice ${index} of ${total}`}
            loading="lazy"
            onLoad={() => setState("ready")}
            onError={() => setState("error")}
            className={`block w-full h-auto ${state === "loading" ? "opacity-0" : "opacity-100"}`}
          />
        )}
      </div>
    </figure>
  );
}

/**
 * @param {string} clipId - `source_metadata.clip_id` from the inbox row.
 * @param {object} inboxItem - The row, for the capture mode and screenshot note.
 */
export default function ClipboardCapture({ clipId, inboxItem }) {
  const [clip, setClip] = useState(null);
  const [sliceUrls, setSliceUrls] = useState([]);
  const [status, setStatus] = useState("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [slicesFailed, setSlicesFailed] = useState(false);
  const [showAllText, setShowAllText] = useState(false);
  const [showLinks, setShowLinks] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setErrorMessage("");
    setSlicesFailed(false);

    const { data, error } = await supabase
      .from("clips")
      .select(
        "id, title, url, source, captured_at, page_text, text_truncated, links, links_truncated, " +
          "slice_paths, slice_count, screenshot_truncated, page_width, page_height",
      )
      .eq("id", clipId)
      .maybeSingle();

    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return null;
    }
    // Not an error. A clip can be gone — or unreadable, which arrives as the same
    // null through RLS — and the capture row is still perfectly valid to triage.
    if (!data) {
      setStatus("missing");
      return null;
    }
    return data;
  }, [clipId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const row = await load();
      if (cancelled || !row) return;
      setClip(row);

      const paths = Array.isArray(row.slice_paths) ? row.slice_paths : [];
      if (paths.length === 0) {
        setSliceUrls([]);
        setStatus("ready");
        return;
      }

      // One call for every slice. The browser client's token is what the bucket's
      // folder-per-user policy is checked against — the service role is never
      // used for a read.
      const { data: signed, error: signError } = await supabase.storage
        .from(BUCKET)
        .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);

      if (cancelled) return;

      if (signError || !signed) {
        // The text and links are already in hand, so this degrades to "no
        // pictures" rather than to "no capture".
        setSliceUrls([]);
        setSlicesFailed(true);
        setStatus("ready");
        return;
      }

      // Order is the page's order, top to bottom — createSignedUrls answers in the
      // order it was asked, and `slice_paths` is stored in slice order. A row that
      // failed to sign keeps its position so the numbering still matches the page.
      setSliceUrls(signed.map((s) => s.signedUrl || null));
      setStatus("ready");
    })();

    return () => {
      cancelled = true;
    };
  }, [load]);

  if (status === "loading") {
    return (
      <p className="text-sm text-muted-foreground animate-pulse" role="status">
        Loading what was captured…
      </p>
    );
  }

  if (status === "error") {
    return (
      <p className="text-sm text-muted-foreground">
        The captured page could not be loaded ({errorMessage}). The capture itself is fine — you can
        still triage it.
      </p>
    );
  }

  if (status === "missing") {
    return (
      <p className="text-sm text-muted-foreground">
        The captured page and screenshot are no longer stored. The capture itself is fine — you can
        still triage it.
      </p>
    );
  }

  const pageText = typeof clip.page_text === "string" ? clip.page_text : "";
  const links = displayLinks(clip.links);
  const caveat = screenshotCaveat(inboxItem, clip);
  const slices = sliceUrls.filter(Boolean);

  return (
    <div className="flex flex-col gap-4">
      {clip.url && (
        <a
          href={clip.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-start gap-1.5 text-sm text-primary hover:text-primary-hover break-all"
        >
          <ExternalLink className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          {clip.url}
        </a>
      )}

      {/* The page text. Clamped rather than cut: "Show all" reveals text that was
          always in the DOM, so nothing has to be re-fetched and a browser find
          still reaches it. */}
      {pageText && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Page text</SectionLabel>
          <div
            className="text-sm leading-relaxed whitespace-pre-wrap text-foreground"
            style={showAllText ? undefined : { display: "-webkit-box", WebkitLineClamp: COLLAPSE_LINES, WebkitBoxOrient: "vertical", overflow: "hidden" }}
          >
            {pageText}
          </div>
          {needsShowAll(pageText) && (
            <button
              onClick={() => setShowAllText((v) => !v)}
              className="self-start inline-flex items-center gap-1.5 min-h-[44px] text-sm text-primary hover:text-primary-hover"
            >
              {showAllText ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              {showAllText ? "Show less" : "Show all"}
            </button>
          )}
          {clip.text_truncated && (
            <p className="text-xs text-muted-foreground">
              The page was longer than 1 MB, so the text was cut at that point when it was captured.
            </p>
          )}
        </div>
      )}

      {/* Links. Collapsed behind their own count, because a job board's capture
          carries hundreds and they would otherwise bury the screenshot. */}
      {links.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            onClick={() => setShowLinks((v) => !v)}
            className="self-start inline-flex items-center gap-1.5 min-h-[44px] text-sm font-bold text-foreground"
            aria-expanded={showLinks}
          >
            {showLinks ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <Link2 className="w-4 h-4" aria-hidden="true" />
            Links <span className="font-normal text-muted-foreground">({links.length})</span>
          </button>
          {showLinks && (
            <ul className="flex flex-col gap-1 m-0 pl-0 list-none">
              {links.map((link) => (
                <li key={link.href} className="text-sm leading-snug">
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    title={link.href}
                    className="text-primary hover:text-primary-hover break-all"
                  >
                    {link.text}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {clip.links_truncated && (
            <p className="text-xs text-muted-foreground">
              The page had more than 1,000 links; these are the first 1,000, nearest the top.
            </p>
          )}
        </div>
      )}

      {/* The screenshot. */}
      {(slices.length > 0 || slicesFailed || caveat) && (
        <div className="flex flex-col gap-2">
          <SectionLabel count={slices.length > 0 ? slices.length : undefined}>
            {slices.length === 1 ? "Screenshot" : "Screenshot slices"}
          </SectionLabel>

          {/* Shown for an INCOMPLETE screenshot and for a visible-screen-only one
              alike. The second is the one that gets forgotten: it is not broken and
              not flagged as truncated, and it is still not the page. */}
          {caveat && (
            <p
              className={`text-xs ${caveat.kind === "incomplete" ? "text-warning" : "text-muted-foreground"}`}
            >
              {caveat.kind === "incomplete" ? "⚠️ " : ""}
              {caveat.text}
            </p>
          )}

          {slicesFailed && (
            <p className="text-sm text-muted-foreground">
              The screenshot could not be loaded. The page text above is unaffected.
            </p>
          )}

          {/* In page order, top to bottom, butted together so the slices read as
              one tall image — which is what they are. */}
          {slices.length > 0 && (
            <div className="flex flex-col rounded overflow-hidden border border-border">
              {sliceUrls.map((url, i) =>
                url ? (
                  <Slice key={i} url={url} index={i + 1} total={sliceUrls.length} />
                ) : (
                  <div key={i} className="flex items-start gap-2 p-3 text-sm text-muted-foreground">
                    <ImageOff className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>
                      Slice {i + 1} of {sliceUrls.length} could not be prepared for display.
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
