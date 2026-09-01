/**
 * ai-service.ts 单测（阶段 1：DeepSeek FIM 协议修复）。
 *
 * 覆盖（阶段 1 验收）：
 *  - FIM URL 正确（/beta/completions）；
 *  - FIM body 使用 prompt/suffix，不发送 messages；
 *  - 正确解析 choices[0].text；
 *  - Chat 模式仍解析 message.content；
 *  - Base URL 不重复拼接（/beta、/v1、/completions）；
 *  - max_tokens 钳制（0/负数/超 4096）；
 *  - HTTP 401 / 429 / 5xx；
 *  - choices 为空、空 text。
 */
import { describe, it, expect, vi } from 'vitest';
import { AiService } from '@main/services/ai-service';
import type { AiConfig, AiCompletionRequest } from '@shared/types';

const FIM_CONFIG: AiConfig = {
  enabled: true,
  baseUrl: 'https://api.deepseek.com/beta',
  model: 'deepseek-v4-pro',
  apiKey: 'sk-test',
  protocol: 'deepseek-fim',
};

const CHAT_CONFIG: AiConfig = {
  enabled: true,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
  protocol: 'openai-chat',
};

const REQ: AiCompletionRequest = {
  prefix: 'SELECT * FROM us',
  suffix: ' WHERE id = 1',
  maxTokens: 512,
};

/** 抓取 fetch 调用（url + body），可配置响应。 */
function makeFetchMock(body?: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let respBody: unknown = body;
  let respStatus = 200;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: respStatus >= 200 && respStatus < 300,
      status: respStatus,
      text: async () => JSON.stringify(respBody),
      json: async () => respBody,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return {
    fetchFn,
    calls,
    setBody: (b: unknown) => { respBody = b; },
    setStatus: (s: number) => { respStatus = s; },
  };
}

describe('AiService · DeepSeek FIM', () => {
  it('FIM URL 使用 /beta/completions（baseUrl 已含 /beta 时不重复拼接）', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ text: 'ers' }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, FIM_CONFIG);
    expect(calls[0].url).toBe('https://api.deepseek.com/beta/completions');
  });

  it('FIM body 使用 prompt/suffix，且不发送 messages', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ text: 'ers' }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, FIM_CONFIG);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.prompt).toBe('SELECT * FROM us');
    expect(body.suffix).toBe(' WHERE id = 1');
    expect(body.model).toBe('deepseek-v4-pro');
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty('messages');
    expect(body.max_tokens).toBe(512);
  });

  it('FIM 解析 choices[0].text', async () => {
    const { fetchFn } = makeFetchMock({ choices: [{ text: '  ers  ' }] });
    const svc = new AiService(fetchFn);
    const res = await svc.complete(REQ, FIM_CONFIG);
    expect(res.suggestion).toBe('ers');
  });

  it('FIM 响应 choices 为空 → 空建议', async () => {
    const { fetchFn } = makeFetchMock({ choices: [] });
    const svc = new AiService(fetchFn);
    const res = await svc.complete(REQ, FIM_CONFIG);
    expect(res.suggestion).toBe('');
  });

  it('FIM 响应 text 为空字符串 → 空建议', async () => {
    const { fetchFn } = makeFetchMock({ choices: [{ text: '   ' }] });
    const svc = new AiService(fetchFn);
    const res = await svc.complete(REQ, FIM_CONFIG);
    expect(res.suggestion).toBe('');
  });

  it('FIM baseUrl 以尾斜杠结尾也能正确拼接', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ text: 'ers' }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, { ...FIM_CONFIG, baseUrl: 'https://api.deepseek.com/beta/' });
    expect(calls[0].url).toBe('https://api.deepseek.com/beta/completions');
  });

  it('FIM baseUrl 已含 /completions 不重复拼接', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ text: 'ers' }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, { ...FIM_CONFIG, baseUrl: 'https://api.deepseek.com/beta/completions' });
    expect(calls[0].url).toBe('https://api.deepseek.com/beta/completions');
  });

  it('FIM baseUrl 为根地址时自动补 /beta/completions', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ text: 'ers' }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, { ...FIM_CONFIG, baseUrl: 'https://api.deepseek.com' });
    expect(calls[0].url).toBe('https://api.deepseek.com/beta/completions');
  });

  it('FIM baseUrl 为根地址带尾斜杠时自动补 /beta/completions', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ text: 'ers' }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, { ...FIM_CONFIG, baseUrl: 'https://api.deepseek.com/' });
    expect(calls[0].url).toBe('https://api.deepseek.com/beta/completions');
  });

  it('FIM baseUrl 已含 /v1 时不重复拼接 /v1 或 /beta', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ text: 'ers' }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, { ...FIM_CONFIG, baseUrl: 'https://api.deepseek.com/v1' });
    // FIM 协议下 /v1 地址直接补 /completions，不再补 /beta（不重复拼接）
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/completions');
  });
});

describe('AiService · OpenAI Chat（保留兼容）', () => {
  it('Chat URL 使用 /v1/chat/completions（baseUrl 已含 /v1 时不重复拼接）', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ message: { content: 'users' } }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, CHAT_CONFIG);
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('Chat URL baseUrl 已含 /v1 时不再补 /v1', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ message: { content: 'users' } }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, { ...CHAT_CONFIG, baseUrl: 'https://api.deepseek.com/v1/' });
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('Chat 解析 message.content', async () => {
    const { fetchFn } = makeFetchMock({ choices: [{ message: { content: '  users  ' } }] });
    const svc = new AiService(fetchFn);
    const res = await svc.complete(REQ, CHAT_CONFIG);
    expect(res.suggestion).toBe('users');
  });

  it('Chat body 发送 messages（兼容）且同步 max_tokens', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ message: { content: 'x' } }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, CHAT_CONFIG);
    const body = JSON.parse(calls[0].init.body as string);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(2);
    expect(body.prompt).toBeUndefined();
    expect(body.max_tokens).toBe(512);
  });

  it('Chat 响应 choices 为空 → 空建议', async () => {
    const { fetchFn } = makeFetchMock({ choices: [] });
    const svc = new AiService(fetchFn);
    const res = await svc.complete(REQ, CHAT_CONFIG);
    expect(res.suggestion).toBe('');
  });
});

describe('AiService · 旧配置兼容（无 protocol 字段）', () => {
  it('baseUrl 含 /beta 且无 protocol → 按 FIM 处理（/beta/completions + prompt/suffix）', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ text: 'ers' }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, { ...FIM_CONFIG, protocol: undefined });
    expect(calls[0].url).toBe('https://api.deepseek.com/beta/completions');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.prompt).toBe('SELECT * FROM us');
    expect(body).not.toHaveProperty('messages');
  });

  it('baseUrl 无 /beta 且无 protocol → 按 Chat 处理（/v1/chat/completions + message.content）', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ message: { content: 'users' } }] });
    const svc = new AiService(fetchFn);
    await svc.complete(REQ, { ...CHAT_CONFIG, protocol: undefined });
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    const body = JSON.parse(calls[0].init.body as string);
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

describe('AiService · max_tokens 钳制', () => {
  const cases: Array<[number | undefined, number]> = [
    [undefined, 512],
    [0, 512],
    [-5, 512],
    [-1, 512],
    [100, 100],
    [4096, 4096],
    [5000, 4096],
    [100_000, 4096],
  ];
  for (const [input, expected] of cases) {
    it(`maxTokens=${String(input)} → max_tokens=${expected}`, async () => {
      const { fetchFn, calls } = makeFetchMock({ choices: [{ text: 'x' }] });
      const svc = new AiService(fetchFn);
      await svc.complete({ ...REQ, maxTokens: input }, FIM_CONFIG);
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.max_tokens).toBe(expected);
    });
  }
});

describe('AiService · HTTP 错误规范化', () => {
  it('401 → 认证失败', async () => {
    const mock = makeFetchMock({ error: 'bad key' });
    mock.setStatus(401);
    const svc = new AiService(mock.fetchFn);
    await expect(svc.complete(REQ, FIM_CONFIG)).rejects.toThrow('API 认证失败');
  });

  it('429 → 请求过于频繁', async () => {
    const mock = makeFetchMock({ error: 'rate' });
    mock.setStatus(429);
    const svc = new AiService(mock.fetchFn);
    await expect(svc.complete(REQ, FIM_CONFIG)).rejects.toThrow('请求过于频繁');
  });

  it('503 → 服务暂不可用', async () => {
    const mock = makeFetchMock({ error: 'overloaded' });
    mock.setStatus(503);
    const svc = new AiService(mock.fetchFn);
    await expect(svc.complete(REQ, FIM_CONFIG)).rejects.toThrow('AI 服务暂不可用');
  });

  it('500 → 通用服务错误（含状态码与摘要）', async () => {
    const mock = makeFetchMock({ error: 'boom' });
    mock.setStatus(500);
    const svc = new AiService(mock.fetchFn);
    await expect(svc.complete(REQ, FIM_CONFIG)).rejects.toThrow(/AI 服务错误 \(500\)/);
  });

  it('网络失败直接透传（fetch reject）', async () => {
    const mock = makeFetchMock({});
    const fetchFn = mock.fetchFn as ReturnType<typeof vi.fn>;
    fetchFn.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const svc = new AiService(fetchFn);
    await expect(svc.complete(REQ, FIM_CONFIG)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('AiService · 日志脱敏', () => {
  it('日志不输出 API Key / 完整 SQL / Authorization header', async () => {
    const { fetchFn, calls } = makeFetchMock({ choices: [{ text: 'ers' }] });
    const svc = new AiService(fetchFn);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prefix = 'SELECT * FROM users WHERE name = "secret"';
    try {
      await svc.complete({ prefix, suffix: ';' }, FIM_CONFIG);
    } finally {
      spy.mockRestore();
    }
    // 请求体确实携带 key（主进程内部），但这是 header，不是日志
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization ?? headers.authorization).toBe('Bearer sk-test');
    // 所有 console.log 输出不得包含 key / 完整 SQL
    for (const msg of spy.mock.calls.map((c) => c.map(String).join(' '))) {
      expect(msg).not.toContain('sk-test');
      expect(msg).not.toContain(prefix);
      expect(msg).not.toContain('Authorization');
    }
  });
});