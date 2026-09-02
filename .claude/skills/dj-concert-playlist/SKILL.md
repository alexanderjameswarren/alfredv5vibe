---
name: dj-concert-playlist
description: Build a concert playlist — for a show Alex is going to, an act he wants to see whenever they tour, or a show he already attended. Creates the concert row if absent, resolves the setlist, and seeds the playlist. Load this when he asks for a playlist for a band or a gig. NOT for acting on a weekly review.
---

# Building a concert playlist

🛑 **PROPOSE BEFORE WRITING ANYTHING.** Show the resolved songs, the playlist name, and what will
be created. **Nothing is created, renamed or added until he says yes.** This writes to YouTube,
which is the only part of this system a mistake cannot be quietly undone in.

---

## 🛑 IT ALL TURNS ON ONE QUESTION: IS THERE A DATE?

Three phrasings, **two rows**, and the schema has no third shape:

| he says | row | playlist |
|---|---|---|
| *"Metallica at the Sphere on 14 March"* | **dated** `screening` | prep for a specific show |
| *"I want to see Third Eye Blind next time"* | **undated** `screening` | prep for whenever |
| *"Oasis, if they ever tour again"* | **undated** `screening` | prep for whenever |
| *"a playlist of the Adele show I went to"* | **dated** `attended` — usually already exists | a record of that night |

⚠️ **THE MIDDLE TWO ARE THE SAME ROW.** *"Missed them this time"* and *"they aren't touring"*
differ only in how he said it. **Do not invent a distinction the schema does not have** — both are
an undated `screening` entry, and both surface in the weekly review's Section 1b until he decides.

⚠️ **NEVER GUESS A DATE.** If he names a show but not a date, ask. `create_dj_concert` refuses a
`committed` or `interested` status without one, and a guessed date is indistinguishable from a
checked one once written.

---

## Step 1 — does the row already exist?

**`get_dj_concerts`** before creating anything.

🛑 **CONDITIONAL CREATE. ALL THE OBVIOUS CANDIDATES ALREADY HAVE ROWS.** Adele, Lady Gaga and
Katy Perry are all recorded as `attended` with no playlist. A skill that created a second Adele
row on its first run would be a bad start, and `create_dj_concert` will happily do it.

- **Row exists** → use its `id`. Do not touch its status.
- **No row** → `create_dj_concert` with `artist_name`, `status`, and `starts_on` **only if known**.

⚠️ **THE ARTIST NEEDS AN `mbid` OR THERE IS NO SETLIST.** `get_dj_artists` first;
`upsert_dj_artist` if it is missing. Without one, setlist.fm cannot be queried at all — name
search matches the wrong band, so the tools refuse names outright.

---

## Step 2 — get the setlist

### For an upcoming or undated show: the recent window

**`diff_dj_setlists`** with the mbid and `body: []` (there is no playlist yet, so everything is
"missing" and everything gets resolved in one call).

🛑 **STATE THE WINDOW'S DATE RANGE WHENEVER IT IS NOT RECENT.** For an act touring now, the last
ten shows are what they are playing. **For an act that stopped touring in 2009, the last ten shows
are from 2009** — still the best evidence available, and presenting them as current would be
wrong. One clause: *"from their last run, in 2009"*.

### For a show he attended: the targeted lookup

**`diff_dj_setlists` with `on_date`** — the exact `starts_on` from the concert row.

⚠️ **WHY NOT THE NORMAL WINDOW:** the artist feed is newest-first, so a 2023 show is hundreds of
entries back. `on_date` switches to setlist.fm's search endpoint and goes straight to it.

🛑 **EXACT MATCH OR ASK. THE TOOL ENFORCES THIS AND YOU MUST NOT WORK AROUND IT.** It asserts the
returned show's date against the one requested and refuses anything else:

- **`exact`** → proceed.
- **`not_found`** → it raises, listing the nearest shows with `days_from_requested`. **Show them
  and ask which.** Do not pick one, and do not retry without `on_date`.
- **`found_but_empty`** → setlist.fm has the show and nobody filled in the songs. ⚠️ **That is a
  third outcome and it is not "not found"** — no other date fixes it. Say so and stop.
- **`ambiguous`** → two setlists filed under that date. A judgement, not a tie.

⚠️ **THE REASON THIS IS STRICT:** Adele 2023-10-13 and Katy Perry 2023-10-14 are one day apart. A
near miss would return a plausible setlist from another night of the same residency, every song
would resolve cleanly, and **nothing further down could tell.**

---

## Step 3 — propose

**Show him, before writing:**

1. **The playlist name** — `"<Act> Concert"`, exactly (see naming below).
2. **The show being used** — date and venue, and for a targeted lookup say the date matched.
3. **The resolved songs**, with the ones that did not resolve and why. Use `not_found_cause`:
   `variant_only` is a decision he can make; the others cannot be closed.
4. **Whether an existing playlist will be renamed** (below).

⚠️ **`variant_only` IS A SEPARATE YES.** Adding a live cut means learning the song from a live
recording. Name it and get its own answer; do not fold it into "add them all".

**Then: one question.** *"Shall I build it?"*

---

## Step 4 — build

### Naming, and the archive rename

**`"<Act> Concert"`, exactly.** Not *"Metallica — Concert Prep"*, not *"Metallica (Sphere 2026)"*.
Google Assistant matches on the spoken name in the car; this is a functional constraint, not a
style preference.

🛑 **IF `"<Act> Concert"` ALREADY EXISTS, THE OLD ONE IS RENAMED `"Archived <Act>"` FIRST** —
`edit_dj_playlist mode=rename`. **That is a YouTube write and needs its own confirmation.**

⚠️ **ARCHIVING ALSO CHANGES THE RECORD: `kind` becomes `artist` and `concert_id` becomes null**
(`record_dj_playlist`). The playlist is no longer prep for anything; it is a record of a past
show. **Left as `kind='concert'` with a live `concert_id` it would reappear in the weekly review
forever, reporting on a show that already happened** — a section that fires on the normal case,
which is the failure this whole system keeps guarding against.

*Precedent: "Archived Weezer" is already `kind='artist'` with no concert link, decided in Phase 6b
for this reason. This applies that decision rather than making a new one.*

### Creating and seeding

1. **`create_dj_playlist`** (Workshop) with the title → returns the YouTube playlist id.
2. **`edit_dj_playlist mode=add`** with the resolved video ids, **in the order you want them**.
3. **`get_dj_playlists mode=contents`** — the only source of `set_video_id`, which any later move
   or remove needs.
4. **`record_dj_playlist`** (Alfred) with `yt_playlist_id`, `kind: "concert"`, the `concert_id`,
   and every track with its `role` and `position`.

### 🛑 Cram: seed it in order, never reorder it

**For a show he is GOING to** (dated or undated `screening`), the playlist gets a cram block.

⚠️ **ADDS APPEND, SO ADDING CRAM-FIRST-THEN-BODY GIVES THE RIGHT ORDER WITH ZERO MOVES.** §5 says
cram rows render before body rows; if you add them in that order, they already are.

🛑 **THAT IS THE ONLY TIME CRAM IS CHEAP.** Reordering an *existing* block costs one
`edit_dj_playlist mode=move` per entry, each needing a **fresh contents read** first, because
`set_video_id` is a per-playlist handle that is stale by default and reused across playlists for
different songs. An eight-song block is up to sixteen calls — **more than the entire playlist
build.** Get the order right at seeding time.

⚠️ **A TRACK IN BOTH ZONES IS DELIBERATE** (§5). The cram copy and the body copy are separate
entries with separate `set_video_id`s, and that duplication is what lets a cram clear leave the
setlist intact.

### 🛑 A SHOW HE ATTENDED GETS BODY ONLY. NO CRAM.

**Cram is preparation, and there is nothing to prepare for a night that already happened.** The
playlist is a record of it. Seed `role: "body"` for every track and write no cram rows.

---

## What this skill does NOT do

- **Act on a weekly review item.** That is the `dj-weekly-review` skill: statuses, tagging
  answers, and adding already-resolved songs to an existing playlist.
- **Remove tracks or delete playlists.** `remove_from_dj_playlist` is tier 3 and is not part of
  this flow. Archiving renames; it never deletes.
- **Record a venue.** `dj_concerts.venue_id` is null on every row and `create_dj_concert` accepts
  no venue — there is no path. Put the venue in `notes` if he gives one, and do not imply it is
  stored as a venue.

⚠️ **THE BOUNDARY IS WRITTEN IN BOTH SKILLS ON PURPOSE.** Two skills that each assume the other
handles playlist creation is how nobody does it, or how both do it differently.

---

## Tone

Short, friendly, looking forward to the show. **Confirm what landed, one line per write** —
*"Renamed the old one Archived Weezer, built Weezer Concert with 22 songs, 8 of them crammed to
the top."*

⚠️ **REPORT WHAT LANDED, NOT WHAT WAS ASKED FOR.** A YouTube write can partially succeed. If some
adds failed, say which — a summary listing intentions is how a half-built playlist reports success.
