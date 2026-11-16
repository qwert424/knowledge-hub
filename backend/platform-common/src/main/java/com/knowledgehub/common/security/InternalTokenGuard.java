package com.knowledgehub.common.security;

import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

@Component
public class InternalTokenGuard {

    private final KhSecurityProperties props;

    public InternalTokenGuard(KhSecurityProperties props) {
        this.props = props;
    }

    public void require(String token) {
        String expected = props.getInternalToken();
        if (expected == null || expected.isBlank()) {
            return;
        }
        if (token == null || !MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                token.getBytes(StandardCharsets.UTF_8))) {
            throw new BizException(ErrorCode.AUTH_403, "内部服务令牌无效");
        }
    }
}