package com.knowledgehub.chat.controller;

import com.knowledgehub.chat.service.ChatService;
import com.knowledgehub.chat.service.ConversationService;
import com.knowledgehub.chat.service.PortalSettingsService;
import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1")
@RequirePermission(PermissionCatalog.CHAT_USE)
public class ChatController {

    private final ConversationService conversationService;
    private final ChatService chatService;
    private final PortalSettingsService portalSettings;

    public ChatController(ConversationService conversationService, ChatService chatService,
                          PortalSettingsService portalSettings) {
        this.conversationService = conversationService;
        this.chatService = chatService;
        this.portalSettings = portalSettings;
    }

    /**
     * SSE 端点不能直接抛业务异常：请求的 Accept 是 text/event-stream，
     * 异常处理器回 JSON 时会因为内容协商失败变成 500。这里把可预期错误
     * 变成流内的 error 事件，前端照样能显示成一句人话。
     */
    private SseEmitter stream(java.util.function.Supplier<SseEmitter> action) {
        try {
            return action.get();
        } catch (BizException ex) {
            return errorEmitter(ex.code() == null ? "BAD_REQUEST" : ex.code().name(), ex.getMessage());
        } catch (RuntimeException ex) {
            return errorEmitter("INTERNAL_ERROR", "服务出了点问题，请稍后重试");
        }
    }

    private SseEmitter errorEmitter(String code, String message) {
        SseEmitter emitter = new SseEmitter(0L);
        try {
            emitter.send(SseEmitter.event().name("error")
                    .data("{\"code\":\"" + code + "\",\"message\":\"" + escapeJson(message)
                            + "\",\"retryable\":false}"));
            emitter.send(SseEmitter.event().name("done").data("{\"stopped\":true}"));
        } catch (Exception ignored) {
            // 写不出去就直接结束
        }
        emitter.complete();
        return emitter;
    }

    private static String escapeJson(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }

    @PostMapping("/chat/sessions")
    public ApiResponse<ConversationService.ConversationView> createSession(@RequestBody CreateSessionRequest request) {
        // kbIds 允许为空：空表示"只聊天"，不触发检索。
        return ApiResponse.ok(conversationService.create(
                request.kbIds() == null ? List.of() : request.kbIds(), request.profileId(), request.title()));
    }

    @GetMapping("/chat/sessions")
    public ApiResponse<List<ConversationService.ConversationView>> sessions() {
        return ApiResponse.ok(conversationService.list());
    }

    /** 重命名 / 切模型 / 改知识库绑定。 */
    @PatchMapping("/chat/sessions/{id}")
    public ApiResponse<ConversationService.ConversationView> updateSession(@PathVariable UUID id,
                                                                          @RequestBody UpdateSessionRequest request) {
        return ApiResponse.ok(conversationService.update(id, request.title(), request.model(), request.kbIds()));
    }
    @GetMapping("/chat/sessions/{id}/messages")
    public ApiResponse<List<ConversationService.MessageView>> messages(@PathVariable UUID id) {
        return ApiResponse.ok(conversationService.messages(id));
    }

    /** 删除会话（含消息与引用）。 */
    @org.springframework.web.bind.annotation.DeleteMapping("/chat/sessions/{id}")
    public ApiResponse<Void> deleteSession(@PathVariable UUID id) {
        conversationService.delete(id);
        return ApiResponse.ok(null);
    }

    /**
     * 发送提问。`parentMessageId` 用于时间旅行：先截断到该消息，再从那里继续。
     */
    @PostMapping(value = "/chat/sessions/{id}/messages", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter send(@PathVariable UUID id, @Valid @RequestBody SendRequest request) {
        UUID parent = request.parentMessageId() == null || request.parentMessageId().isBlank()
                ? null : UUID.fromString(request.parentMessageId());
        return stream(() -> chatService.sendMessage(id, request.content(), parent));
    }

    /** 重答：丢弃这条回答及其后的消息，用原提问重新生成。 */
    @PostMapping(value = "/chat/sessions/{id}/messages/{messageId}/retry",
            produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter retry(@PathVariable UUID id, @PathVariable UUID messageId) {
        return stream(() -> chatService.retry(id, messageId));
    }

    /** 编辑提问并重答。 */
    @PostMapping(value = "/chat/sessions/{id}/messages/{messageId}/edit",
            produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter edit(@PathVariable UUID id, @PathVariable UUID messageId,
                           @Valid @RequestBody EditMessageRequest request) {
        return stream(() -> chatService.editAndResend(id, messageId, request.content(),
                request.model(), request.kbIds()));
    }

    /** 断点续传：被中断的回答接着写完，不产生新消息。 */
    @PostMapping(value = "/chat/sessions/{id}/messages/{messageId}/resume",
            produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter resume(@PathVariable UUID id, @PathVariable UUID messageId) {
        return stream(() -> chatService.resume(id, messageId));
    }

    /** 主动停止：前端点「停止」后调用，保证这条回答不会停在 streaming。 */
    @PostMapping("/chat/sessions/{id}/messages/{messageId}/stop")
    public ApiResponse<Void> stop(@PathVariable UUID id, @PathVariable UUID messageId,
                                  @RequestBody(required = false) StopRequest request) {
        chatService.stopMessage(id, messageId, request == null ? null : request.content());
        return ApiResponse.ok(null);
    }

    /** 用户端空状态推荐问题（管理端可配置）。 */
    @GetMapping("/chat/suggestions")
    public ApiResponse<java.util.Map<String, Object>> suggestions() {
        return ApiResponse.ok(java.util.Map.of("items", portalSettings.suggestions()));
    }

    /** 当月用量与配额（区分真额度与展示用数字）。 */
    @GetMapping("/chat/usage")
    public ApiResponse<java.util.Map<String, Object>> usage() {
        return ApiResponse.ok(chatService.usage());
    }

    @PostMapping("/messages/{id}/feedback")
    public ApiResponse<Void> feedback(@PathVariable UUID id, @Valid @RequestBody FeedbackRequest request) {
        chatService.feedback(id, request.rating(), request.comment());
        return ApiResponse.ok();
    }

    public record CreateSessionRequest(List<String> kbIds, String profileId, String title) {
    }

    public record UpdateSessionRequest(String title, String model, List<String> kbIds) {
    }

    public record SendRequest(@NotBlank String content, String parentMessageId) {
    }

    public record EditMessageRequest(@NotBlank String content, String model, List<String> kbIds) {
        /** 兼容只传 content 的旧调用：null 表示"不改这次的条件"。 */
        public EditMessageRequest(String content) {
            this(content, null, null);
        }
    }

    public record FeedbackRequest(@NotBlank String rating, String comment) {
    }

    public record StopRequest(String content) {
    }
}