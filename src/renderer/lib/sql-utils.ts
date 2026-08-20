/**
 * SQL 文本工具（任务 9 ui-editor 纯逻辑，可单测）。
 *
 * 职责：
 *  - splitStatements：按语句分隔符拆分多语句 SQL（识别引号/注释，不在其中切分）。
 *  - getCurrentStatement：给定光标偏移，取光标所在的完整语句（Ctrl+Enter 执行用）。
 *  - buildSelectSql：对象树双击表生成 `SELECT * FROM \`db\`.\`table\`;`。
 *
 * 状态扫描：scanCodeState 逐字符标记每个位置是否处于引号/注释内，
 * 所有边界判断（; 切分）都基于该状态，避免把字符串/注释里的分号当分隔符。
 */

export type SqlCodeState =
  | 0 // code
  | 1 // 单引号字符串
  | 2 // 双引号字符串
  | 3 // 反引号标识符
  | 4 // 行注释 -- 到行尾
  | 5; // 块注释 /* */

/** 逐字符标记 SQL 各位置的代码状态（与输入等长）。 */
export function scanCodeState(sql: string): SqlCodeState[] {
  const states: SqlCodeState[] = new Array(sql.length).fill(0);
  let state: SqlCodeState = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    switch (state) {
      case 0:
        if (ch === "'") state = 1;
        else if (ch === '"') state = 2;
        else if (ch === '`') state = 3;
        else if (ch === '-' && next === '-') {
          state = 4;
          i++; // 消费 --
        } else if (ch === '/' && next === '*') {
          state = 5;
          i++;
        }
        break;
      case 1:
        if (ch === '\\') i++; // 转义
        else if (ch === "'") state = 0;
        break;
      case 2:
        if (ch === '\\') i++;
        else if (ch === '"') state = 0;
        break;
      case 3:
        if (ch === '`') state = 0;
        break;
      case 4:
        if (ch === '\n') state = 0;
        break;
      case 5:
        if (ch === '*' && next === '/') {
          state = 0;
          i++;
        }
        break;
    }
    states[i] = state;
  }
  return states;
}

/** 是否语句分隔符位置（状态为 code 且字符为 ;）。 */
function isSemicolon(sql: string, states: SqlCodeState[], i: number): boolean {
  return sql[i] === ';' && states[i] === 0;
}

/** 按 ; 拆分为非空语句列表（自动去除注释/空白后为空的分段）。 */
export function splitStatements(sql: string): string[] {
  const states = scanCodeState(sql);
  const result: string[] = [];
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    if (isSemicolon(sql, states, i)) {
      const stmt = sql.slice(start, i).trim();
      if (stmt) result.push(stmt);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

/** 取 offset 处所在的完整语句（不含前后分号），无则返回空串。 */
export function getCurrentStatement(sql: string, offset: number): string {
  if (!sql || offset < 0) return '';
  if (offset > sql.length) offset = sql.length;
  const states = scanCodeState(sql);
  let start = 0;
  let end = sql.length;
  for (let i = offset - 1; i >= 0; i--) {
    if (isSemicolon(sql, states, i)) {
      start = i + 1;
      break;
    }
  }
  for (let i = offset; i < sql.length; i++) {
    if (isSemicolon(sql, states, i)) {
      end = i;
      break;
    }
  }
  return sql.slice(start, end).trim();
}

/** 反引号转义（MySQL 内嵌反引号写作 ``）。 */
export function escapeIdent(name: string): string {
  return name.replace(/`/g, '``');
}

/** 对象树双击表生成 SELECT（任务 8 验收：双击表生成 SELECT 到编辑器）。 */
export function buildSelectSql(database: string, table: string): string {
  return `SELECT * FROM \`${escapeIdent(database)}\`.\`${escapeIdent(table)}\`;`;
}

/** 从文件路径取显示名（末段文件名）。 */
export function basename(filePath: string): string {
  const seg = filePath.split(/[\\/]/).filter(Boolean);
  return seg[seg.length - 1] ?? filePath;
}