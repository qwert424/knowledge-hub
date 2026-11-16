"""MinIO / S3 对象读取（SigV4 签名，不额外引入 SDK）。

索引时要把图片取回来交给多模态模型，而图片只存在对象存储里。
这里只做一件事：给 ``bucket/key`` 生成一个短期可用的预签名 GET URL，
再交给 httpx 下载。不缓存、不列桶，避免把对象存储的语义带进 RAG 层。
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime
from urllib.parse import quote, urlparse

import httpx

from knowledge_hub.config.minio_settings import MinioSettings


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def presigned_get(
    settings: MinioSettings,
    bucket: str,
    key: str,
    *,
    expires: int = 600,
    for_browser: bool = True,
) -> str:
    """生成预签名 GET URL（SigV4，query 形式签名）。"""
    # 签名包含 Host：给浏览器用的链接必须按浏览器可访问的域名签，
    # 容器内部下载（图注）则用内网地址签，否则两边总有一边拿不到文件。
    endpoint = (settings.browser_endpoint if for_browser else settings.endpoint).rstrip("/")
    parsed = urlparse(endpoint)
    host = parsed.netloc or parsed.path
    scheme = parsed.scheme or "http"
    region = settings.region or "us-east-1"
    now = datetime.now(UTC)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    scope = f"{date_stamp}/{region}/s3/aws4_request"
    credential = f"{settings.access_key}/{scope}"

    object_path = f"/{bucket.strip('/')}/{quote(key.lstrip('/'), safe='/~')}"
    query = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": credential,
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(max(60, min(expires, 604800))),
        "X-Amz-SignedHeaders": "host",
    }
    canonical_query = "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in sorted(query.items()))
    canonical_request = "\n".join([
        "GET",
        object_path,
        canonical_query,
        f"host:{host}\n",
        "host",
        "UNSIGNED-PAYLOAD",
    ])
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])
    key_bytes = _sign(f"AWS4{settings.secret_key}".encode(), date_stamp)
    key_bytes = _sign(key_bytes, region)
    key_bytes = _sign(key_bytes, "s3")
    key_bytes = _sign(key_bytes, "aws4_request")
    signature = hmac.new(key_bytes, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{scheme}://{host}{object_path}?{canonical_query}&X-Amz-Signature={signature}"


async def fetch_object(settings: MinioSettings, bucket: str, key: str, *, timeout_s: float = 20.0) -> bytes:
    """下载对象字节；失败抛 RuntimeError（调用方决定是否降级成占位文本）。"""
    if not settings.configured:
        raise RuntimeError("object storage not configured")
    url = presigned_get(settings, bucket, key, for_browser=False)
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        response = await client.get(url)
        if response.status_code >= 400:
            raise RuntimeError(f"object fetch rejected ({response.status_code})")
        return response.content


__all__ = ["fetch_object", "presigned_get"]

def object_exists(settings: MinioSettings, bucket: str, key: str, *, timeout_s: float = 3.0) -> bool:
    """用 HEAD 判断对象是否存在（不下载正文）。"""
    # 容器内部发起的检查，必须用内网地址签
    url = presigned_get(settings, bucket, key, expires=120, for_browser=False)
    try:
        # 用 Range GET 而不是 HEAD：预签名签的是 GET，HEAD 在部分部署下会被拒。
        with httpx.Client(timeout=timeout_s) as client:
            response = client.get(url, headers={"Range": "bytes=0-0"})
        return response.status_code in (200, 206)
    except httpx.HTTPError:
        return False
