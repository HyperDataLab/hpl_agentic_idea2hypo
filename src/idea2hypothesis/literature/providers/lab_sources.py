"""Literature sources of the lab, reached through the run's :class:`LabGateway`.

* ``lab_kg``: the lab knowledge graph (OpenAlex works the lab ingested). Its records are the lab's
  own copy of OpenAlex data and are used as they are.
* ``sciatlas``: SciAtlas (OpenKG). Its data licence is not stated, so, as in PaperLab, only the
  DOIs and OpenAlex ids of an answer are kept; titles, abstracts and the rest come from OpenAlex.
* ``paperlab_corpus``: a corpus built in PaperLab, the person's chosen seed set. Its published
  paper models give DOIs, which are looked up in OpenAlex. The whole corpus is returned once, for
  the first query; later queries add nothing (duplicates would be merged anyway).
"""

from __future__ import annotations

import dataclasses
import re
from typing import Any

from idea2hypothesis.literature.lab import LabGateway, LabUnavailable
from idea2hypothesis.literature.models import Author, Paper, SourceRecord, normalise_doi
from idea2hypothesis.literature.providers.http import ProviderError
from idea2hypothesis.literature.providers.openalex import OpenAlexProvider

TOP_K_MAX = 20
#: Published paper models read from one corpus at most (one request each).
CORPUS_MAX_MODELS = 200


def anchor_request(query: str, limit: int, year_min: int) -> dict[str, Any]:
    """PaperLab's search body (Lab KG and SciAtlas share it) for one free-text query."""
    body: dict[str, Any] = {
        "query": query,
        "keywords": [{"text": query[:200], "level": "high"}],
        "topK": max(1, min(limit, TOP_K_MAX)),
        "mode": "hybrid",
        "ranking": "balanced",
    }
    if year_min > 0:
        body["after"] = f"{year_min}-01-01"
    return body


def _papers(answer: Any) -> list[dict[str, Any]]:
    papers = answer.get("papers") if isinstance(answer, dict) else None
    return [p for p in papers or [] if isinstance(p, dict)]


class LabKgProvider:
    name = "lab_kg"

    def __init__(self, gateway: LabGateway) -> None:
        self._gateway = gateway

    async def search(self, query: str, *, limit: int, year_min: int = 0) -> list[Paper]:
        answer = await self._gateway.post_json(
            "/v1/kg/search", anchor_request(query, limit, year_min)
        )
        out: list[Paper] = []
        for item in _papers(answer):
            title = re.sub(r"\s+", " ", str(item.get("title") or "")).strip()
            if not title:
                continue
            short = str(item.get("openalexId") or item.get("id") or "").rsplit("/", 1)[-1]
            doi = normalise_doi(str(item.get("doi") or ""))
            url = f"https://doi.org/{doi}" if doi else f"https://openalex.org/{short}"
            out.append(
                Paper(
                    paper_id="",
                    title=title,
                    authors=tuple(Author(name=str(a)) for a in item.get("authors") or [] if a),
                    year=int(item.get("year") or 0),
                    abstract=str(item.get("abstract") or ""),
                    venue=str(item.get("venue") or ""),
                    citation_count=int(item.get("citations") or 0),
                    doi=doi,
                    url=url,
                    source_records=(SourceRecord(provider=self.name, source_id=short, url=url),),
                )
            )
        return out


class SciAtlasProvider:
    name = "sciatlas"

    def __init__(self, gateway: LabGateway, openalex: OpenAlexProvider) -> None:
        self._gateway = gateway
        self._openalex = openalex

    async def search(self, query: str, *, limit: int, year_min: int = 0) -> list[Paper]:
        answer = await self._gateway.post_json(
            "/v1/sciatlas/search", anchor_request(query, limit, year_min)
        )
        ids: list[str] = []
        dois: list[str] = []
        for item in _papers(answer):  # ids only: nothing else of a SciAtlas record is kept
            short = str(item.get("openalexId") or "").rsplit("/", 1)[-1]
            if re.fullmatch(r"W\d+", short):
                ids.append(short)
            elif item.get("doi"):
                dois.append(str(item["doi"]))
        if not ids and not dois:
            return []
        return [
            _via(p, self.name) for p in await self._openalex.lookup(openalex_ids=ids, dois=dois)
        ]


class PaperLabCorpusProvider:
    name = "paperlab_corpus"

    def __init__(self, gateway: LabGateway, corpus_id: str, openalex: OpenAlexProvider) -> None:
        self._gateway = gateway
        self._corpus_id = corpus_id
        self._openalex = openalex
        self._done = False

    async def search(self, query: str, *, limit: int, year_min: int = 0) -> list[Paper]:
        if self._done:
            return []
        corpus = await self._gateway.get_json(f"/corpora/{self._corpus_id}")
        if corpus is None:
            raise ProviderError(f"paperlab_corpus: corpus {self._corpus_id} not found")
        body = corpus.get("corpus", corpus) if isinstance(corpus, dict) else {}
        paper_ids: list[str] = []
        for member in body.get("members") or []:
            identifiers = member.get("identifiers") if isinstance(member, dict) else None
            for pid in (identifiers or {}).get("paperIds") or []:
                if isinstance(pid, str) and pid not in paper_ids:
                    paper_ids.append(pid)
        dois: list[str] = []
        titles: list[str] = []
        for pid in paper_ids[:CORPUS_MAX_MODELS]:
            try:
                model = await self._gateway.get_json(f"/v1/papers/{pid}/model")
            except LabUnavailable:
                continue
            metadata = ((model or {}).get("document") or {}).get("metadata") or {}
            doi = normalise_doi(str(metadata.get("doi") or ""))
            if doi:
                dois.append(doi)
            elif metadata.get("title"):
                titles.append(str(metadata["title"]))
        self._done = True
        found = [_via(p, self.name) for p in await self._openalex.lookup(dois=dois)] if dois else []
        # A member without DOI is kept by title only; screening judges it like any other record.
        found += [
            Paper(
                paper_id="",
                title=t,
                source_records=(SourceRecord(provider=self.name, source_id=t[:80]),),
            )
            for t in titles
        ]
        return found


def _via(paper: Paper, source: str) -> Paper:
    """An OpenAlex record found through another source: that source is recorded too."""
    record = SourceRecord(provider=source, source_id=paper.doi or paper.url, url=paper.url)
    return dataclasses.replace(paper, source_records=(*paper.source_records, record))
