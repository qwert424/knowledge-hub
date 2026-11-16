package com.knowledgehub.integration.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "kh.integration")
public class KhIntegrationProperties {

    private String storageEndpoint = "http://127.0.0.1:9002";
    /** 浏览器可见的对象存储地址：预签名 URL 用它签名（容器名浏览器解析不到） */
    private String storagePublicEndpoint = "";
    private String storageAccessKey = "";
    private String storageSecretKey = "";
    private String storageBucket = "knowledge-hub";
    private int presignExpirySeconds = 900;

    private String engineBaseUrl = "http://127.0.0.1:8100";
    private String agentBaseUrl = "http://127.0.0.1:8123";
    private String internalToken = "";

    private String litellmBaseUrl = "http://127.0.0.1:4000/v1";
    private String litellmApiKey = "";
    private String nacosServer = "http://127.0.0.1:8848";
    private String nacosNamespace = "public";
    private String nacosUsername = "";
    private String nacosPassword = "";
    private String langfuseHost = "http://127.0.0.1:3000";
    private String langfusePublicKey = "";
    private String langfuseSecretKey = "";
    /** 既有 RAG 栈的配置坐标：切片/向量/检索参数以它为准，避免两套系统各写一份 */
    private String nacosRagConfigDataId = "rag_config";
    private String nacosRagConfigGroup = "deal_pilot";
    /** Nacos 控制台（浏览器可访问的地址，通常是 8080；容器内 8848 只是 OpenAPI） */
    private String nacosConsoleUrl = "http://127.0.0.1:8080";

    /** 引擎自身的配置（模型别名/切分/检索/JEV/中间件开关），dataId 见 deploy/nacos/knowledge-hub.yaml */
    private String nacosAgentConfigDataId = "knowledge-hub.yaml";
    private String nacosAgentConfigGroup = "DEFAULT_GROUP";

    private String feishuAppId = "";
    private String feishuAppSecret = "";
    /** 单篇飞书文档最多给多少张图写描述（默认 80；大文档图多时可以调高） */
    private int feishuImageMaxImages = 80;

    public String getStorageEndpoint() {
        return storageEndpoint;
    }

    public void setStorageEndpoint(String storageEndpoint) {
        this.storageEndpoint = normalize(storageEndpoint);
    }

    public String getStoragePublicEndpoint() {
        return storagePublicEndpoint == null || storagePublicEndpoint.isBlank()
                ? storageEndpoint : storagePublicEndpoint;
    }

    public void setStoragePublicEndpoint(String storagePublicEndpoint) {
        this.storagePublicEndpoint = storagePublicEndpoint == null ? "" : normalize(storagePublicEndpoint);
    }

    public String getStorageAccessKey() {
        return storageAccessKey;
    }

    public void setStorageAccessKey(String storageAccessKey) {
        this.storageAccessKey = storageAccessKey;
    }

    public String getStorageSecretKey() {
        return storageSecretKey;
    }

    public void setStorageSecretKey(String storageSecretKey) {
        this.storageSecretKey = storageSecretKey;
    }

    public String getStorageBucket() {
        return storageBucket;
    }

    public void setStorageBucket(String storageBucket) {
        this.storageBucket = storageBucket;
    }

    public int getPresignExpirySeconds() {
        return presignExpirySeconds;
    }

    public void setPresignExpirySeconds(int presignExpirySeconds) {
        this.presignExpirySeconds = presignExpirySeconds;
    }

    public String getEngineBaseUrl() {
        return engineBaseUrl;
    }

    public void setEngineBaseUrl(String engineBaseUrl) {
        this.engineBaseUrl = normalize(engineBaseUrl);
    }

    public String getAgentBaseUrl() {
        return agentBaseUrl;
    }

    public void setAgentBaseUrl(String agentBaseUrl) {
        this.agentBaseUrl = normalize(agentBaseUrl);
    }

    public String getInternalToken() {
        return internalToken;
    }

    public void setInternalToken(String internalToken) {
        this.internalToken = internalToken;
    }

    public String getLitellmBaseUrl() {
        return litellmBaseUrl;
    }

    public void setLitellmBaseUrl(String litellmBaseUrl) {
        this.litellmBaseUrl = normalize(litellmBaseUrl);
    }

    public String getLitellmApiKey() {
        return litellmApiKey;
    }

    public void setLitellmApiKey(String litellmApiKey) {
        this.litellmApiKey = litellmApiKey;
    }

    public String getNacosServer() {
        return nacosServer;
    }

    public void setNacosServer(String nacosServer) {
        this.nacosServer = normalize(nacosServer);
    }

    public String getNacosNamespace() {
        return nacosNamespace;
    }

    public void setNacosNamespace(String nacosNamespace) {
        this.nacosNamespace = nacosNamespace;
    }

    public String getNacosUsername() {
        return nacosUsername;
    }

    public void setNacosUsername(String nacosUsername) {
        this.nacosUsername = nacosUsername;
    }

    public String getNacosPassword() {
        return nacosPassword;
    }

    public void setNacosPassword(String nacosPassword) {
        this.nacosPassword = nacosPassword;
    }

    public String getLangfuseHost() {
        return langfuseHost;
    }

    public void setLangfuseHost(String langfuseHost) {
        this.langfuseHost = normalize(langfuseHost);
    }

    public String getLangfusePublicKey() {
        return langfusePublicKey;
    }

    public void setLangfusePublicKey(String langfusePublicKey) {
        this.langfusePublicKey = stripQuotes(langfusePublicKey);
    }

    public String getLangfuseSecretKey() {
        return langfuseSecretKey;
    }

    public void setLangfuseSecretKey(String langfuseSecretKey) {
        this.langfuseSecretKey = stripQuotes(langfuseSecretKey);
    }

    private static String stripQuotes(String value) {
        if (value == null) {
            return "";
        }
        String trimmed = value.trim();
        if (trimmed.length() >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            return trimmed.substring(1, trimmed.length() - 1);
        }
        return trimmed;
    }

    private static String normalize(String endpoint) {
        if (endpoint == null || endpoint.isBlank()) {
            return endpoint;
        }
        String trimmed = endpoint.trim();
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
            return "http://" + trimmed;
        }
        return trimmed;
    }

    public String getNacosRagConfigDataId() {
        return nacosRagConfigDataId;
    }

    public void setNacosRagConfigDataId(String nacosRagConfigDataId) {
        this.nacosRagConfigDataId = nacosRagConfigDataId;
    }

    public String getNacosRagConfigGroup() {
        return nacosRagConfigGroup;
    }

    public String getNacosAgentConfigDataId() {
        return nacosAgentConfigDataId;
    }

    public void setNacosAgentConfigDataId(String nacosAgentConfigDataId) {
        this.nacosAgentConfigDataId = nacosAgentConfigDataId;
    }

    public String getNacosAgentConfigGroup() {
        return nacosAgentConfigGroup;
    }

    public void setNacosAgentConfigGroup(String nacosAgentConfigGroup) {
        this.nacosAgentConfigGroup = nacosAgentConfigGroup;
    }

    public void setNacosRagConfigGroup(String nacosRagConfigGroup) {
        this.nacosRagConfigGroup = nacosRagConfigGroup;
    }

    public String getNacosConsoleUrl() {
        return nacosConsoleUrl;
    }

    public void setNacosConsoleUrl(String nacosConsoleUrl) {
        this.nacosConsoleUrl = normalize(nacosConsoleUrl);
    }

    public String getFeishuAppId() {        return feishuAppId;
    }

    public void setFeishuAppId(String feishuAppId) {
        this.feishuAppId = feishuAppId;
    }

    public String getFeishuAppSecret() {
        return feishuAppSecret;
    }

    public void setFeishuAppSecret(String feishuAppSecret) {
        this.feishuAppSecret = feishuAppSecret;
    }

    public int getFeishuImageMaxImages() {
        return feishuImageMaxImages;
    }

    public void setFeishuImageMaxImages(int feishuImageMaxImages) {
        this.feishuImageMaxImages = feishuImageMaxImages;
    }
}