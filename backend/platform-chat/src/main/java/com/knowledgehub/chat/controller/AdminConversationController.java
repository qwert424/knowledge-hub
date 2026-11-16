package com.knowledgehub.chat.controller;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.chat.entity.Conversation;
import com.knowledgehub.chat.entity.Message;
import com.knowledgehub.chat.entity.MessageCitation;
import com.knowledgehub.chat.mapper.ConversationMapper;
import com.knowledgehub.chat.mapper.MessageCitationMapper;
import com.knowledgehub.chat.mapper.MessageMapper;
import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.iam.entity.AppUser;
import com.knowledgehub.iam.mapper.AppUserMapper;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 管理端会话审计。
 *
 * <p>用户端只能看到自己的会话；管理员需要能按人看全租户的提问与回答（含引用），
 * 才能判断"回答得好不好"，并把典型问题沉淀成评测用例。
 */
@RestController
@RequestMapping("/api/v1/admin/conversations")
@RequirePermission(PermissionCatalog.OPS_AUDIT_READ)
public class AdminConversationController {

    private final ConversationMapper conversationMapper;
    private final MessageMapper messageMapper;
    private final MessageCitationMapper citationMapper;
    private final AppUserMapper userMapper;

    public AdminConversationController(ConversationMapper conversationMapper, MessageMapper messageMapper,
                                       MessageCitationMapper citationMapper, AppUserMapper userMapper) {
        this.conversationMapper = conversationMapper;
        this.messageMapper = messageMapper;
        this.citationMapper = citationMapper;
        this.userMapper = userMapper;
    }

    @GetMapping
    public ApiResponse<PageResult<Map<String, Object>>> list(
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String userId,
            @RequestParam(defaultValue = "1") long page,
            @RequestParam(defaultValue = "20") long pageSize) {
        String tenantId = TenantContext.require();
        var query = Wrappers.<Conversation>lambdaQuery()
                .eq(Conversation::getTenantId, tenantId)
                .like(keyword != null && !keyword.isBlank(), Conversation::getTitle, keyword);
        if (userId != null && !userId.isBlank()) {
            query.eq(Conversation::getUserId, UUID.fromString(userId));
        }
        query.orderByDesc(Conversation::getLastMessageAt, Conversation::getCreatedAt);
        var result = conversationMapper.selectPage(new com.baomidou.mybatisplus.extension.plugins.pagination.Page<>(
                page, pageSize), query);
        Map<UUID, String> owners = new HashMap<>();
        userMapper.selectList(Wrappers.<AppUser>lambdaQuery().eq(AppUser::getTenantId, tenantId))
                .forEach(user -> owners.put(user.getId(), user.getDisplayName() == null
                        ? user.getUsername() : user.getDisplayName()));
        List<Map<String, Object>> items = new ArrayList<>();
        for (Conversation conversation : result.getRecords()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", conversation.getId());
            row.put("title", conversation.getTitle());
            row.put("userId", conversation.getUserId());
            row.put("owner", owners.getOrDefault(conversation.getUserId(), "-"));
            row.put("kbIds", conversation.getKbIds());
            row.put("model", conversation.getModel());
            row.put("messageCount", conversation.getMessageCount());
            row.put("lastMessageAt", conversation.getLastMessageAt());
            row.put("createdAt", conversation.getCreatedAt());
            items.add(row);
        }
        return ApiResponse.ok(PageResult.of(items, result.getTotal(), page, pageSize));
    }

    @GetMapping("/{id}/messages")
    public ApiResponse<List<Map<String, Object>>> messages(@PathVariable UUID id) {
        String tenantId = TenantContext.require();
        Conversation conversation = conversationMapper.selectOne(Wrappers.<Conversation>lambdaQuery()
                .eq(Conversation::getTenantId, tenantId)
                .eq(Conversation::getId, id));
        if (conversation == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "会话不存在");
        }
        List<Message> messages = messageMapper.selectList(Wrappers.<Message>lambdaQuery()
                .eq(Message::getTenantId, tenantId)
                .eq(Message::getConversationId, id)
                .orderByAsc(Message::getCreatedAt));
        List<Map<String, Object>> items = new ArrayList<>();
        for (Message message : messages) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", message.getId());
            row.put("role", message.getRole());
            row.put("content", message.getContent());
            row.put("status", message.getStatus());
            row.put("model", message.getModel());
            row.put("inputTokens", message.getInputTokens());
            row.put("outputTokens", message.getOutputTokens());
            row.put("createdAt", message.getCreatedAt());
            List<MessageCitation> citations = citationMapper.selectList(Wrappers.<MessageCitation>lambdaQuery()
                    .eq(MessageCitation::getTenantId, tenantId)
                    .eq(MessageCitation::getMessageId, message.getId())
                    .orderByAsc(MessageCitation::getIdx));
            row.put("citations", citations.stream().map(citation -> {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("chunkId", citation.getChunkId());
                item.put("docId", citation.getDocId());
                item.put("title", citation.getTitle());
                item.put("snippet", citation.getSnippet());
                item.put("score", citation.getScore());
                return item;
            }).toList());
            items.add(row);
        }
        return ApiResponse.ok(items);
    }
}
