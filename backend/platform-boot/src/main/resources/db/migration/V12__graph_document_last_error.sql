-- 图谱抽取失败原因：只显示「失败」不告诉用户为什么，等于让人自己去猜。
ALTER TABLE graph_document ADD COLUMN IF NOT EXISTS last_error text;
