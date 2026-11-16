-- 思考链落库：刷新页面后仍能看到这条回答经历了哪些步骤。
-- 引擎通过 status 事件报告阶段，后端在收流时累计并写入这里（用户可读的中文步骤）。
ALTER TABLE message ADD COLUMN IF NOT EXISTS reasoning_steps jsonb;
