package com.kitchenbook.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opens order messages sealed by the app screens (index.html: keyFor / seal).
 * Both sides must stay identical: PBKDF2-SHA256 over the kitchen code, salt
 * "kitchen-book-v1", 100000 rounds, AES-256-GCM, message = "KB1:" + base64(iv[12] + ciphertext).
 */
final class KitchenCrypto {
    final String topic;
    private final SecretKeySpec key;

    private static String cachedCode;
    private static KitchenCrypto cached;

    static synchronized KitchenCrypto forCode(String code) throws Exception {
        if (!code.equals(cachedCode)) {
            cached = new KitchenCrypto(code);
            cachedCode = code;
        }
        return cached;
    }

    private KitchenCrypto(String code) throws Exception {
        SecretKeyFactory f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
        byte[] raw = f.generateSecret(new PBEKeySpec(code.toCharArray(),
                "kitchen-book-v1".getBytes(StandardCharsets.UTF_8), 100000, 256)).getEncoded();
        key = new SecretKeySpec(raw, "AES");
        byte[] h = MessageDigest.getInstance("SHA-256").digest(("topic:" + code).getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder("kb-");
        for (int i = 0; i < 16; i++) sb.append(String.format("%02x", h[i] & 0xff));
        topic = sb.toString();
    }

    /** The decrypted JSON text, or null if this message is not ours. */
    String open(String text) {
        if (text == null || !text.startsWith("KB1:")) return null;
        try {
            byte[] all = Base64.getDecoder().decode(text.substring(4).trim());
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, all, 0, 12));
            return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
