# Known-permanent `artist_disagreements` — do not re-investigate these

> ## ⚠️ THE TABLE IS AUTHORITATIVE. THIS PAGE IS ITS RENDERING.
>
> The code reads **`public.dj_known_disagreements`**. This page explains those rows for a
> human. **If the two ever disagree, the table is right and this page is stale.**
>
> Seeded by `supabase/migrations/008_dj_known_disagreements.sql`. Adding a decision means
> inserting a row **by hand**, reviewed — no tool writes this table, because a tool that
> could silence its own alarms is the wrong shape. Then update this page to match.

**Purpose: stop the same three things being investigated repeatedly.**

`artist_disagreements` fires whenever a play is submitted for a track already stored under a
different primary artist. It is a real signal — it found the `Release` parsing defect, which
it was not designed for. But some entries are **permanent and decided**, and they will fire
**every single time** those tracks are played.

⚠️ **They cannot fix themselves.** `dj_tracks` inserts use `ON CONFLICT DO NOTHING`, so the
correct value arriving later is discarded, not applied (spec §11.13). Only a reviewed
migration changes them.

**If a disagreement is on this page, it has been decided. Nothing to do.**
**If it is NOT on this page, it is new — read it.**

In practice you will rarely see the decided ones at all: `record_dj_plays` partitions against
the table and returns them as **`known_disagreements`**, separately from
`artist_disagreements`, so the daily task never raises an inbox item for them. The count is
still reported — a run that is silent because everything was decided must not look identical
to one that is silent because the notifier broke.

---

## 1. `AbbzAPXvNZ8` — *Roundalay* · decided 2026-09-01, no alias entry

| | |
|---|---|
| stored | `Oscar Peterson` |
| submitted | `Oscar Peterson Trio, Clark Terry` |

**Decision: leave it. Do NOT add an alias-map entry.**

The alias map exists for **one act spelled two ways** — `Eddie Higgins` / `Eddie Higgins
Trio`, `Red Garland` / `The Red Garland Trio`. This is not that. It is **a specific
collaboration**: Oscar Peterson's trio with Clark Terry, a distinct billing rather than a
vocabulary variant.

An alias entry would map every `Oscar Peterson Trio, Clark Terry` credit onto plain
`Oscar Peterson`, **merging a Clark Terry collaboration into Oscar Peterson's solo work.**
The map's job is to remove spelling differences, not crediting differences.

**Consequence, accepted knowingly:** playing this track raises the disagreement again, every
time, for as long as the row stands.

---

## 2. The 12 unresolved `Release` tracks · decided 2026-08-31

Imported with `artist = 'Release'`, a YouTube fallback channel label rather than an act.
30 of the original 42 were repaired by migration 007. **These 12 were deliberately left**,
because YouTube Music's search never returned their exact `video_id` and guessing an artist
into an insert-only `match_key` is worse than leaving it honestly wrong.

| video_id | title | | video_id | title |
|---|---|---|---|---|
| `V1_dIsqq_js` | So What | | `uWdVOwRGDnM` | Freedie Freeloader |
| `YPC8LrLp8wQ` | Boplicity | | `F_QWV9hk6mY` | Jeru |
| `HJyg_8mItR4` | Mr Grinch | | `2r4E1UE4Pgc` | Let It Snow |
| `UEwjhZ1txmc` | Love Is Here to Stay | | `xtG3EpIiLBM` | White Christmas |
| `y8EgSUdC6rE` | Round Midnight | | `JegU7wD5ukE` | Happy Holiday |
| `GDzkoJoFjh8` | Deck the Halls | | `paB8i2_2Q0s` | La vie en rose |

**Consequence:** each of these raises a disagreement whenever played, and the submitted value
will be the *correct* artist. That is the defect, not a new finding.

⚠️ Four of them are **almost certainly Miles Davis** by track listing — *So What* and
*Freedie Freeloader* are Kind of Blue, *Boplicity* and *Jeru* are Birth of the Cool. **That
inference is deliberately not acted on.** It is the same reasoning that would have made
`Edin` obscure jazz rather than The Smashing Pumpkins. If they are ever resolved it must be
by lookup, not deduction. See `docs/dj-release-repair-review.md`.

---

## 3. The five *Smokin' At The Half Note* tracks · decided 2026-09-29, migration 085

| | |
|---|---|
| stored | `Wynton Kelly Trio, Wes Montgomery` |
| submitted | `Wes Montgomery, Wynton Kelly Trio` |

| video_id | title | | video_id | title |
|---|---|---|---|---|
| `Z6Piiu3d3sE` | What's New | | `FsnO8hmlxmM` | Four on Six |
| `D12_468jvNk` | Unit 7 | | `I0V2ZTwnuK8` | If You Could See Me Now |
| `BCKjFxn0xKY` | No Blues | | | |

**Decision: leave it. Do NOT add an alias-map entry.**

**The same two artists, with the lead credit reversed.** Both sides derive their primary
through `primaryArtistOfDisplay`, which cuts at the first comma, so one side reads
`wynton kelly trio` and the other `wes montgomery`. The two bylines genuinely differ — the
detector is right to report it, and this is **not** a false flag.

**Why the alias map is the wrong tool.** The map is for **one act spelled two ways**. Wes
Montgomery and the Wynton Kelly Trio are two acts, and an entry either way would fold one
artist's work into the other's — the `AbbzAPXvNZ8` case above, word for word: a crediting
difference, not a vocabulary variant.

**Consequence, accepted knowingly:** each of these raises the disagreement whenever played,
for as long as the rows stand. `dj_tracks` is insert-only, so the incoming value is discarded
rather than applied (spec §11.13) and they cannot fix themselves.

⚠️ **One thing this decision does NOT cover, and it is open.** The five rows are keyed
`wynton kelly trio|<title>` — verified 2026-09-29, **split at the first artist**, so the
unsplit-key defect that `record_dj_album` used to cause does not apply to them. But the poll
derives its primary as `wes montgomery`, so **another upload of one of these recordings would
be keyed `wes montgomery|<title>` and would not group with the row stored here** — one
recording, two canonical groups, from the credit order alone. `match_key` is frozen at write
(spec §4.1.2). A decision row silences a notification; it repairs no identity.

🛑 **Nor does it make the detector order-insensitive.** Comparing the normalised *set* of
artists on each side, and suppressing a permutation, would be a fix rather than a suppression
— but it would also silence the case where a changed lead credit is the news. That is its own
decision, not a side effect of recording these five.

---

## What is NOT on this list

**Collaborations no longer fire at all.** `Coldplay, BTS` vs `Coldplay` and five others used
to appear here; the detector was comparing the joined display string against a single
submitted artist (spec §11.7). It now compares **normalised primary artists derived the same
way on both sides — `primaryArtistOfDisplay` on each display byline, which cuts at the first
comma, alias-translates and normalises.** Identical inputs are unflaggable by construction. If
a plain collaboration shows up again, the detector has regressed.

⚠️ **`match_key` is NOT the basis, and reading it was itself the bug** — amended 2026-09-25,
spec §4.1.4. The detector used to take both primaries out of a stored `match_key`, but the
call sites that write those keys disagree about what `artists[]` is: `record_dj_album` passed
the whole byline as one element while the poll passes it split. So a stored key carried
whichever tokenisation its writer happened to use, and run `91151897` reported **19 pairs of
identical bylines against themselves** — `Clifford Brown, Max Roach` vs
`Clifford Brown, Max Roach`. If a future edit reaches for `match_key` again, that is the
regression to expect.

## Adding to this page

Only after a decision has been made and recorded — **not** as a way to silence something
awkward. An entry must say what was decided, why the alias map is the wrong tool for it, and
what the ongoing consequence is. A page of unexplained exemptions is worse than no page,
because it launders "we never looked at it" into "we decided".
