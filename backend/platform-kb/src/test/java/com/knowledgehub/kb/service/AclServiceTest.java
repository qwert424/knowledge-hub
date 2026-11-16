package com.knowledgehub.kb.service;

import com.knowledgehub.kb.entity.Document;
import com.knowledgehub.kb.entity.KbMember;
import com.knowledgehub.kb.entity.KnowledgeBase;
import com.knowledgehub.kb.mapper.KbMemberMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class AclServiceTest {

    private final KbMemberMapper memberMapper = mock(KbMemberMapper.class);
    private final AclService aclService = new AclService(memberMapper);

    private Document document(String visibility, String aclMode) {
        Document document = new Document();
        document.setId(UUID.randomUUID());
        document.setTenantId("default");
        document.setKbId(UUID.randomUUID());
        document.setOwnerId(UUID.randomUUID());
        document.setVisibility(visibility);
        document.setAclMode(aclMode);
        return document;
    }

    private KnowledgeBase kb(String visibility) {
        KnowledgeBase kb = new KnowledgeBase();
        kb.setId(UUID.randomUUID());
        kb.setTenantId("default");
        kb.setVisibility(visibility);
        return kb;
    }

    private KbMember member(String type, String id) {
        KbMember member = new KbMember();
        member.setTenantId("default");
        member.setPrincipalType(type);
        member.setPrincipalId(id);
        return member;
    }

    @Test
    void tenantWideKnowledgeBaseGrantsTenantPrincipal() {
        when(memberMapper.selectList(any())).thenReturn(List.of(member("role", "STAFF")));

        AclService.AclResult result = aclService.resolve(document("inherit", "inherit"), kb("tenant"));

        assertThat(result.principals()).contains("tenant:all", "role:STAFF", "role:ADMIN");
        assertThat(result.visibility()).isEqualTo("public");
    }

    @Test
    void restrictedDocumentDropsTenantPrincipalButKeepsOwnerAndAdmin() {
        when(memberMapper.selectList(any())).thenReturn(List.of());
        Document document = document("inherit", "restricted");

        AclService.AclResult result = aclService.resolve(document, kb("tenant"));

        assertThat(result.principals()).doesNotContain("tenant:all");
        assertThat(result.principals()).contains("user:" + document.getOwnerId(), "role:ADMIN");
        assertThat(result.visibility()).isEqualTo("internal");
    }

    @Test
    void privateKnowledgeBaseWithoutMembersOnlyAllowsOwnerAndAdmin() {
        when(memberMapper.selectList(any())).thenReturn(List.of());

        AclService.AclResult result = aclService.resolve(document("private", "inherit"), kb("private"));

        assertThat(result.principals()).hasSize(2);
        assertThat(result.principals()).doesNotContain("tenant:all");
    }
}