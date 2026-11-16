# deploy 运维手册（knowledge-hub / 知汇平台）

> 中间件**复用**本机已有的 RAG 实践栈（`ai-infrastructure-rag-practice`，compose 项目名 `deal-pilot-rag`）。
> 本项目只新增自己的容器：`kh-postgres`、`kh-redis`、`kh-backend`、`kh-agent`、`kh-worker`、`kh-portal`、`kh-admin`。
> 容器访问复用栈一律走 `host.docker.internal`（compose 里已声明 `extra_hosts`）。

---

## 1. 端口表

| 服务 | 宿主端口 | 容器内 | 说明 |
| --- | --- | --- | --- |
| Portal（用户端） | 3100 | 3000 | Next.js |
| Admin（管理端） | 3101 | 3000 | Next.js |
| Java Backend | 8088 | 8088 | REST + SSE，`/actuator/health` |
| RAG Engine | 8100 | 8100 | FastAPI，`/health` |
| Index Worker | 无 | 无 | 消费 `kh:stream:*` |
| kh-postgres | 5433 | 5432 | 本项目新增（库 `kh`） |
| kh-redis | 6380 | 6379 | 本项目新增（默认无密码） |
| —— 复用栈 —— | | | |
| Milvus | 19530 / 9091 | | 库 `knowledge_hub` |
| Nacos | 8848（HTTP）/ **8080（控制台）** | | `dataId=knowledge-hub.yaml` |
| LiteLLM | 4000 | | OpenAI 兼容网关 |
| Shared MinIO | 9002（API）/ 9003（控制台） | | 桶 `knowledge-hub` |
| Neo4j（可选 profile） | 7474 / 7687 | | GraphRAG |
| Langfuse | **3000** | | 观测 |

> ⚠️ `8080` 已被 Nacos 控制台占用、`3000` 已被 Langfuse 占用。nginx 请用 `8081/8089`，不要用 8080。

---

## 2. 标准流程（本地开发）

```powershell
# 0) 首次：准备 .env 与密钥（不会覆盖已有文件）
Copy-Item .env.example .env      # 已经有 .env 就跳过
.\scripts\gen-secrets.ps1        # secrets/jwt-*.pem + SECRET_MASTER_KEY + INTERNAL_SERVICE_TOKEN

# 1) 前置检查（Docker Desktop 是否可用、端口是否被占）
.\scripts\check-docker.ps1

# 2) 拉起复用的中间件（只启动 milvus/etcd/milvus-minio/shared-minio/nacos/litellm）
.\scripts\start-infra.ps1
#    需要图数据库：.\scripts\start-infra.ps1 -WithNeo4j
#    只看状态：    .\scripts\start-infra.ps1 -StatusOnly

# 3) 初始化（可重复执行：Milvus 库、MinIO 桶、Nacos 配置、kh-postgres/kh-redis）
.\scripts\bootstrap.ps1

# 4) 本地起后端 + 引擎 + Worker + 两端前端（每个进程一个窗口）
.\scripts\dev.ps1
#    只起一部分：.\scripts\dev.ps1 -Only backend | agent | web | infra
#    只看命令：  .\scripts\dev.ps1 -DryRun

# 5) 冒烟
.\scripts\smoke.ps1
```

URL：Portal <http://127.0.0.1:3100> · Admin <http://127.0.0.1:3101> ·
Backend <http://127.0.0.1:8088>（`/swagger-ui.html`）· Engine <http://127.0.0.1:8100>（`/docs`）。
默认账号 `admin / Admin@12345`。

### 脚本一览

| 脚本 | 作用 | 关键点 |
| --- | --- | --- |
| `scripts/env.ps1` | 把根 `.env` 载入当前进程，设 `TEMP/TMP=D:\devCaches\temp`，补默认值 | 必须 **dot-source**：`. .\scripts\env.ps1`；`-NoOverride` 让已有的进程环境变量优先（含 `KH_ENV_NO_OVERRIDE=1` 向下传递） |
| `scripts/check-docker.ps1` | 校验 Docker 守护进程 + 6 个自有端口 | 退出码 1 = 有阻塞问题 |
| `scripts/start-infra.ps1` | 只启动复用栈的子集（`up -d --wait`） | 永不 `down`、永不 `-v` |
| `scripts/stop-infra.ps1` | 默认只打印归属关系；`-Force` 才停中间件；`-App` 停本项目容器 | 用 `stop`，不用 `down` |
| `scripts/bootstrap.ps1` | Milvus 库 + MinIO 桶 + Nacos 配置 + 自有容器 | 幂等，可反复执行 |
| `scripts/gen-secrets.ps1` | RSA 密钥对 + 两个随机串 | 已存在则跳过；写 `.env` 只填空值 |
| `scripts/dev.ps1` | 本机开发启动器 | 子进程继承 `.env` 环境变量 |
| `scripts/smoke.ps1` | 端到端 HTTP 冒烟 | 失败退出码 1；`WARN` 不计失败 |

---

## 3. 容器方式

```powershell
# 先起中间件 + 初始化（同上 1~3 步），然后：
docker compose --env-file .\.env -f .\deploy\compose\docker-compose.app.yml up -d --build

# 只做配置校验（守护进程没起也能跑）
docker compose --env-file .\.env -f .\deploy\compose\docker-compose.app.yml config -q

# 单独起自有中间件
docker compose --env-file .\.env -f .\deploy\compose\docker-compose.app.yml up -d kh-postgres kh-redis
```

`deploy/compose/docker-compose.app.yml` 的要点：

- `env_file`：默认读仓库根 `.env`（必需），再叠加可选的 `deploy/.env`（覆盖用）。**插值**（`${KH_PG_PASSWORD}` 等）
  来自 shell 环境或 `--env-file`，所以命令行务必带 `--env-file .\.env`（脚本已替你带）。
- 镜像：`deploy/docker/Dockerfile.backend`（Maven 多阶段 → JDK21 JRE，非 root）、
  `Dockerfile.agent`（uv / python3.13，同一个镜像跑 `kh-agent` 与 `kh-worker`）、
  `Dockerfile.web`（`--build-arg APP=portal|admin`）。
- 三个 Dockerfile 的 **build context 都是仓库根**，配对的 `Dockerfile.*.dockerignore` 只保留需要的目录。
- 健康检查：`pg_isready`、`redis-cli ping`、`/actuator/health`、`/health`；`depends_on: service_healthy`
  保证后端等 PG/Redis、前端等后端。
- 日志：`json-file`，`max-size=10m`、`max-file=3`，避免占满磁盘。
- 命名卷：`kh_pg_data`、`kh_redis_data`（`kh_worker_tmp` 为 worker 临时目录）。

### 反向代理

`deploy/nginx/kh.conf` 三个虚拟主机：`portal.kh.local` / `admin.kh.local` / `api.kh.local`。
SSE 关键配置（`/api/v1/chat/stream`）：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
add_header X-Accel-Buffering no always;
```

其它：`client_max_body_size 200m`、gzip（`text/event-stream` 不压缩）。放进 nginx 容器：

```powershell
docker run -d --name kh-nginx --network kh_net -p 8081:80 `
  -v "${PWD}\deploy\nginx\kh.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine
```

> nginx 起不来通常是 upstream 主机名解析不到（`kh-portal`/`kh-admin`/`kh-backend` 未启动）。
> 先用 `docker network ls | findstr kh_net` 确认网络存在。

---

## 4. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `check-docker.ps1` 报 8088/8100/3100/3101 被占 | `netstat -ano \| findstr :8088` 找 PID，再 `tasklist /FI "PID eq <pid>"`；或在 `.env` 改 `SERVER_PORT`/`RAG_ENGINE_PORT`/`PORTAL_PORT`/`ADMIN_PORT` |
| 5433/6380 被占（常见于另一个项目也在用） | 改 `.env` 的 `KH_PG_PORT`/`KH_REDIS_PORT`；容器内端口始终是 5432/6379 |
| **8080 冲突** | 8080 是 Nacos 控制台（复用栈），本项目与 nginx 都不要用；用 8081/8089 |
| **3000 冲突** | 3000 是 Langfuse；Portal=3100、Admin=3101 |
| `start-infra.ps1` 提示 compose 文件不存在 | 参考栈不在同级目录：`.\scripts\start-infra.ps1 -RefCompose D:\path\docker-compose.yml`，或设 `KH_REF_COMPOSE` |
| `bootstrap.ps1` Nacos 步骤 403 | Nacos 3 写配置需要**管理员**账号：在 `.env` 设 `NACOS_USERNAME=nacos`、`NACOS_PASSWORD=<管理员密码>` 后重跑（脚本也会自动尝试内置 `nacos` 用户） |
| Milvus 步骤失败 | 装 `pymilvus`，或让脚本走 REST 分支（默认自动尝试 `POST /v2/vectordb/databases/create`） |
| 后端启动后连不上 PG | 本机开发：`KH_PG_HOST=127.0.0.1 / KH_PG_PORT=5433`；容器内由 compose 覆盖为 `kh-postgres:5432` |
| 引擎 `/health` 返回 `degraded`，`nacos:false` | 见「已知缺口」第 1 条：引擎仍用 Nacos v1 接口，而复用栈是 Nacos 3.x |
| SSE 变成“一次性吐出” | nginx 少了 `proxy_buffering off` / `X-Accel-Buffering: no` |
| Windows 上中文乱码 | PowerShell 5.1 需要带 BOM 的 UTF-8；`scripts/*.ps1` 已统一为 UTF-8 BOM |
| 改了 `.env` 却“没生效” | 根 `.env` 里存在**重复键**（例如 `MILVUS_DB_NAME`、`MINIO_BUCKET` 各出现两次）。脚本按“后出现的胜出”解析，请检查末尾那一组值；或用 `$env:KH_ENV_NO_OVERRIDE='1'` 让 shell 变量优先 |

---

## 5. 已知缺口（交给对应 track）

1. **引擎的 Nacos 客户端仍是 v1**：`agent/src/knowledge_hub/config/nacos.py` 请求 `/nacos/v1/cs/configs`，
   而复用栈是 Nacos 3.2.4（v1/v2 Open API 已移除）→ 恒 404，引擎以代码默认值启动（设计上允许）。
   配置本身已由 `bootstrap.ps1` 正确写入 Nacos 3 的 `POST /nacos/v3/admin/cs/config`
   （`dataId=knowledge-hub.yaml`、`group=DEFAULT_GROUP`、`namespace=public`），引擎切到 v3 接口后即可读到。
2. **前端未开启 `output: "standalone"`**：`web/apps/*/next.config.mjs` 目前没有该选项，因此
   `Dockerfile.web` 采用「完整 node_modules + `next start`」的方式，镜像较大但可构建。
   加上 `output: "standalone"` 后可改为精简 runner。
3. **镜像未做实际业务验证**：本环境只做了 `docker build --check`（三个 Dockerfile 全部无告警），
   后端镜像完整构建见 `docker build -f deploy/docker/Dockerfile.backend .`。
4. **Neo4j 需要许可协议**：复用栈里 `neo4j` 在 `neo4j` profile 下，且要求 `.env` 里
   `NEO4J_ACCEPT_LICENSE_AGREEMENT` 与 `NEO4J_PASSWORD` 非空。
5. `dev.ps1` 的 Web 部分依赖 `pnpm-lock.yaml` 已安装（首次请先在 `web/` 执行 `pnpm install`）。

---

## 6. 目录

```text
deploy/
├── compose/docker-compose.app.yml     # 本项目容器（中间件不重复搭建）
├── docker/
│   ├── Dockerfile.backend             # maven 多阶段 → temurin 21 JRE，非 root
│   ├── Dockerfile.backend.dockerignore
│   ├── Dockerfile.agent               # uv + python3.13（engine / worker 共用）
│   ├── Dockerfile.agent.dockerignore
│   ├── Dockerfile.web                 # --build-arg APP=portal|admin
│   ├── Dockerfile.web.dockerignore
│   └── postgres/init/00-init.sql      # 建库/扩展（Flyway 之前执行一次）
├── nacos/knowledge-hub.yaml           # 配置中心内容（bootstrap 发布）
├── nginx/kh.conf                      # 反代 + SSE
└── README.md
scripts/
├── env.ps1  check-docker.ps1  start-infra.ps1  stop-infra.ps1
├── bootstrap.ps1  gen-secrets.ps1  dev.ps1  smoke.ps1
```
