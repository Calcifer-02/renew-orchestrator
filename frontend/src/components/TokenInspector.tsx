import { useState } from 'react'
import type { Task, NetTransition } from '../types'

const PLACE_COLOR: Record<string, string> = {
  BACKLOG: '#64748b', READY_FOR_ANALYSIS: '#0ea5e9', ANALYZED: '#8b5cf6',
  READY_FOR_PATCH: '#f59e0b', PATCH_CREATED: '#f97316', TESTING: '#06b6d4',
  DONE: '#22c55e', FAILED: '#ef4444', HUMAN_REVIEW: '#ec4899',
}

interface Props {
  task: Task
  transitions: NetTransition[]   // enabled transitions for this task
  onFire: (transitionId: string) => Promise<void>
  onClose: () => void
}

export function TokenInspector({ task, transitions, onFire, onClose }: Props) {
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

  return (
    <div style={{
      borderBottom: '1px solid #0e1e35',
      padding: '8px 10px',
      flexShrink: 0,
      background: 'rgba(1,8,20,0.97)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{
          fontSize: 9, fontFamily: 'JetBrains Mono', color: '#22d3ee',
          letterSpacing: '1px', textTransform: 'uppercase',
        }}>
          Selected Token
        </span>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: '#2d5080',
          cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1,
        }}>
          ×
        </button>
      </div>

      {/* Task meta */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
        <Row label="id"      value={task.task_id} color="#e2e8f0" />
        <Row label="place"   value={task.place}   color={placeColor} glow={`0 0 8px ${placeColor}99`} />
        <Row label="file"    value={task.file}    color="#94a3b8" />
        <Row label="attempt" value={String(task.attempt)} color="#475569" />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5, marginTop: 1 }}>
          <span style={{ width: 42, fontSize: 8, color: '#2d5080', fontFamily: 'JetBrains Mono', flexShrink: 0, paddingTop: 1 }}>goal</span>
          <span style={{ fontSize: 8.5, color: '#7dd3fc', fontFamily: 'JetBrains Mono', lineHeight: 1.4, wordBreak: 'break-word' }}>
            {task.goal}
          </span>
        </div>
      </div>

      {/* Enabled transitions */}
      <div style={{ marginBottom: 5 }}>
        <span style={{
          fontSize: 8, color: '#2d5080', fontFamily: 'JetBrains Mono',
          textTransform: 'uppercase', letterSpacing: '0.8px',
        }}>
          Enabled Transitions ({transitions.length})
        </span>
      </div>

      {transitions.length === 0 ? (
        <div style={{ fontSize: 8.5, color: '#1e3a5f', fontFamily: 'JetBrains Mono', padding: '4px 0' }}>
          no enabled transitions
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {transitions.map((tr) => {
            const firing = firingId === tr.id
            const busy   = firingId !== null
            const color  = tr.auto ? '#22d3ee' : '#fbbf24'
            return (
              <div key={tr.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 9, color, fontFamily: 'JetBrains Mono',
                    textShadow: `0 0 6px ${color}66`,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {tr.id}
                  </div>
                  <div style={{ fontSize: 7, color: '#1e3a5f', fontFamily: 'JetBrains Mono', marginTop: 1 }}>
                    {tr.from.join(' | ')} → {tr.to}
                  </div>
                </div>
                <button
                  onClick={() => handleFire(tr.id)}
                  disabled={busy}
                  style={{
                    padding: '3px 9px',
                    background: firing ? '#0a1f2e' : `${color}1a`,
                    border: `1px solid ${firing || busy ? '#0e2035' : `${color}66`}`,
                    borderRadius: 3,
                    color: firing || busy ? '#2d5080' : color,
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 8, fontWeight: 700,
                    cursor: busy ? 'not-allowed' : 'pointer',
                    letterSpacing: '0.5px', minWidth: 42, textAlign: 'center',
                    boxShadow: (!busy && !firing) ? `0 0 6px ${color}33` : 'none',
                    transition: 'all 0.15s',
                    flexShrink: 0,
                  }}
                >
                  {firing ? '…' : 'FIRE'}
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
          wordBreak: 'break-word', lineHeight: 1.5,
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
