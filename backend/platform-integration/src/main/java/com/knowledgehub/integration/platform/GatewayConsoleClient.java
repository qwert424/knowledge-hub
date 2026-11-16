package com.knowledgehub.integration.platform;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.integration.config.KhIntegrationProperties;
import com.knowledgehub.integration.http.JsonHttpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * LiteLLM 网关的管理侧封装：模型清单与虚拟密钥。
 *
 * <p>平台不直连厂商，所有模型调用都过网关；管理台因此要能看到"网关到底提供了什么"，
 * 以及给外部系统发的 key 花了多少钱。
 */
@Component
public class GatewayConsoleClient {

    private static final Logger log = LoggerFactory.getLogger(GatewayConsoleClient.class);
    private static final Duration TIMEOUT = Duration.ofSeconds(8);

    private final JsonHttpClient http;
    private final ObjectMapper objectMapper;
    private final KhIntegrationProperties props;

    public GatewayConsoleClient(JsonHttpClient http, ObjectMapper objectMapper, KhIntegrationProperties props) {
        this.http = http;
        this.objectMapper = objectMapper;
        this.props = props;
    }

    /** 模型清单：/model/info 带 provider、上游模型名与用途（chat / embedding / rerank / image） */
    public List<Map<String, Object>> models() {
        try {
            JsonNode body = http.get(adminUrl("/model/info"), auth(), TIMEOUT);
            Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
            for (JsonNode item : body.path("data")) {
                String id = item.path("model_name").asText("");
                if (id.isBlank() || byId.containsKey(id)) {
                    continue;
                }
                JsonNode info = item.path("model_info");
                JsonNode params = item.path("litellm_params");
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", id);
                row.put("provider", info.path("litellm_provider").asText(""));
                row.put("upstream", params.path("model").asText(""));
                row.put("maxTokens", resolveMaxTokens(params, info));
                row.put("mode", resolveMode(id, info.path("mode").asText(""), params.path("model").asText("")));
                // 前缀/账号信息：模型来自哪个凭证，出问题要能直接定位到账号
                row.put("apiBase", params.path("api_base").asText(""));
                row.put("credential", params.path("litellm_credential_name").asText(""));
                byId.put(id, row);
            }
            return new ArrayList<>(byId.values());
        } catch (IOException ex) {
            log.warn("gateway model list failed: {}", ex.getMessage());
            return List.of();
        }
    }

    /**
     * 最大 tokens：网关的配置里不一定写 max_tokens（多数模型走默认），
     * 这时读 model_info 的上下文/输出上限，读不到就 0，界面显示"未配置"。
     */
    private static int resolveMaxTokens(JsonNode params, JsonNode info) {
        int configured = params.path("max_tokens").asInt(0);
        if (configured > 0) {
            return configured;
        }
        for (String field : new String[]{"max_output_tokens", "max_tokens", "max_input_tokens"}) {
            int value = info.path(field).asInt(0);
            if (value > 0) {
                return value;
            }
        }
        return 0;
    }

    /**
     * 用途归一：网关的 mode 用来区分对话/向量/重排/图像；备用模型单独标出来，
     * 否则界面上所有模型都显示成"对话"。
     */
    private static String resolveMode(String id, String mode, String upstream) {
        String normalized = (mode == null ? "" : mode).toLowerCase();
        String probe = (id + " " + upstream).toLowerCase();
        if (probe.contains("backup") || probe.contains("fallback")) {
            return "fallback";
        }
        if (normalized.startsWith("embed")) {
            return "embedding";
        }
        if (normalized.startsWith("rerank")) {
            return "rerank";
        }
        if (normalized.startsWith("image") || normalized.startsWith("audio")) {
            return normalized.startsWith("audio") ? "audio" : "image";
        }
        if (probe.contains("embed")) {
            return "embedding";
        }
        if (probe.contains("rerank")) {
            return "rerank";
        }
        if (probe.contains("image") || probe.contains("vision") || probe.contains("vl")) {
            return "image";
        }
        return "chat";
    }

    /** 虚拟密钥：只回显前缀，永远不返回明文。 */
    public List<Map<String, Object>> keys() {
        try {
            JsonNode body = http.get(adminUrl("/key/list?return_full_key=false"), auth(), TIMEOUT);
            JsonNode data = body.path("keys");
            List<Map<String, Object>> items = new ArrayList<>();
            JsonNode source = data.isArray() ? data : body.path("data");
            for (JsonNode item : source) {
                String hashed = item.isTextual() ? item.asText() : item.path("token").asText("");
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("key", hashed);
                row.put("keyName", "");
                row.put("alias", "");
                row.put("spend", 0.0);
                row.put("maxBudget", 0.0);
                row.put("models", List.of());
                row.put("userId", "");
                if (!hashed.isBlank()) {
                    // /key/list 只给哈希，别名/额度/花费要再查一次 /key/info
                    try {
                        JsonNode info = http.get(adminUrl("/key/info?key=" + hashed), auth(), TIMEOUT)
                                .path("info");
                        row.put("keyName", info.path("key_name").asText(""));
                        row.put("alias", info.path("key_alias").asText(""));
                        row.put("spend", info.path("spend").asDouble(0));
                        row.put("maxBudget", info.path("max_budget").asDouble(0));
                        row.put("userId", info.path("user_id").asText(""));
                        List<String> models = new ArrayList<>();
                        info.path("models").forEach(node -> models.add(node.asText()));
                        row.put("models", models);
                    } catch (IOException ex) {
                        log.debug("key info failed: {}", ex.getMessage());
                    }
                }
                items.add(row);
            }
            return items;
        } catch (IOException ex) {
            log.warn("gateway key list failed: {}", ex.getMessage());
            return List.of();
        }
    }

    /** 上游供应商凭证（LiteLLM UI 那页 Configured credentials）；只给名字/provider/地址，值保持掩码。 */
    public List<Map<String, Object>> credentials() {
        try {
            JsonNode body = http.get(adminUrl("/credentials"), auth(), TIMEOUT);
            // LiteLLM 不同版本分别返回数组或 {credentials: []}，两种都认
            JsonNode source = body.isArray() ? body : body.path("credentials");
            List<Map<String, Object>> rows = new ArrayList<>();
            for (JsonNode item : source) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("name", item.path("credential_name").asText(""));
                row.put("provider", item.path("credential_info").path("custom_llm_provider").asText(""));
                row.put("apiBase", item.path("credential_values").path("api_base").asText(""));
                row.put("apiKey", maskKey(item.path("credential_values").path("api_key").asText("")));
                row.put("createdAt", item.path("created_at").asText(""));
                rows.add(row);
            }
            return rows;
        } catch (IOException ex) {
            log.warn("gateway credentials failed: {}", ex.getMessage());
            return List.of();
        }
    }

    /** 凭证本身不落管理台：只显示前缀，方便对账但不泄露。 */
    private static String maskKey(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        String trimmed = value.trim();
        return trimmed.length() <= 8 ? "****" : trimmed.substring(0, 4) + "****" + trimmed.substring(trimmed.length() - 4);
    }

    /**
     * 调用成本：网关按模型与按天的聚合。管理台的"调用记录"用这两个视图，
     * 逐请求明细在 LiteLLM UI 里（需要 UI 账号登录），这里给的是能核对的账单口径。
     */
    public Map<String, Object> spend(int days) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("byModel", spendByModel());
        result.put("daily", spendDaily(days));
        return result;
    }

    private List<Map<String, Object>> spendByModel() {
        try {
            JsonNode body = http.get(adminUrl("/global/spend/models"), auth(), TIMEOUT);
            List<Map<String, Object>> rows = new ArrayList<>();
            for (JsonNode item : body) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("model", item.path("model").asText(""));
                row.put("spend", item.path("total_spend").asDouble(0));
                rows.add(row);
            }
            rows.sort((a, b) -> Double.compare(
                    ((Number) b.getOrDefault("spend", 0)).doubleValue(),
                    ((Number) a.getOrDefault("spend", 0)).doubleValue()));
            return rows;
        } catch (IOException ex) {
            log.warn("gateway spend by model failed: {}", ex.getMessage());
            return List.of();
        }
    }

    private List<Map<String, Object>> spendDaily(int days) {
        int window = Math.max(1, Math.min(days, 90));
        java.time.LocalDate end = java.time.LocalDate.now();
        java.time.LocalDate start = end.minusDays(window - 1L);
        String url = adminUrl("/spend/logs?start_date=" + start + "&end_date=" + end);
        try {
            JsonNode body = http.get(url, auth(), TIMEOUT);
            List<Map<String, Object>> rows = new ArrayList<>();
            for (JsonNode item : body) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("date", item.path("startTime").asText(""));
                row.put("spend", item.path("spend").asDouble(0));
                List<Map<String, Object>> models = new ArrayList<>();
                JsonNode modelsNode = item.path("models");
                modelsNode.fields().forEachRemaining(entry -> {
                    Map<String, Object> model = new LinkedHashMap<>();
                    model.put("model", entry.getKey());
                    model.put("spend", entry.getValue().asDouble(0));
                    models.add(model);
                });
                models.sort((a, b) -> Double.compare(
                        ((Number) b.getOrDefault("spend", 0)).doubleValue(),
                        ((Number) a.getOrDefault("spend", 0)).doubleValue()));
                row.put("models", models);
                rows.add(row);
            }
            return rows;
        } catch (IOException ex) {
            log.warn("gateway spend daily failed: {}", ex.getMessage());
            return List.of();
        }
    }

    private String adminUrl(String path) {        String base = props.getLitellmBaseUrl();
        if (base.endsWith("/v1")) {
            base = base.substring(0, base.length() - 3);
        }
        if (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base + path;
    }

    private Map<String, String> auth() {
        String key = props.getLitellmApiKey();
        return key == null || key.isBlank() ? Map.of() : Map.of("Authorization", "Bearer " + key);
    }

    public ObjectMapper mapper() {
        return objectMapper;
    }
}
