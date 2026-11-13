// API test for two-person podcasts. Usage: node group-smoke.mjs <baseUrl> <fakeGooglePort> <container>
// Expects FIRSTMIC_MAX_SECONDS=10, the fake Google endpoints (see fake-google.mjs) and media from make-media.mjs.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fakeToken, startFakeGoogle } from './fake-google.mjs'

const [base = 'http://localhost:18101', googlePort = '18199', container = 'firstmic-e2e'] = process.argv.slice(2)
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

async function call(urlPath, { method, body, token, raw } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (raw) headers['Content-Type'] = 'application/octet-stream'
  if (token) headers.Authorization = `Bearer ${token}`
  else if (cookie) headers.Cookie = cookie
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

/** A live-call connection that remembers the latest group state the server pushed. */
function connect(token) {
  const ws = new WebSocket(`${wsBase}/ws?token=${token}`)
  const conn = { ws, group: null, closedWith: null, welcomed: false }
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.t === 'group') conn.group = msg.group
    if (msg.t === 'welcome') conn.welcomed = true
  })
  ws.addEventListener('close', (event) => (conn.closedWith = event.code))
  return conn
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

const group = async (token) => (await json('/api/group', { token })).data.group

async function uploadVoice(token, takeId, bytes, startOffsetMs) {
  const created = await json(`/api/group/takes/${takeId}/voice`, {
    token,
    body: { mimeType: 'audio/webm;codecs=opus', startOffsetMs, durationMs: 3000 },
  })
  assert.equal(created.status, 200, JSON.stringify(created.data))
  const again = await json(`/api/group/takes/${takeId}/voice`, {
    token,
    body: { mimeType: 'audio/webm;codecs=opus', startOffsetMs, durationMs: 3000 },
  })
  assert.equal(again.data.trackId, created.data.trackId, 'asking again returns the same voice track')
  const put = await call(`/api/tracks/${created.data.trackId}/chunks/0`, { method: 'PUT', token, raw: bytes })
  assert.equal(put.status, 200)
  const fin = await json(`/api/tracks/${created.data.trackId}/finalize`, { token, body: { finalChunkCount: 1, durationMs: 3000 } })
  assert.equal(fin.status, 200)
  return created.data.trackId
}

/** Records a take of about 2.5 s: `starter` taps Record, `stopper` taps Stop, both upload their voice. */
async function recordTake(starter, stopper, voices) {
  const started = await json('/api/group/takes', { token: starter, body: {} })
  assert.equal(started.status, 200, JSON.stringify(started.data))
  await sleep(2500)
  assert.equal((await json(`/api/group/takes/${started.data.takeId}/stop`, { token: stopper, body: {} })).status, 200)
  for (const [token, bytes, offset] of voices) {
    await uploadVoice(token, started.data.takeId, bytes, offset)
  }
  return started.data.takeId
}

const waitForStatus = (token, takeId, status) =>
  until(async () => {
    const g = await group(token)
    return g.take?.id === takeId && g.take.status === status ? g : null
  }, `take ${status}`)

/** Mean level (dB) of a file around 440 Hz and around 660 Hz, measured with the container's ffmpeg. */
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

// ---- Setup: a teacher, a class with a topic and four students, and a second class ----
assert.equal((await json('/api/auth/google', { body: { accessToken: fakeToken(`groups${Date.now()}@example.com`) } })).status, 200)
const classId = (await json('/api/teacher/classes', { body: { name: 'Room 12G' } })).data.class.id
const topic = (await json(`/api/teacher/classes/${classId}/topics`, { body: { title: 'Our school trip' } })).data.topic
const roster = (
  await json(`/api/teacher/classes/${classId}/students`, {
    body: { students: ['Ali', 'Sara', 'Omar', 'Lina'].map((name) => ({ name, emoji: '🦊' })) },
  })
).data.students
const byName = Object.fromEntries(roster.map((s) => [s.name, s]))
const classToken = (await json(`/api/teacher/classes/${classId}`)).data.class.classToken
const otherClassId = (await json('/api/teacher/classes', { body: { name: 'Room 12H' } })).data.class.id
await json(`/api/teacher/classes/${otherClassId}/topics`, { body: { title: 'Elsewhere' } })
const zed = (await json(`/api/teacher/classes/${otherClassId}/students`, { body: { students: [{ name: 'Zed', emoji: '🐼' }] } })).data.students[0]
const otherClassToken = (await json(`/api/teacher/classes/${otherClassId}`)).data.class.classToken
const teacherCookie = cookie

async function signIn(token, student) {
  const res = await json(`/api/class/${token}/sign-in`, { body: { studentId: student.id, pin: student.pin } })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  return res.data.studentToken
}
const logins = {}
for (const name of ['Ali', 'Sara', 'Omar', 'Lina']) logins[name] = await signIn(classToken, byName[name])
const zedLogin = await signIn(otherClassToken, zed)

// ---- Groups: create, PIN, join, full ----
const createGroup = (name) => json(`/api/class/${classToken}/groups`, { token: logins[name], body: { topicId: topic.id } })
const joinGroup = (name, pin, token = classToken, login = logins[name]) =>
  json(`/api/class/${token}/groups/join`, { token: login, body: { pin } })

const aliGroup = await createGroup('Ali')
assert.equal(aliGroup.status, 200, JSON.stringify(aliGroup.data))
assert.equal((await createGroup('Ali')).data.groupId, aliGroup.data.groupId, 'creating again returns the same group')
const ali = aliGroup.data.token
const first = await json('/api/group', { token: ali })
assert.match(first.data.group.pin, /^\d{6}$/)
assert.deepEqual(first.data.group.members.map((m) => m.name), ['Ali'])
assert.equal(first.data.group.topic.title, 'Our school trip')
const pin = first.data.group.pin
assert.equal((await json(`/api/class/${classToken}/groups`, { body: { topicId: topic.id } })).status, 401)
step('a student creates a group for a topic and gets a 6-digit group PIN; asking again returns the same group')

assert.equal((await joinGroup('Sara', pin === '000000' ? '111111' : '000000')).status, 404)
assert.equal((await joinGroup('Zed', pin, otherClassToken, zedLogin)).status, 404, 'the PIN only works in its own class')
const saraJoin = await joinGroup('Sara', pin)
assert.equal(saraJoin.status, 200, JSON.stringify(saraJoin.data))
assert.equal(saraJoin.data.groupId, aliGroup.data.groupId)
const sara = saraJoin.data.token
assert.equal((await joinGroup('Sara', pin)).data.token, sara, 'joining again returns the same membership')
assert.equal((await joinGroup('Ali', pin)).data.token, ali)
const omarJoin = await joinGroup('Omar', pin)
assert.equal(omarJoin.status, 409)
assert.match(omarJoin.data.error, /full/)
assert.deepEqual((await group(ali)).members.map((m) => m.name), ['Ali', 'Sara'])
step('a partner joins with the PIN; a third student is refused because the group is full; wrong or other-class PINs fail')

const linaGroup = await createGroup('Lina')
const linaPin = (await group(linaGroup.data.token)).pin
const omarOwn = await createGroup('Omar')
const omarJoinsLina = await joinGroup('Omar', linaPin)
assert.equal(omarJoinsLina.status, 200)
assert.equal((await json('/api/group', { token: omarOwn.data.token })).status, 401, "Omar's empty group is dropped")
assert.equal((await joinGroup('Lina', pin)).status, 409)
assert.match((await joinGroup('Ali', linaPin)).data.error, /full/)
step("joining a friend's group drops your own empty group for that topic; a member of a full group can't switch")

// ---- Tokens stay in their lane ----
assert.equal((await json('/api/student/episode', { token: ali })).status, 401)
assert.equal((await json(`/api/teacher/classes/${classId}`, { token: ali })).status, 401)
const soloEpisode = await json(`/api/class/${classToken}/episodes`, { token: logins.Ali, body: { topicId: topic.id } })
assert.equal((await json('/api/group', { token: soloEpisode.data.token })).status, 401)
const soloSocket = connect(soloEpisode.data.token)
await until(() => soloSocket.closedWith === 4401, 'solo token refused by the live call')
assert.equal((await json(`/api/group/takes/${'x'.repeat(21)}/mix`, { token: ali })).status, 404)
step("group tokens can't reach solo or teacher routes; a solo token can't join a live call")

// ---- Live call presence, and who controls a take ----
const aliConn = connect(ali)
await until(() => aliConn.welcomed && aliConn.group, 'Ali in the call')
const notYet = await json('/api/group/takes', { token: ali, body: {} })
assert.equal(notYet.status, 409)
assert.match(notYet.data.error, /Sara/)
const saraConn = connect(sara)
await until(() => aliConn.group?.members.every((m) => m.online), 'both online')
const take1 = await json('/api/group/takes', { token: ali, body: {} })
assert.equal(take1.status, 200)
const recording = await until(() => (saraConn.group?.take?.status === 'recording' ? saraConn.group.take : null), 'Sara sees recording')
assert.equal(recording.controllerId, first.data.selfId)
assert.equal((await json('/api/group/takes', { token: sara, body: {} })).status, 409, 'one take at a time')
assert.equal((await json(`/api/group/takes/${take1.data.takeId}/stop`, { token: sara, body: {} })).status, 403)
await sleep(2500)
assert.equal((await json(`/api/group/takes/${take1.data.takeId}/stop`, { token: ali, body: {} })).status, 200)
await until(() => saraConn.group?.take?.status === 'mixing', 'Sara sees mixing')
step('Record needs both students in the call; the student who tapped Record controls the take, the partner cannot stop it')

const aliTrack1 = await uploadVoice(ali, take1.data.takeId, tone440, 0)
await uploadVoice(sara, take1.data.takeId, tone660, 150)
await waitForStatus(ali, take1.data.takeId, 'listening')
await until(() => saraConn.group?.take?.status === 'listening', 'Sara is pushed the listening state')
const mixRes = await call(`/api/group/takes/${take1.data.takeId}/mix`, { token: sara })
assert.equal(mixRes.status, 200)
assert.equal(mixRes.headers.get('content-type'), 'audio/mpeg')
const preview = path.join(outDir, 'group-preview.mp3')
fs.writeFileSync(preview, Buffer.from(await mixRes.arrayBuffer()))
const previewLevels = toneLevels(preview)
assert.ok(previewLevels.a440 > -40 && previewLevels.a660 > -40, `preview mix has both voices ${JSON.stringify(previewLevels)}`)
assert.equal((await json(`/api/teacher/classes/${classId}`)).data.submissions.length, 0)
step('both voices upload after Stop, the server mixes them, and both students can play the mix (both tones present)')

assert.equal((await json(`/api/group/takes/${take1.data.takeId}/send`, { token: sara, body: {} })).status, 403)
assert.equal((await json(`/api/group/takes/${take1.data.takeId}/discard`, { token: sara, body: {} })).status, 403)
assert.equal((await json(`/api/group/takes/${take1.data.takeId}/discard`, { token: ali, body: {} })).status, 200)
assert.equal((await group(ali)).take, null)
assert.equal((await call(`/api/group/takes/${take1.data.takeId}/mix`, { token: ali })).status, 404)
assert.equal((await call(`/api/tracks/${aliTrack1}/chunks/1`, { method: 'PUT', token: ali, raw: tone440 })).status, 409)
step('only the controller can Save for Both or Try Again; Try Again throws the take and its mix away')

// ---- Send; the controller drops off, so the partner takes over ----
const take2 = await recordTake(ali, ali, [[ali, tone440, 0], [sara, tone660, 120]])
await waitForStatus(ali, take2, 'listening')
aliConn.ws.close()
await until(async () => (await group(sara)).members.find((m) => m.name === 'Ali')?.online === false, 'Ali offline')
const sent2 = await json(`/api/group/takes/${take2}/send`, { token: sara, body: {} })
assert.equal(sent2.status, 200, JSON.stringify(sent2.data))
assert.equal(sent2.data.version, 1)
const afterSend = await group(sara)
assert.equal(afterSend.take, null)
assert.equal(afterSend.sent.version, 1)
assert.equal((await call(`/api/group/takes/${take2}/mix`, { token: sara })).status, 200, 'the saved mix stays playable')
step('Save for Both saves the take; when the controller leaves, the partner takes over')

// ---- Each member gets their own copy in My Recordings, and decides whether to submit it ----
const mine = async (login) => (await json(`/api/class/${classToken}/recordings`, { token: login })).data
const recordingAudio = (login, id) => call(`/api/class/${classToken}/recordings/${id}/audio`, { token: login })
assert.equal((await json(`/api/teacher/classes/${classId}`)).data.submissions.length, 0, 'the group submits nothing itself')
const [aliCopy] = (await mine(logins.Ali)).recordings
const [saraCopy] = (await mine(logins.Sara)).recordings
assert.ok(aliCopy && saraCopy, 'both members have a copy')
assert.notEqual(aliCopy.id, saraCopy.id)
assert.equal(aliCopy.topicTitle, 'Our school trip')
assert.equal(aliCopy.withNames, 'Sara')
assert.equal(saraCopy.withNames, 'Ali')
assert.equal((await mine(logins.Ali)).submittedId, null)
const copyRes = await recordingAudio(logins.Ali, aliCopy.id)
assert.equal(copyRes.status, 200)
assert.equal(copyRes.headers.get('content-type'), 'audio/mpeg')
const copyFile = path.join(outDir, 'group-copy-ali.mp3')
fs.writeFileSync(copyFile, Buffer.from(await copyRes.arrayBuffer()))
const copyLevels = toneLevels(copyFile)
assert.ok(copyLevels.a440 > -40 && copyLevels.a660 > -40, `Ali's copy is the mix ${JSON.stringify(copyLevels)}`)
assert.equal((await recordingAudio(logins.Sara, aliCopy.id)).status, 404, "one student can't get another's copy")
console.log(`  copy levels: ${JSON.stringify(copyLevels)}`)
step('Save for Both puts a copy of the mix (both tones) in each member\'s My Recordings; the teacher gets nothing yet')

assert.equal((await json(`/api/class/${classToken}/recordings/${aliCopy.id}/submit`, { token: logins.Ali, body: {} })).status, 200)
assert.equal((await json(`/api/class/${classToken}/recordings/${saraCopy.id}`, { method: 'DELETE', token: logins.Sara })).status, 200)
assert.equal((await mine(logins.Ali)).submittedId, aliCopy.id)
assert.equal((await mine(logins.Sara)).recordings.length, 0)
const detail = (await json(`/api/teacher/classes/${classId}`)).data
assert.deepEqual(detail.submissions.map((sub) => [sub.student_name, sub.with_names]), [['Ali', 'Sara']])
assert.equal((await call(`/api/teacher/submissions/${aliCopy.id}/audio`)).status, 200)
step('Ali submits his copy and the teacher gets it (with Sara); Sara deletes hers and submits nothing')

// ---- A failed take changes nothing; then a new save ----
const aliConn2 = connect(ali)
await until(async () => (await group(ali)).members.every((m) => m.online), 'Ali back')
const take3 = await recordTake(ali, ali, [[ali, tone440, 0], [sara, Buffer.from('not audio at all'), 0]])
await waitForStatus(ali, take3, 'failed')
assert.equal((await group(ali)).sent.version, 1)
assert.equal((await mine(logins.Ali)).recordings.length, 1, 'a failed take saves nothing')
assert.equal((await mine(logins.Ali)).submittedId, aliCopy.id)
assert.equal((await json(`/api/group/takes/${take3}/discard`, { token: ali, body: {} })).status, 200)
step("a take whose voice cannot be processed fails; Ali's recordings and submission stay")

const take4 = await recordTake(sara, sara, [[ali, tone440, 0], [sara, tone660, 0]])
await waitForStatus(sara, take4, 'listening')
assert.equal((await json(`/api/group/takes/${take4}/send`, { token: sara, body: {} })).data.version, 2)
assert.equal((await call(`/api/group/takes/${take2}/mix`, { token: sara })).status, 404, 'the old saved mix is gone from the group')
const aliAfter = await mine(logins.Ali)
assert.equal(aliAfter.recordings.length, 2, 'the new save is added next to the first copy')
assert.equal(aliAfter.submittedId, aliCopy.id, 'the submission stays until Ali changes it')
assert.equal((await mine(logins.Sara)).recordings.length, 1)
assert.equal((await recordingAudio(logins.Ali, aliCopy.id)).status, 200, 'his first copy is his own file, still playable')
const aliNewCopy = aliAfter.recordings.find((r) => r.id !== aliCopy.id)
assert.equal((await json(`/api/class/${classToken}/recordings/${aliNewCopy.id}/submit`, { token: logins.Ali, body: {} })).status, 200)
assert.deepEqual((await json(`/api/teacher/classes/${classId}`)).data.submissions.map((sub) => sub.id), [aliNewCopy.id])
step('either student can start a take; a new save adds a copy for both, and Ali switches his submission to it')

// ---- The 3-minute limit (10 s here) is enforced by the server ----
const limited = await json('/api/group/takes', { token: ali, body: {} })
await until(() => (aliConn2.group?.take?.id === limited.data.takeId && aliConn2.group.take.status === 'mixing'), 'auto-stop', 20_000)
const stoppedTake = (await group(ali)).take
assert.ok(stoppedTake.durationMs >= 9500 && stoppedTake.durationMs <= 10_500, `stopped at ${stoppedTake.durationMs} ms`)
assert.equal((await json(`/api/group/takes/${limited.data.takeId}/discard`, { token: ali, body: {} })).status, 200)
step('the server stops a take at the time limit')

// ---- A new PIN signs the student out of the group; removing a student removes their group ----
const saraConn2 = connect(sara)
await until(() => saraConn2.welcomed, 'Sara connected')
const newPin = (await json(`/api/teacher/students/${byName.Sara.id}/new-pin`, { body: {} })).data.pin
await until(() => saraConn2.closedWith === 4401, "Sara's live call closed")
assert.equal((await json('/api/group', { token: sara })).status, 401)
const saraLogin2 = await signIn(classToken, { ...byName.Sara, pin: newPin })
const saraBack = await json(`/api/class/${classToken}/groups`, { token: saraLogin2, body: { topicId: topic.id } })
assert.equal(saraBack.data.groupId, aliGroup.data.groupId)
assert.equal((await group(saraBack.data.token)).sent.version, 2)
step('a new PIN closes the student\'s live call and replaces their group token; signing in again returns the same group')

assert.equal((await json(`/api/teacher/students/${byName.Sara.id}`, { method: 'DELETE' })).status, 200)
await until(() => aliConn2.closedWith === 4401, "Ali's call closed when the group was deleted")
assert.equal((await json('/api/group', { token: ali })).status, 401)
assert.ok(!(await json(`/api/teacher/classes/${classId}`)).data.submissions.some((sub) => sub.student_name === 'Sara'))
const left = execFileSync('docker', ['exec', container, 'sh', '-c', 'ls /data/submissions /data/chunks /data/media'], { encoding: 'utf8' })
assert.doesNotMatch(left, /\.mix\.mp3|\.voice\.mp3|aligned/, `leftover group files:\n${left}`)
assert.equal((await json(`/api/class/${classToken}/groups/join`, { token: logins.Omar, body: { pin } })).status, 404)
cookie = teacherCookie
step('removing a student deletes their group with its recordings and files, and closes the live call')

for (const conn of [aliConn, saraConn, aliConn2, saraConn2, soloSocket]) conn.ws.close()
fakeGoogle.close()
console.log(`\n${passed} group API steps passed`)
