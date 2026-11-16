package com.knowledgehub.retrieval.bootstrap;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.integration.config.KhIntegrationProperties;
import com.knowledgehub.retrieval.entity.RetrievalProfile;
import com.knowledgehub.retrieval.mapper.RetrievalProfileMapper;
import com.knowledgehub.retrieval.service.RetrievalProfileService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.util.List;

@Component
@Order(20)
public class RetrievalSeedRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(RetrievalSeedRunner.class);

    /** 早期版本写死的名字：启动时统一改成带 Nacos 坐标的说法 */
    private static final List<String> LEGACY_NAMES = List.of("默认混合检索", "默认策略", "Nacos 默认策略（混合检索）");

    private final RetrievalProfileMapper profileMapper;
    private final KhIntegrationProperties props;
    private final RetrievalProfileService profileService;

    public RetrievalSeedRunner(RetrievalProfileMapper profileMapper, KhIntegrationProperties props,
                               RetrievalProfileService profileService) {
        this.profileMapper = profileMapper;
        this.props = props;
        this.profileService = profileService;
    }

    private String defaultName() {
        return "Nacos 默认策略 · " + props.getNacosRagConfigDataId() + "/" + props.getNacosRagConfigGroup();
    }

    @Override
    public void run(ApplicationArguments args) {
        String tenantId = TenantContext.DEFAULT_TENANT;
        normaliseStoredConfigs(tenantId);
        List<RetrievalProfile> defaults = profileMapper.selectList(Wrappers.<RetrievalProfile>lambdaQuery()
                .eq(RetrievalProfile::getTenantId, tenantId)
                .eq(RetrievalProfile::getIsDefault, true));
        if (!defaults.isEmpty()) {
            // 名字对齐 Nacos：让管理员一眼看出"这条默认策略的参数来自哪份配置"
            for (RetrievalProfile existing : defaults) {
                if (LEGACY_NAMES.contains(existing.getName())) {
                    existing.setName(defaultName());
                    existing.setUpdatedAt(OffsetDateTime.now());
                    profileMapper.updateById(existing);
                    log.info("Renamed default retrieval profile {} -> {}", existing.getId(), existing.getName());
                }
            }
            return;
        }
        RetrievalProfile profile = new RetrievalProfile();
        profile.setId(Ids.uuid7());
        profile.setTenantId(tenantId);
        profile.setName(defaultName());
        profile.setVersion(1);
        profile.setConfig(RetrievalProfileService.DEFAULT_CONFIG);
        profile.setIsDefault(true);
        profile.setStatus("published");
        profile.setPublishedAt(OffsetDateTime.now());
        profile.setCreatedAt(OffsetDateTime.now());
        profile.setUpdatedAt(OffsetDateTime.now());
        profileMapper.insert(profile);
        log.info("Seeded default retrieval profile {}", profile.getId());
    }

    /**
     * 历史策略用的是嵌套配置形状（`dense: {topK}`），引擎读不到这些键，等于静默失效。
     * 启动时统一翻成扁平形状，只改形状不改语义。
     */
    private void normaliseStoredConfigs(String tenantId) {
        List<RetrievalProfile> all = profileMapper.selectList(Wrappers.<RetrievalProfile>lambdaQuery()
                .eq(RetrievalProfile::getTenantId, tenantId));
        for (RetrievalProfile profile : all) {
            String raw = profile.getConfig();
            if (raw == null || raw.isBlank()) {
                continue;
            }
            String normalised = profileService.normaliseConfig(raw);
            if (!normalised.equals(raw)) {
                profile.setConfig(normalised);
                profile.setUpdatedAt(OffsetDateTime.now());
                profileMapper.updateById(profile);
                log.info("Normalised retrieval profile config {} ({})", profile.getId(), profile.getName());
            }
        }
    }
}