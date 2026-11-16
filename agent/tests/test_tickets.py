"""Retrieval ticket verification: valid / expired / tampered / wrong scope / tenant."""

from __future__ import annotations

import time

import jwt
import pytest

from knowledge_hub.config.settings import EnvSettings
from knowledge_hub.errors import TenantMismatch, TicketError, TicketScopeError
from knowledge_hub.security.tickets import TicketVerifier
from tests.conftest import ISSUER, TEST_SECRET, make_ticket


def test_valid_ticket(env_settings: EnvSettings) -> None:
    verifier = TicketVerifier.from_env(env_settings)
    ticket = verifier.verify(make_ticket(env_settings))
    assert ticket.tenant_id == "t_001"
    assert ticket.user_id == "u_123"
    assert ticket.principals == ("user:u_123", "tenant:all")
    assert ticket.kb_ids == ("kb_001",)


def test_effective_kb_ids_never_widens(env_settings: EnvSettings) -> None:
    ticket = TicketVerifier.from_env(env_settings).verify(
        make_ticket(env_settings, kb_ids=("kb_001", "kb_002"))
    )
    assert ticket.effective_kb_ids(["kb_002", "kb_999"]) == ("kb_002",)
    assert ticket.effective_kb_ids(None) == ("kb_001", "kb_002")
    assert ticket.effective_kb_ids([]) == ("kb_001", "kb_002")


def test_expired_ticket_rejected(env_settings: EnvSettings) -> None:
    verifier = TicketVerifier.from_env(env_settings)
    now = int(time.time())
    expired = jwt.encode(
        {
            "sub": "u_1",
            "tid": "t_001",
            "scope": "ticket",
            "principals": ["user:u_1"],
            "kb_ids": ["kb_001"],
            "iss": ISSUER,
            "iat": now - 600,
            "exp": now - 30,
        },
        TEST_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(TicketError):
        verifier.verify(expired)


def test_tampered_ticket_rejected(env_settings: EnvSettings) -> None:
    verifier = TicketVerifier.from_env(env_settings)
    token = make_ticket(env_settings)
    header, payload, signature = token.split(".")
    forged_payload = payload[:-4] + ("AAAA" if payload[-4:] != "AAAA" else "BBBB")
    with pytest.raises(TicketError):
        verifier.verify(f"{header}.{forged_payload}.{signature}")

    other_secret = make_ticket(env_settings, secret="another-secret-value-1234567890-extra")
    with pytest.raises(TicketError):
        verifier.verify(other_secret)


def test_wrong_scope_rejected(env_settings: EnvSettings) -> None:
    verifier = TicketVerifier.from_env(env_settings)
    with pytest.raises(TicketScopeError):
        verifier.verify(make_ticket(env_settings, scope="internal"))


def test_tenant_mismatch_rejected(env_settings: EnvSettings) -> None:
    verifier = TicketVerifier.from_env(env_settings)
    with pytest.raises(TenantMismatch):
        verifier.verify(make_ticket(env_settings), expected_tenant="t_999")


def test_wrong_issuer_rejected(env_settings: EnvSettings) -> None:
    verifier = TicketVerifier.from_env(env_settings)
    with pytest.raises(TicketError):
        verifier.verify(make_ticket(env_settings, issuer="some-other-service"))


def test_missing_ticket_rejected(env_settings: EnvSettings) -> None:
    verifier = TicketVerifier.from_env(env_settings)
    with pytest.raises(TicketError):
        verifier.verify("")
    with pytest.raises(TicketError):
        verifier.verify(None)


def test_missing_secret_fails_closed(env_settings: EnvSettings) -> None:
    env = env_settings.replace(server__jwt_secret="")
    verifier = TicketVerifier.from_env(env)
    with pytest.raises(TicketError):
        verifier.verify(make_ticket(env_settings))


def test_rs256_ticket(env_settings: EnvSettings, tmp_path) -> None:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    public_path = tmp_path / "jwt-public.pem"
    public_path.write_bytes(public_pem)

    env = env_settings.replace(server__jwt_public_key_path=str(public_path))
    verifier = TicketVerifier.from_env(env)
    assert verifier.algorithms == ("RS256",)

    rs_token = make_ticket(env, algorithm="RS256", key=private_key)
    assert verifier.verify(rs_token).tenant_id == "t_001"

    # An HS256 token must not be accepted while RS256 verification is configured.
    with pytest.raises(TicketError):
        verifier.verify(make_ticket(env_settings))
