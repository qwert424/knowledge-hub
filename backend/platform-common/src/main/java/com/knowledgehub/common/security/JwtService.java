package com.knowledgehub.common.security;

import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;
import java.util.Map;

import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;

/**
 * Signs and verifies platform JWTs. Uses RS256 when PEM keys are configured, otherwise HS256
 * with the shared secret (local development only).
 */
@Component
public class JwtService {

    private static final Logger log = LoggerFactory.getLogger(JwtService.class);

    private final KhSecurityProperties props;
    private PrivateKey privateKey;
    private PublicKey publicKey;
    private SecretKey hmacKey;

    public JwtService(KhSecurityProperties props) {
        this.props = props;
    }

    @PostConstruct
    public void init() {
        try {
            if (props.getPrivateKeyPath() != null && !props.getPrivateKeyPath().isBlank()
                    && Files.exists(Path.of(props.getPrivateKeyPath()))) {
                privateKey = readPrivateKey(Path.of(props.getPrivateKeyPath()));
                publicKey = readPublicKey(Path.of(props.getPublicKeyPath()));
                log.info("JWT signing mode: RS256");
                return;
            }
        } catch (Exception ex) {
            log.warn("Failed to load RSA keys, falling back to HS256: {}", ex.getMessage());
        }
        String secret = props.getSecret();
        if (secret == null || secret.isBlank()) {
            secret = "knowledge-hub-local-development-secret-key-change-me";
            log.warn("kh.security.secret is empty, using built-in development secret");
        }
        hmacKey = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        log.info("JWT signing mode: HS256");
    }

    public String sign(Map<String, Object> claims, Duration ttl) {
        Instant now = Instant.now();
        var builder = Jwts.builder()
                .claims(claims)
                .issuer(props.getIssuer())
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(ttl)));
        if (privateKey != null) {
            builder.signWith(privateKey, Jwts.SIG.RS256);
        } else {
            builder.signWith(hmacKey);
        }
        return builder.compact();
    }

    public Claims parse(String token) {
        try {
            var parser = Jwts.parser();
            if (publicKey != null) {
                parser = parser.verifyWith(publicKey);
            } else {
                parser = parser.verifyWith(hmacKey);
            }
            return parser.requireIssuer(props.getIssuer()).build().parseSignedClaims(token).getPayload();
        } catch (JwtException | IllegalArgumentException ex) {
            throw new BizException(ErrorCode.AUTH_401, "Token 无效或已过期");
        }
    }

    public boolean rsaEnabled() {
        return privateKey != null;
    }

    private PrivateKey readPrivateKey(Path path) throws IOException {
        String pem = Files.readString(path, StandardCharsets.UTF_8);
        byte[] der = Base64.getMimeDecoder().decode(stripPem(pem));
        try {
            return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(der));
        } catch (Exception ex) {
            throw new IllegalStateException("Invalid RSA private key", ex);
        }
    }

    private PublicKey readPublicKey(Path path) {
        try {
            String pem = Files.readString(path, StandardCharsets.UTF_8);
            byte[] der = Base64.getMimeDecoder().decode(stripPem(pem));
            return KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(der));
        } catch (Exception ex) {
            throw new IllegalStateException("Invalid RSA public key", ex);
        }
    }

    private String stripPem(String pem) {
        return pem.replaceAll("-----BEGIN (.*)-----", "")
                .replaceAll("-----END (.*)-----", "")
                .replaceAll("\\s", "");
    }
}