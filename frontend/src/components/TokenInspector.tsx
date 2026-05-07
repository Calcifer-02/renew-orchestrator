import { useState } from 'react'
import type { Task, NetTransition, Job } from '../types'

const PLACE_COLOR: Record<string, string> = {
  BACKLOG: '#64748b', READY_FOR_ANALYSIS: '#0ea5e9', ANALYZED: '#8b5cf6',
  READY_FOR_PATCH: '#f59e0b', PATCH_CREATED: '#f97316', TESTING: '#06b6d4',
  DONE: '#22c55e', FAILED: '#ef4444', HUMAN_REVIEW: '#ec4899',
}

const HUMAN_LABELS: Record<string, string> = {
  approve_plan:    'Одобрить план',
  escalate_review: 'Эскалировать',
  escalate:        'Эскалировать',
  mark_done:       'Завершить',
}

const AGENT_LABELS: Record<string, string> = {
  analysis_finished: 'Анализ завершён',
  patch_created:     'Патч готов',
  tests_passed:      'Тест пройден',
  tests_failed:      'Тест провален',
  retry:             'Повторить',
}

function trLabel(tr: NetTransition): string {
  if (tr.kind === 'human') return HUMAN_LABELS[tr.id] ?? tr.id.replace(/_/g, ' ')
  return AGENT_LABELS[tr.id] ?? 'Выполнить'
}

function trColor(tr: NetTransition): string {
  if (tr.kind === 'human') {
    return tr.id.includes('escalat') ? '#f97316' : '#22c55e'
  }
  return tr.auto ? '#22d3ee' : '#fbbf24'
}

interface Props {
  task: Task
  transitions: NetTransition[]
  lockedJob?: Job | null
  onFire: (transitionId: string) => Promise<void>
  onClose: () => void
}

export function TokenInspector({ task, transitions, lockedJob, onFire, onClose }: Props) {
  const [firingId, setFiringId] = useState<string | null>(null)
  const [error, setError]       = useState<string | null>(null)

  async function handleFire(id: string) {
    setFiringId(id); setError(null)
    try {
      await onFire(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFiringId(null)
    }
  }

  const placeColor = PLACE_COLOR[task.place] ?? '#64748b'
  const hasHumanGate = !lockedJob && transitions.some((tr) => tr.kind === 'human')

  return (
    <div style={{
      borderBottom: '1px solid #0e1e35', padding: '8px 10px',
      flexShrink: 0, background: 'rgba(1,8,20,0.97)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{
          fontSize: 9, fontFamily: 'JetBrains Mono', color: '#22d3ee',
          letterSpacing: '1px', textTransform: 'uppercase',
        }}>
          Инспектор токена
        </span>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: '#2d5080',
          cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1,
        }}>×</button>
      </div>

      {/* Task meta */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8, userSelect: 'text' }}>
        <Row label="id"      value={task.task_id}        color="#e2e8f0" />
        <Row label="место"   value={task.place}          color={placeColor} glow={`0 0 8px ${placeColor}99`} />
        <Row label="файл"    value={task.file}           color="#94a3b8" />
        <Row label="попытка" value={String(task.attempt)} color="#475569" />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5, marginTop: 1 }}>
          <span style={{ width: 42, fontSize: 8, color: '#2d5080', fontFamily: 'JetBrains Mono', flexShrink: 0, paddingTop: 1 }}>
            цель
          </span>
          <span style={{ fontSize: 8.5, color: '#7dd3fc', fontFamily: 'JetBrains Mono', lineHeight: 1.4, wordBreak: 'break-word' }}>
            {task.goal}
          </span>
        </div>
      </div>

      {/* Locked by active job */}
      {lockedJob && (
        <div style={{
          marginBottom: 8, padding: '5px 7px',
          background: '#100a02', border: '1px solid #78350f', borderRadius: 3,
          userSelect: 'text',
        }}>
          <div style={{ fontSize: 8.5, color: '#f59e0b', fontFamily: 'JetBrains Mono', marginBottom: 2 }}>
            Токен заблокирован заданием
          </div>
          <div style={{ fontSize: 8, color: '#92400e', fontFamily: 'JetBrains Mono', wordBreak: 'break-all' }}>
            {lockedJob.job_id}
          </div>
          <div style={{ fontSize: 8, color: '#1e3a5f', fontFamily: 'JetBrains Mono', marginTop: 2 }}>
            Ожидает завершения agent job · {lockedJob.agent_role}
          </div>
        </div>
      )}

      {/* Human gate banner */}
      {hasHumanGate && (
        <div style={{
          marginBottom: 8, padding: '5px 7px',
          background: '#0d0820', border: '1px solid #6d28d944', borderRadius: 3,
        }}>
          <div style={{ fontSize: 8.5, color: '#a78bfa', fontFamily: 'JetBrains Mono', marginBottom: 2 }}>
            ⚡ ТРЕБУЕТСЯ РЕШЕНИЕ
          </div>
          <div style={{ fontSize: 8, color: '#4c1d95', fontFamily: 'JetBrains Mono' }}>
            Ожидает решения человека для продолжения
          </div>
        </div>
      )}

      {/* Enabled transitions */}
      <div style={{ marginBottom: 5 }}>
        <span style={{
          fontSize: 8, color: '#2d5080', fontFamily: 'JetBrains Mono',
          textTransform: 'uppercase', letterSpacing: '0.8px',
        }}>
          Доступные переходы ({transitions.length})
        </span>
      </div>

      {transitions.length === 0 ? (
        <div style={{ fontSize: 8.5, color: '#1e3a5f', fontFamily: 'JetBrains Mono', padding: '4px 0' }}>
          {lockedJob
            ? 'переходы заблокированы активным заданием'
            : 'нет доступных переходов'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {transitions.map((tr) => {
            const firing = firingId === tr.id
            const busy   = firingId !== null
            const color  = trColor(tr)
            const label  = trLabel(tr)
            const isHuman = tr.kind === 'human'

            return (
              <div key={tr.id} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: isHuman ? '4px 6px' : '0',
                background: isHuman ? `${color}0a` : 'transparent',
                border: isHuman ? `1px solid ${color}22` : 'none',
                borderRadius: isHuman ? 3 : 0,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 9, color, fontFamily: 'JetBrains Mono',
                    textShadow: `0 0 6px ${color}66`,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {tr.id}
                  </div>
                  <div style={{ fontSize: 7, color: '#1e3a5f', fontFamily: 'JetBrains Mono', marginTop: 1 }}>
                    {tr.from.join(' | ')} -&gt; {tr.to}
                  </div>
                </div>
                <button
                  onClick={() => handleFire(tr.id)}
                  disabled={busy}
                  style={{
                    padding: isHuman ? '4px 9px' : '3px 7px',
                    background: firing
                      ? `${color}0d`
                      : isHuman
                        ? `${color}26`
                        : `${color}1a`,
                    border: `1px solid ${firing || busy ? '#0e2035' : `${color}66`}`,
                    borderRadius: 3,
                    color: firing || busy ? '#2d5080' : color,
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: isHuman ? 9 : 8,
                    fontWeight: 700,
                    cursor: busy ? 'not-allowed' : 'pointer',
                    letterSpacing: '0.5px',
                    minWidth: isHuman ? 80 : 60,
                    textAlign: 'center',
                    boxShadow: (!busy && !firing) ? `0 0 ${isHuman ? 10 : 6}px ${color}${isHuman ? '44' : '33'}` : 'none',
                    transition: 'all 0.15s',
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {firing ? '…' : label}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {error && (
        <div style={{
          marginTop: 7, padding: '5px 7px',
          background: '#160404', border: '1px solid #7f1d1d', borderRadius: 3,
          fontSize: 8.5, color: '#f87171', fontFamily: 'JetBrains Mono, monospace',
          wordBreak: 'break-word', lineHeight: 1.5, userSelect: 'text',
        }}>
          {error}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, color, glow }: {
  label: string; value: string; color: string; glow?: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 42, fontSize: 8, color: '#2d5080', fontFamily: 'JetBrains Mono', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{
        fontSize: 9, color, fontFamily: 'JetBrains Mono', fontWeight: 600,
        textShadow: glow, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  )
}
