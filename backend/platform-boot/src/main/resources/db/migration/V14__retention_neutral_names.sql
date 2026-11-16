-- 保留策略名称不要写死天数：改了天数还叫「…保留 180 天」就自相矛盾。
UPDATE retention_policy SET name = '审计日志自动清理' WHERE target = 'audit_log';
UPDATE retention_policy SET name = '会话消息自动清理' WHERE target = 'chat_message';
