"""Request and response models of the HTTP adapter (wire contract for Platform BE and Swagger)."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, SecretStr, field_validator

ApiStatus = Literal["running", "paused", "awaiting_review", "completed", "failed"]

# -- engine runs (Platform BE) ------------------------------------------------

ModelRole = Literal["theorist", "methodologist", "skeptic", "judge"]


class LlmSettingsBody(BaseModel):
    """The person's own OpenAI-compatible endpoint for one run; the key is kept in memory only."""

    base_url: str = Field(min_length=8, max_length=500)
    api_key: SecretStr = Field(description="Never stored, logged or returned")
    model: str = Field(min_length=1, max_length=200)
    role_models: dict[ModelRole, str] = Field(
        default_factory=dict, description="Model per agent; unset agents use `model`"
    )


class RunSourcesBody(BaseModel):
    """Lab sources for one run, reached through the Cloudflare Worker (``api.worker_url``)."""

    corpus_id: str | None = Field(
        default=None,
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        description="PaperLab corpus used as a seed set",
    )
    lab_kg: bool = Field(default=False, description="Search the lab knowledge graph")
    sciatlas: bool = Field(default=False, description="Ids from SciAtlas, records from OpenAlex")
    fulltext: bool = Field(
        default=False, description="Read PDFs Paper Fetch Hub stored (GROBID) in stage 6"
    )


IntentKind = Literal["test", "compare", "explain", "explore_dataset"]


class CaseIntent(BaseModel):
    kind: IntentKind
    text: str = Field(min_length=12, max_length=500)

    @field_validator("text")
    @classmethod
    def clean_text(cls, value: str) -> str:
        text = value.strip()
        if not 12 <= len(text) <= 500:
            raise ValueError("Intent text must be 12-500 characters")
        return text


class CaseReference(BaseModel):
    """A citation the researcher gave; plain text, never a literature record."""

    citation: str = Field(min_length=3, max_length=500)

    @field_validator("citation")
    @classmethod
    def clean_citation(cls, value: str) -> str:
        text = value.strip()
        if not 3 <= len(text) <= 500:
            raise ValueError("Citation must be 3-500 characters")
        return text


class RunCase(BaseModel):
    """What the researcher said about the run beyond its topic (optional; holds no secrets)."""

    intent: CaseIntent
    context: str = Field(default="", max_length=4000)
    constraints: list[Annotated[str, Field(max_length=500)]] = Field(
        default_factory=list, max_length=20
    )
    references: list[CaseReference] = Field(default_factory=list, max_length=30)

    @field_validator("context")
    @classmethod
    def clean_context(cls, value: str) -> str:
        return value.strip()

    @field_validator("constraints")
    @classmethod
    def clean_constraints(cls, value: list[str]) -> list[str]:
        return [c.strip() for c in value if c.strip()]


class RunCreateRequest(BaseModel):
    platform_run_id: str = Field(
        min_length=1, max_length=128, description="Run id from Platform BE (idempotency key)"
    )
    topic: str = Field(min_length=12, max_length=1000, description="Research topic")
    domains: list[str] = Field(default_factory=list, max_length=6, description="Academic domains")
    review_mode: Literal["auto", "light", "copilot", "full"] = Field(
        default="copilot", description="Review mode controlling human gates"
    )
    budget_usd: Decimal = Field(default=Decimal("5.00"), gt=0, description="Budget in USD")
    callback_url: str = Field(description="Webhook base URL for event delivery")
    llm: LlmSettingsBody | None = Field(
        default=None, description="Run-scoped model settings; default: the configured model"
    )
    sources: RunSourcesBody | None = Field(default=None, description="Lab sources for this run")
    case: RunCase | None = Field(
        default=None, description="Intent, context, constraints and references given by the user"
    )

    @field_validator("topic")
    @classmethod
    def clean_topic(cls, value: str) -> str:
        text = value.strip()
        if len(text) < 12:
            raise ValueError("Topic must be at least 12 characters")
        return text

    @field_validator("domains")
    @classmethod
    def clean_domains(cls, value: list[str]) -> list[str]:
        return [d.strip() for d in value if d.strip()][:6]


class RunCreateResponse(BaseModel):
    popper_run_id: str
    status: ApiStatus
    cost_usd: str | None = Field(default=None, description="Decimal string; null when unpriced")
    message: str | None = None


class RunStateResponse(BaseModel):
    popper_run_id: str
    status: ApiStatus
    cost_usd: str | None = Field(default=None, description="Decimal string; null when unpriced")
    message: str | None = None
    last_source_seq: int


class GateAnswerRequest(BaseModel):
    option_id: str
    dropped: list[str] = Field(default_factory=list)
    note: str | None = None
    llm: LlmSettingsBody | None = Field(
        default=None, description="Needed when the engine restarted since the run's last start"
    )


class ResumeRequest(BaseModel):
    llm: LlmSettingsBody | None = Field(
        default=None, description="Needed when the engine restarted since the run's last start"
    )


class EventItem(BaseModel):
    source_seq: int
    type: str
    stage_key: str | None = None
    actor: str | None = None
    payload: dict[str, Any]


class EventsBatchResponse(BaseModel):
    events: list[EventItem]


class OkResponse(BaseModel):
    status: str = "ok"
    message: str = ""


# -- stage routes (Swagger / review) -----------------------------------------


class Phase1StartRequest(BaseModel):
    topic: str = Field(description="Research topic")
    domains: list[str] = Field(default_factory=list)
    llm_provider: str | None = Field(
        default=None, description="'bedrock' or 'openai' (default: configured provider)"
    )
    model: str | None = Field(default=None, description="Model id override")
    quality_threshold: float = Field(default=4.0, description="Accepted for compatibility; unused")
    auto_approve: bool = Field(
        default=True, description="true = review mode 'auto', false = 'copilot' (screen gate)"
    )


class Stage1RunRequest(BaseModel):
    topic: str = Field(description="Research topic")
    run_id: str | None = Field(default=None, description="Optional run id; generated otherwise")
    llm_provider: str | None = Field(default=None)
    model: str | None = Field(default=None)


class TextContentUpdate(BaseModel):
    content: str = Field(description="New artifact content (JSON text for JSON artifacts)")
