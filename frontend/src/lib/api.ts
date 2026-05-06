import type { NetDefinition, OrchestratorState, Task } from '../types'

const BASE = import.meta.env.VITE_API_URL ?? ''

async function _throw(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({ detail: res.statusText }))
  throw new Error(body.detail ?? `HTTP ${res.status}`)
}

export async function fetchNet(): Promise<NetDefinition> {
  const res = await fetch(`${BASE}/api/net`)
  if (!res.ok) await _throw(res)
  return res.json()
}

export async function fetchState(): Promise<OrchestratorState> {
  const res = await fetch(`${BASE}/api/state`)
  if (!res.ok) await _throw(res)
  return res.json()
}

export async function createTask(payload: {
  task_id: string
  file: string
  goal: string
}): Promise<Task> {
  const res = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) await _throw(res)
  return res.json()
}

export async function fireTransition(payload: {
  task_id: string
  transition_id: string
  source?: string
}): Promise<{ ok: boolean; task: Task }> {
  const res = await fetch(`${BASE}/api/transitions/fire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'human', ...payload }),
  })
  if (!res.ok) await _throw(res)
  return res.json()
}

type SSECallback = {
  onState: (s: OrchestratorState) => void
  onError?: (msg: string) => void
  onOpen?: () => void
}

export function connectSSE({ onState, onError, onOpen }: SSECallback): () => void {
  const es = new EventSource(`${BASE}/api/stream`)

  es.onopen = () => onOpen?.()

  es.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as
        | { type: 'state'; payload: OrchestratorState }
        | { type: 'error'; message: string }
      if (msg.type === 'state') onState(msg.payload)
      else if (msg.type === 'error') onError?.(msg.message)
    } catch {
      // ignore parse errors
    }
  }

  es.onerror = () => onError?.('SSE disconnected')

  return () => es.close()
}
