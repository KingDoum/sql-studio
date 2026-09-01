/**
 * AI 补全协议纯逻辑（无 Electron / Node 依赖，Main 与 Renderer 共用）。
 *
 * - 协议：`deepseek-fim`（DeepSeek 官方 FIM，beta/completions）vs `openai-chat`（v1/chat/completions）。
 * - BaseUrl 规范化：不允许重复拼接 /beta、/v1、/completions。
 * - max_tokens 钳制：1..4096，缺省/非法值回退 512。
 *
 * 阶段 1（FIM 协议修复）唯一来源：类型定义在 shared/types.ts，URL 计算与推断在本文件。
 */
import type { AiProtocol } from './types';

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