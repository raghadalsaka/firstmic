# Testing First Mic (phase one: solo)

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
node api-smoke.mjs      # 18 API steps
node solo-e2e.mjs       # 12 browser steps, screenshots in e2e/out/
node webkit-layout.mjs  # Safari-engine layout of the home page and student screens

docker rm -f firstmic-e2e
```

`FIRSTMIC_MAX_SECONDS=10` keeps the auto-stop test short.

The tests never talk to Google:
- Each script starts `e2e/fake-google.mjs` on port 18199, which stands in for Google's token-check endpoints. The
  container points at it through `GOOGLE_TOKENINFO_URL` and `GOOGLE_USERINFO_URL`.
- The browser test replaces Google's sign-in script with a stub that "picks" a test account.

Use a fresh container for each run of `api-smoke.mjs`, because it signs in with a fixed email.

**`api-smoke.mjs`** checks:

- Google sign-in: a token issued to another app, an unverified email and the old password sign-up are all refused
- the public class list on the home page
- class and topic management, topic ordering and hiding
- the class link (and the 404 after a new link is made)
- episode creation
- a send becoming version 1, then a replacement becoming version 2
- **a failed replacement leaving version 2 current and playable**
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
9. The student screens fit iPhone 13 and Pixel 7 sizes without sideways scrolling.

To check that the sent audio holds the tone:

```bash
docker cp e2e/out/v2.mp3 firstmic-e2e:/tmp/v2.mp3
docker exec firstmic-e2e ffmpeg -nostats -i /tmp/v2.mp3 -af "bandpass=f=440:width_type=q:w=20,volumedetect" -f null - 2>&1 | grep mean_volume
```

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
14. Tap **Change topic**, then **Not you?**. **Expected:** the name question again.

**Other cases worth a minute each:**

- **Lock the phone while recording.** Expected: recording stops, and the take recorded so far is there to listen to and send.
- **Block the microphone** in the browser's site settings, then tap Record. Expected: a message explaining how to turn
  it back on.
- **Teacher clicks New Link.** Expected: the old class link shows "This link doesn't work".
- **Teacher clicks Delete** on a recording. Expected: it disappears. The student's next Send starts a fresh episode.

## Not covered yet

- Real iPhone Safari and Android Chrome have not been tested automatically. Playwright's WebKit on Windows has no
  `MediaRecorder`, so it only checks layout. Use the manual test above.
- Recovery after a server restart in the middle of processing a submission (`resumeInterruptedTracks` and
  `resumeSettledSubmissions`) runs at
  startup but has no automated test.
