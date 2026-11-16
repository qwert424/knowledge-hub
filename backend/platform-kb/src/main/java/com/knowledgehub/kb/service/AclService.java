package com.knowledgehub.kb.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.kb.entity.Document;
import com.knowledgehub.kb.entity.KbMember;
import com.knowledgehub.kb.entity.KnowledgeBase;
import com.knowledgehub.kb.mapper.KbMemberMapper;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Single place that decides which principals may read a document. The resulting list is written
 * into Milvus acl_principals and is never derived from model output.
 */
@Service
public class AclService {

    private final KbMemberMapper memberMapper;

    public AclService(KbMemberMapper memberMapper) {
        this.memberMapper = memberMapper;
    }

    public AclResult resolve(Document document, KnowledgeBase kb) {
        Set<String> principals = new LinkedHashSet<>();
        principals.add("role:ADMIN");
        if (document.getOwnerId() != null) {
            principals.add("user:" + document.getOwnerId());
        }
        List<KbMember> members = memberMapper.selectList(Wrappers.<KbMember>lambdaQuery()
                .eq(KbMember::getTenantId, document.getTenantId())
                .eq(KbMember::getKbId, document.getKbId()));
        for (KbMember member : members) {
            principals.add(member.getPrincipalType() + ":" + member.getPrincipalId());
        }
        boolean tenantWide = "public".equals(document.getVisibility())
                || "public".equals(kb.getVisibility())
                || "tenant".equals(kb.getVisibility())
                || "inherit".equals(document.getVisibility());
        if (tenantWide) {
            principals.add("tenant:all");
        }
        if ("restricted".equals(document.getAclMode())) {
            principals.remove("tenant:all");
            tenantWide = false;
        }
        return new AclResult(new ArrayList<>(principals), tenantWide ? "public" : "internal");
    }

    public record AclResult(List<String> principals, String visibility) {
    }
}