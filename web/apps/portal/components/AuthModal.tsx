'use client';

import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Modal, Segmented, Select, Space, Typography, theme } from 'antd';
import { useState } from 'react';
import { useApi, usePortalAuth } from '@/lib/providers';
import { friendlyError } from '@/lib/errors';

interface AuthFormValues {
  tenantId?: string;
  username: string;
  password: string;
  displayName?: string;
}

/**
 * 登录 / 注册弹窗。
 *
 * 进站不校验登录：只有真正要用身份的动作才弹这个框，关闭后仍可继续浏览。
 * 租户是下拉选择（不允许手输），登录与注册共用同一套视觉，避免"两个不同风格的表单"。
 */
export function AuthModal({
  open,
  reason,
  onClose,
}: {
  open: boolean;
  reason?: string;
  onClose: () => void;
}) {
  const api = useApi();
  const { token } = theme.useToken();
  const { login, register } = usePortalAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loginForm] = Form.useForm<AuthFormValues>();
  const [registerForm] = Form.useForm<AuthFormValues>();

  const tenants = useQuery({
    queryKey: ['public-tenants'],
    queryFn: () => api.auth.tenants(),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const tenantOptions = (tenants.data?.items ?? []).map((tenant) => ({
    label: tenant.name || tenant.code,
    value: tenant.id,
  }));

  const submit = async (target: 'login' | 'register') => {
    const form = target === 'login' ? loginForm : registerForm;
    let values: AuthFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      if (target === 'login') {
        await login(values);
      } else {
        await register(values);
      }
      form.resetFields();
    } catch (err) {
      setError(friendlyError(err, '操作失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  };

  const tenantField = (
    <Form.Item label="租户" name="tenantId" style={{ marginBottom: 14 }}>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        loading={tenants.isLoading}
        placeholder={tenants.isError ? '租户列表不可用（可留空用默认租户）' : '默认租户可留空'}
        options={tenantOptions}
        notFoundContent={tenants.isLoading ? '加载中…' : '没有可选租户'}
      />
    </Form.Item>
  );

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={400} centered destroyOnHidden>
      <div style={{ padding: '4px 2px 0' }}>
        <Typography.Title level={4} style={{ marginBottom: 2, fontWeight: 600 }}>
          {mode === 'login' ? '登录 Knowledge Hub' : '注册新账号'}
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {reason ?? '登录后即可基于已授权知识库提问'}
        </Typography.Text>

        <div style={{ margin: '16px 0 12px' }}>
          <Segmented
            block
            value={mode}
            onChange={(value) => {
              setMode(value as 'login' | 'register');
              setError(null);
            }}
            options={[
              { label: '登录', value: 'login' },
              { label: '注册', value: 'register' },
            ]}
          />
        </div>

        {mode === 'login' ? (
          <Form<AuthFormValues>
            form={loginForm}
            layout="vertical"
            requiredMark={false}
            onFinish={() => void submit('login')}
          >
            {tenantField}
            <Form.Item
              label="用户名"
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
              style={{ marginBottom: 14 }}
            >
              <Input
                size="large"
                autoComplete="username"
                prefix={<UserOutlined style={{ color: token.colorTextTertiary }} />}
                placeholder="账号"
              />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
              style={{ marginBottom: 14 }}
            >
              <Input.Password
                size="large"
                autoComplete="current-password"
                prefix={<LockOutlined style={{ color: token.colorTextTertiary }} />}
                placeholder="密码"
              />
            </Form.Item>
            {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
            <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
              登录
            </Button>
          </Form>
        ) : (
          <Form<AuthFormValues>
            form={registerForm}
            layout="vertical"
            requiredMark={false}
            onFinish={() => void submit('register')}
          >
            {tenantField}
            <Form.Item
              label="用户名"
              name="username"
              rules={[
                { required: true, message: '请输入用户名' },
                { min: 3, message: '至少 3 个字符' },
              ]}
              style={{ marginBottom: 14 }}
            >
              <Input
                size="large"
                autoComplete="username"
                prefix={<UserOutlined style={{ color: token.colorTextTertiary }} />}
                placeholder="用于登录的账号"
              />
            </Form.Item>
            <Form.Item label="显示名" name="displayName" style={{ marginBottom: 14 }}>
              <Input size="large" placeholder="可选，例如 张三" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[
                { required: true, message: '请输入密码' },
                { min: 8, message: '至少 8 位' },
              ]}
              style={{ marginBottom: 6 }}
            >
              <Input.Password
                size="large"
                autoComplete="new-password"
                prefix={<LockOutlined style={{ color: token.colorTextTertiary }} />}
                placeholder="至少 8 位"
              />
            </Form.Item>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 14 }}>
              新账号默认为「普通员工」：可以提问与阅读被授权的知识库，不能管理知识库与用户。
            </Typography.Text>
            {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
            <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
              注册并登录
            </Button>
          </Form>
        )}

        <Space size={4} style={{ marginTop: 14, justifyContent: 'center', width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {mode === 'login' ? '还没有账号？' : '已有账号？'}
          </Typography.Text>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, fontSize: 12 }}
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? '去注册' : '去登录'}
          </Button>
        </Space>
      </div>
    </Modal>
  );
}
