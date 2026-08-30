/**
 * AiCompletionProvider（V2：AI 行内灰色预测）。
 *
 * 注册为 Monaco `registerInlineCompletionsProvider`，在用户输入时
 * 通过 IPC `ai:complete` 向主进程请求 AI 建议，返回灰色行内预测文本。
 *
 * 与 SchemaCompletionProvider（弹窗补全）并列运行，可独立开关。
 * 开关由 AiConfig.enabled 控制——通过 `settings:getAiConfig` 读取。
 *
 * 限流保护（2026-08-30 修复 429 刷屏）：
 *  - 防抖：用户停止输入 DEBOUNCE_MS 后才真正发请求，避免每击键一次；
 *  - 失败冷却：429/5xx 后进入 COOLDOWN_MS 冷却，期间直接返回空（不再刷错误日志）；
 *  - 过期丢弃：并发请求只有最新的一次被采纳，避免旧响应覆盖。
 */
import type { AiConfig } from '@shared/types';

export interface AiProviderState {
  enabled: boolean;
  config: AiConfig | null;
}

const DEBOUNCE_MS = 400;
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
  // 请求序号（过期丢弃）+ 冷却截止
  let seq = 0;
  let cooldownUntil = 0;
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
        const raw = await getSqlStudio()['ai:complete']({
          prefix,
          maxTokens: 512,
        });

        if (cancelled || mySeq !== seq) return { items: [] };
        const resp = raw as { suggestion: string };
        if (!resp.suggestion) return { items: [] };

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
            console.warn('[AI] 行内补全服务限流，已暂停 AI 补全请求（冷却中）');
            setTimeout(() => { warnedRateLimit = false; }, RATE_LIMIT_COOLDOWN_MS);
          }
        } else if (typeof window !== 'undefined' && window.console) {
          console.error('[AI] 行内补全请求失败:', err instanceof Error ? err.message : String(err));
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
