// Two-person podcast in two browsers. Usage: node group-e2e.mjs <baseUrl> <fakeGooglePort> <container> <outDir>
// Each student's browser has its own fake microphone: Ali plays a 440 Hz tone, Sara a 660 Hz tone.
// Expects FIRSTMIC_MAX_SECONDS=10, the fake Google endpoints (see fake-google.mjs) and media from make-media.mjs.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chromium, devices } from 'playwright'
import { fakeToken, startFakeGoogle } from './fake-google.mjs'

const [base = 'http://localhost:18101', googlePort = '18199', container = 'firstmic-e2e', outDir = './out'] =
  process.argv.slice(2)
const fakeGoogle = await startFakeGoogle(Number(googlePort))
fs.mkdirSync(outDir, { recursive: true })
let n = 0
const ok = (msg) => console.log(`ok ${++n} - ${msg}`)
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `group-${name}.png`), fullPage: true })

// ---- Teacher setup through the API ----
const signIn = await fetch(`${base}/api/auth/google`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ accessToken: fakeToken(`duo${Date.now()}@example.com`) }),
})
const sessionCookie = signIn.headers.get('set-cookie').split(';')[0]
const teacherApi = async (urlPath, body) => {
  const res = await fetch(base + urlPath, {
    method: body ? 'POST' : 'GET',
    headers: { Cookie: sessionCookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}
const classId = (await teacherApi('/api/teacher/classes', { name: 'Grade 6D' })).class.id
await teacherApi(`/api/teacher/classes/${classId}/topics`, { title: 'Our favourite game' })
const students = (
  await teacherApi(`/api/teacher/classes/${classId}/students`, {
    students: [
      { name: 'Ali', emoji: '🦊', pin: '111111' },
      { name: 'Sara', emoji: '🐼', pin: '222222' },
      { name: 'Omar', emoji: '🐯', pin: '333333' },
    ],
  })
).students
const classToken = (await teacherApi(`/api/teacher/classes/${classId}`)).class.classToken
const classLink = `${base}/c/${classToken}`

const launch = (wav) =>
  chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.resolve(wav)}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
const aliBrowser = await launch('./media/tone440.wav')
const saraBrowser = await launch('./media/tone660.wav')
const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 13']

async function studentPage(browser, device, name) {
  const ctx = await browser.newContext({ ...device, permissions: ['microphone'] })
  const page = await ctx.newPage()
  page.on('console', (m) => m.type() === 'error' && console.log(`  [${name} console]`, m.text()))
  await page.goto(classLink)
  await page.getByRole('button', { name }).click()
  await page.getByLabel('Type your PIN').fill(students.find((s) => s.name === name).pin)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByText(`Hi ${name}! Pick a topic`).waitFor()
  return page
}

async function fits(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 0, `${label}: horizontal overflow ${overflow}px`)
  await shot(page, label)
}

/** The strongest frequency the page hears from the partner over the live call. */
function partnerTone(page) {
  return page.evaluate(async () => {
    const stream = document.querySelector('[data-testid="partner-audio"]')?.srcObject
    if (!stream || stream.getAudioTracks().length === 0) return null
    const ctx = new AudioContext()
    await ctx.resume()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 8192
    ctx.createMediaStreamSource(stream).connect(analyser)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const bins = new Float32Array(analyser.frequencyBinCount)
    analyser.getFloatFrequencyData(bins)
    let best = 1
    for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i
    const result = { hz: Math.round((best * ctx.sampleRate) / analyser.fftSize), db: Math.round(bins[best]) }
    await ctx.close()
    return result
  })
}

async function playFor(page, selector, ms) {
  return page.evaluate(
    async ({ selector, ms }) => {
      const audio = document.querySelector(selector)
      await audio.play()
      await new Promise((resolve) => setTimeout(resolve, ms))
      const t = audio.currentTime
      audio.pause()
      return t
    },
    { selector, ms },
  )
}

/** Mean level (dB) of a file around 440 Hz and 660 Hz, measured with the container's ffmpeg. */
function toneLevels(file) {
  execFileSync('docker', ['cp', file, `${container}:/tmp/check.mp3`])
  const level = (hz) => {
    const out = execFileSync(
      'docker',
      ['exec', container, 'sh', '-c', `ffmpeg -nostats -i /tmp/check.mp3 -af "bandpass=f=${hz}:width_type=q:w=20,volumedetect" -f null - 2>&1 | grep mean_volume`],
      { encoding: 'utf8' },
    )
    return Number(/mean_volume: (-?[\d.]+) dB/.exec(out)?.[1] ?? '-inf')
  }
  return { a440: level(440), a660: level(660) }
}

// ---- Ali creates a group and gets a PIN ----
const ali = await studentPage(aliBrowser, devices['Pixel 7'], 'Ali')
await ali.getByRole('button', { name: 'Our favourite game' }).click()
await ali.getByText('How do you want to record?').waitFor()
await fits(ali, 'ali-1-choose')
await ali.getByRole('button', { name: 'With a Partner' }).click()
const pinText = await ali.getByTestId('group-pin').innerText({ timeout: 15_000 })
assert.match(pinText, /^\d{6}$/)
await ali.getByText('Waiting for your partner to join…').waitFor()
await fits(ali, 'ali-2-waiting-pin')
ok(`Ali picks a topic, chooses With a Partner and gets group PIN ${pinText}`)

// ---- Sara joins with the PIN; they can hear each other ----
const sara = await studentPage(saraBrowser, iphone, 'Sara')
await sara.getByRole('button', { name: 'Join a Partner' }).click()
await sara.getByLabel("Type your partner's group PIN").fill(pinText === '000000' ? '999999' : '000000')
await sara.getByRole('button', { name: 'Join' }).click()
await sara.getByText('No group has that PIN').waitFor()
await sara.getByLabel("Type your partner's group PIN").fill(pinText)
await fits(sara, 'sara-1-join')
await sara.getByRole('button', { name: 'Join' }).click()
await sara.getByRole('heading', { name: 'Our favourite game' }).waitFor()
for (const page of [ali, sara]) {
  await page.getByTestId('group-member').nth(1).waitFor()
}
await ali.getByText('You can hear Sara.').waitFor({ timeout: 30_000 })
await sara.getByText('You can hear Ali.').waitFor({ timeout: 30_000 })
const saraHears = await partnerTone(sara)
const aliHears = await partnerTone(ali)
assert.ok(saraHears && Math.abs(saraHears.hz - 440) < 15, `Sara hears Ali's 440 Hz tone: ${JSON.stringify(saraHears)}`)
assert.ok(aliHears && Math.abs(aliHears.hz - 660) < 15, `Ali hears Sara's 660 Hz tone: ${JSON.stringify(aliHears)}`)
await fits(ali, 'ali-3-ready')
await fits(sara, 'sara-2-ready')
ok(`Sara joins with the PIN (a wrong PIN is refused); they talk live: Sara hears ${saraHears.hz} Hz, Ali hears ${aliHears.hz} Hz`)

// ---- A third student is blocked ----
const omar = await studentPage(aliBrowser, devices['Pixel 7'], 'Omar')
await omar.getByRole('button', { name: 'Join a Partner' }).click()
await omar.getByLabel("Type your partner's group PIN").fill(pinText)
await omar.getByRole('button', { name: 'Join' }).click()
await omar.getByText('This group is full. Only two people can record together.').waitFor()
await fits(omar, 'omar-full')
assert.equal(await ali.getByTestId('group-member').count(), 2)
await omar.context().close()
ok('a third student with the PIN is told the group is full')

// ---- Ali records, so Ali controls the take; both hear the mix ----
await ali.getByRole('button', { name: 'Record' }).click()
await ali.getByRole('button', { name: 'Stop' }).waitFor()
await sara.getByText('Ali is in charge. Ali taps Stop.').waitFor()
assert.equal(await sara.getByRole('button', { name: 'Stop' }).count(), 0)
await ali.waitForTimeout(4000)
await fits(ali, 'ali-4-recording')
await fits(sara, 'sara-3-recording-partner')
await ali.getByRole('button', { name: 'Stop' }).click()
for (const page of [ali, sara]) {
  await page.getByTestId('mix-player').waitFor({ timeout: 60_000 })
}
await sara.getByText('Ali chooses Save for Both or Try Again.').waitFor()
assert.equal(await sara.getByRole('button', { name: 'Save for Both' }).count(), 0)
const saraPlayed = await playFor(sara, '[data-testid="mix-player"] audio', 1000)
assert.ok(saraPlayed > 0.5, `Sara's mix playback did not advance (${saraPlayed})`)
await fits(ali, 'ali-5-listening')
await fits(sara, 'sara-4-listening-partner')
ok(`Ali taps Record and controls the take; after Stop both hear the mix (Sara played ${saraPlayed.toFixed(2)}s); only Ali gets Save for Both`)

// A reload brings Sara back to the same take
await sara.reload()
await sara.getByRole('button', { name: 'Our favourite game' }).click()
await sara.getByRole('button', { name: 'With a Partner' }).click()
await sara.getByTestId('mix-player').waitFor({ timeout: 30_000 })
ok('after a reload, Sara opens the same group and is back at the mix')

await ali.getByRole('button', { name: 'Try Again' }).click()
for (const page of [ali, sara]) {
  await page.getByRole('button', { name: 'Record' }).waitFor()
}
assert.equal(await ali.getByTestId('mix-player').count(), 0)
ok('Try Again throws the take away on both phones')

// ---- This time Sara records and saves it for both ----
await sara.getByText('You can hear Ali.').waitFor({ timeout: 30_000 })
await sara.getByRole('button', { name: 'Record' }).click()
await ali.getByText('Sara is in charge. Sara taps Stop.').waitFor()
await sara.waitForTimeout(4000)
await sara.getByRole('button', { name: 'Stop' }).click()
await sara.getByTestId('mix-player').waitFor({ timeout: 60_000 })
await sara.getByRole('button', { name: 'Save for Both' }).click()
for (const page of [ali, sara]) {
  await page.getByText('Saved!').waitFor({ timeout: 30_000 })
  await page.getByText("It's in My Recordings for both of you.").waitFor()
}
await fits(sara, 'sara-5-saved')
await fits(ali, 'ali-6-saved')
ok('Sara taps Record, so Sara controls this take; she saves it and both phones show Saved!')

// ---- Sara submits her copy from My Recordings; the teacher gets it ----
const teacherCtx = await aliBrowser.newContext()
const [cookieName, cookieValue] = sessionCookie.split('=')
await teacherCtx.addCookies([{ name: cookieName, value: cookieValue, url: base }])
const teacher = await teacherCtx.newPage()
await teacher.goto(`${base}/teacher/classes/${classId}`)
await teacher.getByText('No submissions yet.').waitFor()
await sara.getByRole('button', { name: 'My Recordings' }).click()
const saraItems = sara.getByTestId('my-recording')
await saraItems.first().waitFor({ timeout: 30_000 })
assert.match(await saraItems.first().innerText(), /Our favourite game[\s\S]*With Ali/)
await shot(sara, 'sara-7-my-recordings')
await saraItems.first().getByRole('button', { name: 'Submit to Teacher' }).click()
await saraItems.first().getByText('✓ Submitted').waitFor()
await teacher.reload()
const rows = teacher.getByTestId('submission')
await rows.first().waitFor()
assert.equal(await rows.count(), 1)
const rowText = await rows.first().innerText()
assert.match(rowText, /Sara/)
assert.match(rowText, /Our favourite game[\s\S]*with Ali/)
assert.match(await teacher.getByTestId('not-submitted').innerText(), /Ali/)
const teacherPlayed = await playFor(teacher, '[data-testid="submission"] audio', 1000)
assert.ok(teacherPlayed > 0.5, 'teacher playback did not advance')
const download = await teacherCtx.request.get(base + (await rows.first().getByRole('link', { name: 'Download' }).getAttribute('href')))
assert.equal(download.status(), 200)
const sentFile = path.join(outDir, 'group-ui-sara-copy.mp3')
fs.writeFileSync(sentFile, await download.body())
const levels = toneLevels(sentFile)
// Chrome's noise suppression treats a steady test tone as noise and can cut it by about 20 dB (to about -44 dB here),
// so "present" means well above silence, not at the tone file's full level.
assert.ok(levels.a440 > -50 && levels.a660 > -50, `Sara's copy is the mix ${JSON.stringify(levels)}`)
await shot(teacher, 'teacher-1')
console.log(`  levels: ${JSON.stringify(levels)}`)
ok('Sara submits her copy from My Recordings; the teacher plays and downloads it (both voices in it); Ali has not submitted')

// ---- The time limit stops a take on its own; Ali saves it and submits his own copy ----
await sara.getByRole('button', { name: 'Record Another' }).click()
await sara.getByRole('button', { name: 'Our favourite game' }).click()
await sara.getByRole('button', { name: 'With a Partner' }).click()
await ali.getByRole('button', { name: 'Try Again' }).click()
await ali.getByRole('button', { name: 'Record' }).click({ timeout: 30_000 })
await sara.getByText('Ali is in charge. Ali taps Stop.').waitFor({ timeout: 30_000 })
await ali.getByText("Time's up!").waitFor({ timeout: 40_000 })
const capped = await ali.getByRole('timer').innerText()
assert.match(capped, /^0:(09|10)/)
await ali.getByRole('button', { name: 'Save for Both' }).click()
await sara.getByText('Saved!').waitFor({ timeout: 30_000 })
await ali.getByRole('button', { name: 'My Recordings' }).click()
const aliItems = ali.getByTestId('my-recording')
await aliItems.nth(1).waitFor({ timeout: 30_000 })
assert.equal(await aliItems.count(), 2, 'both saves are in his list')
await aliItems.first().getByRole('button', { name: 'Submit to Teacher' }).click()
await aliItems.first().getByText('✓ Submitted').waitFor()
await teacher.reload()
await rows.nth(1).waitFor()
assert.equal(await rows.count(), 2)
assert.doesNotMatch(await teacher.getByTestId('not-submitted').innerText(), /Ali|Sara/, 'both have submitted')
await shot(teacher, 'teacher-2')
ok(`the take stops itself at the 10s limit (timer ${capped.replace(/\s+/g, ' ')}); Ali saves it and submits his own copy`)

await aliBrowser.close()
await saraBrowser.close()
fakeGoogle.close()
console.log(`\nall ${n} group browser steps passed`)
