package com.knowledgehub;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication(scanBasePackages = "com.knowledgehub")
@MapperScan("com.knowledgehub.**.mapper")
@ConfigurationPropertiesScan("com.knowledgehub")
@EnableScheduling
public class KnowledgeHubApplication {

    public static void main(String[] args) {
        SpringApplication.run(KnowledgeHubApplication.class, args);
    }
}