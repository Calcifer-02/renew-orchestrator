export type PlaceId =
  | 'BACKLOG'
  | 'READY_FOR_ANALYSIS'
  | 'ANALYZED'
  | 'READY_FOR_PATCH'
  | 'PATCH_CREATED'
  | 'TESTING'
  | 'DONE'
  | 'FAILED'
  | 'HUMAN_REVIEW'

export interface Task {
  task_id: string
  file: string
  goal: string
  place: PlaceId
  attempt: number
  status: string
}

export interface Job {
  job_id: string
  task_id: string
  agent_role: string
  transition: string           // auto transition that was fired to create this job
  transition_to_fire: string   // transition agent fires when done
  instructions: string
  status: 'pending' | 'running' | 'done' | 'failed'
  created_at: string
  started_at: string | null
  completed_at: string | null
  result: Record<string, unknown> | null
}

export interface BridgeEvent {
  type: string
  task_id?: string
  transition?: string
  to_place?: string
  job_id?: string
  agent_role?: string
  transition_to_fire?: string
  success?: boolean
  source?: 'bridge' | 'mcp' | 'human'
  note?: string
  ts: string
}

export interface NetTransition {
  id: string
  from: string[]
  to: string
  auto: boolean
}

export interface NetDefinition {
  places: string[]
  transitions: NetTransition[]
}

export interface EnabledTransition extends NetTransition {
  eligible_tasks: string[]
}

export interface TickResult {
  fired: Array<{ task_id: string; transition: string; to_place: string }>
  jobs_created: string[]
  waiting_for_human: Array<{ task_id: string; transition: string; place: string }>
  tool_ready: Array<{ task_id: string; transition: string }>
  blocked: Array<{ task_id: string; reason: string }>
}

export interface OrchestratorState {
  tasks: Task[]
  marking: Record<string, string[]>
  jobs: Job[]
  active_jobs: Job[]
  recent_events: BridgeEvent[]
  enabled_transitions: string[]
  locked_tasks: string[]
}
