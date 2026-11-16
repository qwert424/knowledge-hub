package com.knowledgehub.config;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.integration.engine.RagEngineClient;
import com.knowledgehub.integration.platform.PlatformHealthClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/integrations")
public class IntegrationController {

    private final PlatformHealthClient healthClient;
    private final RagEngineClient engineClient;
    private final NacosConfigInspector nacosInspector;
    private final int embeddingDim;
    private final String langfuseHost;

    public IntegrationController(PlatformHealthClient healthClient, RagEngineClient engineClient,
                                 NacosConfigInspector nacosInspector,
                                 @Value("${kh.llm.embedding-dim:1024}") int embeddingDim,
                                 @Value("${kh.integration.langfuse-host}") String langfuseHost) {
        this.healthClient = healthClient;
        this.engineClient = engineClient;
        this.nacosInspector = nacosInspector;
        this.embeddingDim = embeddingDim;
        this.langfuseHost = langfuseHost;
    }

    @GetMapping("/health")
    public ApiResponse<Map<String, Object>> health() {
        return ApiResponse.ok(healthClient.health());
    }

    /**
     * Model catalog straight from the LiteLLM gateway. The console must never ask an operator to
     * type a model name - it picks from what the gateway actually serves.
     */
    @GetMapping("/models")
    public ApiResponse<Map<String, Object>> models() {
        List<Map<String, Object>> items = new ArrayList<>();
        for (String id : healthClient.modelIds()) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", id);
            item.put("mode", modeOf(id));
            if ("embedding".equals(item.get("mode"))) {
                item.put("dimensions", embeddingDim);
            }
            items.add(item);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("models", items);
        payload.put("source", "litellm");
        return ApiResponse.ok(payload);
    }

    @PostMapping("/models/sync")
    @RequirePermission(PermissionCatalog.PROFILE_MANAGE)
    public ApiResponse<Map<String, Object>> syncModels() {
        return ApiResponse.ok(Map.of("synced", healthClient.modelIds().size()));
    }

    @PostMapping("/engine/reload")
    @RequirePermission(PermissionCatalog.PROFILE_MANAGE)
    public ApiResponse<Object> reloadEngine() {
        return ApiResponse.ok(engineClient.reloadConfig());
    }

    @GetMapping("/nacos-config")
    public ApiResponse<Map<String, Object>> nacosConfig() {
        return ApiResponse.ok(nacosInspector.inspect());
    }

    @GetMapping("/langfuse")
    public ApiResponse<Map<String, Object>> langfuse() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("host", langfuseHost);
        payload.put("health", healthClient.health().get("langfuse"));
        payload.put("embedUrl", langfuseHost + "/project");
        return ApiResponse.ok(payload);
    }

    private String modeOf(String modelId) {
        String id = modelId == null ? "" : modelId.toLowerCase();
        if (id.contains("embed")) {
            return "embedding";
        }
        if (id.contains("rerank")) {
            return "rerank";
        }
        if (id.contains("image") || id.contains("vl") || id.contains("vision")) {
            return "image";
        }
        return "chat";
    }
}