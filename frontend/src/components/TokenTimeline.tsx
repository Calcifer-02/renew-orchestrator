import { useEffect, useState } from 'react'
import { fetchTimeline } from '../lib/api'
import type { TimelineEntry, TokenTimeline as TL } from '../types'

const TYPE_COLOR: Record<string, string> = {
  task_created:     '#22c55e',
  transition_fired: '#22d3ee',
  job_created:      '#f59e0b',
  job_completed:    '#22c55e',
  job_failed:       '#ef4444',
  budget_spent:     '#ec4899',
  budget_blocked:   '#ef4444',
  budget_reserved:  '#f59e0b',
  budget_released:  '#22c55e',
  smoke_cleanup:    '#64748b',
}

const TYPE_LABEL: Record<string, string> = {
  task_created:     'Создан',
  transition_fired: 'Переход',
  job_created:      'Задание',
  job_completed:    'Завершено',
  job_failed:       'Провалено',
  budget_spent:     'Бюджет −',
  budget_blocked:   'Заблокировано',
  budget_reserved:  'Бюджет ↓',
  budget_released:  'Бюджет ↑',
  smoke_cleanup:    'Cleanup',
}

function fmtTs(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('ru-RU', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch {
    return ts.slice(11, 19)
  }
}

function Entry({ ev, isLast }: { ev: TimelineEntry; isLast: boolean }) {
  const color = TYPE_COLOR[ev.type] ?? '#64748b'
  const label = TYPE_LABEL[ev.type] ?? ev.type.replace(/_/g, ' ')

  return (
    <div style={{ display: 'flex', gap: 6, position: 'relative', paddingBottom: isLast ? 0 : 7 }}>
      {!isLast && (
        <div style={{
          position: 'absolute', left: 4, top: 12, bottom: 0,
          width: 1, background: '#0e1e35',
        }} />
      )}
      <div style={{
        width: 9, height: 9, borderRadius: '50%', flexShrink: 0, marginTop: 2,
        background: `${color}22`, border: `1px solid ${color}77`,
        boxShadow: `0 0 4px ${color}44`,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
          <span style={{
            fontSize: 8.5, color, fontFamily: 'JetBrains Mono',
            fontWeight: 600, whiteSpace: 'nowrap',
          }}>
            {label}
          </span>
          <span style={{ fontSize: 7, color: '#1e3a5f', fontFamily: 'JetBrains Mono', flexShrink: 0 }}>
            {fmtTs(ev.ts)}
          </span>
        </div>
        <div style={{
          fontSize: 7.5, color: '#475569', fontFamily: 'JetBrains Mono',
          lineHeight: 1.4, wordBreak: 'break-word', marginTop: 1,
        }}>
          {ev.summary}
        </div>
        {ev.job_id && (
          <div style={{ fontSize: 7, color: '#1e3a5f', fontFamily: 'JetBrains Mono' }}>
            job: {ev.job_id.slice(0, 8)}
          </div>
        )}
      </div>
    </div>
  )
}

interface Props {
  taskId: string
}

export function TokenTimeline({ taskId }: Props) {
  const [data, setData]       = useState<TL | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchTimeline(taskId)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [taskId])

  if (loading) return (
    <div style={{ padding: '10px', fontSize: 8.5, color: '#2d5080', fontFamily: 'JetBrains Mono' }}>
      Загрузка…
    </div>
  )

  if (error) return (
    <div style={{ padding: '10px', fontSize: 8.5, color: '#f87171', fontFamily: 'JetBrains Mono' }}>
      {error}
    </div>
  )

  if (!data) return null

  return (
    <div style={{ padding: '8px 10px', overflowY: 'auto' }}>
      <div style={{
        fontSize: 8, color: '#2d5080', fontFamily: 'JetBrains Mono',
        textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 8,
      }}>
        История токена · {data.events.length} событий
      </div>

      {data.events.length === 0 ? (
        <div style={{ fontSize: 8, color: '#1e3a5f', fontFamily: 'JetBrains Mono' }}>
          нет событий
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {data.events.map((ev, i) => (
            <Entry key={i} ev={ev} isLast={i === data.events.length - 1} />
          ))}
        </div>
      )}
    </div>
  )
}
