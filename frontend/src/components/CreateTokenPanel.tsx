import { useState } from 'react'
import { createTask } from '../lib/api'
import type { Task } from '../types'

const INPUT: React.CSSProperties = {
  flex: 1,
  background: '#060d1a',
  border: '1px solid #0e2035',
  borderRadius: 3,
  color: '#94a3b8',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  padding: '3px 6px',
  outline: 'none',
  minWidth: 0,
}

const FIELDS = [
  { key: 'task_id' as const, placeholder: 'SHOP-001' },
  { key: 'file'    as const, placeholder: 'shop/views.py' },
  { key: 'goal'    as const, placeholder: 'optimize DB queries' },
]

interface Props {
  onCreated?: (task: Task) => void
}

export function CreateTokenPanel({ onCreated }: Props) {
  const [open, setOpen]         = useState(false)
  const [jsonMode, setJsonMode] = useState(false)
  const [form, setForm]         = useState({ task_id: '', file: '', goal: '' })
  const [jsonText, setJsonText] = useState('{\n  "task_id": "",\n  "file": "",\n  "goal": ""\n}')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [successId, setSuccessId] = useState<string | null>(null)

  function setField(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError(null); setSuccessId(null)
    try {
      const payload = jsonMode
        ? (JSON.parse(jsonText) as { task_id: string; file: string; goal: string })
        : form
      if (!payload.task_id?.trim() || !payload.file?.trim() || !payload.goal?.trim()) {
        throw new Error('All fields required')
      }
      const task = await createTask(payload)
      setSuccessId(task.task_id)
      setForm({ task_id: '', file: '', goal: '' })
      setJsonText('{\n  "task_id": "",\n  "file": "",\n  "goal": ""\n}')
      onCreated?.(task)
      setTimeout(() => { setSuccessId(null); setOpen(false) }, 2200)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ borderBottom: '1px solid #0e1e35', padding: '8px 10px', flexShrink: 0 }}>
      {/* Toggle button */}
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 6,
          background: 'transparent', border: '1px solid #0e2035', borderRadius: 4,
          padding: '4px 8px', cursor: 'pointer', color: '#22d3ee',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '1px',
        }}
      >
        <span style={{ fontSize: 13, lineHeight: 1, marginTop: -1 }}>{open ? '−' : '+'}</span>
        GENERATE TOKEN
      </button>

      {open && (
        <form onSubmit={handleSubmit} style={{ marginTop: 8 }}>
          {/* Mode tabs */}
          <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
            {(['form', 'json'] as const).map((m) => {
              const active = jsonMode ? m === 'json' : m === 'form'
              return (
                <button key={m} type="button" onClick={() => setJsonMode(m === 'json')}
                  style={{
                    flex: 1, padding: '2px 0', border: '1px solid',
                    borderColor: active ? '#22d3ee44' : '#0e1e35', borderRadius: 3,
                    background: active ? '#0a1f2e' : 'transparent',
                    color: active ? '#22d3ee' : '#2d5080',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 9, cursor: 'pointer',
                    textTransform: 'uppercase', letterSpacing: '0.5px',
                  }}
                >
                  {m}
                </button>
              )
            })}
          </div>

          {jsonMode ? (
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              style={{
                ...INPUT, width: '100%', height: 84, resize: 'vertical',
                boxSizing: 'border-box', color: '#7dd3fc', lineHeight: 1.5,
              }}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {FIELDS.map(({ key, placeholder }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{
                    width: 42, fontSize: 9, color: '#2d5080',
                    fontFamily: 'JetBrains Mono, monospace', flexShrink: 0,
                  }}>
                    {key}
                  </span>
                  <input
                    value={form[key]}
                    onChange={(e) => setField(key, e.target.value)}
                    placeholder={placeholder}
                    style={INPUT}
                  />
                </div>
              ))}
            </div>
          )}

          {error && (
            <div style={{
              marginTop: 6, padding: '4px 6px', background: '#1a0606',
              border: '1px solid #7f1d1d', borderRadius: 3,
              fontSize: 8.5, color: '#ef4444', fontFamily: 'JetBrains Mono, monospace',
              wordBreak: 'break-word',
            }}>
              {error}
            </div>
          )}
          {successId && (
            <div style={{
              marginTop: 6, fontSize: 9, color: '#22c55e',
              fontFamily: 'JetBrains Mono, monospace',
              textShadow: '0 0 8px #22c55e88',
            }}>
              ✓ {successId} added to BACKLOG
            </div>
          )}

          <button
            type="submit" disabled={loading}
            style={{
              marginTop: 8, width: '100%', padding: '4px 0',
              background: loading ? '#0a1f2e' : 'linear-gradient(135deg,#0ea5e9,#0369a1)',
              border: 'none', borderRadius: 3,
              color: loading ? '#2d5080' : '#e0f2fe',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer', letterSpacing: '1px',
            }}
          >
            {loading ? 'creating…' : 'CREATE'}
          </button>
        </form>
      )}
    </div>
  )
}
