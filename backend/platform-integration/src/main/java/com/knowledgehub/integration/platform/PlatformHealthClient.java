package com.knowledgehub.integration.platform;

import com.fasterxml.jackson.databind.JsonNode;
import com.knowledgehub.integration.config.KhIntegrationProperties;
import com.knowledgehub.integration.http.JsonHttpClient;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

@Component
public class PlatformHealthClient {

    private final KhIntegrationProperties props;
    private final JsonHttpClient http;

    public PlatformHealthClient(KhIntegrationProperties props, JsonHttpClient http) {
        this.props = props;
        this.http = http;
    }

    public Map<String, Object> health() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("storage", http.status(props.getStorageEndpoint() + "/minio/health/live",
                Duration.ofSeconds(2)) == 200);
        result.put("nacos", nacosHealthy());
        result.put("litellm", http.status(props.getLitellmBaseUrl() + "/models",
                Duration.ofSeconds(2)) > 0);
        result.put("langfuse", http.status(props.getLangfuseHost() + "/api/public/health",
                Duration.ofSeconds(2)) == 200);
        result.put("engine", http.status(props.getEngineBaseUrl() + "/health",
                Duration.ofSeconds(2)) == 200);
        // 管理台要看到"哪个组件、什么地址、什么版本"，光一个布尔值没法定位问题
        result.put("items", items(result));
        result.put("checkedAt", java.time.OffsetDateTime.now().toString());
        return result;
    }

    private java.util.List<Map<String, Object>> items(Map<String, Object> probe) {
        java.util.List<Map<String, Object>> rows = new java.util.ArrayList<>();
        rows.add(row("MinIO 对象存储", probe.get("storage"), publicUrl(getStorageEndpoint(), 9002),
                "上传与原文快照"));
        rows.add(row("Nacos 配置中心", probe.get("nacos"), getNacosConsoleUrl(),
                getNacosRagConfigDataId() + " / " + getNacosRagConfigGroup()));
        int modelCount = modelIds().size();
        rows.add(row("LiteLLM 模型网关", probe.get("litellm"), publicUrl(getLitellmBaseUrl(), 4000),
                modelCount > 0 ? modelCount + " 个模型可用" : "没有读到模型清单"));
        rows.add(row("Langfuse 链路追踪", probe.get("langfuse"), publicUrl(getLangfuseHost(), 3000),
                "trace 落库与成本"));
        rows.add(row("RAG 引擎", probe.get("engine"), publicUrl(getEngineBaseUrl(), 8100), engineDetail()));
        return rows;
    }

    private String getStorageEndpoint() {
        return props.getStorageEndpoint();
    }

    private String getNacosConsoleUrl() {
        return props.getNacosConsoleUrl();
    }

    private String getLitellmBaseUrl() {
        return props.getLitellmBaseUrl();
    }

    private String getLangfuseHost() {
        return props.getLangfuseHost();
    }

    private String getEngineBaseUrl() {
        return props.getEngineBaseUrl();
    }

    private String getNacosRagConfigDataId() {
        return props.getNacosRagConfigDataId();
    }

    private String getNacosRagConfigGroup() {
        return props.getNacosRagConfigGroup();
    }

    /**
     * 只展示浏览器能打开的地址：容器内是 {@code http://service:port} 或
     * {@code host.docker.internal:port}，浏览器都解析不到，统一换成本机 127.0.0.1 对应端口
     * （compose 都把端口映射到了宿主）。
     */
    private String publicUrl(String configured, int fallbackPort) {
        if (configured == null || configured.isBlank()) {
            return "http://127.0.0.1:" + fallbackPort;
        }
        String value = configured.endsWith("/v1") ? configured.substring(0, configured.length() - 3) : configured;
        int schemeEnd = value.indexOf("://");
        if (schemeEnd < 0) {
            return "http://127.0.0.1:" + fallbackPort;
        }
        String rest = value.substring(schemeEnd + 3);
        int slash = rest.indexOf('/');
        String authority = slash < 0 ? rest : rest.substring(0, slash);
        int colon = authority.lastIndexOf(':');
        String host = colon < 0 ? authority : authority.substring(0, colon);
        String port = colon < 0 ? "" : authority.substring(colon + 1);
        if ("127.0.0.1".equals(host) || "localhost".equals(host)) {
            return value;
        }
        return "http://127.0.0.1:" + (port.isBlank() ? String.valueOf(fallbackPort) : port);
    }

    private Map<String, Object> row(String name, Object ok, String endpoint, String detail) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", name);
        row.put("status", Boolean.TRUE.equals(ok) ? "ok" : "down");
        row.put("endpoint", endpoint);
        row.put("detail", detail);
        return row;
    }

    /** 引擎 /health 里有版本、配置来源与向量库状态，直接展示出来比"健康/异常"有用。 */
    private String engineDetail() {
        try {
            JsonNode body = http.get(props.getEngineBaseUrl() + "/health", Map.of(), Duration.ofSeconds(3));
            if (body == null) {
                return "无响应";
            }
            String version = body.path("version").asText("");
            String source = body.path("config_source").asText("");
            boolean milvus = body.path("milvus").asBoolean(false);
            String graph = body.path("graph").isBoolean() ? String.valueOf(body.path("graph").asBoolean()) : "";
            StringBuilder text = new StringBuilder();
            if (!version.isBlank()) {
                text.append("v").append(version).append(" · ");
            }
            if (!source.isBlank()) {
                text.append("配置来源 ").append(source).append(" · ");
            }
            text.append("向量库 ").append(milvus ? "正常" : "异常");
            if (!graph.isBlank()) {
                text.append(" · 图谱 ").append("true".equals(graph) ? "正常" : "异常");
            }
            return text.toString();
        } catch (Exception ex) {
            // 不吞信息：异常类型 + 消息，避免只显示"读取失败：null"
            String reason = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
            return "读取失败：" + reason;
        }
    }

    /**
     * Nacos 3.x gates the readiness API behind auth, so probe several endpoints and treat any
     * 2xx/4xx response (i.e. the server is answering) as reachable.
     */
    private boolean nacosHealthy() {
        for (String path : new String[]{"/nacos/v1/console/health/readiness",
                "/nacos/v3/admin/core/cluster/node/self", "/nacos/"}) {
            int status = http.status(props.getNacosServer() + path, Duration.ofSeconds(2));
            if (status >= 200 && status < 500) {
                return true;
            }
        }
        return false;
    }

    public JsonNode litellmModels() {
        try {
            return http.get(props.getLitellmBaseUrl() + "/models",
                    Map.of("Authorization", "Bearer " + props.getLitellmApiKey()), Duration.ofSeconds(10));
        } catch (Exception ex) {
            return null;
        }
    }

    public java.util.List<String> modelIds() {
        JsonNode models = litellmModels();
        if (models == null || !models.has("data")) {
            return java.util.List.of();
        }
        java.util.List<String> ids = new java.util.ArrayList<>();
        models.get("data").forEach(node -> {
            if (node.hasNonNull("id")) {
                ids.add(node.get("id").asText());
            }
        });
        return ids;
    }
}