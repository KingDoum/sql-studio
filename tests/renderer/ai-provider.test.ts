/**
 * ai-provider.ts 单测（阶段 2：完整上下文 + 注册时序 + 可观测日志）。
 * 覆盖：禁用时不请求、防抖合并、限流后冷却、过期响应丢弃（含明确日志）、
 *      FIM 请求携带 suffix、prefix 为跨行完整文档、range 从光标位置开始、
 *      超时日志、API Key 不输出。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAiInlineProvider, fetchAiConfig } from '@renderer/lib/ai-provider';
import type { AiPublicConfig } from '@shared/types';

/** Renderer 拿到的配置是 AiPublicConfig（阶段 3：不含 apiKey，仅 apiKeyConfigured）。 */
const CONFIG: AiPublicConfig = {
  baseUrl: 'https://api.deepseek.com/beta',
  model: 'deepseek-v4-pro',
  apiKeyConfigured: true,
  enabled: true,
  protocol: 'deepseek-fim',
};

/** 构造 sqlStudio mock，记录 ai:complete 调用（含 suffix）。 */
function makeSqlStudioMock() {
  const calls: Array<{ prefix: string; suffix: string; maxTokens: number }> = [];
  let impl: (arg: { prefix: string; suffix: string }) => Promise<{ suggestion: string }> =
    async () => ({ suggestion: 'SELECT' });
  (window as unknown as Record<string, unknown>).sqlStudio = {
    'ai:complete': async (arg: { prefix: string; suffix: string; maxTokens: number }) => {
      calls.push(arg);
      return impl(arg);
    },
    'settings:getAiConfig': async () => CONFIG,
  };
  return {
    calls,
    setImpl: (f: (arg: { prefix: string; suffix: string }) => Promise<{ suggestion: string }>) => { impl = f; },
  };
}

/** 跨行文档 stub：getValueInRange 按行/列截取，getLineContent/getLineCount 提供末尾行信息。 */
function modelStub(doc: string, position: { lineNumber: number; column: number }) {
  const lines = doc.split('\n');
  return {
    getValueInRange: (r: { startLineNumber: number; endLineNumber: number; startColumn: number; endColumn: number }) => {
      const startLine = Math.max(1, r.startLineNumber);
      const endLine = Math.min(lines.length, r.endLineNumber);
      if (startLine > endLine) return '';
      const first = lines[startLine - 1].slice(r.startColumn - 1);
      if (startLine === endLine) {
        return first.slice(0, Math.max(0, r.endColumn - r.startColumn));
      }
      const middle = lines.slice(startLine, endLine - 1).join('\n');
      const last = lines[endLine - 1].slice(0, Math.max(0, r.endColumn - 1));
      return [first, middle, last].filter((s, i) => !(i === 1 && s === '') ).join('\n');
    },
    getLineContent: (line: number) => lines[line - 1] ?? '',
    getLineCount: () => lines.length,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createAiInlineProvider 上下文（阶段 2）', () => {
  it('禁用时不发请求', async () => {
    const mock = makeSqlStudioMock();
    const provider = createAiInlineProvider({ enabled: false, config: null });
    const res = await provider.provideInlineCompletions(
      modelStub('SELECT * FROM ', { lineNumber: 1, column: 16 }),
      { lineNumber: 1, column: 16 }, null, null,
    );
    expect(res.items).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
  });

  it('FIM 请求包含 suffix', async () => {
    const mock = makeSqlStudioMock();
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });
    // Monaco 语义：prefix 16 字符 → position.column = 17（endColumn 独占）
    const doc = 'SELECT * FROM us WHERE id';
    const position = { lineNumber: 1, column: 17 };
    const p = provider.provideInlineCompletions(
      modelStub(doc, position),
      position, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await p;
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].prefix).toBe('SELECT * FROM us');
    expect(mock.calls[0].suffix).toBe(' WHERE id');
  });

  it('prefix 为跨行完整文档（光标前全部内容，含换行）', async () => {
    const mock = makeSqlStudioMock();
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });
    const doc = 'SELECT a.id\nFROM users a\nWHERE a.name LIKE';
    // 光标在第三行 "WHERE a.name LIKE" 之后（col 20）
    const position = { lineNumber: 3, column: 20 };
    const p = provider.provideInlineCompletions(modelStub(doc, position), position, null, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await p;
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].prefix).toBe('SELECT a.id\nFROM users a\nWHERE a.name LIKE');
    expect(mock.calls[0].suffix).toBe(''); // 光标在文档末尾
  });

  it('光标在文档中间时 suffix 为光标到文档末尾', async () => {
    const mock = makeSqlStudioMock();
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });
    const doc = 'SELECT * FROM us WHERE id = 1;';
    const position = { lineNumber: 1, column: 17 };
    const p = provider.provideInlineCompletions(modelStub(doc, position), position, null, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await p;
    expect(mock.calls[0].prefix).toBe('SELECT * FROM us');
    expect(mock.calls[0].suffix).toBe(' WHERE id = 1;');
  });

  it('返回 suggestion 后 item 的 range 从光标位置开始（仅插入不替换）', async () => {
    const mock = makeSqlStudioMock();
    mock.setImpl(async () => ({ suggestion: 'ers' }));
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });
    const position = { lineNumber: 2, column: 8 };
    const p = provider.provideInlineCompletions(
      modelStub('SELECT * FROM us\n  WHERE', position),
      position, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    const res = await p;
    expect(res.items).toHaveLength(1);
    expect(res.items[0].insertText).toBe('ers');
    const range = res.items[0].range as { startLineNumber: number; startColumn: number; endColumn: number };
    expect(range.startLineNumber).toBe(2);
    expect(range.startColumn).toBe(8);
    expect(range.endColumn).toBe(8);
  });

  it('过期响应不会覆盖最新请求，且打明确丢弃日志', async () => {
    const mock = makeSqlStudioMock();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 控制 Date.now：让两次请求都通过最小请求间隔（≥2.5s）
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    let resolveFirst: ((v: { suggestion: string }) => void) | undefined;
    const firstWait = new Promise<{ suggestion: string }>((r) => { resolveFirst = r; });
    let n = 0;
    mock.setImpl(async () => {
      n += 1;
      if (n === 1) return firstWait; // 第一个请求挂起
      return { suggestion: '最新' };
    });
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });

    // 请求 1：发出后挂起
    const p1 = provider.provideInlineCompletions(
      modelStub('SELECT * FROM us', { lineNumber: 1, column: 16 }),
      { lineNumber: 1, column: 16 }, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    expect(mock.calls.length).toBe(1);

    // 时间前进 10s（≥ 最小请求间隔），请求 2 发出并立即返回
    nowSpy.mockReturnValue(20_000);
    const p2 = provider.provideInlineCompletions(
      modelStub('SELECT * FROM users', { lineNumber: 1, column: 20 }),
      { lineNumber: 1, column: 20 }, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    const r2 = await p2;
    expect(r2.items).toHaveLength(1);
    expect(r2.items[0].insertText).toBe('最新');

    // 旧请求此刻才返回 → 应被丢弃（seq 已过期），不覆盖最新请求
    resolveFirst?.({ suggestion: '旧响应' });
    await vi.advanceTimersByTimeAsync(0);
    const r1 = await p1;
    expect(r1.items).toHaveLength(0);
    // 最新请求结果未被旧响应污染
    expect(r2.items[0].insertText).toBe('最新');
    // 丢弃必须打明确日志（WARN 且含"已丢弃"），否则用户不知道是被丢弃
    expect(consoleWarn.mock.calls.some((c) => String(c[0]).includes('已丢弃'))).toBe(true);
    nowSpy.mockRestore();
  });
});

describe('createAiInlineProvider 限流保护', () => {
  it('防抖：两次快速输入只发一次请求（400ms 后合并）', async () => {
    const mock = makeSqlStudioMock();
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });
    const p1 = provider.provideInlineCompletions(
      modelStub('SELECT * FROM us', { lineNumber: 1, column: 18 }),
      { lineNumber: 1, column: 18 }, null, null,
    );
    await vi.advanceTimersByTimeAsync(150);
    const p2 = provider.provideInlineCompletions(
      modelStub('SELECT * FROM users', { lineNumber: 1, column: 20 }),
      { lineNumber: 1, column: 20 }, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await Promise.all([p1, p2]);
    expect(mock.calls.length).toBe(1);
  });

  it('限流(429)后进入冷却：冷却期内不再请求，且不刷错误日志', async () => {
    const mock = makeSqlStudioMock();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.setImpl(async () => { throw new Error('请求过于频繁，请稍后重试'); });
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });

    const p1 = provider.provideInlineCompletions(
      modelStub('SELECT * FROM us', { lineNumber: 1, column: 18 }),
      { lineNumber: 1, column: 18 }, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await p1;
    expect(mock.calls.length).toBe(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn.mock.calls.some((c) => String(c[0]).includes('限流'))).toBe(true);

    const p2 = provider.provideInlineCompletions(
      modelStub('SELECT * FROM us', { lineNumber: 1, column: 18 }),
      { lineNumber: 1, column: 18 }, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await p2;
    expect(mock.calls.length).toBe(1); // 冷却期没新增请求
  });

  it('冷却结束后恢复正常请求', async () => {
    const mock = makeSqlStudioMock();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    mock.setImpl(async () => {
      if (fail) throw new Error('请求过于频繁，请稍后重试');
      return { suggestion: 'SELECT' };
    });
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });

    const p1 = provider.provideInlineCompletions(
      modelStub('SELECT * FROM us', { lineNumber: 1, column: 18 }),
      { lineNumber: 1, column: 18 }, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await p1;
    expect(mock.calls.length).toBe(1);

    fail = false;
    await vi.advanceTimersByTimeAsync(16_000);
    const p2 = provider.provideInlineCompletions(
      modelStub('SELECT * FROM us', { lineNumber: 1, column: 18 }),
      { lineNumber: 1, column: 18 }, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    const res = await p2;
    expect(mock.calls.length).toBe(2);
    expect(res.items).toHaveLength(1);
  });

  it('S-需求2：请求超过 12s 超时则打日志并返回空（不永久挂起）', async () => {
    const mock = makeSqlStudioMock();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.setImpl(() => new Promise(() => {}));
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });

    const p = provider.provideInlineCompletions(
      modelStub('SELECT * FROM us', { lineNumber: 1, column: 18 }),
      { lineNumber: 1, column: 18 }, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await vi.advanceTimersByTimeAsync(13_000);
    const res = await p;
    expect(res.items).toHaveLength(0);
    expect(consoleWarn.mock.calls.some((c) => String(c[0]).includes('超时'))).toBe(true);
  });

  it('请求失败打明确日志且日志不含 API Key', async () => {
    const mock = makeSqlStudioMock();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.setImpl(async () => { throw new Error('AI 服务错误 (500)'); });
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });
    const p = provider.provideInlineCompletions(
      modelStub('SELECT * FROM us', { lineNumber: 1, column: 18 }),
      { lineNumber: 1, column: 18 }, null, null,
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await p;
    expect(consoleError.mock.calls.some((c) => String(c[0]).includes('请求失败'))).toBe(true);
    // 日志不得包含 API Key
    for (const c of consoleError.mock.calls) {
      expect(String(c[0])).not.toContain('sk-test');
    }
  });
});

describe('fetchAiConfig', () => {
  it('读主进程 public 配置并返回 AiProviderState（无 apiKey，仅 apiKeyConfigured）', async () => {
    const mock = makeSqlStudioMock();
    const state = await fetchAiConfig();
    expect(state.enabled).toBe(true);
    expect(state.config?.protocol).toBe('deepseek-fim');
    expect(state.config?.apiKeyConfigured).toBe(true);
    // 阶段 3：Renderer 配置里不存在 apiKey 字段
    expect((state.config as unknown as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('异常时返回禁用态', async () => {
    (window as unknown as Record<string, unknown>).sqlStudio = {
      'settings:getAiConfig': async () => { throw new Error('x'); },
    };
    const state = await fetchAiConfig();
    expect(state.enabled).toBe(false);
    expect(state.config).toBeNull();
  });
});

/** 防抖窗口 + 余量（让定时器跑完）。 */
function DEBOUNCE_PLUS(): number {
  return 500;
}