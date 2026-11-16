package com.knowledgehub.common.api;

import com.knowledgehub.common.web.TraceContext;

public record ApiResponse<T>(String code, String message, T data, String requestId) {

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>("OK", "success", data, TraceContext.current());
    }

    public static ApiResponse<Void> ok() {
        return new ApiResponse<>("OK", "success", null, TraceContext.current());
    }

    public static <T> ApiResponse<T> fail(String code, String message) {
        return new ApiResponse<>(code, message, null, TraceContext.current());
    }
}