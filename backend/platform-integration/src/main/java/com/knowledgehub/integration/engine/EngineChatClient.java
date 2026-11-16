package com.knowledgehub.integration.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.integration.config.KhIntegrationProperties;
import com.knowledgehub.integration.http.JsonHttpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Streams chat SSE events from the RAG engine to the caller. */
@Component
public class EngineChatClient {

    private static final Logger log = LoggerFactory.getLogger(EngineChatClient.class);

    private final KhIntegrationProperties props;
    private final JsonHttpClient http;
    private final ObjectMapper objectMapper;

    public EngineChatClient(KhIntegrationProperties props, JsonHttpClient http, ObjectMapper objectMapper) {
        this.props = props;
        this.http = http;
        this.objectMapper = objectMapper;
    }

    public interface Listener {
        void onEvent(String event, JsonNode data);

        void onComplete();

        void onError(Throwable error);
    }

    public Cancellable stream(Map<String, Object> payload, Listener listener) {
        AtomicBoolean cancelled = new AtomicBoolean(false);
        java.util.concurrent.atomic.AtomicReference<java.io.InputStream> bodyRef =
                new java.util.concurrent.atomic.AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                String body = objectMapper.writeValueAsString(payload);
                HttpRequest request = HttpRequest.newBuilder(URI.create(props.getEngineBaseUrl() + "/v1/chat/stream"))
                        .timeout(Duration.ofMinutes(10))
                        .header("Content-Type", "application/json")
                        .header("Accept", "text/event-stream")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build();
                HttpResponse<java.io.InputStream> response = http.raw().send(request,
                        HttpResponse.BodyHandlers.ofInputStream());
                bodyRef.set(response.body());
                if (response.statusCode() >= 400) {
                    listener.onError(new BizException(ErrorCode.ENGINE_UNAVAILABLE,
                            "对话服务返回 " + response.statusCode()));
                    return;
                }
                String currentEvent = "message";
                StringBuilder data = new StringBuilder();
                // 用 BufferedReader 读行，取消时直接关闭底层流——HTTP 连接一断，
                // 引擎侧的 StreamingResponse 会被取消，模型也就停止生成。
                try (var reader = new java.io.BufferedReader(
                        new java.io.InputStreamReader(response.body(), java.nio.charset.StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null && !cancelled.get()) {
                        if (line.startsWith("event:")) {
                            currentEvent = line.substring(6).trim();
                        } else if (line.startsWith("data:")) {
                            data.append(line.substring(5).trim());
                        } else if (line.isEmpty() && data.length() > 0) {
                            emit(listener, currentEvent, data.toString());
                            data.setLength(0);
                            currentEvent = "message";
                        }
                    }
                }
                if (data.length() > 0 && !cancelled.get()) {
                    emit(listener, currentEvent, data.toString());
                }
                if (!cancelled.get()) {
                    listener.onComplete();
                }
            } catch (IOException ex) {
                if (!cancelled.get()) {
                    listener.onError(ex);
                }
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
        }, "engine-chat");
        worker.setDaemon(true);
        worker.start();
        return () -> {
            cancelled.set(true);
            java.io.InputStream body = bodyRef.getAndSet(null);
            if (body != null) {
                try {
                    body.close();
                } catch (IOException ignored) {
                    // 关闭失败不影响后续状态落库
                }
            }
            worker.interrupt();
        };
    }

    private void emit(Listener listener, String event, String data) {
        try {
            JsonNode node = data.isBlank() ? objectMapper.createObjectNode() : objectMapper.readTree(data);
            listener.onEvent(event, node);
        } catch (IOException ex) {
            log.debug("Skip malformed SSE payload: {}", data);
        }
    }

    public interface Cancellable {
        void cancel();
    }
}