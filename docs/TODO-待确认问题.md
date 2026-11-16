# 待办与已决策记录

> 只保留还需要你动作的事项；其余按"建议方案"执行完毕，已从清单移除。
> 最后更新：2026-11-15

## 一、已按建议执行（无需再确认）

| 事项 | 落地方案 |
| --- | --- |
| 未选知识库是否检索 | 选了知识库必检索；没选由 JEV 决策器判断（闲聊不查库，问内部事实才查） |
| 多知识库一起查 | 输入框可多选；后端按知识库分别映射集合、并行检索后 RRF 融合（实测：选 2 个库能命中其中 1 个库的切片并正确引用） |
| `deploy` 工具 | 沙箱产物 → MinIO `agent-artifacts/<tenant>/<user>/<dir>`，返回 7 天预签名直链，不建公共读桶 |
| 推荐问题 | 管理端可编辑，最多 4 条；用户端与管理端都是两列网格展示，留空恢复默认 |
| 会话模型白名单 | 改模型时校验 LiteLLM 别名，不在清单直接 400；网关不可达时放行避免挡住提问 |
| 额度语义 | 显式配 0 = 不限；完全没配才回落 `kh.chat.*`（200 万 tokens / 5000 次） |
| Milvus / Nacos 重启策略 | `restart: on-failure`（崩溃自动拉起，不开机自启），其余容器保持 `restart: "no"` |
| 人机回路 `ask_user_question` | 支持 `options` 候选，`status.stage=awaiting_user` 带 question+options，用户端渲染成可点选卡片 |
| 计划 / 复核 / 安全中间件 | `runtime/middleware.py`：规划（严格 JSON、4s 预算）→ 执行 → 复核（need_fix 改写一次）→ 确定性安全扫描（密钥样式/内部主机/内网 IP/提示词回显），可在 Nacos 用 `agent.plan_enabled` 等开关关闭 |
| 中断 + 引导发送 | 回答中点「发送」可选"打断当前立即发送"或"等这条答完再发送"；排队的问题可以编辑/取消，队列状态在输入框上方显示 |
| 中断的持久化与续写 | 停止 → 断开上游引擎 + 落库 `stopped`（带已显示内容）→ 消息上出现醒目的「继续生成 / 重新生成」，续写沿用同一条消息 |

## 二、需要你动作

1. **skills**：通道已实现（Nacos zip → 解压到沙箱 `/shared/skills/<agent>` → SKILL.md 进提示词 → `load_skill` 读取）。
   当前 `main_agent` 的 `skills` 为空，你在 Nacos 里配上名称后即生效；配好告诉我，我实测一遍解压与执行。
2. **交付物链接有效期**：默认 7 天预签名直链。若需要长期可访问，告诉我，我改成公共读桶或前端代理下载。
3. **飞书应用权限**：文档导入走应用级 tenant_access_token，需要把应用加为文档协作者（或文档设成组织内可阅读），
   并在开放平台给应用开 `docx:document:readonly`、`wiki:wiki:readonly`。没配 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 时导入会直接报"飞书未配置"。

## 三、三个问题的答复（本轮已落地）

### 1) `agent.plan_enabled` 到底在哪配？
不是 manifest.json。它是**引擎自身配置**，在 Nacos 的 `dataId=knowledge-hub.yaml`、`group=DEFAULT_GROUP` 里：

```yaml
agent:
  name: main_agent
  label: production
  plan_enabled: true            # 规划：先出计划再调工具
  review_enabled: true          # 复核：答案自查后改写一次
  security_scan_enabled: true   # 安全扫描：拦截提示词回显/密钥/内网地址
```

三个开关已写进 [deploy/nacos/knowledge-hub.yaml](../../deploy/nacos/knowledge-hub.yaml)，也已经发布到 Nacos 并让引擎 reload 验证过。
管理端也能改：**平台集成 → Agent → 「中间件开关」**，三档开关 + 「保存并生效」= 合并进 `agent.*` → 发布 Nacos → `POST /v1/admin/reload`（不用重启容器）。

### 2) 用户端到底走哪条链路？
- **选了知识库**：必走 RAG（在授权范围内检索），没命中就明确说"资料不足"，不会偷偷换成凭常识回答。
- **没选知识库**：由 JEV 决策器判断要不要查库：
  - 判定"该查"且**查到了** → RAG 链路（带引用作答）；
  - 判定"该查"但**没查到** → **交给主 Agent**（工具 / 子 Agent / 沙箱），事件流仍按 chat 契约回传，前端看不出差异；
  - 判定"不用查"（闲聊/写作）→ 直接回答。

这条兜底已有单测（`test_jev_miss_delegates_to_main_agent`、`test_jev_miss_with_selected_kb_refuses_instead_of_agent`）。

### 3) 飞书直接导入（含知识库浏览）
不再只支持"导出 blocks JSON 上传"：
- **粘贴链接**：`/docx/…`、`/wiki/…` 直接拉取；优先取 **DocxBlock 全量块**（自动翻页）→ 存 `{"blocks":[…]}` → 引擎侧 `blocks_to_ir` 还原标题层级/表格/列表；拉不到块时退回纯文本。
- **浏览知识空间**：文档页「从飞书导入 → 浏览知识空间」，列空间 → 逐层进目录 → 勾选多篇 → 批量导入（逐条返回成功/失败）。

## 三、这一轮新落地（已可用）

| 能力 | 落点 |
| --- | --- |
| 评测真正跑起来 | `EvalRunner`：逐用例走真实检索链路，写回 `metrics`（cases/done/hitRate/answerRate + 前 20 条明细）；运行列表有进度条、「取消」，3s 轮询；trace 进 Langfuse |
| 数据集绑定知识库 | 新建数据集可选知识库，留空=不限库（检索调用者有权访问的全部库） |
| 菜单可配置 | `menu_item` 表 + `/api/v1/admin/menus` + 管理端「菜单管理」：增删、↑↓ 排序、绑权限码、隐藏、恢复默认；前端导航改为读接口（失败回落内置默认） |
| 文档标签 + 检索过滤 | `document.tags` + 索引 payload `tags` → 向量库切片字段；改标签自动重建索引；调试台支持「标签过滤」（只收窄，ACL 仍由票据决定） |
| 飞书直接导入 | 文档页「从飞书导入」：贴 `/docx/…` 或 `/wiki/…` 链接即拉正文建 Markdown 并索引，走与上传相同的解析链路 |
| 检索策略 ↔ Nacos 双向 | 「检索策略」页新增结构化表单（Embedding/维度/切片/重叠/fetch_k/k/rerank/索引类型/度量）：读 Nacos 填充，改完只合并这些字段再发布，其它区块（图片解析、集合配置）原样保留 |
| 网关成本可视 | 平台集成「调用记录与成本」：按模型 + 按天账单（`/global/spend/models`、`/spend/logs`）+ Langfuse 链路 |

## 五、本轮（按菜单）改了什么

### 知识库
- **维度到底有没有用**：有用。`embeddingModel` + `embeddingDim` 写进这个库，决定它的向量集合结构（写入和检索都按它算），创建后不可改。Nacos `rag_config` 只提供**默认值**（新建时预填），不会覆盖已有知识库；切片长度/重叠/召回条数**只**由 Nacos 决定，界面上不生效——现在已经把这段说明写清楚，不再让人误以为改了会覆盖。
- **上下架**：新增「启用 / 停用」（`PATCH /kbs/{id}/status`）。停用后用户端选这个库会被明确拒绝（"知识库已停用…"），也不会出现在"未选库"的自动检索范围里；管理端照常维护。状态列映射成「已上架 / 已下架」。
- 成员授权抽屉：主体类型与权限同一行；授权对象一行 + 全选/清空；当前授权表改成单行（类型标签 + 名称 + id 前缀可复制），`哈哈?test?` 的问号是占位符被吃掉的 bug，已修成「显示名（账号）」。
- 新增/编辑弹窗文案压缩：图谱说明一行，去掉了与知识库无关的 Nacos 介绍。

### 文档
- 「添加文档」合并成一个按钮 + 下拉（上传本地文件 / 从飞书导入）。
- 来源列映射成中文（本地上传 / 飞书导入 / 接口推送…）。
- 大小统一按 B/KB/MB 展示（详情页原来是 `33,164 B`）。
- 上传：同名文件可以重复上传（原来会去重吞掉）；网络/跨域失败给出可操作提示（不再只显示 `Failed to fetch`）；成功/失败分别统计。
  **根因是两个**：① 预签名 URL 用的是容器内地址 `http://shared-minio:9000`，浏览器解析不到 → 现在新增 `MINIO_PUBLIC_ENDPOINT`，签名改用它（实测浏览器跨域 PUT 返回 200）；② MinIO 没放行浏览器源 → `shared-minio` 加了 `MINIO_API_CORS_ALLOW_ORIGIN`（实测预检 204 且回 ACAO）。
- 切片表：页大小跟随上方选择（50/100/200/500）；质量标记为空时整列不展示；`标题路径` 为空时说明"这份文档没有小节标题"。

### 索引任务
- 批量化成一个「批量操作」下拉（取消 / 删除记录），删除弹窗明确说明：**只删任务记录，不动文档与已写入的向量**。
- 文档列显示文档标题（悬停看 id），任务类型映射成「首次索引 / 重建索引」。
- 「立即刷新」的转圈不再被 5 秒自动刷新带起来（改成手动刷新自己的 loading）。

### 检索策略
- 新建策略的 JSON 默认值改为**按 Nacos rag_config 生成**，字段摊平成引擎实际读的 key（`dense_top_k` / `sparse_top_k` / `top_k` / `fusion` / `rerank` / `graph` / `jev` / `timeout_ms`），不再是一份引擎不认的结构。
- 种子策略名改为「Nacos 默认策略 · rag_config/deal_pilot」，启动时会把老名字（默认混合检索 / Nacos 默认策略（混合检索））自动改过来。
- 结构化表单里 Embedding / Rerank / 图片理解（VL）模型都改成**网关下拉**（按 `mode` 过滤），并补上了 rag_config 里原有的 `image_parser.vl_model_config.name`（保存时会合并回 Nacos，不动其它区块）。
- 去掉重复按钮：顶部只保留「保存 YAML 并发布」，结构化表单用「保存并发布」。

### 平台概览 / 全局
- 概览指标卡与「常用入口」按权限判断：没权限的卡片只显示数字（不可点、不闪烁跳转），提示"没有该页面权限"。
- 「集成健康」详情列现在有内容：组件地址 + 引擎版本/配置来源/向量库状态 + 网关模型数量。
- 侧栏选中态与图标改成中性色（不再整片蓝）。

### 图片链路（之前确实没接）
- 飞书图片：导入时下载 → 落 MinIO（`image_parser.bucket_name`）→ 调网关视觉模型（`image_parser.vl_model_config.name`，提示词取 `image_parser_prompt` 这个 Nacos prompt）→ 把描述写进 `image.caption`；引擎解析时把描述当成可检索文本，token 保留在 meta 里便于回读。
- 单篇最多处理 80 张图（原写死 20，长文档后半段的图会丢）；要调大改 `KH_INTEGRATION_FEISHU_IMAGE_MAX_IMAGES`（对应 `kh.integration.feishu-image-max-images`），超限时引擎日志会记一行"只处理了前 N 张"。任何一步失败只少一条描述，不阻断导入。

## 六、还没做/需要你拍板

1. **权限体系"生产级"标准化**：现在三层（功能权限码 `kb:read`… + 知识库 ACL `read/write/manage` + 可见性）各管一段，但知识库成员里的 `write/manage` 目前**只影响检索可见性，不会真的放开或收紧文档写入按钮**——要做到"授权后按钮才出现"，需要把 KB 级 ACL 接进每个写接口（`DocumentService`/`IndexJobService` 逐个校验 kb 成员）。这是数据模型+权限中间件的改动，建议单独立项做。
2. **Nacos 配置文件到底是哪几份**：现在有两份各司其职——
   - `knowledge-hub.yaml`（`DEFAULT_GROUP`）：引擎自身配置（模型别名、切分、检索、JEV、中间件开关）；
   - `rag_config`（`deal_pilot`）：旧 RAG 栈的参数（`image_parser`、`embedding_model`、`splitter`、`milves_stores`、`retriever/reranker`），管理台读取它来填默认值。
   沙箱/网关/链路配置不在这两份里（在 `.env` 与 LiteLLM/Langfuse 自己那边）。要不要合并成一份，你定，我可以做迁移脚本。
3. **用户端按标签检索**：现在标签过滤只在检索调试台生效。用户端加"标签"入口的话，建议按角色默认一组标签（客服=对外口径），需要你确认交互再动。

## 七、这一轮（用户端 + 管理端细节）的判断与结论

| 你问的 | 结论 / 落地 |
| --- | --- |
| 用户端知识库列表要不要显示已停用的库 | 不显示。列表只给启用中的库；万一服务端仍拒绝（例如刚被下架），错误按后端原话提示「知识库「X」已停用，请换一个库或在管理端重新启用」，不再只弹一个通用错误 |
| 知识库多选要不要全选 | 要。选择器底部加「全选 / 清空」，选一项不收起；停用库不进列表 |
| 黄金价格这类问题为什么先走知识库 | 之前 router 只有 retrieve / direct 两条路，问什么都先检索一次再判断。现在加了第三条 `agent`：实时行情、公开网页、制作类任务直接交主 Agent（带 web_search / fetch_url / Skill），不再空跑一次企业库检索；用户显式选了知识库时仍然强制检索该范围（有单测覆盖） |
| 中断后继续/重答用哪个模型 | 用**会话记录的模型**（发第一条时就定下来了），不是输入框里还没发出去的草稿选择。消息尾部会写「标准模型 · chat-standard」这类标签，方便核对 |
| 用户端要不要标签 | 建议不做成用户可选。理由：ACL 已经按身份过滤，再叠一层标签只会让用户困惑"为什么这个库看不到"。标签留给管理端做检索调试/运营口径（若以后要"客服只看对外口径"，用角色默认标签实现更好，见第六节第 3 条） |
| 上游凭证能不能改 | 不能，也不该在管理台改。凭证是网关的资产，改它要过网关自己的账号体系；后台只读展示凭证名/provider/apiBase + 掩码 key，改请点右上角「LiteLLM 网关」 |
| 虚拟密钥是什么 | 网关发给调用方的 API Key（平台后端、外部系统都用它计费/限流）。列表只回显哈希前缀 + 别名 + 已用金额/预算；明文只在创建时给一次 |
| 会话审计保留多久 | 现在**不自动清理**（只增不改）。按常规做法建议：审计日志 ≥ 180 天、对话记录 ≥ 90 天（等保要求通常 6 个月）。要的话我加一个按天清理的定时任务 + 界面上标注保留期 |
| 评测与 Langfuse 联通 | 现在评测运行的 trace 进 Langfuse（可在链路里看），但**数据集本身没同步到 Langfuse 的 Dataset**。要做需要接 Langfuse Datasets API（建 dataset / 建 dataset item / 建 run），我可以补，属于新增集成 |
| Agent 的 production 标签为什么改不了 | **已修**：Nacos 3.2 的接口是 `PUT /v3/admin/ai/agentspecs/labels`，参数是整份 `labels` JSON（`{"production":"0.0.4"}`），不是 `/agentspecs/label`（那个 404）。后台现在能一键「设为 production」并让引擎 reload；`latest` 会先读出来再合并，不会被抹掉。

## 八、这一轮又补上的（都在上面那批问题里）

| 问题 | 落地 |
| --- | --- |
| 铃铛"每次刷新都是 5 条、已读是假的" | 根因：已读状态按 `user.id` 存 localStorage，但首帧 user 还没加载，key 变成 `:anon` 且再也不重读 → 刷新必回未读。改成"key 变了就重新读"，点任一条 = 整批已读（不再一条条点） |
| 索引任务选已完成的行还能批量取消 | 选中行状态存快照，`取消任务` 按"选中的排队/执行中数量"显示并按需禁用；筛选框改为按文档标题或 ID 过滤 |
| 额度没有编辑/删除 | 表格加「编辑」（回填表单）与「撤销」（`DELETE /api/v1/admin/chat-quota`，撤销后回落上一层规则） |
| 评测一次只能跑一个数据集 | 发起评测表单改多选，`POST /api/v1/eval/runs` 支持 `datasetIds[]`，每个数据集各出一条运行记录 |
| 数据集导入 CSV 解析错（`input,expected_output,metadata`） | 换成尊重双引号的分隔符解析（长答案里的逗号不再拆列），表头识别扩到 input/expected_output/question/answer，并按列名自动猜"问题列/期望答案列"，仍可手动改 |
| 检索策略：两个保存按钮、重新获取没反应、不能停用 | 上方只留「重新获取」（清空草稿后重拉）；结构化表单按钮改「合并并发布」；YAML 默认只读，点「编辑 YAML」才出现第二个按钮；操作列加「停用」（`POST /retrieval-profiles/{id}/disable`，最后一条已发布策略不允许停用），状态映射补 `已停用` |
| 知识库删除后说"只能让运维改数据库恢复" | 加回收站：`GET /kbs/deleted` + `POST /kbs/{id}/restore`，页面右上角「回收站」可一键恢复（恢复后是已下架，要重新上架才会被检索） |
| 文档详情看不到原文/知识库显示 ID | 顶部加「查看原文」（预签名地址 + 解析后正文，200KB 截断提示）；知识库名取不到时显示"知识库已删除"而不是裸 ID；版本下拉改 `v{序号} · 生效中/已发布` |
| 菜单管理：状态与侧栏混在一起、分组不能排序 | 拆成两个开关——`状态`（停用=侧栏不出现且路由被挡）、`侧栏`（隐藏=只是不显示，路由仍可访问）；分组标题上加上移/下移；新增/编辑弹窗两个开关都在 |
| 图片链路单篇只有 20 张 | 默认提到 80，可用 `kh.integration.feishu-image-max-images` 调，超限打日志 |
| 检索 Agent 有 web_search，为什么还说交给主 Agent | 描述改准：主 Agent 自己没有 web_search，它是委派检索 Agent（工具在那边）或直接用 Skill。JEV 的 `agent` 分支语义不变 |



## 九、这一轮（管理端完整测试反馈）落地情况

| 问题 | 落地 |
| --- | --- |
| `task` 是不是 LangChain 中间件给的 | 不是。这个项目的 Agent 运行时是自己写的（`agent/src/knowledge_hub/runtime/agent.py`），`task` 是我们自己注册的委派工具；为了让"模型不返回 function_call、只吐 `<task>{...}</task>` 文本"的网关也能用，同时支持 `<task>{...}</task>` / `[task={...}]` / `{"tool": "web_search", ...}` 三种内联写法 |
| 重索引有没有对比哈希 | 有。`document_version.fingerprint = sha256(内容哈希 + 切片模板 + embedding 模型/维度 + 默认策略 + PIPELINE_VERSION)`，一致就 `skipped=true` 秒回，不重复向量化；文档列表「重索引」旁新增「强制」按钮（`?force=true`）才无条件重建 |
| 切片块类型全是"正文段落" | 根因两个：① 飞书导入落盘的 objectKey 用标题命名、没有扩展名，按后缀分发时走了纯文本解析，整篇 JSON 变成 1 个 paragraph；② 真实飞书 openapi 把内容放在块**顶层**（`heading1`/`text`/`table`），代码只读 `raw` 这一层，于是标题空串、表格空单元格。两处都修了，强制重索引后 `kind` 正确输出 `table`（`tableRowIndex` 1..8、`chunkCount` 8）、`paragraph`，`title_path` 也有层级 |
| 表格被当成"导航文本"整块丢掉 | `is_navigation_text` 的符号密度启发式把 `\| a \| b \|` 判成菜单。现在只对 paragraph/list 生效，table/code/image 不受影响 |
| 审计：操作人、动作、变更前/后看不懂 | 动作码补齐（`kb.purge`/`kb.restore`/`doc.move`/`profile.*`/`graph.unselect`/`profile.trace.delete`…）；`before/after` 改成「字段 → 变更前 → 变更后」对照表，`user:<uuid>` 翻成「用户 · 张三」、裸 UUID 翻成「名称（前 8 位）」；引擎回调没有操作人时显示"系统（引擎回调）" |
| 平台集成：内容没改也能发新版本 | 前后端都拦：前端「发布新版本」在「与线上比对未改动」时 disable；后端 `saveAgent` / `savePrompt` 与线上逐字段比对，一致直接 400「内容和线上（x.y.z）一致，没有需要发布的新版本」 |
| 平台集成：改了 AGENTS.md 发布后 Nacos 没变 | 保存链路本身是通的（`draft → submit` 会产生 reviewing 版本，`publish` 才推到 latest），之前缺的是"切 production"。现在版本历史里每个已发布版本都有「设为 production」，切完立刻 reload 引擎 |
| Langfuse 最近调用看不出链路 | 拉 `parentObservationId`，按 `traceId` 折叠成树：父行是整条链路（步数/总耗时/总 tokens/总成本），展开是各步骤 |
| 额度覆盖卡片高度没对齐 | 三个卡片 `height: 100%`，覆盖数那张补了等高占位行 |
| 检索策略：按钮/回收站/默认标签/停用不能编辑 | 「重新发布」→「发布」；「调试」→「删除」（软删进回收站）；去掉策略名后的「默认」标签；已发布才禁止编辑，停用可继续编辑；新增回收站（恢复 / 彻底删除 / 清空）；调试记录支持单选/批量删除 |
| 引擎决策模型和 rag_config 分两处 | 合并成一张卡：聊天模型 `llm.chat_model`、JEV `jev.model` 与切片/检索字段一起「合并并发布」，后端同时写 `rag_config` 和 `knowledge-hub.yaml`（引擎两处都读），写完 reload |
| 调试台还要选 TopK | 去掉。最终 k 已经在策略的 `top_k` 里，调试台只负责选策略/知识库/标签/问题 |
| 评测：重复新建、表格挤压、缺期望文档列 | 左侧数据集卡片去掉重复的「新建」；用例表固定列宽 + 横向滚动 + 问题/答案三行省略号带 tooltip；导入用例新增「期望命中文档列」，按标题匹配成文档 ID；发起评测自动带上左侧已选数据集，策略下拉只列已发布（启用）的 |
| 图谱：精选表格被压缩、`selected` 没映射、不能取消 | 表格 `scroll.x` + 文档标题映射（不再显示裸 ID）+ 抽取状态映射（`selected`→已选中）；新增「取消精选」（`DELETE /api/v1/graph/documents`，只清精选记录与 `graph_selected`，已抽实体保留）；构建结果卡片写清用的是网关 `llm.chat_model`，不需要额外配置 |
| 通知铃铛"每次都是 5 条" | 后端按文档/动作去重（同一文档反复失败只留最新一条），前端角标改成与面板一致的 `visibleUnread`（「清空」后才真的归零），每条显示真实发生时间，并加「审计日志」直达 |
| 菜单停用后直接敲 URL 还能进 | 守卫用精确匹配（`matchedKey`），匹配不上就 `null` → 跳第一个可用页。实测停用 `/overview` 后访问 `/overview` 会被切到 `/kbs` |

## 十、系统提示词盘点（哪些该搬 Nacos）与后续可做项

### 10.1 现在写死在代码里的提示词

| 位置 | 变量 | 作用 | 建议 |
| --- | --- | --- | --- |
| `agent/src/knowledge_hub/engine/prompts.py` | `GROUNDING_RULES` | 引用规则（只能依据 `<untrusted_context>`、`[cN]` 标注、拒绝注入） | **不要搬**。这是安全边界，必须跟着代码走，Nacos 里能被改掉就等于后门 |
| `agent/src/knowledge_hub/engine/prompts.py` | `DEFAULT_PERSONA` / `SYSTEM_PROMPT` | 锁定知识库时的默认人设 | 可搬：`kh-persona-default`（Nacos 缺失时回落到这里） |
| `agent/src/knowledge_hub/engine/prompts.py` | `DIRECT_RULES` / `_CAVEAT_INSTRUCTION` | 无知识库直答规则、资料不足提示 | 可搬：`kh-direct-rules`、`kh-caveat` |
| `agent/src/knowledge_hub/runtime/middleware.py` | `_PLAN_SYSTEM` | 规划器（goal/needs_retrieval/steps） | 可搬：`kh-plan`，改完立刻生效，不用重启引擎 |
| `agent/src/knowledge_hub/runtime/middleware.py` | `_REVIEW_SYSTEM` | 质检员（是否编造/泄露） | 可搬：`kh-review`。注意里面「已知事实 = 工具结果 + 预检索材料」这句不能丢，丢了会把正确的知识库事实判成编造 |
| `agent/src/knowledge_hub/decision/jev.py` | `_SYSTEM_PROMPT` | JEV 决策器（只能选给定候选） | **半搬**：候选枚举与 JSON Schema 留在代码（结构约束），只有「怎么选」的倾向性描述放 `kh-jev` |
| `agent/src/knowledge_hub/runtime/agent.py` | `_initial_context_prompt()` | 把预检索材料拼进用户消息 | 保留在代码，跟流水线强耦合 |
| `skills/*/SKILL.md` | 各 Skill 正文 | 制作类任务 | 已在 Nacos 侧可管理，保持 |

结论：**真正值得搬的一共 5 个 key**：`kh-persona-default`、`kh-direct-rules`、`kh-caveat`、`kh-plan`、`kh-review`（外加 `kh-jev` 的描述段）。落地方式建议：`config/nacos_ai.py` 里加 `text_prompt(key, fallback)`，进程内 60 秒缓存 + Nacos 配置监听清缓存，取不到就用代码里的字符串。这样 Nacos 挂了、或者 key 被误删，行为与今天一致。

### 10.2 对齐本项目的 RAG 系统，Nacos 里建议这样写

- `main_agent`：**不要**让它自己调 `milvus_search`。检索只有两条路——① 用户锁了知识库 → 引擎确定性链路（稠密+稀疏 → RRF → 重排 → 带引用作答）；② 没锁 → 引擎先跑一次 3 条预检索把材料注入，再交给 `main_agent`。所以 `main_agent` 的 tools 保持 `ask_user_question / get_current_time / deploy` 即可，职责是「派活 + 落笔」。
- `retrieve_agent`：保留 `milvus_search / milvus_query / fetch_url / web_search / get_bucket_file_url / get_current_time`。它的提示词里已经声明 `milvus_query` 的结构化补查（按 `node_token` + `revision_id` + `block_id` 读父块/引用块），这块字段现在齐全了，可以真正用起来。
- `web_search` 被拦截：不是工具不可用，是 `retrieve_agent` 那条 `<task>` 委派被当成「模型输出可疑文本」掐掉了（`<task>` 是文本协议，不是 function_call）。已放宽：`<task>` 块只做解析、不参与安全拦截。
- 黄金价格这类实时问题：没有知识库命中是**预期行为**（企业库里没有实时行情），正确路径是回到主 Agent → 委派 `retrieve_agent` → `web_search`。库里没有对应内容时不该报 `RETRIEVAL_UNAVAILABLE`。

### 10.3 还差什么/可以继续优化（按性价比排序）

1. **评测数据集 ↔ Langfuse Dataset 双向同步**：现在只有 trace 进 Langfuse。要接 Datasets API（建 dataset / item / run），评测跑完把每个用例的 input/expected 与实际 output 关联到 dataset run。
2. **审计 180 天 / 对话 90 天自动清理**：现在不清理，库会一直涨。加一个 `@Scheduled` 每天凌晨按 `created_at` 归档/删除，界面上标注保留期。
3. **全站 tag 视觉收口**：状态类（成功/失败/停用）与语义类（分组、标签）目前混用同一套 `color="green|blue"`，建议一次性定义 design token：状态只用「浅底 + 深字 + 圆点」，语义标签用中性灰蓝且不带底色。
4. **图片理解链路**：现在图片只 `[图片] 章节` 占位 + 存 MinIO 拿 URL。要真正可用得接 VLM 生成图注再入库（可复用网关的多模态模型），否则图相关问题只能靠周边文字。
5. **图谱构建**：当前只做「精选文档 → 实体抽取 → Neo4j」，检索侧 `graph` 开关默认关。要么接进召回并在 rerank 之后做一跳扩展，要么先保持关闭，别在 UI 上暗示它生效。
6. **多轮上下文压缩**：`MAX_HISTORY_TURNS=4` 是硬截断，长对话会丢前文。建议超阈值时用便宜模型摘要成一段「会话纪要」再拼。
7. **其它格式上传**：飞书、本地 md/txt/pdf/docx 都通了；xlsx/pptx/图片型 PDF（需 OCR）还没有。要支持得加解析器 + 队列优先级。

## 十一、图谱 / 评测 / 会话这一轮的落地

| 问题 | 落地 |
| --- | --- |
| 点「构建图谱」说成功但没效果 | 三个真 bug 叠加：① 后端只把 kbId + 文档 id 传给引擎，引擎 `build()` 需要切片正文，直接回 `not_implemented`；② 后端 30s 超时，而一篇文档一次 LLM 抽取，十几篇必然超时；③ 网关不支持 `response_format=json_schema`，抽取调用 400 后被静默吞掉，实体永远是 0。现在：引擎自己回 Milvus 读切片（`/v1/graph/build` 带 `collection_name`），超时提到 300s，`chat_json` 按 json_schema → 工具调用 → json_object → 纯提示 四级降级（`chat-standard` 走的是工具调用） |
| 图谱不展示已构建效果 / 每次都要选库 | 页面默认「全部知识库」，顶部四张统计卡（精选/已抽取/实体/关系），表格显示标题而不是 UUID；构建结果从原始 JSON 改成「文档/切片/实体/关系 + 状态」，成功后自动刷新列表与统计 |
| 抽取状态 building 一直挂着 | 构建失败时不写收尾状态（之前永远停在 building）。现在按每篇文档回写 extracted/skipped/failed 并带 `last_error`；超过 15 分钟的 building 在列表里自愈成「待抽取」，同文档的重复精选记录也会顺手清掉 |
| 为什么「来源」有两个（稠密 + 稀疏） | 同一个切片被两路都召回就会显示两个标签，RRF 会把两路分数相加，所以它排得更前——这是正常的。表头已加提示 |
| 调试台右上角「刷新 Trace」| 去掉（下方 Trace 卡片自己有刷新）；「问题」+「执行检索」单独占一行 |
| 策略与 Nacos 显示 10 处不一致 | 根因是表单还没填充时 `Form.useWatch` 返回空对象，拿空值去比就报十处不同。现在没填好就不比较；真正的对比还是只比引擎读的那套扁平键 |
| 想把已发布策略同步到 Nacos | 「Nacos rag_config」卡右上角新增「从已发布策略导入」：只覆盖 dense/sparse/top_k/fusion/rerank/graph/timeout 与 `retriever.k`，图片解析与集合配置原样保留，写完立刻 reload 引擎 |
| 提示词抽屉没有 production/latest 提示 | 补上和 Agent 一样的「线上版本落后」提示 + 两个标签 |
| 评测只跑了检索，没有评「回答」 | 引擎新增 `POST /v1/answer`（非流式，复用同一条 chat 链路）；评测对每条用例同时记录命中文档、真实回复、与期望答案的字符二元组 F1（≥0.5 记通过）；指标拆成文档命中率 / 答案准确率 / 有答案率，明细四列都摊开展示 |
| 评测没有回收站 | 数据集与运行记录都改软删除（`deleted_at`，V10），回收站里可单条恢复/彻底删除，也能一键清空 |
| 排队消息切会话后发错地方 | 排队状态从全局字符串改成 `{sessionKey, text}`，只有回到那个会话且它不在回答中才自动发送；切走时提示「另一会话还有一条排队」并可放弃 |
| 停止后留下空白气泡 | `status=stopped` 且没有内容时改为一行灰字「已停止，这次没有生成内容」，不再渲染空卡片 |
| 刷新后思考链消失 | 后端收流时累计 `status` 阶段的步骤并落库（`message.reasoning_steps`，V11），消息列表返回 `steps`，前后端都按标签去重，刷新前后步数一致 |
| 长对话压缩 | 新增 `engine/history.py`：超过 14 条消息时把较早部分交给模型压成 ≤400 字纪要（Redis 按会话缓存，避免每轮重算），最近 8 条原样保留；摘要以 system 消息注入并标注「可能不完整」；摘要失败自动退回原始历史 |
| A400 图片块还显示「正文段落」 | 老数据是在解析修复之前建的索引。`PIPELINE_VERSION` 升到 `chunk-structure-v3`，所有历史文档的指纹自动失效，点「重建索引」即可得到 image 块（强制重建已验证：`kind=image` 两条） |
| `knowledge-hub.yaml` 里 `retrieval.graph.enabled: true`，rag_config 里是 false，到底谁生效 | 引擎的 `settings.app.retrieval`（含 graph.enabled）来自 **knowledge-hub.yaml**；rag_config 那份是管理端展示 + 卡片表单，请求时真正生效的是「检索策略 JSON」被当作 profile 传下去。所以：策略里的 `graph.enabled` 决定这次检索走不走向量+图，图谱页只决定「抽不抽」。两处矛盾时以策略为准 |

## 十二、图谱查询 / 融合模式 / Nacos 提示词（本轮已落地）

| 问题 | 根因 | 修复 | 验证 |
| --- | --- | --- | --- |
| 图谱查询永远 0 实体 / 0 关系 | `GraphQueryResult.entities/relations` 从未填过，只返回 evidence 切片 id | `Neo4jGraphStore.describe()`：向量命中种子实体 + 1..hops 邻居 + 关系，回填到 query 结果 | `A400 推理卡 内存 一线城市` → 34 实体 / 40 关系 / 32 证据切片 |
| 图谱页文档列被挤扁 | 文档列无宽度 + 横向滚动只给了 640 | 文档列 320px、横向 940、标题 ellipsis 290 | tsc 通过 |
| 点建构后不知道什么时候完成 | 列表不轮询 | 有 `building/pending` 时 3s 自动刷新，汇总 5s | 页面行为 |
| 图谱查询结果看不懂 | 实体只展示名称 + `confidence`（后端不这个字段） | 实体：名称/类型/说明/命中或邻居 + 匹配度；关系：两端实体 → 类型 | 同上 |
| 「4 个知识库可用」表述不对 | 拿全部库数当“可查” | 改成显示当前可查的库名 | 页面 |
| 融合策略第三种「模型模式」没实现 | 引擎只认 rrf，profile 的 `fusion` 字串被忽略 | `fusion in {model,rerank}` 强制走重排；`rerank.top_n` 改为优先读策略 | 新增 2 个单测，252 passed |
| rag_config 卡片字段不分层 | 不管选什么都把重排/图字段摆出来 | 模型模式才出「重排保留数」；开了重排才出 top_n；开了图才出跳数 | tsc 通过 |
| 图片图注回退到普通聊天模型 | 上一轮判断错了：chat-* 不是视觉模型 | 删掉 fallback，只用 `image_parser.vl_model_config`；失败就保留占位不假造 | 4 个单测 |
| kh-* 提示词在 Nacos 没被引擎读 | 引擎没有读取通道 | 新增 `config/nacos_ai.text_prompt(key, fallback)`，60s 缓存 + 失败回退 | 容器内实测：persona/direct/caveat/jev 命中 Nacos；`kh-grounding-rules` 未创建→用兜底 |

### 仍未完成（下一轮）

1. Langfuse Dataset run 记录仍未出现（dataset/item 已同步）——需逐个验证 `/api/public/ingestion` 与 `/dataset-run-items` 的响应与鉴权。
2. 图谱构建的「取消」：引擎建图是单次 HTTP 作业，真正可中断需要任务队列 + job id，不建议只做前端假取消。
3. 「精选文档」的取消精选已支持，但构建中行的「取消抽取」待上面的任务队列一起做。

