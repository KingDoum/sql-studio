/**
 * ai-protocol.ts 请求策略归一化单测（阶段 A：外观与 AI 限流）。
 *
 * 覆盖：
 * - 缺失 rateLimit → 四个默认值；
 * - 各字段低于最小值 → 修正为最小值；
 * - 各字段高于最大值 → 修正为最大值；
 * - 小数、NaN、字符串污染不会进入运行时配置；
 * - 额外字段被忽略；
 * - DEFAULT_AI_RATE_LIMIT_CONFIG 与文档表格一致。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AI_RATE_LIMIT_CONFIG,
  normalizeAiRateLimitConfig,
} from '@shared/ai-protocol';
import type { AiRateLimitConfig } from '@shared/types';

describe('DEFAULT_AI_RATE_LIMIT_CONFIG', () => {
  it('默认值与文档表格一致', () => {
    expect(DEFAULT_AI_RATE_LIMIT_CONFIG).toEqual({
      debounceMs: 400,
      minRequestIntervalMs: 2500,
      rateLimitCooldownMs: 15_000,
      requestTimeoutMs: 12_000,
    });
  });
});

describe('normalizeAiRateLimitConfig', () => {
  it('undefined / null / 非对象 → 全部默认值', () => {
    expect(normalizeAiRateLimitConfig(undefined)).toEqual(DEFAULT_AI_RATE_LIMIT_CONFIG);
    expect(normalizeAiRateLimitConfig(null)).toEqual(DEFAULT_AI_RATE_LIMIT_CONFIG);
    expect(normalizeAiRateLimitConfig('oops' as unknown as Partial<AiRateLimitConfig>)).toEqual(
      DEFAULT_AI_RATE_LIMIT_CONFIG,
    );
  });

  it('旧配置无 rateLimit（缺字段）→ 四个默认值', () => {
    const n = normalizeAiRateLimitConfig({});
    expect(n).toEqual(DEFAULT_AI_RATE_LIMIT_CONFIG);
  });

  it('各字段低于最小值 → 修正为最小值', () => {
    const n = normalizeAiRateLimitConfig({
      debounceMs: 1,
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 50,
      requestTimeoutMs: 100,
    });
    expect(n).toEqual({
      debounceMs: 150,
      minRequestIntervalMs: 500,
      rateLimitCooldownMs: 1000,
      requestTimeoutMs: 3000,
    });
  });

  it('各字段高于最大值 → 修正为最大值', () => {
    const n = normalizeAiRateLimitConfig({
      debounceMs: 9999,
      minRequestIntervalMs: 99_999,
      rateLimitCooldownMs: 999_999,
      requestTimeoutMs: 99_999,
    });
    expect(n).toEqual({
      debounceMs: 3000,
      minRequestIntervalMs: 30_000,
      rateLimitCooldownMs: 120_000,
      requestTimeoutMs: 60_000,
    });
  });

  it('小数 → 取整', () => {
    const n = normalizeAiRateLimitConfig({
      debounceMs: 400.6,
      minRequestIntervalMs: 2500.4,
      rateLimitCooldownMs: 15_000.5,
      requestTimeoutMs: 12_000.9,
    });
    expect(n.debounceMs).toBe(401);
    expect(n.minRequestIntervalMs).toBe(2500);
    expect(n.rateLimitCooldownMs).toBe(15_001);
    expect(n.requestTimeoutMs).toBe(12_001);
  });

  it('NaN / Infinity / 字符串污染 → 回退默认值，不进入运行时配置', () => {
    const n = normalizeAiRateLimitConfig({
      debounceMs: Number.NaN,
      minRequestIntervalMs: '2500' as unknown as number,
      rateLimitCooldownMs: Number.POSITIVE_INFINITY,
      requestTimeoutMs: 12_000,
    });
    // NaN / 字符串 / Infinity → 各自默认
    expect(n.debounceMs).toBe(400);
    expect(n.minRequestIntervalMs).toBe(2500);
    expect(n.rateLimitCooldownMs).toBe(15_000);
    expect(n.requestTimeoutMs).toBe(12_000);
  });

  it('额外字段被忽略（不进入运行时配置）', () => {
    const n = normalizeAiRateLimitConfig({
      debounceMs: 300,
      minRequestIntervalMs: 1000,
      rateLimitCooldownMs: 5000,
      requestTimeoutMs: 8000,
      apiKey: 'sk-leak' as unknown as number,
      maxTokens: 512,
    } as unknown as Partial<AiRateLimitConfig>);
    expect(n).toEqual({
      debounceMs: 300,
      minRequestIntervalMs: 1000,
      rateLimitCooldownMs: 5000,
      requestTimeoutMs: 8000,
    });
    expect((n as unknown as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('合法边界值保持原样', () => {
    const n = normalizeAiRateLimitConfig({
      debounceMs: 150,
      minRequestIntervalMs: 500,
      rateLimitCooldownMs: 1000,
      requestTimeoutMs: 3000,
    });
    expect(n).toEqual({
      debounceMs: 150,
      minRequestIntervalMs: 500,
      rateLimitCooldownMs: 1000,
      requestTimeoutMs: 3000,
    });
  });
});
