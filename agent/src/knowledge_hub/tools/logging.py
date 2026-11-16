"""Logging setup shared by the engine and the worker."""

from __future__ import annotations

import logging
import os
import sys


def configure_logging(level: str | None = None) -> None:
    resolved = (level or os.environ.get("LOG_LEVEL") or "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, resolved, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
        force=True,
    )
    # httpx logs full URLs at INFO; we only want warnings from third-party libs.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("pymilvus").setLevel(logging.WARNING)


__all__ = ["configure_logging"]
