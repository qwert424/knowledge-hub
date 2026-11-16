package com.knowledgehub.iam.service;

import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.JwtService;
import com.knowledgehub.common.security.KhSecurityProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RetrievalTicketServiceTest {

    private JwtService jwtService;
    private RetrievalTicketService ticketService;
    private CurrentUser user;
    private UUID kbId;

    @BeforeEach
    void setUp() {
        KhSecurityProperties props = new KhSecurityProperties();
        props.setSecret("unit-test-secret-unit-test-secret");
        props.setTicketTtlSeconds(300);
        jwtService = new JwtService(props);
        jwtService.init();
        ticketService = new RetrievalTicketService(jwtService, props);
        kbId = UUID.randomUUID();
        user = new CurrentUser(UUID.randomUUID(), "alice", "Alice", "t1",
                Set.of("STAFF"), Set.of("chat:use"), Set.of(), Set.of("g1"));
    }

    @Test
    void issuesTicketWithTenantPrincipalsAndKbScope() {
        String ticket = ticketService.issue(user, List.of(kbId));

        RetrievalTicketService.Ticket parsed = ticketService.verify(ticket);

        assertThat(parsed.tenantId()).isEqualTo("t1");
        assertThat(parsed.kbIds()).containsExactly(kbId.toString());
        assertThat(parsed.principals()).contains("user:" + user.userId(), "role:STAFF", "group:g1", "tenant:all");
    }

    @Test
    void rejectsTamperedTicket() {
        String ticket = ticketService.issue(user, List.of(kbId));
        String tampered = ticket.substring(0, ticket.length() - 3) + "abc";

        assertThatThrownBy(() -> ticketService.verify(tampered)).isInstanceOf(BizException.class);
    }

    @Test
    void rejectsAccessTokenUsedAsTicket() {
        String accessToken = jwtService.sign(java.util.Map.of(
                "sub", user.userId().toString(),
                "tid", "t1",
                "scope", "user"), java.time.Duration.ofMinutes(5));

        assertThatThrownBy(() -> ticketService.verify(accessToken)).isInstanceOf(IllegalArgumentException.class);
    }
}