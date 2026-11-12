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
await sara.getByText('Ali chooses Send or Try Again.').waitFor()
assert.equal(await sara.getByRole('button', { name: 'Send' }).count(), 0)
const saraPlayed = await playFor(sara, '[data-testid="mix-player"] audio', 1000)
assert.ok(saraPlayed > 0.5, `Sara's mix playback did not advance (${saraPlayed})`)
await fits(ali, 'ali-5-listening')
await fits(sara, 'sara-4-listening-partner')
ok(`Ali taps Record and controls the take; after Stop both hear the mix (Sara played ${saraPlayed.toFixed(2)}s); only Ali gets Send`)

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

// ---- This time Sara records and sends ----
await sara.getByText('You can hear Ali.').waitFor({ timeout: 30_000 })
await sara.getByRole('button', { name: 'Record' }).click()
await ali.getByText('Sara is in charge. Sara taps Stop.').waitFor()
await sara.waitForTimeout(4000)
await sara.getByRole('button', { name: 'Stop' }).click()
await sara.getByTestId('mix-player').waitFor({ timeout: 60_000 })
await sara.getByRole('button', { name: 'Send' }).click()
for (const page of [ali, sara]) {
  await page.getByText('Sent!').waitFor({ timeout: 30_000 })
}
await fits(sara, 'sara-5-sent')
await fits(ali, 'ali-6-sent')
ok('Sara taps Record, so Sara controls this take; she sends it and both phones show Sent!')

// ---- The teacher plays the mix and downloads all three files ----
const teacherCtx = await aliBrowser.newContext()
const [cookieName, cookieValue] = sessionCookie.split('=')
await teacherCtx.addCookies([{ name: cookieName, value: cookieValue, url: base }])
const teacher = await teacherCtx.newPage()
await teacher.goto(`${base}/teacher/classes/${classId}`)
const row = teacher.getByTestId('group-recording')
await row.waitFor()
assert.equal(await row.count(), 1)
const rowText = await row.innerText()
assert.match(rowText, /Ali & Sara/)
assert.match(rowText, /Our favourite game/)
const teacherPlayed = await playFor(teacher, '[data-testid="group-recording"] audio', 1000)
assert.ok(teacherPlayed > 0.5, 'teacher playback did not advance')
const links = await row.locator('a').evaluateAll((as) => as.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })))
assert.deepEqual(links.map((l) => l.text), ['Download Mix', "Ali's Voice", "Sara's Voice"])
const levels = {}
for (const link of links) {
  const res = await teacherCtx.request.get(base + link.href)
  assert.equal(res.status(), 200, link.text)
  const file = path.join(outDir, `group-ui-${link.text.replace(/\W+/g, '-')}.mp3`)
  fs.writeFileSync(file, await res.body())
  levels[link.text] = toneLevels(file)
}
// Chrome's noise suppression treats a steady test tone as noise and can cut it by about 20 dB (to about -44 dB here),
// so "present" means well above silence, not at the tone file's full level.
assert.ok(levels['Download Mix'].a440 > -50 && levels['Download Mix'].a660 > -50, `mix ${JSON.stringify(levels['Download Mix'])}`)
assert.ok(levels["Ali's Voice"].a440 - levels["Ali's Voice"].a660 > 15, `Ali's voice ${JSON.stringify(levels["Ali's Voice"])}`)
assert.ok(levels["Sara's Voice"].a660 - levels["Sara's Voice"].a440 > 15, `Sara's voice ${JSON.stringify(levels["Sara's Voice"])}`)
await shot(teacher, 'teacher-1')
console.log(`  levels: ${JSON.stringify(levels)}`)
ok('the teacher sees the podcast, plays the mix, and downloads the mix and each voice (mix has both tones, each voice its own)')

// ---- The time limit stops a take on its own; the replacement becomes version 2 ----
await ali.getByRole('button', { name: 'Try Again' }).click()
await ali.getByRole('button', { name: 'Record' }).click()
await sara.getByText('Ali is in charge. Ali taps Stop.').waitFor()
await ali.getByText("Time's up!").waitFor({ timeout: 40_000 })
const capped = await ali.getByRole('timer').innerText()
assert.match(capped, /^0:(09|10)/)
await ali.getByRole('button', { name: 'Send' }).click()
await sara.getByText('Sent!').waitFor({ timeout: 30_000 })
await teacher.reload()
await row.waitFor()
assert.match(await row.innerText(), /sent 2 times/)
await shot(teacher, 'teacher-2')
ok(`the take stops itself at the 10s limit (timer ${capped.replace(/\s+/g, ' ')}); sending it replaces version 1`)

// ---- Feedback reaches both partners; replacing the commented take keeps it under Past Feedback ----
const comment = 'You took turns really well.'
await row.getByTestId('feedback-input').fill(comment)
await row.getByRole('button', { name: 'Save Feedback' }).click()
await row.getByText('Feedback saved. Students can see it.').waitFor()
for (const page of [ali, sara]) {
  await page.getByTestId('current-feedback').getByText(comment).waitFor()
}
await shot(sara, 'sara-feedback')
ok('the teacher comments on version 2 and both partners see it without reloading')

await ali.getByRole('button', { name: 'Try Again' }).click()
await ali.getByRole('button', { name: 'Record' }).click()
await sara.getByText('Ali is in charge. Ali taps Stop.').waitFor()
await ali.waitForTimeout(2500)
await ali.getByRole('button', { name: 'Stop' }).click()
await ali.getByRole('button', { name: 'Send' }).click({ timeout: 30_000 })
for (const page of [ali, sara]) {
  await page.getByText('Sent!').waitFor({ timeout: 30_000 })
  await page.getByTestId('past-feedback').getByText(comment).waitFor()
}
await sara.getByTestId('past-feedback').getByRole('button', { name: 'Listen' }).click()
await sara.locator('[data-testid="past-feedback"] audio').waitFor({ state: 'attached' })
const pastPlayed = await playFor(sara, '[data-testid="past-feedback"] audio', 1000)
assert.ok(pastPlayed > 0.5, `Sara's past mix playback did not advance (${pastPlayed})`)
await shot(sara, 'sara-past-feedback')

await teacher.reload()
await row.waitFor()
assert.match(await row.innerText(), /sent 3 times/)
const history = row.getByTestId('version-history')
await history.locator('summary').click()
const kept = history.getByTestId('past-version').first()
assert.match(await kept.innerText(), /Version 2[\s\S]*took turns/)
const keptLinks = await kept.locator('a').evaluateAll((as) => as.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })))
assert.deepEqual(keptLinks.map((l) => l.text), ['Download Mix', "Ali's Voice", "Sara's Voice"])
for (const link of keptLinks) {
  assert.equal((await teacherCtx.request.get(base + link.href)).status(), 200, link.text)
}
await shot(teacher, 'teacher-history')
ok(`a new take replaces the commented one: the teacher keeps its mix and both voices; both partners see it under Past Feedback (Sara played ${pastPlayed.toFixed(2)}s)`)

await aliBrowser.close()
await saraBrowser.close()
fakeGoogle.close()
console.log(`\nall ${n} group browser steps passed`)
