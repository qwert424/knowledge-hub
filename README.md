# 知汇平台 Knowledge Hub

企业内部私有化 AI 知识中枢：飞书 / Web 对话 + 知识库管理 + 混合检索 + GraphRAG + 评测治理。

- 方案文档：[docs/](./docs/00-索引与决策摘要.md)
- 决策记录：[docs/11-决策确认与实施方案.md](./docs/11-决策确认与实施方案.md)
- 待确认事项：[docs/TODO-待确认问题.md](./docs/TODO-待确认问题.md)

## 组成

| 目录 | 说明 | 技术栈 |
| --- | --- | --- |
| `backend/` | 控制面，唯一事实源 | Java 21 / Spring Boot 3.5 / MyBatis-Plus / Flyway |
| `agent/` | RAG Engine + Index Worker + LangGraph Agent | Python 3.13 / FastAPI / uv |
| `web/apps/portal` | 用户端对话工作台 | Next.js 15 / Ant Design 5 |
| `web/apps/admin` | 管理后台 | Next.js 15 / Ant Design 5 |
| `deploy/` | 容器编排 | Docker Compose |

## 基础设施复用

中间件**不重复搭建**，直接复用本机已在跑的 RAG 实践栈（Milvus / Nacos / LiteLLM / MinIO / Neo4j / Langfuse），
本项目只新增自己的容器（`kh-postgres`、`kh-redis`、应用容器）。

端口规划（避开已有栈的 8080/3000/5432/6379）：

| 服务 | 端口 |
| --- | --- |
| Portal | 3100 |
| Admin | 3101 |
| Java Backend | 8088 |
| RAG Engine | 8100 |
| Agent Server | 8123 |
| kh-postgres | 5433 |
| kh-redis | 6380 |

## 本地启动

```powershell
# 1. 基础设施（复用已有栈，只拉起本机还没跑的部分）
pwsh scripts/start-infra.ps1

# 2. 后端
cd backend; mvn -q -DskipTests package; mvn -pl platform-boot spring-boot:run

# 3. Agent（RAG Engine + Worker）
cd agent; uv sync; uv run uvicorn knowledge_hub.api.main:app --port 8100
cd agent; uv run arq knowledge_hub.worker.settings.WorkerSettings

# 4. 前端
cd web; pnpm install; pnpm dev
```

默认账号：`admin / Admin@12345`（首次登录强制改密见 TODO）。