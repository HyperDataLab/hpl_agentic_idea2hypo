"""Run-scoped model settings: the person's own key, a model per agent, never persisted."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from idea2hypothesis.config import LLMConfig
from idea2hypothesis.llm.models import LLMConfigError
from idea2hypothesis.llm.run_settings import RunLLMSettings, build_run_llms
from tests.fixtures import FixtureLLM
from tests.fixtures.api_helpers import SERVER_KEY, harness

KEY = "sk-run-scoped-0123456789abcdef"


@pytest.fixture(autouse=True)
def _server_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("I2H_SERVICE_KEY", SERVER_KEY)


class Builder:
    """Records which model each client was built for and the key it was given."""

    def __init__(self) -> None:
        self.built: dict[str, FixtureLLM] = {}
        self.keys: set[str] = set()

    def __call__(self, cfg: LLMConfig, api_key: str) -> FixtureLLM:
        self.keys.add(api_key)
        return self.built.setdefault(cfg.model, FixtureLLM())


def llm_body(**role_models: str) -> dict[str, Any]:
    return {
        "base_url": "https://router.example/v1",
        "api_key": KEY,
        "model": "main-model",
        "role_models": role_models,
    }


def _files(root: Path) -> str:
    return "\n".join(
        p.read_text(encoding="utf-8", errors="replace") for p in root.rglob("*") if p.is_file()
    )


async def test_run_uses_its_own_key_and_a_model_per_agent(tmp_path: Path) -> None:
    builder = Builder()
    async with harness(tmp_path, llm_builder=builder, llm_settings={"debate_rounds": 1}) as h:
        body = llm_body(skeptic="skeptic-model", judge="judge-model")
        response = await h.start("p-1", review_mode="auto", llm=body)
        assert response.status_code == 201, response.text
        await h.settle()
        run_id = response.json()["popper_run_id"]
        assert (await h.state(run_id))["status"] == "completed"

    assert builder.keys == {KEY}
    assert set(builder.built) == {"main-model", "skeptic-model", "judge-model"}
    assert builder.built["skeptic-model"].count("perspective") == 1
    assert builder.built["skeptic-model"].count("debate_rebuttal") == 1
    assert builder.built["main-model"].count("perspective") == 2
    assert builder.built["judge-model"].count("debate_judge") == 1
    assert builder.built["main-model"].count("topic_init") == 1


async def test_key_is_never_written_to_the_run_folder(tmp_path: Path) -> None:
    async with harness(tmp_path, llm_builder=Builder()) as h:
        response = await h.start("p-1", review_mode="auto", llm=llm_body())
        await h.settle()
        run_id = response.json()["popper_run_id"]
        record = h.service.store.read_run(run_id)
    assert record["llm_source"] == "run"
    assert record["llm_models"] == {"default": "main-model"}
    assert KEY not in _files(tmp_path)


async def test_after_a_restart_the_key_must_be_sent_again(tmp_path: Path) -> None:
    builder = Builder()
    async with harness(tmp_path, llm_builder=builder) as h:
        run_id = (await h.start("p-1", llm=llm_body())).json()["popper_run_id"]
        await h.settle()
        assert (await h.state(run_id))["status"] == "awaiting_review"

    async with harness(tmp_path, llm_builder=builder) as h2:
        events = await h2.events(run_id)
        gate_id = next(e for e in reversed(events) if e["type"] == "gate.opened")["payload"][
            "gate_id"
        ]
        refused = await h2.client.post(
            f"/runs/{run_id}/gates/{gate_id}", json={"option_id": "approve"}
        )
        assert refused.status_code == 503
        assert refused.json()["detail"]["code"] == "LLM_KEY_REQUIRED"

        accepted = await h2.client.post(
            f"/runs/{run_id}/gates/{gate_id}", json={"option_id": "approve", "llm": llm_body()}
        )
        assert accepted.status_code == 200, accepted.text
        await h2.settle()
        assert (await h2.state(run_id))["status"] == "completed"


async def test_invalid_endpoint_is_refused(tmp_path: Path) -> None:
    async with harness(tmp_path, llm_builder=Builder()) as h:
        body = {**llm_body(), "base_url": "http://internal.service:8080/v1"}
        response = await h.start("p-1", llm=body)
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "LLM_SETTINGS_INVALID"
        assert h.service.store.list_run_ids() == []


def test_settings_repr_hides_the_key() -> None:
    settings = RunLLMSettings(base_url="https://r.example/v1", api_key=KEY, model="m")
    assert KEY not in repr(settings)


@pytest.mark.parametrize(
    "url",
    ["ftp://r.example", "http://r.example/v1", "https://u:p@r.example", "https://r.example/?k=1"],
)
def test_bad_base_urls(url: str) -> None:
    with pytest.raises(LLMConfigError):
        RunLLMSettings(base_url=url, api_key=KEY, model="m")


def test_one_client_per_distinct_model() -> None:
    builder = Builder()
    settings = RunLLMSettings(
        base_url="http://localhost:20128/v1", api_key=KEY, model="m",
        role_models={"theorist": "m", "methodologist": "x", "skeptic": "x"},
    )  # fmt: skip
    built = build_run_llms(LLMConfig(api_key_env="UNUSED"), settings, builder)
    assert set(builder.built) == {"m", "x"}
    assert set(built.role_llms) == {"methodologist", "skeptic"}
    assert built.reviewer is None
    assert built.config.model == "m"
    assert KEY not in repr(built.config)
