-- 菜单状态：hidden = 不进侧栏但仍可按路径访问；enabled = 彻底停用（进不去也不在侧栏）
alter table menu_item add column if not exists enabled boolean not null default true;
