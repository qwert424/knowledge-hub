package com.knowledgehub.iam.service;

import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.JwtService;
import com.knowledgehub.common.security.KhSecurityProperties;
import io.jsonwebtoken.Claims;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Issues short-lived retrieval tickets. The ticket is the only source of ACL truth for the
 * retrieval layer; models and frontends never supply principals.
 */
@Service
public class RetrievalTicketService {

    private final JwtService jwtService;
    private final KhSecurityProperties props;

    public RetrievalTicketService(JwtService jwtService, KhSecurityProperties props) {
        this.jwtService = jwtService;
        this.props = props;
    }

    public String issue(CurrentUser user, List<UUID> kbIds) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", user.userId().toString());
        claims.put("tid", user.tenantId());
        claims.put("usr", user.username());
        claims.put("scope", "ticket");
        claims.put("principals", user.aclPrincipals());
        claims.put("kb_ids", kbIds.stream().map(UUID::toString).toList());
        claims.put("roles", List.copyOf(user.roles()));
        return jwtService.sign(claims, Duration.ofSeconds(props.getTicketTtlSeconds()));
    }

    public Ticket verify(String ticket) {
        Claims claims = jwtService.parse(ticket);
        if (!"ticket".equals(claims.get("scope", String.class))) {
            throw new IllegalArgumentException("not a retrieval ticket");
        }
        List<String> principals = asStringList(claims.get("principals"));
        List<String> kbIds = asStringList(claims.get("kb_ids"));
        return new Ticket(claims.get("tid", String.class), claims.getSubject(), principals, kbIds,
                Set.copyOf(asStringList(claims.get("roles"))));
    }

    private List<String> asStringList(Object raw) {
        if (raw instanceof List<?> list) {
            return list.stream().map(String::valueOf).collect(Collectors.toList());
        }
        return List.of();
    }

    public record Ticket(String tenantId, String userId, List<String> principals, List<String> kbIds,
                         Set<String> roles) {
    }
}