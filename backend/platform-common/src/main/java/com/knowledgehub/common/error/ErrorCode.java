package com.knowledgehub.common.error;

import org.springframework.http.HttpStatus;

public enum ErrorCode {
    AUTH_401(HttpStatus.UNAUTHORIZED, "未登录或 Token 已过期"),
    AUTH_403(HttpStatus.FORBIDDEN, "无权限"),
    TENANT_MISMATCH(HttpStatus.FORBIDDEN, "跨租户访问被拒绝"),
    TENANT_MISSING(HttpStatus.FORBIDDEN, "缺少租户上下文"),
    NOT_FOUND(HttpStatus.NOT_FOUND, "资源不存在"),
    KB_NOT_FOUND(HttpStatus.NOT_FOUND, "知识库不存在"),
    DOC_NOT_FOUND(HttpStatus.NOT_FOUND, "文档不存在"),
    DOC_STATE_INVALID(HttpStatus.CONFLICT, "文档状态不允许该操作"),
    INDEX_ALREADY_RUNNING(HttpStatus.CONFLICT, "已有索引任务在执行"),
    BAD_REQUEST(HttpStatus.BAD_REQUEST, "请求参数不合法"),
    UNSUPPORTED_FILE(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "不支持的文件类型"),
    FILE_TOO_LARGE(HttpStatus.PAYLOAD_TOO_LARGE, "文件超出大小限制"),
    QUOTA_EXCEEDED(HttpStatus.TOO_MANY_REQUESTS, "配额或限流已超限"),
    RETRIEVAL_TIMEOUT(HttpStatus.GATEWAY_TIMEOUT, "检索超时"),
    MODEL_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "模型网关不可用"),
    ENGINE_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "RAG Engine 不可用"),
    STORAGE_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "对象存储未配置或不可用"),
    UPSTREAM_ERROR(HttpStatus.BAD_GATEWAY, "上游服务错误"),
    INTERNAL_ERROR(HttpStatus.INTERNAL_SERVER_ERROR, "系统内部错误");

    private final HttpStatus status;
    private final String defaultMessage;

    ErrorCode(HttpStatus status, String defaultMessage) {
        this.status = status;
        this.defaultMessage = defaultMessage;
    }

    public HttpStatus status() {
        return status;
    }

    public String defaultMessage() {
        return defaultMessage;
    }
}