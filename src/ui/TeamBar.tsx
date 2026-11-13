import { useEffect, useState } from 'react'
import { useStore } from '../store'

/**
 * The clipping team at a glance: one chip per agent along the top of the
 * screen, saying what it is doing right now or that it is standing by.
 *
 * The bridge pushes the whole team's state whenever any of it changes — from a
 * conversation or from a daily unattended run — so this only draws.
 */

const ORDER: { key: string; label: string }[] = [
  { key: 'scout', label: 'SCOUT' },
  { key: 'trends', label: 'TRENDS' },
  { key: 'coach', label: 'COACH' },
  { key: 'copywriter', label: 'COPY' },
  { key: 'analyst', label: 'ANALYST' },
]

function useTick(on: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => set((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [on])
}

export function TeamBar() {
  const team = useStore((s) => s.team)
  const show = useStore((s) => s.ui.chrome.widgets)
  const anyWorking = ORDER.some((a) => team[a.key]?.state === 'working')
  useTick(anyWorking)
  if (!show) return null

  return (
    <div className="team-bar">
      <span className="team-title">TEAM</span>
      {ORDER.map(({ key, label }) => {
        const a = team[key]
        const working = a?.state === 'working'
        const secs = working && a.since ? Math.max(0, Math.round((Date.now() - a.since) / 1000)) : 0
        return (
          <div
            key={key}
            className={`team-chip${working ? ' team-on' : ''}`}
            title={a?.last ? `Last: ${a.last}` : undefined}
          >
            <span className="team-dot" />
            <span className="team-name">{label}</span>
            <span className="team-state">
              {working ? `${a.step || 'working'} · ${secs}s` : 'standing by'}
            </span>
          </div>
        )
      })}
    </div>
  )
}
