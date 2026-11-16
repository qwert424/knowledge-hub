package com.knowledgehub.chat.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.chat.entity.Conversation;
import com.knowledgehub.chat.entity.Message;
import com.knowledgehub.chat.mapper.ConversationMapper;
import com.knowledgehub.chat.mapper.MessageCitationMapper;
import com.knowledgehub.chat.mapper.MessageMapper;
import com.knowledgehub.chat.entity.MessageCitation;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.integration.platform.GatewayModelCatalog;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Service
public class ConversationService {

    private final ConversationMapper conversationMapper;
    private final MessageMapper messageMapper;
    private final MessageCitationMapper citationMapper;
    private final ObjectMapper objectMapper;
    private final GatewayModelCatalog modelCatalog;

    public ConversationService(ConversationMapper conversationMapper, MessageMapper messageMapper,
                               MessageCitationMapper citationMapper, ObjectMapper objectMapper,
                               GatewayModelCatalog modelCatalog) {
        this.conversationMapper = conversationMapper;
        this.messageMapper = messageMapper;
        this.citationMapper = citationMapper;
        this.objectMapper = objectMapper;
        this.modelCatalog = modelCatalog;
    }

    /**
     * 模型只允许取网关真实提供的别名。
     *
     * <p>模型名来自浏览器（会话级切换），必须在这里拦住任意字符串：
     * 否则调用方可以指定任意上游别名，绕过我们定价/可用的模型范围。
     * 网关完全不可达时按空清单处理（放行空模型=跟随默认），避免因网关抖动挡住正常提问。
     */
    private String sanitizeModel(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }
        String candidate = model.trim();
        if (candidate.length() > 64) {
            throw new BizException(ErrorCode.BAD_REQUEST, "模型名过长");
        }
        if (modelCatalog.catalogEmpty()) {
            return candidate;
        }
        if (!modelCatalog.isKnownChatModel(candidate)) {
            throw new BizException(ErrorCode.BAD_REQUEST,
                    "模型 " + candidate + " 不在网关模型清单中，请重新选择");
        }
        return candidate;
    }

    @Transactional
    public ConversationView create(List<String> kbIds, String profileId, String title) {
        CurrentUser user = UserContext.require();
        Conversation conversation = new Conversation();
        conversation.setId(Ids.uuid7());
        conversation.setTenantId(TenantContext.require());
        conversation.setUserId(user.userId());
        conversation.setAgentKey("main_agent");
        conversation.setKbIds(toJson(kbIds));
        conversation.setProfileId(profileId == null || profileId.isBlank() ? null : UUID.fromString(profileId));
        conversation.setTitle(title == null || title.isBlank() ? "新会话" : title);
        conversation.setSource("web");
        conversation.setMessageCount(0);
        conversation.setCreatedAt(OffsetDateTime.now());
        conversation.setUpdatedAt(OffsetDateTime.now());
        conversationMapper.insert(conversation);
        return toView(conversation);
    }

    public List<ConversationView> list() {
        CurrentUser user = UserContext.require();
        return conversationMapper.selectList(Wrappers.<Conversation>lambdaQuery()
                        .eq(Conversation::getTenantId, TenantContext.require())
                        .eq(Conversation::getUserId, user.userId())
                        .orderByDesc(Conversation::getUpdatedAt)
                        .last("limit 100"))
                .stream().map(this::toView).toList();
    }

    public List<MessageView> messages(UUID conversationId) {
        Conversation conversation = require(conversationId);
        return messageMapper.selectList(Wrappers.<Message>lambdaQuery()
                        .eq(Message::getTenantId, conversation.getTenantId())
                        .eq(Message::getConversationId, conversationId)
                        .orderByAsc(Message::getCreatedAt))
                .stream().map(this::toView).toList();
    }

    /** 删除会话及其全部消息、引用。 */
    @Transactional
    public void delete(UUID conversationId) {
        Conversation conversation = require(conversationId);
        List<Message> messages = messageMapper.selectList(Wrappers.<Message>lambdaQuery()
                .eq(Message::getTenantId, conversation.getTenantId())
                .eq(Message::getConversationId, conversationId));
        for (Message message : messages) {
            citationMapper.delete(Wrappers.<MessageCitation>lambdaQuery()
                    .eq(MessageCitation::getTenantId, message.getTenantId())
                    .eq(MessageCitation::getMessageId, message.getId()));
        }
        messageMapper.delete(Wrappers.<Message>lambdaQuery()
                .eq(Message::getTenantId, conversation.getTenantId())
                .eq(Message::getConversationId, conversationId));
        conversationMapper.deleteById(conversationId);
    }

    /**
     * 时间旅行：删除某条消息之后的所有消息与引用。
     *
     * 返回被删除的条数，调用方据此决定是否重算 message_count。
     */
    @Transactional
    public int truncateAfter(Conversation conversation, UUID messageId) {
        Message anchor = messageMapper.selectById(messageId);
        if (anchor == null || !conversation.getId().equals(anchor.getConversationId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "消息不存在");
        }
        List<Message> later = messageMapper.selectList(Wrappers.<Message>lambdaQuery()
                .eq(Message::getTenantId, conversation.getTenantId())
                .eq(Message::getConversationId, conversation.getId())
                .gt(Message::getCreatedAt, anchor.getCreatedAt()));
        for (Message message : later) {
            citationMapper.delete(Wrappers.<MessageCitation>lambdaQuery()
                    .eq(MessageCitation::getTenantId, message.getTenantId())
                    .eq(MessageCitation::getMessageId, message.getId()));
            messageMapper.deleteById(message.getId());
        }
        recount(conversation);
        return later.size();
    }

    /** 找到某条助手回答对应的用户提问（同会话、更早、role=user 的最近一条）。 */
    public Message previousUserMessage(Conversation conversation, Message assistant) {
        return messageMapper.selectOne(Wrappers.<Message>lambdaQuery()
                .eq(Message::getTenantId, conversation.getTenantId())
                .eq(Message::getConversationId, conversation.getId())
                .eq(Message::getRole, "user")
                .lt(Message::getCreatedAt, assistant.getCreatedAt())
                .orderByDesc(Message::getCreatedAt)
                .last("limit 1"));
    }

    private void recount(Conversation conversation) {
        Long count = messageMapper.selectCount(Wrappers.<Message>lambdaQuery()
                .eq(Message::getTenantId, conversation.getTenantId())
                .eq(Message::getConversationId, conversation.getId()));
        conversation.setMessageCount(count == null ? 0 : count.intValue());
        conversation.setUpdatedAt(OffsetDateTime.now());
        conversationMapper.updateById(conversation);
    }

    /** 重命名 / 切模型 / 改知识库绑定（kbIds 传空数组表示清空，即"纯聊天"）。 */
    @Transactional
    public ConversationView update(UUID conversationId, String title, String model, List<String> kbIds) {
        Conversation conversation = require(conversationId);
        if (title != null && !title.isBlank()) {
            conversation.setTitle(title.length() > 200 ? title.substring(0, 200) : title);
        }
        boolean clearModel = false;
        if (model != null) {
            conversation.setModel(sanitizeModel(model));
            clearModel = conversation.getModel() == null;
        }
        if (kbIds != null) {
            conversation.setKbIds(toJson(kbIds));
        }
        conversation.setUpdatedAt(OffsetDateTime.now());
        conversationMapper.updateById(conversation);
        if (clearModel) {
            // updateById 默认忽略 null，所以"切回跟随默认"必须显式置空，否则前端再读还是旧模型。
            conversationMapper.update(null, Wrappers.<Conversation>lambdaUpdate()
                    .eq(Conversation::getId, conversationId)
                    .set(Conversation::getModel, null));
        }
        return toView(conversation);
    }

    /** 当前用户名下的会话 id（用量统计按人算）。 */
    public List<UUID> idsOf(UUID userId) {
        return conversationMapper.selectList(Wrappers.<Conversation>lambdaQuery()
                        .eq(Conversation::getTenantId, TenantContext.require())
                        .eq(Conversation::getUserId, userId))
                .stream().map(Conversation::getId).toList();
    }

    public Conversation require(UUID conversationId) {
        CurrentUser user = UserContext.require();
        Conversation conversation = conversationMapper.selectOne(Wrappers.<Conversation>lambdaQuery()
                .eq(Conversation::getTenantId, TenantContext.require())
                .eq(Conversation::getId, conversationId));
        if (conversation == null || (!user.isAdmin() && !conversation.getUserId().equals(user.userId()))) {
            throw new BizException(ErrorCode.NOT_FOUND, "会话不存在");
        }
        return conversation;
    }

    @Transactional
    public Message appendMessage(Conversation conversation, String role, String content, String status) {
        return appendMessage(conversation, role, content, status, null);
    }

    @Transactional
    public Message appendMessage(Conversation conversation, String role, String content, String status,
                                 UUID parentMessageId) {
        Message message = new Message();
        message.setId(Ids.uuid7());
        message.setTenantId(conversation.getTenantId());
        message.setConversationId(conversation.getId());
        message.setRole(role);
        message.setContent(content);
        message.setContentFormat("markdown");
        message.setStatus(status);
        message.setParentMessageId(parentMessageId);
        message.setCreatedAt(OffsetDateTime.now());
        messageMapper.insert(message);
        if ("user".equals(role) && (conversation.getTitle() == null
                || conversation.getTitle().isBlank()
                || "新对话".equals(conversation.getTitle())
                || "新会话".equals(conversation.getTitle()))) {
            String auto = content == null ? "" : content.strip().replaceAll("\\s+", " ");
            if (auto.length() > 20) {
                auto = auto.substring(0, 20);
            }
            if (!auto.isBlank()) {
                conversation.setTitle(auto);
            }
        }
        conversation.setMessageCount((conversation.getMessageCount() == null ? 0 : conversation.getMessageCount()) + 1);
        conversation.setLastMessageAt(OffsetDateTime.now());
        conversation.setUpdatedAt(OffsetDateTime.now());
        conversationMapper.updateById(conversation);
        return message;
    }

    @Transactional
    public void touch(Conversation conversation) {
        conversation.setUpdatedAt(OffsetDateTime.now());
        conversationMapper.updateById(conversation);
    }

    public List<String> kbIdList(Conversation conversation) {
        try {
            var node = objectMapper.readTree(conversation.getKbIds());
            List<String> ids = new java.util.ArrayList<>();
            node.forEach(item -> ids.add(item.asText()));
            return ids;
        } catch (Exception ex) {
            return List.of();
        }
    }

    private String toJson(List<String> kbIds) {
        try {
            return objectMapper.writeValueAsString(kbIds == null ? List.of() : kbIds);
        } catch (Exception ex) {
            return "[]";
        }
    }

    public ConversationView toView(Conversation conversation) {
        return new ConversationView(conversation.getId().toString(), conversation.getTitle(),
                conversation.getKbIds(), conversation.getProfileId() == null ? null
                        : conversation.getProfileId().toString(),
                conversation.getMessageCount(), conversation.getModel(),
                conversation.getUpdatedAt() == null ? null : conversation.getUpdatedAt().toString());
    }

    public MessageView toView(Message message) {
        java.util.List<CitationView> citations = citationMapper.selectList(
                        Wrappers.<MessageCitation>lambdaQuery()
                                .eq(MessageCitation::getTenantId, message.getTenantId())
                                .eq(MessageCitation::getMessageId, message.getId())
                                .orderByAsc(MessageCitation::getIdx))
                .stream()
                .map(c -> new CitationView(c.getChunkId(), c.getDocId(), c.getTitle(), c.getUrl(),
                        c.getSnippet(), c.getScore()))
                .toList();
        return new MessageView(message.getId().toString(), message.getRole(), message.getContent(),
                message.getStatus(), message.getModel(), message.getCreatedAt() == null ? null
                        : message.getCreatedAt().toString(), citations,
                message.getParentMessageId() == null ? null : message.getParentMessageId().toString(),
                message.getInputTokens(), message.getOutputTokens(), message.getLatencyMs(),
                parseSteps(message.getReasoningSteps()));
    }

    public record ConversationView(String id, String title, String kbIds, String profileId, Integer messageCount,
                                   String model, String updatedAt) {
    }

    public record CitationView(String chunkId, String docId, String title, String url, String snippet,
                               Double score) {
    }

    /** \u601d\u8003\u94fe\u6b65\u9aa4\u5b58\u5728 jsonb \u91cc\uff0c\u8bfb\u51fa\u6765\u7ed9\u524d\u7aef\u6298\u53e0\u5c55\u793a */
    private java.util.List<String> parseSteps(String raw) {
        if (raw == null || raw.isBlank()) {
            return java.util.List.of();
        }
        try {
            return objectMapper.readValue(raw, new com.fasterxml.jackson.core.type.TypeReference<java.util.List<String>>() {
            });
        } catch (Exception ex) {
            return java.util.List.of();
        }
    }

    public record MessageView(String id, String role, String content, String status, String model,
                              String createdAt, java.util.List<CitationView> citations,
                              String parentMessageId, Integer inputTokens, Integer outputTokens,
                              Integer latencyMs, java.util.List<String> steps) {
    }}