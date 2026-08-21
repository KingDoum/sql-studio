/**
 * 结果展示纯逻辑（任务 10 ui-results，可单测）。
 *
 * - formatCell：结果单元格格式化（NULL → 「NULL」灰显；Uint8Array → 「[二进制 N 字节]」；
 *   大数/日期保持原文；布尔/数字转字符串）。
 * - compareCell：排序比较（NULL 恒小；数字按数值；其余 localeCompare）。
 * - isWriteStatement / hasWriteStatements：写入类 SQL 识别（执行前二次确认用）。
 * - MAX 常量：与主进程 MAX_RESULT_ROWS 对齐的展示提示。
 */
import type { CellValue } from '@shared/types';

/** 单元格 → 展示字符串。 */
/** ISO 日期时间正则（匹配 YYYY-MM-DDTHH:mm:ss 或 YYYY-MM-DD HH:mm:ss 格式）。 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

/** 浮点数保留最多 2 位小数，去尾零。 */
function fmtNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  // 保留两位小数，去尾零
  const s = v.toFixed(2);
  return s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

export function formatCell(value: CellValue | undefined | null): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Uint8Array) return `[二进制 ${value.byteLength} 字节]`;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    return fmtNumber(value);
  }
  const s = String(value);
  // 探测 ISO 日期字符串 → 转为本地可读格式（去掉末尾 .000Z 等，空格替代 T）
  if (ISO_DATE_RE.test(s)) {
    return s.replace(/T/, ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
  }
  return s;
}

/** 排序比较（NULL 恒小；数值按数；其余字符串）。 */
export function compareCell(a: CellValue | undefined, b: CellValue | undefined): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return -1;
  if (bNull) return 1;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return String(a).localeCompare(String(b));
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a);
  const bs = String(b);
  const an = Number(as);
  const bn = Number(bs);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && as.trim() !== '' && bs.trim() !== '') {
    return an - bn;
  }
  return as.localeCompare(bs);
}

/** 按列筛选（不区分大小写包含匹配；NULL 匹配「null」）。 */
export function matchesFilter(
  value: CellValue | undefined,
  keyword: string,
): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  return formatCell(value).toLowerCase().includes(kw);
}

/** 单条语句是否为写入类（执行前 UI 二次确认用）。 */
export function isWriteStatement(stmt: string): boolean {
  return /^\s*(insert|update|delete|drop|alter|create|truncate|rename|replace|call)\b/i.test(
    stmt,
  );
}

/** 一次执行（可能多语句）是否含写入类。 */
export function hasWriteStatements(statements: string[]): boolean {
  return statements.some(isWriteStatement);
}

/** 与主进程对齐的行数上限（展示提示用）。 */
export const MAX_RESULT_ROWS = 50_000;