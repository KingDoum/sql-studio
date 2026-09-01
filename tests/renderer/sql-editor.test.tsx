// @vitest-environment jsdom
/**
 * SqlEditor 组件测试（任务 9 + 阶段 2 注册时序）。
 * @monaco-editor/react 在 jsdom 无法完整加载，mock 为受控 textarea stub，
 * 并通过 hoisted 状态暴露 onMount/beforeMount 回调，供测试驱动 Monaco 挂载时序：
 *   - AI 配置先返回、Monaco 后挂载 → 仍注册 inline provider；
 *   - Monaco 先挂载、AI 配置后返回 → 仍注册；
 *   - StrictMode/重复同步不会留下两个活跃 provider（旧 provider/disposable 正确 dispose）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { StrictMode } from 'react';
import { SqlEditor } from '@renderer/components/SqlEditor';
import type { EditorTab } from '@shared/types';

/** hoisted：测试与 mock 工厂共享的挂载回调捕获器。 */
const editorMock = vi.hoisted(() => ({
  onMountCb: null as null | ((editor: unknown, monaco: unknown) => void),
  beforeMountCb: null as null | ((monaco: unknown) => void),
  // 捕获 <Editor theme=...> prop（验证 Monaco 主题映射）
  editorTheme: null as null | string,
}));

// mock @monaco-editor/react：受控 stub（vi.mock 会被 vitest 提升到顶部）
vi.mock('@monaco-editor/react', () => ({
  default: function MockEditor({
    value,
    onChange,
    onMount,
    beforeMount,
    theme,
  }: {
    value: string;
    onChange?: (v: string | undefined) => void;
    onMount?: (e: unknown, m: unknown) => void;
    beforeMount?: (m: unknown) => void;
    theme?: string;
  }) {
    if (onMount) editorMock.onMountCb = onMount;
    if (beforeMount) editorMock.beforeMountCb = beforeMount;
    if (theme) editorMock.editorTheme = theme;
    return (
      <textarea
        data-testid="monaco-stub"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      />
    );
  },
  loader: { config: vi.fn(), init: vi.fn() },
}));

const tab: EditorTab = {
  id: 't1',
  title: 'a.sql',
  sql: 'SELECT 1;',
  filePath: '/x/a.sql',
  isDirty: false,
};

const AI_CONFIG = {
  enabled: true,
  baseUrl: 'https://api.deepseek.com/beta',
  model: 'deepseek-v4-pro',
  apiKeyConfigured: true,
  protocol: 'deepseek-fim' as const,
  rateLimit: {
    debounceMs: 400,
    minRequestIntervalMs: 2500,
    rateLimitCooldownMs: 15_000,
    requestTimeoutMs: 12_000,
  },
};

/** 构造 fake Monaco（仅含 SqlEditor 用到的 API）。 */
function makeFakeMonaco() {
  const disposables: Array<{ dispose(): void }> = [];
  const monaco = {
    languages: {
      registerInlineCompletionsProvider: vi.fn(() => {
        const d = { dispose: vi.fn() };
        disposables.push(d);
        return d;
      }),
      registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
      setMonarchTokensProvider: vi.fn(),
    },
    editor: {
      defineTheme: vi.fn(),
      getModels: vi.fn(() => []),
    },
    KeyMod: { CtrlCmd: 1, Shift: 2 },
    KeyCode: { Enter: 3, KeyF: 4, KeyS: 5, Space: 6 },
  };
  return {
    monaco: monaco as unknown as Parameters<NonNullable<typeof editorMock.onMountCb>>[1],
    disposables,
    monacoImpl: monaco,
  };
}

/** 构造 fake editor（onMount 用到的 API）。 */
function makeFakeEditor() {
  return {
    updateOptions: vi.fn(),
    addAction: vi.fn(() => ({ dispose: vi.fn() })),
    focus: vi.fn(),
    trigger: vi.fn(),
    getModel: vi.fn(() => ({
      getValueInRange: vi.fn(() => ''),
      getValue: vi.fn(() => 'SELECT 1;'),
      getLineContent: vi.fn(() => ''),
      getLineCount: vi.fn(() => 1),
    })),
    getSelection: vi.fn(() => null),
    getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
    executeEdits: vi.fn(),
  } as unknown as Parameters<NonNullable<typeof editorMock.onMountCb>>[0];
}

function mockSqlStudio(overrides: Record<string, unknown> = {}) {
  (window as unknown as { sqlStudio?: unknown }).sqlStudio = {
    'schema:databases': vi.fn(async () => []),
    'schema:tables': vi.fn(async () => []),
    'schema:columns': vi.fn(async () => []),
    'settings:getAiConfig': vi.fn(async () => AI_CONFIG),
    ...overrides,
  };
  return window.sqlStudio as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

describe('SqlEditor', () => {
  beforeEach(() => {
    cleanup();
    editorMock.onMountCb = null;
    editorMock.beforeMountCb = null;
    mockSqlStudio();
  });

  it('渲染 stub 编辑器并回传内容变更', async () => {
    const onSqlChange = vi.fn();
    render(
      <SqlEditor
        tab={tab}
        connectionId={null}
        onSqlChange={onSqlChange}
        onExecute={() => {}}
      />,
    );
    const stub = await screen.findByTestId('monaco-stub');
    fireEvent.change(stub, { target: { value: 'SELECT 2;' } });
    expect(onSqlChange).toHaveBeenCalledWith('SELECT 2;');
  });

  it('未连接时工具栏提示「未连接」，执行按钮点击不崩溃', async () => {
    const onExecute = vi.fn();
    render(
      <SqlEditor
        tab={tab}
        connectionId={null}
        onSqlChange={() => {}}
        onExecute={onExecute}
      />,
    );
    expect(await screen.findByText('未连接')).toBeTruthy();
    fireEvent.click(screen.getByText('执行'));
  });

  it('工具栏含格式化与执行按钮', async () => {
    render(
      <SqlEditor
        tab={tab}
        connectionId={null}
        onSqlChange={() => {}}
        onExecute={() => {}}
      />,
    );
    expect(await screen.findByText('格式化')).toBeTruthy();
    expect(screen.getByText('执行')).toBeTruthy();
  });

  it('Monaco 主题三值映射：dark/light/titanium（阶段 E）', async () => {
    cleanup();
    editorMock.editorTheme = null;
    render(
      <SqlEditor
        tab={tab}
        connectionId={null}
        onSqlChange={() => {}}
        onExecute={() => {}}
        theme="titanium"
      />,
    );
    expect(await screen.findByTestId('monaco-stub')).toBeTruthy();
    expect(editorMock.editorTheme).toBe('sql-studio-titanium');
  });

  it('默认主题为深色映射 sql-studio-dark（不回归）', async () => {
    cleanup();
    editorMock.editorTheme = null;
    render(
      <SqlEditor
        tab={tab}
        connectionId={null}
        onSqlChange={() => {}}
        onExecute={() => {}}
      />,
    );
    expect(await screen.findByTestId('monaco-stub')).toBeTruthy();
    expect(editorMock.editorTheme).toBe('sql-studio-dark');
  });
});

describe('SqlEditor · AI provider 注册时序（阶段 2）', () => {
  beforeEach(() => {
    cleanup();
    editorMock.onMountCb = null;
    editorMock.beforeMountCb = null;
  });

  /** 渲染并等待 fetchAiConfig 完成（AI 配置先返回）。 */
  async function renderWithAiConfigLoaded() {
    mockSqlStudio();
    render(
      <SqlEditor
        tab={tab}
        connectionId={null}
        onSqlChange={() => {}}
        onExecute={() => {}}
        aiSettingsVersion={1}
      />,
    );
    // 等待配置加载 effect 完成（settings:getAiConfig resolve）
    await vi.waitFor(() => {
      const store = window.sqlStudio as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(store['settings:getAiConfig']).toHaveBeenCalled();
    });
    // flush 微任务
    await new Promise((r) => setTimeout(r, 0));
  }

  it('AI 配置先返回、Monaco 后挂载 → 仍注册 inline provider', async () => {
    await renderWithAiConfigLoaded();
    const { monaco, monacoImpl } = makeFakeMonaco();
    const editor = makeFakeEditor();
    // Monaco 在 AI 配置加载后才挂载
    editorMock.onMountCb?.(editor, monaco);
    expect(monacoImpl.languages.registerInlineCompletionsProvider).toHaveBeenCalledTimes(1);
  });

  it('Monaco 先挂载、AI 配置后返回 → 配置到达后仍注册', async () => {
    // settings:getAiConfig 挂起，模拟配置稍后返回
    let resolveConfig: ((v: unknown) => void) | undefined;
    mockSqlStudio({
      'settings:getAiConfig': vi.fn(() => new Promise((r) => { resolveConfig = r; })),
    });
    render(
      <SqlEditor
        tab={tab}
        connectionId={null}
        onSqlChange={() => {}}
        onExecute={() => {}}
        aiSettingsVersion={1}
      />,
    );
    // Monaco 先挂载（此时 AI 配置未返回）
    const { monaco, monacoImpl } = makeFakeMonaco();
    editorMock.onMountCb?.(makeFakeEditor(), monaco);
    // 配置未返回时至少注册一次（disabled 初始态）
    expect(monacoImpl.languages.registerInlineCompletionsProvider).toHaveBeenCalledTimes(1);
    // AI 配置后返回
    await vi.waitFor(() => expect(resolveConfig).toBeDefined());
    resolveConfig?.(AI_CONFIG);
    await vi.waitFor(() => {
      // 配置到达 → aiState 变化 → 重新注册（旧 provider dispose 后再注册新的）
      expect(monacoImpl.languages.registerInlineCompletionsProvider.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    // 旧 disposable 应已被 dispose（无重复活跃 provider）
    const disposables = (
      monacoImpl.languages.registerInlineCompletionsProvider.mock.results as Array<{
        value: { dispose: ReturnType<typeof vi.fn> };
      }>
    ).map((r) => r.value);
    expect(disposables[0].dispose).toHaveBeenCalled();
  });

  it('StrictMode 双重挂载不会留下两个活跃 provider（先 dispose 旧 provider）', async () => {
    await renderWithAiConfigLoaded();
    const { monaco, monacoImpl } = makeFakeMonaco();
    // StrictMode 下 onMount 双调用（React 18 dev 行为）
    editorMock.onMountCb?.(makeFakeEditor(), monaco);
    editorMock.onMountCb?.(makeFakeEditor(), monaco);
    const disposables = (
      monacoImpl.languages.registerInlineCompletionsProvider.mock.results as Array<{
        value: { dispose: ReturnType<typeof vi.fn> };
      }>
    ).map((r) => r.value);
    // onMount 幂等：每次都先 dispose 旧的再注册 → 只有最后一个活跃
    expect(disposables.length).toBeGreaterThanOrEqual(1);
    if (disposables.length > 1) {
      // 非最后一个全部被 dispose
      for (let i = 0; i < disposables.length - 1; i++) {
        expect(disposables[i].dispose).toHaveBeenCalled();
      }
      expect(disposables[disposables.length - 1].dispose).not.toHaveBeenCalled();
    }
  });
});