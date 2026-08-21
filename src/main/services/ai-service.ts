/**
 * AI 服务（V2：OpenAI 兼容 API 调用）。
 *
 * 职责：向 OpenAI 兼容接口（DeepSeek / 腾讯混元等）发送补全请求，
 * 返回 SQL 行内补全建议。错误规范化：超时/认证失败/限流 → 友好中文提示。
 *
 * 依赖注入：构造函数注入 fetch 函数（默认 globalThis.fetch，单测可 mock）。
 * 不依赖 Electron 环境，可在 Node 或 Electron 主进程复用。
 */
import type { AiConfig, AiCompletionRequest, AiCompletionResponse } from '@shared/types';

/** 超时毫秒。 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 流式/非流式：V1 用非流式。 */
const SYSTEM_PROMPT = `You are a SQL completion assistant for MySQL/MariaDB.
Complete the SQL statement based on the prefix provided.
Return ONLY the SQL text that would complete the statement — no explanation, no markdown, no backticks, no prefix repetition.
The user's prefix ends at the cursor position. Complete it naturally.`;

export class AiService {
  constructor(
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  /**
   * 调用 AI API 获取 SQL 补全建议。
   * @param req 补全请求（prefix）
   * @param config API 配置（baseUrl / model / apiKey）
   * @param signal 可选 AbortSignal（用于取消）
   */
  async complete(
    req: AiCompletionRequest,
    config: AiConfig,
    signal?: AbortSignal,
  ): Promise<AiCompletionResponse> {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    // 兼容 OpenAI 标准 API 路径（自动补全 /v1 前缀）
    const url = baseUrl.endsWith('/v1')
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const mergedSignal = signal
      ? combineSignals(signal, controller.signal)
      : controller.signal;

    try {
      console.log('[AI] 请求:', url, 'model:', config.model, 'prefix:', req.prefix.slice(0, 100));
      const resp = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Complete the SQL:\n${req.prefix}` },
          ],
          max_tokens: req.maxTokens ?? 512,
          temperature: 0.2,
          stream: false,
        }),
        signal: mergedSignal,
      });

      if (!resp.ok) {
        throw normalizeError(resp.status, await resp.text().catch(() => ''));
      }

      console.log('[AI] 响应状态:', resp.status);
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const suggestion = data?.choices?.[0]?.message?.content?.trim() ?? '';
      return { suggestion };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** HTTP 状态码 → 友好错误。 */
function normalizeError(status: number, body: string): Error {
  if (status === 401) return new Error('API 认证失败：请检查 API Key 是否正确');
  if (status === 429) return new Error('请求过于频繁，请稍后重试');
  if (status === 503) return new Error('AI 服务暂不可用，请稍后重试');
  return new Error(`AI 服务错误 (${status}): ${body.slice(0, 200)}`);
}

/** 合并两个 AbortSignal（任一触发即中止）。 */
function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}