'use client';

import { useAuth } from '@/lib/providers';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface LoginFormValues {
  tenantId?: string;
  username: string;
  password: string;
}

export default function LoginPage() {
  const { login, session, ready } = useAuth();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ready && session) {
      router.replace('/overview');
    }
  }, [ready, router, session]);

  const onSubmit = async (values: LoginFormValues) => {
    setSubmitting(true);
    setError(null);
    try {
      await login({ tenantId: values.tenantId?.trim() || undefined, username: values.username, password: values.password });
      router.replace('/overview');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: 'minmax(320px, 460px)',
        placeContent: 'center',
        background: 'radial-gradient(1200px 600px at 20% 0%, #e8f0ff 0%, #f4f6fa 55%, #eef2f8 100%)',
        padding: 24,
      }}
    >
      <Card style={{ borderRadius: 16, boxShadow: '0 18px 50px rgba(15, 23, 42, 0.12)' }}>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          Knowledge Hub 管理端
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
          知识库、索引任务、检索策略与权限治理
        </Typography.Paragraph>

        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}

        <Form<LoginFormValues> layout="vertical" onFinish={onSubmit} requiredMark={false} initialValues={{ tenantId: 'default' }}>
          <Form.Item label="租户" name="tenantId" extra="单租户部署保持 default 即可">
            <Input placeholder="default" autoComplete="organization" />
          </Form.Item>
          <Form.Item label="账号" name="username" rules={[{ required: true, message: '请输入账号' }]}>
            <Input placeholder="admin" autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="请输入密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
            登录
          </Button>
        </Form>

        <Typography.Paragraph type="secondary" style={{ marginTop: 20, marginBottom: 0, fontSize: 12 }}>
          接口地址：{process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8088'}
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
