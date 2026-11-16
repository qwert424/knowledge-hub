"""Inspect tags stored in Milvus for one document (run inside the agent container)."""
import json
import sys

from pymilvus import Collection

from knowledge_hub.config.settings import load_settings
from knowledge_hub.rag.store import ChunkStore

collection = sys.argv[1]
doc_id = sys.argv[2]

settings = load_settings()
store = ChunkStore(settings.env)
store.session.connect()
coll = Collection(collection, using=store.session.alias)
coll.load()
expr = f'doc_id == "{doc_id}"'
rows = coll.query(expr=expr, output_fields=["doc_id", "tags", "chunk_index"], limit=5)
print("rows:", len(rows))
for row in rows[:3]:
    print(json.dumps({"chunk": row.get("chunk_index"), "tags": row.get("tags")}, ensure_ascii=False))
