-- 重索引指纹：内容哈希 + 切片参数 + 向量模型 + 流水线版本。
-- 指纹一致时跳过重索引，避免"每次点一下都重新向量化一遍"（花钱且很慢）。
ALTER TABLE document_version ADD COLUMN IF NOT EXISTS fingerprint VARCHAR(64);

COMMENT ON COLUMN document_version.fingerprint IS '内容哈希+切片参数+向量模型+流水线版本的 sha256；相同则重索引可跳过';
