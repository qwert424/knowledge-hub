package com.knowledgehub.chat.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.chat.entity.Conversation;
import com.knowledgehub.chat.entity.Message;
import com.knowledgehub.chat.entity.MessageCitation;
import com.knowledgehub.chat.mapper.MessageCitationMapper;
import com.knowledgehub.chat.mapper.MessageFeedbackMapper;
import com.knowledgehub.chat.entity.MessageFeedback;
import com.knowledgehub.chat.mapper.MessageMapper;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.integration.engine.EngineChatClient;
import com.knowledgehub.integration.platform.GatewayModelCatalog;
import com.knowledgehub.iam.service.RetrievalTicketService;
import com.knowledgehub.kb.entity.KnowledgeBase;
import com.knowledgehub.kb.service.KbService;
import com.knowledgehub.kb.service.KbService.KbView;
import com.knowledgehub.retrieval.entity.RetrievalProfile;
import com.knowledgehub.retrieval.service.RetrievalProfileService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@Service
public class ChatService {

    private static final Logger log = LoggerFactory.getLogger(ChatService.class);
    private static final int HISTORY_LIMIT = 10;

    /**
     * SSE 心跳：检索阶段引擎可能几十秒不吐 token，只有周期性写才会让容器发现"客户端已断开"，
     * 否则用户点停止后这条回答会永远停在 streaming。
     */
    private static final ScheduledExecutorService HEARTBEAT = Executors.newScheduledThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "sse-heartbeat");
        thread.setDaemon(true);
        return thread;
    });
    private static final long HEARTBEAT_SECONDS = 1L;

    private final ConversationService conversationService;
    private final MessageMapper messageMapper;
    private final MessageCitationMapper citationMapper;
    private final MessageFeedbackMapper feedbackMapper;
    private final KbService kbService;
    private final RetrievalProfileService profileService;
    private final RetrievalTicketService ticketService;
    private final EngineChatClient engineChat;
    private final ObjectMapper objectMapper;
    private final QuotaService quotaService;
    private final GatewayModelCatalog modelCatalog;

    /** 正在流式输出中的回答 → 实时状态（已产出文本 / 已下发引用 / 断开引擎的句柄）。 */
    private final java.util.Map<UUID, StreamState> activeStreams = new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * 一条正在流式输出的回答的实时状态。
     *
     * <p>点"停止"时 SSE 线程可能已经收不到尾部事件，所以停止接口要能自己拿到
     * "用户已经看到的文本 + 已经下发的引用"再落库，否则重新进入会话会看到半截丢内容、
     * 引用也一起消失。
     */
    private static final class StreamState {
        final StringBuilder answer = new StringBuilder();
        final List<MessageCitation> citations = java.util.Collections.synchronizedList(new ArrayList<>());
        /** 阶段名 -> 中文步骤；用 LinkedHashSet 去重且保序（同一个阶段只留一条） */
        final java.util.Set<String> steps = java.util.Collections.synchronizedSet(new java.util.LinkedHashSet<>());
        /** 只有引擎真的发过 done 才算正常完成。 */
        final AtomicBoolean sawDone = new AtomicBoolean(false);
        final AtomicBoolean finished = new AtomicBoolean(false);
        volatile Runnable cancel = () -> { };

        String text() {
            synchronized (answer) {
                return answer.toString();
            }
        }
    }

    /**
     * 引擎 status 事件里的阶段名 -> 用户看到的中文步骤。
     * 跟用户端流式展示用同一套措辞，刷新前后不会变成两句话。
     */
    private static String stepLabel(String stage, JsonNode data) {
        if (stage == null || stage.isBlank()) {
            return null;
        }
        return switch (stage) {
            case "route" -> "判断是否需要检索";
            case "prefetch" -> "预取知识库材料";
            case "retrieve" -> "检索知识库";
            case "generate" -> "生成回答";
            case "direct" -> "直接作答";
            case "agent" -> "交给主 Agent 处理";
            case "resume" -> "接着写完上次的回答";
            case "security" -> "安全检查";
            default -> data != null && data.hasNonNull("message") ? data.get("message").asText() : null;
        };
    }

    @org.springframework.beans.factory.annotation.Value("${kh.chat.monthly-token-quota:0}")
    private long defaultTokenQuota;

    @org.springframework.beans.factory.annotation.Value("${kh.chat.monthly-message-quota:0}")
    private long defaultMessageQuota;

    public ChatService(ConversationService conversationService, MessageMapper messageMapper,
                       MessageCitationMapper citationMapper, MessageFeedbackMapper feedbackMapper, KbService kbService,
                       RetrievalProfileService profileService, RetrievalTicketService ticketService,
                       EngineChatClient engineChat, ObjectMapper objectMapper, QuotaService quotaService,
                       GatewayModelCatalog modelCatalog) {
        this.conversationService = conversationService;
        this.messageMapper = messageMapper;
        this.citationMapper = citationMapper;
        this.feedbackMapper = feedbackMapper;
        this.kbService = kbService;
        this.profileService = profileService;
        this.ticketService = ticketService;
        this.engineChat = engineChat;
        this.objectMapper = objectMapper;
        this.quotaService = quotaService;
        this.modelCatalog = modelCatalog;
    }

    public SseEmitter sendMessage(UUID conversationId, String content) {
        return sendMessage(conversationId, content, null);
    }

    /**
     * @param parentMessageId 时间旅行锚点：给出时先删除该消息之后的所有消息，再从该点继续。
     */
    public SseEmitter sendMessage(UUID conversationId, String content, UUID parentMessageId) {
        Conversation conversation = conversationService.require(conversationId);
        if (parentMessageId != null) {
            conversationService.truncateAfter(conversation, parentMessageId);
        }
        return stream(conversation, content, null);
    }

    /** 重答：删除该回答及其之后的消息，用同一个提问重新生成。 */
    public SseEmitter retry(UUID conversationId, UUID assistantMessageId) {
        Conversation conversation = conversationService.require(conversationId);
        Message assistant = requireMessage(conversation, assistantMessageId);
        Message question = conversationService.previousUserMessage(conversation, assistant);
        if (question == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "找不到这条回答对应的提问");
        }
        conversationService.truncateAfter(conversation, question.getId());
        return stream(conversation, question.getContent(), question);
    }

    /** 编辑提问并重答：改写原提问，丢弃其后的消息。 */
    public SseEmitter editAndResend(UUID conversationId, UUID userMessageId, String content) {
        return editAndResend(conversationId, userMessageId, content, null, null);
    }

    /**
     * 编辑提问并重答，可同时切换"这一条当时用的模型与知识库范围"。
     *
     * 用户要的就是"回到当时那次请求的条件再改一遍"：把这次选的写回会话后再生效，
     * 后续追问也沿用同一套条件，不会出现"改了模型但下一条又变回去"。
     */
    public SseEmitter editAndResend(UUID conversationId, UUID userMessageId, String content,
                                    String model, List<String> kbIds) {
        Conversation conversation = conversationService.require(conversationId);
        Message question = requireMessage(conversation, userMessageId);
        if (!"user".equals(question.getRole())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "只能编辑自己的提问");
        }
        // 复刻"当时那次请求"的条件：模型与检索范围一起写回会话，后续追问也沿用
        if (model != null || kbIds != null) {
            conversationService.update(conversationId, null, model, kbIds);
            conversation = conversationService.require(conversationId);
        }
        conversationService.truncateAfter(conversation, question.getId());
        question.setContent(content);
        messageMapper.updateById(question);
        return stream(conversation, content, question);
    }

    private Message requireMessage(Conversation conversation, UUID messageId) {
        Message message = messageMapper.selectById(messageId);
        if (message == null || !conversation.getId().equals(message.getConversationId())
                || !conversation.getTenantId().equals(message.getTenantId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "消息不存在");
        }
        return message;
    }

    /**
     * 断点续传：被中断（或失败）的回答保留原文，交给模型接着写，而不是整段重来。
     * 这条消息沿用原来的 id 与提问，不会产生重复消息。
     */
    public SseEmitter resume(UUID conversationId, UUID assistantMessageId) {
        Conversation conversation = conversationService.require(conversationId);
        Message assistant = requireMessage(conversation, assistantMessageId);
        if (!"assistant".equals(assistant.getRole())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "只有回答可以续写");
        }
        if ("completed".equals(assistant.getStatus())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "这条回答已经完成，不需要续写");
        }
        if (assistant.getContent() == null || assistant.getContent().isBlank()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "这条回答还没有内容，请直接重新生成");
        }
        Message question = conversationService.previousUserMessage(conversation, assistant);
        if (question == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "找不到这条回答对应的提问");
        }
        return stream(conversation, question.getContent(), question, assistant);
    }

    /**
     * 主动停止：前端点「停止」后调这里，确保即使容器没及时感知断连，
     * 这条回答也不会永远停在 streaming。
     *
     * <p>只改状态、不动正文：流式回答的正文由 SSE 线程在收尾时写入，
     * 这里如果带上（可能是旧的）正文回写，会把已经写好的半截内容覆盖成空。
     */
    public void stopMessage(UUID conversationId, UUID messageId) {
        stopMessage(conversationId, messageId, null);
    }

    /**
     * @param partial 浏览器已经显示出来的半截内容。SSE 线程可能来不及收尾，
     *                带上它就能保证库里的内容与用户看到的一致（只在更长时采用）。
     */
    public void stopMessage(UUID conversationId, UUID messageId, String partial) {
        Conversation conversation = conversationService.require(conversationId);
        Message message = requireMessage(conversation, messageId);
        if (!"assistant".equals(message.getRole())) {
            return;
        }
        // 再用流式状态把"已经给用户看过的内容和引用"补齐，然后掐断上游。
        StreamState state = activeStreams.get(messageId);
        String text = partial == null ? "" : partial;
        if (state != null) {
            String produced = state.text();
            if (produced.length() > text.length()) {
                text = produced;
            }
            persistCitations(state.citations);
        }
        // 掐断上游引擎，模型就不会继续在后台生成（否则切换会话回来还在变长）。
        if (state != null) {
            try {
                state.cancel.run();
            } catch (RuntimeException ignored) {
                // 断开失败也不影响下面的状态落库
            }
        }
        var update = Wrappers.<Message>lambdaUpdate()
                .eq(Message::getId, messageId)
                .eq(Message::getTenantId, conversation.getTenantId())
                .eq(Message::getStatus, "streaming");
        if (text.length() > (message.getContent() == null ? 0 : message.getContent().length())) {
            update = update.set(Message::getContent, text);
        }
        int updated = messageMapper.update(null, update.set(Message::getStatus, "stopped"));
        if (updated > 0) {
            conversationService.touch(conversation);
            log.info("chat {} stopped by user ({} chars)", messageId, text.length());
        }
    }

    private SseEmitter stream(Conversation conversation, String content, Message existingQuestion) {
        return stream(conversation, content, existingQuestion, null);
    }

    /**
     * @param resumeOf 非空表示续写这条已存在的回答（沿用它的 id 与已产出内容）
     */
    private SseEmitter stream(Conversation conversation, String content, Message existingQuestion,
                              Message resumeOf) {
        CurrentUser user = UserContext.require();
        String tenantId = TenantContext.require();
        if (resumeOf == null) {
            assertQuota(user);
        }
        // 会话绑定了解析到的知识库；为空表示"由 Agent 自己决定要不要查"。
        List<String> kbIds = new ArrayList<>(conversationService.kbIdList(conversation));
        java.util.Map<String, String> collections = new java.util.LinkedHashMap<>();
        // 会话里可能留着早就没权限/已下架的库：直接报错会让整条提问失败，
        // 更合理的做法是把它移出本次检索范围并告诉用户，而不是把人挡在门外。
        List<String> droppedKbs = new ArrayList<>();
        for (java.util.Iterator<String> it = kbIds.iterator(); it.hasNext(); ) {
            String kbId = it.next();
            KnowledgeBase kb = kbService.require(kbId);
            if (!kbService.canRead(kb, user)) {
                it.remove();
                droppedKbs.add(kb.getName() + "（无访问权限）");
                continue;
            }
            // 下架的知识库不参与检索：选了也当没选，避免"还能查到已下架内容"。
            if (!"active".equals(kb.getStatus())) {
                it.remove();
                droppedKbs.add(kb.getName() + "（已下架）");
                continue;
            }
            collections.put(kbId, kb.getCollectionName());
        }
        if (!droppedKbs.isEmpty()) {
            // 落库：下次进来不再反复提示，也避免前端继续带着失效的库
            conversationService.update(conversation.getId(), null, null, kbIds);
        }
        // 票据始终签发：即使没选知识库也需要身份与 ACL 主体。
        // 没选库时把"可读库清单"同时用于三件事：
        //   1) available_kbs 告诉决策器各库是什么内容；
        //   2) 票据里带上这些库，决策器判定"该查"时才有授权范围；
        //   3) collections 里带上各自的集合名，否则会退回默认集合名而查不到东西。
        List<UUID> ticketKbIds = kbIds.stream().map(UUID::fromString).toList();
        List<Map<String, String>> availableKbs = new ArrayList<>();
        if (kbIds.isEmpty()) {
            List<UUID> readable = new ArrayList<>();
            for (KbView kb : kbService.list(null, 1, 100, user).items()) {
                KnowledgeBase entity = kbService.require(kb.id());
                if (!kbService.canRead(entity, user)) {
                    continue;
                }
                // 只看启用中的库；停用的库不出现在可检索清单里
                if (!"active".equals(entity.getStatus())) {
                    continue;
                }
                readable.add(UUID.fromString(kb.id()));
                collections.put(kb.id(), entity.getCollectionName());
                Map<String, String> item = new LinkedHashMap<>();
                item.put("name", kb.name());
                item.put("description", kb.description() == null ? "" : kb.description());
                availableKbs.add(item);
            }
            ticketKbIds = readable;
        }
        String ticket = ticketService.issue(user, ticketKbIds);
        RetrievalProfile profile = conversation.getProfileId() == null
                ? profileService.defaultProfile()
                : profileService.require(conversation.getProfileId());
        JsonNode profileConfig = profileService.readConfig(profile);

        List<Map<String, String>> history = history(conversation);
        Message userMessage = existingQuestion != null
                ? existingQuestion
                : conversationService.appendMessage(conversation, "user", content, "completed");
        Message assistant;
        final StreamState state = new StreamState();
        if (resumeOf != null) {
            assistant = resumeOf;
            state.answer.append(assistant.getContent() == null ? "" : assistant.getContent());
            assistant.setStatus("streaming");
            messageMapper.updateById(assistant);
        } else {
            assistant = conversationService.appendMessage(conversation, "assistant", "", "streaming",
                    userMessage.getId());
        }

        Map<String, Object> payload = new HashMap<>();
        payload.put("tenant_id", tenantId);
        payload.put("conversation_id", conversation.getId().toString());
        payload.put("user_message_id", userMessage.getId().toString());
        payload.put("assistant_message_id", assistant.getId().toString());
        payload.put("query", content);
        payload.put("kb_ids", kbIds);
        payload.put("kb_collections", collections);
        payload.put("ticket", ticket);
        payload.put("profile", profileConfig);
        if (resumeOf != null) {
            payload.put("resume", true);
            payload.put("resume_prefix", resumeOf.getContent());
        }
        // 会话级模型必须是网关真实别名；网关撤掉某个模型时自动回落到默认，而不是报错卡死。
        String effectiveModel = conversation.getModel();
        if (effectiveModel != null && !effectiveModel.isBlank()) {
            if (!modelCatalog.catalogEmpty() && !modelCatalog.isKnownChatModel(effectiveModel)) {
                log.warn("conversation {} uses unknown model {}; falling back to default",
                        conversation.getId(), effectiveModel);
                effectiveModel = null;
            }
        }
        if (effectiveModel != null && !effectiveModel.isBlank()) {
            payload.put("model", effectiveModel);
        }
        payload.put("history", history);
        payload.put("trace_id", assistant.getId().toString());
        if (!availableKbs.isEmpty()) {
            payload.put("available_kbs", availableKbs);
        }

        SseEmitter emitter = new SseEmitter(0L);
        java.util.concurrent.atomic.AtomicReference<ScheduledFuture<?>> heartbeat =
                new java.util.concurrent.atomic.AtomicReference<>();

        if (!droppedKbs.isEmpty()) {
            // 先告诉前端"这几个库被移出范围了"，让它顺手刷新库列表，而不是静默降级
            String message = "已自动移除不可用的知识库：" + String.join("、", droppedKbs);
            try {
                String payloadJson = objectMapper.writeValueAsString(
                        Map.of("level", "warning", "message", message));
                emitter.send(SseEmitter.event().name("notice").data(payloadJson));
            } catch (Exception ex) {
                log.debug("SSE notice failed: {}", ex.getMessage());
            }
        }

        EngineChatClient.Cancellable handle = engineChat.stream(payload, new EngineChatClient.Listener() {
            @Override
            public void onEvent(String event, JsonNode data) {
                try {
                    if ("token".equals(event) && data.hasNonNull("delta")) {
                        String delta = data.get("delta").asText();
                        synchronized (state.answer) {
                            state.answer.append(delta);
                        }
                    } else if ("citation".equals(event)) {
                        state.citations.add(toCitation(assistant, data, state.citations.size()));
                    } else if ("status".equals(event)) {
                        String label = stepLabel(data.path("stage").asText(""), data);
                        if (label != null && !label.isBlank()) {
                            state.steps.add(label);
                        }
                    } else if ("done".equals(event)) {
                        state.sawDone.set(true);
                        if (data.hasNonNull("usage")) {
                            applyUsage(assistant, data.get("usage"));
                        }
                    }
                    emitter.send(SseEmitter.event().name(event).data(data.toString()));
                } catch (Exception ex) {
                    log.debug("SSE send failed: {}", ex.getMessage());
                }
            }

            @Override
            public void onComplete() {
                ScheduledFuture<?> beat = heartbeat.getAndSet(null);
                if (beat != null) {
                    beat.cancel(false);
                }
                if (!state.finished.compareAndSet(false, true)) {
                    return;
                }
                activeStreams.remove(assistant.getId());
                boolean normal = state.sawDone.get();
                String text = state.text();
                persistPartial(assistant, text, normal ? "completed" : "stopped");
                persistSteps(assistant, state.steps);
                persistCitations(state.citations);
                conversationService.touch(conversation);
                if (normal) {
                    quotaService.recordUsage(tenantId, user.userId().toString(),
                            assistant.getInputTokens() == null ? 0 : assistant.getInputTokens()
                                    + (assistant.getOutputTokens() == null ? 0 : assistant.getOutputTokens()), true);
                } else {
                    log.info("chat {} stream closed without done; saved as stopped ({} chars)",
                            assistant.getId(), text.length());
                }
                try {
                    emitter.send(SseEmitter.event().name("done").data("{\"messageId\":\""
                            + assistant.getId() + "\",\"citationCount\":" + state.citations.size()
                            + ",\"stopped\":" + (!normal) + "}"));
                } catch (Exception ignored) {
                    // client already gone
                }
                emitter.complete();
            }

            @Override
            public void onError(Throwable error) {
                ScheduledFuture<?> beat = heartbeat.getAndSet(null);
                if (beat != null) {
                    beat.cancel(false);
                }
                if (!state.finished.compareAndSet(false, true)) {
                    return;
                }
                activeStreams.remove(assistant.getId());
                persistPartial(assistant, state.text(), "failed");
                persistSteps(assistant, state.steps);
                persistCitations(state.citations);
                try {
                    emitter.send(SseEmitter.event().name("error").data("{\"code\":\"ENGINE_UNAVAILABLE\",\"message\":\""
                            + escape(error.getMessage()) + "\"}"));
                } catch (Exception ignored) {
                    // client already gone
                }
                emitter.complete();
            }
        });

        state.cancel = handle::cancel;
        activeStreams.put(assistant.getId(), state);
        // 客户端中断（关页面 / 点停止）时：先断开引擎，再把这条回答落成 stopped。
        // 否则消息会永远停在 streaming，重新进入会话还能看到"正在检索"。
        Runnable stop = () -> {
            activeStreams.remove(assistant.getId());
            try {
                state.cancel.run();
            } catch (RuntimeException ignored) {
                // 已断开
            }
            ScheduledFuture<?> beat = heartbeat.getAndSet(null);
            if (beat != null) {
                beat.cancel(false);
            }
            if (!state.finished.compareAndSet(false, true)) {
                return;
            }
            persistPartial(assistant, state.text(), "stopped");
            persistSteps(assistant, state.steps);
            persistCitations(state.citations);
            conversationService.touch(conversation);
            try {
                emitter.complete();
            } catch (Exception ignored) {
                // already completed
            }
        };
        emitter.onTimeout(stop);
        emitter.onError(e -> stop.run());
        emitter.onCompletion(stop);
        try {
            emitter.send(SseEmitter.event().name("start").data("{\"messageId\":\""
                    + assistant.getId() + "\"}"));
        } catch (Exception ex) {
            stop.run();
            emitter.completeWithError(ex);
        }
        // 检索阶段没有 token 可写，容器就发现不了客户端已经断开；心跳负责把断连变成一次写失败。
        ScheduledFuture<?> beat = HEARTBEAT.scheduleAtFixedRate(() -> {
            if (state.finished.get()) {
                return;
            }
            try {
                emitter.send(SseEmitter.event().comment("ping"));
            } catch (Exception ex) {
                log.debug("sse heartbeat failed, client gone: {}", ex.getMessage());
                stop.run();
            }
        }, HEARTBEAT_SECONDS, HEARTBEAT_SECONDS, TimeUnit.SECONDS);
        heartbeat.set(beat);
        if (state.finished.get()) {
            beat.cancel(false);
        }
        return emitter;
    }

    private void persistPartial(Message assistant, String content, String status) {
        assistant.setContent(content);
        assistant.setStatus(status);
        assistant.setLatencyMs((int) java.time.Duration.between(assistant.getCreatedAt(),
                OffsetDateTime.now()).toMillis());
        messageMapper.updateById(assistant);
    }

    /** 把思考链步骤写入消息（刷新页面后前端还能折叠展示） */
    private void persistSteps(Message assistant, java.util.Set<String> steps) {
        if (steps == null || steps.isEmpty()) {
            return;
        }
        List<String> snapshot;
        synchronized (steps) {
            snapshot = new ArrayList<>(steps);
        }
        try {
            assistant.setReasoningSteps(objectMapper.writeValueAsString(snapshot));
            messageMapper.updateById(assistant);
        } catch (Exception ex) {
            log.debug("persist reasoning steps for message {} failed: {}", assistant.getId(), ex.getMessage());
        }
    }

    /**
     * 落库引用。停止接口和 SSE 收尾都会调用，所以先按 message 清旧再写，
     * 保证"点停止后重新进入会话，引用还在，也不会重复"。
     */
    private void persistCitations(List<MessageCitation> citations) {
        if (citations == null || citations.isEmpty()) {
            return;
        }
        List<MessageCitation> snapshot;
        synchronized (citations) {
            snapshot = new ArrayList<>(citations);
        }
        MessageCitation first = snapshot.get(0);
        try {
            citationMapper.delete(Wrappers.<MessageCitation>lambdaQuery()
                    .eq(MessageCitation::getTenantId, first.getTenantId())
                    .eq(MessageCitation::getMessageId, first.getMessageId()));
            for (MessageCitation citation : snapshot) {
                citationMapper.insert(citation);
            }
        } catch (RuntimeException ex) {
            // 引用落库失败不该影响回答本身，记一条日志就好
            log.warn("persist {} citations for message {} failed: {}",
                    snapshot.size(), first.getMessageId(), ex.getMessage());
        }
    }

    /**
     * 当月用量与配额。
     *
     * 额度是可配置的数据（quota 表，见 {@link QuotaService}），用量按"这个人当月"从消息表实算，
     * 前端据此显示真实剩余额度，而不是写死的假进度条。
     */
    public Map<String, Object> usage() {
        CurrentUser user = UserContext.require();
        String tenantId = TenantContext.require();
        OffsetDateTime monthStart = OffsetDateTime.now().withDayOfMonth(1).toLocalDate().atStartOfDay()
                .atOffset(OffsetDateTime.now().getOffset());
        List<UUID> conversationIds = conversationService.idsOf(user.userId());
        long tokens = 0;
        long answered = 0;
        long questions = 0;
        if (!conversationIds.isEmpty()) {
            for (Message message : messageMapper.selectList(Wrappers.<Message>lambdaQuery()
                    .eq(Message::getTenantId, tenantId)
                    .in(Message::getConversationId, conversationIds)
                    .ge(Message::getCreatedAt, monthStart))) {
                if ("user".equals(message.getRole())) {
                    questions++;
                } else if ("assistant".equals(message.getRole())
                        && ("completed".equals(message.getStatus()) || "stopped".equals(message.getStatus()))) {
                    answered++;
                    tokens += (message.getInputTokens() == null ? 0 : message.getInputTokens())
                            + (message.getOutputTokens() == null ? 0 : message.getOutputTokens());
                }
            }
        }

        QuotaService.Limits limits = quotaService.limits(tenantId, user.userId().toString(),
                new java.util.ArrayList<>(user.roles()), new java.util.ArrayList<>(user.groups()));
        // 未配置额度时才回落到系统默认值；管理员显式配 0 表示不限。
        boolean configured = !"none".equals(limits.source());
        long limitTokens = configured ? limits.limitTokens() : defaultTokenQuota;
        long limitMessages = configured ? limits.limitRequests() : defaultMessageQuota;

        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("period", QuotaService.currentPeriod());
        body.put("messagesUsed", answered);
        body.put("messageQuota", limitMessages);
        body.put("tokensUsed", tokens);
        body.put("tokenQuota", limitTokens);
        body.put("tokensRemaining", limitTokens <= 0 ? 0 : Math.max(0, limitTokens - tokens));
        body.put("questionsThisMonth", questions);
        body.put("unlimited", limitTokens <= 0 && limitMessages <= 0);
        body.put("quotaSource", limits.source());
        return body;
    }

    /** 发送前校验配额：超限直接拒绝，并且是可读的业务错误，不是 500。 */
    private void assertQuota(CurrentUser user) {
        Map<String, Object> usage = usage();
        long limitTokens = ((Number) usage.get("tokenQuota")).longValue();
        long limitMessages = ((Number) usage.get("messageQuota")).longValue();
        if (limitTokens <= 0 && limitMessages <= 0) {
            return;
        }
        long tokens = ((Number) usage.get("tokensUsed")).longValue();
        long messages = ((Number) usage.get("messagesUsed")).longValue();
        if (limitTokens > 0 && tokens >= limitTokens) {
            throw new BizException(ErrorCode.QUOTA_EXCEEDED, "本月 token 额度已用完，请联系管理员调整");
        }
        if (limitMessages > 0 && messages >= limitMessages) {
            throw new BizException(ErrorCode.QUOTA_EXCEEDED, "本月提问次数已用完，请联系管理员调整");
        }
    }

    public void feedback(UUID messageId, String rating, String comment) {
        CurrentUser user = UserContext.require();
        Message message = messageMapper.selectById(messageId);
        if (message == null || !TenantContext.require().equals(message.getTenantId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "消息不存在");
        }
        MessageFeedback feedback = new MessageFeedback();
        feedback.setId(Ids.uuid7());
        feedback.setTenantId(TenantContext.require());
        feedback.setMessageId(messageId);
        feedback.setUserId(user.userId());
        feedback.setRating(rating);
        feedback.setComment(comment);
        feedback.setCreatedAt(OffsetDateTime.now());
        feedbackMapper.insert(feedback);
        conversationService.touch(conversationService.require(message.getConversationId()));
    }


    private List<Map<String, String>> history(Conversation conversation) {
        List<Message> messages = messageMapper.selectList(Wrappers.<Message>lambdaQuery()
                .eq(Message::getTenantId, conversation.getTenantId())
                .eq(Message::getConversationId, conversation.getId())
                .eq(Message::getStatus, "completed")
                .orderByDesc(Message::getCreatedAt)
                .last("limit " + HISTORY_LIMIT));
        List<Map<String, String>> history = new ArrayList<>();
        for (int i = messages.size() - 1; i >= 0; i--) {
            Message message = messages.get(i);
            history.add(Map.of("role", message.getRole(), "content", message.getContent() == null ? "" : message.getContent()));
        }
        return history;
    }

    private MessageCitation toCitation(Message assistant, JsonNode data, int index) {
        MessageCitation citation = new MessageCitation();
        citation.setId(Ids.uuid7());
        citation.setTenantId(assistant.getTenantId());
        citation.setMessageId(assistant.getId());
        citation.setChunkId(data.path("chunk_id").asText(null));
        citation.setDocId(data.path("doc_id").asText(null));
        citation.setTitle(data.path("title").asText(null));
        citation.setUrl(data.path("url").asText(null));
        citation.setSnippet(data.path("snippet").asText(null));
        citation.setScore(data.path("score").asDouble(0));
        citation.setIdx(index);
        return citation;
    }

    private void applyUsage(Message assistant, JsonNode usage) {
        assistant.setModel(usage.path("model").asText(null));
        assistant.setInputTokens(usage.path("input_tokens").asInt(0));
        assistant.setOutputTokens(usage.path("output_tokens").asInt(0));
    }

    private String escape(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }
}