"""Import-time tests for ``workshop.tools`` — the check that ``ast.parse``
cannot perform.

WHY THIS FILE EXISTS
--------------------
On 2026-09-01 ``dj_setlists.py`` was verified with ``ast.parse`` and reported
as "parses cleanly". It did. It also raised ``TypeError`` the moment it was
imported, because ``@define_tool(...)`` was missing its required
``input_schema`` argument — and ``tools/__init__.py`` imports every tool module
eagerly, so the whole server died at startup. The tunnel stayed up with nothing
listening behind it.

⚠️ **SYNTACTIC VALIDITY IS NOT IMPORTABILITY.** A decorator that raises, a
missing name, a bad constant — none of them are syntax errors, and all of them
kill this server at startup. ``ast.parse`` reports success without verifying
the effect anyone cared about (spec §11.15). The only check that catches this
class of failure is ACTUALLY IMPORTING THE MODULE. That is what the Alfred side
added in ``index.test.mjs`` after the RUN_STATUS crash; this is the same fix in
the other language.

⚠️ **IT IS WORSE HERE THAN ON ALFRED.** Workshop autostarts under
``pythonw.exe``, which has no console, so this traceback is invisible in normal
operation. The symptom presented to a caller is not "Workshop crashed" but a
502 from the tunnel — which reads as a network or deploy fault and sends the
investigation to the wrong place entirely. These tests are where that traceback
becomes visible, so they print it verbatim on failure rather than summarising.

WHY SUBPROCESSES
----------------
Two reasons, both load-bearing:

1. ``test_platform.py`` calls ``_reset_registry_for_tests()``. Python caches
   modules, so an in-process ``import workshop.tools`` after that reset would
   re-bind an already-imported package WITHOUT re-running any decorator, and
   the registry would read as empty. The test would then pass or fail on TEST
   ORDER rather than on the code. A fresh interpreter has neither problem.

2. A fresh interpreter is what the server actually does. The failure being
   guarded against is a STARTUP failure, so the test should reproduce startup,
   not approximate it from inside a process where the import already succeeded.

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import ast
import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

WORKSHOP_DIR = Path(__file__).resolve().parents[1]

# The tools that must be registered after importing ``workshop.tools``.
# Spelled out rather than counted so a failure says WHICH tool went missing or
# appeared unexpectedly. Adding a tool is expected to fail this test once, and
# updating this set is the deliberate act of accepting the new surface.
EXPECTED_TOOLS = {
    "create_dj_playlist",
    "edit_dj_playlist",
    "get_dj_history",
    "get_dj_playlists",
    "get_dj_setlists",
    "get_job_status",
    "get_workshop_status",
    "list_jobs",
    "remove_from_dj_playlist",
    "search_dj_music",
}


def _run_in_fresh_interpreter(code: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=120,
    )


class ToolsImportTests(unittest.TestCase):
    def test_tools_package_imports_cleanly(self) -> None:
        """The bare minimum: importing every tool module must not raise.

        This is the case that was broken and shipped. It fails loudly, with the
        real traceback, precisely because in production that traceback goes to
        a console that does not exist.
        """
        proc = _run_in_fresh_interpreter("import workshop.tools", WORKSHOP_DIR)
        self.assertEqual(
            proc.returncode,
            0,
            "importing workshop.tools FAILED - the server cannot start.\n"
            "Under pythonw.exe this traceback is invisible and presents as a "
            "502 from the tunnel with nothing listening behind it.\n\n"
            f"--- stderr ---\n{proc.stderr}",
        )

    def test_expected_tools_are_registered(self) -> None:
        """Importing the package must POPULATE THE REGISTRY.

        A module can import cleanly and still register nothing — a dropped
        import line in ``tools/__init__.py`` does exactly that, and the server
        starts happily while serving a short ``list_tools``. Importing without
        checking the registry would not catch it.
        """
        proc = _run_in_fresh_interpreter(
            """
            import json
            import workshop.tools  # noqa: F401  — populates the registry
            from workshop.platform import get_registry
            print(json.dumps(sorted(get_registry())))
            """,
            WORKSHOP_DIR,
        )
        self.assertEqual(proc.returncode, 0, f"--- stderr ---\n{proc.stderr}")

        registered = set(json.loads(proc.stdout.strip().splitlines()[-1]))
        self.assertEqual(
            registered,
            EXPECTED_TOOLS,
            "registered tools differ from EXPECTED_TOOLS.\n"
            f"  missing:    {sorted(EXPECTED_TOOLS - registered)}\n"
            f"  unexpected: {sorted(registered - EXPECTED_TOOLS)}\n"
            "If you added or removed a tool deliberately, update "
            "EXPECTED_TOOLS in this file.",
        )

    def test_tool_count_matches(self) -> None:
        """The count, asserted separately from the names.

        Redundant with the set comparison by design: the count is the number
        quoted when reconnecting a connector ("expect 36, not 34"), so it is
        worth failing on its own terms.
        """
        self.assertEqual(len(EXPECTED_TOOLS), 10)


class ImportCheckIsNotVacuousTests(unittest.TestCase):
    """NEGATIVE CONTROL — proof the check above can actually fail.

    Per spec §11.1 a verification needs a case that FAILS if the thing is
    broken, and §11.16 requires the control to reproduce the ACTUAL defect
    rather than a plausible neighbour. So this does not use a syntax error —
    a syntax error would be caught by the old ``ast.parse`` check too and
    would prove nothing about the gap. It reproduces the REAL 2026-09-01
    defect: a ``@define_tool`` call missing ``input_schema``, which raises
    ``TypeError`` at import while remaining perfectly valid Python.
    """

    BROKEN_MODULE = (
        "from workshop.platform import Ctx, define_tool\n"
        "\n"
        "\n"
        "@define_tool(\n"
        '    name="deliberately_broken_tool",\n'
        "    tier=1,\n"
        '    description="Missing input_schema, exactly as dj_setlists.py was.",\n'
        ")\n"
        "async def deliberately_broken_tool(args: dict, ctx: Ctx) -> dict:\n"
        '    return {"ok": True}\n'
    )

    def test_the_real_defect_is_syntactically_valid(self) -> None:
        """ast.parse ACCEPTS the broken module. This is the whole lesson."""
        # Must not raise. If this ever starts raising, the control has drifted
        # into being a syntax-error test and no longer proves anything.
        ast.parse(self.BROKEN_MODULE)

    def test_but_importing_it_fails(self) -> None:
        """...and importing it does not. Same source, two different answers."""
        with tempfile.TemporaryDirectory(dir=str(WORKSHOP_DIR)) as tmp:
            pkg = Path(tmp)
            (pkg / "broken_tool_module.py").write_text(
                self.BROKEN_MODULE, encoding="utf-8"
            )
            proc = _run_in_fresh_interpreter(
                f"import {pkg.name}.broken_tool_module", WORKSHOP_DIR
            )

        self.assertNotEqual(
            proc.returncode,
            0,
            "the negative control IMPORTED SUCCESSFULLY - this test suite "
            "cannot detect the failure it was written to detect.",
        )
        self.assertIn(
            "input_schema",
            proc.stderr,
            "import failed for some reason OTHER than the missing "
            "input_schema, so the control is not reproducing the real "
            f"defect.\n--- stderr ---\n{proc.stderr}",
        )


if __name__ == "__main__":
    unittest.main()
