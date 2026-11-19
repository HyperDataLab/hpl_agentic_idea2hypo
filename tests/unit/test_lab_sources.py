"""Lab sources, full text and stage 6 cards from full text (all offline: MockTransport)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from idea2hypothesis.literature.fulltext import FullText, GatewayFulltext, Section, parse_tei
from idea2hypothesis.literature.lab import LabGateway, LabUnavailable
from idea2hypothesis.literature.providers.http import ProviderError
from idea2hypothesis.literature.providers.lab_sources import (
    LabKgProvider,
    PaperLabCorpusProvider,
    SciAtlasProvider,
)
from idea2hypothesis.literature.providers.openalex import OpenAlexProvider
from idea2hypothesis.pipeline.runner import run_pipeline
from tests.conftest import make_services, request

WORKER = "https://worker.test/internal"
CORPUS = "00000000-0000-4000-8000-000000000001"

TEI = """<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><profileDesc><abstract>
<p>Short   abstract.</p></abstract></profileDesc></teiHeader><text><body>
<div><head>Methods</head><p>We measured sleep with actigraphy in 120 students.</p></div>
<div><head>Results</head><p>Scores rose by 8.2 points.</p><p>Effect held.</p></div>
<div><p/></div></body></text></TEI>"""


def openalex_work(n: int) -> dict[str, Any]:
    return {
        "id": f"https://openalex.org/W{n}",
        "title": f"OpenAlex work {n}",
        "publication_year": 2020,
        "cited_by_count": n,
        "doi": f"https://doi.org/10.1000/w{n}",
        "ids": {"openalex": f"https://openalex.org/W{n}"},
        "abstract_inverted_index": {"Real": [0], "abstract": [1]},
        "authorships": [],
    }


class Lab:
    """Fake Worker lab routes plus OpenAlex, recording every request."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.pdf_dois = {"10.1000/fixture.0"}

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.url.host == "api.openalex.org":
            flt = request.url.params.get("filter", "")
            values = flt.split(":", 1)[1].split("|") if ":" in flt else []
            nums = [int(v.rsplit("w", 1)[-1].lstrip("W")) for v in values]
            return httpx.Response(200, json={"results": [openalex_work(n) for n in nums]})
        assert request.headers["X-Service-Key"] == "engine-key"
        assert path.startswith("/internal/runs/run-1/lab/")
        route = path.removeprefix("/internal/runs/run-1/lab")
        if route == "/v1/kg/search":
            body = json.loads(request.content)
            assert body["keywords"][0]["level"] == "high" and body["topK"] <= 20
            return httpx.Response(200, json={"papers": [{
                "title": "KG paper", "year": 2019, "citations": 3, "authors": ["A. B"],
                "openalexId": "W9", "doi": "10.1000/kg", "abstract": "KG abstract",
            }]})  # fmt: skip
        if route == "/v1/sciatlas/search":
            return httpx.Response(200, json={"papers": [
                {"title": "SECRET TITLE", "abstract": "SECRET", "openalexId": "W5"},
                {"title": "x", "doi": "10.1000/w6"},
            ]})  # fmt: skip
        if route == f"/corpora/{CORPUS}":
            return httpx.Response(200, json={"corpus": {"members": [
                {"identifiers": {"paperIds": ["m1", "m2", "m1"]}},
                {"identifiers": {"paperIds": ["m3"]}},
            ]}, "version": "v"})  # fmt: skip
        if route.startswith("/v1/papers/"):
            pid = route.split("/")[3]
            meta = {"m1": {"doi": "10.1000/w7"}, "m2": {"title": "No DOI member"}}.get(pid)
            if meta is None:
                return httpx.Response(404, json={"error": "not_found"})
            return httpx.Response(200, json={"document": {"metadata": meta}})
        if route == "/fulltext":
            doi = json.loads(request.content)["doi"]
            if doi in self.pdf_dois:
                return httpx.Response(200, text=TEI)
            return httpx.Response(404, json={"error": "no_pdf"})
        return httpx.Response(503, json={"error": "kg_not_configured"})


async def no_sleep(_: float) -> None:
    return None


def wiring(lab: Lab) -> tuple[LabGateway, OpenAlexProvider]:
    transport = httpx.MockTransport(lab.handle)
    gateway = LabGateway(WORKER, "engine-key", "run-1", transport=transport)
    openalex = OpenAlexProvider(httpx.AsyncClient(transport=transport), sleep=no_sleep)
    return gateway, openalex


async def test_lab_kg_records_are_used() -> None:
    gateway, _ = wiring(Lab())
    papers = await LabKgProvider(gateway).search("sleep and exams", limit=50, year_min=2015)
    assert [p.title for p in papers] == ["KG paper"]
    assert papers[0].doi == "10.1000/kg" and papers[0].abstract == "KG abstract"
    assert papers[0].source_records[0].provider == "lab_kg"


async def test_sciatlas_keeps_ids_only() -> None:
    lab = Lab()
    gateway, openalex = wiring(lab)
    papers = await SciAtlasProvider(gateway, openalex).search("q", limit=10)
    assert sorted(p.title for p in papers) == ["OpenAlex work 5", "OpenAlex work 6"]
    assert all("SECRET" not in json.dumps(p.to_dict()) for p in papers)
    assert all({r.provider for r in p.source_records} == {"openalex", "sciatlas"} for p in papers)


async def test_corpus_is_returned_once() -> None:
    gateway, openalex = wiring(Lab())
    provider = PaperLabCorpusProvider(gateway, CORPUS, openalex)
    first = await provider.search("q1", limit=20)
    assert sorted(p.title for p in first) == ["No DOI member", "OpenAlex work 7"]
    assert await provider.search("q2", limit=20) == []


async def test_lab_errors_are_provider_errors() -> None:
    gateway = LabGateway(
        WORKER, "engine-key", "run-1",
        transport=httpx.MockTransport(lambda r: httpx.Response(401, json={"error": "token"})),
    )  # fmt: skip
    with pytest.raises(LabUnavailable) as info:
        await LabKgProvider(gateway).search("q", limit=5)
    assert isinstance(info.value, ProviderError)
    assert "401" in str(info.value)


def test_parse_tei() -> None:
    text = parse_tei(TEI)
    assert text.abstract == "Short abstract."
    assert text.sections == (
        Section("Methods", "We measured sleep with actigraphy in 120 students."),
        Section("Results", "Scores rose by 8.2 points.\nEffect held."),
    )
    assert text.excerpt(60) == [
        {"heading": "Methods", "text": "We measured sleep with actigraphy in 120 students."},
        {"heading": "Results", "text": "Scores ros"},
    ]


async def test_fulltext_missing_pdf_is_none() -> None:
    gateway, _ = wiring(Lab())
    port = GatewayFulltext(gateway)
    assert isinstance(await port.fetch("10.1000/fixture.0"), FullText)
    assert await port.fetch("10.1000/none") is None


async def test_stage6_uses_full_text_when_the_lab_has_the_pdf(tmp_path: Path) -> None:
    gateway, _ = wiring(Lab())
    services = make_services(tmp_path, review={"mode": "auto"})
    services.fulltext = GatewayFulltext(gateway)
    result = await run_pipeline(request(), services)
    assert result.status.value == "completed"
    art = services.store.artifacts(result.run_id)
    meta = art.read_json(6, "knowledge_meta.json")
    names = [n for n in art.list_files(6) if n.startswith("cards/") and n.endswith(".json")]
    cards = [art.read_json(6, n) for n in names]
    scopes = {c["doi"]: c["evidence_scope"] for c in cards}
    if "10.1000/fixture.0" in scopes:
        assert scopes["10.1000/fixture.0"] == "full_text"
        assert meta["full_text_cards"] == 1
        assert meta["evidence_scope"] == "full_text"
    assert all(s == "abstract" for d, s in scopes.items() if d != "10.1000/fixture.0")
    assert "10.1000/fixture.0" not in meta["fulltext_missing_dois"]
    assert set(meta["fulltext_missing_dois"]) == {d for d in scopes if d != "10.1000/fixture.0"}
    assert meta["fulltext_errors"] == []
