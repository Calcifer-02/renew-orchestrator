#!/usr/bin/env python3
"""
Renew Orchestrator — universal orchestration kernel.

All state lives in <project-dir>/orchestration/reports/.
task.place is ONLY mutated via fire_transition() — never directly.

Public API:
  get_marking(dirs)
  get_enabled_transitions(dirs, task_id=None)
  create_task(dirs, task_id, file, goal)          idempotent
  fire_transition(dirs, task_id, transition_id, source="bridge")
  tick(dirs)                                       idempotent orchestrator tick
  get_jobs(dirs)
  complete_agent_job(dirs, job_id, result=None)    idempotent
  fail_agent_job(dirs, job_id, reason)             idempotent

CLI:
  python bridge/renew_bridge.py --project-dir PATH marking
  python bridge/renew_bridge.py --project-dir PATH enabled [TASK_ID]
  python bridge/renew_bridge.py --project-dir PATH fire TASK_ID TRANSITION_ID
  python bridge/renew_bridge.py --project-dir PATH add-task TASK_ID FILE GOAL
  python bridge/renew_bridge.py --project-dir PATH tick
  python bridge/renew_bridge.py --project-dir PATH jobs
  python bridge/renew_bridge.py --project-dir PATH complete-job JOB_ID
  python bridge/renew_bridge.py --project-dir PATH fail-job JOB_ID REASON
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ─── Net definition ───────────────────────────────────────────────────────────

PLACES: list[str] = [
    "BACKLOG", "READY_FOR_ANALYSIS", "ANALYZED",
    "READY_FOR_PATCH", "PATCH_CREATED", "TESTING",
    "DONE", "FAILED", "HUMAN_REVIEW",
]

# Transition kinds (derived, not stored):
#   auto   → bridge/tick fires this; creates agent job
#   agent  → agent fires this when work is complete (non-auto, non-human)
#   human  → requires explicit human action (agent_role="human")
#   tool   → reserved for shell/test execution (kind="tool" marker)
TRANSITIONS: list[dict] = [
    {"id": "claim_analysis",    "from": ["BACKLOG"],            "to": "READY_FOR_ANALYSIS", "auto": True,  "agent_role": "analyst"},
    {"id": "analysis_finished", "from": ["READY_FOR_ANALYSIS"], "to": "ANALYZED",           "auto": False, "agent_role": "analyst"},
    {"id": "claim_patch",       "from": ["ANALYZED"],           "to": "READY_FOR_PATCH",    "auto": True,  "agent_role": "coder"},
    {"id": "patch_created",     "from": ["READY_FOR_PATCH"],    "to": "PATCH_CREATED",      "auto": False, "agent_role": "coder"},
    {"id": "start_testing",     "from": ["PATCH_CREATED"],      "to": "TESTING",            "auto": True,  "agent_role": "tester"},
    {"id": "tests_passed",      "from": ["TESTING"],            "to": "DONE",               "auto": False, "agent_role": "tester"},
    {"id": "tests_failed",      "from": ["TESTING"],            "to": "FAILED",             "auto": False, "agent_role": "tester"},
    {"id": "retry",             "from": ["FAILED"],             "to": "READY_FOR_ANALYSIS", "auto": True,  "agent_role": "analyst"},
    {"id": "escalate",          "from": ["TESTING", "FAILED"],  "to": "HUMAN_REVIEW",       "auto": False, "agent_role": "human"},
]

_TR: dict[str, dict] = {t["id"]: t for t in TRANSITIONS}

_TERMINAL_PLACES = {"DONE", "HUMAN_REVIEW"}

_INSTRUCTIONS: dict[str, str] = {
    "analyst": "Analyze `{file}` — {goal}",
    "coder":   "Create a patch for `{file}` addressing: {goal}",
    "tester":  "Test `{file}` — verify: {goal}",
    "human":   "(manual review required for `{file}`)",
}


# ─── ProjectDirs ──────────────────────────────────────────────────────────────

class ProjectDirs:
    def __init__(self, project_dir: str | Path):
        self.root = Path(project_dir).resolve()
        self.orch = self.root / "orchestration"
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
    def config_file(self) -> Path:
        return self.orch / ".orchestrator.json"


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
    os.replace(tmp, path)  # atomic on POSIX; best-effort on Windows


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


def _emit(dirs: ProjectDirs, event: dict) -> None:
    """Append to events.ndjson and grow trace.json."""
    event.setdefault("ts", _now())
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
    Classify a transition for tick processing.
      auto   — bridge fires this (auto=True, non-human)
      human  — requires explicit human action (agent_role="human")
      tool   — reserved for shell/test execution (tr["kind"]=="tool")
      agent  — agent fires this when done (auto=False, non-human)
    """
    if tr.get("agent_role") == "human":
        return "human"
    if tr.get("kind") == "tool":
        return "tool"
    if tr["auto"]:
        return "auto"
    return "agent"


def _next_non_auto_transition(from_place: str, agent_role: str) -> str | None:
    """Find the transition an agent should fire after landing in from_place."""
    for tr in TRANSITIONS:
        if from_place in tr["from"] and tr.get("agent_role") == agent_role and not tr["auto"]:
            return tr["id"]
    return None


def _ensure_job(dirs: ProjectDirs, task: dict, tr: dict, jobs: list[dict]) -> dict | None:
    """Create agent job for an auto transition if one doesn't already exist (idempotent)."""
    role = tr["agent_role"]
    if not role or role == "human":
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

    instructions = _INSTRUCTIONS.get(role, "{file}: {goal}").format(
        file=task.get("file", "?"),
        goal=task.get("goal", "?"),
    )
    job: dict = {
        "job_id":            str(uuid.uuid4()),
        "task_id":           task["task_id"],
        "agent_role":        role,
        "transition":        tr["id"],          # auto transition that was fired
        "transition_to_fire": transition_to_fire,  # transition agent fires when done
        "instructions":      instructions,
        "status":            "pending",
        "created_at":        _now(),
        "started_at":        None,
        "completed_at":      None,
        "result":            None,
    }
    jobs.append(job)
    _save_jobs(dirs, jobs)
    _emit(dirs, {
        "type":              "job_created",
        "job_id":            job["job_id"],
        "task_id":           task["task_id"],
        "agent_role":        role,
        "transition":        tr["id"],
        "transition_to_fire": transition_to_fire,
        "source":            "bridge",
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
    A transition is enabled when at least one unlocked token sits in a source place.
    Optionally filter to a specific task.
    """
    tasks = _load_tasks(dirs)
    jobs  = _load_jobs(dirs)
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
    Add a task to BACKLOG.
    Idempotent: returns the existing task unchanged if task_id already exists.
    """
    dirs.ensure()
    tasks = _load_tasks(dirs)
    existing = next((t for t in tasks if t["task_id"] == task_id), None)
    if existing:
        return existing

    task: dict = {
        "task_id":    task_id,
        "file":       file,
        "goal":       goal,
        "place":      "BACKLOG",
        "attempt":    0,
        "status":     "pending",
        "created_at": _now(),
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


def fire_transition(
    dirs: ProjectDirs,
    task_id: str,
    transition_id: str,
    source: str = "bridge",
) -> dict:
    """
    Fire a Petri-net transition for the given task.

    Validates against the transition table; raises ValueError on:
      - unknown transition_id
      - task not found
      - task.place not in transition.from
      - task locked by an active job

    For auto transitions, creates an agent job if none exists.
    """
    dirs.ensure()

    tr = _TR.get(transition_id)
    if tr is None:
        raise ValueError(f"Unknown transition: {transition_id!r}")

    tasks = _load_tasks(dirs)
    task = next((t for t in tasks if t["task_id"] == task_id), None)
    if task is None:
        raise ValueError(f"Task not found: {task_id!r}")

    if task["place"] not in tr["from"]:
        raise ValueError(
            f"Transition {transition_id!r} requires task in {tr['from']}, "
            f"but {task_id!r} is in {task['place']!r}"
        )

    # Idempotent: already in target place
    if task["place"] == tr["to"]:
        return task

    jobs = _load_jobs(dirs)
    active = [j for j in jobs if j["task_id"] == task_id and j["status"] in ("pending", "running")]
    if active:
        raise ValueError(
            f"Task {task_id!r} is locked by active job {active[0]['job_id']!r} "
            f"(status={active[0]['status']!r})"
        )

    from_place = task["place"]
    task["place"] = tr["to"]
    if tr["to"] == "READY_FOR_ANALYSIS":
        task["attempt"] = task.get("attempt", 0) + 1

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

    # Auto transitions hand work to an agent -> create job
    if tr["auto"] and tr.get("agent_role") and tr["agent_role"] != "human":
        _ensure_job(dirs, task, tr, jobs)

    return task


def tick(dirs: ProjectDirs) -> dict:
    """
    Orchestrator tick: advance all tasks that can move automatically.

    For each non-terminal, non-locked task:
      auto   transition -> fire (if no duplicate pending job)
      human  transition -> surface in waiting_for_human
      tool   transition -> surface in tool_ready (no shell execution)
      agent  transition -> skip (agent fires when done)
      locked task       -> blocked

    Idempotent: repeated ticks don't create duplicate jobs or double-fire.

    Returns:
      {fired, jobs_created, waiting_for_human, tool_ready, blocked}
    """
    dirs.ensure()
    tasks = _load_tasks(dirs)
    jobs  = _load_jobs(dirs)
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

        trs_here = [tr for tr in TRANSITIONS if task["place"] in tr["from"]]
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

            elif kind == "auto":
                # Idempotency: skip if pending/running job already covers this
                output_tr = _next_non_auto_transition(tr["to"], tr.get("agent_role", ""))
                t_to_fire = output_tr or tr["id"]
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
                    fired_this_task = True  # don't try other trs for this task
                    continue

                try:
                    fired_task = fire_transition(dirs, tid, tr["id"], source="tick")
                    summary["fired"].append({
                        "task_id":    tid,
                        "transition": tr["id"],
                        "to_place":   fired_task["place"],
                    })
                    fired_this_task = True
                    # Capture new jobs
                    fresh_jobs = _load_jobs(dirs)
                    known = {j2 for j2 in summary["jobs_created"]}
                    for j in fresh_jobs:
                        if (j["task_id"] == tid
                                and j["status"] == "pending"
                                and j["job_id"] not in known):
                            summary["jobs_created"].append(j["job_id"])

                except ValueError as exc:
                    summary["blocked"].append({"task_id": tid, "reason": str(exc)})
                    fired_this_task = True

            # "agent" kind: not tick's job — agent fires when done

    return summary


def get_jobs(dirs: ProjectDirs) -> list[dict]:
    """Return all jobs."""
    return _load_jobs(dirs)


def complete_agent_job(
    dirs: ProjectDirs,
    job_id: str,
    result: dict | None = None,
) -> dict:
    """
    Mark a job done and fire its transition_to_fire.
    Idempotent: returns unchanged if already done.
    """
    dirs.ensure()
    jobs = _load_jobs(dirs)
    job = next((j for j in jobs if j["job_id"] == job_id), None)
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
        "type":              "job_completed",
        "job_id":            job_id,
        "task_id":           job["task_id"],
        "agent_role":        job["agent_role"],
        "transition_to_fire": job["transition_to_fire"],
        "source":            "bridge",
    })

    # Job is now "done" -> lock check in fire_transition passes
    fire_transition(dirs, job["task_id"], job["transition_to_fire"], source="bridge")
    return job


def fail_agent_job(dirs: ProjectDirs, job_id: str, reason: str) -> dict:
    """
    Mark a job failed. Does not fire any transition.
    Idempotent: returns unchanged if already failed.
    """
    dirs.ensure()
    jobs = _load_jobs(dirs)
    job = next((j for j in jobs if j["job_id"] == job_id), None)
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
        "source":     "bridge",
    })
    return job


# ─── CLI ──────────────────────────────────────────────────────────────────────

def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Renew Orchestrator — orchestration kernel CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--project-dir", required=True, metavar="PATH")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("marking",  help="Show current Petri-net marking")
    sub.add_parser("tick",     help="Run orchestrator tick (auto-fire enabled transitions)")
    sub.add_parser("jobs",     help="List all jobs")

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

    args = parser.parse_args()
    dirs = ProjectDirs(args.project_dir).ensure()

    try:
        if args.cmd == "marking":
            marking = get_marking(dirs)
            non_empty = {p: t for p, t in marking.items() if t}
            print(json.dumps(non_empty, indent=2))

        elif args.cmd == "tick":
            result = tick(dirs)
            print(json.dumps(result, indent=2))

        elif args.cmd == "enabled":
            enabled = get_enabled_transitions(dirs, getattr(args, "task_id", None))
            if not enabled:
                print("(no enabled transitions)")
            for e in enabled:
                kind = _transition_kind(e)
                tasks_str = ", ".join(e["eligible_tasks"])
                print(f"  {e['id']:25s}  [{kind:5s}]  tasks: {tasks_str}")

        elif args.cmd == "fire":
            task = fire_transition(dirs, args.task_id, args.transition_id, source="cli")
            print(f"OK  {args.task_id}  ->  {task['place']}")

        elif args.cmd == "add-task":
            task = create_task(dirs, args.task_id, args.file, args.goal)
            print(json.dumps(task, indent=2))

        elif args.cmd == "jobs":
            jobs = get_jobs(dirs)
            if not jobs:
                print("(no jobs)")
            for j in jobs:
                tr_col = j.get("transition", "?")
                print(f"  {j['job_id'][:8]}  {j['status']:10s}  {j['task_id']:15s}  "
                      f"{j['agent_role']:8s}  via:{tr_col}  fire:{j['transition_to_fire']}")

        elif args.cmd == "complete-job":
            job = complete_agent_job(dirs, args.job_id)
            print(f"OK  {args.job_id[:8]}  done, fired {job['transition_to_fire']}")

        elif args.cmd == "fail-job":
            job = fail_agent_job(dirs, args.job_id, args.reason)
            print(f"OK  {args.job_id[:8]}  failed: {args.reason}")

    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    _cli()
