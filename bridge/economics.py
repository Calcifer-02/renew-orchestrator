#!/usr/bin/env python3
"""
Economic layer for the Renew Orchestrator.

The Petri net answers: "What CAN be done now?"
The economic layer answers: "What is BEST to do next?"

Theoretical foundation: Market-based multi-agent task allocation.
Each task has a utility (value of completion) and an estimated cost
(resources needed to reach DONE from the current place).
The economic score = utility / cost guides agent scheduling.

Public API:
    economic_score(task, jobs)                          -> float
    get_next_task(dirs)                                 -> dict | None
    get_next_job(dirs)                                  -> dict | None
    explain_priority(dirs, task_id)                     -> dict
    all_scores(dirs)                                    -> list[dict]
    get_budget(dirs)                                    -> dict
    set_budget(dirs, total)                             -> dict
    spend_budget(dirs, amount, reason, task_id, job_id) -> dict
    get_economic_log(dirs, limit)                       -> list[dict]
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from bridge.renew_bridge import (
    ProjectDirs,
    get_tasks,
    get_jobs,
    get_enabled_transitions,
)

# ─── Price list ───────────────────────────────────────────────────────────────

# Cost per execution step, in token units, indexed by agent_role.
BASE_PRICES: dict[str, float] = {
    "analyst": 2.0,
    "coder":   5.0,
    "tester":  2.0,
    "human":   8.0,   # human attention is the scarcest resource
    "system":  0.0,
    "agent":   3.0,   # generic fallback
}

# ─── Utility tables ───────────────────────────────────────────────────────────

UTILITY_BY_TYPE: dict[str, float] = {
    "bugfix":   10.0,
    "feature":   8.0,
    "refactor":  5.0,
    "chore":     3.0,
}

# Higher risk → higher reward for reaching DONE (compresses schedules)
RISK_MULTIPLIER: dict[str, float] = {
    "critical": 3.0,
    "high":     2.0,
    "medium":   1.5,
    "low":      1.0,
}

# ─── Happy-path cost table ────────────────────────────────────────────────────
# Sum of BASE_PRICES along the happy path from each place to DONE.
# BACKLOG(2) → READY_FOR_ANALYSIS(2) → ANALYZED(8) → READY_FOR_PATCH(5)
#   → PATCH_CREATED(2) → TESTING(2) → DONE
HAPPY_PATH_COST: dict[str, float] = {
    "BACKLOG":            21.0,   # 2+2+8+5+2+2
    "READY_FOR_ANALYSIS": 19.0,   #   2+8+5+2+2
    "ANALYZED":           17.0,   #     8+5+2+2
    "READY_FOR_PATCH":     9.0,   #       5+2+2
    "PATCH_CREATED":       4.0,   #         2+2
    "TESTING":             2.0,   #           2
    "FAILED":             19.0,   # retry → same as READY_FOR_ANALYSIS
    "HUMAN_REVIEW":       27.0,   # human decision(8) + full retry path(19)
    "DONE":                0.0,
    "REVIEW_TIMEOUT":      0.0,
}

TERMINAL_PLACES: frozenset[str] = frozenset({"DONE", "REVIEW_TIMEOUT"})

DEFAULT_BUDGET = 1000.0


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _econ_log_path(dirs: ProjectDirs) -> Path:
    return dirs.reports / "economic_decisions.ndjson"


def _budget_path(dirs: ProjectDirs) -> Path:
    return dirs.reports / "budget.json"


def _load_budget_raw(dirs: ProjectDirs) -> dict:
    p = _budget_path(dirs)
    if not p.exists():
        return {"total": DEFAULT_BUDGET, "spent": 0.0, "updated_at": _utcnow()}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"total": DEFAULT_BUDGET, "spent": 0.0, "updated_at": _utcnow()}


def _save_budget_raw(dirs: ProjectDirs, b: dict) -> None:
    b["updated_at"] = _utcnow()
    _budget_path(dirs).write_text(
        json.dumps(b, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def _log_decision(dirs: ProjectDirs, entry: dict) -> None:
    entry.setdefault("ts", _utcnow())
    with _econ_log_path(dirs).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ─── Core calculations ────────────────────────────────────────────────────────

def _task_utility(task: dict) -> float:
    """
    utility = type_base × risk_mult + age_bonus

    age_bonus prevents starvation: tasks gain up to +5.0 utility per day of age,
    capped at +5.0 total.
    """
    base      = UTILITY_BY_TYPE.get(task.get("type", "refactor"), 5.0)
    risk_mult = RISK_MULTIPLIER.get(task.get("risk", "low"), 1.0)

    age_bonus = 0.0
    raw = task.get("created_at") or task.get("place_entered_at")
    if raw:
        try:
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            age_hours = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
            age_bonus = min(age_hours * 0.05, 5.0)
        except (ValueError, TypeError):
            pass

    return round(base * risk_mult + age_bonus, 3)


def _estimated_cost(task: dict, _jobs: list[dict] | None = None) -> float:
    """
    estimated_cost = happy_path_cost[place] × attempt_multiplier

    Each retry adds 30 % to remaining cost (reflects increased uncertainty).
    """
    place     = task.get("place", "BACKLOG")
    base      = HAPPY_PATH_COST.get(place, 15.0)
    attempt   = max(1, task.get("attempt", 1))
    mult      = 1.0 + (attempt - 1) * 0.3
    return round(max(base * mult, 0.1), 3)


def economic_score(task: dict, jobs: list[dict] | None = None) -> float:
    """economic_score = utility / estimated_cost"""
    u = _task_utility(task)
    c = _estimated_cost(task, jobs)
    return round(u / max(c, 0.1), 4)


# ─── Public API ───────────────────────────────────────────────────────────────

def get_next_task(dirs: ProjectDirs) -> dict | None:
    """
    Return the highest-score task that has work available right now
    (enabled transition, not locked by an active job). Logs the decision.
    """
    tasks   = get_tasks(dirs)
    jobs    = get_jobs(dirs)
    locked  = {j["task_id"] for j in jobs if j["status"] in ("pending", "running")}
    enabled = get_enabled_transitions(dirs)
    enabled_ids = {tid for tr in enabled for tid in tr.get("eligible_tasks", [])}

    candidates = [
        t for t in tasks
        if t["place"] not in TERMINAL_PLACES
        and t["task_id"] not in locked
        and t["task_id"] in enabled_ids
    ]

    if not candidates:
        return None

    budget    = _load_budget_raw(dirs)
    remaining = budget["total"] - budget.get("spent", 0.0)
    scored    = sorted(candidates, key=lambda t: economic_score(t, jobs), reverse=True)
    best      = scored[0]
    score     = economic_score(best, jobs)
    avail_trs = [tr["id"] for tr in enabled if best["task_id"] in tr.get("eligible_tasks", [])]

    result = {
        "task_id":               best["task_id"],
        "place":                 best["place"],
        "economic_score":        score,
        "utility":               _task_utility(best),
        "estimated_cost":        _estimated_cost(best, jobs),
        "available_transitions": avail_trs,
        "budget_remaining":      round(remaining, 3),
        "candidates_scored": [
            {
                "task_id": t["task_id"],
                "score":   economic_score(t, jobs),
                "place":   t["place"],
                "utility": _task_utility(t),
                "cost":    _estimated_cost(t, jobs),
            }
            for t in scored[:10]
        ],
    }

    _log_decision(dirs, {
        "decision_type":   "next_task_selected",
        "task_id":         best["task_id"],
        "economic_score":  score,
        "utility":         _task_utility(best),
        "estimated_cost":  _estimated_cost(best, jobs),
        "candidates":      len(candidates),
        "budget_remaining": round(remaining, 3),
    })
    return result


def get_next_job(dirs: ProjectDirs) -> dict | None:
    """
    Return the highest-priority pending job, ranked by its task's economic_score.
    Logs the allocation.
    """
    tasks  = get_tasks(dirs)
    jobs   = get_jobs(dirs)
    by_tid = {t["task_id"]: t for t in tasks}
    pending = [j for j in jobs if j["status"] == "pending"]
    if not pending:
        return None

    def _score(j: dict) -> float:
        t = by_tid.get(j["task_id"])
        return economic_score(t, jobs) if t else 0.0

    best  = max(pending, key=_score)
    task  = by_tid.get(best["task_id"])
    score = _score(best)

    result = {
        "job_id":             best["job_id"],
        "task_id":            best["task_id"],
        "agent_role":         best["agent_role"],
        "transition_to_fire": best["transition_to_fire"],
        "instructions":       best["instructions"],
        "status":             best["status"],
        "economic_score":     score,
        "utility":            _task_utility(task) if task else None,
        "estimated_cost":     _estimated_cost(task, jobs) if task else None,
        "pending_jobs_count": len(pending),
    }

    _log_decision(dirs, {
        "decision_type":  "next_job_allocated",
        "job_id":         best["job_id"],
        "task_id":        best["task_id"],
        "agent_role":     best["agent_role"],
        "economic_score": score,
    })
    return result


def explain_priority(dirs: ProjectDirs, task_id: str) -> dict:
    """Full economic breakdown: utility components, cost components, rank, budget."""
    tasks = get_tasks(dirs)
    jobs  = get_jobs(dirs)
    task  = next((t for t in tasks if t["task_id"] == task_id), None)
    if task is None:
        raise ValueError(f"Task not found: {task_id!r}")

    u     = _task_utility(task)
    c     = _estimated_cost(task, jobs)
    s     = round(u / max(c, 0.1), 4)
    b     = _load_budget_raw(dirs)
    remaining = b["total"] - b.get("spent", 0.0)

    active = [t for t in tasks if t["place"] not in TERMINAL_PLACES]
    ranked = sorted(active, key=lambda t: economic_score(t, jobs), reverse=True)
    rank   = next((i + 1 for i, t in enumerate(ranked) if t["task_id"] == task_id), None)

    attempt    = max(1, task.get("attempt", 1))
    base_cost  = HAPPY_PATH_COST.get(task.get("place", "BACKLOG"), 15.0)
    type_base  = UTILITY_BY_TYPE.get(task.get("type", "refactor"), 5.0)
    risk_mult  = RISK_MULTIPLIER.get(task.get("risk", "low"), 1.0)
    age_bonus  = round(u - type_base * risk_mult, 3)

    explanation = {
        "task_id":  task_id,
        "file":     task.get("file"),
        "goal":     task.get("goal"),
        "place":    task.get("place"),
        "type":     task.get("type", "refactor"),
        "risk":     task.get("risk", "low"),
        "attempt":  task.get("attempt", 0),
        "utility":  u,
        "utility_breakdown": {
            "type_base":        type_base,
            "risk_multiplier":  risk_mult,
            "age_bonus":        age_bonus,
            "formula":          f"{type_base} × {risk_mult} + {age_bonus} = {u}",
        },
        "estimated_cost": c,
        "cost_breakdown": {
            "happy_path_base":   base_cost,
            "attempt_multiplier": round(1.0 + (attempt - 1) * 0.3, 3),
            "formula":           f"{base_cost} × {round(1.0+(attempt-1)*0.3,3)} = {c}",
        },
        "economic_score":     s,
        "formula":            f"{u} / {c} = {s}",
        "rank_among_active":  rank,
        "total_active_tasks": len(active),
        "budget_remaining":   round(remaining, 3),
        "base_prices":        BASE_PRICES,
    }

    _log_decision(dirs, {
        "decision_type":  "priority_explained",
        "task_id":        task_id,
        "economic_score": s,
        "utility":        u,
        "estimated_cost": c,
        "rank":           rank,
    })
    return explanation


def all_scores(dirs: ProjectDirs) -> list[dict]:
    """Economic scores for every non-terminal task, sorted by score descending."""
    tasks = get_tasks(dirs)
    jobs  = get_jobs(dirs)
    return sorted(
        [
            {
                "task_id":        t["task_id"],
                "place":          t["place"],
                "economic_score": economic_score(t, jobs),
                "utility":        _task_utility(t),
                "estimated_cost": _estimated_cost(t, jobs),
            }
            for t in tasks
            if t["place"] not in TERMINAL_PLACES
        ],
        key=lambda x: x["economic_score"],
        reverse=True,
    )


def get_budget(dirs: ProjectDirs) -> dict:
    b     = _load_budget_raw(dirs)
    spent = b.get("spent", 0.0)
    total = b.get("total", DEFAULT_BUDGET)
    return {
        "total":      total,
        "spent":      round(spent, 4),
        "remaining":  round(total - spent, 4),
        "updated_at": b.get("updated_at"),
    }


def set_budget(dirs: ProjectDirs, total: float) -> dict:
    """Set budget ceiling. Cannot reduce below already-spent amount."""
    dirs.ensure()
    b     = _load_budget_raw(dirs)
    spent = b.get("spent", 0.0)
    if total < spent:
        raise ValueError(f"Cannot set budget to {total:.2f} — already spent {spent:.2f}")
    b["total"] = total
    _save_budget_raw(dirs, b)
    _log_decision(dirs, {
        "decision_type": "budget_set",
        "new_total":     total,
        "spent":         spent,
        "remaining":     round(total - spent, 4),
    })
    return get_budget(dirs)


def spend_budget(
    dirs: ProjectDirs,
    amount: float,
    reason: str,
    task_id: str = "",
    job_id: str = "",
) -> dict:
    """
    Debit the budget by amount (negative = credit/refund).
    Called automatically by the backend on job completion/failure.
    """
    dirs.ensure()
    b = _load_budget_raw(dirs)
    b["spent"] = round(b.get("spent", 0.0) + amount, 4)
    _save_budget_raw(dirs, b)
    _log_decision(dirs, {
        "decision_type": "budget_spent",
        "amount":        amount,
        "reason":        reason,
        "task_id":       task_id,
        "job_id":        job_id,
        "remaining":     round(b["total"] - b["spent"], 4),
    })
    return get_budget(dirs)


def get_economic_log(dirs: ProjectDirs, limit: int = 50) -> list[dict]:
    """Most recent economic decisions, newest first."""
    p = _econ_log_path(dirs)
    if not p.exists():
        return []
    lines = p.read_text(encoding="utf-8").strip().splitlines()
    result: list[dict] = []
    for line in lines[-limit:]:
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return list(reversed(result))
