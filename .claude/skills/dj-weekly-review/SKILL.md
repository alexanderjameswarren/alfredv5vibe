---
name: dj-weekly-review
description: Act on a weekly DJ review inbox item — brief Alex on what it says, then record concert statuses, answer the artist-tagging proposal, and add missing setlist songs to a concert playlist. Load this when Alex pastes a weekly DJ review. NOT for building a concert playlist from scratch.
---

# Acting on a weekly DJ review

## 🛑 STEP 1: HE HAS NOT READ IT. BRIEF HIM FIRST.

**Assume the report was pasted in unread.** It arrives as an inbox item, and pasting an item is
not reading it. **Your first reply presents what is in it** — you are not asking questions about a
document he has in his head, because he does not.

⚠️ **A QUESTION WHOSE CONTEXT LIVES IN A DOCUMENT HE NEVER OPENED IS UNANSWERABLE.** *"Two songs
would mean learning from a live recording"* and *"any of the eight artists to tag?"* are
meaningless cold. This is the same failure the prompt had: **written for someone who already
knows, and the reader doesn't.**

**Your first reply, in this order:**

1. **One line of headline** — what changed since last week, or what most wants attention.
2. **Each upcoming concert, two or three lines.** Date, how far off, whether the playlist is being
   run, and **what specifically needs a decision** — missing songs, a live-cut choice, an
   undecided status.
3. **The decisions, laid out so each can be answered without opening the report.** Every one
   carries its own context.
4. **The tag table, in full, with a suggested tag per artist** — see below. It goes in this first
   reply, not when asked for.
5. **The closing question**, collecting whatever is actually pending.

⚠️ **DO NOT REGENERATE THE REPORT OR RE-RUN ITS CALLS.** Present what the item says. Read extra
data only if he asks something the item does not answer.

### The tag table goes in the first reply, with suggestions

For each proposed artist: **the numbers from the report** (play rows, distinct days, distinct
songs) **and a suggested tag.**

🛑 **THE SUGGESTION COMES FROM YOUR GENERAL KNOWLEDGE OF MUSIC, AND YOU MUST SAY SO.** Miles Davis
→ `jazz`, A$AP Rocky → `hip-hop`. **The system did not derive these and cannot** — nothing in the
data knows what genre anything is. Marking a suggestion as though it came from the listening
history is exactly the failure that made the jazz section wrong for a quarter.

**Suggest one tag per artist, mark the whole column as your guess, and let him correct it.** A
table he can approve in one word beats a list of names he has to think about individually.

⚠️ **IF YOU DO NOT KNOW AN ARTIST, SAY SO AND SUGGEST NOTHING.** Some of these strings are not
artists at all — scraped channel bylines, upload dates, filename fragments.

---

## What you may write

⚠️ **NOTHING UNTIL HE ANSWERS.** Every write below waits on an explicit reply.

| he says | you write | tool |
|---|---|---|
| went / didn't go / not going | the concert status | `update_dj_concert` |
| didn't go **but still want to see them** | status **+ feedback** — two writes | `+ record_dj_feedback` |
| **"still want to see them if they come back"** | status **+ an undated `screening` row** | `+ create_dj_concert` |
| an artist is jazz / rock / anything | the tag | `record_dj_artist_tag` |
| that string isn't an artist | a rejection, with the reason | `record_dj_artist_tag` `status: "rejected"` |
| add the missing songs | the playlist edit | `edit_dj_playlist` + `record_dj_playlist` |

🛑 **NOTHING ELSE.**

---

## 1. Concert statuses

⚠️ **`missed` MEANS THE SHOW HAPPENED AND HE DID NOT GO.** A show still in the future cannot be
`missed` — deciding not to go to it is `rejected`. **Refuse the wrong status and say why**; this
has already caught one real error.

🛑 **`missed` IS TWO WRITES.** It means *did not go, **but still want to see them***. The lingering
want is a fact about the **artist**, so it needs a `dj_feedback` row (`sentiment: "curious"`, or
his words) as well as the status change. If only the status lands, the interest is recorded
nowhere.

### 🛑 A LINGERING WANT NEEDS A ROW THAT COMES BACK, NOT A NOTE

When he rejects or misses a show **and says he would still see the act** — *"if they come back"*,
*"next time they tour"* — that belongs in an **undated `screening` concert row**, the same shape
as the standing watchlist entries the report's Section 1b surfaces.

`create_dj_concert` with the **same artist**, **no `starts_on`**, `status: "screening"`, and his
words in `notes`.

⚠️ **A FREE-TEXT NOTE ON A REJECTED ROW IS A SILENT LOSS.** Nothing reads it. A rejected row is
not past, not upcoming, and not `needs_status` — the want disappears the moment the conversation
ends. An undated screening row is the only shape that **surfaces again**, every week, until he
decides.

⚠️ **ASK IF HE HAS NOT SAID.** When a status is `missed` or `rejected`, *"still want to see them
sometime?"* is one short question and it is the difference between a recorded want and a lost one.

**`decision_pending`** — a dated show still marked `screening` — is just a status change
(`committed` or `rejected`). No feedback row unless he expresses a want.

⚠️ **`attended` vs `missed` IS A FACT ABOUT ALEX AND NO TABLE HOLDS IT.** Never infer it from
listening.

---

## 2. The tagging answers

`record_dj_artist_tag`. Several artists in one call; `artists` takes an array.

⚠️ **COPY THE ARTIST STRING EXACTLY AS THE REPORT PRINTED IT.** It is a match key against
`dj_tracks.artist`, not a display name. The tool refuses an unknown string and writes nothing,
including the rows that would have matched.

🛑 **WHICH KIND OF "NO" MATTERS:**

- **"That's not jazz, it's rock"** → write `tag: "rock"`, active. He told you what it *is*; a
  jazz-rejection throws that away and leaves him uncategorised.
- **"That's not an artist"** → `status: "rejected"` with a note.
- **"Skip it" / silence** → **write nothing.** Absence means *not yet asked* and it is the only
  state that does.

⚠️ **NEVER GUESS A TAG TO TIDY THE LIST.** A suggestion he did not confirm is not an answer.

**Then say what landed** — how many tagged, how many rejected.

### If he asks about the tag list

`get_dj_artist_tags` shows what has been decided, including rejections.
**`mode: "review"`** orders tags by **how little evidence exists that the string names an act** —
tracks, playlists, plays — weakest first.

🛑 **THAT IS AN ORDERING, NOT A VERDICT, AND THE CLEANUP IS NOT THIS CONVERSATION'S JOB.** The
playlist seeds tagged strings like `"Dec 29, 2023"` and `"Cavendish Music"` as jazz — true as
membership, false as claims about an act. Fixing them is a separate hand-reviewed pass over the
whole list. **Do not reject rows in bulk here.** Show him the top of the list if he asks, and say
the cleanup is its own job.

---

## 3. Adding missing setlist songs

`edit_dj_playlist` (Workshop) against the concert playlist, then `record_dj_playlist` so
Supabase's record matches YouTube.

⚠️ **RE-READ `set_video_id` BEFORE ANY MOVE OR REMOVE.** It is a cache: stale by default and
reused across playlists for *different* songs. Adds do not need it; anything else does.

🛑 **A LIVE-CUT RECOMMENDATION IS A SEPARATE YES.** Where the report offered a `variant_only`
choice — a live recording standing in for a missing studio version — **do not fold it into a
general "add the missing songs".** Accepting it means learning that song from a live cut, and he
was asked to weigh that. **Name it explicitly and get its own answer.**

⚠️ **NOT FOUND STAYS NOT FOUND.** If the report said a song could not be resolved, do not search
for it and pick something.

---

## 🛑 The boundary: originate vs complete

**This skill COMPLETES decisions made in this conversation.** It may write an undated screening
row because every field is determined by his answer — same artist, no date, `screening` — and no
playlist is involved.

**It does not ORIGINATE a concert pipeline.** It does not:

- create or name a playlist,
- create a **dated** concert row, or decide a date or venue,
- decide what a new playlist should contain,
- reorder or clear a cram block.

**That is the concert-playlist skill's job (spec §13), and it is not built yet.** If Alex asks for
any of it, say so plainly and stop.

⚠️ **THE BOUNDARY IS IN BOTH DOCUMENTS ON PURPOSE.** Two skills that each assume the other handles
playlist creation is how nobody does it, or how both do it differently.

---

## What must not change

These behaved correctly in the first live round trip. **Do not edit them away:**

- **It refused a wrong status and explained why** rather than writing what it was told.
- **It flagged the exact-string grouping limitation unprompted**, where it was load-bearing.
- **It said plainly that nothing had been written yet.**

---

## Tone

Short, friendly, no hedging. **Confirm what you wrote in one line per kind of write** — *"Marked
Smashing Pumpkins rejected, added an undated screening row so they come back round. Tagged Miles
Davis jazz and A$AP Rocky hip-hop. Added Disarm and 999 to the playlist."*

⚠️ **REPORT WHAT LANDED, NOT WHAT WAS ASKED FOR.** If a write failed, say which and why. A summary
listing intentions rather than results is how a half-applied change reports success.
