# Known-permanent `artist_disagreements` — do not re-investigate these

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

## What is NOT on this list

**Collaborations no longer fire at all.** `Coldplay, BTS` vs `Coldplay` and five others used
to appear here; the detector was comparing the joined display string against a single
submitted artist. It now compares **normalised primary artists, both read from `match_key`**
(spec §11.7). If a plain collaboration shows up again, the detector has regressed.

## Adding to this page

Only after a decision has been made and recorded — **not** as a way to silence something
awkward. An entry must say what was decided, why the alias map is the wrong tool for it, and
what the ongoing consequence is. A page of unexplained exemptions is worse than no page,
because it launders "we never looked at it" into "we decided".
