package com.knowledgehub.integration.feishu;

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
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** 飞书开放平台客户端：tenant token、文本消息、文档正文/结构与知识空间。 */
@Component
public class FeishuClient {

    private static final Logger log = LoggerFactory.getLogger(FeishuClient.class);
    private static final String BASE = "https://open.feishu.cn/open-apis";

    private final KhIntegrationProperties props;
    private final JsonHttpClient http;
    private final ObjectMapper objectMapper;
    private volatile String cachedToken;
    private volatile long tokenExpireAt;

    public FeishuClient(KhIntegrationProperties props, JsonHttpClient http, ObjectMapper objectMapper) {
        this.props = props;
        this.http = http;
        this.objectMapper = objectMapper;
    }

    public boolean configured() {
        return props.getFeishuAppId() != null && !props.getFeishuAppId().isBlank();
    }

    public String tenantAccessToken() {
        if (cachedToken != null && System.currentTimeMillis() < tokenExpireAt) {
            return cachedToken;
        }
        Map<String, Object> body = new HashMap<>();
        body.put("app_id", props.getFeishuAppId());
        body.put("app_secret", props.getFeishuAppSecret());
        try {
            JsonNode response = http.post(BASE + "/auth/v3/tenant_access_token/internal", Map.of(), body,
                    Duration.ofSeconds(10));
            cachedToken = response.path("tenant_access_token").asText();
            long expire = response.path("expire").asLong(7200);
            tokenExpireAt = System.currentTimeMillis() + (expire - 120) * 1000;
            return cachedToken;
        } catch (Exception ex) {
            throw new IllegalStateException("获取飞书 tenant_access_token 失败: " + ex.getMessage(), ex);
        }
    }

    /**
     * 按飞书链接（或 token）拉取正文。支持 docx 与 wiki（wiki 节点会解析到实际文档）。
     * 只做只读拉取，不需要用户授权，用的是应用自己的 tenant_access_token。
     */
    public FeishuDoc fetchDocument(String urlOrToken) {
        if (!configured()) {
            throw new IllegalStateException("飞书未配置：请在环境变量里设置 FEISHU_APP_ID / FEISHU_APP_SECRET");
        }
        LinkRef ref = LinkRef.parse(urlOrToken);
        String objType = ref.kind();
        String objToken = ref.token();
        String title = "";
        if ("wiki".equals(objType)) {
            JsonNode node = call("/wiki/v2/spaces/get_node?token=" + enc(objToken), "解析 wiki 节点");
            JsonNode data = node.path("data").path("node");
            objType = data.path("obj_type").asText("docx");
            objToken = data.path("obj_token").asText("");
            title = data.path("title").asText("");
            if (objToken.isBlank()) {
                throw new IllegalStateException("该 wiki 节点没有可读取的文档对象（可能是文件夹或快捷方式）");
            }
        }
        if (!"docx".equals(objType)) {
            throw new IllegalStateException("暂只支持飞书文档（docx）与知识库（wiki）里的文档，当前类型: " + objType);
        }
        if (title.isBlank()) {
            JsonNode meta = call("/docx/v1/documents/" + objToken, "读取飞书文档信息");
            title = meta.path("data").path("document").path("title").asText("");
        }
        // 优先拉结构化 blocks：引擎侧 blocks_to_ir 会还原标题层级与表格，
        // 比 raw_content 的纯文本更适合切片。失败再退回纯文本。
        String blocksJson = "";
        String text = "";
        try {
            blocksJson = blocksJson(objToken);
        } catch (RuntimeException ex) {
            log.debug("feishu blocks fetch failed for {}: {}", objToken, ex.getMessage());
        }
        try {
            JsonNode content = call("/docx/v1/documents/" + objToken + "/raw_content", "下载飞书文档正文");
            text = content.path("data").path("content").asText("");
        } catch (RuntimeException ex) {
            if (blocksJson.isBlank()) {
                throw ex;
            }
        }
        if (blocksJson.isBlank() && text.isBlank()) {
            throw new IllegalStateException("飞书文档正文为空，或应用没有该文档的阅读权限");
        }
        return new FeishuDoc(title.isBlank() ? "飞书文档 " + objToken : title, text, blocksJson, objType,
                objToken, ref.url());
    }

    /** 全部 DocxBlock（自动翻页），拼成引擎能直接吃的 ``{"blocks": [...]}``。 */
    public String blocksJson(String documentId) {
        com.fasterxml.jackson.databind.node.ObjectNode payload = objectMapper.createObjectNode();
        com.fasterxml.jackson.databind.node.ArrayNode blocks = payload.putArray("blocks");
        String pageToken = "";
        int guard = 0;
        while (guard++ < 40) {
            String path = "/docx/v1/documents/" + enc(documentId) + "/blocks?page_size=500&document_revision_id=-1"
                    + (pageToken.isBlank() ? "" : "&page_token=" + enc(pageToken));
            JsonNode body = call(path, "读取飞书文档结构");
            JsonNode data = body.path("data");
            for (JsonNode item : data.path("items")) {
                blocks.add(item);
            }
            if (!data.path("has_more").asBoolean(false)) {
                break;
            }
            pageToken = data.path("page_token").asText("");
            if (pageToken.isBlank()) {
                break;
            }
        }
        if (blocks.isEmpty()) {
            throw new IllegalStateException("飞书文档没有返回任何块");
        }
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (Exception ex) {
            throw new IllegalStateException("序列化飞书文档结构失败: " + ex.getMessage(), ex);
        }
    }

    /**
     * 下载文档里的图片（media 接口返回二进制，不是 JSON，所以走原始 HttpClient）。
     * 需要应用具备 {@code drive:drive} 或文档附件读权限。
     */
    public byte[] downloadImage(String fileToken) {
        String url = BASE + "/drive/v1/medias/" + enc(fileToken) + "/download";
        try {
            java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder(java.net.URI.create(url))
                    .timeout(Duration.ofSeconds(30))
                    .header("Authorization", "Bearer " + tenantAccessToken())
                    .GET()
                    .build();
            java.net.http.HttpResponse<byte[]> response = http.raw()
                    .send(request, java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() >= 400) {
                throw new IllegalStateException("下载飞书图片失败：HTTP " + response.statusCode());
            }
            return response.body();
        } catch (IOException ex) {
            throw new IllegalStateException("下载飞书图片失败: " + ex.getMessage(), ex);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("下载飞书图片被中断", ex);
        }
    }

    /** 应用身份可访问的知识空间。 */    public List<Map<String, Object>> spaces() {
        if (!configured()) {
            return List.of();
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        String pageToken = "";
        int guard = 0;
        while (guard++ < 20) {
            String path = "/wiki/v2/spaces?page_size=50" + (pageToken.isBlank() ? "" : "&page_token=" + enc(pageToken));
            JsonNode body = call(path, "读取飞书知识空间");
            JsonNode data = body.path("data");
            for (JsonNode item : data.path("items")) {
                rows.add(Map.of(
                        "spaceId", item.path("space_id").asText(""),
                        "name", item.path("name").asText(""),
                        "description", item.path("description").asText("")));
            }
            if (!data.path("has_more").asBoolean(false)) {
                break;
            }
            pageToken = data.path("page_token").asText("");
            if (pageToken.isBlank()) {
                break;
            }
        }
        return rows;
    }

    /** 知识空间下的节点（一层）；parentToken 为空时取根目录。 */
    public List<Map<String, Object>> nodes(String spaceId, String parentToken) {
        List<Map<String, Object>> rows = new ArrayList<>();
        String pageToken = "";
        int guard = 0;
        while (guard++ < 20) {
            String path = "/wiki/v2/spaces/" + enc(spaceId) + "/nodes?page_size=50"
                    + (parentToken == null || parentToken.isBlank() ? "" : "&parent_node_token=" + enc(parentToken))
                    + (pageToken.isBlank() ? "" : "&page_token=" + enc(pageToken));
            JsonNode body = call(path, "读取知识空间节点");
            JsonNode data = body.path("data");
            for (JsonNode item : data.path("items")) {
                String nodeToken = item.path("node_token").asText("");
                Map<String, Object> row = new java.util.LinkedHashMap<>();
                row.put("nodeToken", nodeToken);
                row.put("objToken", item.path("obj_token").asText(""));
                row.put("objType", item.path("obj_type").asText(""));
                row.put("title", item.path("title").asText(""));
                row.put("hasChild", item.path("has_child").asBoolean(false));
                row.put("url", "https://feishu.cn/wiki/" + nodeToken);
                rows.add(row);
            }
            if (!data.path("has_more").asBoolean(false)) {
                break;
            }
            pageToken = data.path("page_token").asText("");
            if (pageToken.isBlank()) {
                break;
            }
        }
        return rows;
    }

    private JsonNode call(String path, String action) {
        try {
            JsonNode response = http.get(BASE + path,
                    Map.of("Authorization", "Bearer " + tenantAccessToken()), Duration.ofSeconds(20));
            int code = response.path("code").asInt(0);
            if (code != 0) {
                throw new IllegalStateException(action + "失败: " + response.path("msg").asText("未知错误")
                        + "（code=" + code + "）");
            }
            return response;
        } catch (IOException ex) {
            throw new IllegalStateException(action + "失败: " + ex.getMessage(), ex);
        }
    }

    private static String enc(String value) {
        return java.net.URLEncoder.encode(value == null ? "" : value, java.nio.charset.StandardCharsets.UTF_8);
    }

    public void sendText(String receiveId, String receiveIdType, String text) {
        Map<String, Object> body = Map.of(
                "receive_id", receiveId,
                "msg_type", "text",
                "content", "{\"text\":\"" + text.replace("\"", "\\\"") + "\"}");
        try {
            http.post(BASE + "/im/v1/messages?receive_id_type=" + receiveIdType,
                    Map.of("Authorization", "Bearer " + tenantAccessToken()), body, Duration.ofSeconds(10));
        } catch (Exception ex) {
            throw new IllegalStateException("飞书消息发送失败: " + ex.getMessage(), ex);
        }
    }

    /** 一份飞书文档的正文与元信息。 */
    public record FeishuDoc(String title, String text, String blocksJson, String objType, String objToken,
                            String url) {
    }

    /**
     * 从用户粘贴的链接里解析出对象类型和 token。
     * 支持 https://xxx.feishu.cn/docx/<token>、/wiki/<token>、/docs/<token>，以及直接粘 token。
     */
    record LinkRef(String kind, String token, String url) {
        private static final java.util.regex.Pattern PATTERN =
                java.util.regex.Pattern.compile("feishu\\.cn/(docx|wiki|docs|doc|sheets|base)/([A-Za-z0-9]+)");

        static LinkRef parse(String input) {
            String text = input == null ? "" : input.trim();
            if (text.isEmpty()) {
                throw new IllegalStateException("请填写飞书文档链接或 token");
            }
            java.util.regex.Matcher matcher = PATTERN.matcher(text);
            if (matcher.find()) {
                String kind = matcher.group(1);
                String normalized = switch (kind) {
                    case "docs", "doc" -> "doc";
                    case "wiki" -> "wiki";
                    case "docx" -> "docx";
                    default -> kind;
                };
                return new LinkRef(normalized, matcher.group(2), text);
            }
            if (text.startsWith("http")) {
                throw new IllegalStateException("无法识别的飞书链接，请使用文档链接（/docx/… 或 /wiki/…）");
            }
            return new LinkRef("docx", text, "https://feishu.cn/docx/" + text);
        }
    }
}