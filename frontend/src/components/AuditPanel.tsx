import { useEffect, useState } from 'react'
import { fetchConsistency } from '../lib/api'
import type { AuditStatus } from '../types'

export function AuditPanel() {
  const [data, setData]       = useState<AuditStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  function load() {
    setLoading(true)
    setError(null)
    fetchConsistency()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])

  const ok         = data?.ok ?? true
  const warnCount  = data?.warnings.length ?? 0
  const taskCount  = data ? Object.keys(data.actual_marking).length : 0
  const eventTotal = data?.total ?? 0

  return (
    <div style={{ borderBottom: '1px solid #0e1e35', padding: '7px 10px', flexShrink: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
        <span style={{
          fontSize: 8, color: '#2d5080', fontFamily: 'JetBrains Mono',
          textTransform: 'uppercase', letterSpacing: '0.8px',
        }}>
          Аудит
        </span>
        <button
          onClick={load}
          disabled={loading}
          style={{
            background: 'none', border: 'none',
            cursor: loading ? 'not-allowed' : 'pointer',
            color: '#1e3a5f', fontFamily: 'JetBrains Mono', fontSize: 10, padding: 0, lineHeight: 1,
          }}
          title="Обновить аудит"
        >
          {loading ? '…' : '↻'}
        </button>
      </div>

      {error ? (
        <div style={{ fontSize: 8, color: '#f87171', fontFamily: 'JetBrains Mono' }}>{error}</div>
      ) : data ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: ok ? '#22c55e' : '#ef4444',
              boxShadow: `0 0 5px ${ok ? '#22c55e' : '#ef4444'}88`,
            }} />
            <span style={{
              fontSize: 8.5, fontFamily: 'JetBrains Mono', fontWeight: 700,
              color: ok ? '#22c55e' : '#ef4444',
            }}>
              {ok ? 'Консистентно' : `${warnCount} предупрежд.`}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: warnCount > 0 ? 5 : 0 }}>
            <Stat label="событий" value={eventTotal} />
            <Stat label="задач"   value={taskCount} />
            <Stat label="типов"   value={Object.keys(data.by_type).length} />
          </div>

          {warnCount > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {data.warnings.slice(0, 5).map((w, i) => (
                <div key={i} style={{
                  fontSize: 7.5, color: '#f59e0b', fontFamily: 'JetBrains Mono',
                  padding: '2px 5px', background: '#100a02', borderRadius: 2,
                  borderLeft: '2px solid #78350f', lineHeight: 1.4, wordBreak: 'break-word',
                }}>
                  {(w as Record<string, string>).issue ?? JSON.stringify(w)}
                </div>
              ))}
              {warnCount > 5 && (
                <div style={{ fontSize: 7, color: '#78350f', fontFamily: 'JetBrains Mono' }}>
                  +{warnCount - 5} ещё
                </div>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span style={{ fontSize: 8, fontFamily: 'JetBrains Mono' }}>
      <span style={{ color: '#1e3a5f' }}>{label} </span>
      <span style={{ color: '#475569', fontWeight: 700 }}>{value}</span>
    </span>
  )
}
