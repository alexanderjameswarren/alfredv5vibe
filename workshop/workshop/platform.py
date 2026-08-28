"""Workshop's platform module — the Python mirror of ``_shared/platform.ts``.

Owns tool registration, tier gating, error taxonomy, envelope discipline, and
``clamp_limit``. All tools land here through ``@define_tool``; the MCP mount
(Step 3) drives everything through ``call_tool``.

Same taxonomy, same envelope discipline, same two error classes as the
TypeScript platform module. Do not invent a second architecture — if a
concept doesn't map cleanly to the TS side, that's the signal to stop and
reconcile, not to fork.
"""
from __future__ import annotations

import ast
import inspect
import logging
import textwrap
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Union

from .config import Config


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class WorkshopError(Exception):
    """Base for tool-level errors that surface as MCP ``isError=true``."""


class GuardrailError(WorkshopError):
    """A terminal denial the model must NOT retry (budget cap, loop
    detection, permission refusal). The 'Do NOT retry' clause from spec §4.3
    is enforced verbatim — if a caller passes a reason without it, we append
    it. Never soften or paraphrase.
    """

    TERMINAL_CLAUSE = (
        "Do NOT retry — retrying will not change the result. "
        "Stop and report to the user."
    )

    def __init__(self, reason: str):
        reason = reason.strip()
        if self.TERMINAL_CLAUSE in reason:
            message = reason
        else:
            # Ensure exactly one full stop before the terminal clause.
            head = reason.rstrip(".").rstrip()
            message = f"{head}. {self.TERMINAL_CLAUSE}"
        super().__init__(message)


class OperationalError(WorkshopError):
    """A retryable failure (timeout, network, subprocess crash). Must NOT
    carry do-not-retry wording — that would suppress a retry that should
    happen. Enforced at construction: any 'do not retry' / 'don't retry' /
    'no retry' phrasing raises ``ValueError`` and points the raiser at
    ``GuardrailError``.
    """

    _FORBIDDEN_PHRASES = (
        "do not retry",
        "don't retry",
        "no retry",
        "not retry",
    )

    def __init__(self, message: str):
        lowered = message.lower()
        for phrase in self._FORBIDDEN_PHRASES:
            if phrase in lowered:
                raise ValueError(
                    f"OperationalError message contains {phrase!r} — that "
                    f"phrasing is reserved for GuardrailError (spec §4.3). "
                    f"If this denial is truly terminal, raise GuardrailError."
                )
        super().__init__(message)


class SchemaParityError(WorkshopError):
    """Registration-time error: a handler reads an ``args`` key that its
    ``input_schema`` does not declare. Advertising and honouring must match,
    or a fresh session sees a manifest that lies about the tool's surface
    (spec §4.1)."""


# ---------------------------------------------------------------------------
# Ctx
# ---------------------------------------------------------------------------


@dataclass
class Ctx:
    """What a tool handler receives. Tools reach for nothing global — the
    Workshop analogue of "never import the Supabase client in a tool file"
    (spec §4.4). ``jobs`` is typed ``Any`` because the JobStore concrete
    class arrives in Step 7; the field exists now so the shape doesn't
    change across steps.
    """

    host_id: str
    config: Config
    log: logging.Logger
    jobs: Any = None                       # JobStore — Step 7 (workshop/jobs.py)
    claims: dict = field(default_factory=dict)  # decoded token; observability only
    job_id: Union[str, None] = None        # set only inside a job worker


# ---------------------------------------------------------------------------
# Registry + define_tool
# ---------------------------------------------------------------------------


Handler = Callable[[dict, Ctx], Union[dict, Awaitable[dict]]]


@dataclass(frozen=True)
class ToolEntry:
    name: str
    tier: int
    description: str
    input_schema: dict
    long_running: bool
    handler: Handler
    # Tier-3 only, and REQUIRED there. Resolves what the call would actually
    # act on, so the proposal describes a target rather than echoing arguments.
    preview: Union[Handler, None] = None


_REGISTRY: dict[str, ToolEntry] = {}


def _extract_declared_keys(input_schema: dict) -> set[str]:
    props = input_schema.get("properties") or {}
    if not isinstance(props, dict):
        raise TypeError(
            f"input_schema.properties must be a dict, got {type(props).__name__}"
        )
    return set(props.keys())


# Reads we detect syntactically in the handler body. The check catches the
# common patterns: ``args["k"]``, ``args.get("k")``, ``args.get("k", default)``.
# Handlers that compute keys at runtime (``args[k]`` where k is a variable)
# fall outside this static check — the spec's intent is "no honoured-but-
# unadvertised parameters", which the dynamic pattern violates too but can't
# be caught here. Keep tool handlers pattern-literal.
def _statically_read_arg_keys(handler: Handler) -> set[str]:
    try:
        source = inspect.getsource(handler)
    except (OSError, TypeError):
        # Built-ins, C funcs, REPL-defined lambdas — can't inspect. Skip.
        return set()
    source = textwrap.dedent(source)
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()

    keys: set[str] = set()
    for node in ast.walk(tree):
        # args["literal"] / args['literal']
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Name)
            and node.value.id == "args"
        ):
            slice_node = node.slice
            if isinstance(slice_node, ast.Constant) and isinstance(
                slice_node.value, str
            ):
                keys.add(slice_node.value)
        # args.get("literal", ...)
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "args"
            and node.func.attr == "get"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            keys.add(node.args[0].value)
    return keys


def _assert_schema_parity(handler: Handler, input_schema: dict, name: str) -> None:
    read_keys = _statically_read_arg_keys(handler)
    declared = _extract_declared_keys(input_schema)
    # 'confirmed' is platform-owned (tier-3 gate). Handlers never need to
    # declare it in their own schema — the gate consumes it before dispatch.
    undeclared = read_keys - declared - {"confirmed"}
    if undeclared:
        raise SchemaParityError(
            f"Tool {name!r}: handler reads {sorted(undeclared)} but "
            f"input_schema.properties declares {sorted(declared)}. "
            f"Every key the handler reads must appear in input_schema. "
            f"Either add the missing properties or stop reading them."
        )


def define_tool(
    *,
    name: str,
    tier: int,
    description: str,
    input_schema: dict,
    long_running: bool = False,
    preview: Union[Handler, None] = None,
) -> Callable[[Handler], Handler]:
    """Register a tool. Every ``@define_tool`` fires at import so the
    registry is populated before ``list_tools`` is ever served.

    Enforces at registration time:
      * ``tier`` is 1, 2, or 3
      * ``input_schema`` has ``type: object`` and a ``properties`` dict
      * every key the handler reads appears in ``input_schema.properties``
        (see ``_statically_read_arg_keys`` for scope)
      * ``name`` isn't already registered
      * tier-3 tools supply a ``preview`` (see below)

    ``preview(args, ctx)`` is MANDATORY for tier 3 and ignored otherwise. It
    resolves what the call would act on and returns a dict describing it, which
    the gate embeds in the proposal.

    Without it the gate stops accidental EXECUTION but not accidental WRONG
    TARGET: a proposal that only echoes its arguments looks exactly as
    reassuring for a mistyped id as for the right one, so a human reading it
    cannot tell the difference — and reading it is the entire point of a speed
    bump. Requiring the hook at registration makes "a destructive tool can say
    what it would destroy" mechanical rather than a habit each tool re-forms.
    """

    if tier not in (1, 2, 3):
        raise ValueError(f"Tool {name!r}: tier must be 1, 2, or 3 (got {tier!r})")
    if not isinstance(input_schema, dict):
        raise TypeError(
            f"Tool {name!r}: input_schema must be a dict, got "
            f"{type(input_schema).__name__}"
        )
    if input_schema.get("type") != "object":
        raise ValueError(
            f"Tool {name!r}: input_schema.type must be 'object'"
        )
    if tier == 3 and preview is None:
        raise ValueError(
            f"Tool {name!r} is tier 3 and must supply a `preview` callable. "
            f"The confirmation gate exists so a human can read what would "
            f"happen; a proposal that only echoes its arguments is "
            f"indistinguishable between the right target and a mistyped one."
        )
    if "properties" not in input_schema:
        raise ValueError(
            f"Tool {name!r}: input_schema must define 'properties' (may be {{}})"
        )

    def decorator(handler: Handler) -> Handler:
        _assert_schema_parity(handler, input_schema, name)
        if name in _REGISTRY:
            raise ValueError(
                f"Tool {name!r} is already registered by "
                f"{_REGISTRY[name].handler!r}"
            )
        _REGISTRY[name] = ToolEntry(
            name=name,
            tier=tier,
            description=description,
            input_schema=input_schema,
            long_running=long_running,
            handler=handler,
            preview=preview,
        )
        return handler

    return decorator


def get_registry() -> dict[str, ToolEntry]:
    """Defensive copy of the tool registry. Callers must not mutate the
    returned dict — the source of truth stays module-level."""
    return dict(_REGISTRY)


def list_tools() -> list[dict]:
    """Public manifest — what MCP ``list_tools`` serves (spec §4.1)."""
    return [
        {
            "name": e.name,
            "tier": e.tier,
            "description": e.description,
            "input_schema": e.input_schema,
            "long_running": e.long_running,
        }
        for e in _REGISTRY.values()
    ]


def _reset_registry_for_tests() -> None:
    """Test-only. Clears the module-level registry so unit tests can
    register throwaway tools without cross-test contamination. NEVER call
    this from production code — the registry is meant to be immutable at
    runtime after import."""
    _REGISTRY.clear()


# ---------------------------------------------------------------------------
# Envelope discipline
# ---------------------------------------------------------------------------

TRUNCATED_NOTE_PREFIX = (
    "NOTE: results truncated to {shown} of {total}. "
    "Narrow the query or request a specific subset."
)


def truncated_note(shown: int, total: int) -> str:
    """The single line that MUST prepend a payload emitted with
    ``meta.truncated`` set. The one fact the model cannot infer — a clamped
    result looks identical to a complete one (spec §4.1)."""
    return TRUNCATED_NOTE_PREFIX.format(shown=shown, total=total)


def _validate_envelope(envelope: Any, tool_name: str) -> tuple[Any, dict]:
    if not isinstance(envelope, dict):
        raise TypeError(
            f"Tool {tool_name!r} returned {type(envelope).__name__}, "
            f"expected an envelope dict with 'data' and optional 'meta'."
        )
    if "data" not in envelope:
        raise ValueError(
            f"Tool {tool_name!r} envelope is missing 'data'. Handlers must "
            f"return {{'data': ..., 'meta': ...}} even for trivial payloads."
        )
    meta = envelope.get("meta") or {}
    if not isinstance(meta, dict):
        raise TypeError(
            f"Tool {tool_name!r} envelope 'meta' must be a dict, got "
            f"{type(meta).__name__}"
        )
    return envelope["data"], meta


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


async def _build_tier_3_proposal(entry: ToolEntry, args: dict, ctx: Ctx) -> dict:
    """Payload returned by the tier-3 gate when ``confirmed`` is missing or
    false. The MCP layer emits this as normal tool output — the confirmation
    is a re-call by the user, not a bespoke UI (spec §4.1).

    Runs the tool's ``preview`` so the proposal describes the TARGET, not just
    the arguments. A preview failure is reported inside the proposal rather
    than raised: "I could not find that playlist" is exactly what the reader
    needs to see, and it must not look like a transport error.
    """
    target: Any
    try:
        if inspect.iscoroutinefunction(entry.preview):
            target = await entry.preview(args, ctx)
        else:
            target = entry.preview(args, ctx)  # type: ignore[misc]
    except Exception as e:
        target = {
            "resolved": False,
            "error": f"{type(e).__name__}: {e}",
            "warning": (
                "The target could not be resolved, so this proposal cannot say "
                "what would be affected. Do NOT confirm until this is understood "
                "— an unresolvable target is usually a wrong id."
            ),
        }
    return {
        "kind": "tier_3_proposal",
        "tool": entry.name,
        "description": entry.description,
        "args": {k: v for k, v in args.items() if k != "confirmed"},
        "target": target,
        "message": (
            f"Tool '{entry.name}' is tier 3 (destructive, superseding, or "
            f"semantically significant). Nothing has been executed. Read `target` "
            f"and confirm it is what you meant — then re-call this tool with "
            f"`confirmed: true` in the arguments."
        ),
    }


async def call_tool(name: str, args: dict, ctx: Ctx) -> tuple[Any, dict]:
    """Dispatch a tool call. Returns ``(data, meta)`` — the MCP layer emits
    ``data`` bare and prepends ``truncated_note(...)`` iff ``meta.truncated``.

    Raises:
      * ``GuardrailError`` — terminal denial, do-not-retry wording enforced.
      * ``OperationalError`` — retryable failure.
      * Anything else the handler raises, unchanged.

    The tier-3 gate returns a proposal envelope instead of executing when
    ``args['confirmed'] is not True``. Tier is a property of the tool — the
    same call is never sometimes-tier-1-sometimes-tier-3 (spec §4.2).
    """
    entry = _REGISTRY.get(name)
    if entry is None:
        raise OperationalError(f"Unknown tool: {name!r}")

    if entry.tier == 3 and args.get("confirmed") is not True:
        return await _build_tier_3_proposal(entry, args, ctx), {}

    if entry.long_running:
        # Enqueue via ctx.jobs and return the handle. The handler runs on a
        # worker thread and won't have completed by the time we return —
        # callers poll get_job_status. `poll_after_seconds` is a hint; the
        # real value ships from workshop.jobs.POLL_AFTER_SECONDS.
        if ctx.jobs is None:
            raise OperationalError(
                f"Tool {entry.name!r} is long_running but ctx.jobs is None "
                f"(JobStore not initialised in server assembly)."
            )
        from .jobs import POLL_AFTER_SECONDS  # local import — avoid cycle
        job_id = ctx.jobs.enqueue(entry, args, ctx)
        return {
            "job_id": job_id,
            "status": "queued",
            "poll_after_seconds": POLL_AFTER_SECONDS,
        }, {}

    if inspect.iscoroutinefunction(entry.handler):
        envelope = await entry.handler(args, ctx)
    else:
        envelope = entry.handler(args, ctx)

    return _validate_envelope(envelope, entry.name)


# ---------------------------------------------------------------------------
# clamp_limit
# ---------------------------------------------------------------------------


def clamp_limit(requested: Union[int, None], default: int = 20, cap: int = 50) -> int:
    """No list tool returns unbounded rows (spec §4.5). Pass the caller's
    ``limit`` verbatim; get back a usable integer.

    * ``None`` / non-positive → ``default``
    * request > cap           → ``cap``
    * otherwise               → ``requested``
    """
    if requested is None:
        return default
    try:
        n = int(requested)
    except (TypeError, ValueError):
        return default
    if n < 1:
        return default
    return min(n, cap)
