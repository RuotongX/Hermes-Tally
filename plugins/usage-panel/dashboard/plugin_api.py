"""Usage-panel backend: per-session token / cache / cost rows from state.db.

Mounted by the dashboard plugin backend at ``/api/plugins/usage-panel/``
(see ``hermes_cli.web_server._mount_plugin_api_routes``). Runs inside the
gateway/web-server process, read-only. The desktop app's renderer plugin
calls ``ctx.rest('/usage/<session_id>')`` to get the persisted cache and
cost numbers that the ``session.usage`` RPC does not expose.

Requires being enabled: ``hermes plugins enable usage-panel``.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

router = APIRouter()

_SESSION_COLS = (
    "model",
    "input",
    "output",
    "cache_read",
    "cache_write",
    "reasoning",
    "est_cost_usd",
    "actual_cost_usd",
    "calls",
)

# session_model_usage columns -> response keys (SUM() per model/task).
_MODEL_COLS = (
    ("model", "model"),
    ("task", "task"),
    ("api_call_count", "calls"),
    ("input_tokens", "input"),
    ("output_tokens", "output"),
    ("cache_read_tokens", "cache_read"),
    ("cache_write_tokens", "cache_write"),
    ("reasoning_tokens", "reasoning"),
    ("estimated_cost_usd", "est_cost_usd"),
    ("actual_cost_usd", "actual_cost_usd"),
)


def _open_db():
    from hermes_state import SessionDB

    return SessionDB(read_only=True)


@router.get("/usage/{session_id}")
async def session_usage(session_id: str) -> Dict[str, Any]:
    db = _open_db()
    try:
        row = db._conn.execute(
            "SELECT model, input_tokens, output_tokens, cache_read_tokens, "
            "cache_write_tokens, reasoning_tokens, estimated_cost_usd, "
            "actual_cost_usd, api_call_count "
            "FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()

        sum_sql = ", ".join(f"SUM(COALESCE({col}, 0))" for col, _ in _MODEL_COLS[2:])
        model_rows = db._conn.execute(
            f"SELECT model, task, {sum_sql} "
            "FROM session_model_usage WHERE session_id = ? "
            "GROUP BY model, task "
            "ORDER BY SUM(COALESCE(input_tokens, 0)) + SUM(COALESCE(output_tokens, 0)) DESC",
            (session_id,),
        ).fetchall()
    finally:
        db.close()

    out: Dict[str, Any] = {"session_id": session_id, "found": row is not None}
    if row is not None:
        for i, key in enumerate(_SESSION_COLS):
            out[key] = row[i]

    out["models"] = [
        {out_key: r[i] for i, (_, out_key) in enumerate(_MODEL_COLS)}
        for r in model_rows
    ]
    return out
