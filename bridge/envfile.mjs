/**
 * Read server-side settings from a local `.env.local` (or `.env`) at the repo
 * root, so an ElevenLabs key can live in a file instead of being exported in
 * every terminal.
 *
 * Only ELEVENLABS_API_KEY and JARVIS_* names are taken, and a variable already
 * set in the shell always wins. VITE_* lines are left alone here — Vite reads
 * those itself, and only VITE_-prefixed values ever reach the browser, so a key
 * stored under ELEVENLABS_API_KEY stays on this machine's server process.
 *
 * Both files are gitignored. Keep them chmod 600.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED = /^(ELEVENLABS_API_KEY|JARVIS_[A-Z0-9_]+)$/

export function loadEnvFiles(root = ROOT) {
  const loaded = []
  for (const name of ['.env.local', '.env']) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!m) continue
      const [, key, rawValue] = m
      if (!ALLOWED.test(key)) continue
      if (process.env[key] !== undefined && process.env[key] !== '') continue
      let value = rawValue.trim()
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
      else value = value.replace(/\s+#.*$/, '')
      if (!value) continue
      process.env[key] = value
      loaded.push(key)
    }
  }
  return loaded
}

loadEnvFiles()
