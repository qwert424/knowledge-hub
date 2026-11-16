'use client';

import type { KbView } from '@kh/api-client';
import { formatBytes } from '@kh/ui';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button, Drawer, Progress, Select, Space, Typography, Upload } from 'antd';
import { useRef, useState } from 'react';
import { useApi } from '@/lib/providers';

type Phase = 'waiting' | 'intent' | 'uploading' | 'committing' | 'done' | 'error';

interface UploadTask {
  uid: string;
  name: string;
  size: number;
  phase: Phase;
  progress: number;
  error?: string;
  documentId?: string;
}

const PHASE_TEXT: Record<Phase, string> = {
  waiting: '等待上传',
  intent: '申请上传地址',
  uploading: '上传对象存储',
  committing: '提交索引',
  done: '已完成',
  error: '失败',
};

async function sha256(file: File): Promise<string | undefined> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return undefined;
  }
  try {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return undefined;
  }
}

/**
 * 两段式上传：upload-intent 拿预签名地址 → PUT 到 MinIO → commit 触发索引。
 * 多个文件串行执行，避免与在线检索争抢对象存储与索引资源。
 */
export function DocumentUploadDrawer({
  open,
  onClose,
  kbs,
}: {
  open: boolean;
  onClose: () => void;
  kbs: KbView[];
}) {
  const api = useApi();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [kbId, setKbId] = useState<string | undefined>(undefined);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [running, setRunning] = useState(false);
  const fileMap = useRef(new Map<string, File>());
  const seqRef = useRef(0);

  const patchTask = (uid: string, patch: Partial<UploadTask>) => {
    setTasks((prev) => prev.map((task) => (task.uid === uid ? { ...task, ...patch } : task)));
  };

  const addFile = (file: File) => {
    // 同名文件可能被重复上传（改完再传一遍是常见操作），所以用自增序号而不是文件属性做 key
    const uid = `${Date.now()}-${seqRef.current++}-${file.name}`;
    fileMap.current.set(uid, file);
    setTasks((prev) => [...prev, { uid, name: file.name, size: file.size, phase: 'waiting', progress: 0 }]);
  };

  const start = async () => {
    if (!kbId) {
      message.warning('请先选择目标知识库');
      return;
    }
    const pending = tasks.filter((task) => task.phase === 'waiting' || task.phase === 'error');
    if (pending.length === 0) {
      message.info('没有待上传的文件');
      return;
    }
    setRunning(true);
    let ok = 0;
    let failedCount = 0;
    for (const task of pending) {
      const file = fileMap.current.get(task.uid);
      if (!file) {
        patchTask(task.uid, { phase: 'error', error: '文件已失效，请重新选择' });
        continue;
      }
      patchTask(task.uid, { phase: 'intent', progress: 5, error: undefined });
      try {
        const intent = await api.documents.uploadIntent({
          kbId,
          filename: file.name,
          sizeBytes: file.size,
          mimeType: file.type || undefined,
        });
        patchTask(task.uid, { phase: 'uploading', progress: 35, documentId: intent.documentId });
        await api.documents.uploadToPresigned(intent, file, file.type || undefined);
        patchTask(task.uid, { phase: 'committing', progress: 75 });
        const contentHash = await sha256(file);
        await api.documents.commit(intent.documentId, { sizeBytes: file.size, contentHash });
        patchTask(task.uid, { phase: 'done', progress: 100 });
        ok += 1;
      } catch (error) {
        const raw = error instanceof Error ? error.message : '';
        // 浏览器 fetch 的 "Failed to fetch" 基本都是跨域/网络，给用户可操作的提示
        const friendly = /failed to fetch|networkerror|load failed/i.test(raw)
          ? '上传到对象存储失败（跨域或网络中断），请重试'
          : raw || '上传失败';
        patchTask(task.uid, { phase: 'error', progress: 100, error: friendly });
        failedCount += 1;
      }
    }
    setRunning(false);
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
    void queryClient.invalidateQueries({ queryKey: ['index-jobs'] });
    if (ok > 0) {
      message.success(`已提交 ${ok} 个文件，索引进度可在「索引任务」查看`);
    }
    if (failedCount > 0) {
      message.warning(`${failedCount} 个文件上传失败，可按提示重试`);
    }
  };

  return (
    <Drawer
      title="上传文档"
      open={open}
      width={560}
      onClose={() => {
        if (running) {
          message.warning('上传进行中，请稍候再关闭');
          return;
        }
        setTasks([]);
        fileMap.current.clear();
        onClose();
      }}
      destroyOnHidden
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div>
          <Typography.Text strong>目标知识库</Typography.Text>
          <Select
            style={{ width: '100%', marginTop: 6 }}
            placeholder="选择知识库"
            value={kbId}
            onChange={setKbId}
            showSearch
            optionFilterProp="label"
            options={kbs.map((kb) => ({ label: `${kb.name}（${kb.code}）`, value: kb.id }))}
          />
        </div>

        <Upload.Dragger
          multiple
          disabled={running}
          showUploadList={false}
          beforeUpload={(file) => {
            addFile(file as unknown as File);
            return false;
          }}
          style={{ background: 'rgba(31,111,235,0.03)' }}
        >
          <Typography.Paragraph style={{ marginBottom: 4 }}>点击或拖拽文件到此处</Typography.Paragraph>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            支持 pdf / docx / pptx / xlsx / md / txt / html / 图片；大小与类型由后端校验
          </Typography.Text>
        </Upload.Dragger>

        {tasks.length > 0 ? (
          <div>
            {tasks.map((task) => (
              <div key={task.uid} style={{ marginBottom: 12 }}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Typography.Text ellipsis style={{ maxWidth: 300 }}>
                    {task.name}
                  </Typography.Text>
                  <Typography.Text
                    type={task.phase === 'error' ? 'danger' : 'secondary'}
                    style={{ fontSize: 12 }}
                  >
                    {PHASE_TEXT[task.phase]} · {formatBytes(task.size)}
                  </Typography.Text>
                </Space>
                <Progress
                  percent={task.progress}
                  size="small"
                  status={
                    task.phase === 'error' ? 'exception' : task.phase === 'done' ? 'success' : 'active'
                  }
                />
                {task.error ? (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    {task.error}
                  </Typography.Text>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <Button
          type="primary"
          block
          disabled={!kbId || running || tasks.length === 0}
          loading={running}
          onClick={() => void start()}
        >
          开始上传（
          {tasks.filter((task) => task.phase === 'waiting' || task.phase === 'error').length} 个待处理）
        </Button>
      </Space>
    </Drawer>
  );
}
