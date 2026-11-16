package com.knowledgehub.kb.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.spi.AuditRecorder;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.kb.entity.Document;
import com.knowledgehub.kb.entity.KbMember;
import com.knowledgehub.kb.entity.KnowledgeBase;
import com.knowledgehub.kb.mapper.DocumentMapper;
import com.knowledgehub.kb.mapper.KbMemberMapper;
import com.knowledgehub.kb.mapper.KnowledgeBaseMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Service
public class KbService {

    private final KnowledgeBaseMapper kbMapper;
    private final KbMemberMapper memberMapper;
    private final DocumentMapper documentMapper;
    private final AuditRecorder auditRecorder;

    public KbService(KnowledgeBaseMapper kbMapper, KbMemberMapper memberMapper,
                     DocumentMapper documentMapper, AuditRecorder auditRecorder) {
        this.kbMapper = kbMapper;
        this.memberMapper = memberMapper;
        this.documentMapper = documentMapper;
        this.auditRecorder = auditRecorder;
    }

    public PageResult<KbView> list(String keyword, long page, long pageSize, CurrentUser user) {
        String tenantId = TenantContext.require();
        LambdaQueryWrapper<KnowledgeBase> query = Wrappers.<KnowledgeBase>lambdaQuery()
                .eq(KnowledgeBase::getTenantId, tenantId)
                .isNull(KnowledgeBase::getDeletedAt)
                .orderByDesc(KnowledgeBase::getCreatedAt);
        if (keyword != null && !keyword.isBlank()) {
            query.and(w -> w.like(KnowledgeBase::getName, keyword).or().like(KnowledgeBase::getCode, keyword));
        }
        Page<KnowledgeBase> result = kbMapper.selectPage(new Page<>(page, pageSize), query);
        List<KbView> views = result.getRecords().stream()
                .map(kb -> toView(kb, user))
                .toList();
        return PageResult.of(views, result.getTotal(), page, pageSize);
    }

    public KnowledgeBase require(String kbId) {
        String tenantId = TenantContext.require();
        KnowledgeBase kb = kbMapper.selectOne(Wrappers.<KnowledgeBase>lambdaQuery()
                .eq(KnowledgeBase::getTenantId, tenantId)
                .eq(KnowledgeBase::getId, UUID.fromString(kbId))
                .isNull(KnowledgeBase::getDeletedAt));
        if (kb == null) {
            throw new BizException(ErrorCode.KB_NOT_FOUND);
        }
        return kb;
    }

    @Transactional
    public KbView create(String name, String code, String description, String visibility,
                         String embeddingModel, Integer embeddingDim, CurrentUser user) {
        String tenantId = TenantContext.require();
        String resolvedCode = (code == null || code.isBlank()) ? autoCode(tenantId) : code.trim();
        Long exists = kbMapper.selectCount(Wrappers.<KnowledgeBase>lambdaQuery()
                .eq(KnowledgeBase::getTenantId, tenantId)
                .eq(KnowledgeBase::getCode, resolvedCode)
                .isNull(KnowledgeBase::getDeletedAt));
        if (exists != null && exists > 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "知识库编码已存在");
        }
        int dim = embeddingDim == null || embeddingDim <= 0 ? 1024 : embeddingDim;
        KnowledgeBase kb = new KnowledgeBase();
        kb.setId(Ids.uuid7());
        kb.setTenantId(tenantId);
        kb.setName(name);
        kb.setCode(resolvedCode);
        kb.setDescription(description);
        kb.setVisibility(visibility == null ? "tenant" : visibility);
        kb.setEmbeddingModel(embeddingModel == null ? "text-embedding-v4" : embeddingModel);
        kb.setEmbeddingDim(dim);
        kb.setCollectionName("kh_" + resolvedCode.replaceAll("[^a-zA-Z0-9_]", "_") + "_" + dim);
        kb.setChunkTemplate("general");
        kb.setGraphEnabled(false);
        kb.setStatus("active");
        kb.setCreatedBy(user.userId());
        kb.setCreatedAt(OffsetDateTime.now());
        kb.setUpdatedAt(OffsetDateTime.now());
        kbMapper.insert(kb);
        auditRecorder.record("kb.create", "kb", kb.getId().toString(), null, resolvedCode);
        return toView(kb, user);
    }

    /** 编码只是集合命名与接口引用的键：没填就用短随机串，租户内唯一即可。 */
    private String autoCode(String tenantId) {
        for (int attempt = 0; attempt < 5; attempt++) {
            String candidate = "kb" + Long.toHexString(System.nanoTime()).substring(6)
                    + Integer.toHexString((int) (Math.random() * 0xffff));
            Long taken = kbMapper.selectCount(Wrappers.<KnowledgeBase>lambdaQuery()
                    .eq(KnowledgeBase::getTenantId, tenantId)
                    .eq(KnowledgeBase::getCode, candidate)
                    .isNull(KnowledgeBase::getDeletedAt));
            if (taken == null || taken == 0) {
                return candidate;
            }
        }
        throw new BizException(ErrorCode.BAD_REQUEST, "生成知识库编码失败，请手动填写");
    }

    @Transactional
    public KbView update(UUID kbId, String name, String description, String visibility, Boolean graphEnabled,
                         CurrentUser user) {
        KnowledgeBase kb = require(kbId.toString());
        String before = kb.getName() + "|" + kb.getVisibility() + "|" + kb.getGraphEnabled();
        if (name != null && !name.isBlank()) {
            kb.setName(name);
        }
        if (description != null) {
            kb.setDescription(description);
        }
        if (visibility != null && !visibility.isBlank()) {
            kb.setVisibility(visibility);
        }
        if (graphEnabled != null) {
            kb.setGraphEnabled(graphEnabled);
        }
        kb.setUpdatedAt(OffsetDateTime.now());
        kbMapper.updateById(kb);
        auditRecorder.record("kb.update", "kb", kbId.toString(), before,
                kb.getName() + "|" + kb.getVisibility() + "|" + kb.getGraphEnabled());
        return toView(kb, user);
    }

    /**
     * 上架/下架：下架后用户端不能再检索这个库（选了会被拒），管理端仍可维护。
     * 这是"可用性"开关，跟谁能看见（授权/ACL）是两件事。
     */
    @Transactional
    public KbView updateStatus(UUID kbId, String status, CurrentUser user) {
        if (status == null || !java.util.Set.of("active", "disabled").contains(status)) {
            throw new BizException(ErrorCode.BAD_REQUEST, "状态只支持 active（启用）/ disabled（停用）");
        }
        KnowledgeBase kb = require(kbId.toString());
        String before = kb.getStatus();
        kb.setStatus(status);
        kb.setUpdatedAt(OffsetDateTime.now());
        kbMapper.updateById(kb);
        auditRecorder.record("kb." + ("active".equals(status) ? "enable" : "disable"), "kb",
                kbId.toString(), before, status);
        return toView(kb, user);
    }

    public void addMember(UUID kbId, String principalType, String principalId, String permission) {
        KnowledgeBase kb = require(kbId.toString());
        Long exists = memberMapper.selectCount(Wrappers.<KbMember>lambdaQuery()
                .eq(KbMember::getKbId, kb.getId())
                .eq(KbMember::getPrincipalType, principalType)
                .eq(KbMember::getPrincipalId, principalId));
        if (exists != null && exists > 0) {
            return;
        }
        KbMember member = new KbMember();
        member.setId(Ids.uuid7());
        member.setTenantId(kb.getTenantId());
        member.setKbId(kb.getId());
        member.setPrincipalType(principalType);
        member.setPrincipalId(principalId);
        member.setPermission(permission == null ? "read" : permission);
        member.setCreatedAt(OffsetDateTime.now());
        memberMapper.insert(member);
        auditRecorder.record("kb.member.add", "kb", kbId.toString(), null, principalType + ":" + principalId);
    }

    /** 取消某条授权：只删这条成员记录，不影响其它成员。 */
    @Transactional
    public void removeMember(UUID kbId, UUID memberId) {
        KnowledgeBase kb = require(kbId.toString());
        KbMember member = memberMapper.selectOne(Wrappers.<KbMember>lambdaQuery()
                .eq(KbMember::getTenantId, kb.getTenantId())
                .eq(KbMember::getKbId, kb.getId())
                .eq(KbMember::getId, memberId));
        if (member == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "???????");
        }
        memberMapper.deleteById(memberId);
        auditRecorder.record("kb.member.remove", "kb", kbId.toString(), null,
                member.getPrincipalType() + ":" + member.getPrincipalId());
    }

    public boolean canRead(KnowledgeBase kb, CurrentUser user) {
        if (user == null) {
            return false;
        }
        if (user.isAdmin() || "tenant".equals(kb.getVisibility()) || "public".equals(kb.getVisibility())) {
            return true;
        }
        if (user.userId().equals(kb.getCreatedBy())) {
            return true;
        }
        List<KbMember> members = memberMapper.selectList(Wrappers.<KbMember>lambdaQuery()
                .eq(KbMember::getTenantId, kb.getTenantId())
                .eq(KbMember::getKbId, kb.getId()));
        return members.stream().anyMatch(m -> switch (m.getPrincipalType()) {
            case "user" -> m.getPrincipalId().equals(user.userId().toString());
            case "role" -> user.roles().contains(m.getPrincipalId());
            case "group" -> user.groups().contains(m.getPrincipalId());
            case "dept" -> user.depts().contains(m.getPrincipalId());
            default -> false;
        });
    }

    public java.util.List<KbMember> members(UUID kbId) {
        KnowledgeBase kb = require(kbId.toString());
        return memberMapper.selectList(Wrappers.<KbMember>lambdaQuery()
                .eq(KbMember::getTenantId, kb.getTenantId())
                .eq(KbMember::getKbId, kb.getId())
                .orderByAsc(KbMember::getCreatedAt));
    }

    @org.springframework.transaction.annotation.Transactional
    public void updateAcl(String type, UUID id, String visibility, String aclMode,
                          java.util.List<KbAclInput> members) {
        if ("kb".equals(type)) {
            KnowledgeBase kb = require(id.toString());
            if (visibility != null && !visibility.isBlank()) {
                kb.setVisibility(visibility);
                kb.setUpdatedAt(OffsetDateTime.now());
                kbMapper.updateById(kb);
            }
            memberMapper.delete(Wrappers.<KbMember>lambdaQuery()
                    .eq(KbMember::getTenantId, kb.getTenantId())
                    .eq(KbMember::getKbId, kb.getId()));
            if (members != null) {
                for (KbAclInput input : members) {
                    KbMember member = new KbMember();
                    member.setId(Ids.uuid7());
                    member.setTenantId(kb.getTenantId());
                    member.setKbId(kb.getId());
                    member.setPrincipalType(input.principalType());
                    member.setPrincipalId(input.principalId());
                    member.setPermission(input.permission() == null ? "read" : input.permission());
                    member.setCreatedAt(OffsetDateTime.now());
                    memberMapper.insert(member);
                }
            }
            auditRecorder.record("kb.acl.update", "kb", id.toString(), null, visibility);
            return;
        }
        if ("document".equals(type)) {
            Document document = documentMapper.selectOne(Wrappers.<Document>lambdaQuery()
                    .eq(Document::getTenantId, TenantContext.require())
                    .eq(Document::getId, id)
                    .isNull(Document::getDeletedAt));
            if (document == null) {
                throw new BizException(ErrorCode.DOC_NOT_FOUND);
            }
            if (visibility != null && !visibility.isBlank()) {
                document.setVisibility(visibility);
            }
            if (aclMode != null && !aclMode.isBlank()) {
                document.setAclMode(aclMode);
            }
            document.setUpdatedAt(OffsetDateTime.now());
            documentMapper.updateById(document);
            auditRecorder.record("document.acl.update", "document", id.toString(), null,
                    visibility + "|" + aclMode);
            return;
        }
        throw new BizException(ErrorCode.BAD_REQUEST, "不支持的资源类型: " + type);
    }

    public KbStats stats(UUID kbId) {
        KnowledgeBase kb = require(kbId.toString());
        Long documents = documentMapper.selectCount(Wrappers.<Document>lambdaQuery()
                .eq(Document::getTenantId, kb.getTenantId())
                .eq(Document::getKbId, kb.getId())
                .isNull(Document::getDeletedAt));
        Long active = documentMapper.selectCount(Wrappers.<Document>lambdaQuery()
                .eq(Document::getTenantId, kb.getTenantId())
                .eq(Document::getKbId, kb.getId())
                .eq(Document::getStatus, "active")
                .isNull(Document::getDeletedAt));
        Long failed = documentMapper.selectCount(Wrappers.<Document>lambdaQuery()
                .eq(Document::getTenantId, kb.getTenantId())
                .eq(Document::getKbId, kb.getId())
                .eq(Document::getStatus, "failed")
                .isNull(Document::getDeletedAt));
        return new KbStats(kb.getId().toString(), documents == null ? 0 : documents,
                active == null ? 0 : active, failed == null ? 0 : failed,
                kb.getEmbeddingDim(), kb.getCollectionName());
    }

    @org.springframework.transaction.annotation.Transactional
    public void softDelete(UUID kbId) {
        KnowledgeBase kb = require(kbId.toString());
        Long docs = documentMapper.selectCount(Wrappers.<Document>lambdaQuery()
                .eq(Document::getTenantId, kb.getTenantId())
                .eq(Document::getKbId, kb.getId())
                .isNull(Document::getDeletedAt));
        if (docs != null && docs > 0) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.BAD_REQUEST,
                    "这个知识库里还有 " + docs + " 个文档：先把它们转移到其它知识库或删除，再删知识库");
        }
        if ("active".equals(kb.getStatus())) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.BAD_REQUEST, "先下架再删除");
        }
        kb.setDeletedAt(OffsetDateTime.now());
        kb.setStatus("offline");
        kb.setUpdatedAt(OffsetDateTime.now());
        kbMapper.updateById(kb);
        auditRecorder.record("kb.delete", "kb", kbId.toString(), kb.getCode(), null);
    }

    /**
     * 用户端可选的库：只返回"启用 + 当前用户确实能读"的，连名字都不外泄。
     * 之前用户端直接调列表接口再自己过滤状态，结果别人的私有库也会出现在选择器里。
     */
    public List<KbView> listAvailable(CurrentUser user) {
        String tenantId = TenantContext.require();
        return kbMapper.selectList(Wrappers.<KnowledgeBase>lambdaQuery()
                        .eq(KnowledgeBase::getTenantId, tenantId)
                        .isNull(KnowledgeBase::getDeletedAt)
                        .eq(KnowledgeBase::getStatus, "active")
                        .orderByAsc(KnowledgeBase::getName))
                .stream()
                .filter(kb -> canRead(kb, user))
                .map(kb -> toView(kb, user))
                .toList();
    }

    /** 回收站：只列软删除的库，供管理端恢复 */    public java.util.List<KbView> listDeleted(CurrentUser user) {
        String tenantId = TenantContext.require();
        return kbMapper.selectList(Wrappers.<KnowledgeBase>lambdaQuery()
                        .eq(KnowledgeBase::getTenantId, tenantId)
                        .isNotNull(KnowledgeBase::getDeletedAt)
                        .orderByDesc(KnowledgeBase::getDeletedAt))
                .stream().map(kb -> toView(kb, user)).toList();
    }

    /** 恢复软删除的库：清掉 deleted_at，状态回到已下架，需要重新上架才会被检索到 */
    public KbView restore(UUID kbId) {
        String tenantId = TenantContext.require();
        KnowledgeBase kb = kbMapper.selectOne(Wrappers.<KnowledgeBase>lambdaQuery()
                .eq(KnowledgeBase::getTenantId, tenantId)
                .eq(KnowledgeBase::getId, kbId));
        if (kb == null) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.NOT_FOUND, "知识库不存在");
        }
        if (kb.getDeletedAt() == null) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.BAD_REQUEST, "这个知识库没有被删除，无需恢复");
        }
        // deleted_at 必须显式 set(null)：updateById 会忽略 null 字段，否则"恢复"其实没恢复
        kbMapper.update(null, Wrappers.<KnowledgeBase>lambdaUpdate()
                .eq(KnowledgeBase::getId, kbId)
                .eq(KnowledgeBase::getTenantId, tenantId)
                .set(KnowledgeBase::getDeletedAt, null)
                .set(KnowledgeBase::getStatus, "disabled")
                .set(KnowledgeBase::getUpdatedAt, OffsetDateTime.now()));
        kb.setDeletedAt(null);
        kb.setStatus("disabled");
        auditRecorder.record("kb.restore", "kb", kbId.toString(), null, kb.getCode());
        return toView(kb, UserContext.require());
    }

    /**
     * 彻底删除回收站里的一个库。
     *
     * 只允许删"已经在回收站、且库内没有未删除文档"的库；成员授权一并清掉，
     * 这样"清空回收站"之后不会留下指向不存在知识的授权记录。
     */
    @org.springframework.transaction.annotation.Transactional
    public void purgeDeleted(UUID kbId) {
        String tenantId = TenantContext.require();
        KnowledgeBase kb = kbMapper.selectOne(Wrappers.<KnowledgeBase>lambdaQuery()
                .eq(KnowledgeBase::getTenantId, tenantId)
                .eq(KnowledgeBase::getId, kbId));
        if (kb == null) {
            return;
        }
        if (kb.getDeletedAt() == null) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.BAD_REQUEST, "只能彻底删除回收站里的知识库");
        }
        Long docs = documentMapper.selectCount(Wrappers.<Document>lambdaQuery()
                .eq(Document::getTenantId, tenantId)
                .eq(Document::getKbId, kbId)
                .isNull(Document::getDeletedAt));
        if (docs != null && docs > 0) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.BAD_REQUEST,
                    "库里还有 " + docs + " 个文档，先恢复知识库并处理掉文档再彻底删除");
        }
        memberMapper.delete(Wrappers.<KbMember>lambdaQuery()
                .eq(KbMember::getTenantId, tenantId)
                .eq(KbMember::getKbId, kbId));
        kbMapper.deleteById(kbId);
        auditRecorder.record("kb.purge", "kb", kbId.toString(), kb.getCode(), null);
    }

    /** 清空回收站：逐条走 purgeDeleted，有文档的会被跳过并回传原因 */
    @org.springframework.transaction.annotation.Transactional
    public java.util.Map<String, Object> purgeAllDeleted() {
        String tenantId = TenantContext.require();
        java.util.List<KnowledgeBase> targets = kbMapper.selectList(Wrappers.<KnowledgeBase>lambdaQuery()
                .eq(KnowledgeBase::getTenantId, tenantId)
                .isNotNull(KnowledgeBase::getDeletedAt));
        int purged = 0;
        java.util.List<String> skipped = new java.util.ArrayList<>();
        for (KnowledgeBase kb : targets) {
            try {
                purgeDeleted(kb.getId());
                purged++;
            } catch (RuntimeException ex) {
                skipped.add(kb.getName() + "：" + ex.getMessage());
            }
        }
        java.util.Map<String, Object> result = new java.util.LinkedHashMap<>();
        result.put("purged", purged);
        result.put("skipped", skipped);
        return result;
    }

    public KbView toView(KnowledgeBase kb, CurrentUser user) {
        Long docCount = documentMapper.selectCount(Wrappers.<Document>lambdaQuery()
                .eq(Document::getTenantId, kb.getTenantId())
                .eq(Document::getKbId, kb.getId())
                .isNull(Document::getDeletedAt));
        return new KbView(kb.getId().toString(), kb.getName(), kb.getCode(), kb.getDescription(),
                kb.getVisibility(), kb.getEmbeddingModel(), kb.getEmbeddingDim(), kb.getCollectionName(),
                kb.getChunkTemplate(), Boolean.TRUE.equals(kb.getGraphEnabled()), kb.getStatus(),
                docCount == null ? 0 : docCount, canRead(kb, user),
                kb.getCreatedAt() == null ? null : kb.getCreatedAt().toString());
    }

    public record KbAclInput(String principalType, String principalId, String permission) {
    }

    public record KbStats(String id, long documentCount, long activeCount, long failedCount,
                          Integer embeddingDim, String collectionName) {
    }

    public record KbView(String id, String name, String code, String description, String visibility,
                         String embeddingModel, Integer embeddingDim, String collectionName,
                         String chunkTemplate, boolean graphEnabled, String status, long documentCount,
                         boolean readable, String createdAt) {
    }
}