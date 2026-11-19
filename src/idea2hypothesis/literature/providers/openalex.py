"""OpenAlex works search."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Sequence
from typing import Any

import httpx

from idea2hypothesis.literature.models import (
    Author,
    Paper,
    SourceRecord,
    normalise_doi,
)
from idea2hypothesis.literature.providers.http import (
    ProviderError,
    RateSpacer,
    Sleep,
    request_with_retry,
)

logger = logging.getLogger(__name__)

BASE_URL = "https://api.openalex.org/works"
MAX_PER_REQUEST = 50
_SELECT = (
    "id,title,authorships,publication_year,primary_location,"
    "cited_by_count,doi,ids,abstract_inverted_index,type"
)


class OpenAlexProvider:
    name = "openalex"

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        email: str = "",
        api_key: str = "",
        timeout: float = 30.0,
        max_retries: int = 3,
        min_interval: float = 0.2,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        self._client = client
        self._email = email
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._sleep = sleep
        self._spacer = RateSpacer(min_interval, sleep)

    async def search(self, query: str, *, limit: int, year_min: int = 0) -> list[Paper]:
        params: dict[str, Any] = {
            "search": query,
            "per_page": str(min(limit, MAX_PER_REQUEST)),
            "select": _SELECT,
        }
        if year_min > 0:
            params["filter"] = f"from_publication_date:{year_min}-01-01"
        return await self._works(params)

    async def lookup(
        self, *, openalex_ids: Sequence[str] = (), dois: Sequence[str] = ()
    ) -> list[Paper]:
        """Works by OpenAlex id (``W123``) or DOI, at most 50 of each per request."""
        papers: list[Paper] = []
        short = [i.rsplit("/", 1)[-1] for i in openalex_ids if re.fullmatch(r"(?:.*/)?W\d+", i)]
        clean = [d for d in (normalise_doi(d) for d in dois) if d.startswith("10.")]
        for key, values in (("openalex", short), ("doi", clean)):
            for start in range(0, len(values), MAX_PER_REQUEST):
                chunk = values[start : start + MAX_PER_REQUEST]
                papers += await self._works(
                    {
                        "filter": f"{key}:{'|'.join(chunk)}",
                        "per_page": str(MAX_PER_REQUEST),
                        "select": _SELECT,
                    }
                )
        return papers

    async def _works(self, params: dict[str, Any]) -> list[Paper]:
        if self._email:
            params["mailto"] = self._email
        if self._api_key:
            params["api_key"] = self._api_key
        agent = (
            f"idea2hypothesis/0.1 (mailto:{self._email})" if self._email else "idea2hypothesis/0.1"
        )
        response = await request_with_retry(
            self._client,
            "GET",
            BASE_URL,
            provider=self.name,
            params=params,
            headers={"Accept": "application/json", "User-Agent": agent},
            max_retries=self._max_retries,
            timeout=self._timeout,
            spacer=self._spacer,
            sleep=self._sleep,
        )
        try:
            results = response.json().get("results", [])
        except ValueError as exc:
            raise ProviderError("openalex: invalid JSON response") from exc
        papers: list[Paper] = []
        for item in results if isinstance(results, list) else []:
            try:
                papers.append(parse_work(item))
            except (KeyError, TypeError, ValueError):
                logger.debug("skipping unparsable OpenAlex work %s", item.get("id", "?"))
        return papers


def reconstruct_abstract(inverted_index: dict[str, list[int]] | None) -> str:
    if not inverted_index or not isinstance(inverted_index, dict):
        return ""
    words: list[tuple[int, str]] = []
    for word, positions in inverted_index.items():
        words.extend((pos, word) for pos in positions)
    words.sort(key=lambda item: item[0])
    return " ".join(word for _, word in words)


def parse_work(item: dict[str, Any]) -> Paper:
    title = re.sub(r"\s+", " ", str(item.get("title") or "")).strip()
    authors = tuple(
        Author(
            name=str((a.get("author") or {}).get("display_name") or "Unknown"),
            affiliation=str(((a.get("institutions") or [{}])[0] or {}).get("display_name") or ""),
        )
        for a in item.get("authorships") or []
        if isinstance(a, dict)
    )
    source_info = (item.get("primary_location") or {}).get("source") or {}
    venue = str(source_info.get("display_name") or "").strip()
    if venue and re.match(r"^[a-z]{2,}\.[A-Z]{2}$", venue):
        venue = ""
    doi = normalise_doi(str(item.get("doi") or ""))
    ids = item.get("ids") or {}
    openalex_id = str(ids.get("openalex") or item.get("id") or "").strip()
    arxiv_id = ""
    match = re.search(r"(\d{4}\.\d{4,5})", str(ids.get("arxiv") or ""))
    if match:
        arxiv_id = match.group(1)
    if arxiv_id:
        url = f"https://arxiv.org/abs/{arxiv_id}"
    elif doi:
        url = f"https://doi.org/{doi}"
    else:
        url = openalex_id
    record = SourceRecord(provider="openalex", source_id=openalex_id, url=openalex_id or url)
    return Paper(
        paper_id="",
        title=title,
        authors=authors,
        year=int(item.get("publication_year") or 0),
        abstract=reconstruct_abstract(item.get("abstract_inverted_index")),
        venue=venue,
        citation_count=int(item.get("cited_by_count") or 0),
        doi=doi,
        arxiv_id=arxiv_id,
        url=url,
        source_records=(record,),
    )
