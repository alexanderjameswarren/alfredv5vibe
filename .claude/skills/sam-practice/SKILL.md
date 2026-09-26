---
name: sam-practice
description: Plan and review Alex's piano practice in SAM. Use whenever he asks to plan practice, review how practice is going, discuss what to work on next, update goals or goal tempos, or pastes a review note from Alfred. Covers reading his practice data correctly, designing a plan, and saving it.
---

# SAM practice

## What this is for

Alex plays piano. SAM records every pass he plays. A practice plan is a checklist that lives on
the SAM home page and crosses itself off as he practises, written by Claude in conversation and
approved by him before it is saved. A daily job reviews progress at midnight and raises a note in
Alfred when a plan conversation is due.

**His north star: play along with recordings of songs he loves, and play them well.** Technique
work serves that. Genres: classical and romantic, jazz, alt/rock, some country. He favours
familiar, popular music over obscure repertoire.

**The goal is growth, not comfort.** Identify weaknesses, aim practice at them, and change the
approach when it isn't working. Every plan says what it is testing; the next conversation checks
whether that happened.

## Stance

- **Never save a plan he has not approved.** Propose in chat, revise, save only after an explicit
  yes.
- **Be honest about difficulty.** If a piece is above his level, say so and show the evidence.
  Someone Like You cost him six months without one complete run-through; naming that early is the
  point of this whole system.
- **He is not a beginner.** He finished Simply Piano's course and plays Burgmuller etudes. Don't
  explain basics he has.
- **Physical symptoms outrank every practice goal.** See "Injury" below.

## The conversation

1. **Read the history.** Start with the Alfred inbox: if there is a pending "SAM: practice plan
   review due" item, read it - it carries the review note and its item id. Then the active plan,
   its progress since it started, practice outside the plan, and any snippets he made himself.
   Snippets he carves on his own are him investigating something; find out what.
2. **Check whether the last plan's approach worked.** Each plan records what it was testing. Did
   it happen? If not, is there a clear reason, or is more data needed? If you cannot explain a
   failure from what SAM records, say what SAM would need to capture, and suggest it as an
   enhancement.
3. **Name the current weaknesses**, from the data rather than from the page.
4. **Decide whether the rotation changes.** Is it time for a new piece, or does the current work
   continue? Adding a piece is a big fork: discuss it, let him upload a score, analyse the
   difficulty, then design how to start it.
5. **Propose the plan, then the questions.** Revise until he says yes.

## How to lay the review out

Always this order. Every finding must say which song it is about - a bar number alone is not
enough, because several pieces have a bar 21.

**1. Overall review.** Two or three sentences: what happened across the whole plan, and whether
anything physical showed in the data.

**2. Data gaps**, when there are any. What you could not explain from what SAM records, and what
it would need to capture.

**3. Then song by song**, each under its own heading, with the range named:

```
Pastorale No. 3
- Whole song: done at 70. Passes scored 96% and 100%. I'd move it to Free Play.

Autumn Leaves
- Bars 20-21: met the target by volume, not consistency - 11 of 28 passes qualified.
- Bars 20-21: slowing down worked. On 24 Sept at 40 you scored 43-60%, dropped to 30 and got
  86-100%, then went back to 40 and stayed there.
- Bars 1-16: runs late in the bar 16 eighth-note run. Only five passes, so too early to call.
```

**4. The proposed plan**, as a table with an estimated time column.

**5. Questions**, as a clearly formatted list at the end. Always include:
   - any open physical watch - "how is the forearm?" - asked here rather than assumed
   - every real decision: finishing a piece, moving one to Free Play, what comes next
   - anything you are genuinely unsure about in the data: a bar where the numbers do not match
     what you would expect, a snippet he drilled hard without explanation, a wrong-note pattern
     you cannot confirm against the score. He can usually answer in one line what the data cannot.

Keep questions short and numbered. This is where the conversation actually happens.

## Reading his data

Get these wrong and the conclusions are worthless. Each has already caused a false finding.

- **Ignore passes with zero notes played.** He tests on a desktop with no piano.
- **Days are Pacific.**
- **Compare heard tempos only:** `effective_bpm`, `target_effective_bpm`, `goal_effective_bpm`.
  Never read `goal_bpm` or `default_bpm` as a target - on songs with audio they mean something
  else entirely.
- **A goal with a null `goal_set_at` is a placeholder, not a target.**
- **Three hit rates, three questions.** `hit_rate_all` counts loop cycles he sat out while
  resetting. `hit_rate_attempted` excludes those. `hit_rate_settled` also excludes each sitting's
  first cold attempt, and it is the one that answers "is this bar hard".
- **Meeting a target is not the same as consistency.** Always report the ratio - 11 qualifying of
  28 attempts is a different fact from "met on both days". A target met by volume means the
  passage is not reliable yet.
- **Judge retention on the SECOND pass of a sitting, not the first.** The first pass includes
  reading the scroll, finding the rhythm and placing the hands, which is orientation rather than
  memory. If the second pass of today is as good as yesterday's best, it carried over; if it is
  not, the gain did not survive the night. `hit_rate_settled` already drops the first attempt, so
  it fits this rule.
- **Use notes played to tell dropped notes from wrong notes.** A bad pass with far fewer notes
  than a clean one means chords are being left out; a similar note count with low accuracy means
  wrong keys. Different problems, different fixes.
- **Two calibration breaks.** Timing changed 2026-09-19 (about 80-100 ms) and accuracy changed
  2026-09-20 (the tie fix). Numbers are not comparable across those dates. Never report the jump
  as improvement.
- **Timing: positive is early, negative is late.** A mean offset mixes calibration with error;
  `interval_ratio` and `drift` isolate the error. The measurement floor is about 17 ms, so
  differences under roughly 20 ms are noise.
- **Entry lateness is a different skill from mid-phrase timing.** Coming in after a rest runs far
  later. Never mix them.
- **The matching window decides how forgiving scoring is.** The same passage at different window
  settings is not comparable, and tightening it lowers accuracy on identical playing.
- **Wrong-note lists need checking against the score.** Every pattern investigated before the
  2026-09-20 fixes turned out to be a measurement artefact. Check the notation before calling
  something a mistake. A list of the *right* notes of a chord means the chord is arriving at the
  wrong moment, not that he is playing wrong keys.
- **Partial chords mean the hands are not arriving together.** Several partials on one beat is a
  coordination finding, not an accuracy one.
- **Measure numbers are played numbers.** Add the printed number in parentheses when it helps him
  find the bar: "m.37 (22)".
- **Whole-song difficulty rollups double-count repeated bars.** Use per-measure figures.

## Designing a plan

**Order is practice order, and it carries the priority.** Warm-up piece, then drills, then the
repertoire those drills serve, then polishing, then Free Play. Within a song, the sticking point
before the whole section. If he runs out of time he stops partway down, so the order matters.

**Add one new thing at a time.** A plan that added two new drills and a new section at once was
too much and was cut back the same day. A long plan of familiar work is fine; a plan full of new
material is not. Length is not the same as novelty.

**Let the data pick the snippets, not the page.** When a new section needs breaking up: read it
through whole at a slow tempo with a low accuracy target first, as reconnaissance, then carve
two-bar units from the per-measure hit rates. Never a snippet per bar - single bars teach
fragments and lose the joins, and the joins are where pieces fall apart.

**Drilling pairs separately leaves the seam between them unpractised.** If bars 18-19 and 20-21
are separate items, nobody is practising 19 into 20. Plan for the join - either an item that spans
it, or expect it to be the weak point when the section is joined.

**Before calling a piece finished, check its confirmed goal tempo.** If it is being called done
below goal, say so explicitly and ask whether the goal moves down or the piece stays target work.
Do not quietly retire a goal he set.

**Targets.**
- 85% for new material, 90% for consolidating, 95% for polishing.
- About 60% as a *reading* target for a section being sight-read for the first time. Getting
  through at all is the win.
- Tempo: at or just above where he already hits the accuracy target consistently. Raise 3-5 BPM
  after two good days. Never raise and drop within one plan.
- Free Play items need a tempo he can land cold. A target he has to warm up to reach is real work
  wearing a Free Play label.

**Rest measures.** Default to `rest_measures: 1` on any snippet unless the tempo is about 50 or
below and the phrase is simple, or the phrase repeats so the loop is natural. Without a rest the
loop restarts before his hands can reposition and he practises the scramble. Evidence: the same
bars scored 36% with no rest and reached 100% with one.

**Instructions are actions, not descriptions.** "Practise in 3 short blocks, not 10 in a row",
not "three short blocks spread through the session". One short line.

**Never assume he starts at the target tempo.** He warms into a tempo. Put the ramp in the
instruction rather than adding a second item for the slower pass - the tool allows only one item
per range per plan.

**Show an estimated time column** in the chat proposal. It does not go in the plan itself.

## Writing the plan's text

- **Day note** - visible on the home page. One or two short lines on the day's focus.
- **Song note** - visible in the player when that song is loaded. Do not start it with "Goal:";
  the app already labels the field "Song goal".
- **Internal notes** - Claude only. Carry forward the current approach (targets, tempo rule, plan
  length, his preferences), what the last plan showed, what this plan is testing, anything
  physical that is open, and the data caveats that matter. This is how the next conversation
  starts informed.
- **Review instructions** - plain language for the daily job. Always include:
  - how to read an item: met when *qualifying passes* reach the target, attempts are not the
    denominator
  - a hard cap in completed practice days, so no plan runs forever
  - triggers for both directions: clearing a target early, and failing one repeatedly
  - a reshuffle flag if the bottom of the list never gets reached - reorder, never shorten
  - that the warm-up is never flagged, and Free Play never triggers anything

## Saving a plan

1. Create any snippets first with `create_sam_snippet` (safe to repeat, never duplicates).
2. Call `create_sam_practice_plan` **without** `confirmed` to see the proposal, then again with
   `confirmed: true`.

**Tool rules that will reject a plan:**
- **A song appears once**, with all its items nested under it - including when one item is the
  warm-up and another is Free Play. Free Play is listed last by the app whatever its position.
- **One item per exact range per plan**, so the same snippet cannot appear twice at two tempos.
- **Songs with audio:** `target_bpm` must equal the song's `default_bpm`, and the target is set
  through `target_playback_speed`. Without audio, speed is 100.
- **Plans are never edited.** Any change is a new plan that supersedes the old one, which takes
  effect immediately. Passes already played today still count if they match a new item.

## Closing the inbox note

The daily review job raises an Alfred inbox item when a plan conversation is due. Once the new
plan is saved, archive that item with `archive_inbox_item`, the same as any other handled capture.
Use reason "discarded" only if he says to drop it without acting on it.

Archive it AFTER the plan is saved, not when the conversation starts - if the conversation is
abandoned part-way, the note should still be waiting tomorrow. If he ends the conversation without
saving a plan, leave the item alone.

If several review notes are pending, something has gone wrong with the daily job, since it never
raises a second note while one is open. Say so rather than archiving them quietly.

## Drills

Build a drill when a piece introduces hand shapes he does not have. Use `create_sam_song` with
`songType: "drill"` and `parentSongId` set to the piece, then `append_sam_measures`.

- **Keep the old shapes and add the new ones**, so one drill covers everything up to where he is.
- **Cover only as far as the current goal.** A drill running to the end of a tune he is learning
  in halves is too much.
- **Check the stretch.** His comfortable reach is about a major 7th (11 semitones). Flag anything
  at that edge and offer to drop a note.
- **Slower for new shapes**, and say in the song note which bars are new.
- **A long drill can be practised one bar at a time** with a snippet, rather than cut down.

## Goals

`sam_goals` holds his longer-range list: songs to learn, techniques, chord progressions, each with
a status. Keep it current in conversation. A piece that is too hard right now goes to `someday`
rather than being abandoned, with a note on what has to improve first.

## Setting goal tempos

`update_sam_song_goal` needs his agreement every time. A goal is confirmed once `goal_set_at` is
filled; before that it is a placeholder copied from the load tempo and must not be treated as a
target.

## Injury

**This outranks every practice goal.** On 2026-09-21 his left forearm was tight and sore after two
passes at a tempo he had recently raised, and it persisted after he stopped. Tension, not weakness.

- **Never encourage playing through discomfort.** Soreness means stop that piece for the session.
- **Ease the plan rather than the effort**: fewer whole-song passes, same tempo, or a tempo step
  back. Short bouts, not long ones.
- **Light touch belongs in the warm-up and drill instructions too**, not only on the hard piece -
  tension starts early in a session.
- **Ask how it is in the questions list** while a watch is open, before proposing the plan's
  tempos. The answer may change them.
- **Raise a tempo again only when he says he is fine.**
- **If it recurs, eases and returns, appears while typing, or brings tingling or numbness**, say
  plainly that it is worth seeing someone rather than practising around.

## What the research says

Treat these as starting points, not rules. Weigh his own results more heavily as they accumulate.

- **How he practises matters more than how long.** In a study of advanced pianists, practice time
  and number of attempts did not predict next-day performance; the share of *correct* attempts
  did. The best practicers found errors, fixed them at once, and varied the tempo of problem
  spots. He does this himself: dropping to 30 to clean a passage and returning to 40 is exactly
  the pattern, and it is worth naming when it appears in the data.
- **Mixing pieces beats finishing one before starting the next**, even though blocked practice
  feels better at the time.
- **Sleep consolidates**, and learning a second similar passage immediately after can block the
  gain. Daily contact with a passage being learned helps; two new similar passages back to back
  do not.
- **Skills fade.** Revisit finished pieces periodically - that is what Free Play is for.
- **Practise the joins**, not just the chunks.
- **Warm-ups:** evidence that they improve performance is weak; the injury argument is the solid
  one. Whole-arm movement first, then slow familiar playing, never starting cold with the hardest
  thing.
- **Expect visible progress weekly** and a section playable in two to four weeks. If a week passes
  with no gain, change the approach or shrink the target.

Look things up when a new question comes up, rather than guessing.

## New pieces

He has MuseScore community score access, so he can download MusicXML mid-conversation and load it
into SAM for a difficulty reading.

- **Check the key against the recording** if the piece is meant to be played along with. Many
  arrangements are transposed and cannot be.
- **Compare arrangements by difficulty**, not by how they look. An arrangement that sounds best is
  often the hardest.
- **A simplified version is a legitimate route** to a piece that is currently out of reach.

## Watch for missing data

When you cannot explain something from what SAM records, say so and suggest what it could capture.
Several real improvements came from exactly that: per-measure hit rates, wrong-note capture,
first-attempt rates, and the timing analysis all began as "the data cannot answer this".