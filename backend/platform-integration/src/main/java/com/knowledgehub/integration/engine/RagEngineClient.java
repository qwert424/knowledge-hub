package com.knowledgehub.integration.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.integration.config.KhIntegrationProperties;
import com.knowledgehub.integration.http.JsonHttpClient;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Component
public class RagEngineClient {

    private final KhIntegrationProperties props;
    private final JsonHttpClient http;

    public RagEngineClient(KhIntegrationProperties props, JsonHttpClient http) {
        this.props = props;
        this.http = http;
    }

    public JsonNode retrieve(String ticket, List<String> kbIds, String query, JsonNode profile,
                             int topK, boolean debug, Map<String, String> kbCollections,
                             Map<String, Object> filters) {
        Map<String, Object> body = new HashMap<>();
        body.put("ticket", ticket);
        body.put("kb_ids", kbIds);
        body.put("query", query);
        body.put("profile", profile);
        if (kbCollections != null && !kbCollections.isEmpty()) {
            body.put("kb_collections", kbCollections);
        }
        if (filters != null && !filters.isEmpty()) {
            body.put("filters", filters);
        }
        body.put("top_k", topK);
        body.put("debug", debug);
        try {
            return http.post(props.getEngineBaseUrl() + "/v1/retrieve", Map.of(), body, Duration.ofSeconds(30));
        } catch (IOException ex) {
            throw new BizException(ErrorCode.ENGINE_UNAVAILABLE, "检索服务调用失败: " + ex.getMessage());
        }
    }

    /**
     * 非流式回答（评测用）：和用户端问答走同一条链路，但一次性返回整段答复。
     * 超时给到 120s——一次评测可能要等模型把长答案写完。
     */
    public JsonNode answer(String ticket, List<String> kbIds, String query, JsonNode profile,
                           Map<String, String> kbCollections, String conversationId) {
        Map<String, Object> body = new HashMap<>();
        body.put("ticket", ticket);
        body.put("kb_ids", kbIds);
        body.put("query", query);
        body.put("profile", profile);
        body.put("conversation_id", conversationId == null ? "" : conversationId);
        if (kbCollections != null && !kbCollections.isEmpty()) {
            body.put("kb_collections", kbCollections);
        }
        try {
            return http.post(props.getEngineBaseUrl() + "/v1/answer", Map.of(), body, Duration.ofSeconds(120));
        } catch (IOException ex) {
            throw new BizException(ErrorCode.ENGINE_UNAVAILABLE, "回答服务调用失败: " + ex.getMessage());
        }
    }

    public JsonNode submitIndexJob(Map<String, Object> payload) {        try {
            return http.post(props.getEngineBaseUrl() + "/v1/index/jobs", Map.of(), payload,
                    Duration.ofSeconds(15));
        } catch (IOException ex) {
            throw new BizException(ErrorCode.ENGINE_UNAVAILABLE, "索引服务调用失败: " + ex.getMessage());
        }
    }

    public JsonNode graphQuery(Map<String, Object> payload) {
        try {
            return http.post(props.getEngineBaseUrl() + "/v1/graph/query", Map.of(), payload,
                    Duration.ofSeconds(30));
        } catch (IOException ex) {
            throw new BizException(ErrorCode.ENGINE_UNAVAILABLE, "图谱服务调用失败: " + ex.getMessage());
        }
    }

    public JsonNode buildGraph(Map<String, Object> payload) {
        try {
            // 每篇文档一次 LLM 抽取，十几篇就要几分钟：30s 不够，会以"超时"形态失败
            return http.post(props.getEngineBaseUrl() + "/v1/graph/build", Map.of(), payload,
                    Duration.ofSeconds(300));
        } catch (IOException ex) {
            throw new BizException(ErrorCode.ENGINE_UNAVAILABLE, "图谱构建调用失败: " + ex.getMessage());
        }
    }

    public JsonNode health() {
        try {
            return http.get(props.getEngineBaseUrl() + "/health", Map.of(), Duration.ofSeconds(3));
        } catch (IOException ex) {
            return null;
        }
    }

    public JsonNode reloadConfig() {
        try {
            return http.post(props.getEngineBaseUrl() + "/v1/admin/reload", Map.of(), Map.of(),
                    Duration.ofSeconds(10));
        } catch (IOException ex) {
            throw new BizException(ErrorCode.ENGINE_UNAVAILABLE, "配置重载失败: " + ex.getMessage());
        }
    }
}