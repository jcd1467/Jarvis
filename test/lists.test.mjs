import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the store at a throwaway file before the module reads its path.
process.env.JARVIS_STATE = join(mkdtempSync(join(tmpdir(), 'jarvis-lists-')), 'state.json')
const { listTools, todosFor, localDate, toggleTodo } = await import('../bridge/lists.mjs')

const tools = Object.fromEntries(listTools().map((t) => [t.name, t.handler]))
const call = async (name, args) => (await tools[name](args, {})).content[0].text

test('add, list, done, remove', async () => {
  const today = localDate()
  assert.match(await call('todo_add', { text: 'Finish homework' }), /Added/)
  assert.match(await call('todo_add', { text: 'Make clips', date: '2099-01-01' }), /2099-01-01/)
  assert.equal(todosFor(today).length, 1, 'future item not shown today')

  assert.match(await call('todo_done', { item: 'homework' }), /^Done/)
  assert.equal(todosFor(today)[0].done, true)
  assert.match(await call('todo_done', { item: 'homework', done: false }), /Re-opened/)

  await call('todo_add', { text: 'Make thumbnails' })
  assert.match(await call('todo_remove', { item: 'make' }), /Several items match/, 'ambiguous removes nothing')
  assert.match(await call('todo_remove', { item: 'thumbnails' }), /Removed/)
  assert.match(await call('todo_list', {}), /Finish homework/)
})

test('carried-over items, and the click toggle', async () => {
  await call('todo_add', { text: 'Old task', date: '2000-01-01' })
  const carried = todosFor().find((t) => t.text === 'Old task')
  assert.equal(carried.overdue, true)
  assert.equal(toggleTodo(carried.id), true)
  assert.equal(todosFor().some((t) => t.text === 'Old task'), false, 'done old items drop off')
  assert.equal(toggleTodo('nope'), false)
})

test('clip totals keep only real numbers', async () => {
  await call('clips_record', { views: 12000, earnings: 11.5, clips: 4, best: 'MrBeast reaction', best_views: -5 })
  const { clipTotals } = await import('../bridge/lists.mjs')
  const c = clipTotals()
  assert.equal(c.views, 12000)
  assert.equal(c.bestViews, null)
})

test('team reports are saved and read back', async () => {
  const { saveReport, lastReport } = await import('../bridge/lists.mjs')
  saveReport('scout', 'Top campaign: example (source)')
  assert.equal(lastReport('scout').text, 'Top campaign: example (source)')
  const report = listTools().find((t) => t.name === 'team_report')
  assert.match((await report.handler({}, {})).content[0].text, /today/)
})

test('pages are remembered and looked up', async () => {
  const t = Object.fromEntries(listTools().map((x) => [x.name, x.handler]))
  assert.match((await t.page_remember({ name: 'TikTok Studio content', url: 'https://www.tiktok.com/tiktokstudio/content' }, {})).content[0].text, /Remembered/)
  assert.match((await t.page_remember({ name: 'bad', url: 'javascript:alert(1)' }, {})).content[0].text, /Not saved/)
  assert.match((await t.page_lookup({ name: 'tiktok' }, {})).content[0].text, /tiktokstudio/)
})

test('ssemble credits are counted per billing period', async () => {
  process.env.JARVIS_SSEMBLE_CREDITS = '70'
  process.env.JARVIS_SSEMBLE_RENEW_DAY = '1'
  const { creditStatus } = await import('../bridge/lists.mjs')
  const t = Object.fromEntries(listTools().map((x) => [x.name, x.handler]))
  const before = creditStatus().used
  assert.match((await t.ssemble_credits({ action: 'use', credits: 4, note: 'Kai stream' }, {})).content[0].text, /left/)
  assert.equal(creditStatus().used, before + 4)
  assert.equal(creditStatus().left, 70 - before - 4)
  assert.match((await t.ssemble_credits({ action: 'use', credits: 0 }, {})).content[0].text, /Not recorded/)
  assert.match(creditStatus().renews, /^\d{4}-\d{2}-01$/)
})
