"""图片理解：上下文只取正文（跳过别的图片），失败降级成占位。"""

from __future__ import annotations

from typing import Any

import pytest

from knowledge_hub.rag.cir import Block
from knowledge_hub.rag.image_caption import caption_images


class FakeLLM:
    def __init__(self, caption: str = "示意图：机箱正面有 8 个硬盘位。", *, boom: bool = False) -> None:
        self.caption = caption
        self.boom = boom
        self.messages: list[list[dict[str, Any]]] = []
        self.models: list[str] = []

    async def chat(self, messages, **kwargs: Any) -> dict[str, Any]:  # noqa: ANN001
        self.messages.append(list(messages))
        self.models.append(str(kwargs.get("model")))
        if self.boom:
            raise RuntimeError("vision model down")
        return {"choices": [{"message": {"content": self.caption}}]}


class FakeMinio:
    configured = True


@pytest.fixture(autouse=True)
def _patch_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_fetch(settings, bucket, key, timeout_s=20.0):  # noqa: ANN001, ARG001
        if key == "missing.png":
            raise RuntimeError("object fetch rejected (404)")
        return b"\x89PNG\r\n\x1a\nfake"

    monkeypatch.setattr("knowledge_hub.rag.image_caption.fetch_object", fake_fetch)


def _image(block_id: str, filename: str, title_path: tuple[str, ...] = ("产品说明", "外观")) -> Block:
    return Block(
        block_id=block_id,
        block_type="image",
        text="",
        title_path=title_path,
        kind="image",
        payload={"bucket_name": "feishu-images", "bucket_filename": filename},
    )


def _text(block_id: str, text: str) -> Block:
    return Block(block_id=block_id, block_type="paragraph", text=text, kind="paragraph")


@pytest.mark.asyncio
async def test_image_gets_caption_with_title_and_siblings() -> None:
    llm = FakeLLM()
    blocks = [
        _text("p1", "前面一段讲交付配置"),
        _image("i1", "a400.png"),
        _text("p2", "后面一段讲接口"),
    ]
    captioned = await caption_images(
        blocks, llm=llm, minio=FakeMinio(), model="image-basic", sibling_count=3
    )
    assert captioned == 1
    assert blocks[1].text.startswith("图注（产品说明 > 外观）：")
    assert "机箱正面" in blocks[1].text
    assert blocks[1].payload["caption"]
    assert llm.models == ["image-basic"]
    # 上下文里既有标题路径也有前后文
    sent = str(llm.messages[0][1]["content"])
    assert "产品说明 > 外观" in sent
    assert "交付配置" in sent and "接口" in sent


@pytest.mark.asyncio
async def test_neighbour_images_are_skipped_as_context() -> None:
    llm = FakeLLM()
    blocks = [
        _text("p1", "正文一"),
        _image("i1", "first.png"),
        _image("i2", "second.png"),
        _text("p2", "正文二"),
    ]
    await caption_images(blocks, llm=llm, minio=FakeMinio(), model="image-basic", sibling_count=2)
    # 两张图各调一次；第二张的上下文里不能出现第一张的图注（它当时还是空的）
    assert len(llm.messages) == 2
    second_context = str(llm.messages[1][1]["content"])
    assert "正文一" in second_context and "正文二" in second_context


@pytest.mark.asyncio
async def test_missing_object_keeps_placeholder() -> None:
    llm = FakeLLM()
    blocks = [_text("p1", "正文"), _image("i1", "missing.png")]
    captioned = await caption_images(blocks, llm=llm, minio=FakeMinio(), model="image-basic")
    assert captioned == 0
    assert blocks[1].text == ""
    assert llm.messages == []


@pytest.mark.asyncio
async def test_model_failure_keeps_placeholder() -> None:
    llm = FakeLLM(boom=True)
    blocks = [_text("p1", "正文"), _image("i1", "ok.png")]
    captioned = await caption_images(blocks, llm=llm, minio=FakeMinio(), model="image-basic")
    assert captioned == 0
    assert blocks[1].text == ""
