"""Retrieval ticket verification.

The ticket is issued by the Java backend (``RetrievalTicketService``) and is the
*only* source of ACL truth for the retrieval layer. Claims:

    iss   = knowledge-hub
    sub   = userId
    tid   = tenantId
    scope = ticket
    principals = ["user:...", "role:...", "group:...", "dept:...", "tenant:all"]
    kb_ids = ["<uuid>", ...]
    exp / iat

RS256 is used when ``JWT_PUBLIC_KEY_PATH`` points at a readable PEM key, otherwise
HS256 with ``JWT_SECRET`` (mirrors the Java ``JwtService`` fallback).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import jwt

from knowledge_hub.config.settings import EnvSettings
from knowledge_hub.errors import TenantMismatch, TicketError, TicketScopeError

_TICKET_SCOPE = "ticket"
_MAX_PRINCIPALS = 256
_MAX_PRINCIPAL_LEN = 128


@dataclass(frozen=True, slots=True)
class RetrievalTicket:
    """Verified ticket claims. Nothing here comes from the request body."""

    tenant_id: str
    user_id: str
    principals: tuple[str, ...]
    kb_ids: tuple[str, ...]
    roles: tuple[str, ...] = ()
    username: str = ""
    expires_at: int | None = None
    issued_at: int | None = None
    raw_claims: dict[str, Any] = field(default_factory=dict, repr=False)

    def effective_kb_ids(self, requested: Sequence[str] | None) -> tuple[str, ...]:
        """Request may only narrow the ticket's KB set (intersection, never widen)."""
        allowed = self.kb_ids
        if not requested:
            return allowed
        allowed_set = set(allowed)
        return tuple(kb for kb in requested if kb in allowed_set)


def _as_str_list(
    raw: Any, *, limit: int = _MAX_PRINCIPALS, max_len: int = _MAX_PRINCIPAL_LEN
) -> tuple[str, ...]:
    if raw is None:
        return ()
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, Iterable):
        return ()
    out: list[str] = []
    for item in raw:
        if item is None:
            continue
        text = str(item).strip()
        if not text or len(text) > max_len:
            continue
        out.append(text)
        if len(out) >= limit:
            break
    return tuple(out)


class TicketVerifier:
    """Single verification code path; used by retrieve, chat and graph routes."""

    def __init__(
        self,
        *,
        secret: str = "",
        public_key_path: str = "",
        issuer: str = "knowledge-hub",
        algorithms: Sequence[str] | None = None,
        leeway: int = 0,
    ) -> None:
        self.issuer = issuer or "knowledge-hub"
        self.leeway = leeway
        self._key, self._algorithms = self._resolve_key(secret, public_key_path)
        if algorithms:
            self._algorithms = tuple(algorithms)

    @staticmethod
    def _resolve_key(secret: str, public_key_path: str) -> tuple[Any, tuple[str, ...]]:
        if public_key_path:
            path = Path(public_key_path)
            try:
                pem = path.read_text(encoding="utf-8")
            except OSError:
                pem = ""
            if "BEGIN" in pem:
                return pem, ("RS256",)
        if not secret:
            # Never silently accept unsigned tokens: fail closed on verification.
            return "", ("HS256",)
        return secret, ("HS256",)

    @classmethod
    def from_env(cls, env: EnvSettings) -> TicketVerifier:
        return cls(
            secret=env.server.jwt_secret,
            public_key_path=env.server.jwt_public_key_path,
            issuer=env.server.jwt_issuer,
        )

    @property
    def algorithms(self) -> tuple[str, ...]:
        return self._algorithms

    def verify(
        self,
        token: str | None,
        *,
        expected_tenant: str | None = None,
    ) -> RetrievalTicket:
        if not token or not isinstance(token, str):
            raise TicketError("missing retrieval ticket")
        if not self._key:
            raise TicketError("retrieval ticket verification is not configured")
        try:
            claims = jwt.decode(
                token,
                self._key,
                algorithms=list(self._algorithms),
                issuer=self.issuer,
                leeway=self.leeway,
                options={"require": ["exp", "iss", "sub"], "verify_aud": False},
            )
        except jwt.ExpiredSignatureError as exc:
            raise TicketError("retrieval ticket expired") from exc
        except jwt.InvalidTokenError as exc:
            raise TicketError("invalid retrieval ticket") from exc

        if str(claims.get("scope", "")) != _TICKET_SCOPE:
            raise TicketScopeError("token is not a retrieval ticket")

        tenant_id = str(claims.get("tid") or "").strip()
        if not tenant_id:
            raise TicketError("retrieval ticket is missing tid")
        if expected_tenant and expected_tenant != tenant_id:
            raise TenantMismatch("tenant mismatch")

        user_id = str(claims.get("sub") or "").strip()
        if not user_id:
            raise TicketError("retrieval ticket is missing sub")

        return RetrievalTicket(
            tenant_id=tenant_id,
            user_id=user_id,
            principals=_as_str_list(claims.get("principals")),
            kb_ids=_as_str_list(claims.get("kb_ids"), max_len=64),
            roles=_as_str_list(claims.get("roles")),
            username=str(claims.get("usr") or ""),
            expires_at=int(claims["exp"]) if "exp" in claims else None,
            issued_at=int(claims["iat"]) if "iat" in claims else None,
            raw_claims=dict(claims),
        )


def verify_ticket(
    token: str | None,
    *,
    env: EnvSettings,
    expected_tenant: str | None = None,
) -> RetrievalTicket:
    """Convenience wrapper using the process-wide env settings."""
    return TicketVerifier.from_env(env).verify(token, expected_tenant=expected_tenant)


__all__ = ["RetrievalTicket", "TicketVerifier", "verify_ticket"]
