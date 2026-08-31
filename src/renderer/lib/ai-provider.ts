/**
 * AiCompletionProvider（V2：AI 行内灰色预测）。
 *
 * 注册为 Monaco `registerInlineCompletionsProvider`，在用户输入时
 * 通过 IPC `ai:complete` 向主进程请求 AI 建议，返回灰色行内预测文本。
 * 用户按 Tab 接受（Monaco 内建 inline suggestion 行为）。
 *
 * 触发时机：Monaco 每次输入变化都会调 provideInlineCompletions。
 * 本实现加了防抖（停止输入 DEBOUNCE_MS 才真正请求），避免每击键一次。
 *
 * 日志：本文件所有关键路径都打 console.info/warn —— 会被调试日志面板
 * （设置 → 调试日志）捕获，方便排查"为什么不显示灰色预测"。
 *
 * 限流保护（2026-08-30 修复 429 刷屏 + 日志可观测）：
 *  - 防抖：停止输入后过 DEBOUNCE_MS 才请求；
 *  - 失败冷却：429/5xx 后进入 COOLDOWN_MS，期间直接返回空、只 warn 一次；
 *  - 过期丢弃：并发只采纳最新请求。
 */
import type { AiConfig } from '@shared/types';

export interface AiProviderState {
  enabled: boolean;
  config: AiConfig | null;
}

const DEBOUNCE_MS = 400;
/** 最小请求间隔：距上次实际请求不足此值则跳过，避免连续输入把 API 打到 429 限流。 */
const MIN_REQUEST_INTERVAL_MS = 2500;
const RATE_LIMIT_COOLDOWN_MS = 15_000;
const RATE_LIMIT_HINTS = ['过于频繁', '429', 'rate limit', 'rate_limit', 'Too Many Requests'];

function getSqlStudio() {
  return (window as unknown as Record<string, unknown>).sqlStudio as Record<string, (arg: unknown) => Promise<unknown>>;
}

/** 判断错误是否为限流/服务端过载（这类错误应静默 + 冷却）。 */
function isRateLimited(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return RATE_LIMIT_HINTS.some((h) => msg.includes(h));
}

/** 统一日志（会被调试日志面板捕获）。 */
function logAi(level: 'info' | 'warn' | 'error', msg: string, detail?: unknown): void {
  if (typeof window === 'undefined' || !window.console) return;
  const suffix = detail === undefined ? '' : ` | ${detail instanceof Error ? detail.message : JSON.stringify(detail)}`;
  if (level === 'warn') window.console.warn(`[AI] ${msg}${suffix}`);
  else if (level === 'error') window.console.error(`[AI] ${msg}${suffix}`);
  else window.console.info(`[AI] ${msg}${suffix}`);
}

export function createAiInlineProvider(
  state: AiProviderState,
): {
  provideInlineCompletions: (
    model: unknown,
    position: { lineNumber: number; column: number },
    _context: unknown,
    _token: unknown,
  ) => Promise<{ items: Array<{ insertText: string; range: unknown }> }>;
  dispose: () => void;
  disposeInlineCompletions?: () => void;
} {
  let cancelled = false;
  // 防抖：共享定时器；新调用到来时把旧等待 resolve 为 'skip'（避免旧 Promise 悬挂）
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceResolve: ((v: 'ok' | 'skip') => void) | null = null;
  // 请求序号（过期丢弃）+ 冷却截止 + 最近请求时刻
  let seq = 0;
  let cooldownUntil = 0;
  let lastRequestAt = 0;
  let warnedRateLimit = false;

  /** 停止等待并返回 'skip'，让旧调用尽快空返回（不被悬挂）。 */
  const skipPendingDebounce = () => {
    if (debounceResolve) {
      const r = debounceResolve;
      debounceResolve = null;
      r('skip');
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const cleanupTimer = () => {
    skipPendingDebounce();
  };

  return {
    provideInlineCompletions: async (_model, position, _context, _token) => {
      if (!state.enabled || !state.config?.apiKey) {
        // 未启用/未配置：每次输入都到这（Monaco 频繁调用），用 debug 级避免刷屏
        return { items: [] };
      }
      // 冷却期内直接返回（限流后不立刻重试，避免继续触发 429）
      if (Date.now() < cooldownUntil) {
        return { items: [] };
      }

      cancelled = false;
      skipPendingDebounce();

      // 防抖：停止输入 DEBOUNCE_MS 后才请求。
      // 若期间又有新输入，旧调用被 resolve('skip') 快速返回，不悬挂、不发重复请求。
      const outcome = await new Promise<'ok' | 'skip'>((resolve) => {
        debounceResolve = resolve;
        debounceTimer = setTimeout(() => {
          debounceResolve = null;
          debounceTimer = null;
          resolve('ok');
        }, DEBOUNCE_MS);
      });
      if (cancelled || outcome === 'skip') return { items: [] };

      // 最小请求间隔：距上次实际请求不足则跳过（防抖之外再控频，避免 429）
      const sinceLast = Date.now() - lastRequestAt;
      if (sinceLast < MIN_REQUEST_INTERVAL_MS) {
        return { items: [] };
      }

      try {
        const model = _model as {
          getValueInRange: (r: { startLineNumber: number; endLineNumber: number; startColumn: number; endColumn: number }) => string;
          getLineContent: (line: number) => string;
        };
        // 光标前文本（当前行光标之前）
        const prefix = model.getValueInRange({
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: 1,
          endColumn: position.column,
        });
        if (!prefix.trim()) return { items: [] };

        // 过期丢弃：只采纳最新一次请求的响应
        const mySeq = ++seq;
        lastRequestAt = Date.now();
        logAi('info', `行内补全触发: line=${position.lineNumber} col=${position.column} prefixLen=${prefix.length}`);
        const started = Date.now();
        const raw = await getSqlStudio()['ai:complete']({
          prefix,
          maxTokens: 512,
        });
        const elapsed = Date.now() - started;

        if (cancelled || mySeq !== seq) return { items: [] };
        const resp = raw as { suggestion: string };
        const sugLen = resp.suggestion?.length ?? 0;
        logAi('info', `行内补全响应: 耗时=${elapsed}ms suggestionLen=${sugLen}`);
        if (!resp.suggestion) {
          logAi('info', '行内补全返回空建议（服务端未给出补全）');
          return { items: [] };
        }

        return {
          items: [
            {
              insertText: resp.suggestion,
              range: {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: position.column,
                endColumn: position.column, // 仅插入，不替换后续文本
              },
            },
          ],
        };
      } catch (err) {
        // 限流/过载：进入冷却，静默（不刷屏）；其余错误仅记录一次
        if (isRateLimited(err)) {
          cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          if (!warnedRateLimit && typeof window !== 'undefined' && window.console) {
            warnedRateLimit = true;
            logAi('warn', `行内补全服务限流，已暂停 AI 补全请求（冷却 ${RATE_LIMIT_COOLDOWN_MS / 1000}s）`, err);
            setTimeout(() => { warnedRateLimit = false; }, RATE_LIMIT_COOLDOWN_MS);
          }
        } else {
          logAi('error', '行内补全请求失败', err);
        }
        return { items: [] };
      }
    },
    dispose: () => {
      cancelled = true;
      cleanupTimer();
    },
    disposeInlineCompletions: () => {
      cancelled = true;
      cleanupTimer();
    },
  };
}

/** 读取 AI 设置（从主进程）。 */
export async function fetchAiConfig(): Promise<AiProviderState> {
  try {
    const config = await getSqlStudio()['settings:getAiConfig'](undefined) as AiConfig | null;
    return { enabled: config?.enabled ?? false, config };
  } catch {
    return { enabled: false, config: null };
  }
}
