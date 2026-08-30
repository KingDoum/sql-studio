/**
 * SQL 语句风险分类（无 Electron 依赖，Main / Renderer / Shared 共用）。
 *
 * 目的：统一 Renderer 的“执行前写操作确认”与 Main 的“写操作标记 / 安全边界”，
 * 避免两处正则各自为政导致 CTE 包裹写操作、前置注释等被漏判
 * （对齐 docs/后续AI执行指令.md S3）。
 *
 * 策略：
 * - 明确只读：SELECT / SHOW / EXPLAIN / DESCRIBE / DESC / USE / SET / PRAGMA
 * - 明确写：INSERT / UPDATE / DELETE / REPLACE / ALTER / DROP / TRUNCATE /
 *   CREATE / RENAME / GRANT / REVOKE / LOCK / UNLOCK / LOAD
 * - WITH：解析 CTE 头后取主体语句第一关键字分类
 *   （WITH ... SELECT 只读；WITH ... INSERT/UPDATE/DELETE 写）
 * - CALL / 无法识别的关键字：unknown（高风险，要求确认路径，不直接放行）
 * - 空串 / 纯注释 / 纯空白：read（无操作）
 *
 * 声明：本模块不做“覆盖完整 SQL 方言”的承诺，复杂方言按 unknown 保守处理。
 */

export type SqlClass = 'read' | 'write' | 'unknown';

/** 明确只读的关键字集合。 */
const READ_ONLY_KEYWORDS = new Set([
  'SELECT',
  'SHOW',
  'EXPLAIN',
  'DESCRIBE',
  'DESC',
  'USE',
  'SET',
  'PRAGMA',
]);

/** 明确写入的关键字集合。 */
const WRITE_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'CREATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'LOCK',
  'UNLOCK',
  'LOAD',
]);

/** 标识符开头（字母或下划线）。 */
const IDENT_START = /[A-Za-z_]/;
/** 标识符字符。 */
const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * 从 pos 起跳过空白与注释（-- / # / /* * /），返回下一个有效位置。
 * 不跨越括号。
 */
function skipWsAndComments(sql: string, pos: number): number {
  const n = sql.length;
  let i = pos;
  let changed = true;
  while (changed) {
    changed = false;
    while (i < n && /\s/.test(sql[i])) i++;
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      changed = true;
    } else if (sql[i] === '#') {
      while (i < n && sql[i] !== '\n') i++;
      changed = true;
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      changed = true;
    }
  }
  return i;
}

/**
 * 从 sql[pos]（应为 '('）开始匹配配对的右括号下标，忽略字符串与注释内的括号。
 * 返回右括号下标；未闭合返回 -1。
 */
function matchParen(sql: string, pos: number): number {
  const n = sql.length;
  let depth = 0;
  let i = pos;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLine = false;
  let inBlock = false;
  while (i < n) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (inLine) {
      if (ch === '\n') inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && nx === '/') {
        inBlock = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (inBacktick) {
      if (ch === '`') inBacktick = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      i++;
      continue;
    }
    if (ch === '-' && nx === '-') {
      inLine = true;
      i += 2;
      continue;
    }
    if (ch === '#') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && nx === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      i++;
      if (depth === 0) return i - 1;
      continue;
    }
    i++;
  }
  return -1;
}

/** 读取从 pos 开始的一个标识符（字母/下划线开头），返回 [单词, 结束位置] 或 null。 */
function readIdent(sql: string, pos: number): [string, number] | null {
  if (pos >= sql.length || !IDENT_START.test(sql[pos])) return null;
  let i = pos;
  while (i < sql.length && IDENT_CHAR.test(sql[i])) i++;
  return [sql.slice(pos, i), i];
}

/**
 * 从 sql 中取第一个“有效关键字”（跳过前置空白、注释与括号）。
 * 返回大写关键字；找不到返回 null（纯注释/空白或无法识别）。
 */
export function firstKeyword(sql: string): string | null {
  const n = sql.length;
  let i = skipWsAndComments(sql, 0);
  // 跳过任意数量的前置括号（如 `(SELECT ...)` 或 `((WITH ...))`）
  while (i < n && sql[i] === '(') {
    i = skipWsAndComments(sql, i + 1);
  }
  const ident = readIdent(sql, i);
  return ident ? ident[0].toUpperCase() : null;
}

/**
 * 对以 WITH 开头的语句，解析 CTE 头（[RECURSIVE] name AS (…) 列表）后
 * 返回主体语句的第一个关键字（大写）；解析失败返回 null。
 */
function cteBodyKeyword(sql: string): string | null {
  const n = sql.length;
  let i = skipWsAndComments(sql, 0);
  // 跳过 WITH
  const withIdent = readIdent(sql, i);
  if (!withIdent || withIdent[0].toUpperCase() !== 'WITH') return null;
  i = withIdent[1];
  i = skipWsAndComments(sql, i);
  // 可选 RECURSIVE
  const rec = readIdent(sql, i);
  if (rec && rec[0].toUpperCase() === 'RECURSIVE') {
    i = skipWsAndComments(sql, rec[1]);
  }
  // 循环解析 CTE：name AS ( ... ) [, name AS ( ... )]*
  for (;;) {
    // CTE 名（标识符或反引号包裹）
    const namePos = skipWsAndComments(sql, i);
    const nameIdent = readIdent(sql, namePos);
    if (!nameIdent) return null;
    i = skipWsAndComments(sql, nameIdent[1]);
    // AS
    const asIdent = readIdent(sql, i);
    if (!asIdent || asIdent[0].toUpperCase() !== 'AS') return null;
    i = skipWsAndComments(sql, asIdent[1]);
    // (
    if (sql[i] !== '(') return null;
    const close = matchParen(sql, i);
    if (close === -1) return null;
    i = skipWsAndComments(sql, close + 1);
    // 逗号 → 下一个 CTE；否则主体第一关键字
    if (sql[i] === ',') {
      i = skipWsAndComments(sql, i + 1);
      continue;
    }
    const body = readIdent(sql, i);
    return body ? body[0].toUpperCase() : null;
  }
}

/** 对单个关键字做风险分类（不含 WITH 特判）。 */
function classifyKeyword(kw: string): SqlClass {
  if (READ_ONLY_KEYWORDS.has(kw)) return 'read';
  if (WRITE_KEYWORDS.has(kw)) return 'write';
  return 'unknown';
}

/**
 * 对单条 SQL 语句分类。
 * 空串 / 纯注释 / 纯空白视为 read（无操作）。
 */
export function classifyStatement(sql: string): SqlClass {
  if (!sql || !sql.trim()) return 'read';
  const kw = firstKeyword(sql);
  if (!kw) return 'read'; // 纯注释或空白，无操作
  if (kw === 'WITH') {
    const body = cteBodyKeyword(sql);
    if (!body) return 'unknown'; // CTE 头解析失败，保守高风险
    return classifyKeyword(body);
  }
  return classifyKeyword(kw);
}

/**
 * 对多语句（数组）分类：任一为 write → write；否则任一 unknown → unknown；
 * 全部 read → read。供“执行前是否需要确认”使用。
 */
export function classifyStatements(statements: string[]): SqlClass {
  let hasUnknown = false;
  for (const stmt of statements) {
    const c = classifyStatement(stmt);
    if (c === 'write') return 'write';
    if (c === 'unknown') hasUnknown = true;
  }
  return hasUnknown ? 'unknown' : 'read';
}

/** 是否明确写操作（不含 unknown，用于既有 isWriteStatement 语义兼容）。 */
export function isExplicitWrite(sql: string): boolean {
  return classifyStatement(sql) === 'write';
}

/** 是否触发写操作确认（write 或 unknown 都返回 true）。 */
export function requiresWriteConfirm(statements: string[]): boolean {
  return classifyStatements(statements) !== 'read';
}
