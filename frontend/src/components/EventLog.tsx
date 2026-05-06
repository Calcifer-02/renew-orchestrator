import type { BridgeEvent } from '../types'

const EVENT_COLOR: Record<string, string> = {
  transition_fired: '#22c55e',
  job_created:      '#0ea5e9',
  job_completed:    '#8b5cf6',
  job_failed:       '#ef4444',
  bridge_started:   '#f59e0b',
  bridge_tick:      '#1e3a5f',
}

const SOURCE_LABEL: Record<string, string> = {
  bridge: 'BRG',
  mcp:    'MCP',
  human:  'USR',
}

export function EventLog({ events }: { events: BridgeEvent[] }) {
  return (
    <section className="flex flex-col flex-1 min-h-0">
      <header className="px-4 py-2 flex items-center justify-between shrink-0 border-b border-[#0e1e35]">
        <span className="text-[10px] font-mono text-[#2d5080] uppercase tracking-widest">
          Event Log
        </span>
        <span className="text-[9px] font-mono text-[#1e3a5f]">{events.length} events</span>
      </header>
      <div className="overflow-y-auto flex-1">
        {events.length === 0 ? (
          <p className="px-4 py-4 text-[10px] font-mono text-[#1e3a5f]">
            — no events yet —
          </p>
        ) : (
          events.map((ev, i) => <EventRow key={`${ev.ts}-${i}`} ev={ev} />)
        )}
      </div>
    </section>
  )
}

function EventRow({ ev }: { ev: BridgeEvent }) {
  const color = EVENT_COLOR[ev.type] ?? '#334155'
  const ts = (ev.ts ?? '').slice(11, 19)

  let detail = ''
  if (ev.type === 'transition_fired' && ev.transition)
    detail = `${ev.transition.replace(/_/g, ' ')} → ${ev.to_place}`
  else if (ev.type === 'job_created' && ev.job_id)
    detail = `${ev.job_id} · ${ev.agent_role}`
  else if (ev.type === 'job_completed')
    detail = ev.success ? '✓ success' : '✗ failed'
  else if (ev.type === 'bridge_started')
    detail = 'runtime started'

  return (
    <div className="px-4 py-1.5 border-b border-[#060e1a] hover:bg-[#050d1a] transition-colors group">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Timestamp */}
        <span className="text-[8px] font-mono text-[#1e3a5f] group-hover:text-[#2d5080] transition-colors">
          {ts}
        </span>

        {/* Event type badge */}
        <span
          className="text-[8px] font-mono font-bold"
          style={{ color, textShadow: `0 0 5px ${color}55` }}
        >
          {ev.type.replace(/_/g, ' ')}
        </span>

        {/* Source badge */}
        {ev.source && (
          <span
            className="text-[7px] font-mono px-1 rounded"
            style={{ color: '#2d5080', border: '1px solid #1e3a5f' }}
          >
            {SOURCE_LABEL[ev.source] ?? ev.source}
          </span>
        )}

        {/* Task ID */}
        {ev.task_id && (
          <span className="text-[8px] font-mono text-[#3d6090]">{ev.task_id}</span>
        )}
      </div>

      {/* Detail */}
      {detail && (
        <p className="text-[8px] font-mono text-[#2d5080] mt-0.5 pl-0">{detail}</p>
      )}
    </div>
  )
}
