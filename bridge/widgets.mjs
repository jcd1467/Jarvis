/**
 * Data for the always-on widgets: market indices, local weather, countdowns.
 *
 * Fetched here rather than in the page for the same reason as everything else
 * the bridge proxies: the page's CSP names no third-party hosts, and these
 * sources take no key, so there is nothing to keep secret — only a fixed set of
 * hosts to call. Results are cached so a page polling once a minute costs one
 * upstream request per source per cache window, however many tabs are open.
 *
 * Every source can fail. A failure is reported as `status: 'unavailable'` with
 * a reason, and the widget says so — a stale or invented number on a market
 * ticker is worse than an honest blank.
 *
 * Settings (all optional, read from the environment / .env.local):
 *   JARVIS_MARKETS           1 to show the market widget (default on), 0 to hide
 *   JARVIS_WEATHER_LOCATION  "Plainwell, Michigan" — town, then state or country
 *   JARVIS_UNITS             imperial (default) or metric
 *   JARVIS_COUNTDOWNS        "GTA 6=2026-11-19; Finals=2026-12-14"
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
  ' (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const MARKETS_TTL = 60_000
const WEATHER_TTL = 15 * 60_000
const TIMEOUT = 8_000

/** The three indices, in display order. Yahoo symbol, Stooq symbol, label. */
const INDICES = [
  { yahoo: '^GSPC', stooq: '^spx', name: 'S&P 500' },
  { yahoo: '^DJI', stooq: '^dji', name: 'DOW' },
  { yahoo: '^IXIC', stooq: '^ndq', name: 'NASDAQ' },
]

async function get(url, as = 'json') {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : '*/*' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return as === 'json' ? await res.json() : await res.text()
  } finally {
    clearTimeout(timer)
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// ---------------------------------------------------------------- markets

/**
 * One index from Yahoo's chart endpoint: last price, change against the
 * previous close, and the day's 5-minute closes for a sparkline.
 */
async function yahooIndex(ix) {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(ix.yahoo) +
    '?interval=5m&range=1d'
  const body = await get(url)
  const result = body?.chart?.result?.[0]
  const meta = result?.meta
  const price = num(meta?.regularMarketPrice)
  if (price == null) throw new Error('no price in response')
  const prev = num(meta?.chartPreviousClose) ?? num(meta?.previousClose)
  const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(
    (v) => typeof v === 'number' && Number.isFinite(v),
  )
  return {
    name: ix.name,
    price,
    change: prev != null ? price - prev : null,
    changePct: prev ? ((price - prev) / prev) * 100 : null,
    // Thinned to at most ~60 points: a 120px sparkline cannot show more.
    points: closes.filter((_, i) => i % Math.max(1, Math.ceil(closes.length / 60)) === 0),
    time: num(meta?.regularMarketTime) ? meta.regularMarketTime * 1000 : null,
  }
}

/** Fallback: Stooq's CSV quote. Price only — no previous close, no intraday. */
async function stooqIndex(ix) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(ix.stooq)}&f=sd2t2ohlcv&h&e=csv`
  const text = await get(url, 'text')
  const [header, row] = text.trim().split(/\r?\n/)
  if (!header || !row) throw new Error('empty csv')
  const cols = header.split(',').map((c) => c.trim().toLowerCase())
  const vals = row.split(',')
  const close = Number(vals[cols.indexOf('close')])
  const open = Number(vals[cols.indexOf('open')])
  if (!Number.isFinite(close)) throw new Error('no close in csv')
  return {
    name: ix.name,
    price: close,
    // Change since the open, not since yesterday's close — labelled as such.
    change: Number.isFinite(open) ? close - open : null,
    changePct: Number.isFinite(open) && open ? ((close - open) / open) * 100 : null,
    sinceOpen: true,
    points: [],
    time: null,
  }
}

let marketsCache = { at: 0, value: null }

async function markets() {
  if (process.env.JARVIS_MARKETS === '0') return null
  if (marketsCache.value && Date.now() - marketsCache.at < MARKETS_TTL) return marketsCache.value
  const items = []
  const problems = []
  for (const ix of INDICES) {
    try {
      items.push({ ...(await yahooIndex(ix)), source: 'yahoo' })
    } catch (e1) {
      try {
        items.push({ ...(await stooqIndex(ix)), source: 'stooq' })
      } catch (e2) {
        problems.push(`${ix.name}: ${e1.message}; ${e2.message}`)
      }
    }
  }
  if (problems.length) console.warn(`[jarvis] markets: ${problems.join(' | ')}`)
  const value = items.length
    ? { status: 'ok', items, asOf: Date.now() }
    : { status: 'unavailable', reason: 'market data could not be reached', items: [] }
  // A failure is cached for a shorter time so it recovers quickly.
  marketsCache = { at: items.length ? Date.now() : Date.now() - MARKETS_TTL / 2, value }
  return value
}

// ---------------------------------------------------------------- weather

/** WMO weather codes, as Open-Meteo reports them, in plain words. */
const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy',
  45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
}

let place = null // { name, lat, lon } once geocoded
let weatherCache = { at: 0, value: null }

async function geocode(location) {
  if (place?.query === location) return place
  const [town, region] = location.split(',').map((s) => s.trim())
  const url =
    'https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=' +
    encodeURIComponent(town)
  const body = await get(url)
  const results = body?.results ?? []
  const want = (region ?? '').toLowerCase()
  const hit =
    results.find(
      (r) =>
        want &&
        [r.admin1, r.country, r.country_code].some((v) => String(v ?? '').toLowerCase() === want),
    ) ?? results[0]
  if (!hit) throw new Error(`no place called ${town}`)
  place = { query: location, name: hit.name, lat: hit.latitude, lon: hit.longitude }
  return place
}

async function weather() {
  const location = process.env.JARVIS_WEATHER_LOCATION?.trim()
  if (!location) return null
  if (weatherCache.value && Date.now() - weatherCache.at < WEATHER_TTL) return weatherCache.value
  const metric = process.env.JARVIS_UNITS === 'metric'
  let value
  try {
    const p = await geocode(location)
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}` +
      '&current=temperature_2m,weather_code' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&timezone=auto&forecast_days=1' +
      (metric ? '' : '&temperature_unit=fahrenheit')
    const body = await get(url)
    const temp = num(body?.current?.temperature_2m)
    if (temp == null) throw new Error('no temperature in response')
    value = {
      status: 'ok',
      place: p.name,
      temp: Math.round(temp),
      unit: metric ? 'C' : 'F',
      sky: WMO[body.current.weather_code] ?? '',
      high: num(body?.daily?.temperature_2m_max?.[0]),
      low: num(body?.daily?.temperature_2m_min?.[0]),
      rain: num(body?.daily?.precipitation_probability_max?.[0]),
    }
    weatherCache = { at: Date.now(), value }
  } catch (err) {
    console.warn(`[jarvis] weather: ${err.message}`)
    value = { status: 'unavailable', reason: 'weather could not be reached' }
    weatherCache = { at: Date.now() - WEATHER_TTL + 60_000, value }
  }
  return value
}

// ---------------------------------------------------------------- countdowns

/** "GTA 6=2026-11-19; Finals=2026-12-14" -> [{ label, date }]. Bad entries skip. */
export function parseCountdowns(raw = process.env.JARVIS_COUNTDOWNS ?? '') {
  return raw
    .split(/[;\n]/)
    .map((part) => {
      const m = /^\s*(.+?)\s*=\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(part)
      return m ? { label: m[1], date: m[2] } : null
    })
    .filter(Boolean)
}

/** Everything the widgets need, in one response. Never throws. */
export async function widgetData() {
  const [m, w] = await Promise.all([
    markets().catch(() => ({ status: 'unavailable', reason: 'market data failed', items: [] })),
    weather().catch(() => ({ status: 'unavailable', reason: 'weather failed' })),
  ])
  return { markets: m, weather: w, countdowns: parseCountdowns() }
}
