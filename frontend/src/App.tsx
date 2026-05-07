import { useState, useEffect, useRef, useCallback } from 'react'
import { PetriNetCanvas } from './components/PetriNetCanvas'
import { JobQueue } from './components/JobQueue'
import { EventLog } from './components/EventLog'
import { CreateTokenPanel } from './components/CreateTokenPanel'
import { TokenInspector } from './components/TokenInspector'
import { connectSSE, fetchNet, fireTransition, runTick } from './lib/api'
import type { NetDefinition, OrchestratorState, Task, NetTransition, Job, TickResult } from './types'

const EMPTY: OrchestratorState = {
  tasks: [], marking: {}, jobs: [], active_jobs: [],
  recent_events: [], enabled_transitions: [], locked_tasks: [],
}

export default function App() {
  const [net, setNet]     = useState<NetDefinition | null>(null)
  const [state, setState] = useState<OrchestratorState>(EMPTY)
  const [live, setLive]   = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [firingTransitions, setFiringTransitions] = useState<Set<string>>(new Set())

  const [ticking, setTicking]       = useState(false)
  const [tickResult, setTickResult] = useState<TickResult | null>(null)
  const [tickError, setTickError]   = useState<string | null>(null)

  const lastEventTsRef = useRef<string | null>(null)

  useEffect(() => {
    fetchNet().then(setNet).catch((e: unknown) => setError(String(e)))
  }, [])

  useEffect(() => {
    return connectSSE({
      onOpen: () => { setLive(true); setError(null) },
      onError: (msg) => { setLive(false); setError(msg) },
      onState: (s) => {
        setState(s)
        setLive(true)
        setError(null)

        const latest = s.recent_events[0]
        if (latest && latest.ts !== lastEventTsRef.current) {
          lastEventTsRef.current = latest.ts
          if (latest.type === 'transition_fired' && latest.transition) {
            const trId = latest.transition
            setFiringTransitions((prev) => new Set([...prev, trId]))
            setTimeout(() => {
              setFiringTransitions((prev) => {
                const next = new Set(prev)
                next.delete(trId)
                return next
              })
            }, 1000)
          }
        }
      },
    })
  }, [])

  // Auto-clear tick result after 8 s
  useEffect(() => {
    if (!tickResult) return
    const t = setTimeout(() => setTickResult(null), 8000)
    return () => clearTimeout(t)
  }, [tickResult])

  const selectedTask: Task | null =
    selectedTaskId ? (state.tasks.find((t) => t.task_id === selectedTaskId) ?? null) : null

  const selectedTaskTransitions: NetTransition[] = selectedTask && net
    ? net.transitions.filter(
        (tr) =>
          tr.from.includes(selectedTask.place) &&
          state.enabled_transitions.includes(tr.id),
      )
    : []

  const lockedJob: Job | null = selectedTask
    ? (state.jobs.find(
        (j) => j.task_id === selectedTask.task_id && (j.status === 'pending' || j.status === 'running')
      ) ?? null)
    : null

  const handleTokenClick = useCallback((taskId: string) => {
    setSelectedTaskId((prev) => (prev === taskId ? null : taskId))
  }, [])

  async function handleFire(transitionId: string) {
    if (!selectedTask) return
    await fireTransition({ task_id: selectedTask.task_id, transition_id: transitionId })
  }

  async function handleTick() {
    setTicking(true)
    setTickError(null)
    setTickResult(null)
    try {
      const result = await runTick()
      setTickResult(result)
    } catch (e) {
      setTickError(e instanceof Error ? e.message : String(e))
    } finally {
      setTicking(false)
    }
  }

  const done    = state.tasks.filter((t) => t.place === 'DONE').length
  const failed  = state.tasks.filter((t) => t.place === 'FAILED').length
  const pending = state.active_jobs.length
  const enabled = state.enabled_transitions.length

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <header
        className="shrink-0 flex items-center justify-between px-5 py-2.5 border-b border-[#0e1e35] select-none"
        style={{ background: 'rgba(1,2,18,0.85)', backdropFilter: 'blur(10px)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold text-white"
            style={{
              background: 'linear-gradient(135deg,#0ea5e9 0%,#8b5cf6 100%)',
              boxShadow: '0 0 12px #0ea5e966',
            }}
          >
            R
          </div>
          <span className="text-[11px] font-mono font-bold text-slate-300 tracking-[2px] uppercase">
            Renew Orchestrator
          </span>
          <span className="text-[9px] font-mono text-[#2d5080]">Petri-net runtime</span>
        </div>

        <div className="flex items-center gap-5 text-[10px] font-mono">
          <Kpi label="задачи"   value={state.tasks.length} />
          <Kpi label="готово"   value={done}    color="#22c55e" />
          <Kpi label="ошибки"   value={failed}  color={failed  ? '#ef4444' : undefined} />
          <Kpi label="задания"  value={pending} color={pending ? '#22d3ee' : undefined} />
          <Kpi label="активны"  value={enabled} color={enabled ? '#f59e0b' : undefined} />
          <LiveDot live={live} error={error} />
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0">
        {/* Canvas */}
        <main className="flex-1 min-w-0 relative scan-overlay select-none">
          {net ? (
            <PetriNetCanvas
              net={net}
              state={state}
              selectedTaskId={selectedTaskId}
              onTokenClick={handleTokenClick}
              firingTransitions={firingTransitions}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-[11px] font-mono text-[#2d5080]">
                {error ?? 'Подключение…'}
              </div>
            </div>
          )}
        </main>

        {/* Sidebar */}
        <aside
          className="shrink-0 flex flex-col border-l border-[#0e1e35] overflow-hidden"
          style={{ width: 284, background: 'rgba(1,5,15,0.92)' }}
        >
          {/* ── Шаг оркестратора ── */}
          <div style={{ borderBottom: '1px solid #0e1e35', padding: '8px 10px', flexShrink: 0 }}>
            <button
              onClick={handleTick}
              disabled={ticking}
              style={{
                width: '100%', display: 'flex', alignItems: 'center',
                justifyContent: 'center', gap: 6,
                background: ticking
                  ? '#0a1020'
                  : 'linear-gradient(135deg,#6d28d9 0%,#4f46e5 100%)',
                border: ticking ? '1px solid #1e1e3a' : '1px solid #7c3aed44',
                borderRadius: 4, padding: '5px 8px',
                cursor: ticking ? 'not-allowed' : 'pointer',
                color: ticking ? '#2d5080' : '#ede9fe',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                letterSpacing: '1px',
                boxShadow: ticking ? 'none' : '0 0 14px #6d28d944',
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 11 }}>{ticking ? '⟳' : '▶'}</span>
              {ticking ? 'Выполняется…' : 'Шаг оркестратора'}
            </button>

            {tickResult && (
              <div style={{
                marginTop: 6, padding: '6px 8px',
                background: '#030a18', border: '1px solid #1e3a5f', borderRadius: 3,
                fontFamily: 'JetBrains Mono, monospace', fontSize: 8.5,
                display: 'flex', flexDirection: 'column', gap: 2,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ color: '#6d28d9', fontWeight: 700, letterSpacing: '0.5px' }}>
                    РЕЗУЛЬТАТ ШАГА
                  </span>
                  <button
                    onClick={() => setTickResult(null)}
                    style={{ background: 'none', border: 'none', color: '#2d5080', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}
                  >×</button>
                </div>
                <TickRow label="Выполнено переходов" value={tickResult.fired.length} color="#22c55e" />
                <TickRow label="Создано заданий"     value={tickResult.jobs_created.length} color="#22d3ee" />
                <TickRow label="Ожидает человека"    value={tickResult.waiting_for_human.length} color="#ec4899" />
                <TickRow label="Заблокировано"       value={tickResult.blocked.length} color="#ef4444" />
                <TickRow label="Tool-переходы"       value={tickResult.tool_ready.length} color="#f59e0b" />
              </div>
            )}

            {tickError && (
              <div style={{
                marginTop: 5, padding: '4px 6px',
                background: '#1a0606', border: '1px solid #7f1d1d', borderRadius: 3,
                fontSize: 8.5, color: '#f87171', fontFamily: 'JetBrains Mono, monospace',
                wordBreak: 'break-word',
              }}>
                {tickError}
              </div>
            )}
          </div>

          {/* ── Создать токен ── */}
          <CreateTokenPanel />

          {/* ── Инспектор токена ── */}
          {selectedTask ? (
            <TokenInspector
              task={selectedTask}
              transitions={selectedTaskTransitions}
              lockedJob={lockedJob}
              onFire={handleFire}
              onClose={() => setSelectedTaskId(null)}
            />
          ) : (
            <div style={{
              padding: '8px 12px',
              borderBottom: '1px solid #0a1628',
              fontSize: 8.5,
              color: '#1e3a5f',
              fontFamily: 'JetBrains Mono, monospace',
              flexShrink: 0,
            }}>
              нажмите на токен для инспекции и выполнения переходов
            </div>
          )}

          {/* ── Очередь заданий + Журнал событий ── */}
          <div className="flex flex-col flex-1 min-h-0 overflow-auto">
            <JobQueue jobs={state.active_jobs} />
            <EventLog events={state.recent_events} />
          </div>
        </aside>
      </div>

      {/* ── Footer ── */}
      <footer className="shrink-0 flex items-center gap-5 px-5 py-1.5 border-t border-[#0a1628] text-[9px] font-mono text-[#1e3a5f] select-none">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-4 rounded-sm inline-block" style={{ background: '#22d3ee' }} />
          авто (bridge)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-4 rounded-sm inline-block" style={{ background: '#fbbf24' }} />
          ручной (agent)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
          токен (нажмите для выбора)
        </span>
        <span className="ml-auto text-[#0e2035]">SSE · 0.5 с</span>
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
  const label = error ? 'отключено' : live ? 'онлайн' : 'подключение'
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

function TickRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ color: '#2d5080' }}>{label}</span>
      <span style={{
        color: value > 0 ? color : '#1e3a5f',
        fontWeight: 700,
        textShadow: value > 0 ? `0 0 6px ${color}88` : 'none',
        minWidth: 16, textAlign: 'right',
      }}>{value}</span>
    </div>
  )
}
