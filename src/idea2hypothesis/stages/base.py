"""Shared stage helpers: failures, JSON requests with bounded repair, small formatters."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, TypeVar

from idea2hypothesis.llm.models import ChatMessage, LLMPort
from idea2hypothesis.llm.parsing import extract_json_object
from idea2hypothesis.pipeline.contracts import Findings
from idea2hypothesis.pipeline.models import StageContext
from idea2hypothesis.prompts.loader import RenderedPrompt

logger = logging.getLogger(__name__)

Validator = Callable[[dict[str, Any]], Findings]
T = TypeVar("T")


class StageFailure(Exception):
    """A stage cannot produce a valid result; the run stops with this code."""

    def __init__(self, code: str, message: str, warnings: tuple[str, ...] = ()) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.warnings = warnings


def compact_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=1)


def bullet_list(items: tuple[str, ...] | list[str], empty: str = "none") -> str:
    return "; ".join(items) if items else empty


_INTENT_LABELS = {
    "test": "test a claim or hypothesis",
    "compare": "compare approaches",
    "explain": "explain a phenomenon",
    "explore_dataset": "explore a dataset",
}


def case_block(case: dict[str, Any] | None) -> str:
    """The researcher's own case as a labelled prompt block; empty when none was given.

    Everything here is user-given text. References are citations only, not literature records,
    and must not be treated as verified or retrieved evidence.
    """
    if not case:
        return ""
    intent = case.get("intent") or {}
    lines = ["Researcher's case (given by the researcher; use it, do not treat it as verified):"]
    if intent.get("text"):
        kind = _INTENT_LABELS.get(str(intent.get("kind")), str(intent.get("kind", "")))
        lines.append(f"- Intent ({kind}): {intent['text']}")
    if case.get("context"):
        lines.append(f"- Context: {case['context']}")
    refs = [r.get("citation", "") for r in case.get("references") or [] if r.get("citation")]
    if refs:
        lines.append("- References named by the researcher (citations only, not retrieved):")
        lines += [f"  - {c}" for c in refs]
    return "\n".join(lines) + "\n" if len(lines) > 1 else ""


async def request_json(
    ctx: StageContext,
    prompt: RenderedPrompt,
    *,
    label: str,
    validate: Validator | None = None,
    llm: LLMPort | None = None,
    max_tokens: int | None = None,
) -> tuple[dict[str, Any], tuple[str, ...]]:
    """Ask for one JSON object; on a parse or contract failure ask the model to repair it.

    Returns ``(data, warnings)``. At most ``runtime.max_retries`` repair rounds are made; the
    final failure raises :class:`StageFailure` ``LLM_OUTPUT_INVALID`` (nothing is fabricated).
    Provider errors propagate to the runner's bounded stage retry.
    """
    client = llm or ctx.llm
    messages = [ChatMessage.user(prompt.user)]
    rounds = 1 + max(0, ctx.config.runtime.max_retries)
    problems: list[str] = []
    for attempt in range(rounds):
        await ctx.safe_point()
        response = await client.chat(
            messages,
            system=prompt.system or None,
            json_mode=prompt.json_mode,
            max_tokens=max_tokens or prompt.max_tokens,
        )
        try:
            data = extract_json_object(response.text)
        except ValueError as exc:
            problems = [f"the reply was not a valid JSON object ({exc})"]
        else:
            findings = validate(data) if validate else Findings()
            if findings.ok:
                return data, tuple(findings.warnings)
            problems = findings.errors
        logger.warning(
            "%s: invalid model output (attempt %d/%d): %s", label, attempt + 1, rounds, problems
        )
        if attempt + 1 < rounds:
            messages = [
                ChatMessage.user(prompt.user),
                ChatMessage.assistant(response.text),
                ChatMessage.user(
                    "Your previous reply was rejected for these reasons:\n- "
                    + "\n- ".join(problems[:12])
                    + "\nReturn the corrected JSON object only."
                ),
            ]
    raise StageFailure(
        "LLM_OUTPUT_INVALID",
        f"{label}: the model did not return a valid answer after {rounds} attempt(s): "
        + "; ".join(problems[:6]),
    )


async def gather_limited(factories: Sequence[Callable[[], Awaitable[T]]], limit: int) -> list[T]:
    """Run coroutine factories with bounded concurrency, results in input order.

    The first exception cancels the remaining work and is re-raised unchanged.
    """
    semaphore = asyncio.Semaphore(max(1, limit))

    async def run(factory: Callable[[], Awaitable[T]]) -> T:
        async with semaphore:
            return await factory()

    tasks = [asyncio.ensure_future(run(f)) for f in factories]
    try:
        return list(await asyncio.gather(*tasks))
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
