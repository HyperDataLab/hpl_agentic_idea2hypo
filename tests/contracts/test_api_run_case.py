"""The researcher's case (intent, context, constraints, references) on POST /runs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tests.fixtures import FixtureLLM
from tests.fixtures.api_helpers import SERVER_KEY, harness


@pytest.fixture(autouse=True)
def _server_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("I2H_SERVICE_KEY", SERVER_KEY)


CASE: dict[str, Any] = {
    "intent": {"kind": "compare", "text": "Compare spaced and massed practice for exams"},
    "context": "Second-year students, one semester.",
    "constraints": ["Only public datasets", "No GPU"],
    "references": [{"citation": "Cepeda et al. 2006, Psychological Bulletin"}],
}


async def test_case_is_accepted_persisted_and_reaches_the_first_stages(tmp_path: Path) -> None:
    llm = FixtureLLM()
    async with harness(tmp_path, llm=llm) as h:
        response = await h.start("p-case", case=CASE)
        assert response.status_code == 201
        run_id = response.json()["popper_run_id"]
        await h.settle()

        record = h.service.store.read_run(run_id)
        assert record["case"]["intent"] == CASE["intent"]
        assert record["case"]["references"] == CASE["references"]
        assert record["constraints"] == ["Only public datasets", "No GPU"]
        snapshot = json.loads(
            h.service.store.run_dir(run_id).joinpath("config.snapshot.json").read_text("utf-8")
        )
        assert snapshot["run"]["case"]["context"] == CASE["context"]

    for key in ("topic_init", "problem_decompose"):
        prompt = next(c for c in llm.calls if c.key == key)
        assert "Intent (compare approaches): Compare spaced and massed practice" in prompt.user
        assert "Cepeda et al. 2006" in prompt.user
        assert key == "problem_decompose" or "Only public datasets" in prompt.user


async def test_runs_without_a_case_are_unchanged(tmp_path: Path) -> None:
    llm = FixtureLLM()
    async with harness(tmp_path, llm=llm) as h:
        run_id = (await h.start("p-nocase")).json()["popper_run_id"]
        await h.settle()
        assert h.service.store.read_run(run_id)["case"] is None
    assert all("Researcher's case" not in c.user for c in llm.calls)


@pytest.mark.parametrize(
    "bad",
    [
        {"intent": {"kind": "guess", "text": "x" * 20}},
        {"intent": {"kind": "test", "text": "too short"}},
        {"intent": {"kind": "test", "text": "x" * 501}},
        {**CASE, "context": "c" * 4001},
        {**CASE, "constraints": ["c"] * 21},
        {**CASE, "constraints": ["c" * 501]},
        {**CASE, "references": [{"citation": "ab"}]},
        {**CASE, "references": [{"citation": "abc"}] * 31},
        {"context": "no intent"},
    ],
)
async def test_bad_case_is_rejected(tmp_path: Path, bad: dict[str, Any]) -> None:
    async with harness(tmp_path) as h:
        assert (await h.start("p-bad", case=bad)).status_code == 422
        assert h.service.store.list_run_ids() == []
