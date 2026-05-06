import type { Job } from '../types'

const ROLE_COLOR: Record<string, string> = {
  analyst: '#8b5cf6',
  coder:   '#f59e0b',
  tester:  '#06b6d4',
  agent:   '#64748b',
}

export function JobQueue({ jobs }: { jobs: Job[] }) {
  return (
    <section className="flex flex-col border-b border-[#0e1e35]" style={{ minHeight: 0, flex: '0 0 auto', maxHeight: '50%' }}>
      <header className="px-4 py-2 flex items-center justify-between shrink-0 border-b border-[#0e1e35]">
        <span className="text-[10px] font-mono text-[#2d5080] uppercase tracking-widest">
          Agent Jobs
        </span>
        {jobs.length > 0 && (
          <span
            className="text-[10px] font-mono font-bold"
            style={{ color: '#22d3ee', textShadow: '0 0 8px #22d3ee88' }}
          >
            {jobs.length} active
          </span>
        )}
      </header>
      <div className="overflow-y-auto flex-1">
        {jobs.length === 0 ? (
          <p className="px-4 py-4 text-[10px] font-mono text-[#1e3a5f]">
            — waiting for bridge —
          </p>
        ) : (
          jobs.map((job) => <JobCard key={job.job_id} job={job} />)
        )}
      </div>
    </section>
  )
}

function JobCard({ job }: { job: Job }) {
  const color = ROLE_COLOR[job.agent_role] ?? '#64748b'

  return (
    <article
      className="px-4 py-3 border-b border-[#08121e] hover:bg-[#050d1a] transition-colors"
      style={{ borderLeft: `2px solid ${color}` }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5">
        <span
          className="text-[9px] font-mono font-bold tracking-widest uppercase"
          style={{ color, textShadow: `0 0 8px ${color}66` }}
        >
          {job.agent_role}
        </span>
        <span className="text-[9px] font-mono text-[#2d5080]">{job.job_id}</span>
      </div>

      {/* Task chip */}
      <div className="mb-1.5">
        <span
          className="text-[9px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: `${color}18`, color, border: `1px solid ${color}44` }}
        >
          {job.task_id}
        </span>
      </div>

      {/* Instructions excerpt */}
      <p className="text-[9px] text-[#4a6fa5] leading-relaxed line-clamp-2 mb-1.5">
        {job.instructions}
      </p>

      {/* Fires arrow */}
      <div className="flex items-center gap-1 text-[8px] font-mono text-[#1e3a5f]">
        <span>↳ fires</span>
        <span className="text-[#2d5080]">{job.transition_to_fire.replace(/_/g, ' ')}</span>
      </div>
    </article>
  )
}
