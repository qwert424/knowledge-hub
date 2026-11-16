'use client';

import {
  BellOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Badge, Breadcrumb, Button, Dropdown, Layout, Menu, Popover, Space, Tooltip, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useThemeMode } from './theme';

const { Header, Sider, Content } = Layout;
const SIDER_STORAGE_KEY = 'kh.sider-collapsed';

export interface NavItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  href?: string;
  children?: NavItem[];
}

export interface BreadcrumbItem {
  title: ReactNode;
  href?: string;
}

export interface AppShellProps {
  /** 品牌名，显示在侧栏顶部 */
  brand: string;
  brandHref?: string;
  navItems: NavItem[];
  activeKey: string;
  breadcrumb?: BreadcrumbItem[];
  headerExtra?: ReactNode;
  user?: { name: string; description?: string };
  onLogout?: () => void;
  siderWidth?: number;
  /** 通知面板内容：传入后铃铛变为可展开的通知中心，未传时保持纯图标 */
  notificationPanel?: ReactNode;
  /** 未读数（角标）；0 时不显示角标 */
  notificationCount?: number;
  /** 内容区默认包一层白卡片；Portal 等自定义布局可关闭 */
  contentCard?: boolean;
  contentStyle?: React.CSSProperties;
  children: ReactNode;
}

function toMenuItems(items: NavItem[]): MenuProps['items'] {
  return items.map((item) => ({
    key: item.key,
    icon: item.icon,
    label: item.href ? <Link href={item.href}>{item.label}</Link> : item.label,
    children: item.children ? toMenuItems(item.children) : undefined,
  }));
}

/** 当前页在哪个分组里：进入页面时把这个分组展开，不然二级菜单是折叠的看不到高亮 */
function openKeysFor(items: NavItem[], activeKey: string): string[] {
  for (const item of items) {
    if (!item.children) {
      continue;
    }
    if (item.children.some((child) => child.key === activeKey || child.children?.some((c) => c.key === activeKey))) {
      return [item.key];
    }
  }
  return [];
}

/**
 * 管理端外壳：左侧一级菜单 + 顶部面包屑/用户 + 内容卡片。
 * 通过 `href` 驱动 Next 路由，保持为唯一的客户端边界。
 */
export function AppShell({
  brand,
  brandHref = '/',
  navItems,
  activeKey,
  breadcrumb,
  headerExtra,
  user,
  onLogout,
  siderWidth = 224,
  notificationPanel,
  notificationCount,
  contentCard = true,
  contentStyle,
  children,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { mode, toggle } = useThemeMode();
  const { token } = theme.useToken();

  const userMenu: MenuProps['items'] = [
    {
      key: 'profile',
      // 用 disabled 项做信息展示时，AntD 会把没有 label 的字段显示成 "default"，所以这里必须有值
      label: (
        <Space direction="vertical" size={0}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {user?.name ?? '未登录'}
          </Typography.Text>
          {user?.description ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {user.description}
            </Typography.Text>
          ) : null}
        </Space>
      ),
      disabled: true,
    },
    { type: 'divider' },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      onClick: onLogout,
    },
  ];

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Sider
        width={siderWidth}
        collapsible
        collapsed={collapsed}
        trigger={null}
        theme="dark"
        className="kh-shell-sider"
        style={{ height: '100vh', overflow: 'hidden' }}
      >
        <Link
          href={brandHref}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 56,
            flex: '0 0 56px',
            padding: collapsed ? '0 20px' : '0 18px',
            color: '#fff',
            fontWeight: 600,
            fontSize: 16,
            letterSpacing: 0.2,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              background: 'rgba(255,255,255,0.14)',
              border: '1px solid rgba(255,255,255,0.18)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: '#e8eaed',
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            K
          </span>
          {collapsed ? null : brand}
        </Link>
        {/* 菜单自己滚动：展开二级菜单后整页不再被撑高，内容区滚动条也就不会打架 */}
        <div className="kh-sider-scroll" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
          <Menu
            mode="inline"
            theme="dark"
            selectedKeys={[activeKey]}
            defaultOpenKeys={openKeysFor(navItems, activeKey)}
            items={toMenuItems(navItems)}
            style={{ borderInlineEnd: 'none', paddingTop: 4 }}
          />
        </div>
      </Sider>

      <Layout style={{ height: '100vh', overflow: 'hidden' }}>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            height: 56,
            lineHeight: '56px',
            flex: '0 0 56px',
            paddingInline: 20,
            background: token.colorBgContainer,
            zIndex: 10,
          }}
        >
          <Space size={12} style={{ minWidth: 0 }}>
            <Button
              type="text"
              aria-label={collapsed ? '展开菜单' : '收起菜单'}
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((prev) => !prev)}
            />
            {breadcrumb && breadcrumb.length > 0 ? (
              <Breadcrumb
                items={breadcrumb.map((item) => ({
                  title: item.href ? <Link href={item.href}>{item.title}</Link> : item.title,
                }))}
              />
            ) : null}
          </Space>

          <Space size={8}>
            {headerExtra}
            <Tooltip title={mode === 'light' ? '切换到深色' : '切换到浅色'}>
              <Button
                type="text"
                aria-label="切换主题"
                icon={mode === 'light' ? <MoonOutlined /> : <SunOutlined />}
                onClick={toggle}
              />
            </Tooltip>
            <Popover
              trigger="click"
              placement="bottomRight"
              content={
                notificationPanel ?? (
                  <Typography.Text type="secondary">暂无通知</Typography.Text>
                )
              }
            >
              <Badge count={notificationCount ?? 0} size="small" offset={[-2, 2]}>
                <Button type="text" aria-label="通知" icon={<BellOutlined />} />
              </Badge>
            </Popover>
            <Dropdown menu={{ items: userMenu }} trigger={['click']} placement="bottomRight">
              <Space size={8} style={{ cursor: 'pointer', padding: '0 4px', height: 40, alignItems: 'center' }}>
                <Avatar size={28} icon={<UserOutlined />} style={{ background: token.colorPrimary }} />
                <Typography.Text
                  style={{ maxWidth: 140, lineHeight: '40px', display: 'inline-block', verticalAlign: 'middle' }}
                  ellipsis
                >
                  {user?.name ?? '未登录'}
                </Typography.Text>
              </Space>
            </Dropdown>
          </Space>
        </Header>

        <Content style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, ...contentStyle }}>
          {contentCard ? (
            <div
              style={{
                background: token.colorBgContainer,
                borderRadius: token.borderRadiusLG,
                padding: 20,
                minHeight: '100%',
                boxShadow: `0 1px 2px ${token.colorFillSecondary}`,
              }}
            >
              {children}
            </div>
          ) : (
            children
          )}
        </Content>
      </Layout>
    </Layout>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
}

/** 二级页头：标题 + 说明 + 右侧操作 */
export function PageHeader({ title, description, extra }: PageHeaderProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 16,
        flexWrap: 'wrap',
      }}
    >
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
      </Space>
      {extra ? <Space wrap>{extra}</Space> : null}
    </div>
  );
}
