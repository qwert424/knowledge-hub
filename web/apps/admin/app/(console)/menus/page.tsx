'use client';

import type { MenuItemView, PermissionDef } from '@kh/api-client';
import { EmptyState, ErrorState, PageHeader } from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { useApi } from '@/lib/providers';
import { friendlyAdminError } from '@/lib/errors';

interface MenuFormValues {
  section: string;
  label: string;
  path: string;
  permission?: string;
  sortOrder?: number;
  /** 表单里统一用"在侧栏显示"，提交时再转成后端的 hidden */
  shown?: boolean;
  /** 停用后侧栏不出现、直接访问路由也会被挡回 */
  enabled?: boolean;
}

/** 权限码 → 中文名，避免菜单里全是 kb:read 这种码 */
function permissionLabel(code: string | null | undefined, defs: PermissionDef[]): string {
  if (!code) {
    return '登录即可见';
  }
  const matched = defs.find((def) => def.code === code);
  return matched ? `${matched.name} · ${code}` : code;
}

export default function MenusPage() {
  const api = useApi();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<MenuItemView | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<MenuFormValues>();

  const menus = useQuery({ queryKey: ['admin-menus'], queryFn: () => api.menus.list() });
  const permissions = useQuery({
    queryKey: ['permissions'],
    queryFn: () => api.iam.listPermissions(),
    retry: false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-menus'] });
  };

  const createItem = useMutation({
    mutationFn: (values: MenuFormValues) =>
      api.menus.create({
        section: values.section,
        label: values.label,
        path: values.path,
        permission: values.permission,
        sortOrder: values.sortOrder,
        hidden: values.shown === undefined ? undefined : !values.shown,
        enabled: values.enabled,
      }),
    onSuccess: () => {
      message.success('菜单已新增');
      setCreating(false);
      form.resetFields();
      invalidate();
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const updateItem = useMutation({
    mutationFn: ({
      id,
      values,
    }: {
      id: string;
      values: Partial<MenuFormValues> & { hidden?: boolean; enabled?: boolean };
    }) =>
      api.menus.update(id, {
        section: values.section,
        label: values.label,
        path: values.path,
        // 只改 hidden 时不要顺手清空权限：undefined 表示"这次不改"
        permission: values.permission === undefined ? undefined : values.permission ?? '',
        sortOrder: values.sortOrder,
        hidden: values.hidden,
        enabled: values.enabled,
      }),
    onSuccess: () => {
      message.success('菜单已更新');
      setEditing(null);
      form.resetFields();
      invalidate();
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const removeItem = useMutation({
    mutationFn: (id: string) => api.menus.remove(id),
    onSuccess: () => {
      message.success('菜单已删除');
      invalidate();
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.menus.reorder(ids),
    onSuccess: () => invalidate(),
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const reset = useMutation({
    mutationFn: () => api.menus.reset(),
    onSuccess: () => {
      message.success('已恢复默认菜单');
      invalidate();
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const items = menus.data ?? [];
  const permissionDefs = permissions.data ?? [];
  const sections = Array.from(new Set(items.map((item) => item.section)));

  /** 整组上移/下移：按分组切块后重新拼出完整顺序提交 */
  const moveSection = (section: string, delta: number) => {
    const index = sections.indexOf(section);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= sections.length) {
      return;
    }
    const blocks = sections.map((name) => items.filter((item) => item.section === name));
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    reorder.mutate(blocks.flat().map((item) => item.id));
  };

  /** 上移/下移：提交新的完整顺序，后端按顺序重排 sortOrder */
  const move = (index: number, delta: number) => {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) {
      return;
    }
    [next[index], next[target]] = [next[target], next[index]];
    reorder.mutate(next.map((item) => item.id));
  };

  const columns: ColumnsType<MenuItemView> = [
    {
      title: '排序',
      key: 'order',
      width: 96,
      render: (_, record) => {
        const index = items.findIndex((item) => item.id === record.id);
        return (
          <Space size={2}>
            <Button
              size="small"
              type="text"
              disabled={index <= 0 || reorder.isPending}
              onClick={() => move(index, -1)}
            >
              ↑
            </Button>
            <Button
              size="small"
              type="text"
              disabled={index < 0 || index >= items.length - 1 || reorder.isPending}
              onClick={() => move(index, 1)}
            >
              ↓
            </Button>
          </Space>
        );
      },
    },
    {
      title: '菜单',
      key: 'label',
      width: 220,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong delete={!record.enabled}>
            {record.label}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.path}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '可见权限',
      dataIndex: 'permission',
      key: 'permission',
      width: 200,
      render: (value: string | null) =>
        value ? (
          <Typography.Text code>{permissionLabel(value, permissionDefs)}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">登录即可见</Typography.Text>
        ),
    },
    {
      title: '状态',
      key: 'enabled',
      width: 120,
      render: (_, record) => (
        <Space size={6}>
          <Switch
            size="small"
            checked={record.enabled}
            loading={updateItem.isPending && updateItem.variables?.id === record.id}
            onChange={(checked) => updateItem.mutate({ id: record.id, values: { enabled: checked } })}
          />
          <Typography.Text type={record.enabled ? undefined : 'secondary'} style={{ fontSize: 12 }}>
            {record.enabled ? '启用' : '停用'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '侧栏',
      key: 'hidden',
      width: 120,
      render: (_, record) => (
        <Space size={6}>
          <Switch
            size="small"
            disabled={!record.enabled}
            checked={!record.hidden}
            loading={updateItem.isPending && updateItem.variables?.id === record.id}
            onChange={(checked) => updateItem.mutate({ id: record.id, values: { hidden: !checked } })}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {!record.enabled ? '—' : record.hidden ? '隐藏' : '显示'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 130,
      render: (_, record) => (
        <Space size={2}>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setEditing(record);
              form.setFieldsValue({
                section: record.section,
                label: record.label,
                path: record.path,
                permission: record.permission ?? undefined,
                sortOrder: record.sortOrder,
                shown: !record.hidden,
                enabled: record.enabled,
              });
            }}
          >
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            danger
            loading={removeItem.isPending && removeItem.variables === record.id}
            onClick={() => removeItem.mutate(record.id)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="菜单管理"
        description="侧栏按分组维护：分组是一级标题，菜单项挂在分组下。状态停用后侧栏不出现、直接访问路由也会被挡回；侧栏只控制是否展示在侧栏里。"
        extra={
          <Space>
            <Button loading={reset.isPending} onClick={() => reset.mutate()}>
              恢复默认
            </Button>
            <Button type="primary" onClick={() => setCreating(true)}>
              新增菜单
            </Button>
          </Space>
        }
      />

      <Card
        styles={{ body: { padding: 12 } }}
        style={{ borderRadius: token.borderRadiusLG, border: `1px solid ${token.colorBorderSecondary}` }}
      >
        {menus.error ? (
          <ErrorState error={menus.error} title="菜单加载失败" onRetry={() => void menus.refetch()} />
        ) : items.length === 0 && !menus.isLoading ? (
          <EmptyState title="暂无菜单" description="点右上角新增，或恢复默认菜单" />
        ) : (
          <Collapse
            key={sections.join('|')}
            defaultActiveKey={sections}
            ghost
            items={sections.map((section) => {
              const sectionItems = items.filter((item) => item.section === section);
              return {
                key: section,
                label: (
                  <Space size={8}>
                    <Typography.Text strong>{section}</Typography.Text>
                    <Tag>{sectionItems.length} 项</Tag>
                    {sectionItems.every((item) => !item.enabled) ? (
                      <Tag color="orange">整组停用</Tag>
                    ) : null}
                  </Space>
                ),
                extra: (
                  <Space size={2} onClick={(event) => event.stopPropagation()}>
                    <Button
                      size="small"
                      type="text"
                      disabled={sections.indexOf(section) <= 0 || reorder.isPending}
                      onClick={() => moveSection(section, -1)}
                    >
                      上移
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      disabled={
                        sections.indexOf(section) < 0 ||
                        sections.indexOf(section) >= sections.length - 1 ||
                        reorder.isPending
                      }
                      onClick={() => moveSection(section, 1)}
                    >
                      下移
                    </Button>
                  </Space>
                ),
                children: (
                  <Table<MenuItemView>
                    rowKey="id"
                    size="small"
                    loading={menus.isLoading}
                    columns={columns}
                    dataSource={sectionItems}
                    pagination={false}
                    scroll={{ x: 820 }}
                    locale={{ emptyText: <EmptyState title="该分组没有菜单" /> }}
                  />
                ),
              };
            })}
          />
        )}
      </Card>

      <Modal
        title="新增菜单"
        open={creating}
        confirmLoading={createItem.isPending}
        onCancel={() => {
          setCreating(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<MenuFormValues> form={form} layout="vertical" onFinish={(values) => createItem.mutate(values)}>
          <MenuFormFields permissionDefs={permissionDefs} sections={sections} />
        </Form>
      </Modal>

      <Modal
        title={`编辑菜单 · ${editing?.label ?? ''}`}
        open={Boolean(editing)}
        confirmLoading={updateItem.isPending}
        onCancel={() => {
          setEditing(null);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<MenuFormValues>
          form={form}
          layout="vertical"
          onFinish={(values) =>
            editing
              ? updateItem.mutate({
                  id: editing.id,
                  values: { ...values, hidden: values.shown === undefined ? undefined : !values.shown },
                })
              : undefined
          }
        >
          <MenuFormFields permissionDefs={permissionDefs} sections={sections} />
        </Form>
      </Modal>
    </div>
  );
}

function MenuFormFields({
  permissionDefs,
  sections,
}: {
  permissionDefs: PermissionDef[];
  sections: string[];
}) {
  const [sectionSearch, setSectionSearch] = useState('');
  const sectionOptions = useMemo(() => {
    const base = sections.map((section) => ({ value: section, label: section }));
    const keyword = sectionSearch.trim();
    if (keyword && !sections.includes(keyword)) {
      base.push({ value: keyword, label: `新建分组「${keyword}」` });
    }
    return base;
  }, [sectionSearch, sections]);
  return (
    <>
      <Form.Item
        label="分组"
        name="section"
        rules={[{ required: true, message: '请选择或输入分组名' }]}
      >
        <Select
          showSearch
          allowClear
          optionFilterProp="label"
          placeholder="选择已有分组，或输入新分组名"
          options={sectionOptions}
          onSearch={setSectionSearch}
          onChange={() => setSectionSearch('')}
        />
      </Form.Item>
      <Form.Item label="菜单名称" name="label" rules={[{ required: true, message: '请填写菜单名称' }]}>
        <Input placeholder="例如：知识库" />
      </Form.Item>
      <Form.Item
        label="路径"
        name="path"
        rules={[{ required: true, message: '请填写路径' }]}
        extra="对应管理端路由，例如 /kbs"
      >
        <Input placeholder="/kbs" />
      </Form.Item>
      <Form.Item label="可见权限" name="permission" extra="留空表示只要登录就能看到">
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="绑定权限码"
          options={permissionDefs.map((def) => ({
            value: def.code,
            label: `${def.name} · ${def.code}`,
          }))}
        />
      </Form.Item>
      <Form.Item label="排序值" name="sortOrder">
        <InputNumber style={{ width: '100%' }} min={0} />
      </Form.Item>
      <Form.Item
        label="状态"
        name="enabled"
        valuePropName="checked"
        initialValue
        extra="停用后侧栏不出现，直接访问路由也会被挡回"
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="侧栏显示"
        name="shown"
        valuePropName="checked"
        initialValue
        extra="只影响侧栏是否展示，隐藏时仍可直接访问路由"
      >
        <Switch />
      </Form.Item>
    </>
  );
}
