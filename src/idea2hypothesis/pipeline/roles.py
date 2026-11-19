"""Perspective roles of stage 8 and the agent that speaks for each of them.

The prompt domains name their perspectives differently (``prompts/hypothesis_roles.yaml``); the
run studio and per-agent model settings use three agents: the one who proposes (theorist), the
one who asks how it is measured (methodologist) and the one who looks for how it fails (skeptic).
"""

from __future__ import annotations

AGENTS = ("theorist", "methodologist", "skeptic")
#: Agents with their own model setting: the three perspectives plus the debate judge.
MODEL_ROLES = (*AGENTS, "judge")

ML_ROLES = {"innovator": "theorist", "pragmatist": "methodologist", "contrarian": "skeptic"}
ROLE_ACTORS = {
    **ML_ROLES,
    # hep
    "theorist": "theorist",
    "phenomenologist": "methodologist",
    "experimentalist": "skeptic",
    # biology (experimentalist as in hep)
    "model_builder": "theorist",
    "fba_analyst": "methodologist",
}


def agent_for(role: str) -> str | None:
    """The agent of a perspective role, or ``None`` for a role no agent speaks for."""
    return ROLE_ACTORS.get(role.lower())
