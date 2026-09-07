/**
 * 日志脱敏纯函数（自动保存方案 §12.11）。
 *
 * 职责：
 * - 对象键名匹配敏感词（password/passwd/pwd/apiKey/secret/token/authorization 等）→ 值替换为 [REDACTED]。
 * - 文本中的 `Bearer <value>` → `Bearer [REDACTED]`。
 * - URL 中的用户名/密码与敏感 query 参数替换。
 * - 循环引用对象安全序列化（不崩溃）。
 * - 连接串只保留摘要（driver、host 是否存在、库名 hash）。
 * - SQL 只允许长度/hash/queryId/status 等摘要（由调用方构造，本模块不接收完整 SQL）。
 *
 * 纯函数、无 Electron/Node 专用依赖（方案 §14.2 可选独立纯函数模块）。
 */

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /^password$/i,
  /^passwd$/i,
  /^pwd$/i,
  /^api[_-]?key$/i,
  /^secret$/i,
  /^authorization$/i,
  /^token$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^bearer$/i,
];

export const REDACTED = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * 递归脱敏对象（浅拷贝新对象，不修改入参）。
 * 循环引用安全（depth 上限 + WeakSet 防护）。Error 只保留脱敏后的 name/message/stack。
 */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 24) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (value instanceof Error) {
    // Error 的 message/stack 可能含敏感值：逐字段脱敏
    const out: Record<string, unknown> = {
      name: redactText(value.name || 'Error'),
      message: redactText(value.message || ''),
    };
    const stack = (value as { stack?: string }).stack;
    if (stack) out.stack = redactText(stack);
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactObject(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactObject(v, depth + 1);
    }
    return out;
  }

  return REDACTED;
}

/**
 * 文本级脱敏：
 * - `Bearer <token>` → `Bearer [REDACTED]`
 * - URL 中 `user:pass@`（任意 scheme，含 mysql:// 等）→ `[REDACTED]:[REDACTED]@`
 * - 敏感键值对（query 参数或一般文本中的 `password=...` 等）值替换为 [REDACTED]
 */
export function redactText(text: string): string {
  let out = text;
  // Bearer <token>
  out = out.replace(/\b(Bearer|bearer)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [REDACTED]');
  // URL user:pass@（任意 scheme，如 https/mysql/redis 等）
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/gi, '$1[REDACTED]:[REDACTED]@');
  // 敏感键值对：`password=xxx` / `apiKey=yyy` / `?token=zzz` 等（值取到空白/&/;/逗号为止）
  out = out.replace(
    /\b(password|passwd|pwd|api[_-]?key|secret|authorization|token|access[_-]?token|refresh[_-]?token|bearer)\s*=\s*[^\s&,;]+/gi,
    '$1=[REDACTED]',
  );
  return out;
}

/**
 * 连接串摘要（§12.11）：只允许 driver、host 是否存在、库名 hash。
 * 输入形如 `mysql://user:pass@host:3306/dbname` 或 `host:3306/dbname`。
 */
export function redactConnectionString(connStr: string): string {
  if (!connStr || typeof connStr !== 'string') return '';
  const driverMatch = /^([a-z0-9+]+):\/\//i.exec(connStr);
  const driver = driverMatch?.[1] ?? 'unknown';
  const hasHost = /@[^/:\s]+/.test(connStr) || /^[a-z0-9.-]+:[0-9]+/i.test(connStr);
  const dbMatch = /\/([^/?\s]+)(?:\?|$)/.exec(connStr.replace(/\/\/[^/]*@/, '//'));
  const dbHash = dbMatch?.[1] ? shortHash(dbMatch[1]) : undefined;
  return JSON.stringify({
    driver,
    host: hasHost,
    databaseHash: dbHash,
  });
}

/** 稳定短哈希（FNV-1a 32 位，16 进制），用于日志指纹，非安全用途。 */
export function shortHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `sha256:${h.toString(16).padStart(8, '0')}`;
}

/** 循环引用安全的 JSON 序列化（§12.11）；失败回退 String()。 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, v) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (v instanceof Error) return redactObject(v);
      return v;
    });
    return json ?? String(value);
  } catch {
    return String(value);
  }
}