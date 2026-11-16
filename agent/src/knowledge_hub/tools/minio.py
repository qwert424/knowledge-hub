"""MinIO access without boto3: minimal S3 SigV4 GET/PUT/HEAD.

Only what the indexer needs: download an object by ``objectKey`` and upload JSON
snapshots. Credentials stay in :class:`EnvSettings`; nothing is logged.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from datetime import UTC, datetime
from urllib.parse import quote, urlsplit

import httpx

from knowledge_hub.config.settings import EnvSettings
from knowledge_hub.errors import LoaderError

logger = logging.getLogger(__name__)

_ALGORITHM = "AWS4-HMAC-SHA256"
_SERVICE = "s3"


def _hash(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def _canonical_uri(bucket: str, key: str) -> str:
    segments = [bucket] + [part for part in key.split("/") if part != ""]
    return "/" + "/".join(quote(part, safe="-_.~") for part in segments)


class S3Client:
    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        *,
        region: str = "us-east-1",
        timeout_s: float = 15.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.endpoint = (endpoint or "").rstrip("/")
        self.access_key = access_key or ""
        self.secret_key = secret_key or ""
        self.region = region or "us-east-1"
        self.timeout_s = timeout_s
        self._transport = transport

    @classmethod
    def from_env(cls, env: EnvSettings, **kwargs: object) -> S3Client:
        return cls(
            env.minio.endpoint,
            env.minio.access_key,
            env.minio.secret_key,
            region=env.minio.region,
            **kwargs,  # type: ignore[arg-type]
        )

    @property
    def configured(self) -> bool:
        return bool(self.endpoint and self.access_key and self.secret_key)

    # ------------------------------------------------------------------ signing
    def _signed_headers(
        self, method: str, bucket: str, key: str, payload_hash: str, extra: dict[str, str] | None = None
    ) -> tuple[str, dict[str, str]]:
        now = datetime.now(UTC)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")
        host = urlsplit(self.endpoint).netloc

        headers: dict[str, str] = {
            "host": host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if extra:
            headers.update({name.lower(): value for name, value in extra.items()})

        canonical_headers = "".join(f"{name}:{headers[name].strip()}\n" for name in sorted(headers))
        signed_headers = ";".join(sorted(headers))
        canonical_request = "\n".join(
            [
                method,
                _canonical_uri(bucket, key),
                "",
                canonical_headers,
                signed_headers,
                payload_hash,
            ]
        )
        scope = f"{datestamp}/{self.region}/{_SERVICE}/aws4_request"
        string_to_sign = "\n".join(
            [_ALGORITHM, amz_date, scope, _hash(canonical_request.encode("utf-8"))]
        )
        signing_key = _sign(
            _sign(_sign(_sign(f"AWS4{self.secret_key}".encode(), datestamp), self.region), _SERVICE),
            "aws4_request",
        )
        signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        authorization = (
            f"{_ALGORITHM} Credential={self.access_key}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        request_headers = {
            "Host": host,
            "x-amz-date": amz_date,
            "x-amz-content-sha256": payload_hash,
            "Authorization": authorization,
        }
        if extra:
            request_headers.update(extra)
        return _canonical_uri(bucket, key), request_headers

    # ---------------------------------------------------------------- operations
    def get_object(self, bucket: str, key: str) -> bytes:
        if not self.configured:
            raise LoaderError("minio is not configured")
        path, headers = self._signed_headers("GET", bucket, key, _hash(b""))
        url = f"{self.endpoint}{path}"
        try:
            with httpx.Client(timeout=self.timeout_s, transport=self._transport) as client:
                resp = client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            raise LoaderError(f"minio download failed: {type(exc).__name__}") from exc
        if resp.status_code == 404:
            raise LoaderError(f"object not found: {bucket}/{key}")
        if resp.status_code != 200:
            raise LoaderError(f"minio download rejected ({resp.status_code})")
        return resp.content

    def put_object(
        self,
        bucket: str,
        key: str,
        data: bytes,
        *,
        content_type: str = "application/octet-stream",
    ) -> None:
        if not self.configured:
            raise LoaderError("minio is not configured")
        payload_hash = _hash(data)
        path, headers = self._signed_headers(
            "PUT", bucket, key, payload_hash, {"content-type": content_type}
        )
        url = f"{self.endpoint}{path}"
        try:
            with httpx.Client(timeout=self.timeout_s, transport=self._transport) as client:
                resp = client.put(url, headers=headers, content=data)
        except httpx.HTTPError as exc:
            raise LoaderError(f"minio upload failed: {type(exc).__name__}") from exc
        if resp.status_code not in (200, 201):
            raise LoaderError(f"minio upload rejected ({resp.status_code})")

    def health(self) -> bool:
        if not self.configured:
            return False
        try:
            with httpx.Client(timeout=self.timeout_s, transport=self._transport) as client:
                return client.get(f"{self.endpoint}/minio/health/live").status_code == 200
        except httpx.HTTPError:
            return False

    def ensure_bucket(self, bucket: str) -> None:
        """Create the bucket when missing (409 = already exists, which is fine)."""
        if not self.configured:
            raise LoaderError("minio is not configured")
        payload_hash = _hash(b"")
        path, headers = self._signed_headers("PUT", bucket, "", payload_hash)
        try:
            with httpx.Client(timeout=self.timeout_s, transport=self._transport) as client:
                resp = client.put(f"{self.endpoint}{path}", headers=headers, content=b"")
        except httpx.HTTPError as exc:
            raise LoaderError(f"minio bucket check failed: {type(exc).__name__}") from exc
        if resp.status_code not in (200, 201, 409):
            raise LoaderError(f"minio bucket create rejected ({resp.status_code})")

    def presign_get(self, bucket: str, key: str, *, expires_s: int = 7 * 24 * 3600) -> str:
        """Query-string SigV4 URL: the artifact opens in a browser without public ACLs."""
        if not self.configured:
            raise LoaderError("minio is not configured")
        now = datetime.now(UTC)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")
        scope = f"{datestamp}/{self.region}/{_SERVICE}/aws4_request"
        host = urlsplit(self.endpoint).netloc
        canonical_uri = _canonical_uri(bucket, key)
        query = {
            "X-Amz-Algorithm": _ALGORITHM,
            "X-Amz-Credential": f"{self.access_key}/{scope}",
            "X-Amz-Date": amz_date,
            "X-Amz-Expires": str(max(60, min(int(expires_s), 604800))),
            "X-Amz-SignedHeaders": "host",
        }
        canonical_query = "&".join(
            f"{quote(name, safe='-_.~')}={quote(value, safe='-_.~')}"
            for name, value in sorted(query.items())
        )
        canonical_request = "\n".join(
            ["GET", canonical_uri, canonical_query, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"]
        )
        string_to_sign = "\n".join(
            [_ALGORITHM, amz_date, scope, _hash(canonical_request.encode("utf-8"))]
        )
        signing_key = _sign(
            _sign(_sign(_sign(f"AWS4{self.secret_key}".encode(), datestamp), self.region), _SERVICE),
            "aws4_request",
        )
        signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        return f"{self.endpoint}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}"


__all__ = ["S3Client"]