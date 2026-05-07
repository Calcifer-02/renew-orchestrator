#!/usr/bin/env python3
"""
Renew Orchestrator — MCP server (stdio transport).

Start:
  python mcp/server.py --project-dir /path/to/project

Claude Code ~/.claude/claude_desktop_config.json:
  {
    "mcpServers": {
      "renew": {
        "command": "python",
        "args": [
          "C:/projects/renew-orchestrator/mcp/server.py",
          "--project-dir", "C:/projects/MyProject"
        ]
      }
    }
  }

Or set RENEW_PROJECT_DIR env var and omit --project-dir.

NOTE: Import order is intentional — FastMCP must be imported BEFORE the project
root is added to sys.path to prevent our local mcp/ package from shadowing
the real mcp PyPI package.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# ① Import FastMCP FIRST — before _ROOT goes onto sys.path.
#    When invoked as `python mcp/server.py`, sys.path[0] is the mcp/ directory,
#    so Python finds the real mcp package in site-packages, not our local stub.
try:
    from mcp.server.fastmcp import FastMCP
    _MCP_AVAILABLE = True
except ImportError as _e:
    _MCP_AVAILABLE = False
    _MCP_ERR = str(_e)

# ② NOW add the project root so bridge.renew_bridge is importable.
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from bridge.renew_bridge import (  # noqa: E402
    ProjectDirs,
    complete_agent_job,
    create_task,
    fail_agent_job,
    fire_transition,
    get_enabled_transitions,
    get_jobs,
    get_marking,
    tick,
)

# ③ Guard: fail loudly if mcp SDK is missing.
if not _MCP_AVAILABLE:
    print(
        f"ERROR: 'mcp' package not found.\n"
        f"  Run: pip install mcp\n"
        f"  ({_MCP_ERR})",
        file=sys.stderr,
    )
    sys.exit(1)

# ─── Resolve --project-dir ───────────────────────────────────────────────────

def _resolve_project_dir() -> str:
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--project-dir", default="")
    args, _ = p.parse_known_args()
    return args.project_dir or os.environ.get("RENEW_PROJECT_DIR", "")


_PROJECT_DIR = _resolve_project_dir()


def _dirs() -> ProjectDirs:
    if not _PROJECT_DIR:
        raise RuntimeError(
            "No project directory configured. "
            "Pass --project-dir PATH or set RENEW_PROJECT_DIR."
        )
    return ProjectDirs(_PROJECT_DIR).ensure()


# ─── MCP server ───────────────────────────────────────────────────────────────

mcp = FastMCP(
    "renew-orchestrator",
    instructions=(
        "Petri-net orchestrator for agent-driven refactoring workflows.\n\n"
        "Typical flow:\n"
        "  1. add_task(task_id, file, goal)  — enqueue work in BACKLOG\n"
        "  2. tick_orchestrator()            — auto-fire claim_analysis etc.\n"
        "  3. list_jobs(status='pending')    — find the analyst job\n"
        "  4. complete_job(job_id)           — agent done -> fires analysis_finished\n"
        "  5. tick_orchestrator()            — auto-fire claim_patch etc.\n"
        "  ... repeat until DONE\n\n"
        "Use list_marking() to see current state. "
        "Use list_enabled() for next possible moves."
    ),
)


# ── Tools ─────────────────────────────────────────────────────────────────────

@mcp.tool()
def tick_orchestrator() -> dict:
    """
    Run one orchestrator tick.

    Auto-fires all enabled auto-transitions (claim_analysis, claim_patch,
    start_testing, retry) and creates agent jobs for them.
    Human transitions surface in waiting_for_human (e.g. escalate).
    Tool transitions surface in tool_ready.
    Locked tasks or already-covered tasks go to blocked.

    Idempotent — safe to call repeatedly; won't duplicate jobs.

    Returns dict with keys:
      fired             list of {task_id, transition, to_place}
      jobs_created      list of new job_ids
      waiting_for_human list of {task_id, transition, place}
      tool_ready        list of {task_id, transition}
      blocked           list of {task_id, reason}
    """
    return tick(_dirs())


@mcp.tool()
def get_state() -> dict:
    """
    Full orchestrator state snapshot.
    Returns marking (non-empty places), active_jobs, all jobs, enabled transition IDs.
    """
    d = _dirs()
    jobs = get_jobs(d)
    return {
        "marking":             {k: v for k, v in get_marking(d).items() if v},
        "active_jobs":         [j for j in jobs if j["status"] in ("pending", "running")],
        "jobs":                jobs,
        "enabled_transitions": [e["id"] for e in get_enabled_transitions(d)],
    }


@mcp.tool()
def list_marking() -> dict:
    """Current Petri-net marking: place -> [task_ids]. Empty places omitted."""
    return {k: v for k, v in get_marking(_dirs()).items() if v}


@mcp.tool()
def list_enabled(task_id: str = "") -> list:
    """
    Enabled transitions that can fire right now.
    Optionally filter to a specific task_id.
    Each entry includes eligible_tasks list.
    """
    return get_enabled_transitions(_dirs(), task_id or None)


@mcp.tool()
def add_task(task_id: str, file: str, goal: str) -> dict:
    """
    Add a task to BACKLOG. Idempotent — returns existing task if task_id exists.
    """
    return create_task(_dirs(), task_id, file, goal)


@mcp.tool()
def fire(task_id: str, transition_id: str) -> dict:
    """
    Fire a specific Petri-net transition for a task.
    Validates against the transition table.
    Returns updated task dict, or {error: ...} on invalid input.
    """
    try:
        return fire_transition(_dirs(), task_id, transition_id, source="mcp")
    except ValueError as exc:
        return {"error": str(exc)}


@mcp.tool()
def list_jobs(status: str = "") -> list:
    """
    List agent jobs.
    Filter by status: pending | running | done | failed  (empty = all).
    Each job: job_id, task_id, agent_role, transition, transition_to_fire,
              instructions, status, created_at, result.
    """
    jobs = get_jobs(_dirs())
    if status:
        jobs = [j for j in jobs if j["status"] == status]
    return jobs


@mcp.tool()
def complete_job(job_id: str, result_json: str = "{}") -> dict:
    """
    Mark an agent job done and fire its transition_to_fire.

    job_id      — UUID from list_jobs()
    result_json — optional JSON string with agent result payload

    Fires transition_to_fire (e.g. analysis_finished), moving the token
    to the next place. Idempotent if already done.
    """
    try:
        result = json.loads(result_json) if result_json.strip() else {}
        return complete_agent_job(_dirs(), job_id, result)
    except (ValueError, json.JSONDecodeError) as exc:
        return {"error": str(exc)}


@mcp.tool()
def fail_job(job_id: str, reason: str) -> dict:
    """
    Mark an agent job failed. Does not move the token.
    Idempotent if already failed.
    """
    try:
        return fail_agent_job(_dirs(), job_id, reason)
    except ValueError as exc:
        return {"error": str(exc)}


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run(transport="stdio")
