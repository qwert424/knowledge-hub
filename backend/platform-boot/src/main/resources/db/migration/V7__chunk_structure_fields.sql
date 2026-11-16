-- 切片结构字段：块类型（paragraph/table/code/image/heading/list/page）单独存一列，
-- 与 block_type 区分开——block_type 是解析器枚举，kind 是检索 Agent 契约里的语义类别。
ALTER TABLE chunk_meta ADD COLUMN IF NOT EXISTS kind VARCHAR(16);
ALTER TABLE chunk_meta ADD COLUMN IF NOT EXISTS block_parent_id VARCHAR(64);
ALTER TABLE chunk_meta ADD COLUMN IF NOT EXISTS chunk_count INTEGER;
ALTER TABLE chunk_meta ADD COLUMN IF NOT EXISTS table_row_index INTEGER;

COMMENT ON COLUMN chunk_meta.kind IS '语义块类型：paragraph/table/code/image/heading/list/page';
COMMENT ON COLUMN chunk_meta.block_parent_id IS '上级结构块 ID（飞书 parent block），根节点为空';
COMMENT ON COLUMN chunk_meta.chunk_count IS '同一结构块内的切片总数';
COMMENT ON COLUMN chunk_meta.table_row_index IS '表格切片对应的原表物理行号，表头为 0';
