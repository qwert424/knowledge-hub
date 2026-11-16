package com.knowledgehub.integration.http;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

@Component
public class JsonHttpClient {

    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .version(HttpClient.Version.HTTP_1_1)
            .build();
    private final ObjectMapper objectMapper;

    public JsonHttpClient(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public JsonNode post(String url, Map<String, String> headers, Object body, Duration timeout) throws IOException {
        try {
            String payload = body instanceof String text ? text : objectMapper.writeValueAsString(body);
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                    .timeout(timeout)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(payload));
            headers.forEach(builder::header);
            HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            return parse(response.statusCode(), response.body(), url);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted calling " + url, ex);
        }
    }

    public JsonNode get(String url, Map<String, String> headers, Duration timeout) throws IOException {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url)).timeout(timeout).GET();
            headers.forEach(builder::header);
            HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            return parse(response.statusCode(), response.body(), url);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted calling " + url, ex);
        }
    }

    /**
     * 表单编码的 POST。Nacos 3.x 的 AI 管理接口用 Form 绑定，
     * 发 JSON 会被当成"参数缺失"，所以单独开一个方法。
     */
    public JsonNode postForm(String url, Map<String, String> headers, Map<String, String> form, Duration timeout)
            throws IOException {
        try {
            StringBuilder body = new StringBuilder();
            form.forEach((key, value) -> {
                if (body.length() > 0) {
                    body.append('&');
                }
                body.append(enc(key)).append('=').append(enc(value));
            });
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                    .timeout(timeout)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString()));
            headers.forEach(builder::header);
            HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            return parse(response.statusCode(), response.body(), url);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted calling " + url, ex);
        }
    }

    private static String enc(String value) {
        return java.net.URLEncoder.encode(value == null ? "" : value, java.nio.charset.StandardCharsets.UTF_8);
    }

    /** 表单编码的 PUT：Nacos 的标签切换接口用 PUT + Form。 */
    public JsonNode putForm(String url, Map<String, String> headers, Map<String, String> form, Duration timeout)
            throws IOException {
        try {
            StringBuilder body = new StringBuilder();
            form.forEach((key, value) -> {
                if (body.length() > 0) {
                    body.append('&');
                }
                body.append(enc(key)).append('=').append(enc(value));
            });
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                    .timeout(timeout)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .PUT(HttpRequest.BodyPublishers.ofString(body.toString()));
            headers.forEach(builder::header);
            HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            return parse(response.statusCode(), response.body(), url);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted calling " + url, ex);
        }
    }

    public int status(String url, Duration timeout) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url)).timeout(timeout).GET().build();
            return client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
        } catch (IOException | InterruptedException ex) {
            if (ex instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return -1;
        }
    }

    public HttpClient raw() {
        return client;
    }

    public ObjectMapper mapper() {
        return objectMapper;
    }

    private JsonNode parse(int status, String body, String url) throws IOException {
        if (status >= 400) {
            throw new IOException("HTTP " + status + " from " + url + ": " + trim(body));
        }
        if (body == null || body.isBlank()) {
            return objectMapper.createObjectNode();
        }
        return objectMapper.readTree(body);
    }

    private String trim(String body) {
        if (body == null) {
            return "";
        }
        return body.length() > 500 ? body.substring(0, 500) : body;
    }
}