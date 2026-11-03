"""Credentials from the environment or the repo's .env file (pure stdlib; values are never printed or written).

    DATAFORDELER_GRAPHQL_API_KEY   Datafordeler API key (DHM point cloud)
    GSEARCH_TOKEN                  Dataforsyningen token (orthophotos, CIR, Skråfoto, DHM WCS)
    DHM_TERRAIN_TOKEN              Dataforsyningen token for the DHM WCS (falls back to GSEARCH_TOKEN where a script allows it)
    DATAFORDELER_USERNAME/PASSWORD Datafordeler service user (DAR / DAGI WFS; replaced by datagrundlag.dk in phases 2 and 5)

A variable already in the environment wins over .env. See .env.example for the file format (NAME=value, # comments).
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_loaded = False


def load_dotenv(path: Path | None = None) -> None:
    """Fill os.environ from .env (repo root) for names that are not set yet. Silently does nothing without the file."""
    global _loaded
    if _loaded and path is None:
        return
    _loaded = True
    p = path or ROOT / ".env"
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if name and value and not os.environ.get(name):
            os.environ[name] = value


def first(*names: str) -> str | None:
    """The value of the first of `names` that is set (environment, then .env), or None."""
    load_dotenv()
    for n in names:
        v = os.environ.get(n, "").strip()
        if v:
            return v
    return None


def require(*names: str) -> str:
    """Like first(), but stops the script with the names to set when none is."""
    v = first(*names)
    if v is None:
        raise SystemExit(f"set {' or '.join(names)} in the environment or in .env (see .env.example); it is never printed")
    os.environ.setdefault(names[0], v)
    return v
