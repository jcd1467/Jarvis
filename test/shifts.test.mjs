import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_STATE = join(mkdtempSync(join(tmpdir(), 'jarvis-shifts-')), 'state.json')
process.env.JARVIS_TIMEZONE = 'America/Detroit'
const { parseIcs, shiftItems } = await import('../bridge/shifts.mjs')
const { syncManaged, todosFor, listTools } = await import('../bridge/lists.mjs')

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:shift-1@w2w',
  'SUMMARY:Arbor Financial - Teller',
  'DTSTART;TZID=America/Detroit:20991115T150000',
  'DTEND;TZID=America/Detroit:20991115T200000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:shift-2@w2w',
  'SUMMARY:Arbor Financial',
  '  - Teller',
  'DTSTART:20991116T130000Z',
  'DTEND:20991116T170000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:dentist',
  'SUMMARY:Dentist',
  'DTSTART:20991115T090000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:gone',
  'SUMMARY:Arbor',
  'STATUS:CANCELLED',
  'DTSTART:20991117T090000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

test('parses local, UTC and folded events', () => {
  const ev = parseIcs(ICS)
  assert.equal(ev.length, 4)
  assert.deepEqual(ev[0].start, { date: '2099-11-15', time: '15:00' })
  // 13:00 UTC is 8:00 in Detroit in November (EST).
  assert.deepEqual(ev[1].start, { date: '2099-11-16', time: '08:00' })
  assert.equal(ev[1].title, 'Arbor Financial - Teller')
  assert.equal(ev[3].cancelled, true)
})

test('filters by text, skips cancelled, formats times', () => {
  const items = shiftItems(parseIcs(ICS), { today: '2099-11-14', match: 'arbor' })
  assert.deepEqual(
    items.map((i) => [i.date, i.text]),
    [
      ['2099-11-15', 'Work 3:00 PM–8:00 PM'],
      ['2099-11-16', 'Work 8:00 AM–12:00 PM'],
    ],
  )
})

test('sync adds, updates, removes — and leaves hand-made items alone', async () => {
  await listTools().find((t) => t.name === 'todo_add').handler({ text: 'Buy shoes', date: '2099-11-15' }, {})
  let r = syncManaged('shifts', [
    { key: 'a', date: '2099-11-15', text: 'Work 3:00 PM–8:00 PM' },
    { key: 'b', date: '2099-11-16', text: 'Work 8:00 AM–12:00 PM' },
  ])
  assert.deepEqual(r, { added: 2, updated: 0, removed: 0 })
  r = syncManaged('shifts', [{ key: 'a', date: '2099-11-15', text: 'Work 4:00 PM–9:00 PM' }])
  assert.deepEqual(r, { added: 0, updated: 1, removed: 1 })
  const day = todosFor('2099-11-15').map((t) => t.text).sort()
  assert.deepEqual(day, ['Buy shoes', 'Work 4:00 PM–9:00 PM'])
  assert.deepEqual(syncManaged('shifts', [{ key: 'a', date: '2099-11-15', text: 'Work 4:00 PM–9:00 PM' }]), {
    added: 0,
    updated: 0,
    removed: 0,
  })
})

test('past shifts do not carry over as unfinished tasks', () => {
  syncManaged('shifts', [{ key: 'old', date: '2000-01-01', text: 'Work 9:00 AM–1:00 PM' }])
  assert.equal(todosFor('2099-11-15').some((t) => t.text === 'Work 9:00 AM–1:00 PM'), false)
})
