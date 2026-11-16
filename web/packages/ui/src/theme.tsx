'use client';

import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * 品牌色与圆角在整个平台统一，Portal 与 Admin 共用。
 * 注意：不要在这里写 light 专属的表面色（如 colorBgLayout/colorBgContainer），
 * 它会覆盖 darkAlgorithm 的计算结果，导致深色模式下部分区块仍是浅底浅字。
 */
export const brandTokens = {
  colorPrimary: '#1f6feb',
  colorInfo: '#1f6feb',
  colorSuccess: '#1f9d55',
  colorWarning: '#d9822b',
  colorError: '#d64545',
  borderRadius: 8,
  borderRadiusLG: 12,
  fontSize: 14,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif",
  wireframe: false,
} as const;

export type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'kh.theme-mode';

/**
 * 组件级 token 必须跟随算法重算：写死 `#ffffff` 会让深色模式下顶栏保持白底，
 * 面包屑（浅色文字）随之消失在白底上。
 */
function buildComponentTokens(mode: ThemeMode) {
  const token = antdTheme.getDesignToken({
    algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: { ...brandTokens },
  });
  return {
    Layout: {
      headerBg: token.colorBgContainer,
      siderBg: mode === 'dark' ? '#0b1220' : '#0d1b33',
      bodyBg: token.colorBgLayout,
      headerHeight: 56,
      headerPadding: '0 20px',
    },
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(31, 111, 235, 0.28)',
      darkItemHoverBg: 'rgba(255, 255, 255, 0.08)',
      itemBorderRadius: 8,
    },
    Card: {
      headerFontSize: 15,
    },
    Table: {
      headerBg: token.colorFillAlter,
      headerSplitColor: 'transparent',
    },
  };
}

/** 兼容导出：浅色模式下的组件 token；深色由 KhThemeProvider 内部按算法重算 */
export const componentTokens = buildComponentTokens('light');

interface ThemeModeContextValue {
  mode: ThemeMode;
  toggle: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: 'light',
  toggle: () => undefined,
});

export function useThemeMode(): ThemeModeContextValue {
  return useContext(ThemeModeContext);
}

export interface KhThemeProviderProps {
  children: ReactNode;
  mode?: ThemeMode;
}

/**
 * AntD 5 ConfigProvider 封装：统一 token、中文语言包与全局 message/notification 上下文。
 * 主题模式持久化在 localStorage，并同步到 `documentElement[data-theme]` 供全局样式使用。
 */
export function KhThemeProvider({ children, mode: initialMode = 'light' }: KhThemeProviderProps) {
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      setMode(stored);
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', mode);
    root.style.colorScheme = mode;
    if (restored) {
      globalThis.localStorage?.setItem(THEME_STORAGE_KEY, mode);
    }
  }, [mode, restored]);

  const value = useMemo<ThemeModeContextValue>(
    () => ({ mode, toggle: () => setMode((prev) => (prev === 'light' ? 'dark' : 'light')) }),
    [mode],
  );

  const components = useMemo(() => buildComponentTokens(mode), [mode]);

  return (
    <ThemeModeContext.Provider value={value}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: { ...brandTokens },
          components,
        }}
      >
        <AntdApp>{children}</AntdApp>
      </ConfigProvider>
    </ThemeModeContext.Provider>
  );
}
