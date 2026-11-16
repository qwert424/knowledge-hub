"""重建知识库集合以启用结构字段（kind / order / chunk_count / references / payload ...）。

背景：切片结构字段是后加的。老集合里没有这些列，插入时只能丢掉它们（会打 warning），
检索侧"按 block_id 补父块、按 chunk_count 判断是否读全"就做不了。

这个脚本做的是**破坏性**操作：删除集合 → 下次索引时按新 schema 重建。
文档原件仍在对象存储里，跑完必须对每个文档触发重索引才能恢复检索。

用法（在 agent 容器或本地 venv 里）::

    python scripts/migrate_chunk_schema.py --dry-run           # 只列出会删除的集合
    python scripts/migrate_chunk_schema.py --yes               # 真正删除
    python scripts/migrate_chunk_schema.py --yes --with-reindex # 删除后调用后端重建索引

重索引需要 `--backend` 与管理员账号（默认 admin/Admin@12345，可用参数覆盖）。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any

from knowledge_hub.config.settings import load_settings
from knowledge_hub.tools.milvus import MilvusSession

REQUIRED_FIELDS = ("kind", "block_order", "chunk_count", "references", "payload")


def _collection_fields(session: MilvusSession, name: str) -> set[str]:
    from pymilvus import Collection

    collection = Collection(name=name, using=session.alias)
    return {str(getattr(field, "name", "")) for field in collection.schema.fields}


def _list_collections(session: MilvusSession) -> list[str]:
    session.connect()
    from pymilvus import utility

    return sorted(utility.list_collections(using=session.alias))


def _login(base: str, username: str, password: str) -> str:
    body = json.dumps({"username": username, "password": password}).encode()
    request = urllib.request.Request(
        f"{base}/api/v1/auth/login",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310 - 内网地址
        payload: dict[str, Any] = json.loads(response.read().decode())
    return str(payload.get("data", {}).get("accessToken") or "")


def _api(base: str, token: str, path: str, *, method: str = "GET", body: dict | None = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        f"{base}{path}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            **({"Content-Type": "application/json"} if data else {}),
        },
        method=method,
    )
    with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 - 内网地址
        return json.loads(response.read().decode())


def reindex_all(base: str, username: str, password: str) -> list[str]:
    token = _login(base, username, password)
    if not token:
        raise SystemExit("登录失败，无法触发重索引")
    documents = _api(base, token, "/api/v1/documents?page=1&pageSize=200").get("data", {}).get("items", [])
    done: list[str] = []
    for doc in documents:
        if doc.get("status") == "deleted":
            continue
        try:
            _api(base, token, f"/api/v1/documents/{doc['id']}/reindex", method="POST", body={})
            done.append(f"{doc.get('title') or doc['id']}: ok")
        except urllib.error.HTTPError as exc:
            done.append(f"{doc.get('title') or doc['id']}: HTTP {exc.code}")
    return done


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="重建集合以启用切片结构字段")
    parser.add_argument("--dry-run", action="store_true", help="只检查，不删除")
    parser.add_argument("--yes", action="store_true", help="确认执行破坏性删除")
    parser.add_argument("--with-reindex", action="store_true", help="删除后调用后端重建索引")
    parser.add_argument("--backend", default="http://127.0.0.1:8088")
    parser.add_argument("--username", default="admin")
    parser.add_argument("--password", default="Admin@12345")
    args = parser.parse_args(argv)

    settings = load_settings()
    session = MilvusSession(settings.env)
    targets: list[str] = []
    for name in _list_collections(session):
        if name.startswith("_"):
            continue
        try:
            fields = _collection_fields(session, name)
        except Exception as exc:  # pragma: no cover - 探针失败不影响别的集合
            print(f"skip {name}: {exc}")
            continue
        missing = [field for field in REQUIRED_FIELDS if field not in fields]
        if missing:
            targets.append(name)
            print(f"{name}: 缺字段 {','.join(missing)}")
        else:
            print(f"{name}: 已是最新结构")

    if not targets:
        print("没有需要重建的集合。")
        return 0
    if args.dry_run or not args.yes:
        print(f"待重建 {len(targets)} 个集合；确认后加 --yes 执行（会删除向量，需重索引恢复）。")
        return 0

    from pymilvus import utility

    for name in targets:
        utility.drop_collection(name, using=session.alias)
        print(f"dropped {name}")

    if args.with_reindex:
        for line in reindex_all(args.backend, args.username, args.password):
            print(line)
    else:
        print("请到管理端对每个文档触发「重索引」，否则检索为空。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
