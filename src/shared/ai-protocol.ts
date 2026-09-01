/**
 * AI 补全协议纯逻辑（无 Electron / Node 依赖，Main 与 Renderer 共用）。
 *
 * - 协议：`deepseek-fim`（DeepSeek 官方 FIM，beta/completions）vs `openai-chat`（v1/chat/completions）。
 * - BaseUrl 规范化：不允许重复拼接 /beta、/v1、/completions。
 * - max_tokens 钳制：1..4096，缺省/非法值回退 512。
 *
 * 阶段 1（FIM 协议修复）唯一来源：类型定义在 shared/types.ts，URL 计算与推断在本文件。
 */
import type { AiProtocol, AiRateLimitConfig } from './types';

/** 去掉末尾所有斜杠（baseUrl 尾部归一）。 */
export function stripTrailingSlash(s: string): string {
  return (s ?? '').trim().replace(/\/+$/, '');
}

/**
 * 旧配置兼容：没有 protocol 字段时按 baseUrl 推断。
 * baseUrl 含 `/beta` 段 → 视为 DeepSeek FIM；否则视为 OpenAI Chat。
 */
export function inferAiProtocolFromBaseUrl(baseUrl: string): AiProtocol {
  return /\/beta(\/|$)/i.test(baseUrl.trim()) ? 'deepseek-fim' : 'openai-chat';
}

/** 该协议默认 BaseUrl（协议切换时的提示/默认值）。 */
export function defaultBaseUrlFor(protocol: AiProtocol): string {
  return protocol === 'deepseek-fim' ? 'https://api.deepseek.com/beta' : 'https://api.deepseek.com';
}

/** 该协议默认模型（协议切换时的提示/默认值；用户可改）。 */
export function defaultModelFor(protocol: AiProtocol): string {
  return protocol === 'deepseek-fim' ? 'deepseek-v4-pro' : 'deepseek-chat';
}

/**
 * 把 baseUrl 规范化为该协议的最终 completions 端点。
 *
 * DeepSeek FIM：
 *   https://api.deepseek.com         → https://api.deepseek.com/beta/completions
 *   https://api.deepseek.com/        → https://api.deepseek.com/beta/completions
 *   https://api.deepseek.com/beta    → https://api.deepseek.com/beta/completions
 *   https://api.deepseek.com/beta/   → https://api.deepseek.com/beta/completions
 *   https://api.deepseek.com/beta/completions → 原样（不重复拼接）
 *   https://api.deepseek.com/v1      → https://api.deepseek.com/v1/completions（不重复 /v1、不加 /beta）
 *
 * OpenAI Chat：
 *   https://api.deepseek.com         → https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com/v1      → https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com/beta    → https://api.deepseek.com/v1/chat/completions（Chat 协议下去掉误配的 /beta）
 *   …/chat/completions               → 原样（不重复拼接）
 */
export function resolveCompletionsUrl(baseUrl: string, protocol: AiProtocol): string {
  const b = stripTrailingSlash(baseUrl);
  if (!b) return '';

  if (protocol === 'deepseek-fim') {
    if (/\/completions$/i.test(b)) return b;
    if (/\/beta$/i.test(b)) return `${b}/completions`;
    if (/\/v1$/i.test(b)) return `${b}/completions`;
    return `${b}/beta/completions`;
  }

  // openai-chat
  if (/\/chat\/completions$/i.test(b)) return b;
  if (/\/v1$/i.test(b)) return `${b}/chat/completions`;
  if (/\/beta$/i.test(b)) return `${b.replace(/\/beta$/i, '')}/v1/chat/completions`;
  if (/\/completions$/i.test(b)) return b; // 已是 completions（非 chat）：不重复拼接
  return `${b}/v1/chat/completions`;
}

/** 协议归一：显式 protocol 优先；缺失时按 baseUrl 推断。 */
export function resolveProtocol(protocol: AiProtocol | undefined, baseUrl: string): AiProtocol {
  return protocol ?? inferAiProtocolFromBaseUrl(baseUrl);
}

/**
 * max_tokens 钳制：[1, 4096]。
 * - 未传 / 0 / 负数 / 非有限数 → 默认 512（避免请求不合理或超长补全延迟）。
 * - 超过 4096 → 截断为 4096。
 */
export function clampMaxTokens(v?: number): number {
  if (v === undefined || v === null || !Number.isFinite(v)) return 512;
  if (v <= 0) return 512;
  return Math.min(Math.trunc(v), 4096);
}

// ─────────────────────────────────────────────────────────────
// AI 请求策略（限流参数）：唯一默认值与归一化（Main/Renderer 共用）
// ─────────────────────────────────────────────────────────────

/** 唯一默认 AI 请求策略（Main 与 Renderer 引用同一份）。 */
export const DEFAULT_AI_RATE_LIMIT_CONFIG: AiRateLimitConfig = {
  debounceMs: 400,
  minRequestIntervalMs: 2500,
  rateLimitCooldownMs: 15_000,
  requestTimeoutMs: 12_000,
} as const;

/** 各字段的允许范围（用于归一化钳制；小数/NaN/非数值回退默认值）。 */
export const AI_RATE_LIMIT_RANGES: Record<
  keyof AiRateLimitConfig,
  { min: number; max: number }
> = {
  debounceMs: { min: 150, max: 3000 },
  minRequestIntervalMs: { min: 500, max: 30_000 },
  rateLimitCooldownMs: { min: 1000, max: 120_000 },
  requestTimeoutMs: { min: 3000, max: 60_000 },
};

/** 单个字段归一化：缺失/非数字/非有限 → 默认；越界钳制到 [min,max]；小数取整。 */
function clampRateLimitValue(
  key: keyof AiRateLimitConfig,
  value: unknown,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_AI_RATE_LIMIT_CONFIG[key];
  }
  const { min, max } = AI_RATE_LIMIT_RANGES[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 归一化 AiRateLimitConfig：
 * - 缺失 / null / undefined → 全部默认值；
 * - 每个字段：非数字、NaN、无穷 → 默认值；小数取整；低于 min / 高于 max 钳制。
 * - 额外字段被忽略（不进入运行时配置）。
 * Main（metadata-store / ai-service）与 Renderer（ai-provider / 设置面板）共用此逻辑。
 */
export function normalizeAiRateLimitConfig(
  raw?: Partial<AiRateLimitConfig> | null,
): AiRateLimitConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_AI_RATE_LIMIT_CONFIG };
  }
  return {
    debounceMs: clampRateLimitValue('debounceMs', raw.debounceMs),
    minRequestIntervalMs: clampRateLimitValue('minRequestIntervalMs', raw.minRequestIntervalMs),
    rateLimitCooldownMs: clampRateLimitValue('rateLimitCooldownMs', raw.rateLimitCooldownMs),
    requestTimeoutMs: clampRateLimitValue('requestTimeoutMs', raw.requestTimeoutMs),
  };
}