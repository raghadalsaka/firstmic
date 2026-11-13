// API smoke test for First Mic phase one. Usage: node api-smoke.mjs <baseUrl> <fakeGooglePort> <toneWebmPath>
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { fakeToken, startFakeGoogle } from './fake-google.mjs'

const [base = 'http://localhost:18101', googlePort = '18199', tonePath = './media/tone.webm'] = process.argv.slice(2)
const tone = fs.readFileSync(tonePath)
const fakeGoogle = await startFakeGoogle(Number(googlePort))
let cookie = ''
let passed = 0

function step(name) {
  passed++
  console.log(`ok ${passed} - ${name}`)
}

async function call(path, { method, body, token, raw, headers = {} } = {}) {
  const h = { ...headers }
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json'
  if (raw) h['Content-Type'] = 'application/octet-stream'
  if (token) h.Authorization = `Bearer ${token}`
  else if (cookie) h.Cookie = cookie
  const res = await fetch(base + path, {
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers: h,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie && !token) cookie = setCookie.split(';')[0]
  return res
}

async function json(path, opts) {
  const res = await call(path, opts)
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function sendTake(token, bytes) {
  const created = await json('/api/student/submissions', { token, body: { mimeType: 'audio/webm;codecs=opus', durationMs: 4000 } })
  assert.equal(created.status, 200, JSON.stringify(created.data))
  const put = await call(`/api/tracks/${created.data.trackId}/chunks/0`, { method: 'PUT', token, raw: bytes })
  assert.equal(put.status, 200)
  const fin = await json(`/api/tracks/${created.data.trackId}/finalize`, { token, body: { finalChunkCount: 1, durationMs: 4000 } })
  assert.equal(fin.status, 200)
  for (let i = 0; i < 60; i++) {
    const s = await json(`/api/student/submissions/${created.data.submissionId}`, { token })
    if (s.data.status !== 'sending') return { ...created.data, ...s.data }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('submission never settled')
}

// Teachers sign in with Google; the server checks every token with Google before trusting it
assert.equal((await json('/api/auth/google', { body: { accessToken: 'not-a-google-token' } })).status, 401)
assert.equal((await json('/api/auth/google', { body: { accessToken: 'fake-otherapp.t@example.com' } })).status, 401)
assert.equal((await json('/api/auth/google', { body: { accessToken: fakeToken('unverified@example.com') } })).status, 403)
assert.equal((await json('/api/auth/register', { body: { email: 't@example.com', name: 'T', password: 'password123' } })).status, 404)
assert.equal(cookie, '')
const signIn = await json('/api/auth/google', { body: { accessToken: fakeToken('t@example.com') } })
assert.equal(signIn.status, 200)
assert.equal(signIn.data.user.email, 't@example.com')
assert.equal((await json('/api/auth/me')).data.user.name, 'T')
step('Google sign-in: tokens for another app, unverified emails and password sign-up are refused')

const cls = await json('/api/teacher/classes', { body: { name: 'Room 12B' } })
const classId = cls.data.class.id
const t1 = await json(`/api/teacher/classes/${classId}/topics`, { body: { title: 'My favourite animal' } })
const t2 = await json(`/api/teacher/classes/${classId}/topics`, { body: { title: 'A day at school' } })
assert.equal((await json(`/api/teacher/classes/${classId}/topic-order`, { method: 'PUT', body: { topicIds: [t2.data.topic.id, t1.data.topic.id] } })).status, 200)
assert.equal((await json(`/api/teacher/classes/${classId}/topic-order`, { method: 'PUT', body: { topicIds: [t2.data.topic.id] } })).status, 400)
let detail = await json(`/api/teacher/classes/${classId}`)
const classToken = detail.data.class.classToken
assert.deepEqual(detail.data.topics.map((t) => t.title), ['A day at school', 'My favourite animal'])
step('class, topics and ordering')

assert.equal((await json('/api/class/not-a-real-token')).status, 404)
const pub = await json(`/api/class/${classToken}`)
assert.equal(pub.data.topics.length, 2)
assert.equal(pub.data.maxSeconds, 10)
assert.equal(pub.data.class.name, 'Room 12B')
const publicList = await fetch(`${base}/api/classes`).then((r) => r.json())
assert.ok(publicList.classes.some((c) => c.name === 'Room 12B' && c.classToken === classToken))
step('the home page list shows the class; the class link shows active topics and the time limit')

// Roster: the teacher adds students; a typed PIN is kept, a missing one is made
const added = await json(`/api/teacher/classes/${classId}/students`, {
  body: { students: [{ name: '  Ali  ', emoji: '🦊', pin: '012345' }, { name: 'Sara', emoji: '🐼' }] },
})
assert.equal(added.status, 200, JSON.stringify(added.data))
const [ali, sara] = added.data.students
assert.equal(ali.name, 'Ali')
assert.equal(ali.pin, '012345')
assert.match(sara.pin, /^\d{6}$/)
assert.notEqual(sara.pin, ali.pin)
assert.equal((await json(`/api/teacher/classes/${classId}/students`, { body: { students: [{ name: 'Copy', emoji: '🐸', pin: '012345' }] } })).status, 409)
assert.equal((await json(`/api/teacher/classes/${classId}/students`, { body: { students: [{ name: 'Bad', emoji: '🐸', pin: '12345' }] } })).status, 400)
const roster = (await json(`/api/class/${classToken}`)).data.students
assert.deepEqual(roster.map((s) => s.name), ['Ali', 'Sara'])
assert.ok(roster.every((s) => !('pin' in s)), 'PINs must never reach the public class page')
step('teacher adds students with typed and generated PINs; the class page lists names without PINs')

const topicId = t1.data.topic.id
const signIn1 = async (student, pin) => json(`/api/class/${classToken}/sign-in`, { body: { studentId: student.id, pin } })
assert.equal((await json(`/api/class/${classToken}/episodes`, { body: { topicId } })).status, 401)
for (let i = 0; i < 4; i++) {
  assert.equal((await signIn1(sara, '000000' === sara.pin ? '111111' : '000000')).status, 401)
}
const locked = await signIn1(sara, '000000' === sara.pin ? '111111' : '000000')
assert.equal(locked.status, 429)
assert.equal((await signIn1(sara, sara.pin)).status, 429, 'a locked student stays locked even with the right PIN')
step('a wrong PIN is refused, and 5 wrong PINs lock the student out')

const deviceA = await signIn1(ali, '012345')
assert.equal(deviceA.status, 200)
const deviceB = await signIn1(ali, '012345')
assert.equal((await json(`/api/class/${classToken}/me`, { token: deviceA.data.studentToken })).data.student.name, 'Ali')
const ep = await json(`/api/class/${classToken}/episodes`, { token: deviceA.data.studentToken, body: { topicId } })
assert.equal(ep.status, 200)
const epOtherDevice = await json(`/api/class/${classToken}/episodes`, { token: deviceB.data.studentToken, body: { topicId } })
assert.equal(epOtherDevice.data.episodeId, ep.data.episodeId, 'one student gets one episode per topic on every device')
const tokenA = ep.data.token
const me = await json('/api/student/episode', { token: tokenA })
assert.equal(me.data.episode.studentName, 'Ali')
step('the student signs in with the right PIN and gets the same episode on two devices')

assert.equal((await call(`/api/teacher/classes/${classId}`, { token: tokenA })).status, 401)
assert.equal((await json('/api/student/submissions', { token: tokenA, body: { mimeType: 'video/webm', durationMs: 1000 } })).status, 400)
assert.equal((await json('/api/student/submissions', { token: tokenA, body: { mimeType: 'audio/webm', durationMs: 999_000 } })).status, 400)
step('student token cannot reach teacher routes; bad uploads rejected')

// ---- My Recordings: saving adds to the student's list; they submit one to the teacher ----
let aliLogin = deviceA.data.studentToken
let currentClassToken = classToken
const myRecordings = async (login = aliLogin) =>
  (await json(`/api/class/${currentClassToken}/recordings`, { token: login })).data
const submit = (id, login = aliLogin) => json(`/api/class/${currentClassToken}/recordings/${id}/submit`, { token: login, body: {} })

const v1 = await sendTake(tokenA, tone)
assert.equal(v1.status, 'ready')
let mine = await myRecordings()
assert.deepEqual(mine.recordings.map((r) => r.id), [v1.submissionId])
assert.equal(mine.recordings[0].topicTitle, 'My favourite animal')
assert.equal(mine.recordings[0].withNames, null)
assert.equal(mine.submittedId, null)
detail = await json(`/api/teacher/classes/${classId}`)
assert.equal(detail.data.submissions.length, 0, 'saving does not submit')
assert.equal((await call(`/api/teacher/submissions/${v1.submissionId}/audio`)).status, 404)
const own = await call(`/api/class/${currentClassToken}/recordings/${v1.submissionId}/audio`, { token: aliLogin })
assert.equal(own.status, 200)
assert.equal(own.headers.get('content-type'), 'audio/mpeg')
step('Save puts the recording in My Recordings, where the student can play it; the teacher gets nothing yet')

const submitted1 = await submit(v1.submissionId)
assert.equal(submitted1.status, 200)
assert.equal((await myRecordings()).submittedId, v1.submissionId)
detail = await json(`/api/teacher/classes/${classId}`)
assert.equal(detail.data.submissions.length, 1)
assert.equal(detail.data.submissions[0].student_name, 'Ali')
assert.equal(detail.data.submissions[0].id, v1.submissionId)
const audio = await call(`/api/teacher/submissions/${v1.submissionId}/audio`)
assert.equal(audio.status, 200)
assert.equal(audio.headers.get('content-type'), 'audio/mpeg')
assert.equal(audio.headers.get('content-disposition'), null)
const mp3 = Buffer.from(await audio.arrayBuffer())
fs.writeFileSync(new URL('./media/smoke-v1.mp3', import.meta.url), mp3)
const ranged = await call(`/api/teacher/submissions/${v1.submissionId}/audio`, { headers: { Range: 'bytes=0-99' } })
assert.equal(ranged.status, 206)
const dl = await call(`/api/teacher/submissions/${v1.submissionId}/audio?download=1`)
assert.match(dl.headers.get('content-disposition'), /attachment; filename="Room-12B-My-favourite-animal-Ali-v1\.mp3"/)
step(`Submit hands it to the teacher, who plays (${mp3.length} bytes), seeks and downloads it`)

const v2 = await sendTake(tokenA, tone)
mine = await myRecordings()
assert.deepEqual(new Set(mine.recordings.map((r) => r.id)), new Set([v1.submissionId, v2.submissionId]))
assert.equal(mine.submittedId, v1.submissionId, 'saving another keeps the submission')
assert.equal((await submit(v2.submissionId)).status, 200)
detail = await json(`/api/teacher/classes/${classId}`)
assert.deepEqual(detail.data.submissions.map((s) => s.id), [v2.submissionId])
assert.equal((await call(`/api/teacher/submissions/${v1.submissionId}/audio`)).status, 404, 'the teacher only gets the submitted one')
assert.equal((await call(`/api/class/${currentClassToken}/recordings/${v1.submissionId}/audio`, { token: aliLogin })).status, 200, 'v1 stays in My Recordings')
step('a second recording is saved alongside the first; submitting it changes what the teacher has')

const bad = await sendTake(tokenA, Buffer.from('this is not audio at all'.repeat(50)))
assert.equal(bad.status, 'failed')
mine = await myRecordings()
assert.equal(mine.recordings.length, 2, 'a failed save adds nothing')
assert.equal(mine.submittedId, v2.submissionId)
step('a failed save adds nothing and leaves the submission alone')

assert.equal((await json(`/api/class/${currentClassToken}/recordings/${v2.submissionId}`, { method: 'DELETE', token: aliLogin })).status, 409)
assert.equal((await json(`/api/class/${currentClassToken}/recordings/${v1.submissionId}`, { method: 'DELETE', token: aliLogin })).status, 200)
assert.deepEqual((await myRecordings()).recordings.map((r) => r.id), [v2.submissionId])
step('a student deletes a recording they did not submit; the submitted one cannot be deleted')

assert.equal((await json(`/api/teacher/classes/${classId}/deadline`, { method: 'PUT', body: { deadline: Date.now() - 60_000 } })).status, 200)
const late = await sendTake(tokenA, tone)
assert.equal(late.status, 'ready', 'recording still works after the deadline')
const lateSubmit = await submit(late.submissionId)
assert.equal(lateSubmit.status, 409)
assert.match(lateSubmit.data.error, /deadline/)
assert.equal((await myRecordings()).submittedId, v2.submissionId)
assert.ok((await myRecordings()).deadline < Date.now())
assert.equal((await json(`/api/teacher/classes/${classId}/deadline`, { method: 'PUT', body: { deadline: Date.now() + 3_600_000 } })).status, 200)
assert.equal((await submit(late.submissionId)).status, 200)
assert.equal((await json(`/api/teacher/classes/${classId}/deadline`, { method: 'PUT', body: { deadline: null } })).status, 200)
assert.equal((await json(`/api/teacher/classes/${classId}`)).data.class.deadline, null)
assert.equal((await json(`/api/teacher/classes/${classId}/deadline`, { method: 'PUT', body: { deadline: 'soon' } })).status, 400)
step('after the deadline students can still save but not submit; a later deadline opens it again')

const unfinished = await json('/api/student/submissions', { token: tokenA, body: { mimeType: 'audio/webm', durationMs: 1000 } })
await json('/api/student/submissions', { token: tokenA, body: { mimeType: 'audio/webm', durationMs: 1000 } })
assert.equal((await call(`/api/tracks/${unfinished.data.trackId}/chunks/0`, { method: 'PUT', token: tokenA, raw: tone })).status, 409)
assert.equal((await json(`/api/student/submissions/${unfinished.data.submissionId}`, { token: tokenA })).data.status, 'failed')
step('a newer take stops an unfinished one from taking more uploads')

const third = (await json(`/api/teacher/classes/${classId}/students`, { body: { students: [{ name: 'Omar', emoji: '🐯', pin: '222222' }] } })).data.students[0]
const omarLogin = await signIn1(third, '222222')
const epB = await json(`/api/class/${classToken}/episodes`, { token: omarLogin.data.studentToken, body: { topicId } })
const tokenB = epB.data.token
assert.equal((await json(`/api/student/submissions/${v2.submissionId}`, { token: tokenB })).status, 404)
assert.equal((await call(`/api/tracks/${v2.trackId}/chunks/5`, { method: 'PUT', token: tokenB, raw: tone })).status, 404)
assert.equal((await call(`/api/class/${classToken}/recordings/${v2.submissionId}/audio`, { token: omarLogin.data.studentToken })).status, 404)
assert.equal((await submit(v2.submissionId, omarLogin.data.studentToken)).status, 404)
assert.equal((await json(`/api/class/${classToken}/recordings/${v2.submissionId}`, { method: 'DELETE', token: omarLogin.data.studentToken })).status, 404)
step("one student cannot see, submit, delete or upload into another student's recordings")

await json(`/api/teacher/topics/${t2.data.topic.id}`, { method: 'PATCH', body: { active: false } })
assert.equal((await json(`/api/class/${classToken}/episodes`, { token: omarLogin.data.studentToken, body: { topicId: t2.data.topic.id } })).status, 404)
assert.equal((await json(`/api/class/${classToken}`)).data.topics.length, 1)
step('hidden topics disappear from the class link')

const rotated = await json(`/api/teacher/classes/${classId}/class-link`, { method: 'POST' })
assert.equal((await json(`/api/class/${classToken}`)).status, 404)
assert.equal((await json(`/api/class/${rotated.data.classToken}`)).status, 200)
currentClassToken = rotated.data.classToken
step('new class link replaces the old one')

assert.equal((await json(`/api/teacher/submissions/${late.submissionId}`, { method: 'DELETE' })).status, 200)
detail = await json(`/api/teacher/classes/${classId}`)
assert.equal(detail.data.submissions.length, 0)
mine = await myRecordings()
assert.equal(mine.submittedId, null)
assert.ok(!mine.recordings.some((r) => r.id === late.submissionId))
step('teacher deletes a submitted recording; the student can submit another')

const newPin = await json(`/api/teacher/students/${ali.id}/new-pin`, { method: 'POST' })
assert.match(newPin.data.pin, /^\d{6}$/)
assert.equal((await json(`/api/class/${currentClassToken}/me`, { token: aliLogin })).status, 401)
assert.equal((await json('/api/student/episode', { token: tokenA })).status, 401, 'the old upload token must stop working')
assert.equal((await json('/api/student/submissions', { token: tokenA, body: { mimeType: 'audio/webm', durationMs: 1000 } })).status, 401)
assert.equal((await json(`/api/class/${currentClassToken}/recordings`, { token: aliLogin })).status, 401)
assert.equal((await json(`/api/class/${currentClassToken}/sign-in`, { body: { studentId: ali.id, pin: '012345' } })).status, 401)
const aliNewLogin = await json(`/api/class/${currentClassToken}/sign-in`, { body: { studentId: ali.id, pin: newPin.data.pin } })
assert.equal(aliNewLogin.status, 200)
aliLogin = aliNewLogin.data.studentToken
assert.deepEqual((await myRecordings()).recordings.map((r) => r.id), [v2.submissionId])
step('a new PIN signs the student out everywhere, upload tokens included; their recordings stay')

const aliEpisode = await json(`/api/class/${currentClassToken}/episodes`, { token: aliLogin, body: { topicId } })
const omarSaved = await sendTake(tokenB, tone)
assert.equal(omarSaved.status, 'ready')
assert.equal((await submit(omarSaved.submissionId, omarLogin.data.studentToken)).status, 200)
assert.equal((await json(`/api/teacher/students/${third.id}`, { method: 'DELETE' })).status, 200)
detail = await json(`/api/teacher/classes/${classId}`)
assert.ok(!detail.data.students.some((s) => s.id === third.id))
assert.equal(detail.data.submissions.length, 0)
assert.equal((await call(`/api/teacher/submissions/${omarSaved.submissionId}/audio`)).status, 404)
step('removing a student removes their recordings and submission')

assert.equal((await submit(v2.submissionId)).status, 200)
assert.equal((await json(`/api/teacher/classes/${classId}`)).data.submissions.length, 1)
assert.equal((await json(`/api/teacher/topics/${topicId}`, { method: 'DELETE' })).status, 200)
detail = await json(`/api/teacher/classes/${classId}`)
assert.ok(!detail.data.topics.some((t) => t.id === topicId))
assert.equal(detail.data.submissions.length, 0)
assert.equal((await call(`/api/teacher/submissions/${v2.submissionId}/audio`)).status, 404)
assert.equal((await myRecordings()).recordings.length, 0)
assert.equal((await myRecordings()).submittedId, null)
assert.equal((await json('/api/student/episode', { token: aliEpisode.data.token })).status, 401)
assert.equal((await json(`/api/teacher/topics/${topicId}`, { method: 'DELETE' })).status, 404)
step('deleting a topic deletes every recording made for it, submitted ones included')

fakeGoogle.close()
console.log(`\nall ${passed} steps passed`)
