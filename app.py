"""Vercel's supported FastAPI discovery entrypoint."""
import os

if os.getenv("VERCEL"):
    os.environ.setdefault("CACHE_DIR", "/tmp/heat-atlas-cache")

from backend.main import app  # noqa: E402,F401
