# Changelog

Version convention: below 1.0, an addition is a patch and a breaking change is a minor (npm reads `^0.1.2` as 0.1.x only, so templates take a patch on their own and hold a minor for a person).

## 0.3.6 (2026-10-13)

- **A batch is a folder tile, and tiles say what they say.** With `multiPhoto` on, the photos of one
  Send on one day are one tile in `SnapsArchive`: the first photo with one photo peeking out behind
  it for a pair and two for three or more, and a count of the photos in the corner (replacing the
  `+N` of 0.3.5). Every tile also shows its snap's caption on one line under it. With the option off
  nothing is drawn differently from 0.3.3.

## 0.3.5 (2026-10-13)

- **Photos sent together carry a batch mark, and the archive shows them as one tile.** With
  `multiPhoto` on, each photo of a Send of two or more files with `batch: { id, index, size }`
  (a random id per Send kept across a retry, the photo's place from 0 in the order picked, and how
  many were sent). The server stores exactly those three fields, refuses a batch when the option is
  off or the mark is not valid (id of 8 to 40 letters, digits, `-` or `_`; size 2 to 10; place below
  size) before the app's pipeline is touched, and writes nothing for a single photo. `Snap.batch`
  and `SnapRow.batch` carry it. `SnapsArchive` draws the photos of one batch on one day as one tile:
  the first of them, with `+N`, opening that first one. Each photo is still its own snap, with its
  own hearts, comments and seen. A snap filed without a batch reads exactly as before.

## 0.3.4 (2026-10-13)

- **`multiPhoto: true`: pick several photos at once, one caption.** With the option on, the Photo
  button takes up to 10 photos. The sheet shows them side by side with a way to take one out, and
  one caption, Just us and tag for all of them. Send files each as its own snap, one at a time, in
  the order picked ("Sending 2 of 5"). A photo that fails stops the run: the ones already filed
  stay filed and leave the sheet, the rest stay to try again, and a photo whose bytes already
  uploaded is filed from the stored copy rather than uploaded twice. Video, the two-shot camera
  and voice notes stay one at a time. Off by default; with it off every screen is as it was.

## 0.3.3 (2026-10-13)

- **`@supersuit/cowitness/camera`: the two-shot capture layer on its own.** `SnapCamera`,
  `openStream` and `askForMotion`, from an entry that reaches nothing but React, so an app that
  is not a Next.js app (or mounts none of Cowitness's screens) can take the same photo: the
  selfie first, then the back camera, an optional screenshot, one composed jpeg handed to
  `onCapture`. `/client` is unchanged.

## 0.3.2 (2026-10-12)

- `VoiceNote` accepts `maxSec` so a custom conversation can stop a spoken reaction at the same three-minute limit the server accepts. Voice snaps retain their default twenty-minute limit.

## 0.3.1 (2026-10-12)

- Witness with emojis and typing first. Add voice optionally; after that tap, speech is recorded hands-free and transcribed through the host adapter. Each snap keeps its own emoji selection and retries remain quiet.
- Shared discussion input, send button, emoji palette, draft helpers, retry-id rules and reaction toggle rules can be reused by a host's other tiles, including transcript passages.
- Compact custom audio playback keeps transcripts foremost, supports keyboard seeking and labeled play/pause, and reports playback failures. Voice-note words refresh automatically while transcription is pending.
- An author can discard a wordless recorded reply after transcription finishes. The conversation hides it while retaining its record and audio; other people's replies, words, images and active transcriptions are protected.
- The optional transcription settled hook lets hosts index words after they are saved. Member-scoped held reaction retries and signed-in identity checks prevent replaying a recorded reply under another person after an account change.

## 0.3.0 (2026-10-12)

- **`host.agent` and `handlers.agent`: the Mac posts a snap as one member (ticket, file, read back).**
  An app that adds an `agent` block to its host (`member`, `photoTicket`, `videoTicket`) mounts
  three routes. The agent key acts as exactly one member and never reads the session; a snap is
  filed and announced as that member's own share, through the app's own upload pipeline, and can
  be read back for its witness state. Without the block every agent route answers 401. An app that
  adds nothing changes in nothing.

## 0.2.4 (2026-10-12)

- **The streak takes a time zone, and the counting is no longer Cowitness's own copy of it.**
  `CowitnessHome` and `StreakStrip` take `timeZone`: one named zone for everyone
  (`'America/Chicago'`) or the zone each member keeps
  (`{ ana: 'America/Chicago', ben: 'America/New_York' }`). A day then counts in every zone in play
  rather than only its owner's, so a member's days are the union of those day keys and a together
  day is the intersection of the members' unions. Left out, the strip counts the phone's own
  calendar day exactly as it did in 0.2.3, so no app that passes nothing changes.

  What this fixes: a phone an hour east of the zone the streak is kept in filed a late-evening
  snap on the NEXT day, which opened a gap on every day its owner shared only late and showed that
  owner's streak and the together streak as broken when neither was. Two people in Central and
  Eastern, both sharing every day for fifteen days, read as 15 / 1 / 0 on the eastern phone and
  15 / 15 / 15 in the zone they keep.

- `src/streak.ts` and `src/zoned.ts` are now re-exports of
  [`@supersuit/streak-steward`](https://www.npmjs.com/package/@supersuit/streak-steward) (a new
  dependency), not implementations. They were a copy of the same code, which is why this one bug
  existed in two places and was fixed in only one. Every name they exported is still exported, with
  the same behaviour, plus `zonedStreakOf`, `zonedStreaksOf`, `zonesOf`, `localDayKey`,
  `msUntilMidnight` and the types `StreakRow` and `StreakZones`.

## 0.2.3 (2026-10-09)

- The language picker, the tag picker and the reminder times field were set at 14px, so iOS Safari zoomed the page when one was focused. They are now 16px (`text-base`) with the same height and padding. A test reads every input, textarea and select in the screens and fails if one is under 16px.

## 0.2.2 (2026-10-05)

- New option `home: 'today'`, off by default. The Cowitness home shows the last 24 hours (a rolling window, witnessed or not), and the shelf behind the link, now named "Earlier", holds everything older. Nothing is deleted and the streak still counts every snap, so the home feels new each day and the record stays whole. With the option off, every answer and screen is what 0.2.1 produced. New rules `todayOf` and `earlierOf`.

## 0.2.1 (2026-10-02)

- The camera screen now says why the camera did not open instead of a bare "No camera." and the reason was previously thrown away. Blocked permission, another app (such as a video call) holding the camera, no camera at all, and anything else each get their own plain-language title and fix, and an unrecognized failure shows the error's name in small text so a screenshot says what happened. A "Try again" button re-opens the camera; "Choose a photo instead" stays. A browser with no camera API at all now rejects as a missing camera. The other catches in the camera screen (taking the shot, reading a screenshot, saving) never led to this screen and are unchanged.

## 0.2.0 (2026-10-01)

Options, all off by default. With none turned on, for every request 0.1.3's own client sends, every answer, stored record, call into the host and screen is what 0.1.3 produced (a golden recorded from 0.1.3 proves it). One request 0.1.3's client never sent is now refused: with the options off, a filing body carrying a `justUs` other than `false` or `null`, or non-null `tags` answers 400 instead of being filed with the field ignored, because ignoring it would show a private snap to everyone.

- The audience kind: the app says who shares and who witnesses (`people()`); each witness has their own seen (`witnessedBy`), their own queue and shelves; the first seen stays the snap's receipt.
- "Just us": a snap visible only to the people who share. It fails closed: a snap filed "just us" stays private whatever the options say later, and with no circle to say who shares it is its author's alone, across covers, counts, lists, signed links and announcements. Its author always sees it; someone who does not share cannot file one (400). Every announcement hands the app the snap with its flag, and the app must check each recipient with the new `mayHear` before telling them.
- Tags from a list the app supplies (`tags.list`, at most `tags.max` per snap, default one), set when sharing or later; `announce.tagged` tells the app, at filing and when they change.
- Voice notes as snaps: recorded into the phone's vault, sent under its own id so a retry files the same snap, transcribed afterwards like a spoken reaction, played from a signed link. The upload is stamped with who it was issued to (`x-goog-meta-cowitness-by`, in the ticket's `requiredHeaders`), and filing refuses bytes stamped for anyone else. Its words can be asked for again by its author at any time except during a live run, and by anyone else who can see it only when the run failed or stalled.
- Capture reminders: each person's own times, one person per reminder, snooze a day, claimed once before the app's `prompts.nudge` is called; `store.sendDuePrompts` runs from the app's own timer.
- The household streak: one count in one time zone from a start date, with one free skip a week when the app allows it. A person who only witnesses is shown no streak.
- The double camera can be turned off.
- `announce.spoken` tells the app when a spoken reaction is filed. It is opt-in by supplying the callback, not by an option: an app without it hears nothing new.
- `askPeopleOnce(host)` makes a request's store ask the app who its people are once. Make it per request, never at module scope.
- Handlers to mount: an app upgrading from 0.1.3 adds four groups to its routes, `voiceUploadUrl`, `voice`, `voiceTranscribe` and `prompts` (the README's table gives each file). They answer 404 while their option is off. The bucket's CORS must also allow the `x-goog-meta-cowitness-by` request header for voice uploads.
- Types: `media.urls` now returns `MediaSnap`.
- Screens: `CowitnessHome` takes `can`, `tagChoices` and `languages`; `SnapDetail` and `SnapsArchive` take `tagLabels`; `AddSnap` takes `shares`; new `VoiceNote`, `VoiceMedia` and `CaptureReminders`; `sendHeldVoiceSnaps` reports a note the server refused for good through `onDropped`.

Why a minor: `Snap.kind` now includes `'voice'` and `Snap`, `SnapRow` and `SnapPatch` gained members. Nothing behaves differently with the options off, but an app that branches on `kind` or assigns a `Snap` to its own photo type may need a line changed, so a template takes this through `living/bump.mjs --allow-major` and its own check, never silently.

## 0.1.3 (2026-10-01)

- A host's `commentImages.attach` that throws after a comment was saved no longer answers 500 (which
  made the phone send the comment again). The failure goes to `host.log('commentImages.attach
  failed', err)`, or is dropped, and the message is still announced.

## 0.1.2 (2026-10-01)

- The phone's resend no longer depends on one app's refusal wording. On a retried Send, any 400,
  403 or 409 refusal makes it ask whether the snap was already filed (found: sent; gone: start over
  from a fresh ticket), whatever the host's pipeline calls it.
- A host `announce` that throws, or returns a promise that rejects, after its snap or comment was
  saved no longer turns the answer into a 500 (which made the phone send it twice). The failure
  goes to the new optional `host.log(message, err)`, or is dropped.
- A refusal answers with its own status only when that is 400-499 (403 when it has none). A refusal
  carrying any other status is logged and answers an opaque 500, instead of a success or a crash.
- Documented the host's duties: `media.filePhoto`/`fileVideo` must check the upload was issued to
  the member, claim it exactly once and refuse when the record exists; and a pipeline with
  refusals of its own must pass them as `isRefusal`, which the phone's resend relies on.
- README: points at the exported `CowitnessHost` type rather than an unshipped source file, and
  documents `ThreadSlotProps`. The publish workflow now runs the comment-date check.

## 0.1.1 (2026-10-01)

- First release through GitHub Actions with npm trusted publishing and provenance. No change to the package's behaviour.

## 0.1.0 (2026-10-01)

- First version: Cowitness moved out of the app it was built in, unchanged in behaviour.
