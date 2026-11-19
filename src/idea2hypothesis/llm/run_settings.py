"""LLM settings supplied by the person who starts a run (key typed in the UI, not configured).

The key lives only in memory: it is never part of :class:`~idea2hypothesis.config.LLMConfig`,
so ``Config.snapshot()``, ``run.json`` and the events cannot carry it. ``repr`` hides it.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from idea2hypothesis.config import LLMConfig
from idea2hypothesis.llm.factory import build_llm
from idea2hypothesis.llm.models import LLMConfigError, LLMPort
from idea2hypothesis.pipeline.roles import AGENTS

#: Builds one client from a key-free configuration and the run's key.
LLMBuilder = Callable[[LLMConfig, str], LLMPort]


def default_builder(cfg: LLMConfig, api_key: str) -> LLMPort:
    return build_llm(cfg, api_key=api_key)


@dataclass(frozen=True)
class RunLLMSettings:
    base_url: str
    api_key: str = field(repr=False)
    model: str
    #: Model per agent (``theorist``, ``methodologist``, ``skeptic``, ``judge``); unset = ``model``.
    role_models: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.api_key.strip():
            raise LLMConfigError("llm.api_key is empty")
        if not self.model.strip():
            raise LLMConfigError("llm.model is empty")
        parts = urlsplit(self.base_url)
        local = parts.hostname in ("localhost", "127.0.0.1")
        if (
            parts.scheme not in ("https", "http")
            or (parts.scheme == "http" and not local)
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
        ):
            raise LLMConfigError("llm.base_url must be an https URL without credentials or query")


@dataclass
class RunLLMs:
    """Clients for one run, and the key-free configuration that describes them."""

    config: LLMConfig
    llm: LLMPort
    reviewer: LLMPort | None
    role_llms: dict[str, LLMPort]


def build_run_llms(
    base: LLMConfig, settings: RunLLMSettings, builder: LLMBuilder = default_builder
) -> RunLLMs:
    """Main, judge and per-agent clients for ``settings``; one client per distinct model."""
    cfg = dataclasses.replace(
        base, provider="openai_compatible", base_url=settings.base_url, model=settings.model,
        fallback_models=(), reviewer=None,
    )  # fmt: skip
    clients: dict[str, LLMPort] = {}

    def client(model: str) -> LLMPort:
        if model not in clients:
            clients[model] = builder(dataclasses.replace(cfg, model=model), settings.api_key)
        return clients[model]

    main = client(settings.model)
    role_llms = {
        agent: client(model)
        for agent in AGENTS
        if (model := (settings.role_models.get(agent) or "").strip()) and model != settings.model
    }
    judge_model = (settings.role_models.get("judge") or "").strip()
    reviewer = client(judge_model) if judge_model and judge_model != settings.model else None
    if reviewer is not None:
        cfg = dataclasses.replace(cfg, reviewer=dataclasses.replace(cfg, model=judge_model))
    return RunLLMs(config=cfg, llm=main, reviewer=reviewer, role_llms=role_llms)
