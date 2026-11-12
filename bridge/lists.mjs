import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * JARVIS's own small lists: a dated to-do list and the latest clip totals.
 *
 * Kept in one JSON file under ~/.jarvis (JARVIS_STATE overrides the path),
 * outside the project folder, so it survives updates and never reaches git.
 * This is JARVIS's own memory, not the user's files — the read-only rule for
 * their folders is untouched.
 *
 * Every change is written to a temp file and renamed over the old one, so a
 * crash mid-write can never leave half a file behind.
 */

const PATH = process.env.JARVIS_STATE || join(homedir(), '.jarvis', 'state.json')
const TZ = process.env.JARVIS_TIMEZONE?.trim() || undefined
const MAX_TODOS = 500

/** YYYY-MM-DD in the user's zone. en-CA formats dates that way. */
export function localDate(d = new Date()) {
  try {
    return d.toLocaleDateString('en-CA', { timeZone: TZ })
  } catch {
    return d.toLocaleDateString('en-CA')
  }
}

function load() {
  try {
    const s = JSON.parse(readFileSync(PATH, 'utf8'))
    return { todos: Array.isArray(s.todos) ? s.todos : [], clips: s.clips ?? null, reports: s.reports ?? {} }
  } catch {
    return { todos: [], clips: null, reports: {} }
  }
}

function save(state) {
  mkdirSync(dirname(PATH), { recursive: true })
  const tmp = `${PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(tmp, PATH)
}

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''))

/**
 * What the widget shows: today's items, plus anything from an earlier day
 * still not done (flagged overdue), oldest first. Done items from earlier days
 * drop off.
 */
export function todosFor(date = localDate()) {
  const { todos } = load()
  return todos
    // Carry-over is for things to do. A synced item (a work shift) whose day
    // has passed is history, not an unfinished task.
    .filter((t) => t.date === date || (t.date < date && !t.done && !t.source))
    .map((t) => ({
      id: t.id,
      text: t.text,
      done: Boolean(t.done),
      overdue: t.date < date,
      date: t.date,
      synced: t.source ?? null,
    }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.date.localeCompare(b.date))
}

/**
 * Make the items from one outside source (e.g. 'shifts') match `items`, each
 * { key, date, text }. Matched by key: changed ones update in place (keeping
 * their done mark), new ones are added, and ones the source no longer lists
 * are removed — but only if today or later and not ticked off. Items the user
 * or JARVIS added by hand are never touched.
 */
export function syncManaged(source, items) {
  const state = load()
  const today = localDate()
  const want = new Map(items.map((it) => [it.key, it]))
  let added = 0
  let updated = 0
  let removed = 0
  const kept = []
  for (const t of state.todos) {
    if (t.source !== source) {
      kept.push(t)
      continue
    }
    const it = want.get(t.key)
    if (it) {
      if (t.date !== it.date || t.text !== it.text) {
        t.date = it.date
        t.text = it.text
        updated++
      }
      want.delete(t.key)
      kept.push(t)
    } else if (t.date >= today && !t.done) {
      removed++
    } else {
      kept.push(t)
    }
  }
  for (const it of want.values()) {
    kept.push({
      id: randomUUID().slice(0, 8),
      text: String(it.text).slice(0, 120),
      date: it.date,
      done: false,
      source,
      key: it.key,
      created: new Date().toISOString(),
    })
    added++
  }
  if (added || updated || removed) {
    state.todos = kept
    save(state)
  }
  return { added, updated, removed }
}

/** Save a team report (e.g. the daily scout run), replacing the last one. */
export function saveReport(kind, text) {
  const state = load()
  state.reports = { ...(state.reports ?? {}), [kind]: { date: localDate(), at: new Date().toISOString(), text: String(text).slice(0, 4000) } }
  save(state)
}

export function lastReport(kind) {
  return load().reports?.[kind] ?? null
}

export function clipTotals() {
  return load().clips
}

/** Tick or untick one item — the widget's click. Returns false if unknown. */
export function toggleTodo(id) {
  const state = load()
  const t = state.todos.find((x) => x.id === id)
  if (!t) return false
  t.done = !t.done
  t.doneAt = t.done ? new Date().toISOString() : null
  save(state)
  return true
}

const ok = (text) => ({ content: [{ type: 'text', text }] })

/** Find items by id or by words in their text; an exact id wins. */
function match(todos, ref) {
  const r = String(ref ?? '').trim().toLowerCase()
  if (!r) return []
  const byId = todos.filter((t) => t.id === r)
  if (byId.length) return byId
  return todos.filter((t) => t.text.toLowerCase().includes(r))
}

const describe = (t) => `${t.id} · ${t.date} · ${t.done ? 'done' : 'open'} · ${t.text}`

/**
 * @param {() => void} changed - called after every change, so the page can
 *   refresh its widgets at once instead of on its next poll
 */
export function listsServer(changed) {
  return createSdkMcpServer({
    name: 'jarvis_lists',
    version: '1.0.0',
    instructions:
      "The user's to-do list and their clip totals, both shown on their screen. " +
      'Use these, not Asana, whenever they say "to-do list" or "my list".',
    alwaysLoad: true,
    tools: listTools(changed),
  })
}

/** The tool definitions, separate from the server so tests can call them. */
export function listTools(changed = () => {}) {
  return [
      tool(
        'todo_add',
        `Add one item to their to-do list. Use it whenever they say "add … to my to-do list" or "remind me to … on Friday". Default the date to today; resolve "tomorrow" or a weekday from the time stamp on their message. Add each thing they list as its own item. Afterwards, say what you added and for which day in one short sentence.`,
        {
          text: z.string().describe('The item, as they said it, in a few words.'),
          date: z.string().optional().describe('YYYY-MM-DD in their local time. Omit for today.'),
        },
        async (args) => {
          const text = String(args.text ?? '').trim().slice(0, 120)
          if (!text) return ok('Nothing added — the item was empty.')
          const date = isDate(args.date) ? args.date : localDate()
          const state = load()
          const item = { id: randomUUID().slice(0, 8), text, date, done: false, created: new Date().toISOString() }
          state.todos.push(item)
          // Oldest finished items go first if the file ever grows large.
          if (state.todos.length > MAX_TODOS) {
            state.todos.sort((a, b) => Number(a.done ? 0 : 1) - Number(b.done ? 0 : 1) || a.date.localeCompare(b.date))
            state.todos = state.todos.slice(state.todos.length - MAX_TODOS)
          }
          save(state)
          changed()
          return ok(`Added: ${describe(item)}`)
        },
      ),
      tool(
        'todo_list',
        'Their to-do items for one day (default today), including unfinished items carried over from earlier days. Use it before marking or removing anything, and for "what\'s on my list".',
        { date: z.string().optional().describe('YYYY-MM-DD. Omit for today.') },
        async (args) => {
          const date = isDate(args.date) ? args.date : localDate()
          const items = todosFor(date)
          if (!items.length) return ok(`Nothing on the list for ${date}.`)
          return ok(
            items
              .map(
                (t) =>
                  `${t.id} · ${t.date}${t.overdue ? ' (carried over)' : ''}${t.synced === 'shifts' ? ' (work shift, synced from calendar)' : ''} · ${t.done ? 'done' : 'open'} · ${t.text}`,
              )
              .join('\n'),
          )
        },
      ),
      tool(
        'todo_done',
        'Mark an item done — or not done again with done=false. Identify it by id, or by words from its text. If the words match more than one open item, mark none and ask which they meant.',
        {
          item: z.string().describe('The id, or words from the item.'),
          done: z.boolean().optional().describe('false to un-tick. Default true.'),
        },
        async (args) => {
          const state = load()
          const want = args.done !== false
          const hits = match(state.todos, args.item).filter((t) => t.done !== want)
          if (!hits.length) return ok('No matching item to change.')
          if (hits.length > 1) return ok(`Several items match — ask which:\n${hits.map(describe).join('\n')}`)
          hits[0].done = want
          hits[0].doneAt = want ? new Date().toISOString() : null
          save(state)
          changed()
          return ok(`${want ? 'Done' : 'Re-opened'}: ${describe(hits[0])}`)
        },
      ),
      tool(
        'todo_remove',
        'Remove an item they asked to remove, by id or words from its text. Only remove what they named; if the words match more than one item, remove none and ask which.',
        { item: z.string().describe('The id, or words from the item.') },
        async (args) => {
          const state = load()
          const hits = match(state.todos, args.item)
          if (!hits.length) return ok('No matching item.')
          if (hits.length > 1) return ok(`Several items match — ask which:\n${hits.map(describe).join('\n')}`)
          state.todos = state.todos.filter((t) => t !== hits[0])
          save(state)
          changed()
          return ok(`Removed: ${describe(hits[0])}`)
        },
      ),
      tool(
        'team_report',
        "The latest unattended report from the team — today the daily scout run (paid clipping campaigns worth his time). Read it for the morning brief and whenever he asks what the scout found. Says when it was written; anything not from today is stale.",
        { kind: z.string().optional().describe('Which report. Default "scout".') },
        async (args) => {
          const r = lastReport(String(args.kind ?? 'scout'))
          if (!r) return ok('No report yet.')
          return ok(`Written ${r.at} (${r.date === localDate() ? 'today' : 'not today'}):\n${r.text}`)
        },
      ),
      tool(
        'clips_record',
        'Save the clip totals you have just read from their Clip Tracker and dashboards, so the CLIPS widget on their screen shows them. Only numbers you actually read — never estimates. Call it after building the clip earnings dashboard. Silent: do not mention it.',
        {
          clips: z.number().optional().describe('How many clips are tracked.'),
          views: z.number().optional().describe('Total views across them.'),
          earnings: z.number().optional().describe('Total earnings in dollars.'),
          best: z.string().optional().describe('The best clip, a few words.'),
          best_views: z.number().optional().describe('Views on the best clip.'),
        },
        async (args) => {
          const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
          const state = load()
          state.clips = {
            clips: n(args.clips),
            views: n(args.views),
            earnings: n(args.earnings),
            best: args.best ? String(args.best).slice(0, 60) : null,
            bestViews: n(args.best_views),
            updatedAt: new Date().toISOString(),
          }
          save(state)
          changed()
          return ok('Saved.')
        },
      ),
  ]
}
