import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_STATE = join(mkdtempSync(join(tmpdir(), 'jarvis-camp-')), 'state.json')
const { checkCaption, ssembleSettings } = await import('../bridge/campaigns.mjs')
const { listTools } = await import('../bridge/lists.mjs')
const tools = Object.fromEntries(listTools().map((t) => [t.name, t.handler]))
const call = async (n, a) => (await tools[n](a, {})).content[0].text

const DROP = {
  name: 'The Drop: TikTok Edits',
  requiredPhrases: ['Stream All Episodes of The Drop: A Snowfall Saga on Hulu'],
  requiredHashtags: ['#TheDropPartner'],
  onlyListedHashtags: true,
  minSeconds: 12,
  aiTools: 'restricted',
  outsideVisuals: false,
  audioChanges: false,
}

test('a correct caption passes, whatever the quote style or spacing', () => {
  const r = checkCaption(DROP, 'This scene 😳  stream all episodes of the drop: a snowfall saga on hulu #TheDropPartner', 20)
  assert.equal(r.pass, true, r.problems.join('; '))
})

test('missing text, missing tag, extra tags and short clips are all caught', () => {
  const r = checkCaption(DROP, 'Wild scene #fyp', 8)
  assert.equal(r.pass, false)
  assert.equal(r.problems.length, 4)
  assert.match(r.fixed, /Hulu/)
  assert.match(r.fixed, /#TheDropPartner/)
})

test('Ssemble settings follow the rules', () => {
  const s = ssembleSettings(DROP).join(' ')
  assert.match(s, /B-roll: OFF/)
  assert.match(s, /Sound effects and music: OFF/)
  assert.match(s, /Check first/)
  assert.match(ssembleSettings({ aiTools: 'not allowed' })[0], /Do not use Ssemble/)
})

test('save, look up, check and end through the tools', async () => {
  assert.match(await call('campaign_save', DROP), /Saved/)
  assert.match(await call('campaign_rules', { campaign: 'drop' }), /TheDropPartner/)
  assert.match(await call('caption_check', { campaign: 'the drop', caption: 'nope' }), /FAIL/)
  assert.match(await call('caption_check', { campaign: 'nothing saved' , caption: 'x' }), /No saved rules/)
  assert.match(await call('campaign_end', { campaign: 'drop' }), /ended/)
  assert.match(await call('campaign_rules', {}), /ended/)
})

test('a campaign that requires a platform he does not use is flagged', async () => {
  const { platformProblems } = await import('../bridge/campaigns.mjs')
  assert.equal(platformProblems({ requiredPlatforms: ['Instagram', 'TikTok'] }, ['TikTok', 'YouTube Shorts']).length, 1)
  assert.match(platformProblems({ requiredPlatforms: ['Instagram'] }, ['TikTok'])[0], /Instagram/)
  assert.equal(platformProblems({ requiredPlatforms: ['TikTok'] }, ['TikTok', 'YouTube Shorts']).length, 0)
  assert.equal(platformProblems({ postPlatforms: ['TikTok', 'Instagram'] }, ['TikTok']).length, 0)
  assert.match(await call('campaign_save', { name: 'Stream House LA', requiredPlatforms: ['Instagram', 'TikTok'] }), /WARNING/)
})

test('a required logo shows in the rules and the Ssemble settings', async () => {
  const c = { name: 'GTA test', logoRequired: true, logoRules: 'top-right, whole clip' }
  assert.match(ssembleSettings(c).join(' '), /Logo REQUIRED on every clip — top-right, whole clip/)
  assert.match(await call('campaign_save', c), /LOGO REQUIRED: top-right, whole clip/)
})
