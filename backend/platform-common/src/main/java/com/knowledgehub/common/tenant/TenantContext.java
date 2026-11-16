package com.knowledgehub.common.tenant;

import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;

public final class TenantContext {

    public static final String DEFAULT_TENANT = "default";

    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();

    private TenantContext() {
    }

    public static void set(String tenantId) {
        TENANT.set(tenantId);
    }

    public static String get() {
        return TENANT.get();
    }

    public static String require() {
        String tenantId = TENANT.get();
        if (tenantId == null || tenantId.isBlank()) {
            throw new BizException(ErrorCode.TENANT_MISSING);
        }
        return tenantId;
    }

    public static void clear() {
        TENANT.remove();
    }
}