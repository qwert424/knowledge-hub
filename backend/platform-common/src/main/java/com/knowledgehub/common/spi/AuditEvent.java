package com.knowledgehub.common.spi;

import java.util.UUID;

public record AuditEvent(
        String tenantId,
        UUID actorId,
        String actorName,
        String action,
        String resourceType,
        String resourceId,
        String before,
        String after,
        String ip,
        String userAgent,
        String result,
        String errorCode,
        String requestId) {
}