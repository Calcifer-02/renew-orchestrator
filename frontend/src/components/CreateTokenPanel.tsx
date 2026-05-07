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

const DEFAULT_JSON = JSON.stringify({
  task_id: '',
  file: '',
  goal: '',
  initial_place: 'BACKLOG',
  type: 'refactor',
  risk: 'low',
  autonomy: 'supervised',
}, null, 2)

interface Props {
  onCreated?: (task: Task) => void
}

export function CreateTokenPanel({ onCreated }: Props) {
  const [open, setOpen]         = useState(false)
  const [jsonMode, setJsonMode] = useState(false)
  const [form, setForm]         = useState({ task_id: '', file: '', goal: '' })
  const [jsonText, setJsonText] = useState(DEFAULT_JSON)
  const [loading, setLoading]   = useState(false)
  const [errors, setErrors]     = useState<string[]>([])
  const [successId, setSuccessId] = useState<string | null>(null)
  const [copied, setCopied]     = useState(false)

  function setField(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors([])
  }

  const canSubmit = jsonMode
    ? jsonText.trim().length > 2
    : (form.task_id.trim() && form.file.trim() && form.goal.trim())

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErrors([])
    setSuccessId(null)

    let payload: { task_id: string; file: string; goal: string }

    if (jsonMode) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(jsonText) as Record<string, unknown>
      } catch {
        setErrors(['Некорректный JSON'])
        return
      }
      const errs: string[] = []
      if (!String(parsed.task_id ?? '').trim()) errs.push('task_id обязателен')
      if (!String(parsed.file   ?? '').trim()) errs.push('file обязателен')
      if (!String(parsed.goal   ?? '').trim()) errs.push('goal обязателен')
      if (errs.length) { setErrors(errs); return }
      payload = {
        task_id: String(parsed.task_id),
        file:    String(parsed.file),
        goal:    String(parsed.goal),
      }
    } else {
      const errs: string[] = []
      if (!form.task_id.trim()) errs.push('task_id обязателен')
      if (!form.file.trim())    errs.push('file обязателен')
      if (!form.goal.trim())    errs.push('goal обязателен')
      if (errs.length) { setErrors(errs); return }
      payload = form
    }

    setLoading(true)
    try {
      const task = await createTask(payload)
      setSuccessId(task.task_id)
      setForm({ task_id: '', file: '', goal: '' })
      setJsonText(DEFAULT_JSON)
      onCreated?.(task)
      setTimeout(() => { setSuccessId(null); setOpen(false) }, 2200)
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)])
    } finally {
      setLoading(false)
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(jsonText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div style={{ borderBottom: '1px solid #0e1e35', padding: '8px 10px', flexShrink: 0 }}>
      <button
        onClick={() => { setOpen(!open); setErrors([]) }}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 6,
          background: 'transparent', border: '1px solid #0e2035', borderRadius: 4,
          padding: '4px 8px', cursor: 'pointer', color: '#22d3ee',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '1px',
        }}
      >
        <span style={{ fontSize: 13, lineHeight: 1, marginTop: -1 }}>{open ? '−' : '+'}</span>
        Создать токен
      </button>

      {open && (
        <form onSubmit={handleSubmit} style={{ marginTop: 8 }}>
          {/* Mode tabs */}
          <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
            {(['форма', 'json'] as const).map((m) => {
              const active = jsonMode ? m === 'json' : m === 'форма'
              return (
                <button key={m} type="button"
                  onClick={() => { setJsonMode(m === 'json'); setErrors([]) }}
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
            <div style={{ position: 'relative' }}>
              <textarea
                value={jsonText}
                onChange={(e) => { setJsonText(e.target.value); setErrors([]) }}
                style={{
                  ...INPUT, width: '100%', height: 120, resize: 'vertical',
                  boxSizing: 'border-box', color: '#7dd3fc', lineHeight: 1.5,
                  userSelect: 'text',
                }}
              />
              <button
                type="button"
                onClick={handleCopy}
                style={{
                  position: 'absolute', top: 4, right: 4,
                  background: copied ? '#0a2e1a' : '#0a1f2e',
                  border: `1px solid ${copied ? '#22c55e44' : '#1e3a5f'}`,
                  borderRadius: 3, padding: '2px 6px',
                  color: copied ? '#22c55e' : '#2d5080',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 8,
                  cursor: 'pointer', transition: 'all 0.15s',
                }}
              >
                {copied ? 'Скопировано ✓' : 'Копировать JSON'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {([
                { key: 'task_id' as const, placeholder: 'SHOP-001', label: 'task_id' },
                { key: 'file'    as const, placeholder: 'shop/views.py', label: 'file' },
                { key: 'goal'    as const, placeholder: 'optimize DB queries', label: 'goal' },
              ]).map(({ key, placeholder, label }) => {
                const missing = errors.some((e) => e.includes(key))
                return (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{
                      width: 42, fontSize: 9,
                      color: missing ? '#ef4444' : '#2d5080',
                      fontFamily: 'JetBrains Mono, monospace', flexShrink: 0,
                    }}>
                      {label}
                    </span>
                    <input
                      value={form[key]}
                      onChange={(e) => setField(key, e.target.value)}
                      placeholder={placeholder}
                      style={{
                        ...INPUT,
                        borderColor: missing ? '#7f1d1d' : '#0e2035',
                        userSelect: 'text',
                      }}
                    />
                  </div>
                )
              })}
            </div>
          )}

          {errors.length > 0 && (
            <div style={{
              marginTop: 6, padding: '4px 6px', background: '#1a0606',
              border: '1px solid #7f1d1d', borderRadius: 3,
              fontFamily: 'JetBrains Mono, monospace', userSelect: 'text',
            }}>
              {errors.map((err) => (
                <div key={err} style={{ fontSize: 8.5, color: '#ef4444' }}>{err}</div>
              ))}
            </div>
          )}

          {successId && (
            <div style={{
              marginTop: 6, fontSize: 9, color: '#22c55e',
              fontFamily: 'JetBrains Mono, monospace',
              textShadow: '0 0 8px #22c55e88',
            }}>
              ✓ {successId} добавлен в BACKLOG
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !canSubmit}
            style={{
              marginTop: 8, width: '100%', padding: '4px 0',
              background: (loading || !canSubmit) ? '#0a1020' : 'linear-gradient(135deg,#0ea5e9,#0369a1)',
              border: 'none', borderRadius: 3,
              color: (loading || !canSubmit) ? '#2d5080' : '#e0f2fe',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
              cursor: (loading || !canSubmit) ? 'not-allowed' : 'pointer',
              letterSpacing: '1px',
            }}
          >
            {loading ? 'Создание…' : 'Создать'}
          </button>
        </form>
      )}
    </div>
  )
}
