"""Pure Unicode-aware matching for Telegram mention search.

This module intentionally depends only on the Python standard library so the
matching contract can be tested without importing FastAPI or Telethon.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

MATCH_MODES = frozenset({"contains", "word"})
MAX_INCLUDE_TERMS = 12
MAX_EXCLUDE_TERMS = 30
MAX_EXCLUDE_SOURCES = 50
MAX_ITEM_LENGTH = 80


def fold_text(value: object) -> str:
    """Case-fold, decompose Unicode accents, strip marks and equate ё with е."""
    normalized = unicodedata.normalize("NFKD", str(value or "")).casefold()
    without_marks = "".join(ch for ch in normalized if not unicodedata.category(ch).startswith("M"))
    return without_marks.replace("ё", "е")


def clean_terms(values: Iterable[object] | None, limit: int) -> list[str]:
    """Defensively normalize a server-supplied term list and dedupe folded forms."""
    if values is None or isinstance(values, (str, bytes)):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, str):
            continue
        term = re.sub(r"\s+", " ", raw).strip()
        # Keep accent variants as distinct Telegram queries. The API does not document
        # accent-folding for global search, so `notem` and `nōtem` may discover different posts.
        key = unicodedata.normalize("NFKC", term).casefold()
        if not key or len(term) > MAX_ITEM_LENGTH or key in seen:
            continue
        seen.add(key)
        result.append(term)
        if len(result) >= limit:
            break
    return result


def clean_sources(values: Iterable[object] | None) -> set[str]:
    if values is None or isinstance(values, (str, bytes)):
        return set()
    result: set[str] = set()
    for raw in values:
        if not isinstance(raw, str):
            continue
        source = raw.strip().lstrip("@").casefold()
        if source and len(source) <= MAX_ITEM_LENGTH:
            result.add(source)
        if len(result) >= MAX_EXCLUDE_SOURCES:
            break
    return result


def clean_channel_ids(values: Iterable[object] | None) -> set[int]:
    if values is None or isinstance(values, (str, bytes)):
        return set()
    result: set[int] = set()
    for raw in values:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value:
            result.add(abs(value))
        if len(result) >= MAX_EXCLUDE_SOURCES:
            break
    return result


def _matches_folded(folded_text: str, folded_term: str, mode: str) -> bool:
    if not folded_term:
        return False
    if mode == "contains":
        return folded_term in folded_text
    # Python's \w is Unicode-aware. Flexible whitespace keeps a saved phrase valid
    # when Telegram text contains a newline or repeated spaces between its words.
    phrase = r"\s+".join(re.escape(part) for part in folded_term.split())
    return bool(re.search(rf"(?<!\w){phrase}(?!\w)", folded_text, flags=re.UNICODE))


def first_matching_term(
    text: object,
    include_terms: Iterable[object] | None,
    exclude_terms: Iterable[object] | None = None,
    match_mode: str = "contains",
) -> str | None:
    """Return the first ANY include match unless ANY exclude term matches."""
    mode = match_mode if match_mode in MATCH_MODES else "contains"
    includes = clean_terms(include_terms, MAX_INCLUDE_TERMS)
    excludes = clean_terms(exclude_terms, MAX_EXCLUDE_TERMS)
    folded = fold_text(text)
    if any(_matches_folded(folded, fold_text(term).strip(), mode) for term in excludes):
        return None
    return next(
        (term for term in includes if _matches_folded(folded, fold_text(term).strip(), mode)),
        None,
    )


def source_is_excluded(
    username: object,
    channel_id: object,
    excluded_sources: Iterable[object] | None = None,
    excluded_channel_ids: Iterable[object] | None = None,
) -> bool:
    sources = clean_sources(excluded_sources)
    ids = clean_channel_ids(excluded_channel_ids)
    uname = str(username or "").strip().lstrip("@").casefold()
    try:
        cid = abs(int(channel_id))
    except (TypeError, ValueError):
        cid = 0
    return bool((uname and uname in sources) or (cid and cid in ids) or (cid and str(cid) in sources))
