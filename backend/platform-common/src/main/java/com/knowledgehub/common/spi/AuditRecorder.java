package com.knowledgehub.common.spi;

import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.web.TraceContext;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/** Convenience facade so business modules do not depend on the ops module. */
@Component
public class AuditRecorder {

    private final ObjectProvider<AuditPort> ports;

    public AuditRecorder(ObjectProvider<AuditPort> ports) {
        this.ports = ports;
    }

    public void record(String action, String resourceType, String resourceId, String before, String after) {
        record(action, resourceType, resourceId, before, after, "SUCCESS", null);
    }

    public void record(String action, String resourceType, String resourceId, String before, String after,
                       String result, String errorCode) {
        AuditPort port = ports.getIfAvailable();
        if (port == null) {
            return;
        }
        CurrentUser user = UserContext.get();
        HttpServletRequest request = currentRequest();
        port.record(new AuditEvent(
                TenantContext.get(),
                user == null ? null : user.userId(),
                user == null ? null : user.username(),
                action,
                resourceType,
                resourceId,
                before,
                after,
                request == null ? null : clientIp(request),
                request == null ? null : request.getHeader("User-Agent"),
                result,
                errorCode,
                TraceContext.current()));
    }

    private HttpServletRequest currentRequest() {
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs) {
            return attrs.getRequest();
        }
        return null;
    }

    private String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }
}