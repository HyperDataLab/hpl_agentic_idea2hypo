"""Run-file mirror: a run survives the loss of the engine's disk (container restart)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import httpx
import pytest

from idea2hypothesis.storage.mirror import HttpRunMirror, MirrorSync
from idea2hypothesis.storage.runs import RunStore
from tests.fixtures.api_helpers import SERVER_KEY, harness


@pytest.fixture(autouse=True)
def _server_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("I2H_SERVICE_KEY", SERVER_KEY)


class MemoryMirror:
    def __init__(self) -> None:
        self.files: dict[str, dict[str, bytes]] = {}
        self.puts = 0

    async def put(self, run_id: str, path: str, data: bytes, sha256: str) -> None:
        assert hashlib.sha256(data).hexdigest() == sha256
        self.files.setdefault(run_id, {})[path] = data
        self.puts += 1

    async def list(self, run_id: str) -> dict[str, str] | None:
        files = self.files.get(run_id)
        if files is None:
            return None
        return {p: hashlib.sha256(d).hexdigest() for p, d in files.items()}

    async def get(self, run_id: str, path: str) -> bytes:
        return self.files[run_id][path]


async def test_run_continues_on_a_fresh_disk(tmp_path: Path) -> None:
    mirror = MemoryMirror()
    async with harness(tmp_path / "first", mirror=mirror) as h:
        run_id = (await h.start("p-1")).json()["popper_run_id"]
        await h.settle()
        assert (await h.state(run_id))["status"] == "awaiting_review"
        before = await h.events(run_id)
    assert "run.json" in mirror.files[run_id]
    assert not any(".tmp-" in p for p in mirror.files[run_id])

    async with harness(tmp_path / "second", mirror=mirror) as h2:
        assert h2.service.store.list_run_ids() == []
        assert (await h2.state(run_id))["status"] == "awaiting_review"
        assert await h2.events(run_id) == before
        gate_id = next(e for e in reversed(before) if e["type"] == "gate.opened")["payload"][
            "gate_id"
        ]
        answer = await h2.client.post(
            f"/runs/{run_id}/gates/{gate_id}", json={"option_id": "approve"}
        )
        assert answer.status_code == 200, answer.text
        await h2.settle()
        assert (await h2.state(run_id))["status"] == "completed"


async def test_unknown_run_is_still_404(tmp_path: Path) -> None:
    async with harness(tmp_path, mirror=MemoryMirror()) as h:
        assert (await h.client.get("/runs/run-does-not-exist")).status_code == 404


async def test_only_changed_files_are_sent(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    store.create(
        "r-1", {"status": "running", "attempt": 1}, config_snapshot={}, prompts_snapshot={}
    )
    mirror = MemoryMirror()
    sync = MirrorSync(store, mirror)
    assert await sync.sync("r-1") == 3
    assert await sync.sync("r-1") == 0
    store.update_run("r-1", status="paused")
    assert await sync.sync("r-1") == 1


async def test_restore_rejects_a_corrupt_copy(tmp_path: Path) -> None:
    mirror = MemoryMirror()
    mirror.files["r-1"] = {"run.json": b"{}"}
    original = mirror.list

    async def bad_list(run_id: str) -> dict[str, str] | None:
        listing = await original(run_id)
        return {k: "0" * 64 for k in listing or {}}

    mirror.list = bad_list  # type: ignore[method-assign]
    with pytest.raises(OSError):
        await MirrorSync(RunStore(tmp_path / "runs"), mirror).restore("r-1")


async def test_restore_skips_paths_outside_the_run(tmp_path: Path) -> None:
    mirror = MemoryMirror()
    mirror.files["r-1"] = {"run.json": b"{}", "../escape.txt": b"x"}
    store = RunStore(tmp_path / "runs")
    assert await MirrorSync(store, mirror).restore("r-1")
    assert not (tmp_path / "runs" / "escape.txt").exists()
    assert store.exists("r-1")


async def test_http_mirror_wire_format() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "GET" and request.url.path.endswith("/files"):
            return httpx.Response(200, json={"files": {"run.json": "ab"}})
        if request.method == "GET":
            return httpx.Response(200, content=b"data")
        return httpx.Response(201)

    mirror = HttpRunMirror("https://w.test/internal/", "k", transport=httpx.MockTransport(handle))
    await mirror.put("r-1", "stage-06/cards/a b.json", b"{}", "ff")
    assert await mirror.list("r-1") == {"run.json": "ab"}
    assert await mirror.get("r-1", "run.json") == b"data"
    put = seen[0]
    assert put.url.raw_path == b"/internal/runs/r-1/files/stage-06/cards/a%20b.json"
    assert put.headers["X-Service-Key"] == "k"
    assert put.headers["X-Content-SHA256"] == "ff"
    assert json.loads(put.content) == {}
    await mirror.aclose()
