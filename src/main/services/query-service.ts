/**
 * 查询服务（任务 5 main-schema-query 的一部分）。
 *
 * 职责：
 *   1. 接收（可能含多条语句的）SQL，按语句拆分用于「陈述展示」。
 *   2. 调用底层执行函数拿到多结果集（RawResultSet[]）。
 *   3. 对每个结果集做：列元信息提取、行数上限截断（MAX_RESULT_ROWS）、耗时统计。
 *   4. 聚合为 QueryResult（多结果集 + 总耗时 + 截断/写类标记）。
 *   5. 支持取消执行（AbortSignal）。
 *
 * 依赖注入：构造时传入 `executor`——(sql) => Promise<RawResultSet[]>。
 * 真实环境由 ConnectionManager.executeMany 提供；单测注入 mock，无需真实 MySQL。
 *
 * 铁律 R3（完成门槛）：单测覆盖上限截断、多语句拆分、错误分支、耗时统计。
 */

import type {
  ColumnMeta,
  QueryRequest,
  QueryResultSet,
  QueryResult,
  CellValue,
} from '@shared/types';
import { classifyStatement } from '@shared/sql-classify';
import { columnTypeFromCode, columnTypeFromRaw } from '@shared/column-type';

/** 底层执行函数返回的原始结果集。 */
export interface RawResultSet {
  rows: Record<string, unknown>[];
  fields: unknown;
  affectedRows: number;
  isWrite: boolean;
}

/** 执行函数签名（由 ConnectionManager 或 mock 提供）。 */
export type QueryExecutor = (sql: string, signal?: AbortSignal) => Promise<RawResultSet[]>;

/** 主进程常量（铁律 R5：单一来源）。 */
export const QUERY_CONFIG = {
  /** 单次查询结果集行数上限，超过则截断并标记 truncated（与渲染进程 MAX_RESULT_ROWS 5万一致）。 */
  MAX_RESULT_ROWS: 50_000,
} as const;

/**
 * 把一条 SQL 文本粗略拆分为多条语句（用于展示 statement 与判定写类）。
 * 仅按顶层 `;` 切分，忽略引号内与行内/块注释内的分号。
 */
export function splitStatements(sql: string): string[] {
  const stmts: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  const chars = sql.split('');
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1] ?? '';
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        buf += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    // 注释检测必须在引号之后：字符串内的 -- / # 不触发
    if (!inSingle && !inDouble) {
      if (ch === '-' && next === '-') {
        inLineComment = true;
        i++;
        continue;
      }
      if (ch === '#') {
        inLineComment = true;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
    }
    if (ch === ';' && !inSingle && !inDouble) {
      const trimmed = buf.trim();
      if (trimmed) stmts.push(trimmed);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const last = buf.trim();
  if (last) stmts.push(last);
  return stmts;
}

/**
 * 判断单条语句是否为写类（非只读即写；无法确定的按高风险处理）。
 * 委托共享分类模块（@shared/sql-classify），与 Renderer 提示保持一致。
 */
export function isWriteStatement(stmt: string): boolean {
  return classifyStatement(stmt) !== 'read';
}

/** 从 mysql2 fields 元信息提取 ColumnMeta[]。 */
function extractColumns(fields: unknown): ColumnMeta[] {
  if (!Array.isArray(fields)) return [];
  return (fields as Array<Record<string, unknown>>).map((f) => {
    const name = String(f.name ?? f.column ?? '');
    const rawType = f.type ?? f.dbType ?? 'unknown';
    const type = typeof rawType === 'number'
      ? columnTypeFromCode(rawType)
      : columnTypeFromRaw(String(rawType));
    return {
      name,
      type,
      nullable: f.nullable !== false,
      isPrimary: Boolean(f.primaryKey),
      isUnique: Boolean(f.unique),
      defaultValue: (f.defaultValue as string | null) ?? null,
      comment: typeof f.comment === 'string' ? f.comment : undefined,
      charset: typeof f.charset === 'string' ? f.charset : undefined,
      // 结果集字段来源表名（mysql2 field.table/orgTable），供主进程回填列注释
      tableName: (f.orgTable as string | undefined) ?? (f.table as string | undefined),
    } satisfies ColumnMeta;
  });
}

// 列类型归一化统一在 @shared/column-type（columnTypeFromCode / columnTypeFromRaw），
// 本文件不再自行实现，避免与对象浏览器字段列表的类型名漂移。

/**
 * 列类型是否为 MySQL BIT（`bit` / `bit(1)` / `bit(8)` 等）。
 * 注意 `\b` 边界：避免误匹配 `bitmap` 这类非 BIT 类型。
 */
function isBitColumn(type?: string): boolean {
  return typeof type === 'string' && /^bit\b/i.test(type.trim());
}

/**
 * BIT 字节（大端）→ 数值；超出安全整数范围返回 null。
 * mysql2 对 BIT(n) 统一返回 ceil(n/8) 字节的大端 Buffer，
 * 6 字节（48bit）以内可无精度损失地转成 number；更长则保持二进制。
 */
function bitBytesToNumber(bytes: Uint8Array): number | null {
  if (bytes.length === 0 || bytes.length > 6) return null;
  let n = 0;
  for (let i = 0; i < bytes.length; i++) n = n * 256 + bytes[i];
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 把一行记录转为 CellValue[][]（NULL→null，Buffer→Uint8Array，Date→本地可读，其余保持）。
 * 传入 columns 以便按「列类型」决定日期格式（DATE 只显示日期、DATETIME 保留时间）
 * 以及 BIT 列归一化。
 */
function rowsToCells(rows: Record<string, unknown>[], columns: ColumnMeta[] = []): CellValue[][] {
  return rows.map((row) => {
    return Object.keys(row).map((k, ci) => {
      const v = row[k];
      if (v === null || v === undefined) return null;
      if (v instanceof Date) return formatDateLocal(v, columns[ci]?.type);
      // Buffer 是 Uint8Array 的子类，统一在这一条路径处理（历史实现的 Buffer 分支不可达）。
      // 复制为等长副本：不能返回 v.buffer —— 那会丢掉 byteOffset/byteLength，
      // Buffer 切片会读到整个底层内存池的数据。
      if (v instanceof Uint8Array) {
        // BIT 列按 MySQL 语义显示为数值（BIT(1) → 0/1），而不是「[二进制 N 字节]」。
        // 在此处归一化的收益：网格、数据预览、Excel/CSV/SQL 导出共用同一结果。
        const bit = isBitColumn(columns[ci]?.type) ? bitBytesToNumber(v) : null;
        return bit !== null ? bit : new Uint8Array(v);
      }
      if (typeof v === 'object') return JSON.stringify(v);
      return v as CellValue;
    });
  });
}

/**
 * Date → 本地可读字符串（YYYY-MM-DD HH:mm:ss；DATE 类型仅显示日期部分）。
 *
 * 是否省略时间**按列类型判断**：mysql2 把 DATE 与 DATETIME 都转成 Date，
 * 无法从值本身区分列类型。历史实现用「时分秒是否为 0」推断，
 * 会把真实的 00:00:00 误显示成纯日期（丢时间信息）。
 * `columnType` 缺省时保留旧启发式，兼容未传列类型的调用点。
 */
export function formatDateLocal(d: Date, columnType?: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dateOnly =
    columnType === 'date' ||
    (columnType === undefined &&
      d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0);
  if (dateOnly) return datePart;
  return `${datePart} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class QueryService {
  private readonly executor: QueryExecutor;
  private readonly maxRows: number;

  constructor(executor: QueryExecutor, options?: { maxRows?: number }) {
    this.executor = executor;
    this.maxRows = options?.maxRows ?? QUERY_CONFIG.MAX_RESULT_ROWS;
  }

  /**
   * 执行 SQL 并返回多结果集聚合。
   * @param req 含 connectionId / sql / 可选 statement（选区）
   * @param signal 取消信号
   */
  async run(req: QueryRequest, signal?: AbortSignal): Promise<QueryResult> {
    const sql = req.statement ?? req.sql;
    const started = Date.now();
    let rawSets: RawResultSet[] = [];
    try {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      rawSets = await this.executor(sql, signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw err;
    }
    const statements = splitStatements(sql);
    const resultSets: QueryResultSet[] = rawSets.map((set, idx) => {
      const columns = extractColumns(set.fields);
      const allRows = rowsToCells(set.rows, columns);
      const truncated = allRows.length > this.maxRows;
      const rows = truncated ? allRows.slice(0, this.maxRows) : allRows;
      const stmtText = statements[idx] ?? (idx === 0 ? sql.trim() : '');
      return {
        index: idx,
        statement: stmtText.slice(0, 200),
        columns,
        rows,
        affectedRows: set.affectedRows,
        truncated,
        // 该结果集完成归一化时相对查询开始的累计耗时（毫秒）。
        // 语义：由于多语句是单次往返执行，无法逐语句拆分执行时间，
        // elapsedMs 单调递增趋近 totalElapsedMs（最后一个 ≈ totalElapsedMs）。
        elapsedMs: Date.now() - started,
      } satisfies QueryResultSet;
    });
    const totalElapsedMs = Date.now() - started;
    const anyTruncated = resultSets.some((r) => r.truncated);
    const hasWrite = rawSets.some((s) => s.isWrite) || statements.some(isWriteStatement);
    return {
      connectionId: req.connectionId,
      resultSets,
      totalElapsedMs,
      truncated: anyTruncated,
      hasWrite,
    };
  }
}
