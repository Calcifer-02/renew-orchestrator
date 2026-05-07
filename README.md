# renew-orchestrator

Petri-net agent orchestrator with a real-time dashboard.

Tracks software refactoring tasks through a workflow modelled as a Petri net,
dispatches work to AI agents, and visualises live state via a dark-theme
neon dashboard.

```
BACKLOG --[claim_analysis]--> READY_FOR_ANALYSIS --[analysis_finished]--> ANALYZED
   --[claim_patch]--> READY_FOR_PATCH --[patch_created]--> PATCH_CREATED
   --[start_testing]--> TESTING --[tests_passed]--> DONE
                              |--[tests_failed]--> FAILED --[retry]--> READY_FOR_ANALYSIS
                              |--[escalate]-------> HUMAN_REVIEW
```

## Structure

```
renew-orchestrator/
  backend/          FastAPI server  (port 7771)
  bridge/           Orchestration kernel — Petri-net engine + file I/O
  frontend/         React + Vite dashboard  (port 5173 in dev)
  mcp/              MCP server stub (planned)
```

## Quick start

```bash
# 1. Python env
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt

# 2. Start backend (point at your target project)
$env:RENEW_PROJECT_DIR = "C:\projects\MyProject"
uvicorn backend.main:app --reload --port 7771

# 3. Start frontend (dev)
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

## Bridge CLI

```bash
python bridge/renew_bridge.py --project-dir PATH marking
python bridge/renew_bridge.py --project-dir PATH enabled [TASK_ID]
python bridge/renew_bridge.py --project-dir PATH fire TASK_ID TRANSITION_ID
python bridge/renew_bridge.py --project-dir PATH add-task TASK_ID FILE GOAL
python bridge/renew_bridge.py --project-dir PATH jobs
python bridge/renew_bridge.py --project-dir PATH complete-job JOB_ID
python bridge/renew_bridge.py --project-dir PATH fail-job JOB_ID REASON
```

## Target project layout

The orchestrator expects this structure inside the target project:

```
<project>/
  orchestration/
    .orchestrator.json          # {"project": "...", "workflow": "..."}
    reports/
      refactor-plan.json        # task list + Petri-net marking
      agent_jobs.json           # agent job queue
      trace.json                # full event trace (array)
      events.ndjson             # append-only event log
      current_marking.md        # human-readable marking snapshot
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/net` | Static Petri-net definition |
| GET | `/api/state` | Full current state |
| GET | `/api/enabled` | Enabled transitions (optional `?task_id=`) |
| GET | `/api/jobs` | All agent jobs |
| GET | `/api/stream` | SSE — pushes state on change |
| POST | `/api/tasks` | Create task `{task_id, file, goal}` |
| POST | `/api/transitions/fire` | Fire transition `{task_id, transition_id, source?}` |
| POST | `/api/jobs/{id}/complete` | Mark job done `{result?}` |
| POST | `/api/jobs/{id}/fail` | Mark job failed `{reason}` |
