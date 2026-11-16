package com.knowledgehub.integration.platform;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.integration.config.KhIntegrationProperties;
import com.knowledgehub.integration.http.JsonHttpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Nacos 3.x AI 注册中心的管理侧封装。
 *
 * <p>Agent（含 AGENTS.md 指令、tools/subagents/skills/link_prompts）、Prompt、Skill
 * 都放在 Nacos 里，管理台要能看见并直接改，所以这里走的是 admin 接口
 * （`/nacos/v3/admin/ai/*`），而不是引擎用的只读 client 接口。
 */
@Component
public class NacosConsoleClient {

    private static final Logger log = LoggerFactory.getLogger(NacosConsoleClient.class);
    private static final Duration TIMEOUT = Duration.ofSeconds(8);

    private final JsonHttpClient http;
    private final ObjectMapper objectMapper;
    private final KhIntegrationProperties props;

    private volatile String token;
    private volatile Instant tokenExpiry = Instant.EPOCH;

    public NacosConsoleClient(JsonHttpClient http, ObjectMapper objectMapper, KhIntegrationProperties props) {
        this.http = http;
        this.objectMapper = objectMapper;
        this.props = props;
    }

    // ------------------------------------------------------------------ 认证
    private synchronized String token() throws IOException {
        if (token != null && Instant.now().isBefore(tokenExpiry)) {
            return token;
        }
        String url = base() + "/nacos/v3/auth/user/login?username="
                + enc(props.getNacosUsername()) + "&password=" + enc(props.getNacosPassword());
        JsonNode body = http.post(url, Map.of(), "", TIMEOUT);
        String value = body.path("accessToken").asText("");
        if (value.isBlank()) {
            throw new IOException("Nacos 登录失败：没有返回 accessToken（检查账号密码）");
        }
        token = value;
        // Nacos 默认 5 小时有效，这里提前 5 分钟换新
        tokenExpiry = Instant.now().plus(Duration.ofMinutes(295));
        return token;
    }

    private JsonNode get(String path) throws IOException {
        String url = base() + path + (path.contains("?") ? "&" : "?") + "namespaceId=" + enc(namespace());
        return http.get(url, Map.of("accessToken", token()), TIMEOUT);
    }

    private JsonNode post(String path, Object body) throws IOException {
        String url = base() + path;
        return http.post(url, Map.of("accessToken", token()), body, TIMEOUT);
    }

    private JsonNode postForm(String path, Map<String, String> form) throws IOException {
        return http.postForm(base() + path, Map.of("accessToken", token()), form, TIMEOUT);
    }

    private JsonNode putForm(String path, Map<String, String> form) throws IOException {
        return http.putForm(base() + path, Map.of("accessToken", token()), form, TIMEOUT);
    }

    /** Nacos 统一响应：code!=0 视为失败，把它的 message 直接抛给调用方。 */
    private JsonNode data(JsonNode response) throws IOException {
        int code = response.path("code").asInt(-1);
        if (code != 0) {
            throw new IOException("Nacos 返回错误：" + response.path("message").asText("unknown"));
        }
        return response.path("data");
    }

    // ------------------------------------------------------------------ agent
    public List<Map<String, Object>> agents() {
        return safeList(() -> {
            JsonNode data = data(get("/nacos/v3/admin/ai/agentspecs/list?pageNo=1&pageSize=100"));
            List<Map<String, Object>> items = new ArrayList<>();
            for (JsonNode item : data.path("pageItems")) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("name", item.path("name").asText());
                row.put("description", item.path("description").asText(""));
                row.put("enable", item.path("enable").asBoolean(true));
                row.put("updateTime", item.path("updateTime").asLong(0));
                JsonNode labels = item.path("labels");
                row.put("version", labelVersion(labels, item.path("latestVersion").asText("")));
                row.put("latestVersion", item.path("latestVersion").asText(labels.path("latest").asText("")));
                row.put("reviewingVersion", item.path("reviewingVersion").asText(""));
                row.put("onlineCount", item.path("onlineCnt").asInt(0));
                items.add(row);
            }
            return items;
        });
    }

    /**
     * Nacos 的 AgentSpec 生产标签在不同版本里叫 {@code product}（3.x 默认）
     * 或 {@code production}（早期写法），两个都认，缺失时回落到 latest。
     */
    private static String labelVersion(JsonNode labels, String fallback) {
        if (labels == null || labels.isMissingNode()) {
            return fallback == null ? "" : fallback;
        }
        for (String key : new String[]{"product", "production", "latest"}) {
            String value = labels.path(key).asText("");
            if (!value.isBlank()) {
                return value;
            }
        }
        return fallback == null ? "" : fallback;
    }

    /** Agent 详情：配置 JSON（tools/subagents/model/link_prompts）+ AGENTS.md 指令正文 + 版本历史。 */
    public Map<String, Object> agent(String name) throws IOException {
        JsonNode detail = data(get("/nacos/v3/admin/ai/agentspecs?agentSpecName=" + enc(name)));
        // Nacos 3.x 的 AgentSpec 生产标签叫 product，早期写法是 production：逐个试，别因为标签名不对就读不到正文
        JsonNode client = null;
        for (String label : new String[]{"product", "production", "latest"}) {
            try {
                client = data(get("/nacos/v3/client/ai/agentspecs?name=" + enc(name) + "&label=" + label));
                break;
            } catch (IOException ex) {
                log.debug("agentspec {} not found with label {}: {}", name, label, ex.getMessage());
            }
        }
        if (client == null) {
            throw new IOException("Nacos 里没有这个 Agent 的可用版本（试过 product / production / latest）");
        }
        String instruction = instructionOf(client.path("resource"));
        String content = client.path("content").asText("");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", name);
        payload.put("description", client.path("description").asText(detail.path("description").asText("")));
        payload.put("content", content);
        payload.put("instruction", instruction);
        // Nacos 的 admin 详情不一定带 labels：生产标签缺失时回落到 latest（实际生效的就是它）
        JsonNode labels = detail.path("labels");
        String latest = labels.path("latest").asText(detail.path("latestVersion").asText(""));
        payload.put("version", labelVersion(labels, latest));
        payload.put("latestVersion", latest);
        payload.put("productVersion", labels.path("product").asText(labels.path("production").asText("")));
        payload.put("labels", toLabelMap(labels));
        payload.put("versions", versionsOf(detail.path("versions")));
        payload.put("editingVersion", detail.path("editingVersion").asText(""));
        payload.put("reviewingVersion", detail.path("reviewingVersion").asText(""));
        payload.put("enable", detail.path("enable").asBoolean(true));
        payload.put("onlineCount", detail.path("onlineCnt").asInt(0));
        payload.put("linkPrompts", parseLinkPrompts(content));
        return payload;
    }

    /**
     * 把某个版本发布到 latest。
     *
     * <p>Nacos 3.x 的 AgentSpec 走 草稿 → 提交审核 → 发布 三步；这里只做最后一步
     * （只接受已审核通过的版本），审核动作仍然留在 Nacos 控制台，避免绕过审批流。
     */
    public Map<String, Object> publishAgent(String name, String version) throws IOException {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("namespaceId", namespace());
        form.put("agentSpecName", name);
        form.put("version", version == null ? "" : version);
        data(postForm("/nacos/v3/admin/ai/agentspecs/publish", form));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", name);
        payload.put("version", version);
        payload.put("published", true);
        return payload;
    }

    /**
     * 切换 Agent 的版本标签（production / latest）。
     *
     * <p>Nacos 3.2 没有单独的 {@code /agentspecs/label} 接口，标签是一个整体映射：
     * {@code PUT /agentspecs/labels} 带 {@code labels={"production":"0.0.4"}}。
     * 必须整体提交，所以先把现有标签读出来再合并，避免把 latest 抹掉。
     */
    public Map<String, Object> setAgentLabel(String name, String label, String version) throws IOException {
        String target = label == null || label.isBlank() ? "production" : label;
        JsonNode detail = data(get("/nacos/v3/admin/ai/agentspecs?agentSpecName=" + enc(name)));
        Map<String, String> labels = new LinkedHashMap<>();
        JsonNode existing = detail.path("labels");
        if (existing.isObject()) {
            existing.fields().forEachRemaining(entry -> labels.put(entry.getKey(), entry.getValue().asText("")));
        }
        String previous = labels.get(target);
        labels.put(target, version == null ? "" : version);
        Map<String, String> form = new LinkedHashMap<>();
        form.put("namespaceId", namespace());
        form.put("agentSpecName", name);
        form.put("labels", objectMapper.writeValueAsString(labels));
        data(putForm("/nacos/v3/admin/ai/agentspecs/labels", form));

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", name);
        payload.put("label", target);
        payload.put("version", version);
        payload.put("previous", previous == null ? "" : previous);
        payload.put("labels", labels);
        return payload;
    }

    private static Map<String, Object> toLabelMap(JsonNode labels) {
        Map<String, Object> map = new LinkedHashMap<>();
        if (labels != null && labels.isObject()) {
            labels.fields().forEachRemaining(entry -> map.put(entry.getKey(), entry.getValue().asText("")));
        }
        return map;
    }

    private List<Map<String, Object>> versionsOf(JsonNode versions) {
        List<Map<String, Object>> rows = new ArrayList<>();
        if (versions == null || !versions.isArray()) {
            return rows;
        }
        for (JsonNode item : versions) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("version", item.path("version").asText(""));
            row.put("status", item.path("status").asText(""));
            row.put("author", item.path("author").asText(""));
            row.put("updateTime", item.path("updateTime").asLong(0));
            row.put("pipelineStatus", pipelineStatus(item.path("publishPipelineInfo").asText("")));
            rows.add(row);
        }
        return rows;
    }

    /** 审核流水线结果（skill-scanner 等）只取状态，正文太长不适合放表格。 */
    private String pipelineStatus(String pipeline) {
        if (pipeline == null || pipeline.isBlank()) {
            return "";
        }
        try {
            return objectMapper.readTree(pipeline).path("status").asText("");
        } catch (IOException ex) {
            return "";
        }
    }

    /** 上线/下线：对齐 Nacos 的 online / offline 接口。 */
    public Map<String, Object> setAgentOnline(String name, boolean online) throws IOException {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("namespaceId", namespace());
        form.put("agentSpecName", name);
        data(postForm("/nacos/v3/admin/ai/agentspecs/" + (online ? "online" : "offline"), form));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", name);
        payload.put("enable", online);
        return payload;
    }

    /**
     * 保存 Agent：建草稿 → **写草稿内容** → 提交审核。
     *
     * <p>关键在第二步：Nacos 的草稿是「从指定版本复制一份」后**空转**的，
     * `POST /draft` 只建版本、不带内容；内容必须再 `PUT /draft` 用
     * `agentSpecCard` 整份写进去。之前少了这一步，于是"发布新版本"只是复制了旧版，
     * 改了 AGENTS.md 也不会生效。
     *
     * <p>顺序：读线上版本的 resource（保留其它资源文件）→ 建草稿 → 写草稿 → 提交审核。
     * 审核/上线仍在 Nacos 流水线里完成，不绕过审批。
     */
    public Map<String, Object> saveAgent(String name, String description, String content, String instruction)
            throws IOException {
        // 内容没变就不该产生一个"空版本"：Nacos 里 0.0.2 → 0.0.3 内容一样，
        // 审核流水线还得跑一遍，线上也没变化，纯噪音。
        Map<String, Object> published = agent(name);
        boolean sameContent = Objects.equals(normalize(published.get("content")), normalize(content));
        boolean sameInstruction = instruction == null
                || Objects.equals(normalize(published.get("instruction")), normalize(instruction));
        boolean sameDescription = description == null
                || Objects.equals(normalize(published.get("description")), normalize(description));
        if (sameContent && sameInstruction && sameDescription) {
            throw new BizException(ErrorCode.BAD_REQUEST,
                    "内容和线上（" + published.get("version") + "）一致，没有需要发布的新版本");
        }

        String baseVersion = String.valueOf(published.getOrDefault("latestVersion", ""));
        if (baseVersion.isBlank()) {
            baseVersion = String.valueOf(published.getOrDefault("version", ""));
        }
        Map<String, Object> base = readAgentVersion(name, baseVersion);
        Map<String, Object> resources = new LinkedHashMap<>();
        Object baseResources = base.get("resource");
        if (baseResources instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                resources.put(String.valueOf(entry.getKey()), entry.getValue());
            }
        }

        // 1) 建草稿（基于当前 latest，不指定 targetVersion 让 Nacos 自增）
        Map<String, String> draftForm = new LinkedHashMap<>();
        draftForm.put("namespaceId", namespace());
        draftForm.put("agentSpecName", name);
        if (!baseVersion.isBlank()) {
            draftForm.put("basedOnVersion", baseVersion);
        }
        JsonNode drafted = data(postForm("/nacos/v3/admin/ai/agentspecs/draft", draftForm));
        String version = drafted.isTextual() ? drafted.asText() : drafted.path("version").asText("");

        // 2) 把内容写进草稿（agentSpecCard 是整份 AgentSpec 的 JSON 字符串）
        Map<String, Object> card = new LinkedHashMap<>();
        card.put("namespaceId", namespace());
        card.put("name", name);
        card.put("description", description == null
                ? String.valueOf(published.getOrDefault("description", "")) : description);
        card.put("content", content == null ? String.valueOf(published.getOrDefault("content", "")) : content);
        if (instruction != null) {
            String key = resources.keySet().stream()
                    .filter(item -> item.toLowerCase().contains("agents"))
                    .findFirst()
                    .orElse("instruction_" + name + "/AGENTS__MD");
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", name + "/AGENTS.MD");
            entry.put("type", "instruction");
            entry.put("content", instruction);
            resources.put(key, entry);
        }
        if (!resources.isEmpty()) {
            card.put("resource", resources);
        }
        Map<String, String> updateForm = new LinkedHashMap<>();
        updateForm.put("namespaceId", namespace());
        updateForm.put("agentSpecName", name);
        updateForm.put("version", version);
        updateForm.put("agentSpecCard", objectMapper.writeValueAsString(card));
        data(putForm("/nacos/v3/admin/ai/agentspecs/draft", updateForm));

        // 3) 提交审核
        Map<String, String> submit = new LinkedHashMap<>();
        submit.put("namespaceId", namespace());
        submit.put("agentSpecName", name);
        submit.put("version", version);
        data(postForm("/nacos/v3/admin/ai/agentspecs/submit", submit));

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", name);
        payload.put("version", version);
        payload.put("basedOn", baseVersion);
        payload.put("status", "reviewing");
        return payload;
    }

    /** 读某个具体版本的完整内容（含 resource 里的 AGENTS.md） */
    public Map<String, Object> readAgentVersion(String name, String version) throws IOException {
        Map<String, Object> payload = new LinkedHashMap<>();
        if (version == null || version.isBlank()) {
            return payload;
        }
        String url = base() + "/nacos/v3/admin/ai/agentspecs/version?agentSpecName=" + enc(name)
                + "&version=" + enc(version) + "&namespaceId=" + enc(namespace());
        JsonNode detail = data(http.get(url, Map.of("accessToken", token()), TIMEOUT));
        payload.put("content", detail.path("content").asText(""));
        payload.put("description", detail.path("description").asText(""));
        Map<String, Object> resources = new LinkedHashMap<>();
        JsonNode resourceNode = detail.path("resource");
        if (resourceNode.isObject()) {
            resourceNode.fields().forEachRemaining(entry -> {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("name", entry.getValue().path("name").asText(""));
                item.put("type", entry.getValue().path("type").asText(""));
                item.put("content", entry.getValue().path("content").asText(""));
                resources.put(entry.getKey(), item);
            });
        }
        payload.put("resource", resources);
        return payload;
    }

    // ----------------------------------------------------------------- prompt
    public List<Map<String, Object>> prompts() {
        return safeList(() -> {
            JsonNode data = data(get("/nacos/v3/admin/ai/prompt/list?pageNo=1&pageSize=100"));
            List<Map<String, Object>> items = new ArrayList<>();
            for (JsonNode item : data.path("pageItems")) {
                Map<String, Object> row = new LinkedHashMap<>();
                String key = item.path("promptKey").asText();
                row.put("key", key);
                row.put("description", item.path("description").asText(""));
                // 列表接口给的是 labels（product/production/latest），没有就退到 latestVersion
                String version = labelVersion(item.path("labels"), item.path("latestVersion").asText(""));
                if (version.isBlank() && !key.isBlank()) {
                    try {
                        version = data(get("/nacos/v3/admin/ai/prompt/detail?promptKey=" + enc(key)))
                                .path("version").asText("");
                    } catch (IOException ex) {
                        log.debug("prompt version lookup failed for {}: {}", key, ex.getMessage());
                    }
                }
                row.put("version", version);
                row.put("latestVersion", item.path("latestVersion").asText(""));
                row.put("reviewingVersion", item.path("reviewingVersion").asText(""));
                row.put("editingVersion", item.path("editingVersion").asText(""));
                row.put("onlineCount", item.path("onlineCnt").asInt(0));
                row.put("updateTime", item.path("gmtModified").asLong(0));
                items.add(row);
            }
            return items;
        });
    }

    public Map<String, Object> prompt(String key) throws IOException {
        JsonNode data = data(get("/nacos/v3/admin/ai/prompt/detail?promptKey=" + enc(key)));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("key", key);
        payload.put("version", data.path("version").asText(""));
        payload.put("template", data.path("template").asText(""));
        payload.put("description", data.path("description").asText(""));
        // detail 不带版本标签，只有 list 行有：补上 production / latest，
        // 否则界面上分不清"哪个版本是线上正在用的"，发布完也没法判断能不能设 production。
        try {
            JsonNode list = data(get("/nacos/v3/admin/ai/prompt/list?pageNo=1&pageSize=100"));
            for (JsonNode item : list.path("pageItems")) {
                if (!key.equals(item.path("promptKey").asText(""))) {
                    continue;
                }
                JsonNode labels = item.path("labels");
                payload.put("labels", toLabelMap(labels));
                payload.put("productionVersion", labels.path("production").asText(""));
                payload.put("latestVersion", labels.path("latest").asText(item.path("latestVersion").asText("")));
                break;
            }
        } catch (IOException ex) {
            log.debug("prompt labels failed for {}: {}", key, ex.getMessage());
        }
        try {
            payload.put("versions", promptVersions(key));
        } catch (IOException ex) {
            // 历史版本读不到不该挡住正文编辑
            log.debug("prompt versions failed for {}: {}", key, ex.getMessage());
            payload.put("versions", List.of());
        }
        return payload;
    }

    /** Prompt 历史版本：Nacos 的 prompt/versions 返回 version + status（online/reviewed/draft）。 */
    public List<Map<String, Object>> promptVersions(String key) throws IOException {
        JsonNode data = data(get("/nacos/v3/admin/ai/prompt/versions?promptKey=" + enc(key)));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (JsonNode item : data.path("pageItems")) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("version", item.path("version").asText(""));
            row.put("status", item.path("status").asText(""));
            row.put("author", item.path("srcUser").asText(""));
            row.put("updateTime", item.path("gmtModified").asLong(0));
            row.put("commitMsg", item.path("commitMsg").asText(""));
            rows.add(row);
        }
        return rows;
    }

    /** 发布 Prompt：把指定版本推进到生产（Nacos 会检查该版本是否已审核）。 */
    public Map<String, Object> publishPrompt(String key, String version) throws IOException {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("namespaceId", namespace());
        body.put("promptKey", key);
        body.put("version", version == null ? "" : version);
        data(postForm("/nacos/v3/admin/ai/prompt/publish", body));
        return Map.of("key", key, "version", version == null ? "" : version, "published", true);
    }

    /** 切换标签（production / latest ...）：和 Nacos 控制台的"版本标签"是同一个动作。 */
    public Map<String, Object> setPromptLabel(String key, String label, String version) throws IOException {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("namespaceId", namespace());
        body.put("promptKey", key);
        body.put("label", label == null ? "production" : label);
        body.put("version", version == null ? "" : version);
        data(http.putForm(base() + "/nacos/v3/admin/ai/prompt/label",
                Map.of("accessToken", token()), body, TIMEOUT));
        return Map.of("key", key, "label", body.get("label"), "version", body.get("version"), "switched", true);
    }

    /** 发布 Prompt（Nacos 会按模板内容生成新版本，引擎下一次加载即生效）。 */
    public Map<String, Object> savePrompt(String key, String template, String description) throws IOException {
        Map<String, Object> current = prompt(key);
        if (Objects.equals(normalize(current.get("template")), normalize(template))
                && Objects.equals(normalize(current.get("description")), normalize(description))) {
            throw new BizException(ErrorCode.BAD_REQUEST,
                    "模板内容与线上（" + current.get("version") + "）一致，无需发布新版本");
        }
        String version = String.valueOf(current.get("version"));
        Map<String, String> body = new LinkedHashMap<>();
        body.put("namespaceId", namespace());
        body.put("promptKey", key);
        body.put("version", nextVersion(version));
        body.put("template", template == null ? "" : template);
        body.put("description", description == null ? "" : description);
        body.put("bizTags", "");
        data(postForm("/nacos/v3/admin/ai/prompt", body));
        return Map.of("key", key, "saved", true, "version", body.get("version"));
    }

    /** 比较"改没改"时忽略行尾空白和换行差异，避免只因为多一个换行就发个新版本。 */
    private static String normalize(Object value) {
        return value == null ? "" : String.valueOf(value).replace("\r\n", "\n").trim();
    }

    // ----------------------------------------------------------------- config
    /**
     * 读取 Nacos 配置里的原始文本（例如既有 RAG 栈的 rag_config，group=deal_pilot）。
     *
     * <p>切片长度、Embedding 模型与维度这些参数不该在两套系统里各写一份，
     * 统一以 Nacos 上的 rag_config 为准，管理台只做展示与默认值。
     */
    public Map<String, Object> rawConfig(String dataId, String group) throws IOException {
        String url = base() + "/nacos/v3/admin/cs/config?dataId=" + enc(dataId)
                + "&groupName=" + enc(group) + "&namespaceId=" + enc(namespace());
        JsonNode response = http.get(url, Map.of("accessToken", token()), TIMEOUT);
        JsonNode data = data(response);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("dataId", dataId);
        payload.put("group", group);
        payload.put("content", data.path("content").asText(""));
        payload.put("type", data.path("type").asText(""));
        return payload;
    }

    /** 把配置写回 Nacos：调试好的检索策略要能"发布"回 rag_config，而不是只读。 */
    public Map<String, Object> publishConfig(String dataId, String group, String content) throws IOException {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("namespaceId", namespace());
        form.put("dataId", dataId);
        form.put("groupName", group);
        form.put("content", content == null ? "" : content);
        form.put("type", "yaml");
        data(http.postForm(base() + "/nacos/v3/admin/cs/config", Map.of("accessToken", token()), form, TIMEOUT));
        return Map.of("dataId", dataId, "group", group, "published", true);
    }

    // ------------------------------------------------------------------ skill
    public List<Map<String, Object>> skills() {        return safeList(() -> {
            JsonNode data = data(get("/nacos/v3/admin/ai/skills/list?pageNo=1&pageSize=100"));
            List<Map<String, Object>> items = new ArrayList<>();
            for (JsonNode item : data.path("pageItems")) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("name", item.path("name").asText());
                row.put("description", item.path("description").asText(""));
                row.put("version", labelVersion(item.path("labels"), item.path("latestVersion").asText("")));
                row.put("latestVersion", item.path("latestVersion").asText(""));
                row.put("reviewingVersion", item.path("reviewingVersion").asText(""));
                items.add(row);
            }
            return items;
        });
    }

    public Map<String, Object> skill(String name) throws IOException {
        JsonNode data = data(get("/nacos/v3/admin/ai/skills?skillName=" + enc(name)));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", name);
        payload.put("description", data.path("description").asText(""));
        payload.put("version", data.path("labels").path("production").asText(""));
        return payload;
    }

    // ---------------------------------------------------------------- helper
    private String base() {
        String server = props.getNacosServer();
        return server.endsWith("/") ? server.substring(0, server.length() - 1) : server;
    }

    private String namespace() {
        String ns = props.getNacosNamespace();
        return ns == null || ns.isBlank() ? "public" : ns;
    }

    private static String enc(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }

    private static String instructionOf(JsonNode resource) {
        if (resource == null || !resource.isObject()) {
            return "";
        }
        for (Map.Entry<String, JsonNode> entry : iterable(resource)) {
            if (entry.getKey().endsWith("AGENTS__MD")) {
                String content = entry.getValue().path("content").asText("");
                if (!content.isBlank()) {
                    return content;
                }
            }
        }
        return "";
    }

    private static List<Map.Entry<String, JsonNode>> iterable(JsonNode node) {
        List<Map.Entry<String, JsonNode>> entries = new ArrayList<>();
        node.fields().forEachRemaining(entries::add);
        return entries;
    }

    private List<String> parseLinkPrompts(String content) {
        if (content == null || content.isBlank()) {
            return List.of();
        }
        try {
            JsonNode node = objectMapper.readTree(content).path("link_prompts");
            List<String> keys = new ArrayList<>();
            node.forEach(item -> keys.add(item.asText()));
            return keys;
        } catch (IOException ex) {
            return List.of();
        }
    }

    private static String nextVersion(Object current) {
        String value = current == null ? "" : current.toString();
        if (value.isBlank()) {
            return "0.0.1";
        }
        String[] parts = value.split("\\.");
        try {
            int patch = Integer.parseInt(parts[parts.length - 1]);
            parts[parts.length - 1] = String.valueOf(patch + 1);
            return String.join(".", parts);
        } catch (NumberFormatException ex) {
            return value + ".1";
        }
    }

    private interface NacosCall<T> {
        T run() throws IOException;
    }

    /** 列表类接口失败不该把整个管理台拖垮：记录并返回空列表。 */
    private <T> List<T> safeList(NacosCall<List<T>> call) {
        try {
            return call.run();
        } catch (IOException ex) {
            log.warn("nacos console list failed: {}", ex.getMessage());
            return List.of();
        }
    }
}
