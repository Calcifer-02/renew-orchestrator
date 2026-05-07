import { useState } from 'react'
import { completeJob, failJob } from '../lib/api'
import type { Job } from '../types'

const ROLE_COLOR: Record<string, string> = {
  analyst: '#8b5cf6',
  coder:   '#f59e0b',
  tester:  '#06b6d4',
  agent:   '#64748b',
}

const COMPLETE_RESULT = {
  summary: 'Ручной smoke-тест завершён. Код проекта не изменялся.',
  risk: 'low',
  next: 'human approval',
}

const FAIL_REASON = 'Ручной smoke-test failure'

export function JobQueue({ jobs }: { jobs: Job[] }) {
  return (
    <section className="flex flex-col border-b border-[#0e1e35]" style={{ minHeight: 0, flex: '0 0 auto', maxHeight: '55%' }}>
      <header className="px-4 py-2 flex items-center justify-between shrink-0 border-b border-[#0e1e35]">
        <span className="text-[10px] font-mono text-[#2d5080] uppercase tracking-widest">
          Очередь заданий
        </span>
        {jobs.length > 0 && (
          <span
            className="text-[10px] font-mono font-bold"
            style={{ color: '#22d3ee', textShadow: '0 0 8px #22d3ee88' }}
          >
            {jobs.length} активных
          </span>
        )}
      </header>
      <div className="overflow-y-auto flex-1">
        {jobs.length === 0 ? (
          <p className="px-4 py-4 text-[10px] font-mono text-[#1e3a5f]">
            — нет активных заданий —
          </p>
        ) : (
          jobs.map((job) => <JobCard key={job.job_id} job={job} />)
        )}
      </div>
    </section>
  )
}

function JobCard({ job }: { job: Job }) {
  const [completing, setCompleting] = useState(false)
  const [failing, setFailing]       = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [done, setDone]             = useState(false)

  const color = ROLE_COLOR[job.agent_role] ?? '#64748b'
  const busy  = completing || failing

  async function handleComplete() {
    setCompleting(true); setActionError(null)
    try {
      await completeJob(job.job_id, COMPLETE_RESULT)
      setDone(true)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setCompleting(false)
    }
  }

  async function handleFail() {
    setFailing(true); setActionError(null)
    try {
      await failJob(job.job_id, FAIL_REASON)
      setDone(true)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setFailing(false)
    }
  }

  return (
    <article
      className="px-4 py-3 border-b border-[#08121e] hover:bg-[#050d1a] transition-colors"
      style={{ borderLeft: `2px solid ${color}`, opacity: done ? 0.5 : 1 }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5">
        <span
          className="text-[9px] font-mono font-bold tracking-widest uppercase"
          style={{ color, textShadow: `0 0 8px ${color}66` }}
        >
          {job.agent_role}
        </span>
        <span className="text-[8px] font-mono text-[#1e3a5f]" style={{ userSelect: 'text' }}>
          {job.job_id.slice(0, 8)}…
        </span>
      </div>

      {/* Task chip */}
      <div className="mb-1.5">
        <span
          className="text-[9px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: `${color}18`, color, border: `1px solid ${color}44` }}
        >
          {job.task_id}
        </span>
        <span className="text-[8px] font-mono text-[#1e3a5f] ml-2">
          {job.status === 'pending' ? 'Ожидает' : job.status === 'running' ? 'Выполняется' : job.status === 'done' ? 'Завершено' : 'Ошибка'}
        </span>
      </div>

      {/* Instructions excerpt */}
      <p className="text-[9px] text-[#4a6fa5] leading-relaxed line-clamp-2 mb-1.5" style={{ userSelect: 'text' }}>
        {job.instructions}
      </p>

      {/* Fires arrow */}
      <div className="flex items-center gap-1 text-[8px] font-mono text-[#1e3a5f] mb-2">
        <span>&#8627; fires</span>
        <span className="text-[#2d5080]">{job.transition_to_fire.replace(/_/g, ' ')}</span>
      </div>

      {/* Action buttons */}
      {!done && (
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={handleComplete}
            disabled={busy}
            style={{
              flex: 1, padding: '3px 0',
              background: completing ? '#0a1a0a' : '#0a2e1a',
              border: `1px solid ${completing ? '#1e3a1e' : '#166534'}`,
              borderRadius: 3, color: completing ? '#1e3a1e' : '#22c55e',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 8, fontWeight: 700,
              cursor: busy ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s', letterSpacing: '0.3px',
            }}
          >
            {completing ? '…' : 'Завершить'}
          </button>
          <button
            onClick={handleFail}
            disabled={busy}
            style={{
              flex: 1, padding: '3px 0',
              background: failing ? '#1a0606' : '#160404',
              border: `1px solid ${failing ? '#3a1010' : '#7f1d1d'}`,
              borderRadius: 3, color: failing ? '#3a1010' : '#f87171',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 8, fontWeight: 700,
              cursor: busy ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s', letterSpacing: '0.3px',
            }}
          >
            {failing ? '…' : 'Провалить'}
          </button>
        </div>
      )}

      {done && (
        <div style={{ fontSize: 8, color: '#22c55e', fontFamily: 'JetBrains Mono', marginTop: 2 }}>
          ✓ отправлено, ожидаем SSE…
        </div>
      )}

      {actionError && (
        <div style={{
          marginTop: 4, padding: '3px 5px',
          background: '#1a0606', border: '1px solid #7f1d1d', borderRadius: 3,
          fontSize: 8, color: '#f87171', fontFamily: 'JetBrains Mono',
          wordBreak: 'break-word', userSelect: 'text',
        }}>
          {actionError}
        </div>
      )}
    </article>
  )
}
