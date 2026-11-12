# Testing First Mic

## Automated checks

### Unit tests and type checks (no server needed)

```bash
pnpm install
pnpm check
```

This runs the server typecheck and the web type-check, lint and unit tests. The unit tests cover:

- the take recorder: auto-stop at the limit, whole-millisecond durations, reload survival, Try Again
- Send: upload, finalize, waiting for the server, failure and retry, a deleted episode, the deadline
- the uploader: finalize retry, stopping on a rejected upload

### End-to-end against a real server

These need Docker. Port 18100 is used because Windows often reserves 4100.

```bash
docker build -t firstmic:dev --build-arg VITE_GOOGLE_CLIENT_ID=test-client .
docker run -d --name firstmic-e2e -p 18101:4100 -e FIRSTMIC_MAX_SECONDS=10 \
  -e VITE_GOOGLE_CLIENT_ID=test-client \
  -e GOOGLE_TOKENINFO_URL=http://host.docker.internal:18199/tokeninfo \
  -e GOOGLE_USERINFO_URL=http://host.docker.internal:18199/userinfo firstmic:dev

cd e2e
npm install
npx playwright install chromium webkit
node make-media.mjs     # makes test tones with the container's ffmpeg
node api-smoke.mjs      # 20 API steps
node solo-e2e.mjs       # 14 browser steps, screenshots in e2e/out/
node webkit-layout.mjs  # Safari-engine layout of the home page and student screens
node group-smoke.mjs    # 16 API steps for two-person podcasts, with two live-call connections
node group-e2e.mjs      # 11 browser steps: two browsers, each with its own fake microphone

docker rm -f firstmic-e2e
```

`FIRSTMIC_MAX_SECONDS=10` keeps the auto-stop test short.

The tests never talk to Google:
- Each script starts `e2e/fake-google.mjs` on port 18199, which stands in for Google's token-check endpoints. The
  container points at it through `GOOGLE_TOKENINFO_URL` and `GOOGLE_USERINFO_URL`.
- The browser test replaces Google's sign-in script with a stub that "picks" a test account.

Use a fresh container for each run of `api-smoke.mjs`, because it signs in with a fixed email.
`group-smoke.mjs` and `group-e2e.mjs` check audio inside the container with `docker exec`, so pass the container
name as the third argument if it isn't `firstmic-e2e`.

**`api-smoke.mjs`** checks:

- Google sign-in: a token issued to another app, an unverified email and the old password sign-up are all refused
- the public class list on the home page
- class and topic management, topic ordering and hiding
- the class link (and the 404 after a new link is made)
- episode creation
- a send becoming version 1, then a replacement becoming version 2; version 1 stays in the history without audio
- feedback: the teacher writes and edits a comment on the current version only; the student sees it
- **a failed replacement leaving version 2 current and playable, with its feedback**
- a replacement of the commented version 2: it keeps its audio and comment, the student plays it under Past Feedback,
  and its comment can no longer change
- a newer take refusing late uploads to an unfinished one
- a new PIN signing the student out on every device, upload tokens included, while their recordings stay
- that a student token can't reach teacher routes or another student's episode
- teacher playback with seeking, the download filename, and deletion

**`solo-e2e.mjs`** drives Chromium with a fake microphone playing a 440 Hz tone:

1. The teacher clicks **Sign In** on the home page, creates a class and topics, and copies the class link.
2. The student taps the class on the home page, enters a name, picks a topic, records, stops and listens back.
3. Try Again works.
4. The take survives a page reload.
5. A Send the server refuses keeps the recording, and Send again works.
6. The teacher sees version 1, plays it and downloads it.
7. The 10-second auto-stop fires, and the teacher still has version 1 until the replacement is sent.
8. Version 2 replaces version 1.
9. The teacher saves a comment on version 2 and the student sees it.
10. The student sends version 3. The teacher's history keeps version 2 with its audio and comment, version 1 without
    audio, and the student plays version 2 under **Past Feedback**.
11. The student screens fit iPhone 13 and Pixel 7 sizes without sideways scrolling.

To check that the sent audio holds the tone:

```bash
docker cp e2e/out/v2.mp3 firstmic-e2e:/tmp/v2.mp3
docker exec firstmic-e2e ffmpeg -nostats -i /tmp/v2.mp3 -af "bandpass=f=440:width_type=q:w=20,volumedetect" -f null - 2>&1 | grep mean_volume
```

**`group-smoke.mjs`** checks:

- creating a group gives a 6-digit PIN; creating again returns the same group
- a partner joins with the PIN; a third student is refused because the group is full; a wrong PIN, or a PIN from
  another class, fails
- joining a friend's group drops your own group for that topic if nobody joined it
- group tokens can't reach solo or teacher routes, and a solo token can't join a live call
- Record needs both students in the call; only the student who tapped Record can Stop, Send or Try Again, unless they
  leave the call
- the mix has both voices (440 Hz and 660 Hz test tones), and each voice file has only its own tone
- a take whose voice can't be processed fails, and the sent version stays playable; a new Send replaces it, and the
  replaced version keeps no files
- feedback on the current take reaches both partners at once; replacing that take keeps its mix and both voices for
  the teacher, and both partners can play its mix (only) under Past Feedback
- the server stops a take at the time limit
- a new PIN closes the student's live call; removing a student deletes their group and its files

**`group-e2e.mjs`** drives two Chromium browsers. Ali's fake microphone plays a 440 Hz tone and Sara's a 660 Hz tone.

1. Ali picks a topic, chooses **With a Partner** and sees a group PIN.
2. Sara joins with the PIN; a wrong PIN is refused. They hear each other live: each page measures the partner's tone
   from the call.
3. Omar types the PIN and is told the group is full.
4. Ali taps Record and controls the take; Sara sees "Ali is in charge". After Stop, both play the mix; only Ali has
   Send.
5. Sara reloads and comes back to the same take.
6. Try Again clears it on both phones.
7. Sara records and sends; both phones show **Sent!**
8. The teacher plays the mix and downloads the mix and both voices; the tones are checked with ffmpeg.
9. A take stops at the 10-second limit, and sending it makes version 2.
10. The teacher comments on version 2, and both phones show it without reloading.
11. Ali records and sends version 3. Both phones list version 2 under **Past Feedback**, Sara plays it, and the
    teacher's history keeps its mix and both voices.

Chrome's noise suppression treats a steady test tone as noise and can turn it down by about 20 dB. That's why the
test only checks that each tone is well above silence.

## Manual solo test on real devices

Do this after every deployment. It covers what the automated tests can't: real microphones, iPhone Safari,
Android Chrome and real networks. Use the deployed HTTPS site. The microphone doesn't work over plain `http://` except on `localhost`.

**Teacher, on a laptop:**

1. Open `https://<domain>`, click **Sign In** (top right) and pick your Google account.
2. Create a class, for example "Test class", add two topics and a test student (note the PIN).
3. Open the home page and check "Test class" is listed.

**Student, on each phone (iPhone Safari, then Android Chrome), on mobile data if possible:**

1. Open `https://<domain>`, tap "Test class", tap your test student's name, type their PIN, then tap **Next**.
2. Pick a topic. The record screen shows the topic, a big **Record** button and the 3:00 limit.
3. Tap **Record**. Allow the microphone when the phone asks.
   - **Expected:** the timer counts up in red, with "Recording".
4. Speak for about 20 seconds, then tap **Stop**.
   - **Expected:** an audio player plus **Send** and **Try Again**, and a tip to talk for at least 2 minutes.
5. Play it back. **Expected:** you hear yourself.
6. Tap **Try Again**. **Expected:** back to **Record**, with no player.
7. Record again for about 30 seconds, tap **Stop**, then turn on airplane mode and tap **Send**.
   - **Expected:** within about 5 minutes, "Couldn't send. Your recording is safe on this device."
8. Turn airplane mode off and tap **Send**. **Expected:** "Sending… %", then **Sent!**
9. On the laptop, reload the class page.
   - **Expected:** one recording under that name and topic, with the right length.
   - It plays in the browser, and **Download** saves an MP3 that plays.
10. On the phone, tap **Try Again**.
    - **Expected:** "Your sent recording stays with your teacher until you send a new one."
    - On the laptop, the first recording still plays.
11. Tap **Record** and let it run past 3:00. **Expected:** it stops on its own at 3:00 with "Time's up!".
12. Tap **Send**, then reload the laptop.
    - **Expected:** the recording is replaced, shows 3:00 and "sent 2 times", and plays the new take.
13. Close the browser tab, reopen the class link and pick the same topic.
    - **Expected:** **Sent!** with **Try Again**, so the name and episode were remembered.
14. On the laptop, type a comment on the recording and click **Save Feedback**. On the phone, reopen the topic.
    - **Expected:** **Teacher Feedback** shows the comment.
15. Tap **Try Again**, record and **Send**, then reload the laptop.
    - **Expected:** the phone lists the comment under **Past Feedback** and **Listen** plays the older recording.
    - The laptop's **Earlier versions** shows that version with its comment and audio.
16. Tap **Change topic**, then **Not you?**. **Expected:** the name question again.

**Other cases worth a minute each:**

- **Lock the phone while recording.** Expected: recording stops, and the take recorded so far is there to listen to and send.
- **Block the microphone** in the browser's site settings, then tap Record. Expected: a message explaining how to turn
  it back on.
- **Teacher clicks New Link.** Expected: the old class link shows "This link doesn't work".
- **Teacher clicks Delete** on a recording. Expected: it disappears. The student's next Send starts a fresh episode.

## Manual two-person test on real devices

Use two phones (an iPhone and an Android phone if you can), ideally on different networks, for example one on school
Wi-Fi and one on mobile data. Wear headphones.

1. On both phones, sign in as two different test students in the same class.
2. Phone A: pick a topic, tap **With a Partner**, allow the microphone. **Expected:** a 6-digit group PIN.
3. Phone B: tap **Join a Partner**, type the PIN, allow the microphone.
   - **Expected:** both names show with green dots, and "You can hear …" appears.
   - Talk: each phone should hear the other.
4. On a third device, sign in as another student and try the same PIN. **Expected:** "This group is full."
5. Phone A: tap **Record** and have a short conversation, about 30 seconds.
   - **Expected:** phone B shows "… is in charge" and has no Stop button.
6. Phone A: tap **Stop**.
   - **Expected:** "Putting your voices together…", then a player on both phones.
   - Play it on both: it should have both voices, in sync.
7. Phone A: tap **Try Again**, then record again and tap **Send**.
   - **Expected:** **Sent!** on both phones.
8. On the laptop, reload the class page.
   - **Expected:** one recording, "Together", with both names.
   - The mix plays. **Download Mix** and each student's **Voice** button download MP3s that play.
9. Record once more and let it run to 3:00. **Expected:** it stops on its own on both phones.
10. Close the tab on phone A while phone B is listening to a take.
    - **Expected:** phone B gets Send and Try Again, because control passes to the student who is still there.
11. On the laptop, save a comment on the group's recording.
    - **Expected:** both phones show **Teacher Feedback** without reloading.
12. Record and send a new take. On phone B, tap **Listen** under **Past Feedback** while connected to phone A.
    - **Expected:** the old mix plays, and phone A does not hear it through phone B's microphone.

If the call never connects ("Connecting you to …" doesn't go away) on some network, that network needs a TURN relay.
See `ICE_SERVERS` in `.env.example`.

## Not covered yet

- Real iPhone Safari and Android Chrome have not been tested automatically. Playwright's WebKit on Windows has no
  `MediaRecorder` or working live call, so it only checks layout. Use the manual tests above.
- Live calls across real networks (NAT, school firewalls, mobile data) have not been tested. The automated test runs
  both browsers on one machine.
- Recovery after a server restart in the middle of processing a submission (`resumeInterruptedTracks` and
  `resumeSettledSubmissions`) runs at
  startup but has no automated test.
