/**
 * log-redaction.ts 单测（自动保存方案 S4，测试矩阵 §16.5 LG-16~22 对应项）。
 */
import { describe, it, expect } from 'vitest';
import {
  redactObject,
  redactText,
  redactConnectionString,
  safeStringify,
  shortHash,
} from '@main/services/log-redaction';

describe('redactObject（对象键名脱敏，LG-16/17/18）', () => {
  it('password / passwd / pwd 键值被替换', () => {
    const out = redactObject({
      password: 'secret123',
      passwd: 's',
      pwd: 'p',
      username: 'root',
    }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED]');
    expect(out.passwd).toBe('[REDACTED]');
    expect(out.pwd).toBe('[REDACTED]');
    expect(out.username).toBe('root');
  });

  it('apiKey / api_key / secret 键值被替换', () => {
    const out = redactObject({
      apiKey: 'sk-abc',
      api_key: 'x',
      secret: 's',
      model: 'deepseek-v4-pro',
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
    expect(out.model).toBe('deepseek-v4-pro');
  });

  it('authorization / token / accessToken / refreshToken 键值被替换', () => {
    const out = redactObject({
      authorization: 'Bearer abc',
      token: 't',
      accessToken: 'at',
      refreshToken: 'rt',
      connectionId: 'conn-1',
    }) as Record<string, unknown>;
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.accessToken).toBe('[REDACTED]');
    expect(out.refreshToken).toBe('[REDACTED]');
    expect(out.connectionId).toBe('conn-1');
  });

  it('嵌套对象递归脱敏，循环引用安全', () => {
    const obj: Record<string, unknown> = { level1: { password: 'x', ok: 1 } };
    (obj as { self?: unknown }).self = obj; // 循环引用
    const out = redactObject(obj) as { level1: Record<string, unknown>; self: unknown };
    expect(out.level1.password).toBe('[REDACTED]');
    expect(out.level1.ok).toBe(1);
    // 循环引用不会导致无限递归（depth 上限）
    expect(out.self).toBeDefined();
  });

  it('Error 对象脱敏：message/stack 清洗（LG-22 相关）', () => {
    const err = new Error('连接失败 password=abc123');
    const out = redactObject(err) as { name: string; message: string };
    expect(out.message).toContain('[REDACTED]');
    expect(out.message).not.toContain('abc123');
  });
});

describe('redactText（文本级脱敏）', () => {
  it('Bearer <value> 替换（LG-19）', () => {
    expect(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('URL 中 user:pass@ 替换', () => {
    expect(redactText('mysql://root:pw123@host:3306/db')).toContain('[REDACTED]:[REDACTED]@');
    expect(redactText('mysql://root:pw123@host:3306/db')).not.toContain('pw123');
  });

  it('URL query 敏感参数替换', () => {
    const out = redactText('https://api.example.com/v1?token=abc123&page=2');
    expect(out).toContain('token=[REDACTED]');
    expect(out).not.toContain('abc123');
    expect(out).toContain('page=2'); // 非敏感参数保留
  });
});

describe('redactConnectionString（连接串摘要，LG-20）', () => {
  it('不出现完整原文，只含 driver/host/databaseHash', () => {
    const out = redactConnectionString('mysql://user:pass@10.0.0.1:3306/sales_db');
    expect(out).not.toContain('user');
    expect(out).not.toContain('pass');
    expect(out).not.toContain('sales_db');
    expect(out).toContain('mysql');
    expect(out).toContain('host');
  });

  it('空输入返回空串', () => {
    expect(redactConnectionString('')).toBe('');
  });
});

describe('safeStringify（循环引用安全，LG-22）', () => {
  it('循环引用对象不崩溃', () => {
    const obj: Record<string, unknown> = { a: 1 };
    (obj as { self?: unknown }).self = obj;
    const s = safeStringify(obj);
    expect(typeof s).toBe('string');
    expect(s).toContain('[Circular]');
  });

  it('正常对象正常序列化', () => {
    expect(safeStringify({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });
});

describe('shortHash（SQL/库名指纹，LG-21 相关）', () => {
  it('同输入同输出，不同输入大概率不同', () => {
    expect(shortHash('SELECT 1')).toBe(shortHash('SELECT 1'));
    expect(shortHash('SELECT 1')).not.toBe(shortHash('SELECT 2'));
    expect(shortHash('sales_db')).toMatch(/^sha256:[0-9a-f]{8}$/);
  });
});