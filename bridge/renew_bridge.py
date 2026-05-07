#!/usr/bin/env python3
"""
Renew Orchestrator — universal orchestration kernel (v2).

All state lives in <project-dir>/orchestration/reports/.
task.place is ONLY mutated via fire_transition() — never directly.

Public API:
  get_marking(dirs)
  get_enabled_transitions(dirs, task_id=None)
  create_task(dirs, task_id, file, goal)                   idempotent
  fire_transition(dirs, task_id, transition_id, source)
  tick(dirs)                                               idempotent tick
  get_jobs(dirs)
  complete_agent_job(dirs, job_id, result=None)            idempotent
  fail_agent_job(dirs, job_id, reason)                     idempotent
  acquire_resource_lock(dirs, resource, task_id, job_id)
  release_resource_locks_for_job(dirs, job_id)
  timeout_stale_human_tasks(dirs, max_hours=72)
  replay(dirs, dry_run=True)

CLI:
  python bridge/renew_bridge.py --project-dir PATH marking
  python bridge/renew_bridge.py --project-dir PATH enabled [TASK_ID]
  python bridge/renew_bridge.py --project-dir PATH fire TASK_ID TRANSITION_ID
  python bridge/renew_bridge.py --project-dir PATH add-task TASK_ID FILE GOAL
  python bridge/renew_bridge.py --project-dir PATH tick
  python bridge/renew_bridge.py --project-dir PATH jobs
  python bridge/renew_bridge.py --project-dir PATH complete-job JOB_ID
  python bridge/renew_bridge.py --project-dir PATH fail-job JOB_ID REASON
  python bridge/renew_bridge.py --project-dir PATH timeout-human [--max-hours 72]
  python bridge/renew_bridge.py --project-dir PATH replay [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# ─── Schema / runtime version ─────────────────────────────────────────────────

SCHEMA_VERSION = "1.0"

# ─── Net definition ───────────────────────────────────────────────────────────

PLACES: list[str] = [
    "BACKLOG", "READY_FOR_ANALYSIS", "ANALYZED",
    "READY_FOR_PATCH", "PATCH_CREATED", "TESTING",
    "DONE", "FAILED", "HUMAN_REVIEW", "REVIEW_TIMEOUT",
]

# Transition kinds (derived, not stored):
#   auto   → bridge/tick fires; creates agent job
#   human  → requires explicit human action  (kind="human" or agent_role="human")
#   system → internal command only (agent_role="system") — tick skips
#   tool   → reserved for shell execution   (kind="tool")
#   agent  → agent fires when done          (auto=False, non-human, non-system)
TRANSITIONS: list[dict] = [
    {"id": "claim_analysis",    "from": ["BACKLOG"],            "to": "READY_FOR_ANALYSIS", "auto": True,  "agent_role": "analyst"},
    {"id": "analysis_finished", "from": ["READY_FOR_ANALYSIS"], "to": "ANALYZED",           "auto": False, "agent_role": "analyst"},
    # Human gate at ANALYZED — approve triggers coder job; escalate sends to review
    {"id": "approve_plan",      "from": ["ANALYZED"],           "to": "READY_FOR_PATCH",    "auto": False, "agent_role": "coder",   "kind": "human"},
    {"id": "escalate_review",   "from": ["ANALYZED"],           "to": "HUMAN_REVIEW",       "auto": False, "agent_role": "human",   "kind": "human"},
    {"id": "patch_created",     "from": ["READY_FOR_PATCH"],    "to": "PATCH_CREATED",      "auto": False, "agent_role": "coder"},
    {"id": "start_testing",     "from": ["PATCH_CREATED"],      "to": "TESTING",            "auto": True,  "agent_role": "tester"},
    {"id": "tests_passed",      "from": ["TESTING"],            "to": "DONE",               "auto": False, "agent_role": "tester"},
    {"id": "tests_failed",      "from": ["TESTING"],            "to": "FAILED",             "auto": False, "agent_role": "tester"},
    {"id": "retry",             "from": ["FAILED"],             "to": "READY_FOR_ANALYSIS", "auto": True,  "agent_role": "analyst"},
    {"id": "escalate",          "from": ["TESTING", "FAILED"],  "to": "HUMAN_REVIEW",       "auto": False, "agent_role": "human",   "kind": "human"},
    # Recovery transitions from HUMAN_REVIEW
    {"id": "reopen",            "from": ["HUMAN_REVIEW"],       "to": "READY_FOR_ANALYSIS", "auto": False, "agent_role": "human",   "kind": "human"},
    {"id": "close_wontfix",     "from": ["HUMAN_REVIEW"],       "to": "FAILED",             "auto": False, "agent_role": "human",   "kind": "human"},
    # Timeout — only fired by timeout_stale_human_tasks; hidden from UI
    {"id": "review_timeout",    "from": ["HUMAN_REVIEW"],       "to": "REVIEW_TIMEOUT",     "auto": False, "agent_role": "system",  "kind": "system"},
]

_TR: dict[str, dict] = {t["id"]: t for t in TRANSITIONS}

# Tokens in terminal places are skipped by tick
_TERMINAL_PLACES = {"DONE", "REVIEW_TIMEOUT"}

_INSTRUCTIONS: dict[str, str] = {
    "analyst": "Analyze `{file}` -> {goal}",
    "coder":   "Create a patch for `{file}` addressing: {goal}",
    "tester":  "Test `{file}` -> verify: {goal}",
    "human":   "(manual review required for `{file}`)",
    "system":  "(system action for `{file}`)",
}


# ─── ProjectDirs ──────────────────────────────────────────────────────────────

class ProjectDirs:
    def __init__(self, project_dir: str | Path):
        self.root    = Path(project_dir).resolve()
        self.orch    = self.root / "orchestration"
        self.reports = self.orch / "reports"

    def ensure(self) -> "ProjectDirs":
        self.reports.mkdir(parents=True, exist_ok=True)
        return self

    @property
    def plan_file(self) -> Path:
        return self.reports / "refactor-plan.json"

    @property
    def jobs_file(self) -> Path:
        return self.reports / "agent_jobs.json"

    @property
    def trace_file(self) -> Path:
        return self.reports / "trace.json"

    @property
    def events_file(self) -> Path:
        return self.reports / "events.ndjson"

    @property
    def marking_file(self) -> Path:
        return self.reports / "current_marking.md"

    @property
    def locks_file(self) -> Path:
        return self.reports / "resource_locks.json"

    @property
    def config_file(self) -> Path:
        return self.orch / ".orchestrator.json"

    @property
    def workflow_file(self) -> Path:
        return self.orch / "workflow.json"


# ─── Atomic I/O ───────────────────────────────────────────────────────────────

def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _append_ndjson(path: Path, event: dict) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── Internal helpers ─────────────────────────────────────────────────────────

def _load_tasks(dirs: ProjectDirs) -> list[dict]:
    return _read_json(dirs.plan_file, {"tasks": []}).get("tasks", [])


def _save_tasks(dirs: ProjectDirs, tasks: list[dict]) -> None:
    _write_json(dirs.plan_file, {"tasks": tasks})


def _load_jobs(dirs: ProjectDirs) -> list[dict]:
    return _read_json(dirs.jobs_file, [])


def _save_jobs(dirs: ProjectDirs, jobs: list[dict]) -> None:
    _write_json(dirs.jobs_file, jobs)


def _load_locks(dirs: ProjectDirs) -> list[dict]:
    return _read_json(dirs.locks_file, [])


def _save_locks(dirs: ProjectDirs, locks: list[dict]) -> None:
    _write_json(dirs.locks_file, locks)


def _emit(dirs: ProjectDirs, event: dict) -> None:
    """
    Append event to events.ndjson and trace.json.
    Auto-injects event_id and event_version for new events.
    """
    event.setdefault("ts", _now())
    event.setdefault("event_version", "1.0")
    event.setdefault("event_id", str(uuid.uuid4()))
    _append_ndjson(dirs.events_file, event)
    trace = _read_json(dirs.trace_file, [])
    trace.append(event)
    _write_json(dirs.trace_file, trace)


def _update_marking_md(dirs: ProjectDirs, tasks: list[dict]) -> None:
    marking: dict[str, list[str]] = {}
    for t in tasks:
        marking.setdefault(t["place"], []).append(t["task_id"])
    lines = [
        "# Current Marking\n\n",
        f"_updated: {_now()}_\n\n",
        "| Place | Tokens |\n",
        "|---|---|\n",
    ]
    for place in PLACES:
        tokens = marking.get(place, [])
        lines.append(f"| {place} | {', '.join(tokens) if tokens else '-'} |\n")
    dirs.marking_file.write_text("".join(lines), encoding="utf-8")


def _transition_kind(tr: dict) -> str:
    """
    Classify a transition for processing:
      human  — explicit human action  (kind="human" or agent_role="human")
      system — internal command only  (kind="system" or agent_role="system")
      tool   — shell execution        (kind="tool")
      auto   — bridge/tick fires      (auto=True)
      agent  — agent fires when done  (auto=False, non-human)
    """
    k = tr.get("kind", "")
    r = tr.get("agent_role", "")
    if k == "human" or r == "human":
        return "human"
    if k == "system" or r == "system":
        return "system"
    if k == "tool":
        return "tool"
    if tr["auto"]:
        return "auto"
    return "agent"


def _next_non_auto_transition(from_place: str, agent_role: str) -> str | None:
    """Find the non-auto transition an agent fires after landing in from_place."""
    for tr in TRANSITIONS:
        if from_place in tr["from"] and tr.get("agent_role") == agent_role and not tr["auto"]:
            return tr["id"]
    return None


def _ensure_job(dirs: ProjectDirs, task: dict, tr: dict, jobs: list[dict]) -> dict | None:
    """
    Create agent job for an auto/human-approved transition (idempotent).
    - For coder jobs: acquires file resource lock.
    - Returns None if role is human/system.
    - Returns existing job if already pending/running.
    """
    role = tr.get("agent_role", "")
    if not role or role in ("human", "system"):
        return None

    transition_to_fire = _next_non_auto_transition(tr["to"], role) or tr["id"]

    existing = next(
        (j for j in jobs
         if j["task_id"] == task["task_id"]
         and j.get("transition_to_fire") == transition_to_fire
         and j["status"] in ("pending", "running")),
        None,
    )
    if existing:
        return existing

    job_id = str(uuid.uuid4())
    instructions = _INSTRUCTIONS.get(role, "{file}: {goal}").format(
        file=task.get("file", "?"),
        goal=task.get("goal", "?"),
    )
    job: dict = {
        "object_type":        "job",
        "schema_version":     SCHEMA_VERSION,
        "job_id":             job_id,
        "task_id":            task["task_id"],
        "agent_role":         role,
        "transition":         tr["id"],
        "transition_to_fire": transition_to_fire,
        "instructions":       instructions,
        "status":             "pending",
        "created_at":         _now(),
        "started_at":         None,
        "completed_at":       None,
        "result":             None,
    }
    jobs.append(job)
    _save_jobs(dirs, jobs)

    # Acquire file resource lock for coder jobs
    if role == "coder" and task.get("file"):
        acquire_resource_lock(dirs, f"file:{task['file']}", task["task_id"], job_id)

    _emit(dirs, {
        "type":               "job_created",
        "job_id":             job_id,
        "task_id":            task["task_id"],
        "agent_role":         role,
        "transition":         tr["id"],
        "transition_to_fire": transition_to_fire,
        "source":             "bridge",
    })
    return job


# ─── Public API ───────────────────────────────────────────────────────────────

def get_marking(dirs: ProjectDirs) -> dict[str, list[str]]:
    """Return place -> [task_id, ...] for all places."""
    tasks = _load_tasks(dirs)
    result: dict[str, list[str]] = {p: [] for p in PLACES}
    for t in tasks:
        result.setdefault(t["place"], []).append(t["task_id"])
    return result


def get_enabled_transitions(
    dirs: ProjectDirs,
    task_id: str | None = None,
) -> list[dict]:
    """
    Return transitions that can fire now.
    Enabled when at least one unlocked token sits in a source place.
    """
    tasks  = _load_tasks(dirs)
    jobs   = _load_jobs(dirs)
    locked = {j["task_id"] for j in jobs if j["status"] in ("pending", "running")}

    marking: dict[str, list[str]] = {}
    for t in tasks:
        marking.setdefault(t["place"], []).append(t["task_id"])

    result = []
    for tr in TRANSITIONS:
        for place in tr["from"]:
            tokens = [tid for tid in marking.get(place, []) if tid not in locked]
            if task_id:
                tokens = [tid for tid in tokens if tid == task_id]
            if tokens:
                result.append({**tr, "eligible_tasks": tokens})
                break
    return result


def create_task(dirs: ProjectDirs, task_id: str, file: str, goal: str) -> dict:
    """
    Add a task (token) to BACKLOG.
    Idempotent: returns existing task unchanged if task_id already exists.
    Backward-compatible: new fields only on new tasks.
    """
    dirs.ensure()
    tasks = _load_tasks(dirs)
    existing = next((t for t in tasks if t["task_id"] == task_id), None)
    if existing:
        return existing

    now = _now()
    task: dict = {
        "object_type":            "token",
        "schema_version":         SCHEMA_VERSION,
        "task_id":                task_id,
        "file":                   file,
        "goal":                   goal,
        "place":                  "BACKLOG",
        "attempt":                0,
        "status":                 "pending",
        "created_at":             now,
        "place_entered_at":       now,
        "approval_metadata":      None,
        "human_review_context":   None,
        "artifacts":              [],
    }
    tasks.append(task)
    _save_tasks(dirs, tasks)
    _update_marking_md(dirs, tasks)
    _emit(dirs, {
        "type":     "task_created",
        "task_id":  task_id,
        "to_place": "BACKLOG",
        "source":   "bridge",
    })
    return task


def acquire_resource_lock(
    dirs: ProjectDirs,
    resource: str,
    task_id: str,
    job_id: str,
) -> dict:
    """
    Acquire a named resource lock for a job. Idempotent if same job holds it.
    Returns {ok: True, lock} or {ok: False, reason, holder}.
    """
    dirs.ensure()
    locks = _load_locks(dirs)
    existing = next((l for l in locks if l["resource"] == resource), None)
    if existing:
        if existing["job_id"] == job_id:
            return {"ok": True, "lock": existing}
        return {
            "ok":     False,
            "reason": f"Locked by job {existing['job_id'][:8]} (task {existing['task_id']!r})",
            "holder": existing,
        }
    lock = {
        "resource":    resource,
        "task_id":     task_id,
        "job_id":      job_id,
        "acquired_at": _now(),
    }
    locks.append(lock)
    _save_locks(dirs, locks)
    return {"ok": True, "lock": lock}


def release_resource_locks_for_job(dirs: ProjectDirs, job_id: str) -> list[str]:
    """Release all resource locks held by a job. Returns list of freed resources."""
    dirs.ensure()
    locks = _load_locks(dirs)
    held  = [l for l in locks if l["job_id"] == job_id]
    if not held:
        return []
    _save_locks(dirs, [l for l in locks if l["job_id"] != job_id])
    return [l["resource"] for l in held]


def fire_transition(
    dirs: ProjectDirs,
    task_id: str,
    transition_id: str,
    source: str = "bridge",
) -> dict:
    """
    Fire a Petri-net transition for the given task.

    Validates:
      - transition_id known
      - task exists and is in a valid source place
      - task not locked by active job
      - resource lock free (for coder-creating transitions)

    Side effects on token:
      - updates place, place_entered_at
      - sets approval_metadata  (approve_plan)
      - sets human_review_context  (escalate transitions)
      - increments attempt  (on READY_FOR_ANALYSIS entry)
    """
    dirs.ensure()

    tr = _TR.get(transition_id)
    if tr is None:
        raise ValueError(f"Unknown transition: {transition_id!r}")

    tasks = _load_tasks(dirs)
    task  = next((t for t in tasks if t["task_id"] == task_id), None)
    if task is None:
        raise ValueError(f"Task not found: {task_id!r}")

    if task["place"] not in tr["from"]:
        raise ValueError(
            f"Transition {transition_id!r} requires task in {tr['from']}, "
            f"but {task_id!r} is in {task['place']!r}"
        )

    if task["place"] == tr["to"]:  # idempotent: already there
        return task

    jobs   = _load_jobs(dirs)
    active = [j for j in jobs if j["task_id"] == task_id and j["status"] in ("pending", "running")]
    if active:
        raise ValueError(
            f"Task {task_id!r} locked by job {active[0]['job_id']!r} "
            f"(status={active[0]['status']!r})"
        )

    # Resource lock guard: check before moving token
    _kind = _transition_kind(tr)
    if _kind in ("auto", "human") and tr.get("agent_role") == "coder":
        _file = task.get("file", "")
        if _file:
            resource = f"file:{_file}"
            conflict = next(
                (l for l in _load_locks(dirs)
                 if l["resource"] == resource and l["task_id"] != task_id),
                None,
            )
            if conflict:
                raise ValueError(
                    f"Resource {_file!r} locked by job {conflict['job_id'][:8]} "
                    f"(task {conflict['task_id']!r}) — cannot create coder job"
                )

    from_place = task["place"]
    now = _now()
    task["place"]           = tr["to"]
    task["place_entered_at"] = now

    if tr["to"] == "READY_FOR_ANALYSIS":
        task["attempt"] = task.get("attempt", 0) + 1

    # Metadata hooks
    if transition_id == "approve_plan":
        task["approval_metadata"] = {
            "approved_at": now,
            "approved_by": source,
            "transition":  "approve_plan",
        }
    if tr["to"] == "HUMAN_REVIEW":
        task["human_review_context"] = {
            "escalated_at":  now,
            "escalated_via": transition_id,
            "escalated_by":  source,
        }

    _save_tasks(dirs, tasks)
    _update_marking_md(dirs, tasks)
    _emit(dirs, {
        "type":       "transition_fired",
        "task_id":    task_id,
        "transition": transition_id,
        "from_place": from_place,
        "to_place":   tr["to"],
        "source":     source,
    })

    # Create agent job for auto and human-approved transitions
    if _kind in ("auto", "human") and tr.get("agent_role") and tr["agent_role"] not in ("human", "system"):
        _ensure_job(dirs, task, tr, jobs)

    return task


def tick(dirs: ProjectDirs) -> dict:
    """
    Orchestrator tick: advance all non-terminal, non-locked tasks.

      auto   → fire; create agent job
      human  → surface in waiting_for_human
      tool   → surface in tool_ready
      system → skip (explicit command only)
      agent  → skip (agent fires when done)
      locked → blocked

    Idempotent. Returns {fired, jobs_created, waiting_for_human, tool_ready, blocked}.
    """
    dirs.ensure()
    tasks  = _load_tasks(dirs)
    jobs   = _load_jobs(dirs)
    locked = {j["task_id"] for j in jobs if j["status"] in ("pending", "running")}

    summary: dict = {
        "fired":             [],
        "jobs_created":      [],
        "waiting_for_human": [],
        "tool_ready":        [],
        "blocked":           [],
    }

    for task in tasks:
        tid = task["task_id"]

        if task["place"] in _TERMINAL_PLACES:
            continue

        if tid in locked:
            summary["blocked"].append({"task_id": tid, "reason": "active job"})
            continue

        trs_here       = [tr for tr in TRANSITIONS if task["place"] in tr["from"]]
        fired_this_task = False

        for tr in trs_here:
            if fired_this_task:
                break

            kind = _transition_kind(tr)

            if kind == "human":
                summary["waiting_for_human"].append({
                    "task_id":    tid,
                    "transition": tr["id"],
                    "place":      task["place"],
                })

            elif kind == "tool":
                summary["tool_ready"].append({
                    "task_id":    tid,
                    "transition": tr["id"],
                })

            elif kind in ("system", "agent"):
                pass  # skip — explicit call required

            elif kind == "auto":
                output_tr  = _next_non_auto_transition(tr["to"], tr.get("agent_role", ""))
                t_to_fire  = output_tr or tr["id"]
                dup = next(
                    (j for j in jobs
                     if j["task_id"] == tid
                     and j.get("transition_to_fire") == t_to_fire
                     and j["status"] in ("pending", "running")),
                    None,
                )
                if dup:
                    summary["blocked"].append({
                        "task_id": tid,
                        "reason":  f"job {dup['job_id'][:8]} pending for {t_to_fire}",
                    })
                    fired_this_task = True
                    continue

                try:
                    fired_task = fire_transition(dirs, tid, tr["id"], source="tick")
                    summary["fired"].append({
                        "task_id":    tid,
                        "transition": tr["id"],
                        "to_place":   fired_task["place"],
                    })
                    fired_this_task = True
                    known = set(summary["jobs_created"])
                    for j in _load_jobs(dirs):
                        if (j["task_id"] == tid
                                and j["status"] == "pending"
                                and j["job_id"] not in known):
                            summary["jobs_created"].append(j["job_id"])

                except ValueError as exc:
                    summary["blocked"].append({"task_id": tid, "reason": str(exc)})
                    fired_this_task = True

    return summary


def get_tasks(dirs: ProjectDirs) -> list[dict]:
    """Return all tasks (tokens). Public wrapper over _load_tasks."""
    return _load_tasks(dirs)


def get_jobs(dirs: ProjectDirs) -> list[dict]:
    return _load_jobs(dirs)


def complete_agent_job(
    dirs: ProjectDirs,
    job_id: str,
    result: dict | None = None,
) -> dict:
    """
    Mark job done and fire transition_to_fire.
    Releases resource locks. Idempotent if already done.
    """
    dirs.ensure()
    jobs = _load_jobs(dirs)
    job  = next((j for j in jobs if j["job_id"] == job_id), None)
    if job is None:
        raise ValueError(f"Job not found: {job_id!r}")
    if job["status"] == "done":
        return job
    if job["status"] == "failed":
        raise ValueError(f"Job {job_id!r} already failed — cannot complete")

    job["status"]       = "done"
    job["completed_at"] = _now()
    job["result"]       = result or {}
    _save_jobs(dirs, jobs)

    _emit(dirs, {
        "type":               "job_completed",
        "job_id":             job_id,
        "task_id":            job["task_id"],
        "agent_role":         job["agent_role"],
        "transition_to_fire": job["transition_to_fire"],
        "success":            True,
        "source":             "bridge",
    })

    fire_transition(dirs, job["task_id"], job["transition_to_fire"], source="bridge")

    released = release_resource_locks_for_job(dirs, job_id)
    if released:
        _emit(dirs, {
            "type":      "resource_locks_released",
            "job_id":    job_id,
            "task_id":   job["task_id"],
            "resources": released,
            "source":    "bridge",
        })

    return job


def fail_agent_job(dirs: ProjectDirs, job_id: str, reason: str) -> dict:
    """
    Mark job failed. Releases resource locks. Idempotent if already failed.
    """
    dirs.ensure()
    jobs = _load_jobs(dirs)
    job  = next((j for j in jobs if j["job_id"] == job_id), None)
    if job is None:
        raise ValueError(f"Job not found: {job_id!r}")
    if job["status"] == "failed":
        return job

    job["status"]       = "failed"
    job["completed_at"] = _now()
    job["result"]       = {"error": reason}
    _save_jobs(dirs, jobs)

    _emit(dirs, {
        "type":       "job_failed",
        "job_id":     job_id,
        "task_id":    job["task_id"],
        "agent_role": job["agent_role"],
        "reason":     reason,
        "success":    False,
        "source":     "bridge",
    })

    released = release_resource_locks_for_job(dirs, job_id)
    if released:
        _emit(dirs, {
            "type":      "resource_locks_released",
            "job_id":    job_id,
            "task_id":   job["task_id"],
            "resources": released,
            "source":    "bridge",
        })

    return job


def timeout_stale_human_tasks(dirs: ProjectDirs, max_hours: int = 72) -> dict:
    """
    Check HUMAN_REVIEW tasks for staleness based on place_entered_at.
    If older than max_hours: fire review_timeout transition if available,
    otherwise set task.status='timeout' and emit human_timeout event.
    Only run explicitly — not called by tick.
    """
    dirs.ensure()
    tasks  = _load_tasks(dirs)
    now    = datetime.now(timezone.utc)
    cutoff = timedelta(hours=max_hours)

    timed_out: list[dict] = []
    skipped:   list[dict] = []

    for task in tasks:
        if task["place"] != "HUMAN_REVIEW":
            continue

        raw = task.get("place_entered_at") or task.get("created_at")
        if not raw:
            continue

        try:
            entered = datetime.fromisoformat(raw)
        except ValueError:
            continue

        if entered.tzinfo is None:
            entered = entered.replace(tzinfo=timezone.utc)

        age = now - entered
        if age <= cutoff:
            skipped.append({"task_id": task["task_id"], "age_hours": round(age.total_seconds() / 3600, 2)})
            continue

        if "review_timeout" in _TR:
            try:
                fire_transition(dirs, task["task_id"], "review_timeout", source="system")
                timed_out.append({
                    "task_id":   task["task_id"],
                    "age_hours": round(age.total_seconds() / 3600, 2),
                    "action":    "transition:review_timeout",
                })
            except ValueError as exc:
                task["status"] = "timeout"
                _save_tasks(dirs, tasks)
                _emit(dirs, {"type": "human_timeout", "task_id": task["task_id"],
                             "reason": str(exc), "source": "system"})
                timed_out.append({
                    "task_id":   task["task_id"],
                    "age_hours": round(age.total_seconds() / 3600, 2),
                    "action":    "status:timeout",
                })
        else:
            task["status"] = "timeout"
            _save_tasks(dirs, tasks)
            _emit(dirs, {"type": "human_timeout", "task_id": task["task_id"], "source": "system"})
            timed_out.append({
                "task_id":   task["task_id"],
                "age_hours": round(age.total_seconds() / 3600, 2),
                "action":    "status:timeout",
            })

    return {"timed_out": timed_out, "skipped": skipped, "max_hours": max_hours}


def replay(dirs: ProjectDirs, dry_run: bool = True) -> dict:
    """
    Event audit / replay tool (dry_run mode).

    Reads events.ndjson, counts events by type, checks for required fields
    in versioned events (event_id / type / ts).

    Full state reconstruction from events is planned for a future version.
    events.ndjson is the authoritative audit log.
    """
    if not dirs.events_file.exists():
        return {
            "total": 0, "by_type": {}, "versioned": 0,
            "legacy": 0, "missing_fields": [], "dry_run": dry_run,
        }

    lines    = dirs.events_file.read_text(encoding="utf-8").strip().splitlines()
    by_type: dict[str, int] = {}
    versioned   = 0
    missing_fld: list[dict] = []

    for i, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            missing_fld.append({"line": i, "issue": "invalid JSON"})
            continue

        ev_type = ev.get("type", "<unknown>")
        by_type[ev_type] = by_type.get(ev_type, 0) + 1

        if ev.get("event_version"):
            versioned += 1
            for field in ("event_id", "ts", "type"):
                if not ev.get(field):
                    missing_fld.append({"line": i, "event_type": ev_type, "missing": field})

    return {
        "total":          len([l for l in lines if l.strip()]),
        "by_type":        by_type,
        "versioned":      versioned,
        "legacy":         len([l for l in lines if l.strip()]) - versioned,
        "missing_fields": missing_fld,
        "dry_run":        dry_run,
        "note": (
            "events.ndjson is the authoritative audit log. "
            "Full state reconstruction from events is planned for a future version."
        ),
    }


# ─── CLI ──────────────────────────────────────────────────────────────────────

def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Renew Orchestrator — orchestration kernel CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--project-dir", required=True, metavar="PATH")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("marking",       help="Show current marking")
    sub.add_parser("tick",          help="Run orchestrator tick")
    sub.add_parser("jobs",          help="List all jobs")

    p_en = sub.add_parser("enabled", help="List enabled transitions")
    p_en.add_argument("task_id", nargs="?")

    p_fire = sub.add_parser("fire", help="Fire a transition")
    p_fire.add_argument("task_id")
    p_fire.add_argument("transition_id")

    p_add = sub.add_parser("add-task", help="Add task to BACKLOG")
    p_add.add_argument("task_id")
    p_add.add_argument("file")
    p_add.add_argument("goal")

    p_done = sub.add_parser("complete-job", help="Mark job done and fire its transition")
    p_done.add_argument("job_id")

    p_fail = sub.add_parser("fail-job", help="Mark job failed")
    p_fail.add_argument("job_id")
    p_fail.add_argument("reason")

    p_timeout = sub.add_parser("timeout-human", help="Timeout stale HUMAN_REVIEW tasks")
    p_timeout.add_argument("--max-hours", type=int, default=72)

    p_replay = sub.add_parser("replay", help="Audit events.ndjson")
    p_replay.add_argument("--dry-run", action="store_true", default=True)

    # ── Economics commands ─────────────────────────────────────────────────────
    sub.add_parser("next-task",  help="Best task to work on next (economic score)")
    sub.add_parser("next-job",   help="Best pending job to execute (economic score)")
    sub.add_parser("scores",     help="Economic scores for all active tasks")

    p_explain = sub.add_parser("explain", help="Explain economic priority for a task")
    p_explain.add_argument("task_id")

    sub.add_parser("budget", help="Show current budget")

    p_setb = sub.add_parser("set-budget", help="Set budget ceiling")
    p_setb.add_argument("amount", type=float)

    p_econ_log = sub.add_parser("econ-log", help="Show recent economic decisions")
    p_econ_log.add_argument("--limit", type=int, default=20)

    args = parser.parse_args()
    dirs = ProjectDirs(args.project_dir).ensure()

    try:
        if args.cmd == "marking":
            print(json.dumps({p: t for p, t in get_marking(dirs).items() if t}, indent=2))

        elif args.cmd == "tick":
            print(json.dumps(tick(dirs), indent=2))

        elif args.cmd == "enabled":
            enabled = get_enabled_transitions(dirs, getattr(args, "task_id", None))
            if not enabled:
                print("(no enabled transitions)")
            for e in enabled:
                kind = _transition_kind(e)
                print(f"  {e['id']:25s}  [{kind:6s}]  tasks: {', '.join(e['eligible_tasks'])}")

        elif args.cmd == "fire":
            task = fire_transition(dirs, args.task_id, args.transition_id, source="cli")
            print(f"OK  {args.task_id}  ->  {task['place']}")

        elif args.cmd == "add-task":
            print(json.dumps(create_task(dirs, args.task_id, args.file, args.goal), indent=2))

        elif args.cmd == "jobs":
            jobs = get_jobs(dirs)
            if not jobs:
                print("(no jobs)")
            for j in jobs:
                print(f"  {j['job_id'][:8]}  {j['status']:10s}  {j['task_id']:15s}  "
                      f"{j['agent_role']:8s}  via:{j.get('transition','?')}  fire:{j['transition_to_fire']}")

        elif args.cmd == "complete-job":
            job = complete_agent_job(dirs, args.job_id)
            print(f"OK  {args.job_id[:8]}  done, fired {job['transition_to_fire']}")

        elif args.cmd == "fail-job":
            job = fail_agent_job(dirs, args.job_id, args.reason)
            print(f"OK  {args.job_id[:8]}  failed: {args.reason}")

        elif args.cmd == "timeout-human":
            print(json.dumps(timeout_stale_human_tasks(dirs, max_hours=args.max_hours), indent=2))

        elif args.cmd == "replay":
            print(json.dumps(replay(dirs, dry_run=args.dry_run), indent=2))

        # ── Economics ──────────────────────────────────────────────────────────
        elif args.cmd in ("next-task", "next-job", "scores", "explain",
                          "budget", "set-budget", "econ-log"):
            from bridge.economics import (  # lazy import — avoids circular at module level
                get_next_task, get_next_job, all_scores, explain_priority,
                get_budget, set_budget, get_economic_log,
            )

            if args.cmd == "next-task":
                result = get_next_task(dirs)
                if result is None:
                    print("(no eligible tasks)")
                else:
                    print(json.dumps(result, indent=2))

            elif args.cmd == "next-job":
                result = get_next_job(dirs)
                if result is None:
                    print("(no pending jobs)")
                else:
                    print(json.dumps(result, indent=2))

            elif args.cmd == "scores":
                rows = all_scores(dirs)
                if not rows:
                    print("(no active tasks)")
                for r in rows:
                    print(f"  {r['task_id']:20s}  score={r['economic_score']:6.4f}  "
                          f"u={r['utility']:5.2f}  c={r['estimated_cost']:5.2f}  [{r['place']}]")

            elif args.cmd == "explain":
                print(json.dumps(explain_priority(dirs, args.task_id), indent=2))

            elif args.cmd == "budget":
                print(json.dumps(get_budget(dirs), indent=2))

            elif args.cmd == "set-budget":
                print(json.dumps(set_budget(dirs, args.amount), indent=2))

            elif args.cmd == "econ-log":
                entries = get_economic_log(dirs, limit=args.limit)
                if not entries:
                    print("(no decisions logged yet)")
                for e in entries:
                    print(json.dumps(e))

    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    _cli()
