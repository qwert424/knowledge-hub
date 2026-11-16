package com.knowledgehub.common.web;

public final class TraceContext {

    private static final ThreadLocal<String> REQUEST_ID = new ThreadLocal<>();

    private TraceContext() {
    }

    public static void set(String requestId) {
        REQUEST_ID.set(requestId);
    }

    public static String current() {
        return REQUEST_ID.get();
    }

    public static void clear() {
        REQUEST_ID.remove();
    }
}