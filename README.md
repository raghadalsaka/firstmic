# First Mic

A private podcast app for classrooms. It should feel like sending a voice message:

**Student:** open the site and tap your class (or open its link) → tap your name and type the 6-digit PIN from the teacher → pick a topic → **Record** → **Stop** → listen → **Save** (or **Try Again**).
Recordings stop automatically at 3 minutes; there is no minimum. Every saved recording goes into the student's
**My Recordings** list, on any topic, alone or with a partner. From there the student listens, deletes the ones they
don't want, and taps **Submit to Teacher** on the one they like best. Each student submits one recording for the class
and can change it until the class deadline; the submitted one is marked **✓ Submitted**.

**Teacher:** sign in with Google (top right of the home page) to a private dashboard to create a class, manage its
topics and students, copy the class link, and set a **submission deadline**. After the deadline students can still
record, but can't submit or change their submission. The dashboard lists each student's submitted recording, to play or
download as an MP3, and who hasn't submitted yet.

**Two-person podcasts:** after picking a topic, a student chooses **With a Partner** and gets a 6-digit group PIN
to share (there is no invite link). A classmate taps **Join a Partner** and types it; once two students are in, the
group is full. They talk live and use Record → Stop → Listen with Try Again and the 3-minute limit. Whoever taps
Record controls that take (Stop, Save for Both, Try Again); if they drop off, their partner takes over. Each phone
records only its own microphone, the server lines the two voices up and mixes them, and both students listen to the
mix. **Save for Both** puts a copy of the mix in each student's My Recordings; the group submits nothing itself, and
each student decides whether to submit their copy.

## How it works

- **Backend:** Fastify 5, SQLite and ffmpeg (`server/`). Classes, topics, student episodes and submissions live in
  `server/src/routes/student.ts`, `server/src/routes/classes.ts` and `server/src/jobs/submissions.ts`.
- **Frontend:** Vue 3, TypeScript, Vite and Tailwind CSS 4, with the same look as QuizRush (`web/`).
- **Recording:** the browser records with `MediaRecorder` in 3-second chunks. Each chunk is saved to IndexedDB on the
  device, so a reload doesn't lose a take. On **Send**, a resumable chunk upload sends the take, and the
  server assembles it with ffmpeg into one private MP3 (mono, 128 kbps, capped at the time limit).
- **Two-person podcasts:** the live call is a WebRTC peer-to-peer connection, using Tributary's signalling, "perfect
  negotiation" and clock sync (`web/src/group/`, `server/src/routes/group.ts`). Each voice uploads after Stop through
  the same resumable chunk upload, and `server/src/jobs/group-takes.ts` mixes them with ffmpeg once both arrive. If a
  voice hasn't arrived within `FIRSTMIC_GROUP_UPLOAD_MINUTES` (5), the take fails and the group records again. The
  call uses public STUN servers; some school or mobile networks need a TURN relay, set with `ICE_SERVERS`.
- **Privacy:** no student emails or passwords: the teacher adds each student (name, emoji, optional photo) with a 6-digit PIN. Recordings are served only to signed-in
  teachers of that class. The home page lists every class and each class page lists its students (names, emoji,
  photos), but recording needs the student's PIN, and only the class's teachers can hear recordings.
- **Teacher sign-in:** Google, the same way and with the same OAuth client as QuestRush (`VITE_GOOGLE_CLIENT_ID`). The browser gets a Google access token and the server checks it with
  Google (issued to this app's client ID, verified email) before creating the session. Any Google account can sign in.

## Development

Requires Node 22.12+, pnpm 10 (`npx pnpm@10.12.1 …` works without installing it), and ffmpeg/ffprobe on PATH.

```bash
pnpm install
VITE_GOOGLE_CLIENT_ID=<QuestRush client id> pnpm dev   # API on :4100, web on :4110 (proxies /api and /ws)
pnpm check                              # server typecheck + web type-check, lint, unit tests
pnpm build && pnpm start                # production-style single process on :4100
```

On Windows, set `VITE_GOOGLE_CLIENT_ID` with `$env:VITE_GOOGLE_CLIENT_ID="<QuestRush client id>"` (PowerShell) first, or use Docker
(see [docs/TESTING.md](docs/TESTING.md)).

- Deploying to DigitalOcean: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- Testing the solo and two-person flows (automated and by hand): [docs/TESTING.md](docs/TESTING.md)

## License

MIT, see [LICENSE](LICENSE). The fonts in `web/src/assets/fonts` are under the SIL Open Font License (license files
alongside).
