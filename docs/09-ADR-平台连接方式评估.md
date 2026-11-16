# 09 ADR：Agent 与中间件的连接方式

- 状态：建议采纳
- 日期：2026-11-11
- 决策人：架构组
- 相关：[01 §5](./01-总体架构与实现方案.md)

## 1. 背景

系统涉及多个平台：LiteLLM（模型网关）、Nacos（配置/Agent 资产）、Langfuse（追踪评测）、OpenSandbox（沙箱）、MinIO（对象存储）、Milvus（向量）、Neo4j（图谱）。

你的直觉：**让 Agent 统一通过 Java 后端连接这些平台**，这样以后换平台只改一处，不会两个端都改。

需要评估三种方案。

## 2. 选项

### A. Agent 直连所有平台

```text
Agent ──> LiteLLM / Nacos / Langfuse / MinIO / Milvus / Neo4j / Sandbox
Java  ──> 只管业务元数据
```

- 优点：链路短、延迟低、Python 生态现成（参考项目就是这么做的）。
- 缺点：凭证散落两端；换平台要改两处；审计不统一；权限边界模糊；Agent 成为“万能钥匙”。

### B. 全部经 Java 代理

```text
Agent ──> Java ──> LiteLLM / Nacos / Langfuse / MinIO / Milvus / Neo4j / Sandbox
```

- 优点：单一入口、单一凭证、统一审计、换平台只改 Java。
- 缺点：
  - **向量检索结果是大 payload**（topK × 1KB × 多路），Java 代理会浪费 CPU/带宽，增加 20–80ms。
  - **LLM 流式**经 Java 转发要处理背压、断线、超时，复杂且易错。
  - **文件上传/下载**经 Java 会打爆内存和连接数。
  - Java 成为所有流的单点，扩容只能整体扩。
  - Python 侧的 LangChain/LangGraph 生态（callback、tracing、tool）被切断。

### C. 控制面统一、数据面受控直连（推荐）

```text
配置/凭证/权限/审计/编排 ──> Java（控制面）
大流量数据（LLM/向量/文件/追踪）──> Agent/RAG Engine 直连（数据面）
直连必须持有 Java 签发的短期凭证/票据，并强制租户与 ACL 过滤
```

- 优点：兼顾“只改一处”和“数据面性能”。
- 缺点：需要设计票据与凭证下发机制；边界要靠规范与测试保证。

## 3. 评估矩阵

权重：可维护 25%、性能 20%、安全 20%、扩展 15%、交付速度 10%、运维 10%。

| 维度 | A 全直连 | B 全代理 | C 控制/数据分离 |
| --- | --- | --- | --- |
| 换平台改动点 | 2 处（Java + Agent） | 1 处（Java） | 1 处（Java 适配器 + 契约不变） |
| 凭证管理 | 分散 | 集中 | 集中签发，短期下发 |
| 审计完整性 | 部分（Agent 自审） | 完整 | 控制面完整 + 数据面采样 |
| 检索延迟 | 最低 | +20–80ms | 接近最低 |
| LLM 流式 | 最简单 | 复杂 | 简单 |
| 文件吞吐 | 好 | 差 | 好（预签名） |
| 故障隔离 | 好 | 差（Java 单点） | 好 |
| 水平扩展 | 各自扩 | Java 瓶颈 | 各自扩 |
| 权限强制 | 靠自觉 | 集中 | 票据 + 强制 filter |
| 开发工作量 | 低 | 高 | 中 |
| 综合 | 6.5 | 6.0 | **8.5** |

## 4. 决策

**采用 C：控制面统一、数据面受控直连。**

具体分工：

| 能力 | 控制面（Java） | 数据面（Agent/RAG） |
| --- | --- | --- |
| 模型清单/别名/预算/Key | 管理、下发 Virtual Key | 用 Key 调 LiteLLM |
| Prompt/Skill/MCP/AgentSpec | 编辑、版本、发布到 Nacos | 从 Nacos 只读加载 |
| Langfuse | 项目/数据集/评测查询 | 写 Trace（ingest key） |
| MinIO | Bucket、预签名、生命周期 | 用预签名 URL 读写 |
| Milvus | 集合注册、维度、索引参数 | 直连读写，强制 ACL |
| Neo4j | 图谱开关、精选文档 | 直连读写 |
| Milvus/Neo4j 凭证 | **不持有**（只记录连接元数据） | 专用账号，网络隔离 |
| 用户/角色/租户 | 事实源 | 只信票据 |
| 审计 | 汇总、查询、告警 | 上报事件 |

## 5. 关键机制

### 5.1 短期票据（RetrievalTicket）

- Java 用 RS256 私钥签发，RAG Engine 用公钥验签。
- 内容：`sub`、`tenant_id`、`principals`、`kb_ids`、`profile_id`、`scope`、`exp`（5 分钟）、`jti`。
- Agent 不能修改；模型不能影响。
- 过期由 Agent 重新申请（用户会话仍有效）。

### 5.2 租户级模型 Key

- Java 在 LiteLLM 创建 Team（每租户一个）+ Virtual Key。
- Key 带预算、RPM/TPM、可用模型列表。
- Agent 用该 Key 调用；LiteLLM 按 `user` 字段归集到具体用户。
- 轮换：Java 定时轮换，Agent 从配置中心/环境变量热加载。

### 5.3 预签名 URL

- 上传：浏览器 → Java 申请 → MinIO 直传。
- 下载/引用：Java 生成 1 小时 GET URL。
- Agent 不持有 MinIO 长期密钥；如需批量读，使用 STS（二期）。

### 5.4 网络隔离

```text
[DMZ] Portal/Admin/Nginx
   |
[App] Java / Agent / RAG Engine
   |
[Data] Postgres / Redis / Milvus / Neo4j / MinIO
```

- Milvus/Neo4j 只对 App 网段开放。
- Java 不开放 Milvus/Neo4j 端口访问。
- 出站：Agent 仅允许访问 LiteLLM、Nacos、Langfuse、MinIO、Milvus、Neo4j、Sandbox。

### 5.5 审计补位

数据面直连无法被 Java 逐条拦截，因此：

- Agent/RAG Engine 必须上报：检索请求（问题哈希、KB、命中文档、耗时、过滤数）、LLM 调用（模型、Token、成本）、工具调用。
- Java 侧做采样校验与异常检测（如某用户检索量突增、命中大量未授权文档）。
- 所有“写”操作（索引、图谱、配置）必须经 Java，不允许数据面直接改业务元数据。

## 6. 后果

### 正面

- 换 LiteLLM/Nacos/Langfuse 供应商时，只改 Java 适配器和配置，Agent 契约不变。
- LLM/向量/文件走最短路径，性能和流式体验最好。
- 凭证集中管理，Agent 只拿短期凭证。
- Java 不会成为流量瓶颈，各端可独立扩容。

### 负面 / 需要接受

- 存在“两套调用路径”，需要在文档和代码评审中明确边界。
- 票据机制增加了实现复杂度（约 +2 人日）。
- 数据面审计是“上报制”，不是“拦截制”，需要监控补位。
- Milvus/Neo4j 的库级权限较粗，必须依赖应用层强制过滤 + 网络隔离。

### 缓解

- 在 `agent/security` 中提供唯一的 `build_filter`，禁止其他位置拼 filter。
- CI 中加入“越权检索”集成测试。
- 票据短 TTL + `jti` 黑名单（Redis）。
- 每季度做一次权限渗透测试。

## 7. 何时可以改回 B（全代理）

如果未来出现以下情况，可重新评估：

- 合规要求“所有数据访问必须经过统一网关”。
- Milvus/Neo4j 迁到托管服务，无法给 Agent 开网络。
- Java 侧引入高性能异步网关（WebFlux + 零拷贝），能承受向量流量。

届时只需把 `RAG Engine` 的 Milvus 客户端替换为 Java 代理客户端，票据与 ACL 逻辑不变。

## 8. 结论

**不要让 Agent 各自散着连一堆平台，也不要让 Java 代理所有流量。**  
用 Java 做“控制面 + 凭证签发 + 审计汇总”，让 Agent/RAG Engine 在“短期票据 + 专用账号 + 网络隔离”下直连数据面。这是可维护性、性能与安全的最优平衡。
