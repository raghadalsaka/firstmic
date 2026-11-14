// Podcast Guide and timer helpers shared by solo-e2e.mjs and group-e2e.mjs.
import assert from 'node:assert/strict'

export const guideButton = (page) => page.getByRole('button', { name: /Podcast Guide/ })

/** Keys of the guide sections the student can see right now, in order. */
export const shownSections = (page) =>
  page
    .locator('[data-testid="podcast-guide"] section')
    .evaluateAll((els) => els.filter((el) => el.offsetParent).map((el) => el.dataset.testid.replace('guide-', '')))

export async function toggleGuide(page, open) {
  await guideButton(page).click()
  assert.equal(await guideButton(page).getAttribute('aria-expanded'), String(open))
  assert.equal((await guideButton(page).innerText()).trim(), open ? 'Hide Podcast Guide' : 'View Podcast Guide')
}

export async function clockSeconds(page) {
  const [minutes, seconds] = (await page.getByRole('timer').innerText()).split('/')[0].trim().split(':').map(Number)
  return minutes * 60 + seconds
}
