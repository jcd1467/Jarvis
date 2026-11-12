import { useEffect, useMemo, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { useStore, type Agenda } from '../store'

/**
 * The always-on widgets: clock and weather (top left), market indices (top
 * right), next up and countdowns (bottom left).
 *
 * Market and weather data come from the bridge's /widgets endpoint, which
 * caches each source, so polling once a minute is cheap. The agenda arrives
 * from JARVIS himself through the ui_agenda tool and is kept in localStorage
 * for the day, so a page reload does not blank "Next up" until he is asked
 * about the schedule again.
 *
 * Timers are setInterval, never requestAnimationFrame: a backgrounded tab
 * would freeze an rAF clock.
 */

/** How often to ask the bridge for markets and weather. */
const POLL_MS = 60_000
const AGENDA_KEY = 'jarvis.agenda'

type MarketItem = {
  name: string
  price: number
  change: number | null
  changePct: number | null
  sinceOpen?: boolean
  points: number[]
  time: number | null
}
type WidgetData = {
  markets: { status: 'ok' | 'unavailable'; reason?: string; items: MarketItem[]; asOf?: number } | null
  weather:
    | {
        status: 'ok' | 'unavailable'
        reason?: string
        place?: string
        temp?: number
        unit?: string
        sky?: string
        high?: number | null
        low?: number | null
        rain?: number | null
      }
    | null
  countdowns: { label: string; date: string }[]
  verse?: { ref: string; text: string } | null
  todos?: Todo[]
  clips?: Clips | null
}
type Todo = { id: string; text: string; done: boolean; overdue: boolean; date: string }
type Clips = {
  clips: number | null
  views: number | null
  earnings: number | null
  best: string | null
  bestViews: number | null
  updatedAt: string
}

function todayKey(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** Fired when JARVIS changes the to-do list or clip totals, and after a click. */
export const WIDGETS_REFRESH = 'jarvis:widgets'

function useWidgetData() {
  const [data, setData] = useState<WidgetData | null>(null)
  const [down, setDown] = useState(false)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/widgets`, { cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as WidgetData
        if (alive) {
          setData(body)
          setDown(false)
        }
      } catch {
        if (alive) setDown(true)
      }
    }
    void load()
    const id = setInterval(load, POLL_MS)
    window.addEventListener(WIDGETS_REFRESH, load)
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener(WIDGETS_REFRESH, load)
    }
  }, [])
  return { data, down }
}

/** The agenda from the store, falling back to today's saved copy. */
function useAgenda(): Agenda | null {
  const live = useStore((s) => s.agenda)
  const [saved, setSaved] = useState<Agenda | null>(() => {
    try {
      const raw = localStorage.getItem(AGENDA_KEY)
      return raw ? (JSON.parse(raw) as Agenda) : null
    } catch {
      return null
    }
  })
  useEffect(() => {
    if (!live) return
    setSaved(live)
    try {
      localStorage.setItem(AGENDA_KEY, JSON.stringify(live))
    } catch {
      /* storage unavailable — the live copy still works this session */
    }
  }, [live])
  return live ?? saved
}

const fmt = (n: number, digits = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  const d = useMemo(() => {
    if (points.length < 2) return ''
    const lo = Math.min(...points)
    const hi = Math.max(...points)
    const span = hi - lo || 1
    return points
      .map((v, i) => {
        const x = (i / (points.length - 1)) * 100
        const y = 22 - ((v - lo) / span) * 20
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }, [points])
  if (!d) return <span className="w-spark w-spark-empty" />
  return (
    <svg className={`w-spark ${up ? 'w-up' : 'w-down'}`} viewBox="0 0 100 24" preserveAspectRatio="none">
      <path d={d} />
    </svg>
  )
}

function Markets({ m }: { m: NonNullable<WidgetData['markets']> }) {
  if (m.status !== 'ok' || !m.items.length) {
    return (
      <div className="w-block w-markets">
        <div className="w-title">MARKETS</div>
        <div className="w-warn">UNAVAILABLE — {m.reason ?? 'no data'}</div>
      </div>
    )
  }
  const latest = Math.max(0, ...m.items.map((i) => i.time ?? 0))
  return (
    <div className="w-block w-markets">
      <div className="w-title">
        MARKETS
        <span className="w-dim">
          {latest
            ? ` · ${new Date(latest).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
            : ''}{' '}
          · DELAYED
        </span>
      </div>
      {m.items.map((it) => {
        const up = (it.change ?? 0) >= 0
        return (
          <div key={it.name} className="w-mkt">
            <span className="w-mkt-name">{it.name}</span>
            <Sparkline points={it.points} up={up} />
            <span className="w-mkt-price">{fmt(it.price)}</span>
            <span className={`w-mkt-chg ${it.changePct == null ? '' : up ? 'w-up' : 'w-down'}`}>
              {it.changePct == null ? '—' : `${up ? '▲' : '▼'} ${fmt(Math.abs(it.changePct))}%`}
              {it.sinceOpen ? ' *' : ''}
            </span>
          </div>
        )
      })}
      {m.items.some((i) => i.sinceOpen) && <div className="w-dim w-foot">* change since today's open</div>}
    </div>
  )
}

function ClockWeather({ now, w }: { now: Date; w: WidgetData['weather'] }) {
  return (
    <div className="w-block w-clock">
      <div className="w-time">
        {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </div>
      <div className="w-date">
        {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}
      </div>
      {w &&
        (w.status === 'ok' ? (
          <div className="w-weather">
            <span className="w-temp">
              {w.temp}°{w.unit}
            </span>
            <span className="w-sky">
              {w.sky}
              {w.high != null && w.low != null && ` · H ${Math.round(w.high)}° L ${Math.round(w.low)}°`}
              {w.rain != null && ` · RAIN ${w.rain}%`}
            </span>
          </div>
        ) : (
          <div className="w-warn">WEATHER UNAVAILABLE</div>
        ))}
    </div>
  )
}

function NextUp({ now, agenda, countdowns }: { now: Date; agenda: Agenda | null; countdowns: WidgetData['countdowns'] }) {
  const today = todayKey(now)
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const items = agenda?.date === today ? agenda.items : []
  const next = items.find((it) => it.time >= hhmm)
  const after = next ? items[items.indexOf(next) + 1] : undefined

  const clock = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    const d = new Date(now)
    d.setHours(h, m, 0, 0)
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const days = (iso: string) =>
    Math.round((new Date(`${iso}T00:00:00`).getTime() - midnight.getTime()) / 86_400_000)
  const upcoming = countdowns.map((c) => ({ ...c, days: days(c.date) })).filter((c) => c.days >= 0)

  return (
    <div className="w-block w-next">
      <div className="w-title">NEXT UP</div>
      {!agenda || agenda.date !== today ? (
        <div className="w-dim">Ask “what’s my day” to load today</div>
      ) : next ? (
        <>
          <div className="w-next-row">
            <span className="w-next-time">{clock(next.time)}</span>
            <span className="w-next-label">{next.label}</span>
            {next.tag && <span className="w-tag">{next.tag}</span>}
          </div>
          {after && (
            <div className="w-next-row w-dim">
              <span className="w-next-time">{clock(after.time)}</span>
              <span className="w-next-label">{after.label}</span>
            </div>
          )}
        </>
      ) : (
        <div className="w-dim">Nothing else scheduled today</div>
      )}
      {upcoming.length > 0 && (
        <>
          <div className="w-title w-gap">COUNTDOWN</div>
          {upcoming.map((c) => (
            <div key={c.label} className="w-count">
              <span className="w-count-n">{c.days === 0 ? 'TODAY' : c.days}</span>
              {c.days > 0 && <span className="w-dim">{c.days === 1 ? 'DAY' : 'DAYS'}</span>}
              <span className="w-count-label">{c.label}</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

function TodoList({ todos }: { todos: Todo[] }) {
  const [busy, setBusy] = useState<string | null>(null)
  const toggle = async (id: string) => {
    setBusy(id)
    try {
      await fetch(`${BRIDGE_HTTP_URL}/todos/toggle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    } finally {
      setBusy(null)
      window.dispatchEvent(new Event(WIDGETS_REFRESH))
    }
  }
  const open = todos.filter((t) => !t.done).length
  return (
    <div className="w-block w-todo">
      <div className="w-title">
        TO DO
        <span className="w-dim">{todos.length ? ` · ${open} LEFT` : ''}</span>
      </div>
      {todos.length === 0 ? (
        <div className="w-dim">Say “add … to my to-do list”</div>
      ) : (
        todos.slice(0, 8).map((t) => (
          <button
            key={t.id}
            type="button"
            className={`w-todo-item${t.done ? ' w-todo-done' : ''}${busy === t.id ? ' w-busy' : ''}`}
            onClick={() => void toggle(t.id)}
            title={t.done ? 'Mark not done' : 'Mark done'}
          >
            <span className="w-check">{t.done ? '✓' : ''}</span>
            <span className="w-todo-text">{t.text}</span>
            {t.overdue && !t.done && <span className="w-tag">CARRIED</span>}
          </button>
        ))
      )}
      {todos.length > 8 && <div className="w-dim w-foot">+{todos.length - 8} more — ask JARVIS</div>}
    </div>
  )
}

function ClipsWidget({ c }: { c: Clips | null }) {
  return (
    <div className="w-block w-clips">
      <div className="w-title">
        CLIPS
        {c && (
          <span className="w-dim">
            {' · '}
            {new Date(c.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase()}
          </span>
        )}
      </div>
      {!c ? (
        <div className="w-dim">No clips tracked yet — ask “how are my clips doing”</div>
      ) : (
        <>
          <div className="w-clips-row">
            <div>
              <div className="w-clips-n">{c.earnings != null ? `$${c.earnings.toFixed(2)}` : '—'}</div>
              <div className="w-dim">EARNED</div>
            </div>
            <div>
              <div className="w-clips-n">{c.views != null ? compact(c.views) : '—'}</div>
              <div className="w-dim">VIEWS</div>
            </div>
            <div>
              <div className="w-clips-n">{c.clips ?? '—'}</div>
              <div className="w-dim">CLIPS</div>
            </div>
          </div>
          {c.best && (
            <div className="w-clips-best">
              <span className="w-dim">BEST</span> {c.best}
              {c.bestViews != null && <span className="w-dim"> · {compact(c.bestViews)}</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Verse({ v }: { v: NonNullable<WidgetData['verse']> }) {
  return (
    <div className="w-block w-verse">
      <div className="w-title">VERSE</div>
      <p className="w-verse-text">“{v.text}”</p>
      {v.ref && <div className="w-verse-ref">{v.ref}</div>}
    </div>
  )
}

export function Widgets() {
  const show = useStore((s) => s.ui.chrome.widgets)
  const now = useNow(1000)
  const { data, down } = useWidgetData()
  const agenda = useAgenda()
  if (!show) return null
  // Four columns: each stacks its own blocks, so a long to-do list pushes
  // nothing on top of anything else.
  return (
    <div className="widgets">
      <div className="w-col w-col-tl">
        <ClockWeather now={now} w={data?.weather ?? null} />
        {data && <TodoList todos={data.todos ?? []} />}
      </div>
      <div className="w-col w-col-tr">
        {down && !data ? (
          <div className="w-block">
            <div className="w-warn">WIDGET DATA UNAVAILABLE — BRIDGE NOT REACHABLE</div>
          </div>
        ) : (
          data?.markets && <Markets m={data.markets} />
        )}
        {data && <ClipsWidget c={data.clips ?? null} />}
      </div>
      <div className="w-col w-col-bl">
        <NextUp now={now} agenda={agenda} countdowns={data?.countdowns ?? []} />
      </div>
      <div className="w-col w-col-br">{data?.verse && <Verse v={data.verse} />}</div>
    </div>
  )
}
