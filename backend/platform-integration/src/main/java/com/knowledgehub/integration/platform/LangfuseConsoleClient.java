package com.knowledgehub.integration.platform;

import com.fasterxml.jackson.databind.JsonNode;
import com.knowledgehub.integration.config.KhIntegrationProperties;
import com.knowledgehub.integration.http.JsonHttpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Langfuse 只读查询：把线上真实调用（模型、耗时、token、成本）搬进管理台。
 *
 * <p>Langfuse v4 的公开 API 里 trace 列表已换到 `/api/public/v2/observations`，
 * 这里按观察点（GENERATION/SPAN）取最近记录，够用且稳定。
 */
@Component
public class LangfuseConsoleClient {

    private static final Logger log = LoggerFactory.getLogger(LangfuseConsoleClient.class);
    private static final Duration TIMEOUT = Duration.ofSeconds(10);

    private final JsonHttpClient http;
    private final KhIntegrationProperties props;

    public LangfuseConsoleClient(JsonHttpClient http, KhIntegrationProperties props) {
        this.http = http;
        this.props = props;
    }

    public boolean configured() {
        return notBlank(props.getLangfusePublicKey()) && notBlank(props.getLangfuseSecretKey());
    }

    public Map<String, Object> overview(int limit) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("host", publicHost());
        payload.put("configured", configured());
        payload.put("observations", observations(limit));
        return payload;
    }

    /** 容器内是 http://langfuse:3000 这类地址，浏览器打不开：统一换成本机映射端口 */
    private String publicHost() {
        String host = host();
        if (host.contains("://") && !host.contains("127.0.0.1") && !host.contains("localhost")) {
            int schemeEnd = host.indexOf("://") + 3;
            String rest = host.substring(schemeEnd);
            int slash = rest.indexOf('/');
            String authority = slash < 0 ? rest : rest.substring(0, slash);
            int colon = authority.lastIndexOf(':');
            String port = colon < 0 ? "3000" : authority.substring(colon + 1);
            return "http://127.0.0.1:" + port;
        }
        return host;
    }

    public List<Map<String, Object>> observations(int limit) {
        if (!configured()) {
            return List.of();
        }
        try {
            // v4 的列表接口默认只给摘要，必须显式要 model / usage / cost 字段，否则列全是空的
            String fields = "fields=model,usageDetails,totalCost,type,name,level,startTime,latency,"
                    + "projectId,parentObservationId";
            JsonNode body = http.get(host() + "/api/public/v2/observations?limit="
                    + Math.max(1, Math.min(limit, 100)) + "&" + fields, auth(), TIMEOUT);
            List<Map<String, Object>> items = new ArrayList<>();
            for (JsonNode item : body.path("data")) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", item.path("id").asText(""));
                row.put("traceId", item.path("traceId").asText(""));
                row.put("parentObservationId", item.path("parentObservationId").asText(""));
                row.put("projectId", item.path("projectId").asText(""));
                row.put("type", item.path("type").asText(""));
                row.put("name", item.path("name").asText(""));
                row.put("model", item.path("model").asText(""));
                row.put("startTime", item.path("startTime").asText(""));
                row.put("latency", item.path("latency").asDouble(0));
                JsonNode usage = item.path("usageDetails");
                row.put("inputTokens", usage.path("input").asInt(0));
                row.put("outputTokens", usage.path("output").asInt(0));
                row.put("totalCost", item.path("totalCost").isNumber() ? item.path("totalCost").asDouble(0) : 0.0);
                row.put("level", item.path("level").asText(""));
                items.add(row);
            }
            return items;
        } catch (IOException ex) {
            log.warn("langfuse observations failed: {}", ex.getMessage());
            return List.of();
        }
    }

    // ---------------------------------------------------- 评测数据集同步（写）
    /** 建/更新一个数据集（Langfuse 的 dataset 是 upsert 语义，同名重复调用不报错） */
    public Map<String, Object> upsertDataset(String name, String description) {
        if (!configured()) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.BAD_REQUEST, "未配置 Langfuse 密钥");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("description", description == null ? "" : description);
        try {
            JsonNode node = http.post(host() + "/api/public/v2/datasets", auth(), body, TIMEOUT);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", node.path("id").asText(""));
            row.put("name", node.path("name").asText(name));
            return row;
        } catch (IOException ex) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.ENGINE_UNAVAILABLE,
                    "Langfuse 数据集写入失败: " + ex.getMessage());
        }
    }

    /**
     * 写一条数据集条目（问题 + 期望答案 + 期望文档）。
     * ``id`` 用我们自己的用例 id，重复同步会覆盖而不是新增，天然幂等。
     */
    public String upsertDatasetItem(String datasetName, String itemId, Object input,
                                    Object expectedOutput, Map<String, Object> metadata) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", itemId);
        body.put("datasetName", datasetName);
        body.put("input", input);
        if (expectedOutput != null) {
            body.put("expectedOutput", expectedOutput);
        }
        if (metadata != null && !metadata.isEmpty()) {
            body.put("metadata", metadata);
        }
        try {
            JsonNode node = http.post(host() + "/api/public/dataset-items", auth(), body, TIMEOUT);
            return node.path("id").asText(itemId);
        } catch (IOException ex) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.ENGINE_UNAVAILABLE,
                    "Langfuse 数据集条目写入失败: " + ex.getMessage());
        }
    }

    /**
     * 打开一条「运行」并把某个条目挂上去。
     *
     * <p>Langfuse 的 dataset run item 必须指向一条 trace，所以先用 ingestion 接口
     * 写一条只含 input/output 的 trace（真实回复就在这里），再挂到 run 上。
     * 这样在 Langfuse 里能看到「期望答案 vs 实际回复」的对照，而不是只有我们自己的表。
     */
    public String linkRunItem(String runName, String datasetItemId, String traceId,
                              String input, String output, Map<String, Object> metadata) {
        try {
            Map<String, Object> trace = new LinkedHashMap<>();
            trace.put("id", traceId);
            trace.put("name", "eval · " + runName);
            trace.put("input", input);
            trace.put("output", output);
            if (metadata != null && !metadata.isEmpty()) {
                trace.put("metadata", metadata);
            }
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("type", "trace-create");
            event.put("id", java.util.UUID.randomUUID().toString());
            event.put("timestamp", java.time.OffsetDateTime.now().toString());
            event.put("body", trace);
            http.post(host() + "/api/public/ingestion", auth(), Map.of("batch", List.of(event)), TIMEOUT);

            Map<String, Object> body = new LinkedHashMap<>();
            body.put("runName", runName);
            body.put("datasetItemId", datasetItemId);
            body.put("traceId", traceId);
            JsonNode node = http.post(host() + "/api/public/dataset-run-items", auth(), body, TIMEOUT);
            return node.path("id").asText("");
        } catch (IOException ex) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.ENGINE_UNAVAILABLE,
                    "Langfuse 运行记录写入失败: " + ex.getMessage());
        }
    }

    private String host() {
        String host = props.getLangfuseHost();
        return host != null && host.endsWith("/") ? host.substring(0, host.length() - 1) : host;
    }

    private Map<String, String> auth() {
        String raw = props.getLangfusePublicKey() + ":" + props.getLangfuseSecretKey();
        String encoded = Base64.getEncoder().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
        return Map.of("Authorization", "Basic " + encoded);
    }

    private static boolean notBlank(String value) {
        return value != null && !value.isBlank();
    }
}
