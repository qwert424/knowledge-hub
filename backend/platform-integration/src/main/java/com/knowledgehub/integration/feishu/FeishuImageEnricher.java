package com.knowledgehub.integration.feishu;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.knowledgehub.integration.config.KhIntegrationProperties;
import com.knowledgehub.integration.http.JsonHttpClient;
import com.knowledgehub.integration.storage.ObjectStorageClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 飞书文档里的图片：下载 → 落 MinIO → 让视觉模型写一段描述 → 回填到 blocks JSON 的
 * {@code image.caption}，引擎侧把 caption 当成可检索文本（图本身不可检索）。
 *
 * <p>这条链路对应既有 RAG 项目的 {@code image_parser}：图片 token 存下来，原文在对象存储里，
 * 切片里留的是描述 + token，回答时按需回读图片。任何一步失败都只是少一条描述，不影响导入。
 */
@Component
public class FeishuImageEnricher {

    private static final Logger log = LoggerFactory.getLogger(FeishuImageEnricher.class);
    private static final int IMAGE_BLOCK = 27;
    /**
     * 单篇文档最多处理多少张图。之前写死 20，长文档后半段的图全丢了；
     * 现在改成可配置（默认 80），并且超限时打日志，导入结果里能看到"被截断"。
     */
    private static final int DEFAULT_MAX_IMAGES = 80;

    private static final String DEFAULT_PROMPT = """
            你在为知识库做图片索引。请用简体中文写一段 1-3 句的描述，说明这张图的类型（流程图/截图/表格/照片等）
            与它传达的关键信息（步骤、字段、数值、结论）。只输出描述本身，不要加"这张图"之类的前缀，不要编造看不清的内容。
            """;

    private final FeishuClient feishu;
    private final ObjectStorageClient storage;
    private final JsonHttpClient http;
    private final KhIntegrationProperties props;
    private final ObjectMapper objectMapper;

    public FeishuImageEnricher(FeishuClient feishu, ObjectStorageClient storage, JsonHttpClient http,
                               KhIntegrationProperties props, ObjectMapper objectMapper) {
        this.feishu = feishu;
        this.storage = storage;
        this.http = http;
        this.props = props;
        this.objectMapper = objectMapper;
    }

    /**
     * 给 blocks JSON 里的图片补上 caption。
     *
     * @param blocksJson  引擎能直接吃的 {@code {"blocks": [...]}}
     * @param bucket      rag_config 里 {@code image_parser.bucket_name}，为空则用默认桶
     * @param vlModel     rag_config 里 {@code image_parser.vl_model_config.name}，为空则不处理图片
     * @param prompt      图片解析提示词（来自 Nacos prompt，可为空）
     */
    public String enrich(String blocksJson, String tenantId, String documentId, String bucket, String vlModel,
                         String prompt) {
        if (blocksJson == null || blocksJson.isBlank() || vlModel == null || vlModel.isBlank()) {
            return blocksJson;
        }
        JsonNode root;
        try {
            root = objectMapper.readTree(blocksJson);
        } catch (Exception ex) {
            return blocksJson;
        }
        JsonNode blocks = root.path("blocks");
        if (!blocks.isArray()) {
            return blocksJson;
        }
        String template = prompt == null || prompt.isBlank() ? DEFAULT_PROMPT : prompt;
        int maxImages = maxImages();
        int images = 0;
        for (JsonNode block : blocks) {
            if (block.path("block_type").asInt(0) == IMAGE_BLOCK) {
                images++;
            }
        }
        int processed = 0;
        int captioned = 0;
        for (JsonNode block : blocks) {
            if (processed >= maxImages) {
                log.info("document {} has {} images, only first {} were captioned (kh.feishu.image.max-images)",
                        documentId, images, maxImages);
                break;
            }
            if (block.path("block_type").asInt(0) != IMAGE_BLOCK || !(block instanceof ObjectNode node)) {
                continue;
            }
            JsonNode image = node.path("image");
            if (!(image instanceof ObjectNode imageNode)) {
                continue;
            }
            String token = imageNode.path("token").asText("");
            if (token.isBlank()) {
                continue;
            }
            processed++;
            try {
                byte[] bytes = feishu.downloadImage(token);
                if (bytes.length == 0) {
                    continue;
                }
                String mime = guessMime(bytes);
                String objectKey = "%s/feishu-images/%s/%s.%s".formatted(
                        tenantId == null ? "default" : tenantId, documentId, token, extensionOf(mime));
                try {
                    storage.putObject(bucket == null || bucket.isBlank() ? objectKey : bucket + "/" + objectKey,
                            bytes, mime);
                } catch (RuntimeException ex) {
                    log.debug("image store failed for {}: {}", token, ex.getMessage());
                }
                String caption = caption(bytes, mime, template, vlModel);
                if (caption.isBlank()) {
                    continue;
                }
                imageNode.put("caption", caption);
                imageNode.put("mime", mime);
                captioned++;
            } catch (RuntimeException ex) {
                log.debug("image {} skipped: {}", token, ex.getMessage());
            }
        }
        if (captioned == 0) {
            return blocksJson;
        }
        try {
            return objectMapper.writeValueAsString(root);
        } catch (Exception ex) {
            return blocksJson;
        }
    }

    /** 视觉模型：走网关的多模态 chat，base64 直传，免去对象存储的对外可达要求。 */
    private int maxImages() {
        int configured = props.getFeishuImageMaxImages();
        return configured > 0 ? configured : DEFAULT_MAX_IMAGES;
    }

    private String caption(byte[] image, String mime, String prompt, String model) {
        String baseUrl = props.getLitellmBaseUrl();
        if (baseUrl == null || baseUrl.isBlank() || props.getLitellmApiKey() == null) {
            return "";
        }
        Map<String, Object> imageUrl = new LinkedHashMap<>();
        imageUrl.put("url", "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(image));
        Map<String, Object> textPart = Map.of("type", "text", "text", prompt);
        Map<String, Object> imagePart = Map.of("type", "image_url", "image_url", imageUrl);
        Map<String, Object> message = Map.of("role", "user", "content", List.of(textPart, imagePart));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("messages", new ArrayList<>(List.of(message)));
        body.put("temperature", 0.2);
        body.put("max_tokens", 320);
        try {
            JsonNode response = http.post(baseUrl + "/chat/completions",
                    Map.of("Authorization", "Bearer " + props.getLitellmApiKey()), body, Duration.ofSeconds(40));
            String text = response.path("choices").path(0).path("message").path("content").asText("");
            return text == null ? "" : text.trim();
        } catch (Exception ex) {
            log.warn("image caption failed (model={}): {}", model, ex.getMessage());
            return "";
        }
    }

    private String guessMime(byte[] bytes) {
        if (bytes.length > 3 && (bytes[0] & 0xFF) == 0x89 && bytes[1] == 'P') {
            return "image/png";
        }
        if (bytes.length > 2 && (bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xFF) == 0xD8) {
            return "image/jpeg";
        }
        if (bytes.length > 3 && bytes[0] == 'G' && bytes[1] == 'I') {
            return "image/gif";
        }
        return "image/png";
    }

    private String extensionOf(String mime) {
        return switch (mime) {
            case "image/jpeg" -> "jpg";
            case "image/gif" -> "gif";
            case "image/webp" -> "webp";
            default -> "png";
        };
    }
}
