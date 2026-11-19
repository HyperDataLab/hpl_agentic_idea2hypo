"""Lab services reached through the Cloudflare Worker for one run.

The engine never holds a person's sign-in token. It calls the Worker's internal routes under
``{worker_url}/runs/{run_id}/lab`` with the engine key; the Worker forwards an allow-listed request
to the lab's services (PaperLab worker: Lab KG, SciAtlas, corpora, GROBID; the shared R2 bucket of
Paper Fetch Hub) with the newest token of the person following that run.

Routes used (Worker side mirrors this list):

* ``POST /v1/kg/search``           Lab KG search (body as PaperLab's contract)
* ``POST /v1/sciatlas/search``     SciAtlas search; only ids are kept (licence not stated)
* ``GET  /corpora/{id}``           a PaperLab corpus
* ``GET  /v1/papers/{id}/model``   a published PaperLab paper model (metadata only is read)
* ``POST /fulltext``               ``{"doi": ...}`` -> GROBID TEI of the PDF Paper Fetch Hub stored,
                                   404 when the lab has no PDF for that DOI
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from idea2hypothesis.literature.providers.http import ProviderError


class LabUnavailable(ProviderError):
    """The Worker or the service behind it answered with an error (never fatal to a run)."""


class LabGateway:
    def __init__(
        self,
        base_url: str,
        key: str,
        run_id: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 90.0,
    ) -> None:
        self._base = f"{base_url.rstrip('/')}/runs/{quote(run_id, safe='')}/lab"
        self._client = httpx.AsyncClient(
            transport=transport, timeout=timeout, headers={"X-Service-Key": key}
        )

    async def _send(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._client.request(method, f"{self._base}{path}", **kwargs)
        except httpx.HTTPError as exc:
            raise LabUnavailable(f"lab {path}: {type(exc).__name__}") from exc
        return response

    @staticmethod
    def _error(path: str, response: httpx.Response) -> LabUnavailable:
        code = ""
        try:
            body = response.json()
            code = str(body.get("error") or "") if isinstance(body, dict) else ""
        except ValueError:
            pass
        return LabUnavailable(f"lab {path}: HTTP {response.status_code} {code}".strip())

    async def post_json(self, path: str, body: dict[str, Any]) -> Any:
        response = await self._send("POST", path, json=body)
        if response.status_code >= 400:
            raise self._error(path, response)
        return response.json()

    async def get_json(self, path: str) -> Any | None:
        """JSON body, or ``None`` for 404."""
        response = await self._send("GET", path)
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise self._error(path, response)
        return response.json()

    async def post_text(self, path: str, body: dict[str, Any]) -> str | None:
        """Text body, or ``None`` for 404."""
        response = await self._send("POST", path, json=body)
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise self._error(path, response)
        return response.text

    async def aclose(self) -> None:
        await self._client.aclose()
