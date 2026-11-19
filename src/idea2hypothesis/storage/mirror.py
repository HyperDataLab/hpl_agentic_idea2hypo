"""Copy of each run folder kept outside the engine's (ephemeral) disk.

In the Cloudflare deployment the engine runs in a container whose disk is lost when it stops.
After every event the changed files of the run are sent to the Worker, which stores them in R2;
a run that is not on disk is fetched back before it is read. The container holds no storage key:
it only knows the Worker's internal URL and key.

Wire contract (Worker, ``X-Service-Key``):

* ``PUT  {base}/runs/{run_id}/files/{path}`` body = file bytes, ``X-Content-SHA256`` = hex digest
* ``GET  {base}/runs/{run_id}/files`` -> ``{"files": {"<path>": "<sha256>", ...}}``
  (404 = unknown run)
* ``GET  {base}/runs/{run_id}/files/{path}`` -> file bytes
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

import httpx

from idea2hypothesis.storage.artifacts import write_bytes_atomic
from idea2hypothesis.storage.runs import RunStore

logger = logging.getLogger(__name__)


class RunMirror(Protocol):
    async def put(self, run_id: str, path: str, data: bytes, sha256: str) -> None: ...
    async def list(self, run_id: str) -> dict[str, str] | None: ...
    async def get(self, run_id: str, path: str) -> bytes: ...


class HttpRunMirror:
    """The Worker's file routes."""

    def __init__(
        self, base_url: str, key: str, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._base = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            transport=transport, timeout=60.0, headers={"X-Service-Key": key}
        )

    def _url(self, run_id: str, path: str | None = None) -> str:
        url = f"{self._base}/runs/{quote(run_id, safe='')}/files"
        return url if path is None else f"{url}/{quote(path, safe='/')}"

    async def put(self, run_id: str, path: str, data: bytes, sha256: str) -> None:
        response = await self._client.put(
            self._url(run_id, path), content=data, headers={"X-Content-SHA256": sha256}
        )
        response.raise_for_status()

    async def list(self, run_id: str) -> dict[str, str] | None:
        response = await self._client.get(self._url(run_id))
        if response.status_code == 404:
            return None
        response.raise_for_status()
        files = response.json().get("files", {})
        return {str(k): str(v) for k, v in files.items()}

    async def get(self, run_id: str, path: str) -> bytes:
        response = await self._client.get(self._url(run_id, path))
        response.raise_for_status()
        return response.content

    async def aclose(self) -> None:
        await self._client.aclose()


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_relative(path: str) -> bool:
    parts = Path(path).parts
    return bool(parts) and not Path(path).is_absolute() and ".." not in parts and ":" not in path


class MirrorSync:
    """Sends changed run files to the mirror and fetches a run back when it is missing."""

    def __init__(self, store: RunStore, mirror: RunMirror) -> None:
        self.store = store
        self.mirror = mirror
        self._sent: dict[str, dict[str, str]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._dirty: set[str] = set()
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def _lock(self, run_id: str) -> asyncio.Lock:
        return self._locks.setdefault(run_id, asyncio.Lock())

    def _local_files(self, run_id: str) -> dict[str, bytes]:
        root = self.store.run_dir(run_id)
        files: dict[str, bytes] = {}
        for path in sorted(root.rglob("*")):
            # write_bytes_atomic's temporary files are named "<name>.tmp-<pid>-<hex>".
            if not path.is_file() or ".tmp-" in path.name:
                continue
            try:
                files[path.relative_to(root).as_posix()] = path.read_bytes()
            except OSError:
                continue  # replaced or removed while listing; the next sync sends it
        return files

    async def sync(self, run_id: str) -> int:
        """Send the files that changed since the last sync; returns how many were sent."""
        async with self._lock(run_id):
            sent = self._sent.setdefault(run_id, {})
            count = 0
            for path, data in self._local_files(run_id).items():
                digest = _digest(data)
                if sent.get(path) == digest:
                    continue
                await self.mirror.put(run_id, path, data, digest)
                sent[path] = digest
                count += 1
            return count

    def schedule(self, run_id: str) -> None:
        """Sync soon; calls made while a sync runs are folded into one more pass."""
        self._dirty.add(run_id)
        task = self._tasks.get(run_id)
        if task is None or task.done():
            self._tasks[run_id] = asyncio.get_running_loop().create_task(self._drain(run_id))

    async def _drain(self, run_id: str) -> None:
        while run_id in self._dirty:
            self._dirty.discard(run_id)
            try:
                await self.sync(run_id)
            except (httpx.HTTPError, OSError) as exc:
                # Kept on disk; the next event tries again. Never fails the run.
                logger.warning("mirror sync of %s failed: %s", run_id, exc)
                return

    async def wait_idle(self) -> None:
        while any(not t.done() for t in self._tasks.values()):
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    async def restore(self, run_id: str) -> bool:
        """Fetch a run that is not on disk; ``False`` when the mirror does not know it either."""
        async with self._lock(run_id):
            if self.store.exists(run_id):
                return True
            listing = await self.mirror.list(run_id)
            if not listing or "run.json" not in listing:
                return False
            root = self.store.run_dir(run_id)
            # run.json last: the run counts as present only once every other file is in place.
            for path in sorted(listing, key=lambda p: p == "run.json"):
                if not _safe_relative(path):
                    logger.warning("mirror of %s lists an unsafe path %r; skipped", run_id, path)
                    continue
                data = await self.mirror.get(run_id, path)
                if _digest(data) != listing[path]:
                    raise OSError(f"mirror copy of {run_id}/{path} does not match its digest")
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                write_bytes_atomic(target, data)
            self._sent[run_id] = dict(listing)
            return True
