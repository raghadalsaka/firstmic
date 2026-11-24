// Grades, the Upload and Edit pages, and the public Top 3 page. Usage: node grades-e2e.mjs <baseUrl> <fakeGooglePort>
// Expects the fake Google endpoints (see fake-google.mjs) and media from make-media.mjs.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { fakeToken, startFakeGoogle } from './fake-google.mjs'

const [base = 'http://localhost:18101', googlePort = '18199'] = process.argv.slice(2)
const wsBase = base.replace(/^http/, 'ws')
const tone440 = fs.readFileSync('./media/tone.webm')
const tone660 = fs.readFileSync('./media/tone660.webm')
const outDir = './out'
fs.mkdirSync(outDir, { recursive: true })
const fakeGoogle = await startFakeGoogle(Number(googlePort))
let cookie = ''
let passed = 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function step(name) {
  passed++
  console.log(`ok ${passed} - ${name}`)
}

async function call(urlPath, { method, body, token, raw, anonymous } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (raw) headers['Content-Type'] = 'application/octet-stream'
  if (token) headers.Authorization = `Bearer ${token}`
  else if (cookie && !anonymous) headers.Cookie = cookie
  const res = await fetch(base + urlPath, {
    method: method ?? (body !== undefined || raw ? 'POST' : 'GET'),
    headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie && !token) cookie = setCookie.split(';')[0]
  return res
}

async function json(urlPath, opts) {
  const res = await call(urlPath, opts)
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

async function until(check, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await sleep(200)
  }
}

// ---- Setup: a class with five students; three record alone, Ali and Sara record together and both submit ----
assert.equal((await json('/api/auth/google', { body: { accessToken: fakeToken(`grades${Date.now()}@example.com`) } })).status, 200)
const classId = (await json('/api/teacher/classes', { body: { name: 'Room 7G' } })).data.class.id
const topic = (await json(`/api/teacher/classes/${classId}/topics`, { body: { title: "What's in My Name?" } })).data.topic
const roster = (
  await json(`/api/teacher/classes/${classId}/students`, {
    body: { students: ['Ali', 'Sara', 'Omar', 'Lina', 'Huda'].map((name) => ({ name, emoji: '🦊' })) },
  })
).data.students
const byName = Object.fromEntries(roster.map((s) => [s.name, s]))
const classToken = (await json(`/api/teacher/classes/${classId}`)).data.class.classToken
const teacherCookie = cookie

const logins = {}
for (const name of Object.keys(byName)) {
  const res = await json(`/api/class/${classToken}/sign-in`, { body: { studentId: byName[name].id, pin: byName[name].pin } })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  logins[name] = res.data.studentToken
}
const mine = async (name) => (await json(`/api/class/${classToken}/recordings`, { token: logins[name] })).data
const submit = async (name, id) =>
  assert.equal((await json(`/api/class/${classToken}/recordings/${id}/submit`, { token: logins[name], body: {} })).status, 200)

async function recordAlone(name) {
  const episode = (await json(`/api/class/${classToken}/episodes`, { token: logins[name], body: { topicId: topic.id } })).data
  const sub = await json('/api/student/submissions', { token: episode.token, body: { mimeType: 'audio/webm;codecs=opus', durationMs: 4000 } })
  assert.equal(sub.status, 200, JSON.stringify(sub.data))
  assert.equal((await call(`/api/tracks/${sub.data.trackId}/chunks/0`, { method: 'PUT', token: episode.token, raw: tone440 })).status, 200)
  await json(`/api/tracks/${sub.data.trackId}/finalize`, { token: episode.token, body: { finalChunkCount: 1, durationMs: 4000 } })
  await until(
    async () => (await json(`/api/student/submissions/${sub.data.submissionId}`, { token: episode.token })).data.status === 'ready',
    `${name}'s recording`,
  )
  await submit(name, sub.data.submissionId)
  return sub.data.submissionId
}

const solo = {}
for (const name of ['Omar', 'Lina', 'Huda']) solo[name] = await recordAlone(name)

function connect(token) {
  const ws = new WebSocket(`${wsBase}/ws?token=${token}`)
  const conn = { ws, group: null }
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.t === 'group') conn.group = msg.group
  })
  return conn
}

async function uploadVoice(token, takeId, bytes) {
  const created = await json(`/api/group/takes/${takeId}/voice`, {
    token,
    body: { mimeType: 'audio/webm;codecs=opus', startOffsetMs: 0, durationMs: 3000 },
  })
  assert.equal(created.status, 200, JSON.stringify(created.data))
  await call(`/api/tracks/${created.data.trackId}/chunks/0`, { method: 'PUT', token, raw: bytes })
  await json(`/api/tracks/${created.data.trackId}/finalize`, { token, body: { finalChunkCount: 1, durationMs: 3000 } })
}

const ali = (await json(`/api/class/${classToken}/groups`, { token: logins.Ali, body: { topicId: topic.id } })).data.token
const groupPin = (await json('/api/group', { token: ali })).data.group.pin
const sara = (await json(`/api/class/${classToken}/groups/join`, { token: logins.Sara, body: { pin: groupPin } })).data.token
const aliConn = connect(ali)
const saraConn = connect(sara)
await until(() => aliConn.group?.members.length === 2 && aliConn.group.members.every((m) => m.online), 'both partners online')
const take = (await json('/api/group/takes', { token: ali, body: {} })).data.takeId
await sleep(2500)
assert.equal((await json(`/api/group/takes/${take}/stop`, { token: ali, body: {} })).status, 200)
await uploadVoice(ali, take, tone440)
await uploadVoice(sara, take, tone660)
await until(async () => (await json('/api/group', { token: ali })).data.group.take?.status === 'listening', 'the mix')
assert.equal((await json(`/api/group/takes/${take}/send`, { token: ali, body: {} })).status, 200)
aliConn.ws.close()
saraConn.ws.close()
const aliCopy = (await mine('Ali')).recordings[0].id
const saraCopy = (await mine('Sara')).recordings[0].id
await submit('Ali', aliCopy)
await submit('Sara', saraCopy)

// ---- Grades API ----
const grades = async () => (await json(`/api/teacher/classes/${classId}/grades`)).data
const first = await grades()
assert.equal(first.recordings.length, 4, 'four recordings: the partners share one')
const pair = first.recordings.find((r) => r.names.includes('Ali'))
assert.deepEqual([...pair.submissionIds].sort(), [aliCopy, saraCopy].sort())
assert.deepEqual([...pair.names].sort(), ['Ali', 'Sara'])
assert.ok(first.recordings.every((r) => r.grade === null && r.rank === null))
assert.equal(first.class.top3PublishedAt, null)
step("the partners' two identical copies are one recording; nothing is graded yet")

const top3 = async () => (await json(`/api/class/${classToken}/top3`, { anonymous: true })).data
const publicAudio = (id) => call(`/api/class/${classToken}/top3/${id}/audio`, { anonymous: true })
assert.deepEqual(await top3(), { className: 'Room 7G', published: false, recordings: [] })
assert.equal((await publicAudio(solo.Omar)).status, 404)
step('the Top 3 page is empty and plays nothing until the teacher publishes it')

const scores = (content, organization, delivery, language) => ({ content, organization, delivery, language })
const putGrades = (list, opts = {}) => json(`/api/teacher/classes/${classId}/grades`, { method: 'PUT', body: { grades: list }, ...opts })
const good = { submissionId: solo.Omar, scores: scores(4, 3, 3, 2), highlights: [], comment: null }
const refusals = [
  [[good, { submissionId: 'nope', scores: scores(1, 1, 1, 1) }], /no submitted recording/],
  [[{ ...good, highlights: [{ startMs: 1000, endMs: 60_000, note: 'too late' }] }], /ends after the recording/],
  [[{ submissionId: aliCopy, scores: scores(1, 1, 1, 1) }, { submissionId: saraCopy, scores: scores(2, 2, 2, 2) }], /graded twice/],
  [[{ ...good, scores: scores(5, 1, 1, 1) }], /scores/],
  [[{ ...good, highlights: [{ startMs: 2000, endMs: 1000, note: 'backwards' }] }], /end after/],
]
for (const [list, message] of refusals) {
  const res = await putGrades(list)
  assert.equal(res.status, 400, JSON.stringify(res.data))
  assert.match(res.data.error, message)
}
assert.equal((await putGrades([good], { token: logins.Omar })).status, 401, 'a student token cannot grade')
assert.ok((await grades()).recordings.every((r) => r.grade === null), 'a refused upload saves nothing')
step('bad uploads are refused whole: unknown recording, highlight past the end, partners graded twice, bad scores; students cannot grade')

const upload = [
  {
    submissionId: saraCopy,
    scores: scores(4, 4, 3, 3),
    highlights: [
      { startMs: 1500, endMs: 2200, note: 'They take turns' },
      { startMs: 200, endMs: 1200, note: 'A strong opening' },
    ],
    comment: 'Teacher-only note',
  },
  { submissionId: solo.Omar, scores: scores(4, 3, 3, 2), highlights: [{ startMs: 500, endMs: 1500, note: 'Clear voice' }] },
  { submissionId: solo.Lina, scores: scores(3, 3, 3, 3), highlights: [] },
  { submissionId: solo.Huda, scores: scores(2, 2, 2, 2), highlights: [] },
]
const saved = await putGrades(upload)
assert.equal(saved.status, 200, JSON.stringify(saved.data))
const ranked = (await grades()).recordings
assert.deepEqual(
  ranked.map((r) => [r.rank, [...r.names].sort().join('+'), r.grade.total]),
  [
    [1, 'Ali+Sara', 14],
    [2, 'Omar', 12],
    [3, 'Lina', 12],
    [4, 'Huda', 8],
  ],
)
assert.deepEqual(
  ranked[0].grade.highlights.map((h) => h.startMs),
  [200, 1500],
  'highlights are kept in time order',
)
step("grades save; the partners' grade covers both copies; a 12-12 tie goes to the higher Content score")

const classInfo = async () => (await json(`/api/class/${classToken}`, { anonymous: true })).data.class
assert.equal((await classInfo()).top3Published, false)
assert.equal((await mine('Omar')).feedback, null, 'students see nothing until the teacher publishes')
step('before publishing, the class page has no Top 3 link and students see no grade')

assert.equal((await json(`/api/teacher/classes/${classId}/top3`, { method: 'PUT', body: { published: true } })).status, 200)
const shown = await top3()
assert.equal(shown.published, true)
assert.deepEqual(
  shown.recordings.map((r) => [r.rank, [...r.names].sort().join('+')]),
  [
    [1, 'Ali+Sara'],
    [2, 'Omar'],
    [3, 'Lina'],
  ],
)
assert.ok(shown.recordings.every((r) => !('total' in r) && !('scores' in r)), 'the public page gets no scores')
assert.ok(!JSON.stringify(shown).includes('Teacher-only'), 'the teacher comment stays private')
assert.equal((await classInfo()).top3Published, true)
for (const recording of shown.recordings) {
  const res = await publicAudio(recording.submissionId)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'audio/mpeg')
}
assert.equal((await publicAudio(solo.Huda)).status, 404, 'fourth place is not playable on the public page')
step('published: anyone with the class link sees the Top 3 with highlights (no scores or comment) and can play only those three')

const omarFeedback = (await mine('Omar')).feedback
assert.deepEqual(omarFeedback, { levels: scores(4, 3, 3, 2), highlights: [{ startMs: 500, endMs: 1500, note: 'Clear voice' }] })
assert.ok(!('total' in omarFeedback) && !JSON.stringify(omarFeedback).includes('Teacher-only'))
assert.deepEqual((await mine('Ali')).feedback.levels, scores(4, 4, 3, 3), "Ali's submitted copy carries the partners' grade")
assert.equal((await mine('Huda')).feedback.levels.content, 2)
step('published: each student gets their own grade as levels with their highlights, never a total or the comment')

assert.equal((await putGrades([{ submissionId: solo.Huda, scores: scores(4, 4, 4, 4), highlights: [] }])).status, 200)
const reranked = await top3()
assert.deepEqual(
  reranked.recordings.map((r) => [...r.names].sort().join('+')),
  ['Huda', 'Ali+Sara', 'Omar'],
)
assert.equal((await publicAudio(solo.Lina)).status, 404, 'Lina dropped out of the Top 3')
assert.equal((await json(`/api/teacher/classes/${classId}/grades/${solo.Huda}`, { method: 'DELETE' })).status, 200)
assert.equal((await grades()).recordings.find((r) => r.names.includes('Huda')).rank, null)
assert.equal((await top3()).recordings[2].names[0], 'Lina', 'removing a grade lets the next recording back in')
step('editing a grade re-ranks the Top 3 at once; removing a grade takes the recording out of the ranking')

// ---- Browser: the teacher pages and the public page ----
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const [cookieName, ...cookieRest] = teacherCookie.split('=')
const teacher = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await teacher.addCookies([{ name: cookieName, value: cookieRest.join('='), url: base }])
const page = await teacher.newPage()
page.on('pageerror', (err) => console.log(`  [teacher page error] ${err.message}`))

await page.goto(`${base}/teacher/classes/${classId}`)
await page.getByTestId('grades-link').click()
await page.getByRole('heading', { name: 'Grades: Room 7G' }).waitFor()
assert.equal(await page.getByTestId('grade-row').count(), 4)
assert.deepEqual(await page.getByTestId('grade-total').allInnerTexts(), ['14/16', '12/16', '12/16', 'Not graded'])
await page.screenshot({ path: path.join(outDir, 'grades-list.png'), fullPage: true })
step('the class page links to Grades, which lists the recordings in rank order with their totals')

const gradesFile = path.join(outDir, 'grades-upload.json')
fs.writeFileSync(
  gradesFile,
  JSON.stringify({ grades: [{ submissionId: solo.Huda, scores: scores(3, 3, 3, 3), highlights: [{ startMs: 1000, endMs: 3000, note: 'Funny story' }] }] }),
)
await page.getByRole('link', { name: 'Upload Scores' }).click()
await page.getByTestId('grades-file').setInputFiles(gradesFile)
await page.getByTestId('grades-preview').getByText('Huda').waitFor()
await page.screenshot({ path: path.join(outDir, 'grades-upload.png'), fullPage: true })
await page.getByTestId('grades-save').click()
await page.getByRole('heading', { name: 'Grades: Room 7G' }).waitFor()
assert.ok((await page.getByTestId('grade-row').allInnerTexts()).some((text) => text.includes('Huda') && text.includes('12/16')))
step('Upload Scores previews who the file matches, then saves it')

await page.getByTestId('grade-row').filter({ hasText: 'Lina' }).getByRole('link').click()
await page.getByTestId('edit-total').waitFor()
assert.equal(await page.getByTestId('edit-total').innerText(), '12/16')
await page.getByTestId('score-content-4').check()
await page.getByTestId('score-delivery-4').check()
assert.equal(await page.getByTestId('edit-total').innerText(), '14/16')
await page.getByRole('button', { name: 'Add Highlight' }).click()
const row = page.getByTestId('highlight-row').last()
await row.getByLabel('Start').fill('0:01')
await row.getByLabel('End').fill('0:03')
await row.getByLabel('Note').fill('Great ending')
await page.screenshot({ path: path.join(outDir, 'grades-edit.png'), fullPage: true })
await page.getByTestId('grade-save').click()
await page.getByRole('heading', { name: 'Grades: Room 7G' }).waitFor()
const lina = (await grades()).recordings.find((r) => r.names.includes('Lina'))
assert.equal(lina.grade.total, 14)
assert.deepEqual(lina.grade.highlights, [{ startMs: 1000, endMs: 3000, note: 'Great ending' }])
step('Edit Scores changes the scores and adds a highlight; the total updates as you pick')

await page.getByRole('button', { name: 'Hide Top 3' }).click()
await page.getByRole('button', { name: 'Publish Top 3' }).click()
const topUrl = await page.getByLabel('Top 3 link').inputValue()
assert.match(topUrl, /\/top\/[^/]+\/room-7g$/)
step('the teacher hides and publishes the Top 3 and gets its link')

for (const [label, viewport] of [['phone', { width: 375, height: 740 }], ['desktop', { width: 1280, height: 900 }]]) {
  const visitor = await browser.newContext({ viewport })
  const top = await visitor.newPage()
  top.on('pageerror', (err) => console.log(`  [top page error] ${err.message}`))
  await top.goto(topUrl)
  await top.getByRole('heading', { name: 'Top 3 Podcasts' }).waitFor()
  const cards = top.getByTestId('top-recording')
  assert.equal(await cards.count(), 3)
  assert.match(await cards.first().innerText(), /1st/)
  assert.ok(!/\d+\s*\/\s*16/.test(await top.locator('main').innerText()), 'no scores on the public page')
  const boxes = await cards.evaluateAll((items) => items.map((item) => item.getBoundingClientRect()))
  assert.ok(boxes[1].top >= boxes[0].bottom && boxes[2].top >= boxes[1].bottom, `${label}: the three cards are stacked`)
  const overflow = await top.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(overflow <= 0, `top 3 (${label}) scrolls sideways by ${overflow}px`)
  await top.screenshot({ path: path.join(outDir, `top3-${label}.png`), fullPage: true })
  if (label === 'phone') {
    const pairCard = cards.filter({ hasText: 'Sara' })
    await pairCard.getByRole('button', { name: 'Play', exact: true }).click()
    const status = pairCard.getByTestId('highlight-status')
    await until(async () => /Highlight 1 of 2: A strong opening/.test(await status.innerText()), 'first highlight playing', 10_000)
    await until(async () => /Highlight 2 of 2: They take turns/.test(await status.innerText()), 'second highlight', 10_000)
    await until(async () => (await status.innerText()) === 'Full recording', 'then the full recording', 10_000)
    step('the Top 3 page plays the highlights in order, then the full recording')
  }
  await visitor.close()
}
step('the Top 3 page stacks its cards and fits a phone and a desktop without sideways scrolling')

const student = await browser.newContext({ viewport: { width: 375, height: 740 } })
const classPage = await student.newPage()
classPage.on('pageerror', (err) => console.log(`  [class page error] ${err.message}`))
await classPage.goto(`${base}/c/${classToken}`)
await classPage.getByTestId('top3-link').click()
await classPage.getByRole('heading', { name: 'Top 3 Podcasts' }).waitFor()
await classPage.goBack()
await classPage.getByRole('button', { name: 'Omar' }).click()
await classPage.locator('#pin').fill(byName.Omar.pin)
await classPage.getByRole('button', { name: 'Next' }).click()
await classPage.getByRole('button', { name: 'My Recordings' }).click()
const feedback = classPage.getByTestId('my-feedback')
await feedback.waitFor()
const feedbackText = await feedback.innerText()
assert.match(feedbackText, /Content: Excellent[\s\S]*Organization: Great[\s\S]*Delivery: Great[\s\S]*Language: Good/)
assert.ok(!/\d/.test(feedbackText), `the student's grade shows no numbers: ${feedbackText}`)
await classPage.getByRole('button', { name: 'Listen' }).click()
await classPage.getByTestId('highlight-status').waitFor()
await classPage.screenshot({ path: path.join(outDir, 'student-feedback.png'), fullPage: true })
await student.close()
step('the class page links to the Top 3; a signed-in student sees their grade in words, with their highlights')

await browser.close()

assert.equal((await json(`/api/teacher/classes/${classId}`, { method: 'DELETE' })).status, 200)
assert.equal((await json(`/api/teacher/classes/${classId}/grades`)).status, 404)
assert.equal((await json(`/api/class/${classToken}/top3`, { anonymous: true })).status, 404)
step('deleting the class removes its grades and its Top 3 page with it')

await fakeGoogle.close?.()
console.log(`\nall ${passed} grade steps passed`)
process.exit(0)
