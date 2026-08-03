"""Generic job-polling tools. Both tier 1 (reads only), per spec §5.2.

There is NO generic ``start_job(tool_name, args)`` — a long tool declares
``long_running=True`` in its own ``define_tool`` and appears in the
manifest under its own name. This file only provides polling / listing.
"""
from __future__ import annotations

from ..platform import Ctx, clamp_limit, define_tool


@define_tool(
    name="get_job_status",
    tier=1,
    description=(
        "Poll one async job by its `job_id`. Returns status "
        "(queued/running/succeeded/failed/cancelled), timestamps, progress, "
        "and the parsed result once succeeded. Long-running tools "
        "(long_running=True) return a job_id immediately when called; use "
        "this to fetch their eventual result."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "job_id": {"type": "string", "description": "Job id returned by the enqueue call."},
        },
        "required": ["job_id"],
    },
)
async def get_job_status(args: dict, ctx: Ctx) -> dict:
    if ctx.jobs is None:
        return {
            "data": {"error": "Job store not initialised on this host."},
        }
    job = ctx.jobs.get(args["job_id"])
    if job is None:
        # Report as data, not exception — a poll for an unknown id is a
        # legitimate operational query, not a bug worth failing the call.
        return {"data": {"error": "no such job", "job_id": args["job_id"]}}
    return {"data": job}


@define_tool(
    name="list_jobs",
    tier=1,
    description=(
        "List recent async jobs (most recent first). Optionally filter by "
        "`status` (queued/running/succeeded/failed/cancelled). `limit` is "
        "clamped to a small cap so this tool cannot return unbounded rows."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["queued", "running", "succeeded", "failed", "cancelled"],
                "description": "Optional status filter.",
            },
            "limit": {
                "type": "integer",
                "description": "Max rows to return (default 20, cap 50).",
            },
        },
    },
)
async def list_jobs(args: dict, ctx: Ctx) -> dict:
    if ctx.jobs is None:
        return {"data": []}
    limit = clamp_limit(args.get("limit"))
    status = args.get("status")
    rows = ctx.jobs.list(limit=limit, status=status)
    return {"data": rows}
