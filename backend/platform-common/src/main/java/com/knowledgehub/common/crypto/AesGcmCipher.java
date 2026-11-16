package com.knowledgehub.common.crypto;

import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.KhSecurityProperties;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;

/** AES-256-GCM for third-party secrets at rest. */
@Component
public class AesGcmCipher {

    private static final int IV_LENGTH = 12;
    private static final int TAG_LENGTH_BIT = 128;

    private final SecureRandom random = new SecureRandom();
    private final KhSecurityProperties props;

    public AesGcmCipher(KhSecurityProperties props) {
        this.props = props;
    }

    public boolean configured() {
        String key = props.getMasterKey();
        return key != null && !key.isBlank();
    }

    public String encrypt(String plain) {
        if (plain == null) {
            return null;
        }
        try {
            byte[] iv = new byte[IV_LENGTH];
            random.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(), new GCMParameterSpec(TAG_LENGTH_BIT, iv));
            byte[] encrypted = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + encrypted.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(encrypted, 0, out, iv.length, encrypted.length);
            return Base64.getEncoder().encodeToString(out);
        } catch (Exception ex) {
            throw new BizException(ErrorCode.INTERNAL_ERROR, "加密失败");
        }
    }

    public String decrypt(String encoded) {
        if (encoded == null || encoded.isBlank()) {
            return null;
        }
        try {
            byte[] all = Base64.getDecoder().decode(encoded);
            byte[] iv = new byte[IV_LENGTH];
            System.arraycopy(all, 0, iv, 0, IV_LENGTH);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_LENGTH_BIT, iv));
            byte[] plain = cipher.doFinal(all, IV_LENGTH, all.length - IV_LENGTH);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception ex) {
            throw new BizException(ErrorCode.INTERNAL_ERROR, "解密失败");
        }
    }

    private SecretKeySpec key() {
        if (!configured()) {
            throw new BizException(ErrorCode.INTERNAL_ERROR, "未配置 SECRET_MASTER_KEY");
        }
        byte[] raw = Base64.getDecoder().decode(props.getMasterKey());
        if (raw.length != 32) {
            throw new BizException(ErrorCode.INTERNAL_ERROR, "SECRET_MASTER_KEY 必须是 32 字节 base64");
        }
        return new SecretKeySpec(raw, "AES");
    }
}