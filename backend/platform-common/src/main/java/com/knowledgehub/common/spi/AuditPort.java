package com.knowledgehub.common.spi;

public interface AuditPort {

    void record(AuditEvent event);
}