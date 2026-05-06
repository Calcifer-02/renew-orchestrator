import type { NetDefinition, OrchestratorState } from '../types'

const BASE = import.meta.env.VITE_API_URL ?? ''

export async function fetchNet(): Promise<NetDefinition> {
  const res = await fetch(`${BASE}/api/net`)
  if (!res.ok) throw new Error(`/api/net ${res.status}`)
  return res.json()
}

export async function fetchState(): Promise<OrchestratorState> {
  const res = await fetch(`${BASE}/api/state`)
  if (!res.ok) throw new Error(`/api/state ${res.status}`)
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
