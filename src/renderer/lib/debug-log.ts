/**
 * 调试日志收集（调试模式）。
 *
 * 渲染进程环形缓冲最多 DEBUG_LOG_LIMIT 条：
 *  - console.info/log/warn/error 转发
 *  - window.onerror / window.onunhandledrejection 捕获
 *  - 调试模式开启时显示到设置面板日志区，支持一键复制
 *
 * 只在首次调用 enableDebugLogging() 时做一次拦截（幂等），
 * 不投递到真实 console 的行为保持默认（同步转发，不吞日志）。
 */

export interface DebugLogEntry {
  /** 时间戳（ISO 字符串）。 */
  time: string;
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  /** 附加对象（可选，JSON 序列化）。 */
  detail?: string;
}

const DEBUG_LOG_LIMIT = 800;

const entries: DebugLogEntry[] = [];

let installed = false;

function push(level: DebugLogEntry['level'], message: string, detail?: unknown): void {
  const detailStr = detail === undefined ? undefined : safeJson(detail);
  entries.push({ time: new Date().toISOString(), level, message, detail: detailStr });
  if (entries.length > DEBUG_LOG_LIMIT) entries.splice(0, entries.length - DEBUG_LOG_LIMIT);
}

function safeJson(v: unknown): string {
  // Error 的 message/stack 是不可枚举属性，JSON.stringify 会变成 {}，必须显式提取
  if (v instanceof Error) {
    return v.stack ?? `${v.name}: ${v.message}`;
  }
  if (v && typeof v === 'object' && 'reason' in (v as Record<string, unknown>)) {
    const r = (v as { reason?: unknown }).reason;
    if (r instanceof Error) return r.stack ?? `${r.name}: ${r.message}`;
  }
  try {
    const s = JSON.stringify(v);
    return s && s.length > 2000 ? `${s.slice(0, 2000)}…` : (s ?? String(v));
  } catch {
    return String(v);
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      return safeJson(a);
    })
    .join(' ');
}

/** 拦截 console / 全局错误（幂等）。 */
export function enableDebugLogging(): void {
  if (installed) return;
  installed = true;

  const wrap = (level: DebugLogEntry['level'], orig: (...a: unknown[]) => void) => {
    return (...args: unknown[]): void => {
      push(level, formatArgs(args));
      orig.apply(console, args);
    };
  };

  console.log = wrap('log', console.log);
  console.info = wrap('info', console.info);
  console.warn = wrap('warn', console.warn);
  console.error = wrap('error', console.error);

  window.addEventListener('error', (e) => {
    push('error', `window.onerror: ${e.message}`, e.error);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    push('error', `unhandledrejection: ${r instanceof Error ? (r.stack ?? r.message) : safeJson(r)}`);
  });
}

/** 调试模式开启时调用（幂等拦截）。 */
export function ensureDebugLogging(enabled: boolean): void {
  if (enabled) enableDebugLogging();
  // 关闭时保持缓冲（不丢历史），只是不显示
}

export function getDebugLogEntries(): DebugLogEntry[] {
  return [...entries];
}

/** 清空日志缓冲（调试用）。 */
export function clearDebugLogs(): void {
  entries.length = 0;
}

/**
 * 北京时间（UTC+8，Asia/Shanghai）格式化（阶段 4 修复：不再直接显示 UTC）。
 * 内部 DebugLogEntry.time 继续保存 ISO UTC，仅展示时转北京时间。
 * 输出形如 `2026-09-01 11:48:34.647`（毫秒保留）。
 */
export function formatBeijingTime(isoTime: string): string {
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return isoTime; // 非法时间原样返回
  const part = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => part.find((p) => p.type === type)?.value ?? '';
  // zh-CN + hour12:false 个别 ICU 对午夜可能输出 24:xx，归一为 00:xx 与日期保持一致
  const hour = get('hour') === '24' ? '00' : get('hour');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}.${ms}`;
}

/** 单条日志的展示行（北京时间 + 级别 + 消息）。 */
export function formatLogEntryLine(e: DebugLogEntry): string {
  return `[${formatBeijingTime(e.time)}] [${e.level.toUpperCase()}] ${e.message}${e.detail ? ` | ${e.detail}` : ''}`;
}

/** 生成可复制的纯文本日志（标题与条目均使用北京时间）。 */
export function formatDebugLogText(limit = 500): string {
  const tail = entries.slice(-limit);
  const lines = tail.map(formatLogEntryLine);
  const header = `SQL Studio 调试日志（北京时间 ${formatBeijingTime(new Date().toISOString())}）\n共 ${tail.length} 条\n${'─'.repeat(60)}\n`;
  return header + lines.join('\n');
}
