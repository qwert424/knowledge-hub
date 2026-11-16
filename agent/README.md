# Knowledge Hub — RAG Engine & Index Worker (`agent/`)

Python 3.13 project (uv managed) implementing the frozen engine contract in
`docs/12-内部契约与配置约定.md` §3/§4/§5:

| 能力 | 入口 | 实现状态 |
| --- | --- | --- |
| 健康检查 | `GET /health` | 真实探测（Milvus/Nacos/Redis），不可用时返回 `degraded` |
| 检索 | `POST /v1/retrieve` | 真实：dense + BM25(RRF) → 可选 rerank → ACL 过滤 |
| 索引 | `POST /v1/index/jobs` | 真实：后台任务解析→切分→嵌入→写 Milvus→快照 |
| 对话 | `POST /v1/chat/stream` | 真实：JEV 路由 → 检索 → JEV 判定 → LiteLLM 流式 → 引用 |
| 图谱查询 | `POST /v1/graph/query` | 契约占位：无 Neo4j 依赖，返回空结构 + `degraded=true` |
| 图谱构建 | `POST /v1/graph/build` | 契约占位：返回 202 + `not_implemented` |
| 配置热更新 | `POST /v1/admin/reload` | 真实：重新拉取 Nacos |
| 索引 Worker | `kh-worker` | 真实：`XREADGROUP` + 幂等 + 重试 + DLQ |

## 目录结构

```
agent/
  pyproject.toml            # uv_build, requires-python >=3.13,<3.14
  config/knowledge-hub.yaml # 内置默认配置（与 deploy/nacos/knowledge-hub.yaml 一致）
  src/knowledge_hub/
    api/main.py             # FastAPI 路由（docs/12 §3）
    api/container.py        # 依赖装配 + /health 探测
    api/sse.py              # SSE 帧格式
    config/settings.py      # 三层配置：Nacos → ${ENV:default} → 代码默认值
    config/nacos.py         # Nacos v1/cs/configs 读取（含登录 token）
    security/tickets.py     # 检索票据校验（RS256/HS256，issuer=knowledge-hub，scope=ticket）
    decision/jev.py         # JEV 受限选择决策器（规则优先 + 结构化 LLM + 回退）
    rag/loader.py           # local_path / MinIO(SigV4) 读取
    rag/parser.py           # pdf/docx/md/txt/html → CIR
    rag/splitter.py         # 结构化切分 + 质量标记
    rag/embed.py            # LiteLLM /embeddings，批量 + 维度校验
    rag/store.py            # pymilvus：建库/建集合/写入/dense+sparse 检索
    rag/filters.py          # 唯一的 ACL 过滤表达式拼接入口 build_filter()
    rag/retriever.py        # dense + sparse + RRF + 可选 rerank + ACL 复核
    rag/pipeline.py         # 索引流水线（HTTP 与 Worker 共用）
    rag/graph.py            # GraphRAG 契约占位
    engine/chat.py          # 流式问答（status/token/citation/error/done）
    engine/prompts.py       # 不可信数据块的提示词构造
    worker/main.py          # Redis Stream 消费者（group=kh-workers）
    worker/callbacks.py     # Java 内部回调（X-Internal-Token）
    tools/llm.py            # LiteLLM 客户端（embed / chat / stream / rerank）
    tools/milvus.py         # Milvus 连接工厂（惰性）
    tools/minio.py          # 无 boto3 的 S3 SigV4 GET/PUT
    tools/redis_factory.py  # Redis URL / stream key / 幂等 key
  tests/                    # pytest（无网络、Mock Milvus/LiteLLM）
```

## 本地运行

```powershell
cd agent
uv sync
uv run pytest -q
uv run python -c "import knowledge_hub; print(knowledge_hub.__version__)"

# 引擎（默认端口取 RAG_ENGINE_PORT，缺省 8100）
uv run uvicorn knowledge_hub.api.main:app --port 8100
# 或
uv run kh-engine

# Worker
uv run kh-worker
uv run python -m knowledge_hub.worker.main --once
```

健康检查：

```powershell
curl http://127.0.0.1:8100/health
```

Milvus/Nacos/Redis 未启动时进程不会崩溃，`/health` 返回
`{"status":"degraded", "milvus":false, "nacos":false, ...}`；检索/索引接口在依赖不可用时返回
`INTERNAL_ERROR`(503) 或 `MODEL_UNAVAILABLE`(503)，而不是 500。

## 环境变量（只放接入点/凭证/端口，名称列表）

| 变量 | 用途 |
| --- | --- |
| `APP_ENV`, `LOG_LEVEL` | 运行环境与日志级别 |
| `MILVUS_URI`, `MILVUS_DB_NAME`, `MILVUS_TOKEN`, `MILVUS_TIMEOUT_MS` | Milvus 连接 |
| `NACOS_SERVER`, `NACOS_DATA_ID`, `NACOS_GROUP`, `NACOS_NAMESPACE`, `NACOS_USERNAME`, `NACOS_PASSWORD`, `NACOS_TIMEOUT_MS` | 配置中心 |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `MINIO_REGION` | 对象存储 |
| `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `OPENAI_DEFAULT_MODEL`, `OPENAI_EMBEDDING_MODEL`, `EMBEDDING_DIM` | 模型网关 |
| `JWT_SECRET`, `JWT_PUBLIC_KEY_PATH`, `JWT_ISSUER` | 票据验签（RS256 优先，否则 HS256） |
| `INTERNAL_SERVICE_TOKEN`, `BACKEND_BASE_URL` | Worker → Java 内部回调 |
| `RAG_ENGINE_PORT` | 引擎端口 |
| `KH_REDIS_HOST`, `KH_REDIS_PORT`, `KH_REDIS_PASSWORD`, `KH_REDIS_DB` | Redis（`kh-redis` 6380） |
| `WORKER_GROUP`, `WORKER_CONSUMER`, `WORKER_MAX_ATTEMPTS`, `WORKER_IDEM_TTL_SECONDS`, `WORKER_BLOCK_MS`, `WORKER_BATCH` | Worker 行为 |
| `KH_ENV_FILE` | 可选：显式指定 dotenv 文件（默认不加载任何 `.env`） |

模型别名 / 切分参数 / 检索权重 / JEV 阈值**只在 Nacos**：

- `dataId=knowledge-hub.yaml`
- `group=DEFAULT_GROUP`
- `namespace=public`
- 读取顺序：Nacos → 环境变量覆盖（`${ENV:default}`）→ `agent/config/knowledge-hub.yaml` 内置默认值
- Nacos 不可用 → 使用内置默认值启动，`/health` 与 `/v1/admin/reload` 会返回错误原因

## 契约要点

- **ACL 唯一来源是票据**：`security/tickets.py` 校验 `iss=knowledge-hub`、`scope=ticket`、
  `exp`（RS256 优先，否则 HS256），`principals`/`kb_ids` 只从票据读取；请求级 `filters` 被忽略。
- **过滤表达式单一路径**：`rag/filters.py::build_filter()` 永远包含
  `tenant_id` + `kb_id in [...]` + `status == "active"` + 可见性/主体子句；
  非标识符值直接报错（不做转义拼接），因此查询注入无法改写过滤条件。
  票据无 principals → `AUTH_403`。
- **请求只能收窄 KB**：`ticket.effective_kb_ids(requested)` 取交集，永远不会扩大。
- **集合解析（每个 kb 独立）**：`kb_collections[kb_id]` → `profile.collectionName`（或
  `profile.collection` / `profile.retrieve.collectionName`）→ `kb_chunks_{dim}`（debug 日志）；
  与 Java 索引下发的 `collectionName` 对齐。某 kb 的集合在 Milvus 中不存在时**不报错**：
  跳过该 kb 并写入 `debug.skipped_kbs=[{kb_id,collection,reason:"collection_missing"}]`，
  继续检索其余 kb；全部缺失时返回 `chunks=[]`、`debug.all_collections_missing=true`、
  `debug.jev.choice="no_kb"`。
- **索引幂等**：`chunk_id = sha1(doc:version:block:index:text)`，写入前先按
  `doc_id + version_id` 删除旧行；Worker 按 `eventId` 做 24h `SETNX` 幂等。
- **SSE 事件**：`status` / `token` / `citation` / `error` / `done`，`done.usage` 为
  `{model,input_tokens,output_tokens}`；LiteLLM 不可达时发**恰好一个**
  `error{code:MODEL_UNAVAILABLE}` 后补一个 `done`，且不泄露任何内部提示词；
  生成阶段有 `llm.stream_timeout_s`（默认 120s）硬超时，SSE 不会挂死。
- **空检索不伪造引用**：`chunks=[]` 时 JEV router 走 `direct` 直答路径，
  事件序列仍为 `status → token… → done`，不产生任何 `citation`。
- **JEV**：候选集由代码给定；权限/租户/空检索/集合全缺失走确定性规则；模型调用 `temperature=0`、
  JSON Schema 约束、3s 超时；失败/越界/低置信回退到 `fallback` 并置 `degraded=true`。

## 已解决的契约歧义

1. **集合命名**：Java 按 KB 下发 `collectionName`（如 `kh_demo_1024`），而检索请求原本不带集合名。
   现已按主控确认的契约补齐：`POST /v1/retrieve`（及 `/v1/chat/stream`）新增可选
   `kb_collections={"<kb_id>":"<collectionName>"}`，解析顺序
   `kb_collections[kb_id]` → `profile.collectionName` → `kb_chunks_{dim}`（最后一级仅兜底 + debug 日志）。
   集合缺失时按 kb 跳过（`debug.skipped_kbs`），不再 500；全缺失时 `debug.jev.choice="no_kb"`。
   索引侧 `collectionName` 仍由 Java 下发，未给时落 `kb_chunks_{dim}` 并写 warning。
2. **`chunking.chunk_size` 单位**：按字符数实现（中文场景 1000 字符 ≈ 1000 token 量级），
   `chunk_overlap` 同样按字符；`quality.min_tokens/max_tokens` 使用估算 token 数。
3. **对象存储读取**：Worker 支持 `localPath`（已下载到本地）或 `objectKey`（MinIO SigV4 拉取）；
   HTTP 契约 `docs/12 §3.2` 只有 `objectKey`，因此两者都接受，`localPath` 为扩展字段。
4. **`tenantId` 归属**：`docs/12 §3.2` payload 无租户字段，但 Milvus 必须写 `tenant_id`；
   Worker 用 Stream 信封里的 `tenantId` 注入 payload（缺失时固定 `default`）。
5. **GraphRAG**：`docs/11 §7` 要求保留链路但默认关闭；本交付不引入 Neo4j 驱动，
   `/v1/graph/*` 返回空结构 + `degraded`/`reason`，避免伪造图结果。
6. **`/v1/admin/reload` 鉴权**：Java `RagEngineClient.reloadConfig()` 不发送内部 token，
   因此该路由不加 `X-Internal-Token` 校验，部署时须只监听内网。
7. **`pyjwt[crypto]`**：依赖清单一栏写 `pyjwt`；RS256 验签需要 `cryptography`，
   因此声明为 `pyjwt[crypto]`（仍是同一个包）。

## GraphRAG / 未实现项

- Neo4j 实体抽取、社区摘要、`/v1/graph/*` 实际查询：**未实现**（返回契约占位结构）。
- `kh:stream:acl.sync`、`kh:stream:graph.jobs`：本 Worker 只消费
  `kh:stream:index.job.created`，其余 stream 预留。
- 语义缓存、查询改写、Agentic 多轮补检索：未实现（`docs/05` 的 P1 范围）。
