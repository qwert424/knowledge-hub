package com.knowledgehub.integration.platform;

import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Locale;

/**
 * Cached view of what the LiteLLM gateway actually serves.
 *
 * <p>Model names arrive from the browser (per-conversation model choice), so they must be
 * validated against the gateway before they reach the engine: an arbitrary string there would
 * let a caller pick any upstream deployment the gateway exposes, or probe non-existent aliases.
 * The list is cached briefly so a chat turn costs no extra HTTP round-trip.
 */
@Component
public class GatewayModelCatalog {

    private static final long TTL_MS = 60_000L;

    private final PlatformHealthClient healthClient;

    private volatile List<String> cached = List.of();
    private volatile long cachedAt = 0L;

    public GatewayModelCatalog(PlatformHealthClient healthClient) {
        this.healthClient = healthClient;
    }

    /** Chat-capable, non-backup aliases the console and portal may offer. */
    public List<String> chatModels() {
        return ids().stream()
                .filter(id -> !id.toLowerCase(Locale.ROOT).contains("embed"))
                .filter(id -> !id.toLowerCase(Locale.ROOT).contains("rerank"))
                .filter(id -> !id.toLowerCase(Locale.ROOT).contains("image"))
                .filter(id -> !isBackup(id))
                .toList();
    }

    public boolean isKnownChatModel(String model) {
        if (model == null || model.isBlank()) {
            return false;
        }
        return ids().stream().anyMatch(id -> id.equals(model.trim()));
    }

    /** Fail-open helper: returns true when the gateway cannot be reached at all. */
    public boolean catalogEmpty() {
        return ids().isEmpty();
    }

    private static boolean isBackup(String id) {
        String lower = id.toLowerCase(Locale.ROOT);
        return lower.contains("backup") || lower.contains("fallback") || lower.contains("备用");
    }

    private List<String> ids() {
        long now = System.currentTimeMillis();
        if (now - cachedAt < TTL_MS && !cached.isEmpty()) {
            return cached;
        }
        List<String> fresh = healthClient.modelIds();
        if (!fresh.isEmpty()) {
            cached = List.copyOf(fresh);
            cachedAt = now;
        }
        return cached;
    }
}
