package com.knowledgehub.iam.security;

import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.JwtService;
import com.knowledgehub.common.security.KhSecurityProperties;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.tenant.TenantContext;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    public static final String TICKET_SCOPE = "ticket";

    private final JwtService jwtService;
    private final KhSecurityProperties props;

    public JwtAuthFilter(JwtService jwtService, KhSecurityProperties props) {
        this.jwtService = jwtService;
        this.props = props;
    }

    @Override
    protected boolean shouldNotFilterAsyncDispatch() {
        return false;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String token = resolveToken(request);
        if (token != null) {
            try {
                Claims claims = jwtService.parse(token);
                if (!TICKET_SCOPE.equals(claims.get("scope", String.class))) {
                    CurrentUser user = toCurrentUser(claims);
                    UserContext.set(user);
                    TenantContext.set(user.tenantId());
                    List<SimpleGrantedAuthority> authorities = user.roles().stream()
                            .map(r -> new SimpleGrantedAuthority("ROLE_" + r))
                            .collect(Collectors.toList());
                    user.permissions().forEach(p -> authorities.add(new SimpleGrantedAuthority("PERM_" + p)));
                    SecurityContextHolder.getContext().setAuthentication(
                            new UsernamePasswordAuthenticationToken(user, token, authorities));
                }
            } catch (JwtException | IllegalArgumentException | BizException ignored) {
                // Invalid/expired token is treated as anonymous so protected endpoints answer 401.
            }
        }
        try {
            chain.doFilter(request, response);
        } finally {
            UserContext.clear();
            TenantContext.clear();
            SecurityContextHolder.clearContext();
        }
    }

    private String resolveToken(HttpServletRequest request) {
        String header = request.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            return header.substring(7);
        }
        if (request.getCookies() != null) {
            for (Cookie cookie : request.getCookies()) {
                if (props.getCookieName().equals(cookie.getName())) {
                    return cookie.getValue();
                }
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private CurrentUser toCurrentUser(Claims claims) {
        return new CurrentUser(
                UUID.fromString(claims.getSubject()),
                claims.get("usr", String.class),
                claims.get("name", String.class),
                claims.get("tid", String.class),
                toSet(claims.get("roles", Collection.class)),
                toSet(claims.get("perms", Collection.class)),
                toSet(claims.get("depts", Collection.class)),
                toSet(claims.get("groups", Collection.class)));
    }

    private Set<String> toSet(Collection<?> values) {
        if (values == null) {
            return Set.of();
        }
        return values.stream().map(String::valueOf).collect(Collectors.toSet());
    }
}