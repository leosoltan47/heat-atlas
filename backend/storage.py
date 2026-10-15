"""A small document database for a single-process demo deployment.

TinyDB is NoSQL, with one document per model/grid point/year. Atomic replacement
prevents truncated JSON on interruption; a process-local lock serializes writes.
For multiple workers/instances, replace this adapter with a shared document DB.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
import threading
from tinydb import TinyDB, Query
from tinydb.storages import Storage


class AtomicJSONStorage(Storage):
    def __init__(self, path: str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def read(self):
        if not self.path.exists():
            return None
        with self.path.open(encoding="utf-8") as handle:
            return json.load(handle)

    def write(self, data):
        fd, temp_name = tempfile.mkstemp(dir=self.path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, allow_nan=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)


class WeatherStore:
    def __init__(self, directory: str):
        self._lock = threading.RLock()
        self.db = TinyDB(str(Path(directory) / "weather.json"), storage=AtomicJSONStorage)
        self.weather = self.db.table("weather", cache_size=0)

    def get_years(self, location_key: str, years: list[int]) -> dict[int, dict]:
        now = datetime.now(timezone.utc).timestamp()
        with self._lock:
            result = self.weather.search(Query().location_key == location_key)
            return {doc["year"]: dict(doc) for doc in result
                    if doc["year"] in years and now - doc["fetched_at"] < 30 * 86400}

    def put_years(self, location_key: str, documents: list[dict]) -> None:
        with self._lock:
            cutoff = datetime.now(timezone.utc).timestamp() - 30 * 86400
            self.weather.remove(Query().fetched_at < cutoff)
            for document in documents:
                record = {**document, "location_key": location_key}
                self.weather.upsert(record, (Query().location_key == location_key) & (Query().year == document["year"]))
            # Bound public-demo disk use; evicted histories can be fetched again.
            excess = len(self.weather) - 2400
            if excess > 0:
                oldest = sorted(self.weather.all(), key=lambda doc: doc["fetched_at"])[:excess]
                self.weather.remove(doc_ids=[doc.doc_id for doc in oldest])

    def close(self) -> None:
        with self._lock:
            self.db.close()
