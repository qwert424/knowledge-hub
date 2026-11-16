'use client';

import type { EvalCase, EvalDataset, EvalRun, RetrievalProfileView } from '@kh/api-client';
import { EmptyState, ErrorState, PageHeader, StatusTag, formatDate } from '@kh/ui';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
  theme,
} from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/lib/providers';

interface DatasetFormValues {
  name: string;
  description?: string;
  kbIds?: string[];
}

interface CaseFormValues {
  question: string;
  expectedAnswer?: string;
  expectedDocIds?: string[];
}

interface RunFormValues {
  datasetIds: string[];
  profileId?: string;
}

function parseDocIds(raw?: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseMetrics(raw?: string | null): Array<[string, string]> {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return [];
    }
    return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
      key,
      typeof value === 'number' ? value.toFixed(3) : String(value),
    ]);
  } catch {
    return [];
  }
}

const METRIC_LABELS: Record<string, string> = {
  hitRate: '文档命中率',
  answerAccuracy: '答案准确率',
  answerScore: '答案相似度',
  answerRate: '有答案率',
  docScored: '可计分(文档)',
  answerScored: '可计分(答案)',
  scored: '计分用例',
  failed: '失败',
};

/** 用例导入：JSON 数组优先，否则按 CSV/TSV 逐行解析（首行是表头就跳过）。 */
function parseCaseImport(raw: string): { question: string; expectedAnswer?: string }[] {
  const text = raw.trim();
  if (!text) {
    return [];
  }
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .map((row) => {
            const record = row as Record<string, unknown>;
            const question = String(record.question ?? '').trim();
            const expected = record.expectedAnswer ?? record.answer;
            return {              question,
              expectedAnswer: expected == null ? undefined : String(expected).trim(),
            };
          })
          .filter((row) => row.question.length > 0);
      }
    } catch {
      return [];
    }
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows = lines.map((line) => line.split(/\t|,|，/).map((cell) => cell.trim()));
  if (rows.length > 0 && /问题|question/i.test(rows[0][0] ?? '')) {
    rows.shift();
  }
  return rows
    .filter((cells) => (cells[0] ?? '').length > 0)
    .map((cells) => ({ question: cells[0], expectedAnswer: cells[1] || undefined }));
}

/**
 * 拆行拆列：CSV 里的双引号包裹必须尊重，否则一列里带逗号（很常见，比如长答案）
 * 就会把整行拆散，用户看到的就是"解析不对"。
 */
function parseDelimitedRows(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quoted) {
      if (char === '"') {
        if (raw[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',' || char === '\t' || char === '，') {
      row.push(cell.trim());
      cell = '';
      continue;
    }
    if (char === '\n') {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.length > 0));
}

const HEADER_PATTERN = /问题|答案|期望|查询|输入|输出|question|answer|expected|input|output|query|metadata/i;

/** 列名 → 用途：兼容 input/expected_output、question/answer 这类常见表头 */
function guessColumn(header: string[] | null, kind: 'question' | 'answer'): number {
  if (!header) {
    return kind === 'question' ? 0 : 1;
  }
  const questionPattern = /问题|查询|输入|question|input|query/i;
  const answerPattern = /答案|期望|输出|answer|expected|output/i;
  const pattern = kind === 'question' ? questionPattern : answerPattern;
  const index = header.findIndex((cell) => pattern.test(cell));
  if (index >= 0) {
    return index;
  }
  return kind === 'question' ? 0 : Math.min(1, Math.max(0, header.length - 1));
}

/**
 * 导入表格：拆成表头 + 数据行，交给界面做字段映射。
 * 表头识别走内容判断（含 input/expected_output/question/answer 等），避免把第一行数据吃掉。
 */
function parseImportTable(raw: string): { header: string[] | null; rows: string[][] } {
  const cells = parseDelimitedRows(raw);
  if (cells.length === 0) {
    return { header: null, rows: [] };
  }
  const first = cells[0] ?? [];
  const looksHeader = first.some((cell) => HEADER_PATTERN.test(cell));
  return {
    header: looksHeader ? first : null,
    rows: (looksHeader ? cells.slice(1) : cells).filter((row) => (row[0] ?? '').length > 0),
  };
}

/** 按映射列把表格行转成用例；答案列与期望文档列都可选 */
function casesFromTable(
  rows: string[][],
  questionIndex: number,
  answerIndex: number,
  docIndex = -1,
  resolveDocs?: (cell: string) => string[],
): { question: string; expectedAnswer?: string; expectedDocIds?: string[] }[] {
  return rows
    .map((cells) => {
      const docCell = docIndex >= 0 ? (cells[docIndex] ?? '').trim() : '';
      const expectedDocIds = docCell && resolveDocs ? resolveDocs(docCell) : [];
      return {
        question: (cells[questionIndex] ?? '').trim(),
        expectedAnswer: answerIndex >= 0 ? (cells[answerIndex] ?? '').trim() || undefined : undefined,
        expectedDocIds: expectedDocIds.length > 0 ? expectedDocIds : undefined,
      };
    })
    .filter((row) => row.question.length > 0);
}

/** 从 metrics 里取出 cases/done，用于渲染运行进度 */
function parseProgress(raw?: string | null): { total: number; done: number } | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const total = typeof record.cases === 'number' ? record.cases : 0;
    const done = typeof record.done === 'number' ? record.done : 0;
    if (total === 0) {
      return null;
    }
    return { total, done };
  } catch {
    return null;
  }
}

/** 运行明细：每题的期望答案 / 真实回复 / 期望文档 / 命中文档，摊开给管理员核对 */
interface RunDetailRow {
  question: string;
  expectedAnswer: string;
  answer: string;
  error: string;
  expectedDocs: string[];
  expectedDocTitles: string[];
  hitDocs: string[];
  hitDocTitles: string[];
  docHit: boolean | null;
  answerScore: number | null;
  answerPass: boolean | null;
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function parseRunDetails(raw?: string | null): RunDetailRow[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { details?: unknown };
    if (!Array.isArray(parsed.details)) {
      return [];
    }
    return parsed.details
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => {
        const expectedDocs = asList(item.expectedDocs);
        const hitDocs = asList(item.hitDocs);
        const expectedDocTitles = asList(item.expectedDocTitles);
        const hitDocTitles = asList(item.hitDocTitles);
        return {
          question: String(item.question ?? ''),
          expectedAnswer: String(item.expectedAnswer ?? ''),
          answer: String(item.answer ?? ''),
          error: String(item.error ?? ''),
          expectedDocs,
          expectedDocTitles: expectedDocTitles.length ? expectedDocTitles : expectedDocs,
          hitDocs,
          hitDocTitles: hitDocTitles.length ? hitDocTitles : hitDocs,
          // 老运行记录只有 matched 字段，兜底读一次
          docHit:
            typeof item.docHit === 'boolean' ? item.docHit : typeof item.matched === 'boolean' ? item.matched : null,
          answerScore: typeof item.answerScore === 'number' ? item.answerScore : null,
          answerPass: typeof item.answerPass === 'boolean' ? item.answerPass : null,
        };
      });
  } catch {
    return [];
  }
}

export default function EvalPage() {
  const api = useApi();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const queryClient = useQueryClient();

  const [pickedIds, setPickedIds] = useState<string[]>([]);
  /** 用例批量删除：key 是 `datasetId:caseId`，删除时按 datasetId 分组调接口 */
  const [selectedCaseKeys, setSelectedCaseKeys] = useState<string[]>([]);
  const [editingCase, setEditingCase] = useState<(EvalCase & { datasetId?: string }) | null>(null);
  const [creatingDataset, setCreatingDataset] = useState(false);
  const [creatingCase, setCreatingCase] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [creatingRun, setCreatingRun] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [importQuestionCol, setImportQuestionCol] = useState(0);
  const [importAnswerCol, setImportAnswerCol] = useState(1);
  const [importDocCol, setImportDocCol] = useState(-1);

  const [datasetForm] = Form.useForm<DatasetFormValues>();
  const [caseForm] = Form.useForm<CaseFormValues>();
  const [runForm] = Form.useForm<RunFormValues>();

  const datasets = useQuery({
    queryKey: ['eval-datasets'],
    queryFn: () => api.evalApi.listDatasets(),
  });

  /** 勾选的数据集：可以同时看多个数据集的用例，写操作要求只勾一个 */
  const selectedDataset =
    pickedIds.length === 1 ? ((datasets.data ?? []).find((item) => item.id === pickedIds[0]) ?? null) : null;

  // 同时看多个数据集时逐库拉用例，合并成一张表
  const caseQueries = useQueries({
    queries: pickedIds.map((id) => ({
      queryKey: ['eval-cases', id],
      queryFn: () => api.evalApi.listCases(id),
    })),
  });
  const casesLoading = caseQueries.some((query) => query.isLoading);
  const casesError = caseQueries.find((query) => query.error)?.error;
  const casesData = caseQueries.flatMap((query, index) =>
    (query.data ?? []).map((item) => ({ ...item, datasetId: pickedIds[index] })),
  );

  const runs = useQuery({
    queryKey: ['eval-runs'],
    queryFn: () => api.evalApi.listRuns(),
    refetchInterval: (query) => {
      const items = query.state.data ?? [];
      const active = items.some((run) => run.status === 'queued' || run.status === 'running');
      return active ? 3_000 : 15_000;
    },
  });

  const profiles = useQuery({
    queryKey: ['retrieval-profiles'],
    queryFn: api.retrievalProfiles.list,
  });

  /** 新建数据集时可绑定知识库（留空 = 不限库） */
  const kbs = useQuery({
    queryKey: ['kbs', 'eval'],
    queryFn: () => api.kbs.list({ page: 1, pageSize: 100 }),
  });

  /** 期望文档候选：评测用例需要能勾选"这条应该命中哪些文档" */
  const documents = useQuery({
    queryKey: ['documents', 'eval-options'],
    queryFn: () => api.documents.list({ page: 1, pageSize: 200 }),
  });

  const docOptions = useMemo(
    () =>
      (documents.data?.items ?? []).map((doc) => ({
        value: doc.id,
        label: doc.title || doc.id.slice(0, 8),
      })),
    [documents.data],
  );

  const docTitle = (id: string) => docOptions.find((option) => option.value === id)?.label ?? id.slice(0, 8);

  /**
   * 导入时「期望命中文档」列里填的是文档标题（或 ID），这里翻成 ID。
   * 一个单元格可以写多个，用逗号/分号/斜杠分隔；标题对不上的会被忽略而不是猜。
   */
  const resolveDocCell = (cell: string): string[] =>
    cell
      .split(/[,，;；/、|]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const byTitle = docOptions.find((option) => option.label === item);
        if (byTitle) {
          return byTitle.value;
        }
        const byId = docOptions.find((option) => option.value === item);
        return byId ? byId.value : '';
      })
      .filter(Boolean);

  const datasetItems = useMemo(() => datasets.data ?? [], [datasets.data]);

  /** 导入预览：JSON 直接解析；表格按用户选的列映射，改列不用重新贴 */
  const importTable = useMemo(() => parseImportTable(importText), [importText]);

  // 表头一变就按列名猜一次"问题列/答案列"，猜完仍可手动改
  const headerKey = importTable.header?.join('|') ?? '';
  useEffect(() => {
    if (!headerKey) {
      return;
    }
    const header = headerKey.split('|');
    setImportQuestionCol(guessColumn(header, 'question'));
    setImportAnswerCol(guessColumn(header, 'answer'));
  }, [headerKey]);
  const importPreview = useMemo(
    () =>
      importText.trim().startsWith('[')
        ? parseCaseImport(importText)
        : casesFromTable(importTable.rows, importQuestionCol, importAnswerCol, importDocCol, resolveDocCell),
    [importAnswerCol, importDocCol, importQuestionCol, importTable.rows, importText, docOptions],
  );
  const runItems = useMemo(() => runs.data ?? [], [runs.data]);

  const datasetName = (id?: string | null) =>
    datasetItems.find((dataset) => dataset.id === id)?.name ?? (id ? id.slice(0, 8) : '-');

  const createDataset = useMutation({
    mutationFn: (values: DatasetFormValues) =>
      api.evalApi.createDataset({
        name: values.name,
        description: values.description,
        kbIds: values.kbIds ?? [],
      }),
    onSuccess: () => {
      message.success('数据集已创建');
      setCreatingDataset(false);
      datasetForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['eval-datasets'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const deleteDataset = useMutation({
    mutationFn: (datasetId: string) => api.evalApi.deleteDataset(datasetId),
    onSuccess: (_data, datasetId) => {
      message.success('数据集已移入回收站（可在右上角「回收站」恢复）');
      setPickedIds((prev) => prev.filter((id) => id !== datasetId));
      void queryClient.invalidateQueries({ queryKey: ['eval-datasets'] });
      void queryClient.invalidateQueries({ queryKey: ['eval-runs'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const trash = useQuery({
    queryKey: ['eval-trash'],
    queryFn: () => api.evalApi.trash(),
    enabled: trashOpen,
  });
  const trashData = trash.data;
  const invalidateTrash = () => {
    void queryClient.invalidateQueries({ queryKey: ['eval-trash'] });
    void queryClient.invalidateQueries({ queryKey: ['eval-datasets'] });
    void queryClient.invalidateQueries({ queryKey: ['eval-runs'] });
  };
  const restoreDataset = useMutation({
    mutationFn: (datasetId: string) => api.evalApi.restoreDataset(datasetId),
    onSuccess: () => {
      message.success('数据集已恢复');
      invalidateTrash();
    },
    onError: (error: Error) => message.error(error.message),
  });
  const purgeDataset = useMutation({
    mutationFn: (datasetId: string) => api.evalApi.purgeDataset(datasetId),
    onSuccess: () => {
      message.success('数据集已彻底删除');
      invalidateTrash();
    },
    onError: (error: Error) => message.error(error.message),
  });
  const restoreRun = useMutation({
    mutationFn: (runId: string) => api.evalApi.restoreRun(runId),
    onSuccess: () => {
      message.success('运行记录已恢复');
      invalidateTrash();
    },
    onError: (error: Error) => message.error(error.message),
  });
  const purgeRun = useMutation({
    mutationFn: (runId: string) => api.evalApi.purgeRun(runId),
    onSuccess: () => {
      message.success('运行记录已彻底删除');
      invalidateTrash();
    },
    onError: (error: Error) => message.error(error.message),
  });
  const purgeAllTrash = useMutation({
    mutationFn: () => api.evalApi.purgeTrash(),
    onSuccess: (result) => {
      message.success(`回收站已清空（${result.purged} 项）`);
      invalidateTrash();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const deleteRun = useMutation({
    mutationFn: (runId: string) => api.evalApi.deleteRun(runId),
    onSuccess: () => {
      message.success('运行记录已删除');
      void queryClient.invalidateQueries({ queryKey: ['eval-runs'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  /** 批量导入用例：支持 CSV（问题,期望答案）与 JSON（[{question, expectedAnswer}]） */
  const importCases = useMutation({
    mutationFn: ({
      datasetId,
      cases,
    }: {
      datasetId: string;
      cases: { question: string; expectedAnswer?: string; expectedDocIds?: string[] }[];
    }) => api.evalApi.addCases(datasetId, cases),
    onSuccess: (result) => {
      message.success(`已导入 ${result.added ?? 0} 条用例`);
      setImporting(false);
      setImportText('');
      void queryClient.invalidateQueries({ queryKey: ['eval-cases'] });
      void queryClient.invalidateQueries({ queryKey: ['eval-datasets'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const createCase = useMutation<{ added?: number } | void, Error, CaseFormValues>({
    mutationFn: (values: CaseFormValues) => {
      const datasetId = editingCase?.datasetId ?? selectedDataset?.id;
      if (!datasetId) {
        throw new Error('请只勾选一个数据集后再编辑用例');
      }
      const body = {
        question: values.question,
        expectedAnswer: values.expectedAnswer,
        expectedDocIds: values.expectedDocIds,
      };
      return editingCase
        ? api.evalApi.updateCase(datasetId, editingCase.id, body)
        : api.evalApi.addCases(datasetId, [body]);
    },
    onSuccess: () => {
      message.success(editingCase ? '用例已更新' : '用例已添加');
      setCreatingCase(false);
      setEditingCase(null);
      caseForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['eval-cases'] });
      void queryClient.invalidateQueries({ queryKey: ['eval-datasets'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const deleteCases = useMutation({
    mutationFn: async (keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        const [datasetId, caseId] = key.split(':');
        if (!datasetId || !caseId) {
          continue;
        }
        await api.evalApi.deleteCase(datasetId, caseId);
        deleted += 1;
      }
      return deleted;
    },
    onSuccess: (deleted) => {
      message.success(`已删除 ${deleted} 条用例`);
      setSelectedCaseKeys([]);
      void queryClient.invalidateQueries({ queryKey: ['eval-cases'] });
      void queryClient.invalidateQueries({ queryKey: ['eval-datasets'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const deleteCase = useMutation({
    mutationFn: (payload: { datasetId: string; caseId: string }) => {
      if (!payload.datasetId) {
        throw new Error('未选择数据集');
      }
      return api.evalApi.deleteCase(payload.datasetId, payload.caseId);
    },
    onSuccess: () => {
      message.success('用例已删除');
      void queryClient.invalidateQueries({ queryKey: ['eval-cases'] });
      void queryClient.invalidateQueries({ queryKey: ['eval-datasets'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const createRun = useMutation({
    mutationFn: (values: RunFormValues) =>
      api.evalApi.createRun({ datasetIds: values.datasetIds, profileId: values.profileId }),
    onSuccess: (result) => {
      message.success(`已提交 ${result.runIds.length} 个评测任务`);
      setCreatingRun(false);
      runForm.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['eval-runs'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const cancelRun = useMutation({
    mutationFn: (runId: string) => api.evalApi.cancelRun(runId),
    onSuccess: () => {
      message.success('已取消评测');
      void queryClient.invalidateQueries({ queryKey: ['eval-runs'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const kbName = (id?: string | null) =>
    (kbs.data?.items ?? []).find((kb) => kb.id === id)?.name ?? (id ? id.slice(0, 8) : '');

  /** 分数摘要：命中率 / 有答案率，列表里一眼能看出好坏 */
  const scoreText = (raw?: string | null) =>
    parseMetrics(raw)
      .filter(([key]) => key.endsWith('Rate'))
      .map(([key, value]) => `${METRIC_LABELS[key] ?? key} ${value}`)
      .join(' / ') || '-';

  const datasetColumns: ColumnsType<EvalDataset> = [
    {
      title: '数据集',
      key: 'name',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.description ?? '无描述'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '绑定知识库',
      key: 'kbIds',
      width: 200,
      render: (_, record) => {
        const ids = record.kbIds ?? (record.kbId ? [record.kbId] : []);
        if (ids.length === 0) {
          return <Tag>不限库</Tag>;
        }
        return (
          <Space size={4} wrap>
            {ids.slice(0, 2).map((id) => (
              <Tag key={id} color="geekblue">
                {kbName(id)}
              </Tag>
            ))}
            {ids.length > 2 ? <Tag>+{ids.length - 2}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '用例数',
      dataIndex: 'caseCount',
      key: 'caseCount',
      width: 90,
      align: 'right',
      render: (value?: number | null) => (typeof value === 'number' ? value : 0),
    },
    {
      title: '最近一次评测',
      key: 'lastRun',
      width: 210,
      render: (_, record) => {
        if (!record.lastRunStatus) {
          return <Typography.Text type="secondary">还没跑过</Typography.Text>;
        }
        const metrics = parseProgress(record.lastRunMetrics);
        const scores = parseMetrics(record.lastRunMetrics).filter(([key]) => key.endsWith('Rate'));
        return (
          <Space direction="vertical" size={0}>
            <Space size={6}>
              <StatusTag kind="eval" status={record.lastRunStatus} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatDate(record.lastRunAt)}
              </Typography.Text>
            </Space>
            {scores.length > 0 ? (
              <Typography.Text style={{ fontSize: 12 }}>
                {scores.map(([key, value]) => `${METRIC_LABELS[key] ?? key} ${value}`).join(' · ')}
                {metrics ? ` · ${metrics.done}/${metrics.total} 用例` : ''}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_, record) => (
        <Space size={2}>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setPickedIds([record.id]);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            查看用例
          </Button>
          <Popconfirm
            title={`删除数据集「${record.name}」？`}
            description="用例与历史运行记录会一起删除，不影响知识库内容。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteDataset.mutate(record.id)}
          >
            <Button size="small" type="link" danger loading={deleteDataset.isPending && deleteDataset.variables === record.id}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const caseColumns: ColumnsType<EvalCase & { datasetId?: string }> = [
    {
      // 问题列给足宽度并允许换行，否则长问题会把整行挤成一条线
      title: '问题',
      dataIndex: 'question',
      key: 'question',
      width: 260,
      render: (value: string) => (
        <Typography.Paragraph ellipsis={{ rows: 3, tooltip: value }} style={{ marginBottom: 0 }}>
          {value}
        </Typography.Paragraph>
      ),
    },
    {
      title: '期望答案',
      dataIndex: 'expectedAnswer',
      key: 'expectedAnswer',
      render: (value?: string | null) => (
        <Typography.Paragraph
          ellipsis={{ rows: 2, tooltip: value ?? undefined }}
          style={{ marginBottom: 0 }}
        >
          {value || '-'}
        </Typography.Paragraph>
      ),
    },
    {
      title: '期望文档',
      dataIndex: 'expectedDocIds',
      key: 'expectedDocIds',
      width: 200,
      render: (value?: string | null) => {
        const ids = parseDocIds(value);
        if (ids.length === 0) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        return (
          <Space size={4} wrap>
            {ids.slice(0, 3).map((id) => (
              <Tag key={id}>{docTitle(id)}</Tag>
            ))}
            {ids.length > 3 ? <Tag>+{ids.length - 3}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Space size={2}>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setEditingCase(record);
              setCreatingCase(true);
              caseForm.setFieldsValue({
                question: record.question,
                expectedAnswer: record.expectedAnswer ?? undefined,
                expectedDocIds: parseDocIds(record.expectedDocIds),
              });
            }}
          >
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            danger
            loading={deleteCase.isPending && deleteCase.variables?.caseId === record.id}
            onClick={() =>
              deleteCase.mutate({ datasetId: record.datasetId ?? selectedDataset?.id ?? '', caseId: record.id })
            }
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const runColumns: ColumnsType<EvalRun> = [
    {
      title: '运行',
      key: 'id',
      width: 230,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{datasetName(record.datasetId)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatDate(record.createdAt)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (value: string) => <StatusTag kind="eval" status={value} />,
    },
    {
      title: '进度',
      key: 'progress',
      width: 190,
      render: (_, record) => {
        const progress = parseProgress(record.metrics);
        if (!progress) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
        return (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Progress
              percent={percent}
              size="small"
              status={
                record.status === 'failed'
                  ? 'exception'
                  : record.status === 'canceled'
                    ? 'normal'
                    : record.status === 'succeeded'
                      ? 'success'
                      : 'active'
              }
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {progress.done}/{progress.total} 用例
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '指标',
      dataIndex: 'metrics',
      key: 'metrics',
      render: (value?: string | null) => {
        const metrics = parseMetrics(value).filter(
          ([key]) =>
            key !== 'cases' &&
            key !== 'done' &&
            key !== 'details' &&
            key !== 'failed' &&
            key !== 'docScored' &&
            key !== 'answerScored',
        );
        return metrics.length > 0 ? (
          <Space size={8} wrap>
            {metrics.map(([key, metric]) => {
              const ratio = Number(metric);
              const good = (key === 'hitRate' || key === 'answerAccuracy') && Number.isFinite(ratio) && ratio >= 0.8;
              return (
                <Tag key={key} color={good ? 'green' : 'blue'}>
                  {METRIC_LABELS[key] ?? key}: {metric}
                </Tag>
              );
            })}
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        );
      },
    },
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      key: 'startedAt',
      width: 170,
      render: (value?: string | null) => formatDate(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_, record) => {
        const running = record.status === 'queued' || record.status === 'running';
        return (
          <Space size={2}>
            {running ? (
              <Button
                size="small"
                type="link"
                loading={cancelRun.isPending && cancelRun.variables === record.id}
                onClick={() => cancelRun.mutate(record.id)}
              >
                取消
              </Button>
            ) : null}
            <Popconfirm
              title="删除这条运行记录？"
              description="只是评测结果，不影响数据集与用例。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={running}
              onConfirm={() => deleteRun.mutate(record.id)}
            >
              <Button
                size="small"
                type="link"
                danger
                disabled={running}
                loading={deleteRun.isPending && deleteRun.variables === record.id}
              >
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="评测"
        description="数据集、用例与评测运行；指标用于回归门禁，避免策略或模型调整后召回下滑"
        extra={
          <Space>
            <Button onClick={() => setTrashOpen(true)}>回收站</Button>
            <Button onClick={() => setCreatingDataset(true)}>新建数据集</Button>
            <Button type="primary" onClick={() => setCreatingRun(true)}>
              发起评测
            </Button>
          </Space>
        }
      />

      <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginBottom: 16 }}>
        一条用例 = 一个真实问题 + 期望答案 +（可选）期望命中的文档。评测会按当前检索策略跑这些用例，
        用「文档命中率 / 答案准确率 / 有答案率」衡量"改策略或换模型后有没有变差"。
      </Typography.Paragraph>

      {datasets.error ? (
        <ErrorState
          error={datasets.error}
          title="数据集加载失败"
          onRetry={() => void datasets.refetch()}
        />
      ) : null}

      <Tabs
        items={[
          {
            key: 'datasets',
            label: '数据集与用例',
            children: (
              <Row gutter={16}>
                {/* 左：数据集列表（点一下就切换，不用先收起再看另一个） */}
                <Col span={9}>
                  <Card
                    size="small"
                    title="数据集"
                    styles={{ body: { padding: 8 } }}
                  >
                    {datasets.isLoading ? (
                      <Typography.Text type="secondary">加载中…</Typography.Text>
                    ) : datasetItems.length === 0 ? (
                      <EmptyState title="暂无评测数据集" description="点右上角新建一个" />
                    ) : (
                      <Space direction="vertical" size={6} style={{ width: '100%' }}>
                        {datasetItems.map((dataset) => {
                          const active = pickedIds.includes(dataset.id);
                          return (
                            <div
                              key={dataset.id}
                              role="button"
                              tabIndex={0}
                              // 左侧只是"看哪个数据集的用例"：单击切换，不需要勾选框。
                              // 真正的多选在「发起评测」里做（那里才是要一起跑的场景）。
                              onClick={() => setPickedIds([dataset.id])}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  setPickedIds([dataset.id]);
                                }
                              }}
                              style={{
                                cursor: 'pointer',
                                position: 'relative',
                                padding: '10px 12px 10px 14px',
                                borderRadius: 8,
                                border: `1px solid ${active ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
                                // 选中态不用蓝色底：一片蓝看着像选中了所有行。用浅灰底 + 左侧竖条 + 加粗标题
                                background: active ? token.colorFillQuaternary : token.colorBgContainer,
                                boxShadow: active ? `inset 3px 0 0 ${token.colorPrimary}` : 'none',
                                transition: 'background 0.15s, border-color 0.15s',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  width: '100%',
                                }}
                              >
                                <Typography.Text
                                  strong={active}
                                  ellipsis
                                  style={{ flex: 1, minWidth: 0, color: active ? token.colorPrimaryText : undefined }}
                                >
                                  {dataset.name}
                                </Typography.Text>
                                {active ? (
                                  <Tag
                                    bordered={false}
                                    style={{ marginInlineEnd: 0, background: token.colorFillSecondary }}
                                  >
                                    查看中
                                  </Tag>
                                ) : null}
                                {(() => {
                                  const ids = dataset.kbIds ?? (dataset.kbId ? [dataset.kbId] : []);
                                  const text = ids.length === 0 ? '不限库' : ids.map((id) => kbName(id)).join('、');
                                  return (
                                    <Tooltip title={text}>
                                      <Tag
                                        style={{
                                          marginInlineEnd: 0,
                                          maxWidth: 170,
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                          whiteSpace: 'nowrap',
                                        }}
                                      >
                                        {text}
                                      </Tag>
                                    </Tooltip>
                                  );
                                })()}
                              </div>
                              <div style={{ marginTop: 4 }}>
                                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                                  {dataset.caseCount ?? 0} 条用例
                                  {dataset.lastRunStatus ? ` · 最近：${scoreText(dataset.lastRunMetrics)}` : ''}
                                </Typography.Text>
                                {dataset.description ? (
                                  <Typography.Text
                                    type="secondary"
                                    style={{ fontSize: 12, display: 'block' }}
                                    ellipsis={{ tooltip: dataset.description }}
                                  >
                                    {dataset.description}
                                  </Typography.Text>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </Space>
                    )}
                  </Card>
                </Col>

                {/* 右：当前选中数据集的用例（左侧是单选；多选只在「发起评测」里） */}
                <Col span={15}>
                  <Card
                    size="small"
                    title={selectedDataset ? `${selectedDataset.name} · 用例` : '用例'}
                    extra={
                      <Space size={6}>
                        {selectedCaseKeys.length > 0 ? (
                          <Popconfirm
                            title={`删除选中的 ${selectedCaseKeys.length} 条用例？`}
                            description="删除后不可恢复，评测指标也会随之变化。"
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => deleteCases.mutate(selectedCaseKeys)}
                          >
                            <Button size="small" danger loading={deleteCases.isPending}>
                              删除选中（{selectedCaseKeys.length}）
                            </Button>
                          </Popconfirm>
                        ) : null}
                        <Button size="small" disabled={!selectedDataset} onClick={() => setImporting(true)}>
                          导入用例
                        </Button>
                        <Popconfirm
                          title={selectedDataset ? `删除数据集「${selectedDataset.name}」？` : '删除数据集？'}
                          description={
                            selectedDataset
                              ? `这个数据集下有 ${selectedDataset.caseCount ?? 0} 条用例，删除会一起移入回收站（可恢复）。要永久清理请去「回收站」彻底删除。`
                              : '先在左侧选中一个数据集'
                          }
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          disabled={!selectedDataset}
                          onConfirm={() => selectedDataset && deleteDataset.mutate(selectedDataset.id)}
                        >
                          <Button size="small" danger disabled={!selectedDataset} loading={deleteDataset.isPending}>
                            删除数据集
                          </Button>
                        </Popconfirm>
                        <Button
                          size="small"
                          type="primary"
                          disabled={!selectedDataset}
                          onClick={() => {
                            setEditingCase(null);
                            caseForm.resetFields();
                            setCreatingCase(true);
                          }}
                        >
                          添加用例
                        </Button>
                      </Space>
                    }
                    styles={{ body: { padding: 8 } }}
                  >
                    {pickedIds.length === 0 ? (
                      <EmptyState
                        title="点左侧数据集查看用例"
                        description="一条用例 = 一个问题 + 期望答案 +（可选）期望命中的文档"
                      />
                    ) : casesError ? (
                      <ErrorState
                        error={casesError}
                        title="用例加载失败"
                        onRetry={() => caseQueries.forEach((query) => void query.refetch())}
                      />
                    ) : (
                      <Table<EvalCase & { datasetId?: string }>
                        rowKey={(record) => `${record.datasetId ?? ''}:${record.id}`}
                        size="small"
                        loading={casesLoading}
                        rowSelection={{
                          selectedRowKeys: selectedCaseKeys,
                          onChange: (keys) => setSelectedCaseKeys(keys.map(String)),
                        }}
                        columns={caseColumns}
                        dataSource={casesData}
                        pagination={{ pageSize: 8, size: 'small' }}
                        tableLayout="fixed"
                        scroll={{ x: 900 }}
                        locale={{
                          emptyText: <EmptyState title="暂无用例" description="一条用例就是一个问题加期望答案" />,
                        }}
                      />
                    )}
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: 'runs',
            label: '评测运行',
            children: (
              <div>
                {runs.error ? (
                  <ErrorState
                    error={runs.error}
                    title="评测运行加载失败"
                    onRetry={() => void runs.refetch()}
                  />
                ) : null}
                <Table<EvalRun>
                  rowKey="id"
                  size="middle"
                  loading={runs.isLoading}
                  columns={runColumns}
                  dataSource={runItems}
                  pagination={false}
                  expandable={{
                    rowExpandable: (record) => Boolean(parseRunDetails(record.metrics).length),
                    expandedRowRender: (record) => (
                      // 展开行里再套表格：给它自己一个滚动容器，避免横向把父级撑破
                      <div style={{ width: '100%', maxWidth: '100%', overflowX: 'auto' }}>
                      <Table
                        rowKey={(row) => row.question}
                        size="small"
                        pagination={false}
                        scroll={{ x: 900 }}
                        dataSource={parseRunDetails(record.metrics)}
                        columns={[
                          {
                            title: '问题',
                            dataIndex: 'question',
                            key: 'question',
                            width: 300,
                            render: (value: string) => (
                              <Typography.Paragraph
                                style={{ marginBottom: 0, fontSize: 13 }}
                                ellipsis={{ rows: 2, tooltip: value }}
                              >
                                {value}
                              </Typography.Paragraph>
                            ),
                          },
                          {
                            title: '期望答案',
                            dataIndex: 'expectedAnswer',
                            key: 'expectedAnswer',
                            width: 220,
                            render: (value: string) =>
                              value ? (
                                <Typography.Paragraph
                                  style={{ marginBottom: 0, fontSize: 13 }}
                                  ellipsis={{ rows: 2, tooltip: value }}
                                >
                                  {value}
                                </Typography.Paragraph>
                              ) : (
                                <Typography.Text type="secondary">未指定（不计入准确率）</Typography.Text>
                              ),
                          },
                          {
                            title: '真实回复',
                            dataIndex: 'answer',
                            key: 'answer',
                            width: 260,
                            render: (value: string, row) =>
                              value ? (
                                <Typography.Paragraph
                                  style={{ marginBottom: 0, fontSize: 13 }}
                                  ellipsis={{ rows: 2, tooltip: value }}
                                >
                                  {value}
                                </Typography.Paragraph>
                              ) : (
                                <Typography.Text type="danger">{row.error || '模型未返回内容'}</Typography.Text>
                              ),
                          },
                          {
                            title: '期望文档',
                            key: 'expected',
                            width: 140,
                            render: (_, row) =>
                              row.expectedDocTitles.length === 0 ? (
                                <Typography.Text type="secondary">未指定</Typography.Text>
                              ) : (
                                <Space size={4} wrap>
                                  {row.expectedDocTitles.map((title, index) => (
                                    <Tag key={`${title}-${index}`} style={{ maxWidth: 150 }}>
                                      <span style={{ display: 'inline-block', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                                        {title}
                                      </span>
                                    </Tag>
                                  ))}
                                </Space>
                              ),
                          },
                          {
                            title: '命中文档',
                            key: 'hit',
                            width: 140,
                            render: (_, row) =>
                              row.hitDocTitles.length === 0 ? (
                                <Typography.Text type="secondary">无命中</Typography.Text>
                              ) : (
                                <Space size={4} wrap>
                                  {row.hitDocTitles.map((title, index) => (
                                    <Tag key={`${title}-${index}`} color="green" style={{ maxWidth: 150 }}>
                                      <span style={{ display: 'inline-block', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                                        {title}
                                      </span>
                                    </Tag>
                                  ))}
                                </Space>
                              ),
                          },
                          {
                            title: '结果',
                            key: 'result',
                            width: 120,
                            render: (_, row) => {
                              const docPart =
                                row.expectedDocs.length === 0
                                  ? null
                                  : row.docHit
                                    ? <Tag color="green">文档命中</Tag>
                                    : <Tag color="red">文档未命中</Tag>;
                              const answerPart =
                                row.answerPass === null
                                  ? null
                                  : row.answerPass
                                    ? <Tag color="green">答复通过</Tag>
                                    : <Tag color="orange">答复偏离</Tag>;
                              return (
                                <Space size={4} wrap>
                                  {docPart}
                                  {answerPart}
                                  {docPart === null && answerPart === null ? (
                                    <Typography.Text type="secondary">未设评判标准</Typography.Text>
                                  ) : null}
                                </Space>
                              );
                            },
                          },
                        ]}
                        locale={{ emptyText: <EmptyState title="这次运行没有留下明细" /> }}
                      />
                      </div>
                    ),
                  }}
                  locale={{
                    emptyText: (
                      <EmptyState title="暂无评测运行" description="选择数据集与策略后发起评测" />
                    ),
                  }}
                />
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                  命中率 = 期望文档被检索到的用例占比（只统计填了期望文档的用例）；
                  答案准确率 = 真实回复与期望答案的相似度 ≥ 0.5 的用例占比（只统计填了期望答案的用例）；
                  有答案率 = 模型确实给出内容的用例占比。展开任意一行可以逐条核对四个字段。
                </Typography.Paragraph>
              </div>
            ),
          },
        ]}
      />

      <Modal
        title={`导入用例${selectedDataset ? ` · ${selectedDataset.name}` : ''}`}
        open={importing}
        confirmLoading={importCases.isPending}
        onCancel={() => setImporting(false)}
        destroyOnHidden
        width={720}
        okText={`导入${importPreview.length > 0 ? ` ${importPreview.length} 条` : ''}`}
        onOk={() => {
          if (!selectedDataset) {
            return;
          }
          const cases = importPreview;
          if (cases.length === 0) {
            message.warning('没有解析到用例：每行至少要有问题，或贴 JSON 数组');
            return;
          }
          importCases.mutate({ datasetId: selectedDataset.id, cases });
        }}
      >
        <Space size={8} wrap style={{ marginBottom: 10 }}>
          <Upload
            accept=".csv,.tsv,.txt,.json"
            showUploadList={false}
            beforeUpload={(file) => {
              const reader = new FileReader();
              reader.onload = () => setImportText(String(reader.result ?? ''));
              reader.readAsText(file as unknown as Blob, 'utf-8');
              return false;
            }}
          >
            <Button icon={<UploadOutlined />}>选择文件</Button>
          </Upload>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            支持 CSV / TSV / JSON；也可以直接把内容贴到下面
          </Typography.Text>
        </Space>

        {importTable.header ? (
          // 三个映射放成等宽三列，标签在上、下拉在下；挤成一行时标签和选择器会错位
          <Row gutter={12} style={{ marginBottom: 10 }}>
            {[
              { label: '问题列（必选）', value: importQuestionCol, onChange: setImportQuestionCol, allowSkip: false },
              { label: '期望答案列', value: importAnswerCol, onChange: setImportAnswerCol, allowSkip: true },
              { label: '期望命中文档列', value: importDocCol, onChange: setImportDocCol, allowSkip: true },
            ].map((item) => (
              <Col span={8} key={item.label}>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                  {item.label}
                </Typography.Text>
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  value={item.value}
                  onChange={item.onChange}
                  options={[
                    ...(item.allowSkip ? [{ value: -1, label: '不导入' }] : []),
                    ...(importTable.header ?? []).map((name, index) => ({
                      value: index,
                      label: name || `第 ${index + 1} 列`,
                    })),
                  ]}
                />
              </Col>
            ))}
          </Row>
        ) : null}

        {importTable.header && importDocCol >= 0 ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            该列填文档标题（多个用逗号分隔），导入时按标题匹配成文档 ID；匹配不到的会被忽略。
          </Typography.Paragraph>
        ) : null}

        <Input.TextArea
          rows={9}
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          placeholder={'差旅报销标准是多少？,一线城市住宿 600 元/晚\n请假流程有哪些节点？'}
          style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12.5 }}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          解析结果：{importPreview.length} 条
          {importPreview.length > 0 ? `（首条：${importPreview[0].question.slice(0, 40)}）` : ''}
        </Typography.Paragraph>
      </Modal>

      <Modal
        title="回收站"
        open={trashOpen}
        onCancel={() => setTrashOpen(false)}
        footer={
          <Space>
            <Button
              danger
              disabled={!trashData || (trashData.datasets.length === 0 && trashData.runs.length === 0)}
              onClick={() => {
                Modal.confirm({
                  title: '清空回收站？',
                  content: '数据集、用例与运行记录都会被真删除，无法恢复。',
                  okButtonProps: { danger: true },
                  onOk: () => purgeAllTrash.mutate(),
                });
              }}
            >
              清空回收站
            </Button>
            <Button onClick={() => setTrashOpen(false)}>关闭</Button>
          </Space>
        }
        width={720}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
          这里的「删除」都是软删除：数据只是从列表里消失，可以从这里恢复；「彻底删除」才会真的清掉。
          恢复一个数据集会把它名下的运行记录一起带回来。
        </Typography.Paragraph>
        <Typography.Text strong>数据集</Typography.Text>
        <Table
          rowKey="id"
          size="small"
          style={{ marginTop: 8, marginBottom: 16 }}
          loading={trash.isLoading}
          dataSource={trashData?.datasets ?? []}
          pagination={false}
          locale={{ emptyText: '回收站里没有数据集' }}
          columns={[
            { title: '名称', dataIndex: 'name', key: 'name' },
            {
              title: '删除时间',
              dataIndex: 'deletedAt',
              key: 'deletedAt',
              width: 170,
              render: (value: string) => formatDate(value),
            },
            {
              title: '操作',
              key: 'actions',
              width: 150,
              render: (_, row) => (
                <Space size={4}>
                  <Button size="small" type="link" onClick={() => restoreDataset.mutate(row.id)}>
                    恢复
                  </Button>
                  <Button size="small" type="link" danger onClick={() => purgeDataset.mutate(row.id)}>
                    彻底删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
        <Typography.Text strong>评测运行</Typography.Text>
        <Table
          rowKey="id"
          size="small"
          style={{ marginTop: 8 }}
          loading={trash.isLoading}
          dataSource={trashData?.runs ?? []}
          pagination={false}
          locale={{ emptyText: '回收站里没有运行记录' }}
          columns={[
            {
              title: '数据集',
              dataIndex: 'datasetId',
              key: 'datasetId',
              render: (value: string) => datasetName(value),
            },
            {
              title: '状态',
              dataIndex: 'status',
              key: 'status',
              width: 100,
              render: (value: string) => <StatusTag kind="eval" status={value} />,
            },
            {
              title: '删除时间',
              dataIndex: 'deletedAt',
              key: 'deletedAt',
              width: 170,
              render: (value: string) => formatDate(value),
            },
            {
              title: '操作',
              key: 'actions',
              width: 150,
              render: (_, row) => (
                <Space size={4}>
                  <Button size="small" type="link" onClick={() => restoreRun.mutate(row.id)}>
                    恢复
                  </Button>
                  <Button size="small" type="link" danger onClick={() => purgeRun.mutate(row.id)}>
                    彻底删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        title="新建数据集"
        open={creatingDataset}
        confirmLoading={createDataset.isPending}
        onCancel={() => setCreatingDataset(false)}
        onOk={() => datasetForm.submit()}
        destroyOnHidden
      >
        <Form<DatasetFormValues>
          form={datasetForm}
          layout="vertical"
          onFinish={(values) => createDataset.mutate(values)}
        >
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="产品问答基线集" />
          </Form.Item>
          <Form.Item
            label="绑定知识库（可多选）"
            name="kbIds"
            extra="留空表示不限库：检索调用者有权访问的全部知识库；绑多个库时按这些库评测"
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="不限库"
              options={(kbs.data?.items ?? []).map((kb) => ({ value: kb.id, label: kb.name }))}
            />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={3} placeholder="数据来源、覆盖范围、维护人" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`${editingCase ? '编辑用例' : '添加用例'}${selectedDataset ? ` · ${selectedDataset.name}` : ''}`}
        open={creatingCase}
        confirmLoading={createCase.isPending}
        onCancel={() => {
          setCreatingCase(false);
          setEditingCase(null);
          caseForm.resetFields();
        }}
        onOk={() => caseForm.submit()}
        width={560}
        destroyOnHidden
      >
        <Form<CaseFormValues>
          form={caseForm}
          layout="vertical"
          onFinish={(values) => createCase.mutate(values)}
        >
          <Form.Item label="问题" name="question" rules={[{ required: true, message: '请输入问题' }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="期望答案" name="expectedAnswer">
            <Input.TextArea rows={3} placeholder="可选：用来对比答案正确性" />
          </Form.Item>
          <Form.Item
            label="期望命中的文档"
            name="expectedDocIds"
            extra="可选：评测会检查检索结果有没有命中这些文档"
          >
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="选择应该被命中的文档"
              options={docOptions}
              maxTagCount="responsive"
              allowClear
              loading={documents.isLoading}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="发起评测"
        open={creatingRun}
        confirmLoading={createRun.isPending}
        onCancel={() => setCreatingRun(false)}
        onOk={() => runForm.submit()}
        afterOpenChange={(open) => {
          // 左侧已经点了数据集就直接带进来，不用再选一次
          if (open) {
            runForm.setFieldsValue({ datasetIds: pickedIds });
          }
        }}
        destroyOnHidden
      >
        <Form<RunFormValues>
          form={runForm}
          layout="vertical"
          onFinish={(values) => createRun.mutate(values)}
        >
          <Form.Item
            label="数据集"
            name="datasetIds"
            rules={[{ required: true, message: '请选择至少一个数据集' }]}
            extra="可多选，同一策略会为每个数据集分别生成一条运行记录"
          >
            <Select
              mode="multiple"
              optionFilterProp="label"
              placeholder="选择数据集（可多选）"
              options={datasetItems.map((dataset) => ({ label: dataset.name, value: dataset.id }))}
            />
          </Form.Item>
          <Form.Item
            label="检索策略"
            name="profileId"
            extra="只能选已发布（启用）的策略；留空则用当前默认策略"
          >
            <Select
              allowClear
              placeholder="默认策略"
              options={(profiles.data ?? [])
                .filter((profile: RetrievalProfileView) => profile.status === 'published')
                .map((profile: RetrievalProfileView) => ({
                  label: `${profile.name}（v${profile.version}）`,
                  value: profile.id,
                }))}
              notFoundContent="没有已发布的策略，先去「检索策略与调试」发布一条"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}