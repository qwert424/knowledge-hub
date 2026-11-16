'use client';

import type {
  ChatCitation,
  ChatStreamEvent,
  ChatUsageQuota,
  ConversationView,
  GatewayModel,
  KbView,
  MessageView,
} from '@kh/api-client';
import { ApiError } from '@kh/api-client';
import {
  ArrowDownOutlined,
  BookOutlined,
  DownOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Avatar,
  Button,
  Dropdown,
  Layout,
  Modal,
  Progress,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CitationPanel } from './CitationPanel';
import { Composer } from './Composer';
import { MessageBubble, stageLabel, type UiMessage } from './MessageBubble';
import { SessionSidebar } from './SessionSidebar';
import { friendlyError } from '@/lib/errors';
import { defaultModelOf, modelLabelOf } from '@/lib/models';
import { useApi, usePortalAuth } from '@/lib/providers';

const SIDER_WIDTH = 248;
const COLLAPSED_WIDTH = 64;

/**
 * 还没落库的新会话用它做消息桶的 key（首条消息发出后才创建真实会话 id），
 * 这样"新会话"和已有会话可以共用同一套按会话存放的消息状态。
 */
const NEW_SESSION_KEY = '__new__';

/** 后端拉取失败时的兜底文案（正文由管理端配置，见 /api/v1/chat/suggestions） */
const FALLBACK_SUGGESTIONS = [
  '公司差旅报销标准是什么？',
  '入职需要准备哪些材料？',
  '总结一下请假流程的关键节点',
  '报销单需要哪些附件？',
];

/** 空状态最多展示 4 条，两列排布，避免一长串像列表 */
const MAX_SUGGESTIONS = 4;

function newId(): string {
  return `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

/** 用量只占额度零点几个百分点时，0% 的进度条看着像坏了，这里保证有一点可见长度。 */
function visiblePercent(used: number, limit: number): number {
  if (!limit || limit <= 0 || used <= 0) {
    return 0;
  }
  const raw = (used / limit) * 100;
  return Math.min(100, Math.max(1, Number(raw.toFixed(2))));
}

function tokenShare(used: number, limit: number): string {
  if (!limit || limit <= 0) {
    return '不限';
  }
  return `${((used / limit) * 100).toFixed(2)}%`;
}

function toUiMessage(message: MessageView): UiMessage {
  return {
    id: message.id,
    serverId: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content ?? '',
    // 页面刷新 / 接口中断后，落库里的这条还是 streaming：前端没人接着流了，
    // 必须显式标成「已中断」，否则会一直停在“正在生成”。
    status:
      message.status === 'streaming'
        ? ('stopped' as UiMessage['status'])
        : ((message.status as UiMessage['status']) ?? 'completed'),
    citations: message.citations ?? [],
    // 服务端落库的思考链步骤：刷新页面后仍能展开看到这条回答走了哪些阶段
    steps: message.steps && message.steps.length > 0 ? message.steps : undefined,
    createdAt: message.createdAt,
    usage:
      message.inputTokens || message.outputTokens
        ? {
            input_tokens: message.inputTokens ?? 0,
            output_tokens: message.outputTokens ?? 0,
            model: message.model ?? undefined,
          }
        : undefined,
  };
}

function parseKbIds(raw?: string | null): string[] {
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

/** 备份别名不暴露给用户；JEV 是内部决策模型，也不能被当成聊天模型选。 */
function userSelectableModels(models: GatewayModel[]): GatewayModel[] {
  return models.filter(
    (model) =>
      (!model.mode || model.mode === 'chat') &&
      !/backup|fallback|备用/i.test(model.id) &&
      !/^jev[-_.]/i.test(model.id),
  );
}

/**
 * 流结束后把服务端最新状态合并回本地视图。
 *
 * 规则：内容取"更长的那个"——中断时服务端可能还没落库，如果直接用它的空内容覆盖，
 * 用户会看到自己刚看过的段落凭空消失（再切会话回来又出现）。
 */
function mergeAfterStream(local: UiMessage[], server: UiMessage[]): UiMessage[] {
  // 服务端可能为"刚开始、还没有任何 token"的回答落了一条空消息：本地也没有对应内容时
  // 保留它只会得到一个空白气泡，所以这些占位行直接丢掉（后续再有内容会重新拉取）。
  const meaningful = server.filter(
    (item) => item.role !== 'assistant' || item.content.trim().length > 0 || item.status !== 'streaming',
  );
  const byId = new Map(local.map((item) => [item.serverId ?? item.id, item]));
  return meaningful.map((item) => {
    const previous = byId.get(item.serverId ?? item.id);
    if (!previous) {
      return item;
    }
    const localLonger = previous.content.length > item.content.length;
    // 服务端还没收尾（streaming）时以本地的"已停止"为准；已收尾则相信服务端状态。
    const status =
      previous.status === 'stopped' && item.status === 'streaming' ? ('stopped' as const) : item.status;
    return {
      ...item,
      status,
      content: localLonger ? previous.content : item.content,
      // 主动停止时服务端拿不到内存里的引用（引用在 SSE 线程里），
      // 直接覆盖会让刚展示过的引用消失，所以保留本地那份。
      citations: item.citations.length > 0 ? item.citations : previous.citations,
      // 服务端现在会把思考链落库，刷新后从 item.steps 恢复；流式中仍优先用本地的
      steps: previous.steps && previous.steps.length > 0 ? previous.steps : item.steps,
    };
  });
}

/**
 * 用户端工作台。
 *
 * 关键约定：
 * - 进站不拦截登录，只有发消息等需要身份的动作才弹登录框；
 * - 不选知识库 = 纯对话（不检索、不向量化），选了才走 RAG；
 * - 检索策略对用户不可见；知识库与模型在输入框内切换；
 * - 支持停止、重试、编辑提问、从某条消息继续（时间旅行，不销毁当前视图）；
 * - 额度用量不放在顶栏，点开「用量」看详情。
 */
export function Workspace() {
  const api = useApi();
  const { token } = theme.useToken();
  const { message: toast } = App.useApp();
  const queryClient = useQueryClient();
  const { signedIn, user, logout, ensureSignedIn, openAuth } = usePortalAuth();

  const [collapsed, setCollapsed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * 消息按会话分开存：切到别的会话（甚至别的会话还在流式输出）时，
   * 各自的 token 只会写进自己的桶里，不会串到当前视图，也不会把别人的"停止"吃掉。
   */
  const [sessionMessages, setSessionMessages] = useState<Record<string, UiMessage[]>>({});
  const [streamingBySession, setStreamingBySession] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState('');
  const [pendingKbIds, setPendingKbIds] = useState<string[]>([]);
  /** 时间旅行锚点：只标记"从这里继续"，不立刻删消息 */
  const [branchPoint, setBranchPoint] = useState<{ id: string; question: string } | null>(null);
  /** 正在回答时输入的新问题：等当前这条答完再自动发送 */
  /**
   * 排队的问题必须跟着会话走：之前存成全局字符串，切到另一个会话后
   * 下一条回答结束就会把它发到那个会话里（错发）。
   */
  const [queued, setQueued] = useState<{ sessionKey: string; text: string } | null>(null);
  const queuedRef = useRef<{ sessionKey: string; text: string } | null>(null);
  /** Agent 反问（ask_user_question）：带候选时用户可点选，不用重打一遍 */
  const [askUser, setAskUser] = useState<{
    sessionId: string;
    question: string;
    options: string[];
  } | null>(null);
  /** 是否贴着底部：只有贴着时才自动跟随输出，否则显示"回到底部" */
  const [atBottom, setAtBottom] = useState(true);
  const [usageOpen, setUsageOpen] = useState(false);
  const [citationState, setCitationState] = useState<{ open: boolean; citations: ChatCitation[] }>({
    open: false,
    citations: [],
  });
  /** 每个会话最多一条在跑的流：sessionKey -> { 中止控制器, 本地消息 id } */
  const streamsRef = useRef<
    Map<string, { controller: AbortController; localId: string; content: string; serverId?: string }>
  >(new Map());
  const sessionMessagesRef = useRef<Record<string, UiMessage[]>>({});
  const activeKeyRef = useRef<string>(NEW_SESSION_KEY);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadedSessionRef = useRef<Set<string>>(new Set());

  const activeKey = activeId ?? NEW_SESSION_KEY;
  const messages = sessionMessages[activeKey] ?? [];
  const streaming = Boolean(streamingBySession[activeKey]);

  const setMessagesFor = useCallback((key: string, updater: (prev: UiMessage[]) => UiMessage[]) => {
    setSessionMessages((prev) => ({ ...prev, [key]: updater(prev[key] ?? []) }));
  }, []);

  const setStreamingFor = useCallback((key: string, value: boolean) => {
    setStreamingBySession((prev) => {
      if (Boolean(prev[key]) === value) {
        return prev;
      }
      return { ...prev, [key]: value };
    });
  }, []);

  /** 默认指向"当前正在看的会话"，事件回调里会用显式 key 覆盖它。 */
  const setMessages = useCallback(
    (updater: (prev: UiMessage[]) => UiMessage[]) => setMessagesFor(activeKeyRef.current, updater),
    [setMessagesFor],
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setCollapsed(window.localStorage.getItem('kh.portal.sider') === 'collapsed');
  }, []);

  const toggleSider = () => {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('kh.portal.sider', next ? 'collapsed' : 'expanded');
      }
      return next;
    });
  };

  const sessions = useQuery({
    queryKey: ['chat-sessions'],
    queryFn: () => api.chat.listSessions(),
    enabled: signedIn,
  });

  const kbs = useQuery({
    queryKey: ['portal-kbs'],
    // 只拿"启用 + 我有权限"的库：后端过滤，避免别人的私有库出现在选择器里
    queryFn: () => api.kbs.available(),
    enabled: signedIn,
  });

  const models = useQuery({
    queryKey: ['gateway-models'],
    queryFn: () => api.integrations.models(),
    enabled: signedIn,
    staleTime: 5 * 60_000,
  });

  const usage = useQuery({
    queryKey: ['chat-usage'],
    queryFn: () => api.chat.usage(),
    enabled: signedIn,
    staleTime: 30_000,
    // 打开"我的用量"时按 30 秒自动刷新，关掉就停
    refetchInterval: usageOpen ? 30_000 : false,
  });

  const suggestions = useQuery({
    queryKey: ['chat-suggestions'],
    queryFn: () => api.chat.suggestions(),
    enabled: signedIn,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    sessionMessagesRef.current = sessionMessages;
  }, [sessionMessages]);

  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  // 后端已经只回可选库；这里再兜一层，防止旧缓存里带出下架/无权限的库
  const kbList: KbView[] = (kbs.data ?? []).filter((kb) => !kb.status || kb.status === 'active');
  const chatModels = useMemo(() => userSelectableModels(models.data ?? []), [models.data]);

  const sessionList: ConversationView[] = sessions.data ?? [];
  const activeSession = useMemo(
    () => sessionList.find((session) => session.id === activeId) ?? null,
    [activeId, sessionList],
  );
  const selectedKbIds = useMemo(() => {
    const raw = activeSession ? parseKbIds(activeSession.kbIds) : pendingKbIds;
    // 会话里可能还记着后来被下架/删除的库：只保留当前可用的，避免带着会 400 的库去提问
    const available = new Set(kbList.map((kb) => kb.id));
    return available.size === 0 ? raw : raw.filter((id) => available.has(id));
  }, [activeSession, kbList, pendingKbIds]);
  const selectedModel = activeSession?.model?.trim() ? activeSession.model : null;

  useEffect(() => {
    if (!activeId && sessionList.length > 0 && !streaming) {
      setActiveId(sessionList[0].id);
    }
  }, [activeId, sessionList, streaming]);

  // 退出登录后把本地状态清干净，避免下一个用户看到上一个人的会话与消息
  useEffect(() => {
    if (signedIn) {
      return;
    }
    streamsRef.current.forEach((stream) => stream.controller.abort());
    streamsRef.current.clear();
    loadedSessionRef.current = new Set();
    setActiveId(null);
    setSessionMessages({});
    setStreamingBySession({});
    setPendingKbIds([]);
    setBranchPoint(null);
    setDraft('');
    setCitationState({ open: false, citations: [] });
    queryClient.removeQueries({ queryKey: ['chat-sessions'] });
    queryClient.removeQueries({ queryKey: ['portal-kbs'] });
    queryClient.removeQueries({ queryKey: ['chat-usage'] });
  }, [queryClient, signedIn]);

  useEffect(() => {
    if (!activeId || loadedSessionRef.current.has(activeId)) {
      return;
    }
    // 这条会话正在本地流式输出：以本地为准，别用服务端的半截状态覆盖掉。
    if (streamsRef.current.has(activeId)) {
      return;
    }
    loadedSessionRef.current.add(activeId);
    api.chat
      .listMessages(activeId)
      .then((items) => setMessagesFor(activeId, () => items.map(toUiMessage)))
      .catch(() => setMessagesFor(activeId, () => []));
  }, [activeId, api.chat, setMessagesFor]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    // 只在用户本来就贴着底部时才跟随；否则（比如往回翻历史）不去抢滚动条，
    // 改成右下角出现"回到底部"按钮，避免输出时滚动条来回闪。
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 120) {
      el.scrollTop = el.scrollHeight;
    } else {
      setAtBottom(false);
    }
  }, [messages]);

  /**
   * 切换会话后直接落到最新一条。
   * messages 的 effect 会等渲染完成才跑，切换瞬间 el 还是旧高度，所以这里下一帧再补一次，
   * 否则从长会话切到新会话会停在顶部。
   */
  useEffect(() => {
    if (!activeId) {
      return;
    }
    const jump = () => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      el.scrollTop = el.scrollHeight;
      setAtBottom(true);
    };
    jump();
    const frame = requestAnimationFrame(jump);
    const timer = setTimeout(jump, 120);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [activeId]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      setAtBottom(true);
    }
  };

  const refreshSessions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
  }, [queryClient]);

  const patchSession = useCallback(
    async (patch: { title?: string; model?: string | null; kbIds?: string[] }) => {
      if (!activeId) {
        return;
      }
      try {
        await api.chat.updateSession(activeId, {
          title: patch.title,
          model: patch.model === null ? '' : patch.model,
          kbIds: patch.kbIds,
        });
        refreshSessions();
      } catch (error) {
        toast.error(friendlyError(error, '会话更新失败'));
      }
    },
    [activeId, api.chat, refreshSessions, toast],
  );

  const ensureSession = useCallback(
    async (kbIds: string[]): Promise<string | null> => {
      if (activeId) {
        return activeId;
      }
      try {
        const session = await api.chat.createSession({ kbIds });
        loadedSessionRef.current.add(session.id);
        setActiveId(session.id);
        // 把"新会话"桶里的消息搬到真实会话 id 下，用户不会看到消息闪一下。
        setSessionMessages((prev) => {
          const pending = prev[NEW_SESSION_KEY];
          if (!pending) {
            return prev;
          }
          const next = { ...prev, [session.id]: pending };
          delete next[NEW_SESSION_KEY];
          return next;
        });
        setPendingKbIds([]);
        refreshSessions();
        return session.id;
      } catch (error) {
        toast.error(friendlyError(error, '新建对话失败'));
        return null;
      }
    },
    [activeId, api.chat, refreshSessions, toast],
  );

  const runStream = useCallback(
    async (
      sessionId: string,
      runner: (handlers: { onEvent: (event: ChatStreamEvent) => void; signal: AbortSignal }) => Promise<void>,
      assistantLocalId: string,
    ) => {
      const controller = new AbortController();
      streamsRef.current.set(sessionId, { controller, localId: assistantLocalId, content: '' });
      setStreamingFor(sessionId, true);
      try {
        await runner({
          signal: controller.signal,
          onEvent: (event) => {
            // 人在回路：候选选项必须在事件回调里直接设，
            // 不能放进 setMessagesFor 的 updater（那里的 setState 会被丢弃）。
            if (event.event === 'status' && event.data?.stage === 'awaiting_user') {
              const payload = event.data as { question?: string; options?: string[] };
              const options = (Array.isArray(payload.options) ? payload.options : []).filter(Boolean);
              if (options.length >= 2) {
                setAskUser({
                  sessionId,
                  question: payload.question ?? '请补充更多信息',
                  options,
                });
              }
            }
            setMessagesFor(sessionId, (prev) =>
              prev.map((item) => {
                if (item.id !== assistantLocalId) {
                  return item;
                }
                if (event.event === 'token') {
                  const stream = streamsRef.current.get(sessionId);
                  if (stream) {
                    stream.content = item.content + event.data.delta;
                  }
                  return { ...item, content: item.content + event.data.delta };
                }
                if (event.event === 'status') {
                  const stage = event.data.stage;
                  const label = stage ? stageLabel(stage) : '';
                  const steps = item.steps ?? [];
                  // 同一个阶段只留一条：服务端落库的思考链也是去重的，刷新前后步数才不会跳动
                  if (label && !steps.includes(label)) {
                    return { ...item, stage: stage ?? item.stage, steps: [...steps, label] };
                  }
                  return { ...item, stage: stage ?? item.stage };
                }
                if (event.event === 'notice') {
                  // 后端主动说明（比如自动移除了不可用的知识库）：挂在消息上，顺手刷新库列表
                  void queryClient.invalidateQueries({ queryKey: ['portal-kbs'] });
                  const steps = item.steps ?? [];
                  return { ...item, steps: [...steps, event.data.message] };
                }
                if (event.event === 'tool') {
                  const name = (event.data as { name?: string }).name;
                  const steps = item.steps ?? [];
                  const label = `调用工具 ${name ?? '未知'}`;
                  return { ...item, steps: [...steps, label] };
                }
                if (event.event === 'citation') {
                  return { ...item, citations: [...item.citations, event.data] };
                }
                if (event.event === 'error') {
                  // 流中途报错（知识库停用、模型不可用等）：把后端原因显示在这条回答上，
                  // 而不是让气泡停在"正在生成"或只弹一个 toast。
                  const detail = (event.data as { message?: string }).message;
                  return {
                    ...item,
                    status: 'failed',
                    error: friendlyError(new Error(detail ?? ''), '生成失败，请重试'),
                  };
                }
                if (event.event === 'start' && event.data.messageId) {
                  // 只记 serverId，不改本地 id：改了之后下面所有 token/status 都匹配不上，
                  // 界面就不会再逐字更新，只能等最后整体刷新才看到答案。
                  const stream = streamsRef.current.get(sessionId);
                  if (stream) {
                    stream.serverId = event.data.messageId;
                  }
                  return { ...item, serverId: event.data.messageId };
                }
                if (event.event === 'done') {
                  return {
                    ...item,
                    status: (event.data.stopped ? 'stopped' : 'completed') as UiMessage['status'],
                    usage: event.data.usage ?? item.usage,
                    serverId: event.data.messageId ?? item.serverId,
                  };
                }
                return item;
              }),
            );
          },
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'ABORTED') {
          setMessagesFor(sessionId, (prev) =>
            prev.map((item) => (item.id === assistantLocalId ? { ...item, status: 'stopped' } : item)),
          );
        } else {
          const text = friendlyError(error, '生成失败，请重试');
          setMessagesFor(sessionId, (prev) =>
            prev.map((item) =>
              item.id === assistantLocalId ? { ...item, status: 'failed', error: text } : item,
            ),
          );
        }
      } finally {
        const current = streamsRef.current.get(sessionId);
        const superseded = current !== undefined && current.controller !== controller;
        if (current?.controller === controller) {
          streamsRef.current.delete(sessionId);
          setStreamingFor(sessionId, false);
        }
        void queryClient.invalidateQueries({ queryKey: ['chat-usage'] });
        refreshSessions();
        // 已经有新的一条流在跑（"打断并发送"）：这段收尾是旧流的，绝不能再去合并
        // 服务端消息，否则会把刚发出的新消息/新回答覆盖成空白。
        if (superseded) {
          return;
        }
        // 中断后服务端落库有延迟：等一拍再拉，避免把本地"已停止"覆盖成"正在检索"。
        if (controller.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
        if (streamsRef.current.has(sessionId)) {
          return;
        }
        try {
          const items = await api.chat.listMessages(sessionId);
          if (controller.signal.aborted) {
            // 容器可能还没感知到断连：对仍是 streaming 的这条补一次停止（顺带把内容写库）。
            const streamingItem = items.find(
              (item) => item.role === 'assistant' && item.status === 'streaming',
            );
            if (streamingItem) {
              await api.chat
                .stopMessage(sessionId, streamingItem.id, streamingItem.content ?? '')
                .catch(() => undefined);
              const refreshed = await api.chat.listMessages(sessionId);
              setMessagesFor(sessionId, (prev) => mergeAfterStream(prev, refreshed.map(toUiMessage)));
              return;
            }
          }
          setMessagesFor(sessionId, (prev) => mergeAfterStream(prev, items.map(toUiMessage)));
        } catch {
          // 保留本地状态
        }
      }
    },
    [api.chat, queryClient, refreshSessions, setMessagesFor, setStreamingFor],
  );

  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? draft).trim();
      if (!text) {
        return;
      }
      // 用户已经补充了信息：旧的反问卡片不该再挂在输入框上方
      setAskUser(null);
      // 同一会话只允许一条流在跑：正在回答时再发就排队，避免两条回答同时生成、
      // 也避免"停止"只能停掉最后一条。
      if (streamsRef.current.has(activeKeyRef.current)) {
        const entry = { sessionKey: activeKeyRef.current, text };
        setQueued(entry);
        queuedRef.current = entry;
        setDraft('');
        toast.info('当前回答还没结束，已排队；也可以点「打断并发送」');
        return;
      }
      if (!ensureSignedIn('登录后即可提问')) {
        return;
      }
      const sessionId = await ensureSession(selectedKbIds);
      if (!sessionId) {
        return;
      }

      const userLocalId = newId();
      const assistantLocalId = newId();
      const parentMessageId = branchPoint?.id ?? null;
      setDraft('');
      setBranchPoint(null);
      setMessagesFor(sessionId, (prev) => [
        ...prev,
        {
          id: userLocalId,
          role: 'user',
          content: text,
          status: 'completed',
          citations: [],
          // 记下"这次实际用的模型与库"：编辑重答时默认回到这套条件
          model: selectedModel,
          kbIds: selectedKbIds,
        },
        { id: assistantLocalId, role: 'assistant', content: '', status: 'streaming', citations: [] },
      ]);

      await runStream(
        sessionId,
        (handlers) => api.chat.streamMessage(sessionId, text, handlers, parentMessageId),
        assistantLocalId,
      );
    },
    [api.chat, branchPoint, draft, ensureSession, ensureSignedIn, runStream, selectedKbIds, setMessagesFor, toast],
  );

  const stop = useCallback(() => {
    const key = activeKeyRef.current;
    const stream = streamsRef.current.get(key);
    if (!stream) {
      return;
    }
    // 先把界面上那条"正在检索"就地改成已停止，用户点完立即有反馈，
    // 服务端落库结果稍后才合并回来。
    const pending = (sessionMessagesRef.current[key] ?? []).find(
      (item) => item.id === stream.localId && item.role === 'assistant',
    );
    setMessagesFor(key, (prev) =>
      prev.map((item) =>
        item.id === stream.localId
          ? { ...item, status: 'stopped' as const, content: item.content }
          : item,
      ),
    );
    setStreamingFor(key, false);
    streamsRef.current.delete(key);
    stream.controller.abort();
    // 不依赖浏览器断连被容器及时感知：直接告诉后端"这条停了"，并把已展示的内容一起带上。
    const serverId = stream.serverId ?? pending?.serverId;
    const content = pending?.content ?? stream.content;
    if (serverId && key !== NEW_SESSION_KEY) {
      void api.chat.stopMessage(key, serverId, content).catch(() => undefined);
    }
  }, [api.chat, setMessagesFor, setStreamingFor]);

  /**
   * 正在回答时再发一条：让用户自己决定"打断重问"还是"排队等说完"。
   * 打断会先停掉当前这条（落库为 stopped），再作为新提问追加在后面。
   */
  const steer = useCallback(
    async (mode: 'interrupt' | 'queue') => {
      const text = draft.trim();
      if (!text) {
        return;
      }
      if (!ensureSignedIn('登录后即可提问')) {
        return;
      }
      if (mode === 'queue') {
        const entry = { sessionKey: activeKeyRef.current, text };
        setQueued(entry);
        queuedRef.current = entry;
        setDraft('');
        toast.info('已排队：这条答完会自动发送');
        return;
      }
      setDraft('');
      stop();
      // 等当前流真正结束（streaming 变 false）再发，避免两条回答交叠。
      for (let i = 0; i < 40 && streamsRef.current.has(activeKeyRef.current); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await send(text);
    },
    [draft, ensureSignedIn, send, stop, toast],
  );

  // 排队的问题在「它自己那个会话」的回答结束后自动发送；
  // 切到别的会话不能把它带过去。
  useEffect(() => {
    if (!queued || queued.sessionKey !== activeKey) {
      return;
    }
    if (streamsRef.current.has(queued.sessionKey)) {
      return;
    }
    const text = queued.text;
    setQueued(null);
    queuedRef.current = null;
    void send(text);
  }, [activeKey, queued, send]);

  /**
   * 在这条下面重新生成 / 继续生成时，如果后面还有消息，先讲清楚会发生什么。
   * 返回 false 表示用户选择取消。
   */
  const confirmRewrite = useCallback(async (target: UiMessage): Promise<boolean> => {
    const list = sessionMessagesRef.current[activeKeyRef.current] ?? [];
    const index = list.findIndex((item) => item.id === target.id);
    const below = index >= 0 ? list.length - index - 1 : 0;
    if (below <= 0) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: '这条后面还有对话',
        content: `这条之后还有 ${below} 条消息，重新生成会用新的回答替换掉它们（上面的内容不受影响）。`,
        okText: '继续',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }, []);

  /**
   * 重新生成用哪个模型：输入框里选了的就用它（并写回会话，后续都按它走），
   * 没选就沿用这条回答原本的模型。
   */
  const applyModelForRewrite = useCallback(
    async (target: UiMessage) => {
      const model = selectedModel ?? target.usage?.model ?? null;
      if (model && activeSession && activeSession.model !== model) {
        await patchSession({ model });
      }
    },
    [activeSession, patchSession, selectedModel],
  );

  const retry = useCallback(
    async (target: UiMessage) => {
      if (!activeId || !target.serverId) {
        return;
      }
      if (!ensureSignedIn('登录后即可重新生成')) {
        return;
      }
      if (!(await confirmRewrite(target))) {
        return;
      }
      await applyModelForRewrite(target);
      const assistantLocalId = newId();
      setMessages((prev) => {
        const index = prev.findIndex((item) => item.id === target.id);
        const kept = index >= 0 ? prev.slice(0, index) : prev;
        return [
          ...kept,
          { id: assistantLocalId, role: 'assistant', content: '', status: 'streaming', citations: [] },
        ];
      });
      await runStream(
        activeId,
        (handlers) => api.chat.retryMessage(activeId, target.serverId as string, handlers),
        assistantLocalId,
      );
    },
    [activeId, api.chat, applyModelForRewrite, confirmRewrite, ensureSignedIn, runStream],
  );

  const editAndResend = useCallback(
    async (
      target: UiMessage,
      content: string,
      options: { model: string | null; kbIds: string[] },
    ) => {
      if (!activeId || !target.serverId || !content) {
        return;
      }
      if (!ensureSignedIn('登录后即可重新回答')) {
        return;
      }
      if (!(await confirmRewrite(target))) {
        return;
      }
      const assistantLocalId = newId();
      setMessages((prev) => {
        const index = prev.findIndex((item) => item.id === target.id);
        const kept = index >= 0 ? prev.slice(0, index) : prev;
        return [
          ...kept,
          { ...target, content, model: options.model, kbIds: options.kbIds },
          { id: assistantLocalId, role: 'assistant', content: '', status: 'streaming', citations: [] },
        ];
      });
      await runStream(
        activeId,
        (handlers) =>
          api.chat.editMessage(activeId, target.serverId as string, content, handlers, {
            model: options.model,
            kbIds: options.kbIds,
          }),
        assistantLocalId,
      );
    },
    [activeId, api.chat, confirmRewrite, ensureSignedIn, runStream],
  );

  /**
   * 断点续传：保留已产出的内容，让模型从这里接着写（服务端沿用同一条消息）。
   */
  const resumeMessage = useCallback(
    async (target: UiMessage) => {
      if (!activeId || !target.serverId) {
        return;
      }
      if (!ensureSignedIn('登录后即可继续生成')) {
        return;
      }
      if (!(await confirmRewrite(target))) {
        return;
      }
      setMessages((prev) =>
        prev.map((item) =>
          item.id === target.id ? { ...item, status: 'streaming' as const, error: undefined } : item,
        ),
      );
      await runStream(
        activeId,
        (handlers) => api.chat.resumeMessage(activeId, target.serverId as string, handlers),
        target.id,
      );
    },
    [activeId, api.chat, confirmRewrite, ensureSignedIn, runStream],
  );

  /**
   * 时间旅行：只标记锚点并把问题放回输入框。
   * 不立即删除后面的消息——否则用户点一下历史，画面就"空了"，非常吓人。
   */
  const markBranchPoint = useCallback(
    (target: UiMessage) => {
      if (!activeId) {
        return;
      }
      setBranchPoint({ id: target.serverId ?? target.id, question: target.content });
      setDraft(target.content);
      toast.info('已回到这条提问，可以修改后直接发送');
    },
    [activeId, toast],
  );

  const feedback = useCallback(
    async (target: UiMessage, rating: 'up' | 'down', comment?: string) => {
      if (!target.serverId) {
        toast.warning('回答尚未保存完成，请稍后再反馈');
        return;
      }
      try {
        await api.chat.feedback(target.serverId, { rating, comment });
        setMessages((prev) =>
          prev.map((item) => (item.id === target.id ? { ...item, feedback: rating } : item)),
        );
        toast.success('感谢反馈');
      } catch (error) {
        toast.error(friendlyError(error, '反馈没提交成功'));
      }
    },
    [api.chat, toast],
  );

  const openCitations = useCallback((citations: ChatCitation[]) => {
    setCitationState({ open: true, citations });
  }, []);

  const createConversation = useCallback(async () => {
    if (!ensureSignedIn('登录后即可创建对话')) {
      return;
    }
    try {
      const session = await api.chat.createSession({ kbIds: selectedKbIds });
      loadedSessionRef.current.add(session.id);
      setActiveId(session.id);
      setBranchPoint(null);
      refreshSessions();
    } catch (error) {
      toast.error(friendlyError(error, '新建对话失败'));
    }
  }, [api.chat, ensureSignedIn, refreshSessions, selectedKbIds, toast]);

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await api.chat.deleteSession(id);
        // 正在为这条会话生成时先停掉，否则它还会往已经删掉的会话里写。
        const stream = streamsRef.current.get(id);
        if (stream) {
          stream.controller.abort();
          streamsRef.current.delete(id);
          setStreamingFor(id, false);
        }
        loadedSessionRef.current.delete(id);
        setSessionMessages((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        if (id === activeId) {
          setActiveId(null);
          setBranchPoint(null);
        }
        refreshSessions();
        toast.success('已删除对话');
      } catch (error) {
        toast.error(friendlyError(error, '删除失败'));
      }
    },
    [activeId, api.chat, refreshSessions, setStreamingFor, toast],
  );

  const quota: ChatUsageQuota | undefined = usage.data;

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        overflow: 'hidden',
        background: token.colorBgLayout,
      }}
    >
      {/*
        自己管理侧栏，而不是套 antd 的 Layout.Sider：
        Sider 内部多一层 .ant-layout-sider-children，收起状态下不会跟着缩，
        会话一多列表就会被撑出屏幕且滚不动。
      */}
      <aside
        className="kh-portal-sider"
        style={{
          flex: `0 0 ${collapsed ? COLLAPSED_WIDTH : SIDER_WIDTH}px`,
          width: collapsed ? COLLAPSED_WIDTH : SIDER_WIDTH,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          padding: '12px 8px',
          height: '100vh',
          minHeight: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width .2s, flex-basis .2s',
        }}
      >
        <SessionSidebar
          sessions={sessionList}
          activeId={activeId}
          collapsed={collapsed}
          onCreate={() => void createConversation()}
          onSelect={(id) => {
            // 只是切换视图：在跑的流继续写它自己的会话，不会串到当前会话，
            // 也不会因为切走就把"停止"弄丢。
            setActiveId(id);
            setBranchPoint(null);
          }}
          onRename={(id, title) => {
            if (id === activeId) {
              void patchSession({ title });
            } else {
              void api.chat.updateSession(id, { title }).then(refreshSessions);
            }
          }}
          onDelete={deleteSession}
        />
      </aside>

      <div style={{ flex: 1, minWidth: 0, height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Layout.Header
          style={{
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            height: 56,
            lineHeight: '56px',
            flex: '0 0 56px',
          }}
        >
          <Space size={10}>
            <Button
              type="text"
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={toggleSider}
            />
            <Space size={6} style={{ color: token.colorTextTertiary }}>
              <BookOutlined style={{ fontSize: 15, color: token.colorPrimary }} />
              <Typography.Text style={{ fontSize: 13.5, color: token.colorTextSecondary }}>
                Knowledge Hub
              </Typography.Text>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              /
            </Typography.Text>
            <Typography.Text strong style={{ fontSize: 14 }}>
              {activeSession?.title?.trim() || '新对话'}
            </Typography.Text>
          </Space>

          <Dropdown
            trigger={['click']}
            menu={{
              items: signedIn
                ? [
                    {
                      key: 'who',
                      label: (
                        <div style={{ display: 'grid', gap: 0, lineHeight: 1.4 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>
                            {user?.displayName || user?.username || '已登录'}
                          </span>
                          <span style={{ fontSize: 11.5, color: '#8c8c8c' }}>
                            {user?.username ?? ''}
                            {user?.tenantId ? ` · 租户 ${user.tenantId}` : ''}
                          </span>
                        </div>
                      ),
                      disabled: true,
                    },
                    { type: 'divider' as const },
                    { key: 'usage', label: '我的用量与额度', onClick: () => setUsageOpen(true) },
                    {
                      key: 'logout',
                      icon: <LogoutOutlined />,
                      label: '退出登录',
                      onClick: logout,
                    },
                  ]
                : [{ key: 'login', label: '登录 / 注册', onClick: () => openAuth('登录后即可提问') }],
            }}
          >
            <Space size={6} style={{ cursor: 'pointer' }}>
              <Avatar
                size={26}
                icon={<UserOutlined />}
                style={{ background: token.colorPrimaryBg, color: token.colorPrimary }}
              />
              <Typography.Text style={{ fontSize: 13 }}>
                {user?.displayName || user?.username || '未登录'}
              </Typography.Text>
              <DownOutlined style={{ fontSize: 10, color: token.colorTextTertiary }} />
            </Space>
          </Dropdown>
        </Layout.Header>

        <Layout.Content
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '20px 0 8px' }}
          >
            <div style={{ maxWidth: 820, margin: '0 auto', padding: '0 20px' }}>
              {messages.length === 0 ? (
                <WelcomePanel
                  signedIn={signedIn}
                  suggestions={suggestions.data?.items ?? []}
                  onPick={(text) => void send(text)}
                  onLogin={() => openAuth('登录后即可提问')}
                />
              ) : (
                <div style={{ display: 'grid', gap: 18 }}>
                  {messages.map((item, index) => (
                    <MessageBubble
                      key={item.id}
                      message={item}
                      hasFollowing={index < messages.length - 1}
                      canOperate={!streaming || item.status !== 'streaming'}
                      onOpenCitations={openCitations}
                      onFeedback={feedback}
                      onRetry={retry}
                onQuickReply={(text) => void send(text)}
                      onEdit={editAndResend}
                      onResume={resumeMessage}
                      onCheckpoint={item.role === 'user' ? markBranchPoint : undefined}
                      editContext={
                        item.role === 'user'
                          ? {
                              models: chatModels.map((model) => ({
                                id: model.id,
                                label: modelLabelOf(model.id),
                              })),
                              kbs: kbList.map((kb) => ({ id: kb.id, name: kb.name })),
                              defaultModel: defaultModelOf(chatModels) || null,
                              defaultKbIds: item.kbIds ?? selectedKbIds,
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {!atBottom && messages.length > 0 ? (
            <Tooltip title="回到底部">
              <Button
                shape="circle"
                aria-label="回到底部"
                icon={<ArrowDownOutlined />}
                onClick={scrollToBottom}
                style={{
                  position: 'absolute',
                  right: 24,
                  bottom: 132,
                  boxShadow: token.boxShadowSecondary,
                  zIndex: 5,
                }}
              />
            </Tooltip>
          ) : null}

          <div style={{ flex: '0 0 auto', padding: '8px 0 14px' }}>
            <div style={{ maxWidth: 820, margin: '0 auto', padding: '0 20px' }}>
              {branchPoint ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 8,
                    padding: '6px 10px',
                    borderRadius: token.borderRadius,
                    background: token.colorWarningBg,
                    border: `1px solid ${token.colorWarningBorder}`,
                    fontSize: 12.5,
                  }}
                >
                  <span>在「{branchPoint.question.slice(0, 24)}」之后继续，新回答会替换后面的内容。</span>
                  <Button size="small" type="text" onClick={() => setBranchPoint(null)}>
                    取消
                  </Button>
                </div>
              ) : null}
              {queued && queued.sessionKey !== activeKey ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 8,
                    padding: '6px 10px',
                    borderRadius: token.borderRadius,
                    background: token.colorFillQuaternary,
                    border: `1px dashed ${token.colorBorder}`,
                    fontSize: 12.5,
                    color: token.colorTextSecondary,
                  }}
                >
                  <span>另一个会话还有一条排队的提问：{queued.text.slice(0, 24)}{queued.text.length > 24 ? '…' : ''}（回到那个会话才会发送）</span>
                  <Button
                    size="small"
                    type="text"
                    onClick={() => {
                      setQueued(null);
                      queuedRef.current = null;
                    }}
                  >
                    放弃
                  </Button>
                </div>
              ) : null}
              {/* 反问卡片跟着"它属于哪个对话"走：切到别的对话不显示，切回来还能接着点 */}
              {askUser && askUser.sessionId === activeKey ? (
                <div
                  style={{
                    marginBottom: 8,
                    padding: '10px 12px',
                    borderRadius: token.borderRadiusLG,
                    background: token.colorInfoBg,
                    border: `1px solid ${token.colorInfoBorder}`,
                  }}
                >
                  <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
                    <Typography.Text style={{ fontSize: 13 }}>{askUser.question}</Typography.Text>
                    <Button size="small" type="text" onClick={() => setAskUser(null)}>
                      忽略
                    </Button>
                  </Space>
                  {askUser.options.length > 0 ? (
                    <Space size={6} wrap style={{ marginTop: 8 }}>
                      {askUser.options.map((option) => (
                        <Button
                          key={option}
                          size="small"
                          onClick={() => {
                            setAskUser(null);
                            void send(option);
                          }}
                        >
                          {option}
                        </Button>
                      ))}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      直接在下面输入框补充信息即可（已尝试自动生成候选，本次未能生成）。
                    </Typography.Text>
                  )}
                </div>
              ) : null}
              {queued && queued.sessionKey === activeKey ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 8,
                    padding: '6px 10px',
                    borderRadius: token.borderRadius,
                    background: token.colorInfoBg,
                    border: `1px solid ${token.colorInfoBorder}`,
                    fontSize: 12.5,
                  }}
                >
                  <span>
                    已排队：{queued.text.slice(0, 28)}
                    {queued.text.length > 28 ? '…' : ''}（这条答完自动发送）
                  </span>
                  <Space size={4}>
                    <Button
                      size="small"
                      type="text"
                      onClick={() => {
                        setDraft(queued.text);
                        setQueued(null);
                        queuedRef.current = null;
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      onClick={() => {
                        setQueued(null);
                        queuedRef.current = null;
                      }}
                    >
                      取消
                    </Button>
                  </Space>
                </div>
              ) : null}
              <Composer
                value={draft}
                onChange={setDraft}
                onSend={() => void send()}
                onStop={stop}
                onSteer={(mode) => void steer(mode)}
                streaming={streaming}
                kbs={kbList}
                selectedKbIds={selectedKbIds}
                onKbChange={(ids) => {
                  if (!activeId) {
                    setPendingKbIds(ids);
                    return;
                  }
                  void patchSession({ kbIds: ids });
                }}
                models={chatModels}
                selectedModel={selectedModel}
                onModelChange={(model) => {
                  if (!activeId) {
                    void ensureSession(selectedKbIds).then((id) => {
                      if (id) {
                        void api.chat.updateSession(id, { model: model ?? '' }).then(refreshSessions);
                      }
                    });
                    return;
                  }
                  void patchSession({ model });
                }}
                needLogin={!signedIn}
              />
              <Typography.Text
                type="secondary"
                style={{ fontSize: 11.5, display: 'block', textAlign: 'center', marginTop: 6 }}
              >
                {selectedKbIds.length > 0
                  ? '回答仅基于你选中的知识库，引用可点开核对原文。'
                  : '没有指定知识库：需要内部资料时我会自动检索，闲聊就不会去查库。'}
              </Typography.Text>
            </div>
          </div>
        </Layout.Content>
      </div>

      <CitationPanel
        open={citationState.open}
        onClose={() => setCitationState({ open: false, citations: [] })}
        citations={citationState.citations}
        title={`引用来源（${citationState.citations.length}）`}
      />

      <Modal
        open={usageOpen}
        onCancel={() => setUsageOpen(false)}
        footer={null}
        title={
          <Space size={10}>
            <span>我的用量与额度</span>
            <Button
              size="small"
              type="link"
              loading={usage.isFetching}
              onClick={() => void usage.refetch()}
            >
              刷新
            </Button>
          </Space>
        }
        width={420}
      >
        {quota ? (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              统计周期：{quota.period}（每月 1 日重置）。额度由管理员配置，0 表示不限。
              {usage.dataUpdatedAt
                ? ` 数据更新于 ${new Date(usage.dataUpdatedAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}，打开本窗口时每 30 秒自动刷新。`
                : ''}
            </Typography.Text>
            <div>
              <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                <Typography.Text>本月 Tokens</Typography.Text>
                <Typography.Text strong>
                  {quota.tokensUsed.toLocaleString()}
                  {quota.tokenQuota > 0 ? ` / ${quota.tokenQuota.toLocaleString()}` : '（不限）'}
                </Typography.Text>
              </Space>
              {quota.tokenQuota > 0 ? (
                <Progress
                  percent={visiblePercent(quota.tokensUsed, quota.tokenQuota)}
                  format={() => `${tokenShare(quota.tokensUsed, quota.tokenQuota)}`}
                  strokeColor={quota.tokensUsed / quota.tokenQuota > 0.85 ? token.colorError : token.colorPrimary}
                />
              ) : null}
            </div>
            <div>
              <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                <Typography.Text>本月回答数</Typography.Text>
                <Typography.Text strong>
                  {quota.messagesUsed}
                  {quota.messageQuota > 0 ? ` / ${quota.messageQuota}` : '（不限）'}
                </Typography.Text>
              </Space>
              {quota.messageQuota > 0 ? (
                <Progress
                  percent={Math.min(100, Math.round((quota.messagesUsed / quota.messageQuota) * 100))}
                  showInfo={false}
                  strokeColor={token.colorPrimary}
                />
              ) : null}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              本月提问 {quota.questionsThisMonth} 次
              {quota.tokenQuota > 0 ? `，剩余 ${quota.tokensRemaining.toLocaleString()} tokens` : ''}。
              额度用完时发送会被拒绝，需要管理员调整。
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">用量加载中…</Typography.Text>
        )}
      </Modal>
    </div>
  );
}

function WelcomePanel({
  signedIn,
  suggestions,
  onPick,
  onLogin,
}: {
  signedIn: boolean;
  suggestions: string[];
  onPick: (text: string) => void;
  onLogin: () => void;
}) {
  const { token } = theme.useToken();
  const examples = (suggestions.length > 0 ? suggestions : FALLBACK_SUGGESTIONS).slice(0, MAX_SUGGESTIONS);

  return (
    <div style={{ paddingTop: 48, textAlign: 'center' }}>
      <Typography.Title level={3} style={{ marginBottom: 6, fontWeight: 600 }}>
        Knowledge Hub
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 22 }}>
        {signedIn ? '选中知识库后提问，回答都会给出可核对的出处' : '登录后即可提问，回答都会给出可核对的出处'}
      </Typography.Paragraph>

      {!signedIn ? (
        <Button type="primary" size="large" onClick={onLogin}>
          登录 / 注册
        </Button>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 10,
            maxWidth: 620,
            margin: '0 auto',
          }}
        >
          {examples.map((text, index) => (
            <button
              key={text}
              type="button"
              onClick={() => onPick(text)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: token.borderRadiusLG,
                padding: '12px 14px',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 13.5,
                lineHeight: 1.55,
                background: token.colorBgContainer,
                color: token.colorText,
                transition: 'border-color .15s, box-shadow .15s',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.borderColor = token.colorPrimaryBorder;
                event.currentTarget.style.boxShadow = token.boxShadowTertiary;
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.borderColor = token.colorBorderSecondary;
                event.currentTarget.style.boxShadow = 'none';
              }}
            >
              <span
                style={{
                  flex: '0 0 auto',
                  width: 20,
                  height: 20,
                  borderRadius: 6,
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                  color: token.colorPrimary,
                  background: token.colorPrimaryBg,
                  marginTop: 1,
                }}
              >
                {index + 1}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function QuotaInline({ quota }: { quota?: ChatUsageQuota }) {
  const { token } = theme.useToken();
  if (!quota || quota.unlimited || quota.tokenQuota <= 0) {
    return null;
  }
  const percent = visiblePercent(quota.tokensUsed, quota.tokenQuota);
  return (
    <Space size={6}>
      <Progress
        type="circle"
        percent={percent}
        size={18}
        showInfo={false}
        strokeColor={percent > 85 ? token.colorError : token.colorPrimary}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        剩余 {quota.tokensRemaining.toLocaleString()}
      </Typography.Text>
    </Space>
  );
}
