"""Workshop entrypoint. Loads .env, configures logging, starts uvicorn.

Run directly (`python run.py`) or as a Windows scheduled task pointing at
`.venv\\Scripts\\python.exe run.py` with "Start in" set to this directory.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

from dotenv import load_dotenv


HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"
DATA_DIR.mkdir(exist_ok=True)


def _configure_logging() -> None:
    # Both stdout AND file. The file (data/workshop.log) is what the
    # refresh script tails when a health check fails; stdout is what the
    # Windows scheduled-task history captures. Root-level so anything under
    # `workshop.*` and `uvicorn.*` funnels through the same handlers.
    log_path = DATA_DIR / "workshop.log"
    fmt = "%(asctime)s [%(levelname)s] %(name)s %(message)s"

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()

    file_h = logging.FileHandler(log_path, encoding="utf-8")
    file_h.setFormatter(logging.Formatter(fmt))
    root.addHandler(file_h)

    stream_h = logging.StreamHandler(sys.stdout)
    stream_h.setFormatter(logging.Formatter(fmt))
    root.addHandler(stream_h)


def main() -> None:
    # Load .env BEFORE any workshop.* imports — load_config reads os.environ
    # eagerly and would otherwise see unset values.
    load_dotenv(HERE / ".env")
    _configure_logging()

    import uvicorn

    from workshop.config import load_config
    from workshop.server import build_app

    config = load_config()
    app = build_app(config)

    logging.getLogger("workshop").info(
        "starting host_id=%s port=%s public_origin=%s auth_mode=%s",
        config.host_id, config.port, config.public_origin, config.auth_mode,
    )

    # 127.0.0.1, not 0.0.0.0: only cloudflared talks to this process. Nothing
    # on the LAN should reach the raw port — Cloudflare + our JWT check is
    # the auth boundary. Binding globally would open a second, unauthed door.
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=config.port,
        log_config=None,  # we own logging
    )


if __name__ == "__main__":
    main()
