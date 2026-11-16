package com.knowledgehub.ops.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.common.spi.AuditEvent;
import com.knowledgehub.common.spi.AuditPort;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.ops.entity.AuditLog;
import com.knowledgehub.ops.mapper.AuditLogMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;

@Service
public class AuditLogService implements AuditPort {

    private static final Logger log = LoggerFactory.getLogger(AuditLogService.class);

    private final AuditLogMapper auditLogMapper;

    public AuditLogService(AuditLogMapper auditLogMapper) {
        this.auditLogMapper = auditLogMapper;
    }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(AuditEvent event) {
        if (event.tenantId() == null || event.tenantId().isBlank()) {
            log.debug("Skip audit event without tenant: {}", event.action());
            return;
        }
        try {
            AuditLog entry = new AuditLog();
            entry.setTenantId(event.tenantId());
            entry.setActorId(event.actorId());
            entry.setActorName(event.actorName());
            entry.setAction(event.action());
            entry.setResourceType(event.resourceType());
            entry.setResourceId(event.resourceId());
            entry.setBefore(event.before());
            entry.setAfter(event.after());
            entry.setIp(event.ip());
            entry.setUserAgent(event.userAgent());
            entry.setResult(event.result() == null ? "SUCCESS" : event.result());
            entry.setErrorCode(event.errorCode());
            entry.setRequestId(event.requestId());
            entry.setCreatedAt(OffsetDateTime.now());
            auditLogMapper.insert(entry);
        } catch (Exception ex) {
            // Audit must never break business flows, but it must be visible in logs.
            log.error("Failed to persist audit event action={}: {}", event.action(), ex.getMessage());
        }
    }

    public PageResult<AuditLog> list(String action, String actorName, long page, long pageSize) {
        String tenantId = TenantContext.require();
        LambdaQueryWrapper<AuditLog> query = Wrappers.<AuditLog>lambdaQuery()
                .eq(AuditLog::getTenantId, tenantId)
                .orderByDesc(AuditLog::getCreatedAt);
        if (action != null && !action.isBlank()) {
            query.like(AuditLog::getAction, action);
        }
        if (actorName != null && !actorName.isBlank()) {
            query.like(AuditLog::getActorName, actorName);
        }
        Page<AuditLog> result = auditLogMapper.selectPage(new Page<>(page, pageSize), query);
        return PageResult.of(result.getRecords(), result.getTotal(), page, pageSize);
    }
}