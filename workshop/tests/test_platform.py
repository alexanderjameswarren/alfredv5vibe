"""Unit tests for workshop.platform. Runs under stdlib ``unittest`` — no
pytest dep on the Surface. Every test resets the module registry so cases
don't cross-contaminate.

Coverage per Step 2's checklist:
  * Registration + schema-parity assertion
  * Tier-1 executes; tier-3 without confirmed returns a proposal; tier-3
    with confirmed executes
  * GuardrailError appends the terminal clause; OperationalError rejects
    do-not-retry wording at construction
  * clamp_limit boundary cases
  * Envelope validation

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import asyncio
import logging
import unittest

from workshop.config import Config
from workshop.platform import (
    Ctx,
    GuardrailError,
    OperationalError,
    SchemaParityError,
    _reset_registry_for_tests,
    call_tool,
    clamp_limit,
    define_tool,
    get_registry,
    list_tools,
    truncated_note,
)


def _make_test_config() -> Config:
    return Config(
        host_id="test-desktop",
        port=7777,
        public_origin="http://127.0.0.1:7777",
        auth_mode="strict",
        supabase_issuer="https://test.supabase.co/auth/v1",
        allowed_subs=frozenset({"test-sub"}),
    )


def _make_test_ctx() -> Ctx:
    return Ctx(
        host_id="test-desktop",
        config=_make_test_config(),
        log=logging.getLogger("workshop.test"),
    )


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class RegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_registry_for_tests()

    def test_define_tool_registers_entry(self) -> None:
        @define_tool(
            name="t_read",
            tier=1,
            description="reads a thing",
            input_schema={"type": "object", "properties": {}},
        )
        async def handler(args, ctx):
            return {"data": {"ok": True}}

        reg = get_registry()
        self.assertIn("t_read", reg)
        self.assertEqual(reg["t_read"].tier, 1)
        self.assertFalse(reg["t_read"].long_running)

        manifest = list_tools()
        self.assertEqual(len(manifest), 1)
        self.assertEqual(manifest[0]["name"], "t_read")

    def test_duplicate_name_rejected(self) -> None:
        @define_tool(
            name="t_dupe",
            tier=1,
            description="",
            input_schema={"type": "object", "properties": {}},
        )
        async def h1(args, ctx):
            return {"data": None}

        with self.assertRaises(ValueError):
            @define_tool(
                name="t_dupe",
                tier=1,
                description="",
                input_schema={"type": "object", "properties": {}},
            )
            async def h2(args, ctx):
                return {"data": None}

    def test_invalid_tier_rejected(self) -> None:
        with self.assertRaises(ValueError):
            @define_tool(
                name="t_bad_tier",
                tier=4,
                description="",
                input_schema={"type": "object", "properties": {}},
            )
            async def h(args, ctx):
                return {"data": None}

    def test_schema_missing_properties_rejected(self) -> None:
        with self.assertRaises(ValueError):
            @define_tool(
                name="t_no_props",
                tier=1,
                description="",
                input_schema={"type": "object"},
            )
            async def h(args, ctx):
                return {"data": None}

    def test_schema_wrong_type_rejected(self) -> None:
        with self.assertRaises(ValueError):
            @define_tool(
                name="t_wrong_type",
                tier=1,
                description="",
                input_schema={"type": "array", "properties": {}},
            )
            async def h(args, ctx):
                return {"data": None}


class SchemaParityTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_registry_for_tests()

    def test_reads_undeclared_key_rejected(self) -> None:
        with self.assertRaises(SchemaParityError) as ctx:
            @define_tool(
                name="t_parity_fail",
                tier=1,
                description="",
                input_schema={
                    "type": "object",
                    "properties": {"declared_key": {"type": "string"}},
                },
            )
            async def h(args, ctx):
                # 'undeclared_key' is not in input_schema.properties → boom.
                return {"data": args["undeclared_key"]}

        self.assertIn("undeclared_key", str(ctx.exception))

    def test_reads_declared_key_ok(self) -> None:
        @define_tool(
            name="t_parity_ok",
            tier=1,
            description="",
            input_schema={
                "type": "object",
                "properties": {"needle": {"type": "string"}},
            },
        )
        async def h(args, ctx):
            return {"data": args["needle"]}

        self.assertIn("t_parity_ok", get_registry())

    def test_get_form_also_checked(self) -> None:
        with self.assertRaises(SchemaParityError):
            @define_tool(
                name="t_get_fail",
                tier=1,
                description="",
                input_schema={"type": "object", "properties": {}},
            )
            async def h(args, ctx):
                return {"data": args.get("sneaky", None)}

    def test_confirmed_key_never_requires_declaration(self) -> None:
        # 'confirmed' is platform-owned by the tier-3 gate; handlers may
        # inspect it without declaring it.
        @define_tool(
            name="t_confirmed_ok",
            tier=3,
            description="",
            input_schema={"type": "object", "properties": {}},
        )
        async def h(args, ctx):
            _ = args.get("confirmed")
            return {"data": None}

        self.assertIn("t_confirmed_ok", get_registry())


class TierGateTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_registry_for_tests()

    def test_tier_1_executes(self) -> None:
        @define_tool(
            name="t1",
            tier=1,
            description="read",
            input_schema={"type": "object", "properties": {}},
        )
        async def h(args, ctx):
            return {"data": {"ran": True}}

        data, meta = _run(call_tool("t1", {}, _make_test_ctx()))
        self.assertEqual(data, {"ran": True})
        self.assertEqual(meta, {})

    def test_tier_3_without_confirmed_returns_proposal(self) -> None:
        @define_tool(
            name="t3_delete",
            tier=3,
            description="deletes rows",
            input_schema={
                "type": "object",
                "properties": {"target_id": {"type": "string"}},
            },
        )
        async def h(args, ctx):
            # Would delete; must never execute without confirmation.
            raise AssertionError("handler should NOT run without confirmed=true")

        data, meta = _run(
            call_tool("t3_delete", {"target_id": "abc-123"}, _make_test_ctx())
        )
        self.assertEqual(data["kind"], "tier_3_proposal")
        self.assertEqual(data["tool"], "t3_delete")
        self.assertEqual(data["description"], "deletes rows")
        self.assertEqual(data["args"], {"target_id": "abc-123"})
        # The 'confirmed' field, if present, is stripped from the echoed args.
        self.assertNotIn("confirmed", data["args"])
        self.assertIn("re-call this tool with `confirmed: true`", data["message"])
        self.assertEqual(meta, {})

    def test_tier_3_with_confirmed_executes(self) -> None:
        @define_tool(
            name="t3_ok",
            tier=3,
            description="",
            input_schema={
                "type": "object",
                "properties": {"target_id": {"type": "string"}},
            },
        )
        async def h(args, ctx):
            return {"data": {"deleted": args["target_id"]}}

        data, _ = _run(
            call_tool(
                "t3_ok",
                {"target_id": "abc-123", "confirmed": True},
                _make_test_ctx(),
            )
        )
        self.assertEqual(data, {"deleted": "abc-123"})

    def test_tier_3_with_confirmed_string_true_does_NOT_execute(self) -> None:
        # `is True` — the string "true" does not count.
        @define_tool(
            name="t3_string_true",
            tier=3,
            description="",
            input_schema={"type": "object", "properties": {}},
        )
        async def h(args, ctx):
            raise AssertionError("must not execute")

        data, _ = _run(
            call_tool("t3_string_true", {"confirmed": "true"}, _make_test_ctx())
        )
        self.assertEqual(data["kind"], "tier_3_proposal")

    def test_unknown_tool_raises_operational(self) -> None:
        with self.assertRaises(OperationalError):
            _run(call_tool("does_not_exist", {}, _make_test_ctx()))

    def test_long_running_without_jobstore_raises_operational(self) -> None:
        # `_make_test_ctx()` builds a Ctx with jobs=None. A long-running
        # tool dispatched via call_tool needs the JobStore to enqueue; if
        # server assembly forgot to wire it, we should surface loudly
        # rather than silently swallow the call.
        @define_tool(
            name="t_slow",
            tier=1,
            description="",
            input_schema={"type": "object", "properties": {}},
            long_running=True,
        )
        async def h(args, ctx):
            return {"data": None}

        with self.assertRaises(OperationalError) as cm:
            _run(call_tool("t_slow", {}, _make_test_ctx()))
        self.assertIn("ctx.jobs is None", str(cm.exception))


class EnvelopeTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_registry_for_tests()

    def test_envelope_missing_data_raises(self) -> None:
        @define_tool(
            name="t_bad_env",
            tier=1,
            description="",
            input_schema={"type": "object", "properties": {}},
        )
        async def h(args, ctx):
            return {"meta": {}}  # forgot 'data'

        with self.assertRaises(ValueError):
            _run(call_tool("t_bad_env", {}, _make_test_ctx()))

    def test_non_dict_envelope_raises(self) -> None:
        @define_tool(
            name="t_env_list",
            tier=1,
            description="",
            input_schema={"type": "object", "properties": {}},
        )
        async def h(args, ctx):
            return ["not", "a", "dict"]  # type: ignore[return-value]

        with self.assertRaises(TypeError):
            _run(call_tool("t_env_list", {}, _make_test_ctx()))

    def test_meta_propagates(self) -> None:
        @define_tool(
            name="t_meta",
            tier=1,
            description="",
            input_schema={"type": "object", "properties": {}},
        )
        async def h(args, ctx):
            return {"data": [1, 2], "meta": {"truncated": (2, 500)}}

        data, meta = _run(call_tool("t_meta", {}, _make_test_ctx()))
        self.assertEqual(data, [1, 2])
        self.assertEqual(meta["truncated"], (2, 500))

    def test_truncated_note_format(self) -> None:
        note = truncated_note(20, 500)
        self.assertIn("truncated to 20 of 500", note)
        self.assertIn("Narrow the query", note)


class ErrorTaxonomyTests(unittest.TestCase):
    def test_guardrail_appends_terminal_clause(self) -> None:
        err = GuardrailError("Budget cap of 20 calls hit for this session")
        msg = str(err)
        self.assertIn("Budget cap of 20 calls hit", msg)
        self.assertIn(GuardrailError.TERMINAL_CLAUSE, msg)

    def test_guardrail_does_not_duplicate_terminal(self) -> None:
        # If the caller pre-composed the message with the terminal clause,
        # we don't append a second copy.
        pre = f"LOOP DETECTED: same call, same result. {GuardrailError.TERMINAL_CLAUSE}"
        err = GuardrailError(pre)
        self.assertEqual(str(err).count(GuardrailError.TERMINAL_CLAUSE), 1)

    def test_operational_rejects_do_not_retry(self) -> None:
        for phrase in ("Do not retry", "DO NOT RETRY", "please don't retry"):
            with self.assertRaises(ValueError):
                OperationalError(f"Transient: {phrase} the request")

    def test_operational_ok_for_plain_retryable(self) -> None:
        err = OperationalError("Timed out waiting for demucs subprocess")
        self.assertIn("Timed out", str(err))


class ClampLimitTests(unittest.TestCase):
    def test_none_returns_default(self) -> None:
        self.assertEqual(clamp_limit(None), 20)

    def test_zero_returns_default(self) -> None:
        self.assertEqual(clamp_limit(0), 20)

    def test_negative_returns_default(self) -> None:
        self.assertEqual(clamp_limit(-5), 20)

    def test_in_range_returned_verbatim(self) -> None:
        self.assertEqual(clamp_limit(10), 10)

    def test_over_cap_clamped(self) -> None:
        self.assertEqual(clamp_limit(1000), 50)

    def test_custom_default_and_cap(self) -> None:
        self.assertEqual(clamp_limit(None, default=5, cap=25), 5)
        self.assertEqual(clamp_limit(999, default=5, cap=25), 25)

    def test_non_integer_returns_default(self) -> None:
        self.assertEqual(clamp_limit("nope"), 20)


if __name__ == "__main__":
    unittest.main()
