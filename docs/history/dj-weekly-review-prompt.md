# Weekly DJ review — RUN THIS

🛑 **YOU ARE RUNNING THIS JOB, NOT REVIEWING IT.** Make the calls in "The run" below and write
the item. Do not critique this document, summarise it, or report on its structure. If something
here looks wrong, do the run anyway and put the concern in one line at the end.

## Output — an inbox item, and its first two lines are load-bearing

**Run as the scheduled task, this writes ONE inbox item** (`create_inbox_item`, tier 1) whose body
is exactly:

```
Weekly DJ review, <YYYY-MM-DD>.
⚠️ LOAD THE `dj-weekly-review` SKILL BEFORE REPLYING TO THIS. It says what may be written.

<the report>
```

🛑 **THE SKILL LINE IS NOT DECORATION AND MUST NOT BE PARAPHRASED AWAY.** Skills load by name. A
thread that does not know to load one reads the item as a document — which is exactly how the
first version of this prompt got critiqued instead of run (§14.30).

⚠️ **PUT NO OTHER INSTRUCTIONS IN THE ITEM.** How to *act* on the report lives in the skill, in
one place, and changes without editing anything already filed. An item carrying its own
instructions is frozen at the moment it was written — §14.25 records a prompt and a spec drifting
apart with neither able to reveal it, and every item already sitting in the inbox would have that
failure permanently.

**Run by hand in a conversation:** print the report, skip the inbox write, and say you skipped it.

**Either way: nothing is published, and nothing is written to YouTube.**

---

## The run — make these calls, in this order

| # | call | for |
|---|---|---|
| 1 | `get_workshop_status` | which host answered — note `git_sha` in the footer |
| 2 | `get_dj_concerts mode="needs_status"` | Section 1a |
| 3 | `get_dj_concerts mode="undecided"` | Section 1b |
| 4 | `get_dj_concerts` from today's date | Section 2 — the upcoming list |
| 5 | `get_dj_artists` | mbids for the diff |
| 6 | `get_dj_managed_playlists mode="engagement"` | Section 2 — once, all playlists |
| 7 | `get_dj_plays mode="artists" tag="jazz"` | Section 3, and the tag candidates |
| 8 | `get_dj_plays mode="artists"` | Section 4 |

**Then per upcoming concert, three calls:** `get_dj_managed_playlists mode="cram"`,
`mode="tracks"`, and `diff_dj_setlists` (body from `mode=tracks`, mbid from step 5).

### Budget: 60 calls per 300 seconds, SHARED

**The run costs `8 + 3n`** where n is the number of upcoming concerts. Three concerts is 17.

⚠️ **IF n > 8, DO THE EIGHT NEAREST DATES IN FULL AND GIVE THE REST ONE LINE EACH** — date,
playlist, `runs`, `last_run_on`, taken from the engagement call you already made, so the fallback
costs no extra calls. **Name the ones you shortened and why.** Do not silently drop a concert.

⚠️ If you hit the limit anyway, **stop and say the report is partial, naming what is missing.** A
partial report that says so beats a complete one that guessed.

---

## What THIS job writes — two things, and nothing else

⚠️ **Everything else here is read-only.**

| write | when | tool |
|---|---|---|
| derived tag facts (`derivable_as` non-null) | **immediately, without asking** — they are facts, not proposals | `record_dj_artist_tag` |
| the inbox item | last, once the report is written | `create_inbox_item` |

🛑 **THIS JOB DOES NOT ACT ON THE REPORT. IT WRITES IT.** Concert statuses, tagging answers and
playlist edits all happen later, in the conversation Alex opens from the inbox item, governed by
the `dj-weekly-review` skill. **Do not carry any of them out here** — nobody has answered anything
yet.

⚠️ **AND DO NOT DESCRIBE THEM IN THE ITEM EITHER.** The skill says what may be written. Two
descriptions of one contract drift, and the one filed in an inbox item cannot be updated.

---

## Building the item

### SECTION 1 — decisions waiting on you

**From calls 2 and 3.** Two different questions; do not merge them.

**1a — the date has passed, status still undecided** (`needs_status`). One line each: act, date,
venue. You can change the status once he answers.
- ⚠️ **DO NOT GUESS AND DO NOT INFER FROM LISTENING.** A spike in plays around the date is
  equally consistent with cramming for a show he skipped.

**1b — undated `screening` rows** (`undecided`). One line each: act, how much the playlist has
been played, when. The question is *still interested?*, not *did you go?*
- 🛑 **PRINT EVERY ROW THE CALL RETURNS. APPLY NO FILTER OF YOUR OWN.** The tool applies no
  threshold on purpose. Do not drop a row because `went_quiet` is false or the playlist looks
  warm — a row that fails every flag is exactly the one nothing else will ever surface.

**If a half is empty, omit that half. If both are empty, omit Section 1 entirely** — omitted, not
"nothing to report" (§11.7).

### SECTION 2 — upcoming concerts

**One block per concert. Four lines, in this order:**

1. **Date and how far off** — `starts_on`, `days_until`.
2. **Playlist and how much it has been run** — `runs`, `last_run_on` from engagement.
3. **Cram state** — `cram_state` from `mode=cram`.
4. **Missing from recent setlists** — from `diff_dj_setlists`.

**Plus, when true:** `decision_pending` → one line, *"still marked screening, N days out —
decide?"* ⚠️ **THIS LINE BELONGS HERE, NOT IN SECTION 1.** A dated screening row is a show he is
probably going to. `needs_status` cannot raise it until the day it stops being answerable.

#### Rules that must not be broken

🛑 **`cram_state: "complete"` NEVER PRINTS WITHOUT COVERAGE BESIDE IT.** COMPLETE is a fact about
the playlist, never about the evening. Print `coverage.in_body / coverage.total` in the same
sentence, and **write a complete playlist covering a fraction of the set as a WARNING, not a
reassurance.**

⚠️ **QUOTE `full_set_shows`, NOT `shows`.** Promo appearances count as shows (§12.3) and are
often 1–6 songs, so a raw `shows` count can read as several times the evidence it is. Put the
shape in words: *"at both of the long sets"*, not *"2 of 10"*.

⚠️ **REPORT BOTH COVERAGE DENOMINATORS WHEN THEY DIFFER.** `coverage.total` is what he will hear.
`coverage.gettable` subtracts gaps no decision can close. Neither replaces the other.

⚠️ **`not_found_cause: "variant_only"` IS A DECISION, NOT A DEAD END.** The artist has the song;
only a studio cut is missing. It ships `variant_candidates` and `recommended_video_id` — give it
one line with the recommendation, and say plainly that taking it means learning the song from a
live recording.

🛑 **CHECK `current_cram_size` BEFORE PRINTING `cram_stale`. IF IT IS 0 ON EVERY BLOCK, OMIT THE
FLAG.** With no cram rows anywhere it reads `false` for a reason unrelated to health, and a field
that says the same thing every week trains him to skip the section it is in (§11.7). Print it the
week a cram row exists to be stale.

⚠️ **JOIN CRAM TO DIFF ON `video_id`, NEVER ON TITLE.** Cram reports the raw `dj_tracks` title;
the diff reports setlist.fm's. Both correct, never equal.

### SECTION 3 — jazz

**From call 7.** Top artists by distinct days, **with `distinct_groups` beside each** — songs and
days are different signals and the shape belongs in the line.

🛑 **STATE THE DEFINITION AND THE COVERAGE. BOTH. EVERY WEEK.**

- **Definition, one sentence:** jazz is a *tag*, not a genre — nothing in the data marks a track
  as jazz. A tag is either derived (the artist is on a track in a jazz playlist) or a judgement
  Alex made.
- **Share:** print `projection.tag_share_pct` — how much of the window's listening is by
  jazz-tagged artists.

🛑 **`tag_share_pct` IS A LISTENING FACT, NOT A PROGRESS BAR.** Do not present it as something the
tagging proposal moves. Tagging Weezer `rock` categorises him and does not change how much jazz
Alex listens to. The proposal's number is `categorised_now_pct`, and it belongs in Section 4.

⚠️ **QUALIFY IT WHEN `coverage.tagged_single_track` IS NON-ZERO.** That counts jazz tags whose
artist string appears on exactly **one track** — where the junk is. The playlist seeds tagged
`"Dec 29, 2023"` and `"Cavendish Music"` as jazz: true as membership statements, false as claims
about an act (§14.9), and they count toward the share. **One clause** — *"N of these rest on a
single track and may not be artists"* — and point at `get_dj_artist_tags mode=review`. **Do not
reject anything;** the cleanup is a separate hand-reviewed job.

⚠️ **A TAG IS NOT A PLAYLIST, AND SAY SO IN THE CLAUSE.** Several artists here will be tagged
jazz *and* in no playlist at all — Section 4 says exactly that about the same names, and read
side by side the two look like a contradiction. They are not: **tagging categorises an artist, it
does not add him to anything.** One clause, where the names first appear.

**Then:** *"the tagging proposal is in Section 4."*

### SECTION 4 — everything else

**From call 8.** What he is actually listening to, playlists or not. **Lead with what the
playlists do not explain** — heavily-played artists in no playlist are the finding, not a
footnote.

⚠️ **STATE THE LIMITATION WITH THE NUMBERS, IN ONE SENTENCE** (§14.1, §14.9): this groups
`dj_tracks.artist` as an exact string, so *"X Trio"* and *"X"* do not unify, collaborations appear
under their full joined billing, and at least one row in the data is a scraped channel byline
with a view count in it that will look like an artist.

#### The tagging proposal — ends Section 4

Use `tag_candidates` from call 7. These are artists carrying **no tag of any kind**. **Two kinds.
Not the same ask.**

**1. `derivable_as` NON-NULL — FACTS. Write them now, do not ask.** Playlist membership implies
the tag. One `record_dj_artist_tag` call, then one line saying it is done. If there are none, say
nothing. *(Normally there are none — the seeds keep it that way. Several mean a playlist changed.)*

**2. `derivable_as` NULL — JUDGEMENTS. At most `tag_proposal_cap` of them.**

🛑 **THE QUESTION IS "WHAT ARE THESE?", NOT "IS THIS JAZZ?".** Head the list *"your most-played
uncategorised artists"*. **Any tag is a valid answer** — `rock`, `hip-hop`, whatever fits — and
an answer of any kind removes the artist from this list permanently.

⚠️ **NEVER HEAD IT WITH ONE TAG'S NAME.** A list headed *"Jazz?"* containing rock acts is wrong at
a glance and will get skipped.

One line each with the numbers he is deciding on — play rows, distinct days, distinct songs — and
one sentence on what answering buys, **taken from `projection`, not re-derived**:

> *"These eight are N% of the listening the system can't categorise. Answering them takes it from
> `categorised_now_pct` to `categorised_after_pct`."*

🛑 **USE `categorised_*`, NEVER `tag_share_pct`.** The projection measures *categorisation*, which
moves whatever the answer is. Quoting the jazz share would promise that tagging Weezer improves
jazz coverage — arithmetically true of the old design and a path Alex would never take.

🛑 **A "NO" IS A WRITE. RECORD IT.** If an artist is not the tag being discussed, give him the tag
he *is* rather than a rejection. Reserve `status: "rejected"` for a string that is not an artist
at all, with a note saying so. **Either way it must be written** — an answer that leaves no trace
brings the same name back next week and every week after (§11.7). Absence is the only state
meaning *not yet asked*.

⚠️ **NEVER TAG WITHOUT AN ANSWER.** Some of these strings are not artists.

To review what has already been decided — including rejections, which nothing else shows — use
`get_dj_artist_tags`.

---

## Tone

- Short sentences. Friendly. Concerts are fun; write like someone looking forward to the show.
- **No paragraph explaining how to read a number.** If a number needs caveats to be read right,
  **print a different number.** That rule is why coverage is a share and not a count.
- **Put the denominator in the sentence.** *"only at the one short set"*, not *"1 of 10 — but
  note that show was well below the median length, so…"*
- No hedging. Absence stated plainly and moved past.

### 🛑 ONE QUESTION MARK IN THE ITEM, AND IT IS THE LAST LINE

⚠️ **THIS RESOLVES A CONTRADICTION IN AN EARLIER DRAFT.** Section 1 and the tagging proposal are
both requests for a decision, so writing them as question sentences produced an item with four or
five question marks under a rule saying "one question".

**They are presented as LABELLED DECISIONS, not as questions.** A line reading *"<act> — playlist
run once, months ago. Still interested?"* loses its question mark and sits under a heading that
already says these are waiting on him. Then **one closing question collects all of it**, naming
the kinds of answer actually on the table this week:

> *"So: any statuses to change, any of those artists to tag, and shall I add the missing songs?"*

Drop the clauses that do not apply. If the only thing pending is playlist adds, it is just
*"Want me to make these changes?"*

⚠️ **§12.3 AND §12.7 GOVERN THE ANALYSIS. §12.12 GOVERNS WHAT IS PRINTED.** Followed literally
together they produce 90% epistemics and 10% proposal, which is what went wrong on 2026-09-01.
The rules were right; the balance was not.

---

## Authority — what to trust when things disagree

⚠️ **YOU PROBABLY CANNOT READ THE SPEC.** A Claude thread running this has MCP tools and no
filesystem, so "the spec wins" is not a rule it can check. In order:

1. **The tool payload wins over this file.** Every tool ships `reading`, `gaps` and `definition`
   fields describing its own contract, and they travel with the data — so they cannot be stale
   relative to the numbers you are holding. If a `reading` contradicts an instruction here,
   **follow the payload and say so in one line at the end.**
2. **This file governs the shape of the item** — which sections, in which order, and the rules
   above.
3. **`docs/technical-spec-dj.md` is the source of both** and wins over this file *if you can
   actually read it.* If you cannot, do not treat that as a blocker.

---

## Appendix A — measured 2026-09-02. EXAMPLES, NOT CURRENT FACTS.

🛑 **DO NOT REPORT ANY NUMBER FROM THIS APPENDIX. RE-READ IT FROM THE TOOLS.** These are here so a
rule's shape is recognisable, and every one of them will drift.

- Weezer's setlist window: 6 of 10 "shows" were 1–6 song TV and radio spots; the other four were
  real sets of 12–24. That is why `full_set_shows` exists.
- Foo Fighters coverage: 27/40 total, 27/32 gettable — 6 medley parts and 2 covers-only among the
  gaps.
- Smashing Pumpkins: dated 2026-10-30, still `screening`, 10 runs in 90 days. The
  `decision_pending` case.
- Mayonaise (Smashing Pumpkins, 5 of 10 shows): the `variant_only` case — every cut on YouTube
  Music is live.
- Zero cram rows library-wide, so `cram_stale` could not fire. **Check, do not assume.**
- Section 1b: Oasis did not fire `went_quiet` (two touch days inside the recent window) and still
  needed surfacing. That is why 1b applies no filter.
- Tag coverage: 393 artists played, 87 tagged, 368 untagged, 0 derivable. Ordering by
  `distinct_days` put Green Day (27 play rows) above Miles Davis (83) — a thin artist over a deep
  one, which is why candidates order by `play_rows`.
- All 22 artist rows have an mbid (`without_mbid: 0`), each verified by a live setlist read during
  the 2026-09-01 backfill. ⚠️ **A 2026-09-02 review of an earlier draft claimed only Foo Fighters
  had one. That was wrong.** If a setlist read comes back empty, check `get_dj_artists` before
  reporting "no setlists yet" — an absent mbid and an empty tour calendar produce the same silence
  and are not the same fact.

## The boundary — three documents, three jobs

⚠️ **KEEP THEM APART.** Merging any two produces something that reads as a spec, which is how the
first draft of this file got critiqued instead of run (§14.30).

| document | audience | job |
|---|---|---|
| **this file** | the scheduled task | how to GENERATE the report |
| **`dj-weekly-review` skill** | the follow-up conversation | how to ACT on Alex's answers |
| **spec §13 concert skill** | *not built yet* | how to BUILD a concert playlist from scratch |

🛑 **NEITHER THIS FILE NOR THE SKILL CREATES A PLAYLIST OR A CONCERT ROW.** The skill may add
already-resolved songs to an existing concert playlist and nothing more. Creating a playlist,
creating a `dj_concerts` row, or deciding what a new playlist should contain is §13's job and it
does not exist. **The boundary is stated in both places on purpose** — two skills that each assume
the other handles playlist creation is how nobody does it, or how both do it differently.

## Appendix B — what this job cannot do

State these only when load-bearing for something in the report, never as a standing disclaimer.

- **No artist identity** (§14.1). Exact-string grouping throughout.
- **No subgenre, no unplayed albums** (§14.2, §14.3). `dj_albums` has no writer and no data.
- **It cannot propose an artist he has never played.** *"Try Andrew Hill"* comes from the
  conversation, never from listening history.
- **Artist-identity collisions are not detectable** (§14.4). The diff can tell that a search
  returned several artists; it cannot tell that two real acts share a name.
