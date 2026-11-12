/**
 * Work shifts from a calendar feed, onto the to-do list, on a timer.
 *
 * No model involved: the bridge fetches an iCal (.ics) feed — the private
 * "secret address in iCal format" Google Calendar gives every calendar, or a
 * scheduling app's own iCal export — reads the upcoming events, and syncs them
 * into the to-do list as items JARVIS manages. Changed shifts update, removed
 * ones disappear, and the user's own items are never touched.
 *
 * Settings (.env.local):
 *   JARVIS_SHIFTS_ICS      the feed URL. It is a secret — anyone with it can
 *                          read that calendar — so it is never logged.
 *   JARVIS_SHIFTS_MATCH    only events whose title contains this text (case
 *                          insensitive), e.g. "Arbor" — for a feed that also
 *                          carries other events. Default: every event.
 *   JARVIS_SHIFTS_LABEL    what each item starts with. Default "Work".
 *   JARVIS_SHIFTS_DAYS     how far ahead to sync. Default 21.
 *   JARVIS_SHIFTS_MINUTES  how often to check. Default 30.
 */

import { localDate, syncManaged } from './lists.mjs'

const TZ = process.env.JARVIS_TIMEZONE?.trim() || undefined

/** Undo RFC 5545 line folding: a line starting with a space continues the last. */
function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '')
}

const unescape = (v) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim()

/**
 * A DTSTART/DTEND value as { date: 'YYYY-MM-DD', time: 'HH:MM' | null } in the
 * user's zone. UTC times (…Z) are converted; times with a TZID, or floating
 * times, are taken as already local — a work schedule's zone is the user's.
 */
function when(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, , z] = m
  if (h == null) return { date: `${y}-${mo}-${d}`, time: null }
  if (!z) return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` }
  const utc = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi))
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(utc)
      .map((p) => [p.type, p.value]),
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

/** The VEVENTs in a feed: uid, title, start, end, and whether cancelled. */
export function parseIcs(text) {
  const events = []
  let cur = null
  for (const line of unfold(text).split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') cur = {}
    else if (line === 'END:VEVENT') {
      if (cur?.uid && cur.start) events.push(cur)
      cur = null
    } else if (cur) {
      const i = line.indexOf(':')
      if (i < 0) continue
      const name = line.slice(0, i).split(';')[0].toUpperCase()
      const value = line.slice(i + 1)
      if (name === 'UID') cur.uid = value.trim()
      else if (name === 'SUMMARY') cur.title = unescape(value)
      else if (name === 'DTSTART') cur.start = when(value)
      else if (name === 'DTEND') cur.end = when(value)
      else if (name === 'STATUS') cur.cancelled = value.trim().toUpperCase() === 'CANCELLED'
      else if (name === 'RECURRENCE-ID') cur.recurrence = value.trim()
    }
  }
  return events
}

/** "15:00" -> "3:00 PM". */
function clock(t) {
  const [h, m] = t.split(':').map(Number)
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** The to-do items a feed implies for the next `days` days. */
export function shiftItems(events, { today = localDate(), days = 21, match = '', label = 'Work' } = {}) {
  const last = new Date(`${today}T00:00:00Z`)
  last.setUTCDate(last.getUTCDate() + days)
  const until = last.toISOString().slice(0, 10)
  const want = match.trim().toLowerCase()
  return events
    .filter((e) => !e.cancelled && e.start.date >= today && e.start.date <= until)
    .filter((e) => !want || String(e.title ?? '').toLowerCase().includes(want))
    .map((e) => {
      const span = e.start.time
        ? `${clock(e.start.time)}${e.end?.time ? `–${clock(e.end.time)}` : ''}`
        : 'all day'
      return {
        key: e.recurrence ? `${e.uid}#${e.recurrence}` : e.uid,
        date: e.start.date,
        text: `${label} ${span}`,
      }
    })
}

let timer = null
let running = false

async function syncOnce(url) {
  if (running) return
  running = true
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 15_000)
    let text
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'text/calendar' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = await res.text()
    } finally {
      clearTimeout(t)
    }
    if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('not a calendar feed')
    const items = shiftItems(parseIcs(text), {
      days: Number(process.env.JARVIS_SHIFTS_DAYS) || 21,
      match: process.env.JARVIS_SHIFTS_MATCH ?? '',
      label: process.env.JARVIS_SHIFTS_LABEL?.trim() || 'Work',
    })
    const { added, updated, removed } = syncManaged('shifts', items)
    if (added || updated || removed) {
      console.log(`[jarvis] shifts: ${added} added, ${updated} updated, ${removed} removed`)
    }
  } catch (err) {
    // The URL is a secret, so the message never includes it.
    console.warn(`[jarvis] shifts: could not read the calendar feed (${err.message})`)
  } finally {
    running = false
  }
}

/** Start the timer if a feed is configured. Safe to call once at boot. */
export function startShiftSync() {
  const url = process.env.JARVIS_SHIFTS_ICS?.trim().replace(/^webcal:/i, 'https:')
  if (!url || timer) return false
  const minutes = Math.max(5, Number(process.env.JARVIS_SHIFTS_MINUTES) || 30)
  setTimeout(() => void syncOnce(url), 5_000)
  timer = setInterval(() => void syncOnce(url), minutes * 60_000)
  timer.unref?.()
  console.log(`[jarvis] work shifts sync on, every ${minutes} min`)
  return true
}
