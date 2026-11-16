"""图片理解：把「[图片] 章节名」换成可检索的图注。

按 rag_config 的 ``image_parser`` 配置干活：
1. 从对象存储按 ``payload.bucket_name/bucket_filename`` 取图；
2. 取图片所在标题路径 + 前后各 ``sibling_count`` 段正文（遇到图片跳过，不把别的图当上下文）；
3. 把这段上下文和图片一起交给多模态模型（``vl_model_config.name``），用
   ``image_parser_prompt`` 那段提示词生成描述；
4. 描述写回 block.text，索引时就和正文一样被切分、被向量化、被检索到。

取图失败或模型不可用一律降级为原来的占位文本，绝不让一篇文档因为图片挂掉。
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Sequence
from typing import Any

from knowledge_hub.rag.cir import Block
from knowledge_hub.rag.objectstore import fetch_object

logger = logging.getLogger(__name__)

FALLBACK_PROMPT = (
    "你是文档图片解析器。给你一张文档里的图片，以及它所在章节的标题路径和前后文。\n"
    "请用中文写一段 80~200 字的图注，要求：\n"
    "1. 只描述图片里能看到的内容（类型、结构、组件、标签、数字、界面元素等），不要编造；\n"
    "2. 结合章节标题与前后文说明它想表达什么，让读者不看图也能理解这段内容；\n"
    "3. 如果图片是照片、示意图、截图或表格图片，第一句先说清类型；\n"
    "4. 直接输出图注正文，不要标题、不要「这张图片」这类废话。"
)

MAX_IMAGE_BYTES = 6 * 1024 * 1024


def _mime_for(key: str) -> str:
    lowered = key.lower()
    if lowered.endswith(".png"):
        return "image/png"
    if lowered.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if lowered.endswith(".webp"):
        return "image/webp"
    if lowered.endswith(".gif"):
        return "image/gif"
    return "image/png"


def _siblings(blocks: Sequence[Block], index: int, count: int) -> list[str]:
    """图片前后各取 count 段正文；图片块跳过（它自己没文字，不能拿来当上下文）。"""
    picked: list[str] = []
    cursor = index - 1
    while cursor >= 0 and len(picked) < count:
        block = blocks[cursor]
        if block.kind != "image" and (block.text or "").strip():
            picked.append(block.text.strip()[:400])
        cursor -= 1
    before = list(reversed(picked))
    picked = []
    cursor = index + 1
    while cursor < len(blocks) and len(picked) < count:
        block = blocks[cursor]
        if block.kind != "image" and (block.text or "").strip():
            picked.append(block.text.strip()[:400])
        cursor += 1
    return before + picked


def _context_text(block: Block, siblings: Sequence[str]) -> str:
    title = " > ".join(block.title_path) if block.title_path else "(无标题)"
    lines = [f"章节标题路径：{title}"]
    if siblings:
        lines.append("前后文：")
        lines.extend(f"- {text}" for text in siblings)
    else:
        lines.append("前后文：(无)")
    return "\n".join(lines)


def candidate_objects(
    payload: dict[str, Any],
    *,
    bucket_default: str,
    fallback_bucket: str,
    tenant_id: str,
    document_id: str,
) -> list[tuple[str, str]]:
    """"图片在哪个桶/哪个 key" 的候选清单。

    新导入的文档 payload 里就有 bucket_name/bucket_filename；
    老文档只存了飞书 token，但引擎侧归档上传时用的是
    ``feishu-images/{tenant}/feishu-images/{doc}/{token}.png`` 这个固定 key，
    所以按它推一次，老数据也能补上图注。
    """
    candidates: list[tuple[str, str]] = []
    bucket = str(payload.get("bucket_name") or "").strip()
    filename = str(payload.get("bucket_filename") or "").strip()
    if bucket and filename:
        candidates.append((bucket, filename))
    token = str(payload.get("token") or "").strip()
    if token and document_id:
        tenant = tenant_id or "default"
        candidates.append((bucket_default, f"{tenant}/feishu-images/{document_id}/{token}.png"))
        legacy_key = f"feishu-images/{tenant}/feishu-images/{document_id}/{token}.png"
        candidates.append((fallback_bucket, legacy_key))
        candidates.append((bucket_default, f"{document_id}/{token}.png"))
    return candidates


async def caption_images(
    blocks: Sequence[Block],
    *,
    llm: Any,
    minio: Any,
    model: str,
    prompt: str = "",
    sibling_count: int = 3,
    bucket_default: str = "feishu-images",
    fallback_bucket: str = "knowledge-hub",
    tenant_id: str = "",
    document_id: str = "",
) -> int:
    """就地给图片块补图注，返回成功补了几张。"""
    system_prompt = (prompt or "").strip() or FALLBACK_PROMPT
    captioned = 0
    for index, block in enumerate(blocks):
        if block.kind != "image":
            continue
        payload = block.payload or {}
        candidates = candidate_objects(
            payload,
            bucket_default=bucket_default,
            fallback_bucket=fallback_bucket,
            tenant_id=tenant_id,
            document_id=document_id,
        )
        if not candidates:
            continue
        data: bytes | None = None
        key = ""
        for bucket, candidate in candidates:
            try:
                data = await fetch_object(minio, bucket, candidate)
                key = candidate
                break
            except Exception as exc:  # noqa: BLE001 - 取不到就试下一个候选
                logger.debug("image %s/%s not usable: %s", bucket, candidate, exc)
        if not data:
            logger.info("image for block %s not found in object storage, keeping placeholder", block.block_id)
            continue
        if not data or len(data) > MAX_IMAGE_BYTES:
            continue
        data_uri = f"data:{_mime_for(key)};base64,{base64.b64encode(data).decode('ascii')}"
        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _context_text(block, _siblings(blocks, index, sibling_count))},
                    {"type": "image_url", "image_url": {"url": data_uri}},
                ],
            },
        ]
        # 只用配置里的视觉模型：普通聊天模型不是视觉模型，
        # 回退到它们只会让模型瞎编图注，比没有图注更糟。
        try:
            response = await llm.chat(
                messages, model=model, temperature=0.2, max_tokens=600, timeout_s=90.0
            )
            choices = response.get("choices") or []
            message = (choices[0] or {}).get("message") if choices else {}
            caption = str((message or {}).get("content") or "").strip()
        except Exception as exc:  # noqa: BLE001 - 模型不可用不该挡住索引
            logger.warning("image caption failed with %s for %s: %s", model, key, type(exc).__name__)
            continue
        if not caption:
            continue
        heading = " > ".join(block.title_path) if block.title_path else ""
        prefix = f"图注（{heading}）：" if heading else "图注："
        block.text = f"{prefix}{caption}"
        block.payload = {**payload, "caption": caption}
        captioned += 1
    return captioned


__all__ = ["FALLBACK_PROMPT", "caption_images"]
