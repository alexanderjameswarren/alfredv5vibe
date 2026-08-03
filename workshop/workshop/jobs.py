"""Async job store — SQLite + ThreadPoolExecutor.

Jobs are host-local and ephemeral (spec §5.3). They do not belong in
Supabase — that would mean a registered table, a migration, and Supabase
write credentials on a tablet, all to track work that only matters on the
machine that ran it. Storage is ``data/workshop.db`` (gitignored).

Design (spec §5.2):
  * A long-running tool declares ``long_running=True`` in its own
    ``define_tool``, keeps its own tier, and appears in the manifest under
    its own name. Calling it enqueues and returns
    ``{job_id, status, poll_after_seconds}``.
  * One generic tool, ``get_job_status`` (tier 1), polls.
  * One generic tool, ``list_jobs`` (tier 1), lists recent jobs.
  * NO generic ``start_job(tool_name, args)`` — that would make the
    effective tier depend on which tool was wrapped, which is the
    situational tier we ruled out.

Execution:
  * ``ThreadPoolExecutor(max_workers=2)`` — bounded so a runaway job cannot
    starve the server. Two is arbitrary; can be raised per host later.
  * A job cannot survive the process. On startup, anything left ``running``
    from a previous process is marked ``failed`` with "interrupted by
    restart" — silently leaving it "running" forever is a lie.
  * Retention: rows with ``finished_at`` more than 7 days ago are deleted
    on startup.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import sqlite3
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # Avoids a circular import at runtime — platform.py imports config.py
    # and jobs.py both plug into ctx assembly; only types matter here.
    from .config import Config
    from .platform import Ctx, ToolEntry


log = logging.getLogger("workshop.jobs")


# Reasonable initial poll interval for the client. Long-running tools land
# in the minutes-to-hours range (demucs, Audiveris) so 5s is not chatty and
# not painfully slow. `get_job_status` is cheap, so backoff isn't critical.
POLL_AFTER_SECONDS = 5

# Retention window per spec §5.4.
RETENTION_DAYS = 7

# ThreadPoolExecutor size per spec §5.4.
WORKER_COUNT = 2


CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS jobs (
    id               TEXT PRIMARY KEY,
    tool_name        TEXT NOT NULL,
    status           TEXT NOT NULL,      -- queued|running|succeeded|failed|cancelled
    created_at       TEXT NOT NULL,
    started_at       TEXT,
    finished_at      TEXT,
    params_json      TEXT,
    result_json      TEXT,
    error            TEXT,
    progress_pct     INTEGER,
    progress_message TEXT
);
"""

# Handy secondary index for list_jobs and 24h counts. Not part of the spec
# but essentially free and keeps status_snapshot fast if jobs pile up.
CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_jobs_status_finished
  ON jobs(status, finished_at DESC);
"""


def _now_iso() -> str:
    # ISO 8601 with 'Z' suffix. Same format as get_workshop_status.started_at
    # so times across the API line up visually.
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class JobStore:
    """SQLite-backed job store with a bounded ThreadPoolExecutor.

    Threading: SQLite serializes writes internally; we still hold a Python
    ``RLock`` around DB ops because ``sqlite3.Connection`` is not thread-safe
    across concurrent operations. Using one connection with
    ``check_same_thread=False`` + the lock is simpler than a per-thread
    connection pool and fine for this workload.
    """

    def __init__(self, db_path: Path, config: "Config"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._config = config
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; we do explicit BEGIN when needed
        )
        self._conn.row_factory = sqlite3.Row
        self._executor = ThreadPoolExecutor(
            max_workers=WORKER_COUNT,
            thread_name_prefix="workshop-job",
        )

        with self._lock:
            self._conn.execute(CREATE_TABLE_SQL)
            self._conn.execute(CREATE_INDEX_SQL)

        # Startup housekeeping. Run BEFORE any tool call has a chance to
        # enqueue — build_app() constructs the JobStore before serving.
        orphaned = self._reap_orphans_on_startup()
        pruned = self._prune_old_finished()
        log.info(
            "JobStore ready (db=%s, orphans_reaped=%d, old_rows_pruned=%d, workers=%d)",
            self.db_path, orphaned, pruned, WORKER_COUNT,
        )

    # ------------------------------------------------------------------
    # Lifecycle: enqueue + worker
    # ------------------------------------------------------------------

    def enqueue(self, entry: "ToolEntry", args: dict, ctx: "Ctx") -> str:
        """Insert a new ``queued`` row and hand it to the ThreadPoolExecutor.
        Returns the ``job_id`` immediately — the executor runs the tool
        asynchronously.

        ``ctx`` is only used for host_id, config, and log — a fresh Ctx is
        built inside the worker (with ``jobs=self`` and ``job_id=<id>``),
        because the request's Ctx dies with the request.
        """
        job_id = uuid.uuid4().hex
        try:
            params_json = json.dumps(args, default=str)
        except Exception as e:
            # Refuse to enqueue something we can't record. Better to raise
            # here than to fail later with a corrupt row.
            raise ValueError(
                f"Cannot enqueue {entry.name!r}: args not JSON-serialisable ({e})"
            ) from e

        now = _now_iso()
        with self._lock:
            self._conn.execute(
                "INSERT INTO jobs (id, tool_name, status, created_at, params_json) "
                "VALUES (?, ?, 'queued', ?, ?)",
                (job_id, entry.name, now, params_json),
            )
        log.info(
            "job enqueued: id=%s tool=%s claims_sub=%s",
            job_id, entry.name, ctx.claims.get("sub") if ctx.claims else None,
        )

        # Capture what the worker needs. Not ctx.claims — jobs run without
        # the requester's identity beyond this enqueue log line.
        host_id = ctx.host_id
        config = ctx.config
        parent_log = ctx.log

        self._executor.submit(
            self._run_job,
            job_id=job_id,
            entry=entry,
            args=args,
            host_id=host_id,
            config=config,
            parent_log=parent_log,
        )
        return job_id

    def _run_job(
        self,
        *,
        job_id: str,
        entry: "ToolEntry",
        args: dict,
        host_id: str,
        config: "Config",
        parent_log: logging.Logger,
    ) -> None:
        """Worker body. Runs on a ThreadPoolExecutor thread. Marks the row
        ``running``, invokes the handler, and marks the row
        ``succeeded`` / ``failed`` based on the outcome. Anything raised by
        the handler becomes the ``error`` column verbatim (via ``repr``).
        """
        # Local import breaks the platform ↔ jobs import cycle at runtime
        # (platform imports config; jobs uses platform.Ctx only in typing).
        from .platform import Ctx, WorkshopError, _validate_envelope

        self._mark_running(job_id)
        job_log = logging.getLogger(f"workshop.jobs.{job_id[:8]}")

        # Fresh Ctx for the job. jobs=self so handlers can call
        # ctx.jobs.update_progress(ctx.job_id, ...). claims={} — see enqueue
        # comment about not propagating requester identity into the job.
        ctx = Ctx(
            host_id=host_id,
            config=config,
            log=job_log,
            jobs=self,
            claims={},
            job_id=job_id,
        )

        try:
            if inspect.iscoroutinefunction(entry.handler):
                # Fresh event loop per job. The worker thread doesn't have
                # one, and we don't want to touch the main uvicorn loop
                # from a worker.
                loop = asyncio.new_event_loop()
                try:
                    envelope = loop.run_until_complete(entry.handler(args, ctx))
                finally:
                    loop.close()
            else:
                envelope = entry.handler(args, ctx)

            data, meta = _validate_envelope(envelope, entry.name)
            # `meta` isn't currently persisted for jobs — jobs don't emit a
            # streaming truncation NOTE the way a synchronous tool does.
            # If a later tool wants meta round-trip, add a `meta_json`
            # column and thread it through get_job_status.
            _ = meta
            self._mark_succeeded(job_id, data)
            parent_log.info("job succeeded: id=%s tool=%s", job_id, entry.name)
        except WorkshopError as e:
            self._mark_failed(job_id, f"{type(e).__name__}: {e}")
            parent_log.info(
                "job failed: id=%s tool=%s reason=%s: %s",
                job_id, entry.name, type(e).__name__, e,
            )
        except Exception as e:
            # Log with traceback so debugging doesn't require reproducing
            # the crash — but stash a shorter message in the DB.
            parent_log.exception("job crashed: id=%s tool=%s", job_id, entry.name)
            self._mark_failed(job_id, f"{type(e).__name__}: {e}")

    # ------------------------------------------------------------------
    # Read APIs
    # ------------------------------------------------------------------

    def get(self, job_id: str) -> dict | None:
        """Return the full public view of one job, or None if not found.

        Excludes ``params_json`` per spec §5.3. ``result_json`` is parsed
        back to a native object under key ``result`` for finished jobs.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT id, tool_name, status, created_at, started_at, "
                "finished_at, result_json, error, progress_pct, progress_message "
                "FROM jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_public(row)

    def list(self, limit: int, status: str | None = None) -> list[dict]:
        """Recent jobs, most recent first. ``limit`` is expected to have
        been clamped upstream by ``clamp_limit`` — this method does not
        clamp again to avoid double-clamping surprises."""
        with self._lock:
            if status is None:
                rows = self._conn.execute(
                    "SELECT id, tool_name, status, created_at, started_at, "
                    "finished_at, result_json, error, progress_pct, progress_message "
                    "FROM jobs ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT id, tool_name, status, created_at, started_at, "
                    "finished_at, result_json, error, progress_pct, progress_message "
                    "FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?",
                    (status, limit),
                ).fetchall()
        return [self._row_to_public(r) for r in rows]

    def status_snapshot(self) -> dict[str, int]:
        """Counts for ``get_workshop_status.jobs`` (spec §6). Live counters,
        computed from the DB — no in-memory shadow to fall out of sync."""
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat().replace("+00:00", "Z")
        with self._lock:
            row = self._conn.execute(
                "SELECT "
                "  SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued, "
                "  SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running, "
                "  SUM(CASE WHEN status IN ('succeeded','failed','cancelled') "
                "           AND finished_at > ? THEN 1 ELSE 0 END) AS finished_24h "
                "FROM jobs",
                (cutoff,),
            ).fetchone()
        return {
            "queued": int(row["queued"] or 0),
            "running": int(row["running"] or 0),
            "finished_24h": int(row["finished_24h"] or 0),
        }

    # ------------------------------------------------------------------
    # Progress + finalisation (called by workers and handlers)
    # ------------------------------------------------------------------

    def update_progress(self, job_id: str, pct: int | None, message: str | None) -> None:
        """Called by handlers running inside a worker to report progress.
        Both arguments are optional so a handler can update either without
        touching the other (e.g. incremental pct with the previous message)."""
        with self._lock:
            # Two separate UPDATEs would be simpler but risk clobbering
            # each other. One statement writes only the columns supplied.
            sets = []
            params: list[Any] = []
            if pct is not None:
                sets.append("progress_pct = ?")
                params.append(int(pct))
            if message is not None:
                sets.append("progress_message = ?")
                params.append(str(message))
            if not sets:
                return
            params.append(job_id)
            self._conn.execute(
                f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?",
                params,
            )

    def _mark_running(self, job_id: str) -> None:
        now = _now_iso()
        with self._lock:
            self._conn.execute(
                "UPDATE jobs SET status='running', started_at=? WHERE id=?",
                (now, job_id),
            )

    def _mark_succeeded(self, job_id: str, result: Any) -> None:
        now = _now_iso()
        try:
            result_json = json.dumps(result, default=str)
        except Exception as e:
            # A tool that returns something unserialisable is a bug in the
            # tool — surface via error, not by claiming success.
            self._mark_failed(
                job_id,
                f"handler succeeded but result was not JSON-serialisable: {e}",
            )
            return
        with self._lock:
            self._conn.execute(
                "UPDATE jobs SET status='succeeded', finished_at=?, result_json=?, "
                "progress_pct=100 WHERE id=?",
                (now, result_json, job_id),
            )

    def _mark_failed(self, job_id: str, error: str) -> None:
        now = _now_iso()
        with self._lock:
            self._conn.execute(
                "UPDATE jobs SET status='failed', finished_at=?, error=? WHERE id=?",
                (now, error, job_id),
            )

    # ------------------------------------------------------------------
    # Startup housekeeping
    # ------------------------------------------------------------------

    def _reap_orphans_on_startup(self) -> int:
        """Any row still ``running`` after we've just started means the
        previous process died mid-job. Mark failed with a diagnostic
        message so ``get_job_status`` tells the truth — silently leaving
        the row ``running`` would be a lie (spec §5.4)."""
        now = _now_iso()
        with self._lock:
            cursor = self._conn.execute(
                "UPDATE jobs SET status='failed', finished_at=?, "
                "error='interrupted by restart' WHERE status='running'",
                (now,),
            )
            return cursor.rowcount or 0

    def _prune_old_finished(self) -> int:
        """Delete finished rows older than ``RETENTION_DAYS`` (spec §5.4)."""
        cutoff = (
            datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
        ).isoformat().replace("+00:00", "Z")
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM jobs WHERE status IN ('succeeded','failed','cancelled') "
                "AND finished_at IS NOT NULL AND finished_at < ?",
                (cutoff,),
            )
            return cursor.rowcount or 0

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _row_to_public(self, row: sqlite3.Row) -> dict:
        d = dict(row)
        # Parse the result_json back to a native object when finished; drop
        # the raw string from the payload either way. Failure to parse
        # means a corrupt row — surface the raw string in an "error" so it
        # isn't silent.
        result_json = d.pop("result_json", None)
        if d["status"] == "succeeded" and result_json is not None:
            try:
                d["result"] = json.loads(result_json)
            except json.JSONDecodeError:
                d["result"] = None
                d["error"] = f"corrupt result_json: {result_json!r}"
        else:
            d["result"] = None
        return d
