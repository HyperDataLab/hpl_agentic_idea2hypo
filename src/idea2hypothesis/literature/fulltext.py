"""Full text of shortlisted papers: the PDF Paper Fetch Hub stored, read by GROBID.

The Worker looks the DOI up in the lab's R2 bucket (``papers/{doiKey}.pdf``, written by Paper
Fetch Hub) and returns GROBID's TEI. A DOI the lab has no PDF for is ``None``: stage 6 then reads
the abstract, as before, and lists the DOI so it can be queued in Paper Fetch Hub.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Protocol

from idea2hypothesis.literature.lab import LabGateway

TEI = "{http://www.tei-c.org/ns/1.0}"
#: Characters of body text sent to the model per paper (sections in order, then cut).
MAX_CHARS = 24000


@dataclass(frozen=True)
class Section:
    heading: str
    text: str


@dataclass(frozen=True)
class FullText:
    abstract: str = ""
    sections: tuple[Section, ...] = field(default_factory=tuple)

    def excerpt(self, limit: int = MAX_CHARS) -> list[dict[str, str]]:
        """Sections in reading order until ``limit`` characters; the last one may be cut."""
        out: list[dict[str, str]] = []
        left = limit
        for section in self.sections:
            if left <= 0:
                break
            text = section.text[:left]
            out.append({"heading": section.heading, "text": text})
            left -= len(text)
        return out


class FulltextPort(Protocol):
    async def fetch(self, doi: str) -> FullText | None: ...


def _text(element: ET.Element) -> str:
    return re.sub(r"\s+", " ", "".join(element.itertext())).strip()


def parse_tei(xml: str) -> FullText:
    """Abstract and body sections (``<div>`` with ``<head>`` and ``<p>``) of a GROBID TEI file."""
    root = ET.fromstring(xml)
    abstract = " ".join(_text(p) for p in root.iter(f"{TEI}abstract"))
    sections: list[Section] = []
    for body in root.iter(f"{TEI}body"):
        for div in body.iter(f"{TEI}div"):
            head = div.find(f"{TEI}head")
            paragraphs = [_text(p) for p in div.findall(f"{TEI}p")]
            text = "\n".join(p for p in paragraphs if p)
            if text:
                sections.append(Section(heading=_text(head) if head is not None else "", text=text))
    return FullText(abstract=abstract, sections=tuple(sections))


class GatewayFulltext:
    def __init__(self, gateway: LabGateway) -> None:
        self._gateway = gateway

    async def fetch(self, doi: str) -> FullText | None:
        xml = await self._gateway.post_text("/fulltext", {"doi": doi})
        if not xml:
            return None
        try:
            text = parse_tei(xml)
        except ET.ParseError:
            return None
        return text if text.sections else None
