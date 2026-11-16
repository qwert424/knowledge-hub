'use client';

import {
  ApartmentOutlined,
  ApiOutlined,
  AuditOutlined,
  BookOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  MessageOutlined,
  TeamOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { AppShell, EmptyState } from '@kh/ui';
import type { BreadcrumbItem, NavItem } from '@kh/ui';
import { useQuery } from '@tanstack/react-query';
import { Space, Tag, Typography, Button } from 'antd';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, useAuth } from '@/lib/providers';

/**
 * 菜单与权限一一对应：没有权限的入口直接不渲染，
 * 而不是让用户点进去收 403。分组本身没有权限码，靠子项是否可见决定去留。
 * 菜单清单来自后端 `/api/v1/admin/menus`（可在「菜单管理」里增删/排序/绑权限），
 * 后端不可用时回落到内置默认值，避免导航整片消失。
 */
interface GuardedNavItem extends NavItem {
  /** 需要的权限码；不填表示登录即可见（概览） */
  permission?: string;
  children?: GuardedNavItem[];
}

const DEFAULT_NAV: GuardedNavItem[] = [
  { key: '/overview', href: '/overview', label: '概览', icon: <DashboardOutlined /> },
  {
    key: 'group-content',
    label: '知识内容',
    icon: <BookOutlined />,
    children: [
      { key: '/kbs', href: '/kbs', label: '知识库', permission: 'kb:read' },
      { key: '/documents', href: '/documents', label: '文档', permission: 'doc:read' },
      { key: '/index-jobs', href: '/index-jobs', label: '索引任务', permission: 'index:manage' },
    ],
  },
  {
    key: 'group-quality',
    label: '检索与质量',
    icon: <ExperimentOutlined />,
    children: [
      { key: '/retrieval', href: '/retrieval', label: '检索策略', permission: 'profile:manage' },
      { key: '/eval', href: '/eval', label: '评测集与运行', permission: 'eval:manage' },
      { key: '/conversations', href: '/conversations', label: '会话审计', permission: 'ops:audit:read' },
      { key: '/graph', href: '/graph', label: '知识图谱', permission: 'graph:manage' },
    ],
  },
  {
    key: 'group-org',
    label: '组织与成本',
    icon: <TeamOutlined />,
    children: [
      { key: '/iam', href: '/iam', label: '用户与角色', permission: 'iam:user:manage' },
      { key: '/menus', href: '/menus', label: '菜单管理', permission: 'iam:role:manage' },
      { key: '/quota', href: '/quota', label: '用量与额度', permission: 'chat:use' },
    ],
  },
  {
    key: 'group-platform',
    label: '平台与运维',
    icon: <ApiOutlined />,
    children: [
      { key: '/platform', href: '/platform', label: '平台集成', permission: 'profile:manage' },
      { key: '/audit', href: '/audit', label: '审计日志', permission: 'ops:audit:read' },
      { key: '/settings', href: '/settings', label: '设置', permission: 'profile:manage' },
    ],
  },
];

const SECTION_ICONS: Record<string, ReactNode> = {
  总览: <DashboardOutlined />,
  知识内容: <BookOutlined />,
  检索与质量: <ExperimentOutlined />,
  组织与成本: <TeamOutlined />,
  平台与运维: <ApiOutlined />,
};

/** 把平铺的菜单配置拼成分组导航；单条的分组直接提到顶层 */
function navFromConfig(items: { section: string; label: string; path: string; permission?: string | null }[]): GuardedNavItem[] {
  const groups = new Map<string, GuardedNavItem[]>();
  for (const item of items) {
    const leaf: GuardedNavItem = {
      key: item.path,
      href: item.path,
      label: item.label,
      permission: item.permission ?? undefined,
    };
    const list = groups.get(item.section) ?? [];
    list.push(leaf);
    groups.set(item.section, list);
  }
  const nav: GuardedNavItem[] = [];
  for (const [section, leaves] of groups) {
    if (leaves.length === 1) {
      nav.push({ ...leaves[0], icon: SECTION_ICONS[section] ?? <BookOutlined /> });
      continue;
    }
    nav.push({
      key: `group-${section}`,
      label: section,
      icon: SECTION_ICONS[section] ?? <BookOutlined />,
      children: leaves,
    });
  }
  return nav;
}

function canSee(item: GuardedNavItem, permissions: string[]): boolean {
  if (item.children) {
    return item.children.some((child) => canSee(child, permissions));
  }
  return !item.permission || permissions.includes(item.permission) || permissions.includes('*');
}

/** 过滤掉没权限的叶子节点，并把空分组一起拿掉 */
function visibleNav(navItems: GuardedNavItem[], permissions: string[]): GuardedNavItem[] {
  return navItems.filter((item) => canSee(item, permissions)).map((item) => ({
    ...item,
    children: item.children?.filter((child) => canSee(child, permissions)),
  }));
}

function resolveActiveKey(navItems: GuardedNavItem[], pathname: string): string {
  const leafKeys = navItems.flatMap((item) => item.children ?? [item]).map((item) => item.key);
  const matched = leafKeys
    .filter((key) => pathname === key || pathname.startsWith(`${key}/`))
    .sort((a, b) => b.length - a.length)[0];
  return matched ?? '/overview';
}

/** 管理端外壳（唯一客户端边界），页面本身由各路由渲染 */
export function AdminChrome({ children }: { children: ReactNode }) {
  const rawPathname = usePathname() ?? '/overview';
  const { user, logout } = useAuth();
  const api = useApi();
  const router = useRouter();

  // 菜单配置：失败就用内置默认值，导航不会因为后端抖动而消失
  const menus = useQuery({
    queryKey: ['admin-menus'],
    queryFn: () => api.menus.list(),
    enabled: Boolean(user),
    staleTime: 60_000,
    retry: false,
  });

  const navSource = useMemo<GuardedNavItem[]>(() => {
    const items = menus.data ?? [];
    // 停用(enabled=false)的菜单既不进侧栏，也不能靠直接敲 URL 访问
    const configured = items.length > 0
      ? navFromConfig(items.filter((item) => !item.hidden && item.enabled))
      : [];
    return configured.length > 0 ? configured : DEFAULT_NAV;
  }, [menus.data]);

  /** 隐藏(hidden)只是不进侧栏，路由仍可访问，所以守卫单独算一份 */
  const guardSource = useMemo<GuardedNavItem[]>(() => {
    const items = (menus.data ?? []).filter((item) => item.enabled);
    const configured = items.length > 0 ? navFromConfig(items) : [];
    return configured.length > 0 ? configured : DEFAULT_NAV;
  }, [menus.data]);

  const titleMap = useMemo(() => {
    const map: Record<string, string> = { '/overview': '概览' };
    for (const item of menus.data ?? []) {
      map[item.path] = item.label;
    }
    return map;
  }, [menus.data]);

  const permissions = user?.permissions ?? [];
  const navItems = visibleNav(navSource, permissions);
  const guardItems = visibleNav(guardSource, permissions);
  /**
   * 关键：以前用 resolveActiveKey 兜底成 '/overview'，于是"停用/没权限的路由"被当成概览，
   * 守卫永远判断通过 → 直接敲 URL 还能进。这里改成"精确匹配不上就是 null"。
   */
  const matchedKey = useMemo(() => {
    const leafKeys = guardItems.flatMap((item) => item.children ?? [item]).map((item) => item.key);
    const hit = leafKeys
      .filter((key) => rawPathname === key || rawPathname.startsWith(`${key}/`))
      .sort((a, b) => b.length - a.length)[0];
    return hit ?? null;
  }, [guardItems, rawPathname]);
  const activeKey = matchedKey ?? resolveActiveKey(navSource, rawPathname);
  const allowed = matchedKey !== null;
  /** 被挡回时去哪里：取第一个"能看见"的菜单，而不是永远回 /overview（概览自己也可能被停用） */
  const fallbackKey = useMemo(() => {
    const leaves = guardItems.flatMap((item) => item.children ?? [item]);
    return leaves[0]?.key ?? '/overview';
  }, [guardItems]);

  // 直接敲 URL 也要挡住：停用/没权限的路由一律切到第一个可用页
  useEffect(() => {
    if (user && !allowed && rawPathname !== fallbackKey) {
      router.replace(fallbackKey);
    }
  }, [allowed, fallbackKey, rawPathname, router, user]);

  // 真实运维事件（索引失败 / 审计失败），没有事件时徽标为 0 且展示空状态。
  const notifications = useQuery({
    queryKey: ['ops-notifications'],
    queryFn: () => api.ops.notifications(),
    enabled: Boolean(user),
    refetchInterval: 60_000,
    retry: false,
  });

  const items = notifications.data?.items ?? [];
  /**
   * 已读状态按用户存本地。之前的 bug：key 由 user.id 拼，但首次渲染 user 还没加载，
   * key 变成 `:anon` 且再也不会重读，于是刷新后全部又变未读。
   */
  const readStorageKey = `kh-admin-read-notices:${user?.id ?? user?.username ?? 'anon'}`;
  const [readIds, setReadIds] = useState<string[]>([]);
  const [loadedReadKey, setLoadedReadKey] = useState('');
  useEffect(() => {
    if (loadedReadKey === readStorageKey) {
      return;
    }
    try {
      const raw = window.localStorage.getItem(readStorageKey);
      setReadIds(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setReadIds([]);
    }
    setLoadedReadKey(readStorageKey);
  }, [loadedReadKey, readStorageKey]);
  useEffect(() => {
    if (!loadedReadKey) {
      return;
    }
    try {
      window.localStorage.setItem(loadedReadKey, JSON.stringify(readIds));
    } catch {
      // 隐私模式下写不进去就算了，不影响使用
    }
  }, [loadedReadKey, readIds]);
  const unread = items.filter((item) => !readIds.includes(item.id));
  /** 「清空」= 只看这个时间点之后的新事件（事件本身来自审计/索引，不能真删） */
  const clearedKey = `kh-admin-cleared-notices:${user?.id ?? user?.username ?? 'anon'}`;
  const [clearedAt, setClearedAt] = useState('');
  useEffect(() => {
    if (!user) {
      return;
    }
    try {
      setClearedAt(window.localStorage.getItem(clearedKey) ?? '');
    } catch {
      setClearedAt('');
    }
  }, [clearedKey, user]);
  const visibleItems = clearedAt
    ? items.filter((item) => String(item.occurredAt ?? '') > clearedAt)
    : items;
  /**
   * 角标必须和面板里能看到的东西一致：之前用 items 算未读，
   * 「清空」之后面板空了但角标还是 5，看着就像链路没通。
   */
  const visibleUnread = visibleItems.filter((item) => !readIds.includes(item.id));
  const clearNotifications = () => {
    const stamp = new Date().toISOString();
    setClearedAt(stamp);
    setReadIds(items.map((item) => item.id));
    try {
      window.localStorage.setItem(clearedKey, stamp);
    } catch {
      // 隐私模式下写不进去，本次会话仍然生效
    }
  };

  const breadcrumb: BreadcrumbItem[] = [
    { title: '控制台', href: '/overview' },
    { title: titleMap[activeKey] ?? '概览', href: activeKey },
  ];

  return (
    <AppShell
      brand="Knowledge Hub"
      brandHref="/overview"
      navItems={navItems}
      activeKey={activeKey}
      breadcrumb={breadcrumb}
      user={{
        name: user?.displayName || user?.username || '未登录',
        description: `${user?.username ?? ''}${user?.tenantId ? ` · 租户 ${user.tenantId}` : ''}`,
      }}
      onLogout={logout}
      notificationCount={visibleUnread.length}
      notificationPanel={
        visibleItems.length === 0 ? (
          <div style={{ width: 280 }}>
            <EmptyState title="没有新的运维事件" description="索引失败、审计异常会出现在这里" />
          </div>
        ) : (
          <div style={{ width: 360, maxHeight: 400, overflowY: 'auto' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '2px 4px 8px',
              }}
            >
              <Typography.Text strong>
                通知{visibleUnread.length > 0 ? ` · ${visibleUnread.length} 条未读` : ''}
              </Typography.Text>
              <Space size={2}>
                {visibleUnread.length > 0 ? (
                  <Button
                    size="small"
                    type="link"
                    onClick={() => setReadIds(items.map((item) => item.id))}
                  >
                    全部已读
                  </Button>
                ) : null}
                {visibleItems.length > 0 ? (
                  <Button size="small" type="link" danger onClick={clearNotifications}>
                    清空
                  </Button>
                ) : null}
                <Button size="small" type="link" onClick={() => router.push('/audit')}>
                  审计日志
                </Button>
              </Space>
            </div>
            <div style={{ display: 'grid', gap: 2 }}>
              {visibleItems.slice(0, 8).map((item) => {
                const read = readIds.includes(item.id);
                const open = () => {
                  // 点任意一条就等于看过这批通知：一起标记，避免一条一条点
                  setReadIds(items.map((entry) => entry.id));
                  if (item.href) {
                    router.push(item.href);
                  }
                };
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        open();
                      }
                    }}
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      padding: '8px 8px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: read ? 'transparent' : 'rgba(22,119,255,0.05)',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 6,
                        height: 6,
                        marginTop: 7,
                        borderRadius: '50%',
                        flex: '0 0 6px',
                        background: read ? 'transparent' : '#1677ff',
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Typography.Text strong={!read} style={{ fontSize: 12.5 }}>
                        {item.title}
                      </Typography.Text>
                      {item.description ? (
                        <Typography.Paragraph
                          type="secondary"
                          style={{ fontSize: 12, marginBottom: 0 }}
                          ellipsis={{ rows: 2 }}
                        >
                          {item.description}
                        </Typography.Paragraph>
                      ) : null}
                      {/* 显示真实发生时间：不然"每次刷新都是这几条"看不出是新事件还是老事件 */}
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {item.occurredAt ? new Date(String(item.occurredAt)).toLocaleString() : ''}
                      </Typography.Text>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )
      }
    >
      {user && !allowed ? (
        <EmptyState
          title="没有访问权限"
          description={`当前账号无法访问该页面（${rawPathname}），正在为你切到可访问的页面`}
        />
      ) : (
        children
      )}
    </AppShell>
  );
}
