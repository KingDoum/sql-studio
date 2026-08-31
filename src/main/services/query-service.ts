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
      ? mysql2TypeToName(rawType)
      : normalizeType(String(rawType));
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

/** mysql2 数字类型码 → 可读类型名（QueryService 查询结果的 f.type 是数字）。 */
function mysql2TypeToName(code: number): string {
  switch (code) {
    case 0: case 246: return 'decimal';
    case 1: return 'tinyint';
    case 2: return 'smallint';
    case 3: return 'int';
    case 4: return 'float';
    case 5: return 'double';
    case 7: case 12: return 'datetime';
    case 8: return 'bigint';
    case 9: return 'mediumint';
    case 10: return 'date';
    case 11: return 'time';
    case 13: return 'year';
    case 15: case 253: return 'varchar';
    case 16: return 'bit';
    case 245: return 'json';
    case 247: return 'enum';
    case 248: return 'set';
    case 249: case 250: case 251: case 252: return 'blob';
    case 254: return 'char';
    case 255: return 'geometry';
    default: return 'unknown';
  }
}

/** 把 mysql2 类型名粗略归一为 ColumnType。 */
function normalizeType(raw: string): ColumnMeta['type'] {
  const t = raw.toLowerCase();
  if (t.includes('int')) return t.includes('big') ? 'bigint' : 'int';
  if (t.includes('decimal') || t.includes('numeric')) return 'decimal';
  if (t.includes('float')) return 'float';
  if (t.includes('double')) return 'double';
  if (t.includes('varchar')) return 'varchar';
  if (t.includes('char') && !t.includes('varchar')) return 'char';
  if (t.includes('text') || t.includes('blob') && t.includes('long')) return 'text';
  if (t.includes('blob')) return 'blob';
  if (t.includes('datetime')) return 'datetime';
  if (t.includes('timestamp')) return 'timestamp';
  if (t.includes('date')) return 'date';
  if (t.includes('time')) return 'time';
  if (t.includes('json')) return 'json';
  if (t.includes('bool')) return 'boolean';
  if (t.includes('enum')) return 'enum';
  return raw;
}

/** 把一行记录转为 CellValue[][]（NULL→null，Buffer→Uint8Array，Date→本地可读，其余保持）。 */
function rowsToCells(rows: Record<string, unknown>[]): CellValue[][] {
  return rows.map((row) => {
    return Object.keys(row).map((k) => {
      const v = row[k];
      if (v === null || v === undefined) return null;
      if (v instanceof Date) return formatDateLocal(v);
      if (typeof v === 'object' && v instanceof Uint8Array) return v;
      if (typeof v === 'object' && typeof (v as { length?: number }).length === 'number' && (v as { constructor?: { name?: string } }).constructor?.name === 'Buffer') {
        return new Uint8Array((v as Uint8Array).buffer ?? (v as unknown as Uint8Array));
      }
      if (typeof v === 'object') return JSON.stringify(v);
      return v as CellValue;
    });
  });
}

/** Date → 本地可读字符串（YYYY-MM-DD HH:mm:ss；DATE 类仅显示日期部分）。 */
export function formatDateLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // 无时间部分（时分秒均为 0 且原值只含日期）→ 只显示日期
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0) {
    return datePart;
  }
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
      const allRows = rowsToCells(set.rows);
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
