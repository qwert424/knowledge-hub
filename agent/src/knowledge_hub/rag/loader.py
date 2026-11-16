"""Document byte loading: local path (worker pre-download / dev) or MinIO objectKey.

Resolution order (documented contract for the worker):
1. ``local_path`` (absolute path on the worker host) - used by the worker after
   it downloads, and by local development;
2. ``object_key`` that is itself an absolute existing path;
3. ``object_key`` fetched from MinIO (``MINIO_BUCKET``) via SigV4 GET.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from knowledge_hub.config.settings import EnvSettings
from knowledge_hub.errors import LoaderError
from knowledge_hub.tools.minio import S3Client

logger = logging.getLogger(__name__)

MAX_DOCUMENT_BYTES = 64 * 1024 * 1024


@dataclass(slots=True)
class LoadedDocument:
    filename: str
    data: bytes
    source_url: str = ""
    origin: str = "local"


class DocumentLoader:
    def __init__(self, env: EnvSettings, *, s3: S3Client | None = None) -> None:
        self.env = env
        self.s3 = s3 or S3Client.from_env(env)

    def load(
        self,
        *,
        object_key: str = "",
        local_path: str = "",
        filename: str = "",
        job_id: str = "",
    ) -> LoadedDocument:
        object_key = (object_key or "").strip()
        local_path = (local_path or "").strip()

        if local_path:
            return self._read_local(local_path, filename)
        if object_key and _looks_like_path(object_key):
            path = Path(object_key)
            if path.is_file():
                return self._read_local(object_key, filename)
        if object_key:
            return self._read_minio(object_key, filename)
        raise LoaderError(f"job {job_id}: neither local_path nor object_key was provided")

    # ---------------------------------------------------------------- internals
    def _read_local(self, path_text: str, filename: str) -> LoadedDocument:
        path = Path(path_text)
        try:
            if not path.is_file():
                raise LoaderError(f"local file not found: {path.name}")
            size = path.stat().st_size
            if size > MAX_DOCUMENT_BYTES:
                raise LoaderError(f"document too large: {size} bytes")
            data = path.read_bytes()
        except OSError as exc:
            raise LoaderError(f"local file unreadable: {path.name}") from exc
        return LoadedDocument(
            filename=filename or path.name,
            data=data,
            source_url=path.as_uri(),
            origin="local",
        )

    def _read_minio(self, object_key: str, filename: str) -> LoadedDocument:
        if not self.s3.configured:
            raise LoaderError("minio is not configured and no local_path was provided")
        bucket = self.env.minio.bucket
        data = self.s3.get_object(bucket, object_key)
        if len(data) > MAX_DOCUMENT_BYTES:
            raise LoaderError(f"document too large: {len(data)} bytes")
        name = filename or PurePosixPath(object_key).name
        return LoadedDocument(
            filename=name,
            data=data,
            source_url=f"minio://{bucket}/{object_key}",
            origin="minio",
        )


def _looks_like_path(value: str) -> bool:
    return value.startswith(("/", "\\")) or (len(value) > 2 and value[1] == ":")


__all__ = ["DocumentLoader", "LoadedDocument", "MAX_DOCUMENT_BYTES"]
