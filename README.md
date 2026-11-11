# First Mic

A private podcast app for Grade 6. It should feel like sending a voice message:

**Student:** open the site and tap your class (or open its link) → tap your name and type the 6-digit PIN from the teacher → pick a topic → **Record** → **Stop** → listen → **Send** (or **Try Again**).
Recordings stop automatically at 3 minutes; there is no minimum. A student can record again and send a
replacement at any time. The previous recording stays with the teacher until the new one has been sent successfully.

**Teacher:** sign in with Google (top right of the home page) to a private dashboard to create a class, manage its topics, copy the class link, and play or download
every student's latest recording as an MP3.

Phase one (this version) is **solo episodes only**. Group rooms, group invites, live calls and audio mixing are
phase two.

## How it works

- **Backend:** Fastify 5, SQLite and ffmpeg (`server/`). Classes, topics, student episodes and submissions live in
  `server/src/routes/student.ts`, `server/src/routes/classes.ts` and `server/src/jobs/submissions.ts`.
- **Frontend:** Vue 3, TypeScript, Vite and Tailwind CSS 4, with the same look as QuizRush (`web/`).
- **Recording:** the browser records with `MediaRecorder` in 3-second chunks. Each chunk is saved to IndexedDB on the
  device, so a reload doesn't lose a take. On **Send**, a resumable chunk upload sends the take, and the
  server assembles it with ffmpeg into one private MP3 (mono, 128 kbps, capped at the time limit).
- **Privacy:** no student emails or passwords: the teacher adds each student (name, emoji, optional photo) with a 6-digit PIN. Recordings are served only to signed-in
  teachers of that class. The home page lists every class and each class page lists its students (names, emoji,
  photos), but recording needs the student's PIN, and only the class's teachers can hear recordings.
- **Teacher sign-in:** Google, the same way and with the same OAuth client as QuestRush (`VITE_GOOGLE_CLIENT_ID`). The browser gets a Google access token and the server checks it with
  Google (issued to this app's client ID, verified email) before creating the session. Any Google account can sign in.

## Development

Requires Node 22.12+, pnpm 10 (`npx pnpm@10.12.1 …` works without installing it), and ffmpeg/ffprobe on PATH.

```bash
pnpm install
VITE_GOOGLE_CLIENT_ID=<QuestRush client id> pnpm dev   # API on :4100, web on :4110 (proxies /api)
pnpm check                              # server typecheck + web type-check, lint, unit tests
pnpm build && pnpm start                # production-style single process on :4100
```

On Windows, set `VITE_GOOGLE_CLIENT_ID` with `$env:VITE_GOOGLE_CLIENT_ID="<QuestRush client id>"` (PowerShell) first, or use Docker
(see [docs/TESTING.md](docs/TESTING.md)).

- Deploying to DigitalOcean: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- Testing a full solo flow (automated and by hand): [docs/TESTING.md](docs/TESTING.md)

## License

MIT, see [LICENSE](LICENSE). The fonts in `web/src/assets/fonts` are under the SIL Open Font License (license files
alongside).
