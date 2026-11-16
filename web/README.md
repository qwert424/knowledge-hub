# Knowledge Hub 前端（web/）

pnpm workspace，包含两个 Next.js 15 应用与两个共享包：

| 包 | 说明 | 端口 |
| --- | --- | --- |
| `apps/portal` | 用户端对话工作台（SSE 流式 + 引用抽屉） | 3100 |
| `apps/admin` | 管理端（知识库/文档/索引/策略/权限/审计/评测/图谱/设置） | 3101 |
| `packages/api-client` | 框架无关的强类型 API 客户端（含 SSE 解析） | - |
| `packages/ui` | AntD 5 主题、AppShell、状态标签、JSON 视图等共享组件 | - |

## 常用命令

```bash
pnpm install            # 安装依赖
pnpm dev                # 同时启动两个应用
pnpm dev:portal         # 仅用户端（3100）
pnpm dev:admin          # 仅管理端（3101）
pnpm -r typecheck       # 全量类型检查
pnpm --filter admin build
pnpm --filter portal build
```

## 配置

唯一前端配置是后端接入点，默认 `http://127.0.0.1:8088`：

```bash
# web/.env.local
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8088
```

## 约定

- 所有请求走 `@kh/api-client`，统一拆解 `{code,message,data,requestId}`，`code!="OK"` 抛 `ApiError`（带 `requestId`）。
- 登录：`POST /api/v1/auth/login` → `Authorization: Bearer <accessToken>`；Admin 存 `localStorage`，Portal 存内存 + 轻量 cookie。
- 401 自动用 refreshToken 刷新一次并重试。
- Portal 对话：`POST /api/v1/chat/sessions/{id}/messages` 用 `fetch` + `ReadableStream` 手工解析 SSE（`EventSource` 不支持 POST），事件为 `start/status/token/citation/error/done`。
- 页面不内置 mock 数据；后端未实现的接口按契约调用并展示错误态（含错误码与 requestId）。
