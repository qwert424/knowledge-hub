"""Nacos client (3.x API) for the config centre.

Nacos 3 removed the v1/v2 config endpoints (``/v1/cs/configs`` now returns
``404 No endpoint``), so this client speaks the v3 admin API:

======  ==================================================================
login   ``POST /v3/auth/user/login``   form ``username/password``
read    ``GET  /v3/admin/cs/config``   ``dataId`` / ``groupName`` / ``namespaceId``
health  ``GET  /v3/admin/core/state``
======  ==================================================================

A Nacos 2.x server is still supported through a v1 fallback, detected from the
``No endpoint`` signature instead of a configuration flag.

Any failure raises :class:`NacosError`; callers fall back to bundled defaults so
the engine never refuses to start because the config centre is down.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_NO_ENDPOINT = "No endpoint"


class NacosError(RuntimeError):
    """Nacos is unreachable, rejected the credentials, or returned no config."""


class NacosClient:
    def __init__(
        self,
        server: str,
        *,
        username: str = "",
        password: str = "",
        namespace: str = "public",
        timeout_s: float = 1.5,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.server = (server or "").strip()
        self.username = username or ""
        self.password = password or ""
        self.namespace = (namespace or "").strip()
        self.timeout_s = timeout_s
        self._transport = transport
        self._access_token: str | None = None

    # ------------------------------------------------------------------ helpers
    @property
    def base_url(self) -> str:
        base = self.server.rstrip("/")
        if not base:
            raise NacosError("NACOS_SERVER is empty")
        if not base.endswith("/nacos"):
            base = f"{base}/nacos"
        return base

    def _tenant(self) -> str | None:
        # Nacos treats "public" as the default namespace (no tenant parameter).
        if not self.namespace or self.namespace.lower() == "public":
            return None
        return self.namespace

    def namespace_param(self) -> str:
        """``namespaceId`` for v3 calls; ``public`` is passed through explicitly."""
        return self.namespace or "public"

    def tenant_param(self) -> str | None:
        """Public form of the namespace query parameter (``None`` for ``public``)."""
        return self._tenant()

    # -------------------------------------------------------------------- auth
    def _login(self) -> str:
        if not self.username:
            raise NacosError("nacos auth required but NACOS_USERNAME is empty")
        attempts = [
            f"{self.base_url}/v3/auth/user/login",
            f"{self.base_url}/v1/auth/login",
        ]
        last = "unknown error"
        for url in attempts:
            try:
                with httpx.Client(timeout=self.timeout_s, transport=self._transport) as client:
                    resp = client.post(
                        url, data={"username": self.username, "password": self.password}
                    )
            except httpx.HTTPError as exc:  # pragma: no cover - network dependent
                last = f"nacos login failed: {type(exc).__name__}"
                continue
            if resp.status_code != 200:
                last = f"nacos login rejected (status {resp.status_code})"
                continue
            try:
                payload: dict[str, Any] = resp.json()
            except ValueError:
                last = "nacos login response was not JSON"
                continue
            token = payload.get("accessToken") or payload.get("token")
            if not token:
                last = "nacos login response missing accessToken"
                continue
            self._access_token = str(token)
            return self._access_token
        raise NacosError(last)

    def access_token(self) -> str | None:
        """Cached access token, logging in on demand. ``None`` when anonymous."""
        if self._access_token:
            return self._access_token
        if not self.username:
            return None
        try:
            return self._login()
        except NacosError as exc:
            logger.info("nacos login unavailable: %s", exc)
            return None

    # ------------------------------------------------------------------- fetch
    def fetch(self, data_id: str, group: str = "DEFAULT_GROUP") -> str:
        """Return the raw config text, raising :class:`NacosError` on any problem."""
        if not data_id:
            raise NacosError("NACOS_DATA_ID is empty")
        group = group or "DEFAULT_GROUP"

        if self.username and self._access_token is None:
            self.access_token()

        text = self._fetch_v3(data_id, group)
        if text is None:  # auth rejected -> login then retry once
            if not self.username:
                raise NacosError("nacos rejected the request and no credentials are configured")
            self._login()
            text = self._fetch_v3(data_id, group)
        if text is None:
            raise NacosError("nacos config request rejected")
        if not text.strip():
            raise NacosError("nacos returned an empty config body")
        return text

    def _headers(self) -> dict[str, str]:
        return {"accessToken": self._access_token} if self._access_token else {}

    def _fetch_v3(self, data_id: str, group: str) -> str | None:
        """Return the body, ``None`` when auth was rejected; raise when absent."""
        params = {
            "dataId": data_id,
            "groupName": group,
            "namespaceId": self.namespace_param(),
        }
        try:
            with httpx.Client(timeout=self.timeout_s, transport=self._transport) as client:
                resp = client.get(
                    f"{self.base_url}/v3/admin/cs/config", params=params, headers=self._headers()
                )
        except httpx.HTTPError as exc:  # pragma: no cover - network dependent
            raise NacosError(f"nacos unreachable: {type(exc).__name__}") from exc

        if resp.status_code in (401, 403):
            return None
        if resp.status_code == 404:
            if _NO_ENDPOINT in resp.text:
                return self._fetch_v1(data_id, group)  # Nacos 2.x
            raise NacosError(f"nacos config not found (status 404, dataId={data_id})")
        if resp.status_code != 200:
            raise NacosError(f"nacos returned status {resp.status_code}")

        payload = _json_or_none(resp)
        if payload is None:  # Nacos 2.x answers with the raw body
            return resp.text
        data = payload.get("data")
        if isinstance(data, dict):
            content = data.get("content")
            return content if isinstance(content, str) else ""
        if payload.get("code") not in (0, "0", None):
            raise NacosError(f"nacos rejected the read: {payload.get('message')}")
        return resp.text

    def _fetch_v1(self, data_id: str, group: str) -> str | None:
        """Nacos 2.x fallback (``/v1/cs/configs``)."""
        params: dict[str, Any] = {"dataId": data_id, "group": group}
        tenant = self._tenant()
        if tenant:
            params["tenant"] = tenant
        query = dict(params)
        if self._access_token:
            query["accessToken"] = self._access_token
        try:
            with httpx.Client(timeout=self.timeout_s, transport=self._transport) as client:
                resp = client.get(f"{self.base_url}/v1/cs/configs", params=query)
        except httpx.HTTPError as exc:  # pragma: no cover - network dependent
            raise NacosError(f"nacos unreachable: {type(exc).__name__}") from exc
        if resp.status_code in (401, 403):
            return None
        if resp.status_code == 404:
            raise NacosError(f"nacos config not found (status 404, dataId={data_id})")
        if resp.status_code != 200:
            raise NacosError(f"nacos returned status {resp.status_code}")
        return resp.text

    def health(self) -> bool:
        """Cheap liveness probe; credentials are optional."""
        candidates = [
            f"{self.base_url}/v3/admin/core/state",
            f"{self.base_url}/v1/console/health/liveness",
        ]
        for url in candidates:
            try:
                with httpx.Client(timeout=self.timeout_s, transport=self._transport) as client:
                    resp = client.get(url, headers=self._headers())
            except httpx.HTTPError:
                continue
            if resp.status_code == 200:
                return True
        return False


def _json_or_none(resp: httpx.Response) -> dict[str, Any] | None:
    try:
        payload = resp.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


__all__ = ["NacosClient", "NacosError"]
