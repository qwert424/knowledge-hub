package com.knowledgehub.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.integration.http.JsonHttpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/** Read-only view of the Nacos config that actually drives the engine. */
@Component
public class NacosConfigInspector {

    private static final Logger log = LoggerFactory.getLogger(NacosConfigInspector.class);

    private final JsonHttpClient http;
    private final ObjectMapper objectMapper;
    private final String server;
    private final String namespace;
    private final String group;
    private final String dataId;
    private final String username;
    private final String password;

    public NacosConfigInspector(JsonHttpClient http, ObjectMapper objectMapper,
                                @Value("${kh.integration.nacos-server}") String server,
                                @Value("${kh.integration.nacos-namespace:public}") String namespace,
                                @Value("${kh.integration.nacos-group:DEFAULT_GROUP}") String group,
                                @Value("${kh.integration.nacos-data-id:knowledge-hub.yaml}") String dataId,
                                @Value("${kh.integration.nacos-username:}") String username,
                                @Value("${kh.integration.nacos-password:}") String password) {
        this.http = http;
        this.objectMapper = objectMapper;
        this.server = server;
        this.namespace = namespace;
        this.group = group;
        this.dataId = dataId;
        this.username = username;
        this.password = password;
    }

    public Map<String, Object> inspect() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("server", server);
        result.put("namespace", namespace);
        result.put("group", group);
        result.put("dataId", dataId);

        String content = fetchConfig();
        if (content == null || content.isBlank()) {
            result.put("source", "defaults");
            result.put("available", false);
            result.put("hint", "Nacos 中未找到该配置；引擎正在使用内置默认值 + .env 覆盖");
            return result;
        }
        result.put("source", "nacos");
        result.put("available", true);
        try {
            JsonNode root = objectMapper.readTree(content);
            Map<String, Object> highlights = new LinkedHashMap<>();
            highlights.put("chatModel", root.path("llm").path("chat_model").asText(null));
            highlights.put("embeddingModel", root.path("embedding").path("model").asText(null));
            highlights.put("embeddingDim", root.path("embedding").path("dimensions").asInt(0));
            highlights.put("chunkSize", root.path("chunking").path("chunk_size").asInt(0));
            highlights.put("chunkOverlap", root.path("chunking").path("chunk_overlap").asInt(0));
            highlights.put("topK", root.path("retrieval").path("top_k").asInt(0));
            highlights.put("fusion", root.path("retrieval").path("fusion").path("strategy").asText(null));
            highlights.put("rerankEnabled", root.path("retrieval").path("rerank").path("enabled").asBoolean(false));
            highlights.put("graphEnabled", root.path("retrieval").path("graph").path("enabled").asBoolean(false));
            highlights.put("jevMinConfidence",
                    root.path("jev").path("min_confidence").asDouble(0));
            result.put("highlights", highlights);
            result.put("raw", content);
        } catch (Exception ex) {
            result.put("available", false);
            result.put("hint", "配置存在但无法解析为 YAML/JSON：" + ex.getMessage());
        }
        return result;
    }

    private String fetchConfig() {
        String token = login();
        String suffix = token == null ? "" : "&accessToken=" + token;
        String ns = "public".equals(namespace) ? "" : namespace;
        String[] urls = {
                server + "/nacos/v3/client/cs/config?dataId=" + dataId + "&groupName=" + group
                        + "&namespaceId=" + ns + suffix,
                server + "/nacos/v2/cs/config?dataId=" + dataId + "&group=" + group
                        + "&namespaceId=" + ns + suffix
        };
        for (String url : urls) {
            try {
                JsonNode node = http.get(url, Map.of(), Duration.ofSeconds(4));
                String content = node.path("data").isTextual()
                        ? node.path("data").asText()
                        : node.path("content").asText(null);
                if (content != null && !content.isBlank()) {
                    return content;
                }
            } catch (Exception ex) {
                log.debug("nacos config probe failed: {}", ex.getMessage());
            }
        }
        return null;
    }

    private String login() {
        if (username == null || username.isBlank()) {
            return null;
        }
        try {
            JsonNode node = http.post(server + "/nacos/v1/auth/login", Map.of(),
                    Map.of("username", username, "password", password), Duration.ofSeconds(4));
            String token = node.path("accessToken").asText(null);
            return token == null || token.isBlank() ? null : token;
        } catch (Exception ex) {
            return null;
        }
    }
}