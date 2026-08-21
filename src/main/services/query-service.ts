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

/** 底层执行函数返回的原始结果集。 */
export interface RawResultSet {
  rows: Record<string, unknown>[];
  fields: unknown;
  affectedRows: number;
  isWrite: boolean;
}

/** 执行函数签名（由 ConnectionManager 或 mock 提供）。 */
export type QueryExecutor = (sql: string) => Promise<RawResultSet[]>;

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

/** 判断单条语句是否为写类（非 SELECT/SHOW/EXPLAIN/DESCRIBE/USE/SET 等只读）。 */
export function isWriteStatement(stmt: string): boolean {
  const s = stmt.trim().replace(/^\(+/, '');
  const m = s.match(/^([a-zA-Z]+)/);
  if (!m) return false;
  const kw = m[1].toUpperCase();
  const readOnly = new Set([
    'SELECT',
    'SHOW',
    'EXPLAIN',
    'DESCRIBE',
    'DESC',
    'USE',
    'SET',
    'CALL',
    'WITH',
  ]);
  return !readOnly.has(kw);
}

/** 从 mysql2 fields 元信息提取 ColumnMeta[]。 */
function extractColumns(fields: unknown): ColumnMeta[] {
  if (!Array.isArray(fields)) return [];
  return (fields as Array<Record<string, unknown>>).map((f) => {
    const name = String(f.name ?? f.column ?? '');
    const type = String(f.type ?? f.dbType ?? 'unknown');
    return {
      name,
      type: normalizeType(type),
      nullable: f.nullable !== false,
      isPrimary: Boolean(f.primaryKey),
      isUnique: Boolean(f.unique),
      defaultValue: (f.defaultValue as string | null) ?? null,
      comment: typeof f.comment === 'string' ? f.comment : undefined,
      charset: typeof f.charset === 'string' ? f.charset : undefined,
    } satisfies ColumnMeta;
  });
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

/** 把一行记录转为 CellValue[][]（NULL→null，Buffer→Uint8Array，其余保持）。 */
function rowsToCells(rows: Record<string, unknown>[]): CellValue[][] {
  return rows.map((row) => {
    return Object.keys(row).map((k) => {
      const v = row[k];
      if (v === null || v === undefined) return null;
      if (typeof v === 'object' && v instanceof Uint8Array) return v;
      if (typeof v === 'object' && typeof (v as { length?: number }).length === 'number' && (v as { constructor?: { name?: string } }).constructor?.name === 'Buffer') {
        return new Uint8Array((v as Uint8Array).buffer ?? (v as unknown as Uint8Array));
      }
      if (typeof v === 'object') return JSON.stringify(v);
      return v as CellValue;
    });
  });
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
      rawSets = await this.executor(sql);
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
        elapsedMs: 0,
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
