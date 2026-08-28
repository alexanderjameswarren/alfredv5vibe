"""Tool modules. Importing this package MUST trigger every ``@define_tool``
decorator so the platform registry is populated before ``list_tools`` is
served. Add new tools by writing a module here and appending its import
below — never rely on dynamic module discovery, so a missing import is a
compile-time (import-time) error rather than a silently-absent tool."""

from . import status  # noqa: F401  — registers get_workshop_status
from . import jobs    # noqa: F401  — registers get_job_status + list_jobs
from . import dj      # noqa: F401  — registers get_dj_history + get_dj_playlists
from . import dj_write  # noqa: F401  — registers search + the 3 playlist write tools
