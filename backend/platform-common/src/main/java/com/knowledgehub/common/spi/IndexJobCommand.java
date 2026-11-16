package com.knowledgehub.common.spi;

import java.util.List;
import java.util.UUID;

public record IndexJobCommand(
        String tenantId,
        UUID documentId,
        UUID versionId,
        String kbId,
        String jobType,
        String objectKey,
        String contentHash,
        UUID profileId,
        String traceId,
        String title,
        String collectionName,
        int embeddingDim,
        List<String> aclPrincipals,
        String visibility,
        boolean graphEnabled,
        List<String> tags,
        /** 飞书来源的结构坐标：space_id / node_token / revision_id，检索侧回查同文档同版本的块 */
        String spaceId,
        String nodeToken,
        String revisionId) {

    /** Convenience ctor for callers without Feishu coordinates. */
    public IndexJobCommand(
            String tenantId,
            UUID documentId,
            UUID versionId,
            String kbId,
            String jobType,
            String objectKey,
            String contentHash,
            UUID profileId,
            String traceId,
            String title,
            String collectionName,
            int embeddingDim,
            List<String> aclPrincipals,
            String visibility,
            boolean graphEnabled,
            List<String> tags) {
        this(tenantId, documentId, versionId, kbId, jobType, objectKey, contentHash, profileId, traceId,
                title, collectionName, embeddingDim, aclPrincipals, visibility, graphEnabled, tags, "", "", "");
    }

    /** Convenience ctor for callers that do not opt into graph extraction. */
    public IndexJobCommand(
            String tenantId,
            UUID documentId,
            UUID versionId,
            String kbId,
            String jobType,
            String objectKey,
            String contentHash,
            UUID profileId,
            String traceId,
            String title,
            String collectionName,
            int embeddingDim,
            List<String> aclPrincipals,
            String visibility) {
        this(tenantId, documentId, versionId, kbId, jobType, objectKey, contentHash, profileId, traceId,
                title, collectionName, embeddingDim, aclPrincipals, visibility, false, List.of(), "", "", "");
    }

    /** Convenience ctor for callers without document tags yet. */
    public IndexJobCommand(
            String tenantId,
            UUID documentId,
            UUID versionId,
            String kbId,
            String jobType,
            String objectKey,
            String contentHash,
            UUID profileId,
            String traceId,
            String title,
            String collectionName,
            int embeddingDim,
            List<String> aclPrincipals,
            String visibility,
            boolean graphEnabled) {
        this(tenantId, documentId, versionId, kbId, jobType, objectKey, contentHash, profileId, traceId,
                title, collectionName, embeddingDim, aclPrincipals, visibility, graphEnabled, List.of(), "", "", "");
    }
}