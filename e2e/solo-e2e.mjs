// Full solo browser E2E. Usage: node solo-e2e.mjs <baseUrl> <fakeGooglePort> <toneWav> <outDir>
// Expects the server to run with FIRSTMIC_MAX_SECONDS=10 and the fake Google endpoints (see fake-google.mjs).
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium, devices } from 'playwright'
import { gisStub, startFakeGoogle } from './fake-google.mjs'
import { clockSeconds, guideButton, shownSections, toggleGuide } from './guide-helpers.mjs'

const [base = 'http://localhost:18101', googlePort = '18199', toneWav = './media/tone440.wav', outDir = './out'] =
  process.argv.slice(2)
const fakeGoogle = await startFakeGoogle(Number(googlePort))
fs.mkdirSync(outDir, { recursive: true })
let n = 0
const ok = (msg) => console.log(`ok ${++n} - ${msg}`)
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true })

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.resolve(toneWav)}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
})

// ---- Teacher signs in with Google from the sign-in link and sets up a class ----
const teacherCtx = await browser.newContext()
await teacherCtx.route('https://accounts.google.com/gsi/client', (route) =>
  route.fulfill({ contentType: 'text/javascript', body: gisStub(`raghad${Date.now()}@example.com`) }),
)
const teacher = await teacherCtx.newPage()
// Signed out, the home page has no sign-in, and teacher pages go to the home page instead of a sign-in screen
for (const path of ['/', '/teacher', '/teacher/classes/not-a-class']) {
  await teacher.goto(`${base}${path}`)
  await teacher.waitForURL(`${base}/`)
  await teacher.getByRole('heading', { name: 'Pick your class' }).waitFor()
  assert.equal(await teacher.getByRole('button', { name: /Sign In/ }).count(), 0, `${path}: no sign-in button`)
  assert.equal(await teacher.getByText('Teacher sign in').count(), 0, `${path}: no sign-in screen`)
}
await shot(teacher, 'home-signed-out')
await teacher.goto(`${base}/teacher/sign-in`)
await teacher.getByRole('heading', { name: 'Teacher sign in' }).waitFor()
await shot(teacher, 'login-screen')
await teacher.getByRole('button', { name: 'Sign In with Google' }).click()
await teacher.waitForURL(`${base}/`)
await teacher.getByRole('heading', { name: 'Your classes' }).waitFor()
await teacher.getByRole('button', { name: 'Sign Out' }).waitFor()
assert.equal(teacher.url(), `${base}/`)
await teacher.getByLabel('New class').fill('Room 12B')
await teacher.getByRole('button', { name: 'Create Class' }).click()
await teacher.waitForURL('**/teacher/classes/*')
for (const title of ['My favourite animal', 'A day at school']) {
  await teacher.getByLabel('New topic').fill(title)
  await teacher.getByRole('button', { name: 'Add Topic' }).click()
  await teacher.locator('li span', { hasText: title }).first().waitFor()
}
// Two students: Ali with a PIN the teacher types, Sara with one First Mic makes
const ALI_PIN = '123456'
await teacher.getByRole('button', { name: 'Add Student' }).click()
await teacher.getByLabel('Name').fill('Ali')
await teacher.getByLabel('PIN').fill(ALI_PIN)
await teacher.getByRole('button', { name: 'Add Student' }).last().click()
await teacher.getByTestId('student-row').filter({ hasText: 'Ali' }).waitFor()
await teacher.getByRole('button', { name: 'Add Student' }).click()
await teacher.getByLabel('Name').fill('Sara')
await teacher.getByRole('button', { name: 'Add Student' }).last().click()
const saraRow = teacher.getByTestId('student-row').filter({ hasText: 'Sara' })
await saraRow.waitFor()
const saraPin = (await saraRow.innerText()).match(/\d{6}/)?.[0]
assert.ok(saraPin, 'Sara got a 6-digit PIN')
assert.match(await teacher.getByTestId('student-row').filter({ hasText: 'Ali' }).innerText(), new RegExp(ALI_PIN))
const classLink = await teacher.getByLabel('Class link').inputValue()
assert.match(classLink, /\/c\/[a-z0-9]{32}\/room-12b$/)
const bareLink = classLink.replace(/\/room-12b$/, '')
await shot(teacher, 'teacher-class-roster')
const canonicalCheck = await teacherCtx.newPage()
await canonicalCheck.goto(bareLink)
await canonicalCheck.getByRole('heading', { name: 'Who are you?' }).waitFor()
assert.equal(canonicalCheck.url(), classLink)
await canonicalCheck.close()
ok('teacher signs in with Google, creates a class, two topics and two students (typed and generated PIN)')

// ---- Student: home page, class, name, topic, record, listen, try again, record, send ----
const studentCtx = await browser.newContext({ ...devices['Pixel 7'], permissions: ['microphone'] })
const student = await studentCtx.newPage()
student.on('console', (m) => m.type() === 'error' && console.log('  [student console]', m.text()))
await student.goto(base)
await shot(student, 'student-0-home')
await student.locator(`a[href="${new URL(classLink).pathname}"]`).click()
await student.getByRole('heading', { name: 'Who are you?' }).waitFor()
assert.equal(student.url(), classLink)
await shot(student, 'student-1-names')
await student.getByRole('button', { name: 'Ali' }).click()
await student.getByLabel('Type your PIN').fill('999999')
await student.getByRole('button', { name: 'Next' }).click()
await student.getByText("That PIN isn't right. Try again.").waitFor()
await shot(student, 'student-1b-wrong-pin')
await student.getByLabel('Type your PIN').fill(ALI_PIN)
await student.getByRole('button', { name: 'Next' }).click()
await student.getByText('Hi Ali! Pick a topic').waitFor()
await shot(student, 'student-2-topics')
await student.getByRole('button', { name: 'My favourite animal' }).click()
await student.getByRole('button', { name: 'On My Own' }).click()
await student.getByRole('button', { name: 'Record' }).waitFor()
await shot(student, 'student-3-ready')
ok('student picks the class, then their name; a wrong PIN is refused and the right one gets in')

async function recordFor(ms) {
  await student.getByRole('button', { name: 'Record' }).click()
  await student.getByRole('button', { name: 'Stop' }).waitFor()
  await student.waitForTimeout(ms)
}

await recordFor(3000)
await shot(student, 'student-4-recording')
const timerText = await student.getByRole('timer').innerText()
assert.match(timerText, /^0:0[2-4]/)
const onAir = student.getByTestId('on-air')
assert.equal((await onAir.innerText()).trim().toUpperCase(), 'ON AIR')
const timerBox = await student.getByRole('timer').boundingBox()
assert.ok((await onAir.boundingBox()).y > timerBox.y + timerBox.height - 1, 'On Air sits below the timer')
await student.getByRole('button', { name: 'Stop' }).click()
await student.getByRole('button', { name: 'Save' }).waitFor()
assert.equal(await onAir.count(), 0, 'On Air is gone after Stop')
ok('the On Air badge shows under the timer while recording and goes away on Stop')
await shot(student, 'student-5-recorded')
const played = await student.evaluate(async () => {
  const audio = document.querySelector('audio')
  await audio.play()
  await new Promise((r) => setTimeout(r, 800))
  const t = audio.currentTime
  audio.pause()
  return t
})
assert.ok(played > 0.3, `listen-back did not play (currentTime ${played})`)
ok(`record 3s, stop, listen back (played to ${played.toFixed(2)}s)`)

await student.getByRole('button', { name: 'Try Again' }).click()
await student.getByRole('button', { name: 'Record' }).waitFor()
assert.equal(await student.locator('audio').count(), 0)
ok('Try Again discards the take and returns to Record')

// The take survives a reload before Save
await recordFor(4000)
await student.getByRole('button', { name: 'Stop' }).click()
await student.getByRole('button', { name: 'Save' }).waitFor()
await student.reload()
await student.getByRole('button', { name: 'My favourite animal' }).click()
await student.getByRole('button', { name: 'On My Own' }).click()
await student.getByRole('button', { name: 'Save' }).waitFor()
ok('a stopped take is still there after a page reload')

// Save fails once (server refuses), take stays, second Save works and opens My Recordings
await student.route('**/api/student/submissions', (route) =>
  route.request().method() === 'POST' ? route.fulfill({ status: 503, body: '{}' }) : route.continue(),
)
await student.getByRole('button', { name: 'Save' }).click()
await student.getByText("Couldn't save. Your recording is safe on this device.").waitFor()
await shot(student, 'student-6-save-failed')
await student.unroute('**/api/student/submissions')
await student.getByRole('button', { name: 'Save' }).click()
const list = student.getByTestId('my-recordings')
await list.waitFor({ timeout: 60_000 })
const items = list.getByTestId('my-recording')
await items.first().waitFor()
assert.equal(await items.count(), 1)
assert.match(await items.first().innerText(), /My favourite animal[\s\S]*On your own/)
await student.getByText("You haven't submitted a recording yet.").waitFor()
await shot(student, 'student-7-my-recordings')
await teacher.reload()
await teacher.getByText('No submissions yet.').waitFor()
ok('a failed Save keeps the recording; saving again puts it in My Recordings, and the teacher has nothing yet')

await items.first().getByRole('button', { name: 'Listen' }).click()
await items.first().locator('audio').waitFor({ state: 'attached' })
const listPlayed = await student.evaluate(async () => {
  const audio = document.querySelector('[data-testid="my-recording"] audio')
  await audio.play()
  await new Promise((r) => setTimeout(r, 800))
  const t = audio.currentTime
  audio.pause()
  return t
})
assert.ok(listPlayed > 0.3, `My Recordings playback did not advance (${listPlayed})`)
await items.first().getByRole('button', { name: 'Submit to Teacher' }).click()
await items.first().getByText('✓ Submitted').waitFor()
await student.getByText('You submitted "My favourite animal" to your teacher.').waitFor()
await shot(student, 'student-8-submitted')
ok(`the student plays it in My Recordings (${listPlayed.toFixed(2)}s) and submits it`)

// ---- Teacher sees, plays and downloads it ----
await teacher.reload()
const rows = teacher.getByTestId('submission')
await rows.first().waitFor()
assert.equal(await rows.count(), 1)
const rowText = await rows.first().innerText()
assert.match(rowText, /Ali/)
assert.match(rowText, /My favourite animal/)
assert.match(await teacher.getByTestId('not-submitted').innerText(), /Sara/)
const v1Src = await rows.first().locator('audio').getAttribute('src')
const teacherPlayed = await teacher.evaluate(async () => {
  const audio = document.querySelector('[data-testid="submission"] audio')
  await audio.play()
  await new Promise((r) => setTimeout(r, 1000))
  const t = audio.currentTime
  audio.pause()
  return { t, duration: audio.duration }
})
assert.ok(teacherPlayed.t > 0.5, 'teacher playback did not advance')
const v1 = await teacherCtx.request.get(`${base}${v1Src}?download=1`)
assert.equal(v1.status(), 200)
assert.match(v1.headers()['content-disposition'], /Room-12B-My-favourite-animal-Ali-v1\.mp3/)
fs.writeFileSync(path.join(outDir, 'v1.mp3'), await v1.body())
await shot(teacher, 'teacher-class-v1')
ok(`teacher sees the submission and who hasn't submitted, plays it (${teacherPlayed.t.toFixed(2)}s of ${teacherPlayed.duration.toFixed(2)}s) and downloads it`)

// ---- A second topic, recorded until the 10s auto-stop, is saved next to the first ----
await student.getByRole('button', { name: 'Record Another' }).click()
await student.getByRole('button', { name: 'A day at school' }).click()
await student.getByRole('button', { name: 'On My Own' }).click()
await student.getByRole('button', { name: 'Record' }).click()
await student.getByText("Time's up!").waitFor({ timeout: 20_000 })
await shot(student, 'student-9-times-up')
const capped = await student.getByRole('timer').innerText()
assert.match(capped, /^0:(09|10)/)
await student.getByRole('button', { name: 'Save' }).click()
await list.waitFor({ timeout: 60_000 })
await items.nth(1).waitFor()
assert.equal(await items.count(), 2)
await student.getByText('You submitted "My favourite animal" to your teacher.').waitFor()
await teacher.reload()
await rows.first().waitFor()
assert.equal(await rows.first().locator('audio').getAttribute('src'), v1Src, 'the teacher still has the first one')
ok(`recording auto-stops at the 10s limit (timer ${capped.replace(/\s+/g, ' ')}); the new topic is saved next to the first, which stays submitted`)

// ---- The deadline locks submitting; removing it opens it again ----
const localInput = (ms) => {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
await teacher.getByLabel('Deadline').fill(localInput(Date.now() - 5 * 60_000))
await teacher.getByRole('button', { name: 'Set Deadline' }).click()
await teacher.getByText(/Closed on /).waitFor()
await shot(teacher, 'teacher-deadline-closed')
await student.getByRole('button', { name: 'Record Another' }).click()
await student.getByRole('button', { name: 'My Recordings' }).click()
await student.getByText(/so your submission can't change now/).waitFor()
assert.equal(await list.getByRole('button', { name: 'Submit to Teacher' }).count(), 0)
await shot(student, 'student-10-closed')
await teacher.getByRole('button', { name: 'Remove Deadline' }).click()
await teacher.getByText(/No deadline. Students can submit/).waitFor()
await student.getByRole('button', { name: 'Record Another' }).click()
await student.getByRole('button', { name: 'My Recordings' }).click()
const second = items.filter({ hasText: 'A day at school' })
await second.getByRole('button', { name: 'Submit to Teacher' }).click()
await second.getByText('✓ Submitted').waitFor()
await teacher.reload()
await rows.first().waitFor()
assert.match(await rows.first().innerText(), /A day at school/)
const v2Src = await rows.first().locator('audio').getAttribute('src')
assert.notEqual(v2Src, v1Src)
assert.equal((await teacherCtx.request.get(`${base}${v1Src}`)).status(), 404, 'the teacher only gets the submitted one')
const first = items.filter({ hasText: 'My favourite animal' })
student.once('dialog', (dialog) => void dialog.accept())
await first.getByRole('button', { name: 'Delete' }).click()
await first.waitFor({ state: 'detached' })
assert.equal(await items.count(), 1)
await shot(teacher, 'teacher-class-v2')
ok('after the deadline Submit is gone; without it the student submits the other topic and deletes the first')

// ---- Podcast Guide: the teacher saves, edits and clears it; a student opens it before and while recording ----
const WINTER = {
  prompt:
    'Describe an outfit you actually wore on a cold or rainy day. What did you put on before going outside? What did you take off when you came indoors? Why did you choose those clothes?',
  solo: 'Start with “My favourite thing to wear in winter is…” Then describe your outfit and tell us about the day you wore it.',
  partner:
    'Take turns describing what you wear in winter. Ask a follow-up question, such as “Why do you wear that?” Finish by sharing one similarity or difference in your winter styles.',
  language:
    'Use “put on” and “take off.” Try one sentence with “it” or “them.”\nFor example, “I put my gloves on before I left home. I took them off when I got to school.”',
}
const topicRow = (title) => teacher.locator('li', { hasText: title }).filter({ has: teacher.getByRole('button', { name: 'Edit' }) })
await teacher.getByLabel('New topic').fill('My Winter Style')
await teacher.getByText('Podcast Guide (optional)').click()
for (const key of ['prompt', 'solo', 'partner']) await teacher.getByTestId(`guide-input-${key}`).fill(WINTER[key])
await teacher.getByTestId('guide-input-language').fill(WINTER.language.split('\n')[0])
await shot(teacher, 'teacher-guide-add')
await teacher.getByRole('button', { name: 'Add Topic' }).click()
await topicRow('My Winter Style').getByText('Has a Podcast Guide').waitFor()
await teacher.reload()
await topicRow('My Winter Style').getByRole('button', { name: 'Edit' }).click()
for (const key of ['prompt', 'solo', 'partner']) assert.equal(await teacher.getByTestId(`guide-input-${key}`).inputValue(), WINTER[key])
await teacher.getByTestId('guide-input-language').fill(WINTER.language)
await teacher.getByRole('button', { name: 'Edit Topic' }).click()
await teacher.getByRole('button', { name: 'Add Topic' }).waitFor()
await teacher.reload()
await topicRow('My Winter Style').getByRole('button', { name: 'Edit' }).click()
assert.equal(await teacher.getByTestId('guide-input-language').inputValue(), WINTER.language, 'the edit keeps its line break')
await shot(teacher, 'teacher-guide-edit')
await teacher.getByRole('button', { name: 'Cancel' }).click()
await topicRow('A day at school').getByRole('button', { name: 'Edit' }).click()
await teacher.getByText('Podcast Guide (optional)').click()
await teacher.getByTestId('guide-input-partner').fill('<b>Ask</b> your partner one question.')
await teacher.getByRole('button', { name: 'Edit Topic' }).click()
await topicRow('A day at school').getByText('Has a Podcast Guide').waitFor()
assert.equal(await topicRow('My favourite animal').getByText('Has a Podcast Guide').count(), 0)
ok('the teacher adds a Podcast Guide to a new topic, edits it (line breaks kept) and adds a partner guide to an older topic')

const { defaultBrowserType: _se, ...iphoneSE } = devices['iPhone SE']
const guideCtx = await browser.newContext({ ...iphoneSE, permissions: ['microphone'] })
const sara = await guideCtx.newPage()
sara.on('console', (m) => m.type() === 'error' && console.log('  [sara console]', m.text()))
await sara.goto(classLink)
await sara.getByRole('button', { name: 'Sara' }).click()
await sara.getByLabel('Type your PIN').fill(saraPin)
await sara.getByRole('button', { name: 'Next' }).click()
const noSideScroll = async (label) => {
  const overflow = await sara.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 0, `${label}: horizontal overflow ${overflow}px`)
}

await sara.getByRole('button', { name: 'My favourite animal' }).click()
await sara.getByText('How do you want to record?').waitFor()
assert.equal(await guideButton(sara).count(), 0, 'no guide, no button when choosing')
await sara.getByRole('button', { name: 'On My Own' }).click()
await sara.getByRole('button', { name: 'Record' }).waitFor()
assert.equal(await guideButton(sara).count(), 0, 'no guide, no button when recording')
await sara.getByRole('button', { name: 'Change topic' }).click()

await sara.getByRole('button', { name: 'A day at school' }).click()
await toggleGuide(sara, true)
assert.deepEqual(await shownSections(sara), ['partner'])
assert.equal(await sara.getByTestId('guide-partner').locator('p').innerText(), '<b>Ask</b> your partner one question.')
assert.equal(await sara.getByTestId('podcast-guide').locator('b').count(), 0, 'teacher text is plain text')
await sara.getByRole('button', { name: 'On My Own' }).click()
await sara.getByRole('button', { name: 'Record' }).waitFor()
assert.equal(await guideButton(sara).count(), 0, 'a partner-only guide has nothing for the solo recording screen')
await sara.getByRole('button', { name: 'Change topic' }).click()

await sara.getByRole('button', { name: 'My Winter Style' }).click()
assert.equal(await guideButton(sara).getAttribute('aria-expanded'), 'false')
assert.deepEqual(await shownSections(sara), [], 'collapsed by default')
await toggleGuide(sara, true)
assert.deepEqual(await shownSections(sara), ['prompt', 'solo', 'partner', 'language'])
assert.equal(await sara.getByTestId('guide-language').locator('p').innerText(), WINTER.language)
await noSideScroll('choose with guide')
await shot(sara, 'guide-1-choose-open')
await toggleGuide(sara, false)
await sara.getByRole('button', { name: 'On My Own' }).click()
await sara.getByRole('button', { name: 'Record' }).waitFor()
assert.equal(await guideButton(sara).getAttribute('aria-expanded'), 'false', 'collapsed again on the recording screen')
await toggleGuide(sara, true)
assert.deepEqual(await shownSections(sara), ['prompt', 'solo', 'language'])
await noSideScroll('ready with guide')
await shot(sara, 'guide-2-ready-open')
ok('the guide button shows only where a screen has guidance, starts collapsed, and shows every section when choosing but only the solo ones when recording alone; teacher text stays plain text')

await sara.getByRole('button', { name: 'Record' }).click()
const stop = sara.getByRole('button', { name: 'Stop' })
await stop.waitFor()
const viewport = sara.viewportSize()
const ticks = []
for (let i = 0; i < 6; i++) {
  await sara.waitForTimeout(500)
  await toggleGuide(sara, i % 2 === 1)
  ticks.push(await clockSeconds(sara))
  const timerBox = await sara.getByRole('timer').boundingBox()
  const stopBox = await stop.boundingBox()
  assert.ok(timerBox.y >= 0 && timerBox.y + timerBox.height <= viewport.height, `the timer stays on screen (toggle ${i + 1})`)
  assert.ok(stopBox.y + stopBox.height / 2 <= viewport.height, `Stop stays reachable (toggle ${i + 1}): ${JSON.stringify(stopBox)}`)
  assert.equal(await sara.getByTestId('on-air').count(), 1, 'still recording')
}
assert.ok(ticks.every((t, i) => i === 0 || t >= ticks[i - 1]) && ticks.at(-1) - ticks[0] >= 2, `the timer kept running: ${ticks}`)
const stopBox = await stop.boundingBox()
await noSideScroll('recording with guide')
await shot(sara, 'guide-3-recording-open')
await stop.click()
await sara.getByRole('button', { name: 'Save' }).waitFor()
assert.ok((await clockSeconds(sara)) >= ticks.at(-1))
const guidePlayed = await sara.evaluate(async () => {
  const audio = document.querySelector('audio')
  await audio.play()
  await new Promise((r) => setTimeout(r, 800))
  const t = audio.currentTime
  audio.pause()
  return t
})
assert.ok(guidePlayed > 0.3, `listen-back did not play (currentTime ${guidePlayed})`)
await sara.getByRole('button', { name: 'Save' }).click()
const winterItem = sara.getByTestId('my-recording').filter({ hasText: 'My Winter Style' })
await winterItem.waitFor({ timeout: 60_000 })
await winterItem.getByRole('button', { name: 'Submit to Teacher' }).click()
await winterItem.getByText('✓ Submitted').waitFor()
await teacher.reload()
await rows.filter({ hasText: 'Sara' }).filter({ hasText: 'My Winter Style' }).waitFor()
ok(
  `at ${viewport.width}x${viewport.height}, toggling the guide 6 times while recording keeps the take and timer going (${ticks.join(', ')}s; Stop at y ${Math.round(stopBox.y)}-${Math.round(stopBox.y + stopBox.height)}); the take stops, plays (${guidePlayed.toFixed(2)}s), saves and is submitted`,
)

await topicRow('A day at school').getByRole('button', { name: 'Edit' }).click()
await teacher.getByTestId('guide-input-partner').fill('')
await teacher.getByRole('button', { name: 'Edit Topic' }).click()
await topicRow('A day at school').getByText('Has a Podcast Guide').waitFor({ state: 'detached' })
await sara.reload()
await sara.getByRole('button', { name: 'A day at school' }).click()
await sara.getByText('How do you want to record?').waitFor()
assert.equal(await guideButton(sara).count(), 0, 'a cleared guide hides the button')
ok('the teacher clears a guide and the student no longer sees the button')

await sara.setViewportSize({ width: 375, height: 667 })
await sara.getByRole('button', { name: 'Change topic' }).click()
await sara.getByRole('button', { name: 'My Winter Style' }).click()
await sara.getByRole('button', { name: 'On My Own' }).click()
await sara.getByRole('button', { name: 'Record' }).waitFor()
await toggleGuide(sara, true)
const recordBox = await sara.getByRole('button', { name: 'Record' }).boundingBox()
assert.ok(recordBox.y + recordBox.height <= 667, `Record is fully on screen: ${JSON.stringify(recordBox)}`)
await sara.getByRole('button', { name: 'Record' }).click()
await stop.waitFor()
await sara.waitForTimeout(1500)
const fullStop = await stop.boundingBox()
const fullTimer = await sara.getByRole('timer').boundingBox()
assert.ok(fullStop.y + fullStop.height <= 667 && fullTimer.y >= 0, `Stop and the timer are fully on screen: ${JSON.stringify({ fullStop, fullTimer })}`)
const guideBoxHeight = (await sara.getByRole('region', { name: 'Podcast Guide' }).boundingBox()).height
await shot(sara, 'guide-4-recording-375x667')
await stop.click()
await sara.getByRole('button', { name: 'Try Again' }).click()
await sara.getByRole('button', { name: 'Record' }).waitFor()
await guideCtx.close()
ok(`at 375x667 with the guide open, Record and then Stop and the timer are fully on screen (guide box ${Math.round(guideBoxHeight)}px, scrolls inside)`)

// ---- Layout: no horizontal scroll on phones ----
for (const [label, device] of [['iphone13', devices['iPhone 13']], ['pixel7', devices['Pixel 7']]]) {
  const { defaultBrowserType: _ignored, ...chromiumDevice } = device
  const ctx = await browser.newContext({ ...chromiumDevice, permissions: ['microphone'] })
  const page = await ctx.newPage()
  await page.goto(classLink)
  await page.getByRole('button', { name: 'Sara' }).click()
  await page.getByLabel('Type your PIN').fill(saraPin)
  await shot(page, `${label}-pin`)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'A day at school' }).click()
  await page.getByRole('button', { name: 'On My Own' }).click()
  await page.getByRole('button', { name: 'Record' }).waitFor()
  for (const step of ['ready', 'recording', 'recorded']) {
    if (step === 'recording') {
      await page.getByRole('button', { name: 'Record' }).click()
      await page.getByRole('button', { name: 'Stop' }).waitFor()
    }
    if (step === 'recorded') {
      await page.getByRole('button', { name: 'Stop' }).click()
      await page.getByRole('button', { name: 'Save' }).waitFor()
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert.ok(overflow <= 0, `${label} ${step}: horizontal overflow ${overflow}px`)
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 40)
        .map((b) => b.textContent.trim()),
    )
    await shot(page, `${label}-${step}`)
    if (small.length) console.log(`  note: ${label} ${step} buttons under 40px: ${small.join(', ')}`)
  }
  await ctx.close()
  ok(`${label} viewport: ready/recording/recorded fit without horizontal scroll`)
}

// ---- The teacher deletes the class: Cancel keeps it, OK clears it ----
const classUrl = teacher.url()
const deleteClass = teacher.getByRole('button', { name: 'Delete Class' })
teacher.once('dialog', (dialog) => void dialog.dismiss())
await deleteClass.click()
assert.equal(teacher.url(), classUrl, 'Cancel keeps the class')
let deleteMessage = ''
teacher.once('dialog', (dialog) => {
  deleteMessage = dialog.message()
  void dialog.accept()
})
await deleteClass.click()
await teacher.getByRole('heading', { name: 'Your classes' }).waitFor()
assert.match(deleteMessage, /Room 12B[\s\S]*every recording/)
assert.equal(await teacher.getByRole('link', { name: /Room 12B/ }).count(), 0)
assert.equal((await teacherCtx.request.get(`${base}${v2Src}`)).status(), 404, 'the submitted recording is gone')
assert.equal((await teacherCtx.request.get(classUrl.replace('/teacher/classes/', '/api/teacher/classes/'))).status(), 404)
await shot(teacher, 'teacher-class-deleted')
ok('the teacher deletes the class (Cancel keeps it); its recordings are gone and it leaves the class list')

await browser.close()
fakeGoogle.close()
console.log(`\nall ${n} steps passed`)
