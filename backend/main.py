#!/usr/bin/env python3
"""
Renew Orchestrator — FastAPI backend

Env:  RENEW_PROJECT_DIR — absolute path to the target project
Run:  uvicorn backend.main:app --reload --port 7771
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Ensure project root is on sys.path so `bridge` package is importable
# regardless of where uvicorn is invoked from.
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from bridge.renew_bridge import (  # noqa: E402
    PLACES,
    TRANSITIONS,
    ProjectDirs,
    complete_agent_job,
    create_task,
    fail_agent_job,
    fire_transition,
    get_enabled_transitions,
    get_jobs,
    get_marking,
    tick as run_tick_bridge,
)
from bridge.economics import (  # noqa: E402
    BASE_PRICES,
    all_scores,
    explain_priority,
    get_budget,
    get_economic_log,
    get_next_job,
    get_next_task,
    set_budget,
    spend_budget,
)

# ─── Project directory ────────────────────────────────────────────────────────

_env_dir = os.environ.get("RENEW_PROJECT_DIR", "")
PROJECT_DIR = Path(_env_dir).resolve() if _env_dir else _ROOT
REPORTS_DIR = PROJECT_DIR / "orchestration" / "reports"

PLAN_FILE   = REPORTS_DIR / "refactor-plan.json"
JOBS_FILE   = REPORTS_DIR / "agent_jobs.json"
EVENTS_FILE = REPORTS_DIR / "events.ndjson"


def _dirs() -> ProjectDirs:
    return ProjectDirs(PROJECT_DIR)


# ─── Static net definition (mirrors bridge) ───────────────────────────────────

NET_DEFINITION: dict = {
    "places": PLACES,
    "transitions": [
        {k: v for k, v in t.items() if k != "agent_role"}
        for t in TRANSITIONS
    ],
}

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="Renew Orchestrator", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Request models ───────────────────────────────────────────────────────────

class CreateTaskBody(BaseModel):
    task_id: str
    file: str
    goal: str


class FireTransitionBody(BaseModel):
    task_id: str
    transition_id: str
    source: str = "human"


class CompleteJobBody(BaseModel):
    result: dict[str, Any] | None = None


class FailJobBody(BaseModel):
    reason: str


class TickBody(BaseModel):
    mode: str = "supervised"


class SetBudgetBody(BaseModel):
    total: float


# ─── Legacy helpers (used by /api/state and SSE) ─────────────────────────────

def _read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _read_events(limit: int = 60) -> list[dict]:
    if not EVENTS_FILE.exists():
        return []
    lines = EVENTS_FILE.read_text(encoding="utf-8").strip().splitlines()
    result: list[dict] = []
    for line in lines[-limit:]:
        try:
            result.append(json.loads(line))
        except Exception:
            pass
    return list(reversed(result))


def _compute_state() -> dict:
    plan = _read(PLAN_FILE, {"tasks": []})
    jobs = _read(JOBS_FILE, [])
    events = _read_events()

    marking: dict[str, list[str]] = {}
    for t in plan["tasks"]:
        marking.setdefault(t["place"], []).append(t["task_id"])

    locked = {j["task_id"] for j in jobs if j["status"] in ("pending", "running")}

    enabled_ids: list[str] = []
    for tr in TRANSITIONS:
        for place in tr["from"]:
            tokens = [tid for tid in marking.get(place, []) if tid not in locked]
            if tokens:
                enabled_ids.append(tr["id"])
                break

    return {
        "tasks": plan["tasks"],
        "marking": marking,
        "jobs": jobs,
        "active_jobs": [j for j in jobs if j["status"] in ("pending", "running")],
        "recent_events": events,
        "enabled_transitions": enabled_ids,
        "locked_tasks": sorted(locked),
    }


# ─── Routes — existing ────────────────────────────────────────────────────────

@app.get("/api/net")
def get_net() -> dict:
    """Static Petri-net definition (places + transitions)."""
    return NET_DEFINITION


@app.get("/api/state")
def get_state() -> dict:
    """Full current state: marking, jobs, recent events, enabled transitions."""
    return _compute_state()


# ─── Routes — new ─────────────────────────────────────────────────────────────

@app.get("/api/enabled")
def api_get_enabled(task_id: str | None = None) -> list:
    """
    Enabled transitions that can fire right now.
    Pass ?task_id=SHOP-001 to filter to a specific task.
    """
    return get_enabled_transitions(_dirs(), task_id)


@app.get("/api/jobs")
def api_get_jobs() -> list:
    """All agent jobs."""
    return get_jobs(_dirs())


@app.post("/api/tasks", status_code=201)
def api_create_task(body: CreateTaskBody) -> dict:
    """
    Add a task to BACKLOG.
    Idempotent: returns existing task if task_id already exists.
    """
    return create_task(_dirs(), body.task_id, body.file, body.goal)


@app.post("/api/transitions/fire")
def api_fire_transition(body: FireTransitionBody) -> dict:
    """
    Fire a Petri-net transition for a task.
    Returns 422 with detail on invalid transitions.
    """
    try:
        task = fire_transition(_dirs(), body.task_id, body.transition_id, source=body.source)
        return {"ok": True, "task": task}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/api/jobs/{job_id}/complete")
def api_complete_job(job_id: str, body: CompleteJobBody = CompleteJobBody()) -> dict:
    """
    Mark a job done and fire its transition_to_fire.
    Debits budget by BASE_PRICES[agent_role]. Idempotent if already done.
    """
    try:
        dirs = _dirs()
        job  = complete_agent_job(dirs, job_id, body.result)
        cost = BASE_PRICES.get(job.get("agent_role", ""), 0.0)
        if cost > 0:
            spend_budget(dirs, cost, "job_completed", task_id=job["task_id"], job_id=job_id)
        return {"ok": True, "job": job}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/api/jobs/{job_id}/fail")
def api_fail_job(job_id: str, body: FailJobBody) -> dict:
    """Mark a job failed. Debits half cost (partial work). Idempotent if already failed."""
    try:
        dirs = _dirs()
        job  = fail_agent_job(dirs, job_id, body.reason)
        cost = BASE_PRICES.get(job.get("agent_role", ""), 0.0) * 0.5
        if cost > 0:
            spend_budget(dirs, cost, "job_failed", task_id=job["task_id"], job_id=job_id)
        return {"ok": True, "job": job}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/api/orchestrator/tick")
def api_tick(body: TickBody = TickBody()) -> dict:
    """
    Run one orchestrator tick.
    Fires all auto-transitions, creates agent jobs, surfaces human/tool transitions.
    Idempotent — safe to call repeatedly.
    """
    return run_tick_bridge(_dirs())


# ─── Economics routes ─────────────────────────────────────────────────────────

@app.get("/api/economy/next-task")
def api_next_task() -> dict:
    """Highest economic_score task with available work. Returns null if none."""
    result = get_next_task(_dirs())
    return result if result is not None else {}


@app.get("/api/economy/next-job")
def api_next_job() -> dict:
    """Highest-priority pending job by task economic_score. Returns null if none."""
    result = get_next_job(_dirs())
    return result if result is not None else {}


@app.get("/api/economy/scores")
def api_scores() -> list:
    """Economic scores for all active (non-terminal) tasks, sorted descending."""
    return all_scores(_dirs())


@app.get("/api/economy/explain/{task_id}")
def api_explain(task_id: str) -> dict:
    """Full economic breakdown for a task: utility, cost, score, rank, budget."""
    try:
        return explain_priority(_dirs(), task_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/economy/budget")
def api_get_budget() -> dict:
    """Current budget state: total, spent, remaining."""
    return get_budget(_dirs())


@app.post("/api/economy/budget")
def api_set_budget(body: SetBudgetBody) -> dict:
    """Set budget ceiling. Cannot reduce below already-spent amount."""
    try:
        return set_budget(_dirs(), body.total)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/economy/log")
def api_econ_log(limit: int = 50) -> list:
    """Recent economic decisions from economic_decisions.ndjson."""
    return get_economic_log(_dirs(), limit=limit)


# ─── SSE ──────────────────────────────────────────────────────────────────────

async def _sse_generator():
    """
    Push full state on connect, then whenever events.ndjson changes,
    plus a heartbeat every 2 s.
    """
    last_mtime = 0.0
    tick = 0

    yield f"data: {json.dumps({'type': 'state', 'payload': _compute_state()})}\n\n"

    while True:
        await asyncio.sleep(0.5)
        tick += 1
        try:
            mtime = EVENTS_FILE.stat().st_mtime if EVENTS_FILE.exists() else 0.0
            if mtime != last_mtime or tick % 4 == 0:  # event happened OR 2-s heartbeat
                last_mtime = mtime
                yield f"data: {json.dumps({'type': 'state', 'payload': _compute_state()})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"


@app.get("/api/stream")
async def event_stream() -> StreamingResponse:
    """Server-Sent Events — pushes state on change or every 2 s."""
    return StreamingResponse(
        _sse_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# Serve built frontend in production
_dist = _ROOT / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="static")
