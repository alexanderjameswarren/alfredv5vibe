# The "Release" repair — 42 rows for review

**Nothing has been changed.** This is the proposal. Migration 007 will be written only from
the rows you approve, and will enumerate them literally.

`Release` is not an artist. It is YouTube's fallback label on auto-generated `- Topic`
channels, and 42 tracks were imported under it — spanning **20 different channels** and at
least a dozen unrelated acts. The parser was not at fault: the channel really is named
`Release - Topic`.

## How each proposed value was obtained

| tier | meaning | trust |
|---|---|---|
| **poll** | YouTube Music submitted this artist during a live poll; insert-only discarded it | highest — it is the same metadata source, already seen twice |
| **search** | `search_dj_music` returned **this exact `video_id`**, and its artist was read off that result | high — matched on id, never on title |
| **sibling** | inherited from a `search` hit **on the same channel id** | good, but inferred — see the rule below |
| **unresolved** | the search did not return this `video_id` | **leave as `Release`** |

**The matching rule, held absolutely: a result that is not the exact `video_id` is a MISS,
not a match.** Every search here returned convincing wrong answers — eight Miles Davis
recordings of *So What*, five *Deck the Halls* — and none were used. The method can only say
*found* or *not found*, never *plausible*.

**The sibling rule:** a `- Topic` channel is generated **per release**, so every track on one
channel is one release by one artist. Siblings inherit **only from a `search` hit on their own
channel** — never from another sibling, so no claim is ever two inferences deep. **Where two
tracks on one channel resolve to different artists, the whole cluster goes `unresolved`** — no
winner is picked. That did not occur.

⚠️ **Cluster 2 is the strongest case here**, and it is worth saying why: five tracks were
resolved by poll, and *Wheatland* and *Old Rockin' Chair* were then resolved independently by
search **to the same artist and the same album**. The per-channel assumption was confirmed
twice rather than assumed once.

---

## Resolved — 30 of 42

### Cluster 2 · `UCKRVkyLN9LDWxRFBkoc1nqQ` → **Oscar Peterson**
*The Oscar Peterson Trio in Tokyo*

| video_id | title | current | proposed | tier | resolved from |
|---|---|---|---|---|---|
| `kszNSrnr6eY` | The Good Life (Live) | Release | Oscar Peterson | **poll** | live poll metadata |
| `REk-lpXcUbE` | What Am I Here For (Live) | Release | Oscar Peterson | **poll** | live poll metadata |
| `cEYxRSHXCCM` | I Hear Music (Live) | Release | Oscar Peterson | **poll** | live poll metadata |
| `pDrq9QpOs8Y` | What Are You Doing the Rest of Your Life (Live) | Release | Oscar Peterson | **poll** | live poll metadata |
| `-exsCz9cRq8` | Strike Up the Band (Live) | Release | Oscar Peterson | **poll** | live poll metadata |
| `TI8Y1x7Gd7I` | Wheatland (Live) | Release | Oscar Peterson | **search** | own video_id, result #1 |
| `ccFzr7Xymdg` | Old Rockin' Chair (Live) | Release | Oscar Peterson | **search** | own video_id, result #1 |
| `4DNGhiNVigw` | The More I See You (Live) | Release | Oscar Peterson | sibling | of `TI8Y1x7Gd7I` (search) |
| `VtSNGN9Hb7M` | The Preacher (Live) | Release | Oscar Peterson | sibling | of `TI8Y1x7Gd7I` (search) |
| `S0Bzo4N_1EE` | Blues Etude (Live) | Release | Oscar Peterson | sibling | of `TI8Y1x7Gd7I` (search) |

### Cluster 1 · `UCeTfOw5J70RBb1s0M_av08Q` → **Jazzy Christmas Dinner & The Holiday Jazz**
*Jazz Arrangements of Christmas Classics For A Jazzy Christmas Dinner*

⚠️ **Read this cluster sceptically.** The artist name is itself a library-filler compilation
credit rather than a performer. It **is** what YouTube Music returns, so it is not a guess —
but it is barely more informative than `Release`, and 12 of the 42 rows ride on **one** search
hit. Rejecting this cluster and leaving all 12 as `Release` is a perfectly defensible call.

| video_id | title | current | proposed | tier | resolved from |
|---|---|---|---|---|---|
| `PoKBdBf6xgA` | We Wanna Wish You A Merry Christmas | Release | Jazzy Christmas Dinner & The Holiday Jazz | **search** | own video_id |
| `L0Y988hxxDw` | O Christmas Tree | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |
| `Bki99fexk0w` | Carol of the Bells | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |
| `N80yIhTc3ok` | All I Want For Christmas Is You | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |
| `zntUnbpk7j8` | O Little Town of Bethlehem | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |
| `Esg_-gLnSDY` | Deck The Halls | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |
| `E6h2cM9foHQ` | Feliz Navidad | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |
| `whauhnjmRb4` | Silent Night | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |
| `Wg0dlVLr8co` | The Holly and the Ivy | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |
| `PXmx3MzwfuA` | I'm Dreaming Of A White Christmas | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |
| `HTLv2bNZpVU` | The First Noel | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |
| `LPBR7C47mw0` | Jolly Old St. Nicholas | Release | ″ | sibling | of `PoKBdBf6xgA` (search) |

### Single-track clusters, each resolved by its own search hit

| video_id | title | current | proposed | tier | album on the matched result |
|---|---|---|---|---|---|
| `KNOFLu40NzY` | Edin | Release | **The Smashing Pumpkins** | search | *Aghori Mhori Mei* |
| `bRi_vfUpJhY` | Out of Nowhere | Release | **Miles Davis** | search | *Deluxe: Classics — Miles Davis* |
| `xqUsr6d7a8Q` | Take Five (Remasterizado 2020) | Release | **Dave Brubeck** | search | *Time Out (Remasterizado 2020)* |
| `f_NATzuXF-I` | Douce France | Release | **Charles Trenet** | search | *Le Jardin Extraordinaire* |
| `YbWWQPbeBDk` | Dream A Little Dream Of Me | Release | **Doris Day, Paul Weston And His Orchestra** | search | *Vintage Music No. 103* |
| `nxI6xiRvCQ8` | Oogie Boogie's Song | Release | **Ed Ivory & Ken Page** | search | *Nightmare Before Christmas Special Edition* |
| `blaNCikESpQ` | Let It Grow (From "Dr. Seuss' The Lorax") | Release | **The Lorax Singers** | search | *Dr. Seuss' The Lorax — Original Songs* |
| `Bm8JBPFuqJg` | London Plane | Release | **Luc Brooks** | search | *London Plane* |

---

## Unresolved — 12 of 42. **Leave as `Release`.**

The search did not return these `video_id`s. Every one is a heavily-covered standard where
YouTube Music returns the famous editions instead of this particular upload. **Guessing any of
them would be worse than leaving them wrong-but-honest**, and `match_key` is written once.

| video_id | title | why it missed |
|---|---|---|
| `V1_dIsqq_js` | So What | 8 other Miles Davis recordings returned |
| `uWdVOwRGDnM` | Freedie Freeloader | 5 recordings across 5 artists |
| `YPC8LrLp8wQ` | Boplicity | 4 Miles Davis editions, none this one |
| `F_QWV9hk6mY` | Jeru | Miles Davis and Gerry Mulligan editions |
| `HJyg_8mItR4` | Mr Grinch | 5 versions, none this one |
| `2r4E1UE4Pgc` | Let It Snow | Dean Martin, Sinatra, Bublé… |
| `UEwjhZ1txmc` | Love Is Here to Stay | Sinatra, Oscar Peterson, Ella… |
| `xtG3EpIiLBM` | White Christmas | Crosby, Drifters, Bublé… |
| `y8EgSUdC6rE` | Round Midnight | Miles, Monk, Wes Montgomery… |
| `JegU7wD5ukE` | Happy Holiday | Andy Williams and others |
| `GDzkoJoFjh8` | Deck the Halls | Nat King Cole, Platters, Crosby… |
| `paB8i2_2Q0s` | La vie en rose | Piaf, Armstrong, Grace Jones… |

⚠️ Clusters 3 and 4 are **almost certainly Miles Davis** — *So What* / *Freddie Freeloader*
is Kind of Blue, *Boplicity* / *Jeru* is Birth of the Cool, and `bRi_vfUpJhY` on a different
channel resolved to Miles Davis by search. **That inference is deliberately not acted on.**
It is exactly the reasoning that would have made `Edin` obscure jazz instead of The Smashing
Pumpkins. If you want those four, the right move is to look them up by another route, not to
conclude them from track listings.

---

## 🛑 The Deck the Halls split — the case most likely to be forgotten

`Esg_-gLnSDY` and `GDzkoJoFjh8` are both titled *Deck the Halls*, both currently
`artist = "Release"`, so both key to `release|deck the halls` and **sit in one canonical
group today**. They are on **different channels** and are different recordings. This is the
first known wrong merge in the system, and the check that passed an hour before it surfaced
could not have seen it (spec §11.12).

After the repair they diverge: `Esg_-gLnSDY` gets a new `match_key`, `GDzkoJoFjh8` keeps
`release|deck the halls`. **Migration 007 must therefore re-point `canonical_track_id` for
whichever of the two is currently the follower** — otherwise a member is left pointing at a
leader whose `match_key` no longer matches.

**`dj-grouping-check.js` must be run after the migration and must come back with `CROSS_KEY:
0`.** That is a gate, not a formality: it is precisely the failure this split would produce.

---

## Summary

| | tracks |
|---|---|
| poll | 5 |
| search | 10 |
| sibling | 15 |
| **resolved** | **30** |
| **unresolved — stay `Release`** | **12** |

A partial repair is the intended outcome. 12 rows staying wrong-but-honest is a better
record than 12 rows confidently wrong.
