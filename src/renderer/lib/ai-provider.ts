/**
 * AiCompletionProvider（V2：AI 行内灰色预测，阶段 2：注册时序 + 完整上下文修复）。
 *
 * 注册为 Monaco `registerInlineCompletionsProvider`，在用户输入时
 * 通过 IPC `ai:complete` 向主进程请求 AI 建议，返回灰色行内预测文本。
 * 用户按 Tab 接受（Monaco 内建 inline suggestion 行为）。
 *
 * 触发时机：Monaco 每次输入变化都会调 provideInlineCompletions。
 * 本实现加防抖（停止输入 debounceMs 才真正请求），避免每击键一次。
 *
 * 上下文（阶段 2 修复）：
 *  - prefix：第 1 行第 1 列到当前光标的完整文本（跨行），不是仅当前行；
 *  - suffix：当前光标到文档末尾（DeepSeek FIM 需要 suffix 提升补全质量）。
 *
 * 日志：本文件所有关键路径都打 console.info/warn —— 会被调试日志面板
 * （设置 → 调试日志）捕获。日志只输出非敏感摘要（prefixLen/suffixLen/协议/原因码），
 * 禁止输出 API Key、完整 prefix/suffix/SQL、Authorization header。
 *
 * 限流保护（2026-08-30 修复 429 刷屏 + 日志可观测；阶段 C：参数可调）：
 *  - 四个限流参数不再写死，统一来自 public config 的 `rateLimit`
 *    （共享归一化：`normalizeAiRateLimitConfig`，范围见 ai-protocol.ts）；
 *  - 输出防抖 debounceMs / 最小间隔 minRequestIntervalMs / 冷却 rateLimitCooldownMs /
 *    请求超时 requestTimeoutMs 全部按配置执行；
 *  - 过期丢弃：并发只采纳最新请求，过期响应打明确日志（stale_response）；
 *  - 原因码日志：disabled / not_configured / debounce / min_interval / cooldown /
 *    empty_prefix / timeout / stale_response / provider_empty / error；
 *  - debounce / min_interval / cooldown 的跳过日志至少按 1s 节流，避免刷屏。
 */
import type { AiPublicConfig, AiRateLimitConfig } from '@shared/types';
import { resolveProtocol, normalizeAiRateLimitConfig } from '@shared/ai-protocol';

export interface AiProviderState {
  enabled: boolean;
  config: AiPublicConfig | null;
}

const RATE_LIMIT_HINTS = ['过于频繁', '429', 'rate limit', 'rate_limit', 'Too Many Requests'];
/** 跳过日志节流窗口（ms）：同类跳过原因 1s 内最多打一条，避免 Monaco 高频输入刷屏。 */
const SKIP_LOG_THROTTLE_MS = 1000;

/** 带超时的 ai:complete：超时返回 { timeout: true }；错误返回 { error }；正常返回原始响应。 */
type AiCallResult = { timeout: boolean; raw?: { suggestion: string }; error?: unknown };
async function callAiCompleteWithTimeout(
  args: { prefix: string; suffix: string; maxTokens: number },
  timeoutMs: number,
): Promise<AiCallResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: AiCallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
    getSqlStudio()['ai:complete'](args)
      .then((raw) => finish({ timeout: false, raw: raw as { suggestion: string } }))
      .catch((err: unknown) => finish({ timeout: false, error: err }));
  });
}

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

/** AI 是否已配置（阶段 3：Renderer 看不到 apiKey，改用 apiKeyConfigured 判断）。 */
function isAiReady(state: AiProviderState): boolean {
  return !!state.enabled && !!state.config?.apiKeyConfigured;
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
  // 是否已打过“初始化/就绪”日志（只打一次，避免刷屏）
  let loggedInit = false;
  // 跳过日志节流：上次打跳过日志的时刻
  let lastSkipLogAt = 0;

  /** 限流参数：来自 public config（已归一化），防御性再归一化一次保证安全。 */
  const rateLimit: AiRateLimitConfig = normalizeAiRateLimitConfig(state.config?.rateLimit);

  /** 节流跳过日志：debounce/min_interval/cooldown 等高频跳过原因按 1s 节流。 */
  const logSkipThrottled = (reason: string, remainingMs: number) => {
    const now = Date.now();
    if (now - lastSkipLogAt < SKIP_LOG_THROTTLE_MS) return;
    lastSkipLogAt = now;
    logAi('info', `跳过 AI 补全: reason=${reason} remainingMs=${remainingMs}`);
  };

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
      // dispose 后的 provider 不再发起/采纳任何请求（设置变化重建时旧 provider 立即失效）
      if (cancelled) return { items: [] };
      // 可观测：provider 初始化 / AI 启用 / Key 是否已配置 / 四个限流参数（只打一次）
      if (!loggedInit) {
        loggedInit = true;
        logAi(
          'info',
          `provider 初始化: enabled=${state.enabled} apiKeyConfigured=${isAiReady(state)} protocol=${state.config ? resolveProtocol(state.config.protocol, state.config.baseUrl) : 'n/a'} ` +
            `rateLimit={debounceMs:${rateLimit.debounceMs},minRequestIntervalMs:${rateLimit.minRequestIntervalMs},rateLimitCooldownMs:${rateLimit.rateLimitCooldownMs},requestTimeoutMs:${rateLimit.requestTimeoutMs}}`,
        );
      }
      if (!state.enabled) {
        logSkipThrottled('disabled', 0);
        return { items: [] };
      }
      if (!state.config?.apiKeyConfigured) {
        logSkipThrottled('not_configured', 0);
        return { items: [] };
      }
      // 冷却期内直接返回（限流后不立刻重试，避免继续触发 429）
      if (Date.now() < cooldownUntil) {
        logSkipThrottled('cooldown', cooldownUntil - Date.now());
        return { items: [] };
      }

      cancelled = false;
      skipPendingDebounce();

      // 防抖：停止输入 debounceMs 后才请求。
      // 若期间又有新输入，旧调用被 resolve('skip') 快速返回，不悬挂、不发重复请求。
      const outcome = await new Promise<'ok' | 'skip'>((resolve) => {
        debounceResolve = resolve;
        debounceTimer = setTimeout(() => {
          debounceResolve = null;
          debounceTimer = null;
          resolve('ok');
        }, rateLimit.debounceMs);
      });
      if (cancelled) return { items: [] };
      if (outcome === 'skip') {
        // 新输入替换了旧防抖等待：跳过本次（不视为请求失败）
        logSkipThrottled('debounce', rateLimit.debounceMs);
        return { items: [] };
      }

      // 最小请求间隔：距上次实际请求不足则跳过（防抖之外再控频，避免 429）
      const sinceLast = Date.now() - lastRequestAt;
      if (sinceLast < rateLimit.minRequestIntervalMs) {
        logSkipThrottled('min_interval', rateLimit.minRequestIntervalMs - sinceLast);
        return { items: [] };
      }

      try {
        const model = _model as {
          getValueInRange: (r: { startLineNumber: number; endLineNumber: number; startColumn: number; endColumn: number }) => string;
          getLineContent: (line: number) => string;
          getLineCount: () => number;
        };
        // prefix：第 1 行第 1 列 → 当前光标（跨行完整文档前缀）
        const prefix = model.getValueInRange({
          startLineNumber: 1,
          endLineNumber: position.lineNumber,
          startColumn: 1,
          endColumn: position.column,
        });
        // suffix：当前光标 → 文档末尾
        const lastLine = model.getLineCount();
        const lastLineLen = model.getLineContent(lastLine).length;
        const suffix = model.getValueInRange({
          startLineNumber: position.lineNumber,
          endLineNumber: lastLine,
          startColumn: position.column,
          endColumn: lastLineLen + 1,
        });
        if (!prefix.trim()) {
          logSkipThrottled('empty_prefix', 0);
          return { items: [] };
        }

        // 过期丢弃（单飞保护）：同一时刻只保留最新一次请求为「有效」；
        // 新请求开始时递增 seq，旧请求返回时若序号已过期则丢弃结果，绝不采纳两个建议。
        // 注意：IPC/HTTP 请求本身无法取消，这里不假装已取消，只标记过期并丢弃结果（保留超时兜底）。
        const mySeq = ++seq;
        lastRequestAt = Date.now();
        const protocol = state.config ? resolveProtocol(state.config.protocol, state.config.baseUrl) : 'n/a';
        logAi(
          'info',
          `请求开始: line=${position.lineNumber} col=${position.column} protocol=${protocol} prefixLen=${prefix.length} suffixLen=${suffix.length}`,
        );
        const started = Date.now();
        const call = await callAiCompleteWithTimeout({ prefix, suffix, maxTokens: 512 }, rateLimit.requestTimeoutMs);
        const elapsed = Date.now() - started;

        if (cancelled) return { items: [] };

        // 过期响应（stale_response）：明确日志（旧请求结果丢弃，不采纳）
        if (mySeq !== seq) {
          logAi('warn', `stale_response: 旧请求结果已丢弃（请求已过期 seq=${mySeq} < 最新=${seq}），不采纳`);
          return { items: [] };
        }

        if (call.timeout) {
          logAi('warn', `timeout: 行内补全请求超时（>${rateLimit.requestTimeoutMs / 1000}s），已放弃本次请求`, { elapsed });
          return { items: [] };
        }
        if (call.error) {
          // 交给下方 catch 统一处理限流/错误分类
          throw call.error;
        }
        const resp = call.raw as { suggestion: string; meta?: { choiceCount: number; finishReason?: string; usage?: { totalTokens?: number } } };
        const sugLen = resp.suggestion?.length ?? 0;
        const meta = resp.meta;
        logAi(
          'info',
          `行内补全响应: 耗时=${elapsed}ms suggestionLen=${sugLen}` +
            (meta ? ` choiceCount=${meta.choiceCount} finishReason=${meta.finishReason ?? 'null'} usage=${meta.usage?.totalTokens ?? 'n/a'}` : ''),
        );
        if (!resp.suggestion) {
          // provider_empty：服务端返回了空建议（可能是 choices 为空、空 text 或模型未给出补全；
          // 由 meta.choiceCount 进一步区分：0=无候选，>0=有候选但文本为空）。不是客户端限流。
          if (meta && meta.choiceCount === 0) {
            logAi('info', 'provider_empty: 服务端返回空 choices（无候选），非客户端限流');
          } else {
            logAi('info', 'provider_empty: 行内补全返回空建议（服务端未给出补全），非客户端限流');
          }
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
        // 限流/过载（cooldown）：进入冷却，静默（不刷屏）；其余错误仅记录一次
        if (isRateLimited(err)) {
          cooldownUntil = Date.now() + rateLimit.rateLimitCooldownMs;
          if (!warnedRateLimit && typeof window !== 'undefined' && window.console) {
            warnedRateLimit = true;
            logAi('warn', `cooldown: 行内补全服务限流，已暂停 AI 补全请求（冷却 ${rateLimit.rateLimitCooldownMs / 1000}s）`, err);
            setTimeout(() => { warnedRateLimit = false; }, rateLimit.rateLimitCooldownMs);
          }
        } else {
          logAi('error', `error: 行内补全请求失败`, err);
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

/** 读取 AI 设置（从主进程，Renderer 拿到的只有 AiPublicConfig，不含 apiKey）。 */
export async function fetchAiConfig(): Promise<AiProviderState> {
  try {
    const config = await getSqlStudio()['settings:getAiConfig'](undefined) as AiPublicConfig | null;
    return { enabled: config?.enabled ?? false, config };
  } catch {
    return { enabled: false, config: null };
  }
}