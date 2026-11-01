"""Usage-panel backend: per-session token / cache / cost rows from state.db.

Mounted by the dashboard plugin backend at ``/api/plugins/usage-panel/``
(see ``hermes_cli.web_server._mount_plugin_api_routes``). Runs inside the
gateway/web-server process, read-only. The desktop app's renderer plugin
calls ``ctx.rest('/usage/<session_id>')`` to get the persisted cache and
cost numbers that the ``session.usage`` RPC does not expose.

Cost is NOT taken from Hermes' stored estimate. It is recomputed from the
OpenRouter public model price list (https://openrouter.ai/api/v1/models):

    cost = input_miss * prompt
         + cache_read * input_cache_read
         + cache_write * input_cache_write   (falls back to prompt)
         + output * completion

Reasoning tokens are not added separately (assumed to be inside
output_tokens). The price list is cached on disk for 6 h; if OpenRouter is
unreachable the last good copy is used. Models with no OpenRouter match get
cost = null and are listed in ``unpriced_models``.

Requires being enabled: ``hermes plugins enable usage-panel``.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter

router = APIRouter()

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
PRICE_CACHE_TTL_S = 6 * 3600
PRICE_RETRY_AFTER_FAIL_S = 600

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

_price_state: Dict[str, Any] = {"ts": 0.0, "index": None, "bare": None, "fail_ts": 0.0}


def _open_db():
    from hermes_state import SessionDB

    return SessionDB(read_only=True)


# ── OpenRouter price list ──────────────────────────────────────────────────


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def _price_cache_path() -> Path:
    return _hermes_home() / "cache" / "usage-panel" / "openrouter_models.json"


def _fetch_openrouter() -> List[dict]:
    req = urllib.request.Request(OPENROUTER_MODELS_URL, headers={"User-Agent": "hermes-tally"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)["data"]


def _load_price_index() -> Dict[str, dict]:
    """Return {openrouter_id: pricing_dict}, refreshing from OpenRouter as needed."""
    now = time.time()
    if _price_state["index"] is not None and now - _price_state["ts"] < PRICE_CACHE_TTL_S:
        return _price_state["index"]

    path = _price_cache_path()
    data: Optional[List[dict]] = None
    try:
        if path.exists() and now - path.stat().st_mtime < PRICE_CACHE_TTL_S:
            data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = None

    if data is None and now - _price_state["fail_ts"] >= PRICE_RETRY_AFTER_FAIL_S:
        try:
            data = _fetch_openrouter()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data), encoding="utf-8")
        except Exception:
            _price_state["fail_ts"] = now
            data = None

    if data is None:
        # OpenRouter unreachable: fall back to whatever stale copy is on disk.
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            data = []

    index: Dict[str, dict] = {}
    bare: Dict[str, List[str]] = {}
    for m in data:
        if not isinstance(m, dict) or "id" not in m:
            continue
        mid = m["id"]
        index[mid] = m.get("pricing") or {}
        # Plain ids only for bare-name lookup (skip ":batch"/":free" variants and "~" aliases).
        if ":" not in mid and not mid.startswith("~"):
            bare.setdefault(mid.split("/")[-1], []).append(mid)

    if index:  # never memoise an empty result, so a later call can retry
        _price_state.update(ts=now, index=index, bare=bare)
    return index


_DATE_SUFFIX = re.compile(r"-\d{8}$")
_MINOR_VERSION = re.compile(r"(\d)-(\d{1,2})$")  # claude-opus-5-5 -> claude-opus-5.5


def _resolve_openrouter_id(model: str) -> Optional[str]:
    """Map a Hermes model name (as stored in state.db) to an OpenRouter id."""
    index = _load_price_index()
    raw = (model or "").strip().lower()
    if not raw:
        return None
    if raw in index:
        return raw

    bare_map = _price_state.get("bare") or {}
    base = raw.split("/")[-1]
    variants: List[str] = []
    for v in (base, _MINOR_VERSION.sub(r"\1.\2", base)):
        for w in (v, _DATE_SUFFIX.sub("", v)):
            if w and w not in variants:
                variants.append(w)

    vendor = raw.split("/")[0] + "/" if "/" in raw else None
    for v in variants:
        ids = bare_map.get(v)
        if ids:
            # If the stored name carried a vendor prefix, prefer that vendor.
            ids = sorted(ids, key=lambda i: (vendor is not None and not i.startswith(vendor), i))
            return ids[0]
    return None


def _per_token(pricing: dict, key: str) -> Optional[float]:
    v = pricing.get(key)
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _cost_usd(model: str, inp: int, out: int, cache_read: int, cache_write: int) -> Optional[float]:
    oid = _resolve_openrouter_id(model)
    if oid is None:
        return None
    p = _price_state["index"][oid]
    prompt = _per_token(p, "prompt")
    completion = _per_token(p, "completion")
    if prompt is None or completion is None:
        return None
    cache_r = _per_token(p, "input_cache_read")
    cache_w = _per_token(p, "input_cache_write")
    if cache_r is None:
        cache_r = prompt
    if cache_w is None:
        cache_w = prompt
    return (
        (inp or 0) * prompt
        + (cache_read or 0) * cache_r
        + (cache_write or 0) * cache_w
        + (out or 0) * completion
    )


# ── routes ─────────────────────────────────────────────────────────────────


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

    _load_price_index()  # refresh/warm the OpenRouter price list

    out: Dict[str, Any] = {"session_id": session_id, "found": row is not None}
    unpriced: set = set()

    models: List[Dict[str, Any]] = []
    model_cost_total = 0.0
    any_priced = False
    for r in model_rows:
        d = {out_key: r[i] for i, (_, out_key) in enumerate(_MODEL_COLS)}
        cost = _cost_usd(d["model"], d["input"], d["output"], d["cache_read"], d["cache_write"])
        d["est_cost_usd"] = cost  # replaces Hermes' stored estimate
        d["price_model"] = _resolve_openrouter_id(d["model"])
        if cost is None:
            unpriced.add(d["model"])
        else:
            any_priced = True
            model_cost_total += cost
        models.append(d)

    if row is not None:
        for i, key in enumerate(_SESSION_COLS):
            out[key] = row[i]
        if models:
            # Session total = sum of per-(model, task) rows, each priced on its own model.
            out["est_cost_usd"] = model_cost_total if any_priced else None
        else:
            # Sessions with no session_model_usage rows: price the session's model.
            out["est_cost_usd"] = _cost_usd(row[0] or "", row[1], row[2], row[3], row[4])
            if out["est_cost_usd"] is None and row[0]:
                unpriced.add(row[0])
        out["price_model"] = _resolve_openrouter_id(row[0] or "")

    out["price_source"] = "openrouter"
    out["unpriced_models"] = sorted(unpriced)
    out["models"] = models
    return out
