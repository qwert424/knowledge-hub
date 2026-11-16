"""Smoke test: tag filter narrows retrieval (run inside the agent container)."""
import json
import urllib.request

BASE = "http://kh-backend:8088"


def call(path, method="GET", body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.load(resp)


tok = call("/api/v1/auth/login", "POST", {"username": "admin", "password": "Admin@12345"})["data"]["accessToken"]
doc = call("/api/v1/documents?page=1&pageSize=1", token=tok)["data"]["items"][0]
kb = doc["kbId"]

updated = call(f"/api/v1/documents/{doc['id']}/tags", "PATCH", {"tags": ["finance"]}, tok)["data"]
print("patched tags ->", updated.get("tags"), "status:", updated.get("status"))

profile = call("/api/v1/retrieval-profiles", token=tok)["data"][0]["id"]
for tags in ([], ["finance"], ["other-team"]):
    res = call(
        f"/api/v1/retrieval-profiles/{profile}/test",
        "POST",
        {"query": doc["title"], "kbIds": [kb], "topK": 5, "tags": tags},
        tok,
    )["data"]
    debug = res.get("debug") or {}
    print(f"tags={tags} chunks={len(res.get('chunks') or [])} debug.tags={debug.get('tags')}")
