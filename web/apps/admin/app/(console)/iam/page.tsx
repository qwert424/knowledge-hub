'use client';

import type { GroupView, PermissionDef, RoleView, UserView } from '@kh/api-client';
import { EmptyState, ErrorState, PageHeader, StatusTag, formatDate } from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { useApi } from '@/lib/providers';

interface UserFormValues {
  username: string;
  password: string;
  displayName: string;
  email?: string;
  status?: string;
}

interface RoleFormValues {
  code: string;
  name: string;
  description?: string;
  permissions?: string[];
}

/** 角色编码 -> 名称：优先用角色接口里的真实名称，编码兜底（角色是可新增的，不能写死映射表） */
function roleLabel(code: string, roles?: Array<{ code?: string; name?: string }>): string {
  const hit = roles?.find((role) => (role.code ?? '').toUpperCase() === code.toUpperCase());
  return hit?.name ? `${hit.name}` : code;
}

export default function IamPage() {
  const api = useApi();
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [creatingUser, setCreatingUser] = useState(false);
  const [editingUser, setEditingUser] = useState<UserView | null>(null);
  const [roleUser, setRoleUser] = useState<UserView | null>(null);
  const [creatingRole, setCreatingRole] = useState(false);
  const [permissionRole, setPermissionRole] = useState<RoleView | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupMemberTarget, setGroupMemberTarget] = useState<GroupView | null>(null);

  const [userForm] = Form.useForm<UserFormValues>();
  const [roleAssignForm] = Form.useForm<{ roles: string[] }>();
  const [roleForm] = Form.useForm<RoleFormValues>();
  const [groupForm] = Form.useForm<{ code: string; name: string }>();
  const [memberForm] = Form.useForm<{ userId: string }>();
  const [permissionDraft, setPermissionDraft] = useState<string[]>([]);

  const users = useQuery({
    queryKey: ['users', { keyword, page, pageSize }],
    queryFn: () => api.iam.listUsers({ keyword: keyword || undefined, page, pageSize }),
  });
  const roles = useQuery({ queryKey: ['roles'], queryFn: api.iam.listRoles });
  const permissions = useQuery({ queryKey: ['permissions'], queryFn: api.iam.listPermissions });
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.iam.listGroups });

  const roleOptions = useMemo(
    () =>
      (roles.data ?? []).map((role) => ({ label: `${role.name}（${role.code}）`, value: role.code })),
    [roles.data],
  );

  const permissionGroups = useMemo(() => {
    const map = new Map<string, PermissionDef[]>();
    (permissions.data ?? []).forEach((item) => {
      const list = map.get(item.module) ?? [];
      list.push(item);
      map.set(item.module, list);
    });
    return Array.from(map.entries());
  }, [permissions.data]);

  const createUser = useMutation({
    mutationFn: (values: UserFormValues) =>
      api.iam.createUser({
        username: values.username,
        password: values.password,
        displayName: values.displayName,
        email: values.email,
        roles: [],
      }),
    onSuccess: () => {
      message.success('用户已创建');
      setCreatingUser(false);
      userForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const updateUser = useMutation({
    mutationFn: (values: UserFormValues) => {
      if (!editingUser) {
        throw new Error('未选择用户');
      }
      return api.iam.updateUser(editingUser.id, {
        displayName: values.displayName,
        email: values.email,
        status: values.status,
      });
    },
    onSuccess: () => {
      message.success('用户已更新');
      setEditingUser(null);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const assignRoles = useMutation({
    mutationFn: (values: { roles: string[] }) => {
      if (!roleUser) {
        throw new Error('未选择用户');
      }
      return api.iam.assignRoles(roleUser.id, values.roles);
    },
    onSuccess: () => {
      message.success('角色已更新');
      setRoleUser(null);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const createRole = useMutation({
    mutationFn: (values: RoleFormValues) =>
      api.iam.createRole({
        code: values.code,
        name: values.name,
        description: values.description,
        permissions: values.permissions ?? [],
      }),
    onSuccess: () => {
      message.success('角色已创建');
      setCreatingRole(false);
      roleForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const savePermissions = useMutation({
    mutationFn: () => {
      if (!permissionRole) {
        throw new Error('未选择角色');
      }
      return api.iam.setRolePermissions(permissionRole.id, permissionDraft);
    },
    onSuccess: () => {
      message.success('权限点已更新');
      setPermissionRole(null);
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const createGroup = useMutation({
    mutationFn: (values: { code: string; name: string }) => api.iam.createGroup(values),
    onSuccess: () => {
      message.success('用户组已创建');
      setCreatingGroup(false);
      groupForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const addGroupMember = useMutation({
    mutationFn: (values: { userId: string }) => {
      if (!groupMemberTarget) {
        throw new Error('未选择用户组');
      }
      return api.iam.addGroupMember(groupMemberTarget.id, values.userId);
    },
    onSuccess: () => {
      message.success('成员已加入用户组');
      setGroupMemberTarget(null);
      memberForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const userColumns: ColumnsType<UserView> = [
    {
      title: '用户',
      key: 'user',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.displayName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.username}
            {record.email ? ` · ${record.email}` : ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '角色',
      dataIndex: 'roles',
      key: 'roles',
      render: (value: string[]) =>
        value.length > 0 ? (
          <Space size={4} wrap>
            {value.map((role) => (
              <Tag key={role} color="blue">
                {roleLabel(role, roles.data)}
              </Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">未分配</Typography.Text>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (value: string) => <StatusTag kind="user" status={value} />,
    },
    {
      title: '最近登录',
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      width: 160,
      render: (value?: string) => formatDate(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_, record) => (
        <Space size={2}>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setEditingUser(record);
              userForm.setFieldsValue({
                username: record.username,
                password: '',
                displayName: record.displayName,
                email: record.email ?? undefined,
                status: record.status,
              });
            }}
          >
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setRoleUser(record);
              roleAssignForm.setFieldsValue({ roles: record.roles });
            }}
          >
            分配角色
          </Button>
        </Space>
      ),
    },
  ];

  const roleColumns: ColumnsType<RoleView> = [
    {
      title: '角色',
      key: 'role',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Typography.Text strong>{record.name}</Typography.Text>
            {record.builtin ? <Tag>系统内置</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.code} · {record.description ?? '无描述'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '权限点',
      dataIndex: 'permissions',
      key: 'permissions',
      width: 120,
      align: 'right',
      render: (value: string[]) => value.length,
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_, record) => (
        <Button
          size="small"
          type="link"
          onClick={() => {
            setPermissionRole(record);
            setPermissionDraft(record.permissions ?? []);
          }}
        >
          配置权限
        </Button>
      ),
    },
  ];

  const groupColumns: ColumnsType<GroupView> = [
    { title: '用户组名称', dataIndex: 'name', key: 'name' },
    { title: '编码', dataIndex: 'code', key: 'code', width: 200 },
    { title: '成员数', dataIndex: 'memberCount', key: 'memberCount', width: 100, align: 'right' },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_, record) => (
        <Button size="small" type="link" onClick={() => setGroupMemberTarget(record)}>
          添加成员
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="用户与角色"
        description="管理登录账号、角色与用户组。角色决定能进哪些菜单、能做哪些操作；某个知识库能看到什么，在知识库的「成员授权」里单独配置"
      />

      <Tabs
        items={[
          {
            key: 'users',
            label: '用户',
            children: (
              <div>
                <Space style={{ marginBottom: 12 }} wrap>
                  <Input.Search
                    allowClear
                    placeholder="按账号或姓名搜索"
                    style={{ width: 260 }}
                    onSearch={(value) => {
                      setKeyword(value.trim());
                      setPage(1);
                    }}
                  />
                  <Button type="primary" onClick={() => setCreatingUser(true)}>
                    新建用户
                  </Button>
                  <Button onClick={() => void users.refetch()} loading={users.isFetching}>
                    刷新
                  </Button>
                </Space>
                {users.error ? (
                  <ErrorState error={users.error} title="用户列表加载失败" onRetry={() => void users.refetch()} />
                ) : null}
                <Table<UserView>
                  rowKey="id"
                  size="middle"
                  loading={users.isLoading}
                  columns={userColumns}
                  dataSource={users.data?.items ?? []}
                  scroll={{ x: 900 }}
                  locale={{ emptyText: <EmptyState title="暂无用户" description="创建账号后即可分配角色与知识库权限" /> }}
                  pagination={{
                    current: users.data?.page ?? page,
                    pageSize: users.data?.pageSize ?? pageSize,
                    total: users.data?.total ?? 0,
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 个用户`,
                    onChange: (nextPage, nextSize) => {
                      setPage(nextPage);
                      setPageSize(nextSize);
                    },
                  }}
                />
              </div>
            ),
          },
          {
            key: 'roles',
            label: '角色',
            children: (
              <div>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" onClick={() => setCreatingRole(true)}>
                    新建角色
                  </Button>
                  <Button onClick={() => void roles.refetch()} loading={roles.isFetching}>
                    刷新
                  </Button>
                </Space>
                {roles.error ? (
                  <ErrorState error={roles.error} title="角色列表加载失败" onRetry={() => void roles.refetch()} />
                ) : null}
                <Table<RoleView>
                  rowKey="id"
                  size="middle"
                  loading={roles.isLoading}
                  columns={roleColumns}
                  dataSource={roles.data ?? []}
                  pagination={false}
                  locale={{ emptyText: <EmptyState title="暂无角色" /> }}
                />
              </div>
            ),
          },
          {
            key: 'groups',
            label: '用户组',
            children: (
              <div>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" onClick={() => setCreatingGroup(true)}>
                    新建用户组
                  </Button>
                  <Button onClick={() => void groups.refetch()} loading={groups.isFetching}>
                    刷新
                  </Button>
                </Space>
                {groups.error ? (
                  <ErrorState error={groups.error} title="用户组列表加载失败" onRetry={() => void groups.refetch()} />
                ) : null}
                <Table<GroupView>
                  rowKey="id"
                  size="middle"
                  loading={groups.isLoading}
                  columns={groupColumns}
                  dataSource={groups.data ?? []}
                  pagination={false}
                  locale={{ emptyText: <EmptyState title="暂无用户组" description="用户组用于批量授权" /> }}
                />
              </div>
            ),
          },
        ]}
      />

      <Modal
        title="新建用户"
        open={creatingUser}
        confirmLoading={createUser.isPending}
        onCancel={() => setCreatingUser(false)}
        onOk={() => userForm.submit()}
        destroyOnHidden
      >
        <Form<UserFormValues> form={userForm} layout="vertical" onFinish={(values) => createUser.mutate(values)}>
          <Form.Item label="账号" name="username" rules={[{ required: true, message: '请输入账号' }]}>
            <Input placeholder="zhangsan" />
          </Form.Item>
          <Form.Item
            label="初始密码"
            name="password"
            rules={[{ required: true, min: 8, message: '至少 8 位' }]}
          >
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
          <Form.Item label="显示名" name="displayName" rules={[{ required: true, message: '请输入显示名' }]}>
            <Input placeholder="张三" />
          </Form.Item>
          <Form.Item label="邮箱" name="email" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
            <Input placeholder="zhangsan@example.com" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`编辑用户：${editingUser?.username ?? ''}`}
        open={Boolean(editingUser)}
        confirmLoading={updateUser.isPending}
        onCancel={() => setEditingUser(null)}
        onOk={() => userForm.submit()}
        destroyOnHidden
      >
        <Form<UserFormValues> form={userForm} layout="vertical" onFinish={(values) => updateUser.mutate(values)}>
          <Form.Item label="账号">
            <Input value={editingUser?.username} disabled />
          </Form.Item>
          <Form.Item label="显示名" name="displayName" rules={[{ required: true, message: '请输入显示名' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="邮箱" name="email" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="状态" name="status">
            <Select
              options={[
                { label: '正常', value: 'active' },
                { label: '禁用', value: 'disabled' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`分配角色：${roleUser?.displayName ?? ''}`}
        open={Boolean(roleUser)}
        confirmLoading={assignRoles.isPending}
        onCancel={() => setRoleUser(null)}
        onOk={() => roleAssignForm.submit()}
        destroyOnHidden
      >
        <Form form={roleAssignForm} layout="vertical" onFinish={(values) => assignRoles.mutate(values)}>
          <Form.Item label="角色" name="roles">
            <Select mode="multiple" options={roleOptions} placeholder="选择角色" loading={roles.isLoading} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="新建角色"
        open={creatingRole}
        confirmLoading={createRole.isPending}
        onCancel={() => setCreatingRole(false)}
        onOk={() => roleForm.submit()}
        destroyOnHidden
      >
        <Form<RoleFormValues> form={roleForm} layout="vertical" onFinish={(values) => createRole.mutate(values)}>
          <Form.Item
            label="角色编码（可留空自动生成）"
            name="code"
            extra="只用于权限与授权引用；留空会自动生成 ROLE_ 前缀编码"
          >
            <Input placeholder="留空即可，例如 kb_admin" />
          </Form.Item>
          <Form.Item label="角色名称" name="name" rules={[{ required: true, message: '请输入角色名称' }]}>
            <Input placeholder="知识库管理员" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={`权限点：${permissionRole?.name ?? ''}`}
        open={Boolean(permissionRole)}
        width={520}
        onClose={() => setPermissionRole(null)}
        destroyOnHidden
        extra={
          <Button type="primary" loading={savePermissions.isPending} onClick={() => savePermissions.mutate()}>
            保存
          </Button>
        }
      >
        {permissions.error ? (
          <ErrorState error={permissions.error} title="权限点加载失败" onRetry={() => void permissions.refetch()} />
        ) : null}
        <Checkbox.Group
          value={permissionDraft}
          onChange={(values) => setPermissionDraft(values as string[])}
          style={{ width: '100%' }}
        >
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {permissionGroups.map(([module, items]) => (
              <div key={module}>
                <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
                  {module}
                </Typography.Text>
                <Space direction="vertical" size={4}>
                  {items.map((item) => (
                    <Checkbox key={item.code} value={item.code}>
                      <Space size={6}>
                        <span>{item.name}</span>
                        <Typography.Text code style={{ fontSize: 12 }}>
                          {item.code}
                        </Typography.Text>
                      </Space>
                    </Checkbox>
                  ))}
                </Space>
              </div>
            ))}
          </Space>
        </Checkbox.Group>
      </Drawer>

      <Modal
        title="新建用户组"
        open={creatingGroup}
        confirmLoading={createGroup.isPending}
        onCancel={() => setCreatingGroup(false)}
        onOk={() => groupForm.submit()}
        destroyOnHidden
      >
        <Form form={groupForm} layout="vertical" onFinish={(values) => createGroup.mutate(values)}>
          <Form.Item
            label="编码（可留空自动生成）"
            name="code"
            extra="只用于接口引用与授权，留空自动生成"
          >
            <Input placeholder="留空即可，例如 rd_team" />
          </Form.Item>
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="研发团队" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`添加成员：${groupMemberTarget?.name ?? ''}`}
        open={Boolean(groupMemberTarget)}
        confirmLoading={addGroupMember.isPending}
        onCancel={() => setGroupMemberTarget(null)}
        onOk={() => memberForm.submit()}
        destroyOnHidden
      >
        <Form form={memberForm} layout="vertical" onFinish={(values) => addGroupMember.mutate(values)}>
          <Form.Item label="用户 ID" name="userId" rules={[{ required: true, message: '请输入用户 ID' }]}>
            <Input placeholder="用户 UUID" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
