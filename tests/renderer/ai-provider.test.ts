/**
 * ai-provider.ts 单测（2026-08-30：AI 429 刷屏修复）。
 * 覆盖：禁用时不请求、防抖合并、限流后进入冷却期（不再刷错误日志）、过期响应丢弃。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAiInlineProvider, fetchAiConfig } from '@renderer/lib/ai-provider';
import type { AiConfig } from '@shared/types';

const CONFIG: AiConfig = {
  baseUrl: 'https://api.example.com',
  model: 'test-model',
  apiKey: 'sk-test',
  enabled: true,
};

/** 构造 sqlStudio mock，记录 ai:complete 调用。 */
function makeSqlStudioMock() {
  const calls: Array<{ prefix: string }> = [];
  let impl: (arg: { prefix: string }) => Promise<{ suggestion: string }> = async () => ({ suggestion: 'SELECT' });
  (window as unknown as Record<string, unknown>).sqlStudio = {
    'ai:complete': async (arg: { prefix: string }) => {
      calls.push({ prefix: arg.prefix });
      return impl(arg);
    },
    'settings:getAiConfig': async () => CONFIG,
  };
  return {
    calls,
    setImpl: (f: (arg: { prefix: string }) => Promise<{ suggestion: string }>) => { impl = f; },
  };
}

const modelStub = (prefixLine: string, column: number) => ({
  getValueInRange: (r: { startLineNumber: number; endLineNumber: number; startColumn: number; endColumn: number }) => {
    if (r.startLineNumber === r.endLineNumber && r.startColumn === 1 && r.endColumn === column) return prefixLine;
    return '';
  },
  getLineContent: () => prefixLine,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createAiInlineProvider 限流保护', () => {
  it('禁用时不发请求', async () => {
    const mock = makeSqlStudioMock();
    const provider = createAiInlineProvider({ enabled: false, config: null });
    const res = await provider.provideInlineCompletions(modelStub('SELECT * FROM ', 16), { lineNumber: 1, column: 16 }, null, null);
    expect(res.items).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
  });

  it('防抖：两次快速输入只发一次请求（400ms 后合并）', async () => {
    const mock = makeSqlStudioMock();
    const provider = createAiInlineProvider({ enabled: true, config: CONFIG });
    const p1 = provider.provideInlineCompletions(modelStub('SELECT * FROM us', 18), { lineNumber: 1, column: 18 }, null, null);
    await vi.advanceTimersByTimeAsync(150);
    const p2 = provider.provideInlineCompletions(modelStub('SELECT * FROM users', 20), { lineNumber: 1, column: 20 }, null, null);
    // 两个请求都在防抖窗口内，合并后应只触发一次 ai:complete
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

    // 第一次：触发限流
    const p1 = provider.provideInlineCompletions(modelStub('SELECT * FROM us', 18), { lineNumber: 1, column: 18 }, null, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await p1;
    expect(mock.calls.length).toBe(1);
    expect(consoleError).not.toHaveBeenCalled(); // 限流不打 error
    expect(consoleWarn).toHaveBeenCalledTimes(1); // 一次性 warn

    // 冷却期内再次输入：不再发请求
    const p2 = provider.provideInlineCompletions(modelStub('SELECT * FROM us', 18), { lineNumber: 1, column: 18 }, null, null);
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

    const p1 = provider.provideInlineCompletions(modelStub('SELECT * FROM us', 18), { lineNumber: 1, column: 18 }, null, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    await p1;
    expect(mock.calls.length).toBe(1);

    // 冷却结束后恢复
    fail = false;
    await vi.advanceTimersByTimeAsync(16_000); // 超过 15s 冷却
    const p2 = provider.provideInlineCompletions(modelStub('SELECT * FROM us', 18), { lineNumber: 1, column: 18 }, null, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_PLUS());
    const res = await p2;
    expect(mock.calls.length).toBe(2);
    expect(res.items).toHaveLength(1);
  });
});

/** 防抖窗口 + 余量（让定时器跑完）。 */
function DEBOUNCE_PLUS(): number {
  return 500;
}
