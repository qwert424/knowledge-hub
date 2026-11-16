"""The single ACL filter code path.

``build_filter`` is the only place a Milvus boolean expression is assembled.
Values can never come from the request body or from a model: they come from the
signed ticket (tenant, principals) plus the ticket-intersected kb_ids. Anything
that is not a plain identifier raises instead of being escaped, so an injection
attempt can never widen or alter the predicate.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from knowledge_hub.errors import FilterError, PermissionDenied
from knowledge_hub.security.tickets import RetrievalTicket

_IDENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,127}$")
_TAG = re.compile(r"^[\w\u4e00-\u9fff][\w\u4e00-\u9fff:.\-]{0,63}$")
_STATUS_VALUES = {"active", "staging", "archived"}


def _quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def sanitize_tag(value: str) -> str:
    """Tags are user-authored labels, so only letters/digits/CJK plus a few separators."""
    text = (value or "").strip()
    if not _TAG.match(text):
        raise FilterError("illegal tag value")
    return text


def sanitize_ident(value: str, field: str) -> str:
    text = (value or "").strip()
    if not _IDENT.match(text):
        raise FilterError(f"illegal value for {field}")
    return text


def build_filter(
    ticket: RetrievalTicket,
    kb_ids: Sequence[str],
    *,
    status: str = "active",
    doc_ids: Sequence[str] | None = None,
    tags: Sequence[str] | None = None,
) -> str:
    """Assemble the mandatory predicate: tenant + kb + status + principal ACL.

    ``tags`` can only narrow the result set (an extra AND clause) — it never
    replaces the ACL clause, so a request can never widen visibility.
    """
    tenant_id = sanitize_ident(ticket.tenant_id, "tenant_id")
    principals = [sanitize_ident(value, "principals") for value in ticket.principals]
    if not principals:
        # No principals means "cannot see anything private"; refuse explicitly so
        # we never emit a predicate without the acl clause.
        raise PermissionDenied("retrieval ticket carries no principals")

    kb_list = [sanitize_ident(kb, "kb_ids") for kb in kb_ids]
    if not kb_list:
        raise FilterError("kb_ids must not be empty")
    if status not in _STATUS_VALUES:
        raise FilterError("illegal status value")

    clauses = [
        f"(tenant_id == {_quote(tenant_id)})",
        "(kb_id in [" + ", ".join(_quote(kb) for kb in kb_list) + "])",
        f"(status == {_quote(status)})",
    ]
    if doc_ids:
        doc_list = [sanitize_ident(doc, "doc_ids") for doc in doc_ids]
        clauses.append("(doc_id in [" + ", ".join(_quote(doc) for doc in doc_list) + "])")
    if tags:
        tag_list = [sanitize_tag(tag) for tag in tags]
        if tag_list:
            clauses.append(
                "(ARRAY_CONTAINS_ANY(tags, [" + ", ".join(_quote(tag) for tag in tag_list) + "]))"
            )
    clauses.append(
        "((visibility == \"public\") or "
        "(ARRAY_CONTAINS_ANY(acl_principals, ["
        + ", ".join(_quote(principal) for principal in principals)
        + "])))"
    )
    return " and ".join(clauses)


def is_visible(metadata: Mapping[str, Any], ticket: RetrievalTicket) -> bool:
    """Defence-in-depth re-check applied to every returned hit."""
    if str(metadata.get("tenant_id", "")) != ticket.tenant_id:
        return False
    if str(metadata.get("status", "active")) != "active":
        return False
    if str(metadata.get("visibility", "")) == "public":
        return True
    principals = set(metadata.get("acl_principals") or ())
    return bool(principals & set(ticket.principals))


def intersect_kb_ids(ticket: RetrievalTicket, requested: Iterable[str] | None) -> tuple[str, ...]:
    return ticket.effective_kb_ids(list(requested) if requested else None)


__all__ = ["build_filter", "intersect_kb_ids", "is_visible", "sanitize_ident", "sanitize_tag"]
