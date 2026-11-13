// Renders the home page and student screens in WebKit (Safari's engine) at iPhone size. Layout only:
// Playwright's WebKit has no fake microphone, so this cannot record.
// Usage: node webkit-layout.mjs <baseUrl> <fakeGooglePort> <outDir>
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { webkit, devices } from 'playwright'
import { fakeToken, startFakeGoogle } from './fake-google.mjs'

const [base = 'http://localhost:18101', googlePort = '18199', outDir = './out'] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const fakeGoogle = await startFakeGoogle(Number(googlePort))

const browser = await webkit.launch()
const setup = await browser.newContext()
const api = setup.request
await api.post(`${base}/api/auth/google`, { data: { accessToken: fakeToken(`wk${Date.now()}@example.com`) } })
const created = await (await api.post(`${base}/api/teacher/classes`, { data: { name: 'WebKit Class' } })).json()
await api.post(`${base}/api/teacher/classes/${created.class.id}/topics`, { data: { title: 'A very long topic title to check wrapping on small phones' } })
const names = ['Noor', 'Abdulrahman Al-Hashimi', 'سارة', 'Li', 'Maximilian', 'Zoë']
await api.post(`${base}/api/teacher/classes/${created.class.id}/students`, {
  data: { students: names.map((name, i) => ({ name, emoji: ['🦊', '🐼', '🐯', '🦁', '🐸', '🐙'][i], pin: `20000${i}` })) },
})

const ctx = await browser.newContext({ ...devices['iPhone 13'] })
const page = await ctx.newPage()
await page.goto(base)
const steps = [
  ['home', async () => {
    await page.getByRole('link', { name: 'WebKit Class' }).waitFor()
  }],
  ['names', async () => {
    await page.getByRole('link', { name: 'WebKit Class' }).click()
    await page.getByRole('heading', { name: 'Who are you?' }).waitFor()
  }],
  ['pin', async () => {
    await page.getByRole('button', { name: 'Noor' }).click()
    await page.getByLabel('Type your PIN').fill('200000')
  }],
  ['topics', async () => {
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByText('Pick a topic').waitFor()
  }],
  ['join-partner', async () => {
    await page.getByRole('button', { name: 'Join a Partner' }).click()
    await page.getByLabel("Type your partner's group PIN").waitFor()
  }],
  ['choose', async () => {
    await page.getByRole('button', { name: 'Back' }).click()
    await page.getByRole('button', { name: /A very long topic/ }).click()
    await page.getByText('How do you want to record?').waitFor()
  }],
  ['record', async () => {
    await page.getByRole('button', { name: 'On My Own' }).click()
    await page.getByText('Your topic').waitFor()
  }],
]
for (const [name, run] of steps) {
  await run()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 0, `${name}: horizontal overflow ${overflow}px`)
  await page.screenshot({ path: path.join(outDir, `webkit-iphone13-${name}.png`), fullPage: true })
  console.log(`ok - webkit ${name} screen fits (${await page.evaluate(() => window.innerWidth)}px wide)`)
}
const recordState = (await page.getByRole('button', { name: 'Record' }).count())
  ? 'Record button shown'
  : (await page.locator('[role=alert]').first().innerText().catch(() => 'no Record button'))
console.log(`  record screen in Playwright WebKit: ${recordState}`)
await browser.close()
fakeGoogle.close()
