package com.knowledgehub.config;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.integration.platform.GatewayConsoleClient;
import com.knowledgehub.integration.platform.LangfuseConsoleClient;
import com.knowledgehub.integration.platform.NacosConsoleClient;
import com.knowledgehub.integration.config.KhIntegrationProperties;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 平台集成控制台：把散在 Nacos / LiteLLM / Langfuse 的配置收进管理后台。
 *
 * <p>定位是"看得见、改得动"：Agent（含 AGENTS.md 与 link_prompts）、Prompt、Skill、
 * 网关模型与虚拟密钥、线上真实调用记录，都在这里管理，不用再切到各家控制台。
 */
@RestController
@RequestMapping("/api/v1/admin/platform")
@RequirePermission(PermissionCatalog.PROFILE_MANAGE)
public class PlatformConsoleController {
    private final NacosConsoleClient nacos;
    private final GatewayConsoleClient gateway;
    private final LangfuseConsoleClient langfuse;
    private final KhIntegrationProperties props;
    private final com.knowledgehub.integration.engine.RagEngineClient engine;
    private final com.knowledgehub.retrieval.service.RetrievalProfileService retrievalProfileService;

    public PlatformConsoleController(NacosConsoleClient nacos, GatewayConsoleClient gateway,
                                     LangfuseConsoleClient langfuse, KhIntegrationProperties props,
                                     com.knowledgehub.integration.engine.RagEngineClient engine,
                                     com.knowledgehub.retrieval.service.RetrievalProfileService retrievalProfileService) {
        this.nacos = nacos;
        this.gateway = gateway;
        this.langfuse = langfuse;
        this.props = props;
        this.engine = engine;
        this.retrievalProfileService = retrievalProfileService;
    }

    // ------------------------------------------------------------------ agent
    @GetMapping("/agents")
    public ApiResponse<List<Map<String, Object>>> agents() {
        return ApiResponse.ok(nacos.agents());
    }

    @GetMapping("/agents/{name}")
    public ApiResponse<Map<String, Object>> agent(@PathVariable String name) {
        return ApiResponse.ok(io(() -> nacos.agent(name)));
    }

    public record AgentSaveRequest(String description, String content, String instruction) {
    }

    @PutMapping("/agents/{name}")
    public ApiResponse<Map<String, Object>> saveAgent(@PathVariable String name,
                                                     @RequestBody AgentSaveRequest request) {
        return ApiResponse.ok(io(() -> nacos.saveAgent(name, request.description(), request.content(),
                request.instruction())));
    }

    /** 上线 / 下线：对齐 Nacos 的 enable 开关，不需要去控制台点。 */
    @PostMapping("/agents/{name}/online")
    public ApiResponse<Map<String, Object>> setAgentOnline(@PathVariable String name,
                                                           @RequestBody(required = false) Map<String, Object> body) {
        boolean online = body == null || body.get("online") == null
                || Boolean.parseBoolean(String.valueOf(body.get("online")));
        return ApiResponse.ok(io(() -> nacos.setAgentOnline(name, online)));
    }

    /**
     * 发布某个已审核版本（Nacos 的 publish）：发布后 latest 指向该版本，
     * 引擎下一次加载就会用新的配置。审核（submit）仍然在保存时触发，不跳过审批。
     */
    @PostMapping("/agents/{name}/publish")
    public ApiResponse<Map<String, Object>> publishAgent(@PathVariable String name,
                                                         @RequestBody(required = false) Map<String, Object> body) {
        String version = body == null || body.get("version") == null ? "" : String.valueOf(body.get("version"));
        return ApiResponse.ok(io(() -> nacos.publishAgent(name, version)));
    }

    /**
     * 切换 Agent 的版本标签（production / latest）。
     *
     * <p>只能在版本被发布（status=online）之后做，否则引擎会加载一个还没走完审核的版本；
     * 这个限制在 {@link NacosConsoleClient#setAgentLabel} 的调用方（前端）里体现，服务端再兜一层。
     */
    @PostMapping("/agents/{name}/label")
    public ApiResponse<Map<String, Object>> setAgentLabel(@PathVariable String name,
                                                          @RequestBody Map<String, Object> body) {
        String label = body.get("label") == null ? "production" : String.valueOf(body.get("label"));
        String version = body.get("version") == null ? "" : String.valueOf(body.get("version"));
        return ApiResponse.ok(io(() -> {
            Map<String, Object> result = new LinkedHashMap<>(nacos.setAgentLabel(name, label, version));
            // 标签切换后引擎必须重读，否则还是旧提示词
            result.put("reloaded", reloadEngine());
            return result;
        }));
    }

    // ----------------------------------------------------------------- prompt
    @GetMapping("/prompts")
    public ApiResponse<List<Map<String, Object>>> prompts() {
        return ApiResponse.ok(nacos.prompts());
    }

    @GetMapping("/prompts/{key}")
    public ApiResponse<Map<String, Object>> prompt(@PathVariable String key) {
        return ApiResponse.ok(io(() -> nacos.prompt(key)));
    }

    public record PromptSaveRequest(String template, String description) {
    }

    @PutMapping("/prompts/{key}")
    public ApiResponse<Map<String, Object>> savePrompt(@PathVariable String key,
                                                       @RequestBody PromptSaveRequest request) {
        return ApiResponse.ok(io(() -> nacos.savePrompt(key, request.template(), request.description())));
    }

    /** Prompt 历史版本（version + status：online / reviewed / draft） */
    @GetMapping("/prompts/{key}/versions")
    public ApiResponse<List<Map<String, Object>>> promptVersions(@PathVariable String key) {
        return ApiResponse.ok(io(() -> nacos.promptVersions(key)));
    }

    /** 发布指定版本：和 Nacos 控制台的"发布"是同一个动作 */
    @PostMapping("/prompts/{key}/publish")
    public ApiResponse<Map<String, Object>> publishPrompt(@PathVariable String key,
                                                          @RequestBody(required = false) Map<String, Object> body) {
        String version = body == null || body.get("version") == null ? "" : String.valueOf(body.get("version"));
        return ApiResponse.ok(io(() -> nacos.publishPrompt(key, version)));
    }

    /** 切换版本标签（production / latest），对齐 Nacos 的标签切换 */
    @PostMapping("/prompts/{key}/label")
    public ApiResponse<Map<String, Object>> setPromptLabel(@PathVariable String key,
                                                           @RequestBody Map<String, Object> body) {
        String label = body.get("label") == null ? "production" : String.valueOf(body.get("label"));
        String version = body.get("version") == null ? "" : String.valueOf(body.get("version"));
        return ApiResponse.ok(io(() -> nacos.setPromptLabel(key, label, version)));
    }

    // ------------------------------------------------------------------ skill
    @GetMapping("/skills")
    public ApiResponse<List<Map<String, Object>>> skills() {
        return ApiResponse.ok(nacos.skills());
    }

    @GetMapping("/skills/{name}")
    public ApiResponse<Map<String, Object>> skill(@PathVariable String name) {
        return ApiResponse.ok(io(() -> nacos.skill(name)));
    }

    // ---------------------------------------------------------------- gateway
    @GetMapping("/gateway/models")
    public ApiResponse<List<Map<String, Object>>> gatewayModels() {
        return ApiResponse.ok(gateway.models());
    }

    @GetMapping("/gateway/keys")
    public ApiResponse<List<Map<String, Object>>> gatewayKeys() {
        return ApiResponse.ok(gateway.keys());
    }

    /** 上游供应商凭证（LiteLLM UI 的 Configured credentials），只读展示，值已掩码 */
    @GetMapping("/gateway/credentials")
    public ApiResponse<List<Map<String, Object>>> gatewayCredentials() {
        return ApiResponse.ok(gateway.credentials());
    }

    /** 调用成本：按模型与按天（逐请求明细在 LiteLLM UI 内，需其独立账号） */
    @GetMapping("/gateway/spend")
    public ApiResponse<Map<String, Object>> gatewaySpend(@RequestParam(defaultValue = "14") int days) {
        return ApiResponse.ok(gateway.spend(days));
    }

    // ---------------------------------------------------------------- langfuse
    @GetMapping("/langfuse/traces")
    public ApiResponse<Map<String, Object>> langfuseTraces(@RequestParam(defaultValue = "20") int limit) {
        return ApiResponse.ok(langfuse.overview(limit));
    }

    // ------------------------------------------------- 引擎配置（中间件开关）
    /**
     * 引擎自身配置（`knowledge-hub.yaml`）：模型别名、切分、检索、JEV、中间件开关。
     * 管理台只暴露"开关"这类需要经常调的字段，其余仍以 Nacos 里的文件为准。
     */
    @GetMapping("/agent-config")
    public ApiResponse<Map<String, Object>> agentConfig() {
        return ApiResponse.ok(io(() -> {
            Map<String, Object> payload = nacos.rawConfig(props.getNacosAgentConfigDataId(),
                    props.getNacosAgentConfigGroup());
            String content = String.valueOf(payload.getOrDefault("content", ""));
            Map<String, Object> parsed = parseYaml(content);
            Map<String, Object> agent = section(parsed, "agent");
            Map<String, Object> switches = new LinkedHashMap<>();
            switches.put("plan", agent.getOrDefault("plan_enabled", true));
            switches.put("review", agent.getOrDefault("review_enabled", true));
            switches.put("securityScan", agent.getOrDefault("security_scan_enabled", true));
            // 模型别名也回显：聊天模型与 JEV 决策模型都可能被换成网关里的专用别名
            Map<String, Object> llm = section(parsed, "llm");
            Map<String, Object> jev = section(parsed, "jev");
            Map<String, Object> models = new LinkedHashMap<>();
            models.put("chat", resolvePlaceholder(String.valueOf(llm.getOrDefault("chat_model", ""))));
            models.put("jev", resolvePlaceholder(String.valueOf(jev.getOrDefault("model", ""))));
            Map<String, Object> result = new LinkedHashMap<>(payload);
            result.put("switches", switches);
            result.put("models", models);
            result.put("agentName", agent.getOrDefault("name", ""));
            result.put("agentLabel", agent.getOrDefault("label", ""));
            return result;
        }));
    }

    /** 只合并 agent.* 开关与 llm/jev 的模型别名，不覆盖文件里其它内容；改完立即让引擎 reload 生效。 */
    @PutMapping("/agent-config/switches")
    public ApiResponse<Map<String, Object>> saveAgentSwitches(@RequestBody Map<String, Object> switches) {
        return ApiResponse.ok(io(() -> {
            Map<String, Object> payload = nacos.rawConfig(props.getNacosAgentConfigDataId(),
                    props.getNacosAgentConfigGroup());
            Map<String, Object> parsed = new LinkedHashMap<>(parseYaml(
                    String.valueOf(payload.getOrDefault("content", ""))));
            Map<String, Object> agent = mutableSection(parsed, "agent");
            putIfPresent(agent, "plan_enabled", switches.get("plan"));
            putIfPresent(agent, "review_enabled", switches.get("review"));
            putIfPresent(agent, "security_scan_enabled", switches.get("securityScan"));
            putIfPresent(mutableSection(parsed, "llm"), "chat_model", switches.get("chatModel"));
            putIfPresent(mutableSection(parsed, "jev"), "model", switches.get("jevModel"));
            String merged = new Yaml().dump(parsed);
            Map<String, Object> published = nacos.publishConfig(props.getNacosAgentConfigDataId(),
                    props.getNacosAgentConfigGroup(), merged);
            Map<String, Object> result = new LinkedHashMap<>(published);
            result.put("content", merged);
            result.put("reloaded", reloadEngine());
            return result;
        }));
    }

    /** 让引擎重新读一遍 Nacos（失败不影响配置已发布这件事，只回报状态）。 */
    private boolean reloadEngine() {
        try {
            return engine != null && engine.reloadConfig() != null;
        } catch (RuntimeException ex) {
            return false;
        }
    }

    // ------------------------------------------------------- rag_config（Nacos）
    /**
     * 既有 RAG 栈的 rag_config：切片长度、Embedding 模型与维度、检索参数都从这里来。
     * 管理台新建知识库时用它当默认值，避免"界面写死一个、引擎读另一个"。
     */
    @GetMapping("/rag-config")
    public ApiResponse<Map<String, Object>> ragConfig() {
        return ApiResponse.ok(io(() -> {
            Map<String, Object> payload = nacos.rawConfig(props.getNacosRagConfigDataId(),
                    props.getNacosRagConfigGroup());
            String content = String.valueOf(payload.getOrDefault("content", ""));
            Map<String, Object> parsed = parseYaml(content);
            payload.put("parsed", parsed);
            payload.put("defaults", kbDefaults(parsed));
            return payload;
        }));
    }

    @PutMapping("/rag-config")
    public ApiResponse<Map<String, Object>> publishRagConfig(@RequestBody RagConfigRequest request) {
        return ApiResponse.ok(io(() -> nacos.publishConfig(props.getNacosRagConfigDataId(),
                props.getNacosRagConfigGroup(), request.content())));
    }

    public record RagConfigRequest(String content) {
    }

    /**
     * 结构化保存：表单里改几个字段，合并进现有 rag_config 再发布，
     * 不覆盖文件里其它区块（比如 image_parser / milves_stores）。
     *
     * <p>模型别名（聊天模型 / JEV 决策模型）也在这里一起下发：引擎两处都读，
     * 只写一处就会出现"界面上改了、实际没生效"。写完立刻让引擎 reload。
     */
    @PutMapping("/rag-config/structured")
    public ApiResponse<Map<String, Object>> saveRagConfigStructured(@RequestBody Map<String, Object> fields) {
        return ApiResponse.ok(io(() -> {
            Map<String, Object> payload = nacos.rawConfig(props.getNacosRagConfigDataId(),
                    props.getNacosRagConfigGroup());
            String content = String.valueOf(payload.getOrDefault("content", ""));
            Map<String, Object> parsed = new java.util.LinkedHashMap<>(parseYaml(content));
            applyStructured(parsed, fields);
            String merged = new Yaml().dump(parsed);
            Map<String, Object> published = nacos.publishConfig(props.getNacosRagConfigDataId(),
                    props.getNacosRagConfigGroup(), merged);
            Map<String, Object> result = new java.util.LinkedHashMap<>(published);
            result.put("content", merged);
            // 模型别名同时写进 knowledge-hub.yaml：生产 Agent 的模型选择以那份文件为准
            if (fields.get("chatModel") != null || fields.get("jevModel") != null) {
                Map<String, Object> agentPayload = nacos.rawConfig(props.getNacosAgentConfigDataId(),
                        props.getNacosAgentConfigGroup());
                Map<String, Object> agentParsed = new LinkedHashMap<>(parseYaml(
                        String.valueOf(agentPayload.getOrDefault("content", ""))));
                putIfPresent(mutableSection(agentParsed, "llm"), "chat_model", fields.get("chatModel"));
                putIfPresent(mutableSection(agentParsed, "jev"), "model", fields.get("jevModel"));
                String agentMerged = new Yaml().dump(agentParsed);
                nacos.publishConfig(props.getNacosAgentConfigDataId(),
                        props.getNacosAgentConfigGroup(), agentMerged);
                result.put("agentContent", agentMerged);
                result.put("reloaded", reloadEngine());
            }
            return result;
        }));
    }

    /**
     * 把一条「已发布」检索策略同步进 Nacos rag_config。
     *
     * <p>策略和 rag_config 原本是两份互不相干的配置：在策略里调好的召回参数，
     * 引擎实际跑的 rag_config 完全不知道。这里只覆盖检索相关的那几个键
     * （dense/sparse/top_k/fusion/rerank/graph/timeout），切分与图片解析区块保持原样。
     */
    @PostMapping("/rag-config/from-profile")
    public ApiResponse<Map<String, Object>> applyProfileToRagConfig(@RequestBody Map<String, Object> body) {
        String profileId = String.valueOf(body.getOrDefault("profileId", ""));
        if (profileId.isBlank()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "缺少 profileId");
        }
        return ApiResponse.ok(io(() -> {
            var profileNode = retrievalProfileService.readConfig(
                    retrievalProfileService.require(java.util.UUID.fromString(profileId)));
            @SuppressWarnings("unchecked")
            Map<String, Object> profile = new com.fasterxml.jackson.databind.ObjectMapper()
                    .convertValue(profileNode, Map.class);
            Map<String, Object> payload = nacos.rawConfig(props.getNacosRagConfigDataId(),
                    props.getNacosRagConfigGroup());
            String content = String.valueOf(payload.getOrDefault("content", ""));
            Map<String, Object> parsed = new java.util.LinkedHashMap<>(parseYaml(content));
            mergeRetrieval(parsed, profile);
            String merged = new Yaml().dump(parsed);
            Map<String, Object> published = nacos.publishConfig(props.getNacosRagConfigDataId(),
                    props.getNacosRagConfigGroup(), merged);
            Map<String, Object> result = new java.util.LinkedHashMap<>(published);
            result.put("content", merged);
            result.put("reloaded", reloadEngine());
            return result;
        }));
    }

    /** 只把检索相关键写进 rag_config，其它区块（图片解析、集合配置）一律不动 */
    @SuppressWarnings("unchecked")
    private static void mergeRetrieval(Map<String, Object> root, Map<String, Object> profile) {
        Map<String, Object> retrieval = mutableSection(root, "retrieval");
        Map<String, Object> dense = mutableSection(retrieval, "dense");
        Map<String, Object> sparse = mutableSection(retrieval, "sparse");
        Map<String, Object> fusion = mutableSection(retrieval, "fusion");
        Map<String, Object> rerank = mutableSection(retrieval, "rerank");
        Map<String, Object> graph = mutableSection(retrieval, "graph");

        putIfPresent(dense, "top_k", profile.get("dense_top_k"));
        putIfPresent(sparse, "top_k", profile.get("sparse_top_k"));
        putIfPresent(retrieval, "top_k", profile.get("top_k"));
        putIfPresent(fusion, "strategy", profile.get("fusion"));
        // retriever.k 是引擎另一处读取点，两边同时写才不会一个改了一个没改
        putIfPresent(mutableSection(root, "retriever"), "k", profile.get("top_k"));
        if (profile.get("rerank") instanceof Map<?, ?> rerankProfile) {
            Map<String, Object> source = (Map<String, Object>) rerankProfile;
            putIfPresent(rerank, "enabled", source.get("enabled"));
            putIfPresent(rerank, "top_n", source.get("top_n"));
            putIfPresent(rerank, "model", source.get("model"));
        }
        if (profile.get("graph") instanceof Map<?, ?> graphProfile) {
            Map<String, Object> source = (Map<String, Object>) graphProfile;
            putIfPresent(graph, "enabled", source.get("enabled"));
            putIfPresent(graph, "hops", source.get("hops"));
        }
        if (profile.get("jev") instanceof Map<?, ?> jevProfile) {
            Map<String, Object> source = (Map<String, Object>) jevProfile;
            Object minConfidence = source.get("minConfidence") != null
                    ? source.get("minConfidence") : source.get("min_confidence");
            putIfPresent(mutableSection(root, "jev"), "min_confidence", minConfidence);
        }
        putIfPresent(root, "timeout_ms", profile.get("timeout_ms"));
    }

    @SuppressWarnings("unchecked")
    private static void applyStructured(Map<String, Object> root, Map<String, Object> fields) {        Map<String, Object> embedding = mutableSection(root, "embedding_model");
        Map<String, Object> splitter = mutableSection(root, "splitter");
        Map<String, Object> retriever = mutableSection(root, "retriever");
        Map<String, Object> reranker = mutableSection(retriever, "reranker");
        Map<String, Object> rerankerParams = mutableSection(reranker, "params");
        Map<String, Object> imageParser = mutableSection(root, "image_parser");
        Map<String, Object> vlConfig = mutableSection(imageParser, "vl_model_config");

        putIfPresent(embedding, "model_name", fields.get("embeddingModel"));
        putIfPresent(embedding, "dimensions", fields.get("dimensions"));
        putIfPresent(splitter, "chunk_size", fields.get("chunkSize"));
        putIfPresent(splitter, "chunk_overlap", fields.get("chunkOverlap"));
        putIfPresent(retriever, "fetch_k", fields.get("fetchK"));
        putIfPresent(retriever, "k", fields.get("topK"));
        putIfPresent(rerankerParams, "model_name", fields.get("rerankModel"));
        putIfPresent(vlConfig, "name", fields.get("vlModel"));
        // 决策模型：聊天主模型与 JEV 受限选择模型
        putIfPresent(mutableSection(root, "llm"), "chat_model", fields.get("chatModel"));
        putIfPresent(mutableSection(root, "jev"), "model", fields.get("jevModel"));

        // 检索参数（与 rag_config 里 retrieval.* 同名）
        Map<String, Object> retrieval = mutableSection(root, "retrieval");
        putIfPresent(mutableSection(retrieval, "dense"), "top_k", fields.get("denseTopK"));
        putIfPresent(mutableSection(retrieval, "sparse"), "top_k", fields.get("sparseTopK"));
        putIfPresent(retrieval, "top_k", fields.get("retrievalTopK"));
        Map<String, Object> fusionSection = mutableSection(retrieval, "fusion");
        putIfPresent(fusionSection, "strategy", fields.get("fusion"));
        putIfPresent(fusionSection, "k", fields.get("fusionK"));
        Map<String, Object> rerankSection = mutableSection(retrieval, "rerank");
        putIfPresent(rerankSection, "enabled", fields.get("rerankEnabled"));
        putIfPresent(rerankSection, "top_n", fields.get("rerankTopN"));
        putIfPresent(rerankSection, "model", fields.get("rerankModel"));
        // 权重模式的两个权重放在 retrieval 顶层，和 dense_top_k 一层
        putIfPresent(retrieval, "dense_weight", fields.get("denseWeight"));
        putIfPresent(retrieval, "sparse_weight", fields.get("sparseWeight"));
        Map<String, Object> graphSection = mutableSection(retrieval, "graph");
        putIfPresent(graphSection, "enabled", fields.get("graphEnabled"));
        putIfPresent(graphSection, "hops", fields.get("graphHops"));
        putIfPresent(mutableSection(root, "jev"), "min_confidence", fields.get("jevMinConfidence"));
        putIfPresent(root, "timeout_ms", fields.get("timeoutMs"));

        Object indexType = fields.get("indexType");
        Object metricType = fields.get("metricType");
        if (indexType != null || metricType != null) {
            Map<String, Object> stores = mutableSection(root, "milves_stores");
            Map<String, Object> first = stores.values().stream()
                    .filter(Map.class::isInstance)
                    .map(value -> (Map<String, Object>) value)
                    .findFirst()
                    .orElseGet(() -> mutableSection(stores, "feishu_doc"));
            putIfPresent(first, "index_type", indexType);
            putIfPresent(first, "metric_type", metricType);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mutableSection(Map<String, Object> parent, String key) {
        Object existing = parent.get(key);
        if (existing instanceof Map) {
            return (Map<String, Object>) existing;
        }
        Map<String, Object> created = new java.util.LinkedHashMap<>();
        parent.put(key, created);
        return created;
    }

    private static void putIfPresent(Map<String, Object> target, String key, Object value) {
        if (value == null) {
            return;
        }
        if (value instanceof String text && text.isBlank()) {
            return;
        }
        target.put(key, value);
    }

    /**
     * 把 `${ENV:default}` 解析成真正生效的值。
     * 管理台要显示"实际用的是哪个模型"，显示模板字符串等于没显示。
     */
    static String resolvePlaceholder(String raw) {
        String text = raw == null ? "" : raw.trim();
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("^\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?}$")
                .matcher(text);
        if (!matcher.matches()) {
            return text;
        }
        String envName = matcher.group(1);
        String fallback = matcher.group(2) == null ? "" : matcher.group(2);
        String fromEnv = System.getenv(envName);
        return fromEnv == null || fromEnv.isBlank() ? fallback : fromEnv;
    }

    /** Nacos 控制台入口：Agent 的审核/上线、版本标签切换只能在 Nacos 完成，这里给出直达地址 */
    @GetMapping("/nacos-console")
    public ApiResponse<Map<String, Object>> nacosConsole() {
        return ApiResponse.ok(Map.of(
                "baseUrl", props.getNacosConsoleUrl() == null ? "" : props.getNacosConsoleUrl(),
                "namespace", props.getNacosNamespace() == null ? "public" : props.getNacosNamespace()));
    }

    /**
     * 各平台入口：Nacos / LiteLLM / Langfuse 的地址来自 .env，
     * 管理台把它们做成可点的链接，省得每次去翻配置文件。
     */
    @GetMapping("/links")
    public ApiResponse<java.util.List<Map<String, Object>>> links() {
        // 这里的地址是给**浏览器**点开的：容器内部用的 host.docker.internal 在宿主浏览器里根本解析不到，
        // 所以要换成对外可访问的地址（默认 localhost）。
        String gateway = browserUrl(props.getLitellmBaseUrl(), 4000);
        if (gateway.endsWith("/v1")) {
            gateway = gateway.substring(0, gateway.length() - 3);
        }
        if (gateway.endsWith("/ui")) {
            gateway = gateway.substring(0, gateway.length() - 3);
        }
        java.util.List<Map<String, Object>> items = new java.util.ArrayList<>();
        items.add(link("Nacos 控制台", browserUrl(props.getNacosConsoleUrl(), 8080),
                "Agent / Prompt / Skill / 配置审核上线"));
        items.add(link("LiteLLM 网关", gateway.isBlank() ? "" : gateway + "/ui",
                "模型、虚拟密钥、预算与用量"));
        items.add(link("Langfuse", browserUrl(props.getLangfuseHost(), 3000),
                "LLM 调用链路与成本追踪"));
        return ApiResponse.ok(items);
    }

    /**
     * 把容器内部地址换成浏览器能打开的地址：
     * host.docker.internal / kh-* / knowledge-hub-* 这些主机名在宿主上都是不存在的。
     */
    static String browserUrl(String raw, int fallbackPort) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            return "";
        }
        String host = "localhost";
        String port = String.valueOf(fallbackPort);
        String path = "";
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("^(?:(?:https?)://)?([^/:]+)(?::(\\d+))?(/.*)?$")
                .matcher(value);
        if (matcher.matches()) {
            if (matcher.group(2) != null) {
                port = matcher.group(2);
            }
            if (matcher.group(3) != null) {
                path = matcher.group(3);
            }
        }
        return "http://" + host + ":" + port + path;
    }

    private static Map<String, Object> link(String name, String url, String description) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("name", name);
        item.put("url", url == null ? "" : url);
        item.put("description", description);
        return item;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parseYaml(String content) {        if (content == null || content.isBlank()) {
            return Map.of();
        }
        try {
            Object loaded = new Yaml().load(content);
            return loaded instanceof Map ? (Map<String, Object>) loaded : Map.of();
        } catch (RuntimeException ex) {
            return Map.of("_error", ex.getMessage());
        }
    }

    /** 从 rag_config 里挑出知识库表单需要的默认值（缺字段就留空，由前端兜底）。 */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> kbDefaults(Map<String, Object> parsed) {
        Map<String, Object> defaults = new LinkedHashMap<>();
        Map<String, Object> embedding = section(parsed, "embedding_model");
        Map<String, Object> splitter = section(parsed, "splitter");
        Map<String, Object> retriever = section(parsed, "retriever");
        Map<String, Object> imageParser = section(parsed, "image_parser");
        defaults.put("embeddingModel", embedding.getOrDefault("model_name", ""));
        defaults.put("dimensions", embedding.getOrDefault("dimensions", 1024));
        defaults.put("chunkSize", splitter.getOrDefault("chunk_size", 1000));
        defaults.put("chunkOverlap", splitter.getOrDefault("chunk_overlap", 200));
        defaults.put("fetchK", retriever.getOrDefault("fetch_k", 14));
        defaults.put("topK", retriever.getOrDefault("k", 7));
        Map<String, Object> reranker = section(retriever, "reranker");
        Map<String, Object> rerankerParams = section(reranker, "params");
        defaults.put("rerankModel", rerankerParams.getOrDefault("model_name", ""));
        Map<String, Object> vl = section(imageParser, "vl_model_config");
        defaults.put("vlModel", vl.getOrDefault("name", ""));
        Map<String, Object> stores = section(parsed, "milves_stores");
        Map<String, Object> firstStore = stores.values().stream()
                .filter(Map.class::isInstance)
                .map(value -> (Map<String, Object>) value)
                .findFirst()
                .orElse(Map.of());
        defaults.put("indexType", firstStore.getOrDefault("index_type", ""));
        defaults.put("metricType", firstStore.getOrDefault("metric_type", ""));
        // 检索参数：策略里调好的值要能在这张卡里看到、比对、再发布
        Map<String, Object> retrieval = section(parsed, "retrieval");
        Map<String, Object> dense = section(retrieval, "dense");
        Map<String, Object> sparse = section(retrieval, "sparse");
        Map<String, Object> fusion = section(retrieval, "fusion");
        Map<String, Object> rerank = section(retrieval, "rerank");
        Map<String, Object> graph = section(retrieval, "graph");
        Map<String, Object> jev = section(parsed, "jev");
        defaults.put("denseTopK", dense.getOrDefault("top_k", 20));
        defaults.put("sparseTopK", sparse.getOrDefault("top_k", 20));
        defaults.put("retrievalTopK", retrieval.getOrDefault("top_k", retriever.getOrDefault("k", 8)));
        defaults.put("fusion", fusion.getOrDefault("strategy", "rrf"));
        defaults.put("fusionK", fusion.getOrDefault("k", 60));
        defaults.put("rerankEnabled", rerank.getOrDefault("enabled", false));
        defaults.put("rerankTopN", rerank.getOrDefault("top_n", 8));
        defaults.put("denseWeight", retrieval.getOrDefault("dense_weight", 0.6));
        defaults.put("sparseWeight", retrieval.getOrDefault("sparse_weight", 0.4));
        defaults.put("graphEnabled", graph.getOrDefault("enabled", false));
        defaults.put("graphHops", graph.getOrDefault("hops", 2));
        defaults.put("jevMinConfidence", jev.getOrDefault("min_confidence", 0.55));
        defaults.put("timeoutMs", parsed.getOrDefault("timeout_ms", 8000));
        ((Map<String, Object>) defaults).values().removeIf(value -> value == null);
        return defaults;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> section(Map<String, Object> source, String key) {
        Object value = source == null ? null : source.get(key);
        return value instanceof Map ? (Map<String, Object>) value : Map.of();
    }

    /**
     * 上游 Nacos 的报错原样抛给前端不好读：把最常见的几种翻成人话。
     * 例如 409 resource conflict 实际是"已经有草稿/待审核版本"。
     */
    private <T> T io(ThrowingCall<T> call) {
        try {
            return call.run();
        } catch (IOException ex) {
            throw new BizException(ErrorCode.UPSTREAM_ERROR, friendlyUpstreamMessage(ex.getMessage()));
        }
    }

    private static String friendlyUpstreamMessage(String raw) {
        String message = raw == null ? "" : raw;
        if (message.contains("resource conflict") || message.contains("already a working version")) {
            return "Nacos 里已经有草稿或待审核版本：先到控制台把那个版本审核/上线或丢弃，再发布新版本";
        }
        if (message.contains("HTTP 401") || message.contains("HTTP 403")) {
            return "Nacos 认证失败：检查 .env 里的 NACOS_USERNAME / NACOS_PASSWORD";
        }
        if (message.contains("HTTP 404")) {
            return "Nacos 找不到该资源：可能是名称或命名空间不对";
        }
        return message.length() > 300 ? message.substring(0, 300) + "…" : message;
    }

    private interface ThrowingCall<T> {
        T run() throws IOException;
    }
}
