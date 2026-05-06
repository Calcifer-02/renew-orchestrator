import { useState, useEffect } from 'react'
import { PetriNetCanvas } from './components/PetriNetCanvas'
import { JobQueue } from './components/JobQueue'
import { EventLog } from './components/EventLog'
import { connectSSE, fetchNet } from './lib/api'
import type { NetDefinition, OrchestratorState } from './types'

const EMPTY: OrchestratorState = {
  tasks: [],
  marking: {},
  jobs: [],
  active_jobs: [],
  recent_events: [],
  enabled_transitions: [],
  locked_tasks: [],
}

export default function App() {
  const [net, setNet] = useState<NetDefinition | null>(null)
  const [state, setState] = useState<OrchestratorState>(EMPTY)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchNet().then(setNet).catch((e: unknown) => setError(String(e)))
  }, [])

  useEffect(() => {
    return connectSSE({
      onOpen: () => { setLive(true); setError(null) },
      onState: (s) => { setState(s); setLive(true); setError(null) },
      onError: (msg) => { setLive(false); setError(msg) },
    })
  }, [])

  const done = state.tasks.filter((t) => t.place === 'DONE').length
  const failed = state.tasks.filter((t) => t.place === 'FAILED').length
  const pending = state.active_jobs.length
  const enabledCount = state.enabled_transitions.length

  return (
    <div className="h-screen flex flex-col overflow-hidden select-none">
      {/* ── Header ── */}
      <header className="shrink-0 flex items-center justify-between px-5 py-2.5 border-b border-[#0e1e35]"
        style={{ background: 'rgba(1,2,18,0.85)', backdropFilter: 'blur(10px)' }}>
        {/* Logo + title */}
        <div className="flex items-center gap-3">
          <div
            className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold text-white"
            style={{
              background: 'linear-gradient(135deg, #0ea5e9 0%, #8b5cf6 100%)',
              boxShadow: '0 0 12px #0ea5e966',
            }}
          >
            R
          </div>
          <span className="text-[11px] font-mono font-bold text-slate-300 tracking-[2px] uppercase">
            Renew Orchestrator
          </span>
          <span className="text-[9px] font-mono text-[#2d5080]">Petri-net runtime · Variant A</span>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-5 text-[10px] font-mono">
          <Kpi label="tasks"   value={state.tasks.length} />
          <Kpi label="done"    value={done}    color="#22c55e" />
          <Kpi label="failed"  value={failed}  color={failed ? '#ef4444' : undefined} />
          <Kpi label="jobs"    value={pending}  color={pending ? '#22d3ee' : undefined} />
          <Kpi label="enabled" value={enabledCount} color={enabledCount ? '#f59e0b' : undefined} />
          <LiveDot live={live} error={error} />
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0">
        {/* Petri net canvas (main area) */}
        <main className="flex-1 min-w-0 relative scan-overlay">
          {net ? (
            <PetriNetCanvas net={net} state={state} />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-[11px] font-mono text-[#2d5080]">
                {error ?? 'Connecting…'}
              </div>
            </div>
          )}
        </main>

        {/* Sidebar */}
        <aside
          className="shrink-0 flex flex-col border-l border-[#0e1e35] overflow-hidden"
          style={{ width: 280, background: 'rgba(1,5,15,0.92)' }}
        >
          <JobQueue jobs={state.active_jobs} />
          <EventLog events={state.recent_events} />
        </aside>
      </div>

      {/* Legend */}
      <footer className="shrink-0 flex items-center gap-5 px-5 py-1.5 border-t border-[#0a1628] text-[9px] font-mono text-[#1e3a5f]">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-4 rounded-sm inline-block" style={{ background: '#22d3ee' }} />
          auto transition (bridge)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-4 rounded-sm inline-block" style={{ background: '#fbbf24' }} />
          manual transition (Claude)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
          token
        </span>
        <span className="ml-auto text-[#0e2035]">SSE live · 2s interval</span>
      </footer>
    </div>
  )
}

function Kpi({ label, value, color = '#2d5080' }: { label: string; value: number; color?: string }) {
  return (
    <span className="flex items-center gap-1">
      <span style={{ color: '#1e3a5f' }}>{label}</span>
      <span style={{ color, fontWeight: 700, textShadow: value > 0 ? `0 0 6px ${color}88` : 'none' }}>
        {value}
      </span>
    </span>
  )
}

function LiveDot({ live, error }: { live: boolean; error: string | null }) {
  const color = error ? '#ef4444' : live ? '#22c55e' : '#f59e0b'
  const label = error ? 'disconnected' : live ? 'live' : 'connecting'
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color, boxShadow: live && !error ? `0 0 6px ${color}` : 'none' }}
      />
      <span style={{ color: '#2d5080' }}>{label}</span>
    </span>
  )
}
