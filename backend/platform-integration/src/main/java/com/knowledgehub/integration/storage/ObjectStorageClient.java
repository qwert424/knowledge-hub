package com.knowledgehub.integration.storage;

import com.knowledgehub.integration.config.KhIntegrationProperties;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.ResponseBytes;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.BucketAlreadyExistsException;
import software.amazon.awssdk.services.s3.model.BucketAlreadyOwnedByYouException;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import software.amazon.awssdk.services.s3.model.HeadBucketRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.PresignedGetObjectRequest;
import software.amazon.awssdk.services.s3.presigner.model.PresignedPutObjectRequest;

import java.net.URI;
import java.time.Duration;

@Component
public class ObjectStorageClient {

    private static final Logger log = LoggerFactory.getLogger(ObjectStorageClient.class);

    private final KhIntegrationProperties props;
    private S3Client s3;
    private S3Presigner presigner;

    public ObjectStorageClient(KhIntegrationProperties props) {
        this.props = props;
    }

    @PostConstruct
    void init() {
        if (props.getStorageAccessKey() == null || props.getStorageAccessKey().isBlank()) {
            log.warn("Object storage credentials are empty; upload endpoints will fail until kh.integration.storage-* is set");
            return;
        }
        AwsBasicCredentials credentials = AwsBasicCredentials.create(
                props.getStorageAccessKey(), props.getStorageSecretKey());
        S3Configuration s3Configuration = S3Configuration.builder().pathStyleAccessEnabled(true).build();
        String endpoint = withScheme(props.getStorageEndpoint());
        this.s3 = S3Client.builder()
                .endpointOverride(URI.create(endpoint))
                .region(Region.of("us-east-1"))
                .credentialsProvider(StaticCredentialsProvider.create(credentials))
                .serviceConfiguration(s3Configuration)
                .build();
        // 预签名走"浏览器可见地址"：容器内是 http://shared-minio:9000，浏览器解析不到，
        // 直传就会报 Failed to fetch；签名用宿主映射地址才连得上。
        String publicEndpoint = withScheme(props.getStoragePublicEndpoint());
        this.presigner = S3Presigner.builder()
                .endpointOverride(URI.create(publicEndpoint))
                .region(Region.of("us-east-1"))
                .credentialsProvider(StaticCredentialsProvider.create(credentials))
                .serviceConfiguration(s3Configuration)
                .build();
        ensureBucket();
    }

    private static String withScheme(String raw) {
        String endpoint = raw == null ? "" : raw.trim();
        if (endpoint.isEmpty()) {
            return "http://127.0.0.1:9002";
        }
        if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
            endpoint = "http://" + endpoint;
        }
        return endpoint;
    }

    public boolean available() {
        return s3 != null;
    }

    public void ensureBucket() {
        if (s3 == null) {
            return;
        }
        String bucket = props.getStorageBucket();
        try {
            s3.headBucket(HeadBucketRequest.builder().bucket(bucket).build());
        } catch (S3Exception ex) {
            try {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
                log.info("Created bucket {}", bucket);
            } catch (BucketAlreadyExistsException | BucketAlreadyOwnedByYouException ignored) {
                log.debug("Bucket {} already exists", bucket);
            } catch (S3Exception createEx) {
                log.warn("Cannot create bucket {}: {}", bucket, createEx.getMessage());
            }
        }
    }

    public PresignedUpload presignUpload(String objectKey, String contentType) {
        requireAvailable();
        PutObjectRequest request = PutObjectRequest.builder()
                .bucket(props.getStorageBucket())
                .key(objectKey)
                .contentType(contentType)
                .build();
        PresignedPutObjectRequest presigned = presigner.presignPutObject(builder -> builder
                .signatureDuration(Duration.ofSeconds(props.getPresignExpirySeconds()))
                .putObjectRequest(request));
        return new PresignedUpload(presigned.url().toString(), objectKey,
                props.getPresignExpirySeconds());
    }

    public String presignDownload(String objectKey) {
        requireAvailable();
        GetObjectRequest request = GetObjectRequest.builder()
                .bucket(props.getStorageBucket())
                .key(objectKey)
                .build();
        PresignedGetObjectRequest presigned = presigner.presignGetObject(builder -> builder
                .signatureDuration(Duration.ofSeconds(props.getPresignExpirySeconds()))
                .getObjectRequest(request));
        return presigned.url().toString();
    }

    public byte[] getObject(String objectKey) {
        requireAvailable();
        ResponseBytes<GetObjectResponse> bytes = s3.getObjectAsBytes(GetObjectRequest.builder()
                .bucket(props.getStorageBucket())
                .key(objectKey)
                .build());
        return bytes.asByteArray();
    }

    public void putObject(String objectKey, byte[] content, String contentType) {
        requireAvailable();
        s3.putObject(PutObjectRequest.builder()
                        .bucket(props.getStorageBucket())
                        .key(objectKey)
                        .contentType(contentType)
                        .build(),
                RequestBody.fromBytes(content));
    }

    public void deleteObject(String objectKey) {
        if (s3 == null) {
            return;
        }
        s3.deleteObject(builder -> builder.bucket(props.getStorageBucket()).key(objectKey));
    }

    private void requireAvailable() {
        if (s3 == null) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.STORAGE_UNAVAILABLE,
                    "对象存储未配置：请设置 MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY");
        }
    }

    public record PresignedUpload(String url, String objectKey, int expiresIn) {
    }
}