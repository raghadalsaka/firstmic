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
node api-smoke.mjs      # 23 API steps
node solo-e2e.mjs       # 19 browser steps, screenshots in e2e/out/
node webkit-layout.mjs  # Safari-engine layout of the home page and student screens
node group-smoke.mjs    # 15 API steps for two-person podcasts, with two live-call connections
node group-e2e.mjs      # 9 browser steps: two browsers, each with its own fake microphone

docker rm -f firstmic-e2e
```

`FIRSTMIC_MAX_SECONDS=10` keeps the auto-stop test short.

The tests never talk to Google:
- Each script starts `e2e/fake-google.mjs` on port 18199, which stands in for Google's token-check endpoints. The
  container points at it through `GOOGLE_TOKENINFO_URL` and `GOOGLE_USERINFO_URL`.
- The browser test replaces Google's sign-in script with a stub that "picks" a test account.

Use a fresh container for each run of `api-smoke.mjs`, because it signs in with a fixed email.
`group-smoke.mjs` and `group-e2e.mjs` check audio inside the container with `docker exec`, and `api-smoke.mjs` checks
that deleted files are gone, so pass the container name (the third argument; the fourth for `api-smoke.mjs`) if it
isn't `firstmic-e2e`.

**`api-smoke.mjs`** checks:

- Google sign-in: a token issued to another app, an unverified email and the old password sign-up are all refused
- the public class list on the home page
- class and topic management, topic ordering and hiding
- the Podcast Guide: saved with a topic, edited, cleared with empty boxes, line breaks kept, and too-long text refused
- the class link (and the 404 after a new link is made)
- episode creation
- Save puts a recording in My Recordings without submitting it; Submit hands it to the teacher
- a second recording is saved next to the first, and submitting it changes what the teacher has
- **a failed save adds nothing and leaves the submission alone**
- a student deletes a recording they didn't submit, but not the submitted one
- after the class deadline students can still save but not submit; a later deadline opens it again
- a newer take refusing late uploads to an unfinished one
- one student can't see, submit, delete or upload into another student's recordings
- a new PIN signing the student out on every device, upload tokens included, while their recordings stay
- teacher playback with seeking, the download filename, and deleting a submission, a student or a topic
- deleting the class: another teacher can't; afterwards its link, recordings and sign-ins are gone and its MP3 and
  recording files are removed from disk

**`solo-e2e.mjs`** drives Chromium with a fake microphone playing a 440 Hz tone:

1. Signed out, the home page and teacher pages show no sign-in. The teacher opens `/teacher/sign-in`, clicks
   **Sign In with Google**, creates a class and topics, and copies the class link.
2. The student taps the class on the home page, enters a name, picks a topic, records, stops and listens back.
3. Try Again works.
4. The take survives a page reload.
5. A Save the server refuses keeps the recording; Save again opens **My Recordings**, and the teacher has nothing yet.
6. The student plays it in My Recordings and taps **Submit to Teacher**.
7. The teacher sees the submission and who hasn't submitted, plays it and downloads it.
8. A second topic recorded until the 10-second auto-stop is saved next to the first, which stays submitted.
9. The teacher sets a deadline in the past: the student's Submit buttons disappear. Without a deadline the student
   submits the second topic and deletes the first.
10. The teacher adds "My Winter Style" with all four Podcast Guide sections, edits it (a line break is kept) and adds
    a Partner Guide to an older topic.
11. At 320x568 the student sees no guide button on a topic without a guide, and none on the solo record screen of a
    topic with only a Partner Guide. Teacher text shows as plain text. The guide starts collapsed on each screen; the
    choose screen shows all four sections and the solo record screen shows the prompt, Solo Guide and Language Challenge.
12. While recording, the student opens and closes the guide six times. The timer keeps counting, the timer and Stop
    stay on screen, and the take stops, plays, saves and is submitted.
13. The teacher clears a guide and its button disappears for the student.
14. At 375x667 with the guide open, Record, Stop and the timer are fully on screen.
15. The student screens fit iPhone 13 and Pixel 7 sizes without sideways scrolling.
16. The teacher taps **Delete Class**: Cancel keeps it; OK goes back to the class list without it, and its recordings
    are gone.

To check that the sent audio holds the tone:

```bash
docker cp e2e/out/v1.mp3 firstmic-e2e:/tmp/v1.mp3
docker exec firstmic-e2e ffmpeg -nostats -i /tmp/v1.mp3 -af "bandpass=f=440:width_type=q:w=20,volumedetect" -f null - 2>&1 | grep mean_volume
```

**`group-smoke.mjs`** checks:

- creating a group gives a 6-digit PIN; creating again returns the same group
- a partner joins with the PIN and gets the topic's Podcast Guide in the group data; a third student is refused because the group is full; a wrong PIN, or a PIN from
  another class, fails
- joining a friend's group drops your own group for that topic if nobody joined it
- group tokens can't reach solo or teacher routes, and a solo token can't join a live call
- Record needs both students in the call; only the student who tapped Record can Stop, Save for Both or Try Again,
  unless they leave the call
- the mix has both voices (440 Hz and 660 Hz test tones)
- Save for Both puts a copy of the mix in each member's My Recordings (with the partner's name) and submits nothing
- one student submits their copy (the teacher gets it) while the other deletes theirs; a student can't reach another's
  copy
- a take whose voice can't be processed fails and saves nothing; a new save adds another copy for both, and the
  submission only changes when the student submits the new one
- the server stops a take at the time limit
- a new PIN closes the student's live call; removing a student deletes their group and its files

**`group-e2e.mjs`** drives two Chromium browsers. Ali's fake microphone plays a 440 Hz tone and Sara's a 660 Hz tone.

1. Ali picks a topic and opens the Podcast Guide (all four sections), chooses **With a Partner** and sees a group
   PIN. The guide on the partner screen starts collapsed and shows the prompt, Partner Guide and Language Challenge.
2. Sara joins with the PIN; a wrong PIN is refused. They hear each other live: each page measures the partner's tone
   from the call.
3. Omar types the PIN and is told the group is full. (Sara, who joined by PIN, opens the same partner guide in step 2.)
4. Ali taps Record and controls the take; Sara sees "Ali is in charge". Both open and close the guide while
   recording: both timers keep counting and Sara still hears Ali's tone. After Stop, both play the mix; only Ali has
   Save for Both.
5. Sara reloads and comes back to the same take.
6. Try Again clears it on both phones.
7. Sara records and taps **Save for Both**; both phones show **Saved!**
8. Sara opens **My Recordings** and submits her copy ("With Ali"). The teacher plays and downloads it; the tones are
   checked with ffmpeg. Ali hasn't submitted, so the teacher lists him under "Not submitted yet".
9. A take stops at the 10-second limit; Ali saves it, finds both saves in My Recordings and submits one, and the
   teacher has both students.

Chrome's noise suppression treats a steady test tone as noise and can turn it down by about 20 dB. That's why the
test only checks that each tone is well above silence.

## Manual solo test on real devices

Do this after every deployment. It covers what the automated tests can't: real microphones, iPhone Safari,
Android Chrome and real networks. Use the deployed HTTPS site. The microphone doesn't work over plain `http://` except on `localhost`.

**Teacher, on a laptop:**

1. Open `https://<domain>/teacher/sign-in`, click **Sign In with Google** and pick your Google account.
2. Create a class, for example "Test class", add two topics and a test student (note the PIN). Give one topic a
   Podcast Guide with all four sections, using line breaks.
3. Open the home page and check "Test class" is listed.

**Student, on each phone (iPhone Safari, then Android Chrome), on mobile data if possible:**

1. Open `https://<domain>`, tap "Test class", tap your test student's name, type their PIN, then tap **Next**.
2. Pick the topic with the guide. Tap **View Podcast Guide**: all four sections show, with your line breaks; tap
   **Hide Podcast Guide**. Tap **On My Own**. The record screen shows the topic, a big **Record** button and the
   3:00 limit.
3. Open the guide (prompt, Solo Guide, Language Challenge only), then tap **Record**. Allow the microphone when the
   phone asks.
   - **Expected:** the timer counts up in red, with an **On Air** badge. Close and open the guide a few times: the
     timer keeps counting, and the timer and **Stop** stay on screen.
4. Speak for about 20 seconds, then tap **Stop**.
   - **Expected:** an audio player plus **Save** and **Try Again**, and a tip to talk for at least 2 minutes.
5. Play it back. **Expected:** you hear yourself.
6. Tap **Try Again**. **Expected:** back to **Record**, with no player.
7. Record again for about 30 seconds, tap **Stop**, then turn on airplane mode and tap **Save**.
   - **Expected:** within about 5 minutes, "Couldn't save. Your recording is safe on this device."
8. Turn airplane mode off and tap **Save**. **Expected:** "Saving… %", then **My Recordings** with the recording and
   "You haven't submitted a recording yet."
9. Tap **Listen**, then **Submit to Teacher**. **Expected:** **✓ Submitted** on it.
10. On the laptop, reload the class page.
    - **Expected:** one submission under that name and topic, with the right length; the other test students are
      under "Not submitted yet".
    - It plays in the browser, and **Download** saves an MP3 that plays.
11. On the phone, tap **Record Another**, pick the other topic, tap **Record** and let it run past 3:00.
    **Expected:** it stops on its own at 3:00 with "Time's up!". Tap **Save**.
    - **Expected:** My Recordings shows both; the first is still submitted, and the laptop still has the first.
12. On the laptop, set the deadline to a minute ago. On the phone, reopen My Recordings.
    - **Expected:** "…so your submission can't change now", and no Submit buttons.
13. Remove the deadline. On the phone, submit the second recording, then delete the first.
    - **Expected:** the laptop shows the second topic; My Recordings shows only the second.
14. Tap **Record Another**, then **Not you?**. **Expected:** the name question again.

**Other cases worth a minute each:**

- **Lock the phone while recording.** Expected: recording stops, and the take recorded so far is there to listen to and save.
- **Block the microphone** in the browser's site settings, then tap Record. Expected: a message explaining how to turn
  it back on.
- **Teacher clicks New Link.** Expected: the old class link shows "This link doesn't work".
- **Teacher clicks Delete** on a submission. Expected: it disappears from the dashboard and from the student's My
  Recordings, and the student can submit another.
- **Teacher clicks Delete Class** (do this last, on a test class). Expected: back to the class list without it; the
  class is gone from the home page and its link shows "not found" on the phone.

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
7. Phone A: tap **Try Again**, then record again and tap **Save for Both**.
   - **Expected:** **Saved!** on both phones. The laptop's class page has no submission yet.
8. Phone A: tap **My Recordings**, listen, then **Submit to Teacher**. Phone B: tap **My Recordings** and delete it.
   - **Expected:** the laptop shows phone A's student with the podcast ("with …", both voices); phone B's student is
     under "Not submitted yet".
   - It plays, and **Download** saves an MP3 that plays.
9. Record once more and let it run to 3:00. **Expected:** it stops on its own on both phones.
10. Close the tab on phone A while phone B is listening to a take.
    - **Expected:** phone B gets Save for Both and Try Again, because control passes to the student who is still
      there.

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
