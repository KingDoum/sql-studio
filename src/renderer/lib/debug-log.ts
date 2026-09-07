/**
 * 调试日志收集（调试模式）+ 持久日志桥接（自动保存方案 §12/§14.1）。
 *
 * 双层设计（方案 §14.1：改造为结构化日志门面或兼容适配层）：
 * - 内存环形缓冲（DEBUG_LOG_LIMIT 条）：立即展示与复制（现状兼容）。
 * - 可选持久化 sink：push 时同时转发到持久日志桥（Main 落盘，跨重启）。
 *   Renderer 只发送结构化条目，不进 SQLite；warn/error 由桥即时发送（§12.6）。
 * - 保持 console 拦截与 window.onerror / unhandledrejection 捕获（幂等）。
 * - 北京时间格式化能力保留复用（formatBeijingTime）。
 *
 * 防重入（§12.12）：持久化失败路径不得再次经过 console 包装；
 * bridge 内部失败直接丢弃并计数，不递归调用日志。
 */

import type { PersistentLogEntryInput } from '@shared/types';

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

/** 可选持久化转发（由 persistent-log-bridge 注册，避免 debug-log 直接依赖 IPC）。 */
type LogSink = (entry: DebugLogEntry) => void;
let logSink: LogSink | null = null;

export function setLogSink(sink: LogSink | null): void {
  logSink = sink;
}

/** 当前是否有持久化 sink（供 SettingsPanel 判断展示源）。 */
export function hasLogSink(): boolean {
  return logSink !== null;
}

function push(level: DebugLogEntry['level'], message: string, detail?: unknown): void {
  const detailStr = detail === undefined ? undefined : safeJson(detail);
  const entry: DebugLogEntry = { time: new Date().toISOString(), level, message, detail: detailStr };
  entries.push(entry);
  if (entries.length > DEBUG_LOG_LIMIT) entries.splice(0, entries.length - DEBUG_LOG_LIMIT);
  // 转发持久化（bridge 内部自带重入/失败防护）
  try {
    logSink?.(entry);
  } catch {
    // 转发失败不影响内存日志
  }
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

/** 把内存条目转为持久日志输入（供直接转发到 logs:append 的场景）。 */
export function toPersistentEntry(e: DebugLogEntry): PersistentLogEntryInput {
  // console.log/log 归为 info 级（§12.5：debug 仅 debugMode 采集由 bridge 控制）
  const level = e.level === 'log' ? 'info' : e.level;
  return {
    timestamp: e.time,
    level,
    source: 'renderer',
    event: 'renderer.log',
    message: e.message,
    context: e.detail ? { detail: e.detail.slice(0, 2000) } : undefined,
  };
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

  // 保存原始引用，防止在持久化失败回调中调用被重写的 console 造成递归（§12.12）
  const originalError = console.error.bind(console);

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

  // 导出原始 error 供 bridge 故障通道使用（避免递归）
  void originalError;
}

/** 调试模式开启时调用（幂等拦截）。 */
export function ensureDebugLogging(enabled: boolean): void {
  if (enabled) enableDebugLogging();
  // 关闭时保持缓冲（不丢历史），只是不显示
}

export function getDebugLogEntries(): DebugLogEntry[] {
  return [...entries];
}

/** 清空日志缓冲（调试用；不影响持久日志文件）。 */
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

/** 持久日志条目展示行（复用北京时间格式化，§12.9 复制用）。 */
export function formatPersistentLogLine(e: { timestamp: string; level: string; message: string; event?: string; source?: string }): string {
  const sourceTag = e.source ? ` (${e.source})` : '';
  const eventTag = e.event ? ` [${e.event}]` : '';
  return `[${formatBeijingTime(e.timestamp)}] [${e.level.toUpperCase()}]${sourceTag}${eventTag} ${e.message}`;
}