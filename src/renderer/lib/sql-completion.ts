/**
 * SchemaCompletionProvider（任务 9：V1 规则补全，可插拔接口 CompletionProvider 的实现）。
 *
 * 架构铁律（§3 AI 预留）：补全 provider 为可插拔接口——V1 实装规则补全，
 * V2 新增 AiCompletionProvider 并列注册/可切换，不影响已有规则补全。
 *
 * 数据来源：连接成功后渲染进程经 schema:* IPC 预取 SchemaSnapshot（内存快照），
 * 连接切换 / schema 刷新时通过 update() 重建（架构：连接切换时重建）。
 *
 * 补全策略：
 *  - 未连接/无快照 → 仅关键字。
 *  - 前缀以 `xxx.` 结尾 → xxx 是表名则给字段；是库名则给该库的表（支持跨库）。
 *  - 前缀以 `库名.表名.` 结尾 → 给该表字段（支持跨库，通过异步 loader 拉取）。
 *  - 前文最近关键字为表上下文（FROM/JOIN/UPDATE/INTO…）→ 表 + 库 + 关键字。
 *  - 默认 → 关键字 + 表 + 库名（按 word 前缀过滤，按 score 排序）。
 */
import type {
  ColumnMeta,
  CompletionCategory,
  CompletionContext,
  CompletionItem,
  CompletionProvider,
  TableMeta,
} from '@shared/types';

/** 渲染进程保存的 schema 快照（由 schema:* IPC 组装，见 SqlEditor）。 */
export interface SchemaSnapshot {
  connectionId: string;
  /** 当前数据库（连接默认库或第一个库）。 */
  database?: string;
  databases: string[];
  /** 当前库的表/视图。 */
  tables: TableMeta[];
  /** 表名 → 字段列表（当前库作用域；懒加载，取不到则为空）。 */
  columnsByTable: Record<string, ColumnMeta[]>;
}

/** 异步加载库表/字段数据的接口（跨库补全时使用）。 */
export interface SchemaLoader {
  /** 获取指定库的表列表。 */
  tables(db: string): Promise<TableMeta[]>;
  /** 获取指定库某表的字段列表。 */
  columns(db: string, table: string): Promise<ColumnMeta[]>;
}

/** MySQL 常用关键字（补全 + Monarch 高亮共用）。 */
export const SQL_KEYWORDS: string[] = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'DELETE',
  'SET', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'AND', 'OR',
  'NOT', 'NULL', 'IS', 'LIKE', 'IN', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'DISTINCT', 'UNION', 'ALL', 'CREATE', 'TABLE',
  'DROP', 'ALTER', 'ADD', 'COLUMN', 'INDEX', 'KEY', 'PRIMARY', 'FOREIGN',
  'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'UNIQUE', 'AUTO_INCREMENT', 'USE',
  'SHOW', 'DATABASES', 'DATABASE', 'DESC', 'ASC', 'EXPLAIN', 'WITH',
  'RECURSIVE', 'VIEW', 'TRIGGER', 'PROCEDURE', 'FUNCTION', 'IF', 'ELSEIF',
  'THEN', 'BEGIN', 'END', 'COMMIT', 'ROLLBACK', 'START', 'TRANSACTION',
];

/** 前文出现这些关键字（作为最近词）时，上下文为「表位置」。 */
const TABLE_CONTEXT_KEYWORDS = new Set([
  'from', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross',
  'update', 'into', 'table', 'in', 'on', 'using', 'values', 'describe', 'desc',
]);

/** 关键字补全项。 */
export function getKeywordCompletionItems(): CompletionItem[] {
  return SQL_KEYWORDS.map((k) => ({
    label: k,
    category: 'keyword' as CompletionCategory,
    insertText: k,
    score: 1,
  }));
}

/** 前缀是否以 `标识符.` 结尾（补全字段/表名时使用）。 */
export function endWithQualifiedDot(prefix: string): string | null {
  const m = /(?:`([^`]+)`|([\w$]+))\.\s*$/.exec(prefix);
  if (!m) return null;
  return (m[1] ?? m[2]) as string;
}

/** 解析 `库名.表名.` 或 `表名.` 结尾，返回 {db?, table?} 或 null。 */
export function parseQualifiedDot(prefix: string): { db?: string; table?: string } | null {
  const m = /(?:`([^`]+)`|([\w$]+))\.(?:`([^`]+)`|([\w$]+))\.\s*$/.exec(prefix);
  if (m) return { db: m[1] ?? m[2], table: m[3] ?? m[4] };
  const m2 = /(?:`([^`]+)`|([\w$]+))\.\s*$/.exec(prefix);
  if (m2) return { table: m2[1] ?? m2[2] };
  return null;
}

/** 前缀最近一个词是否表上下文关键字。 */
export function isTableContext(prefix: string): boolean {
  const words = prefix
    .replace(/[`'"()]/g, ' ')
    .split(/[\s,;\n]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words.some((w) => TABLE_CONTEXT_KEYWORDS.has(w));
}

/**
 * 解析前缀中的表别名映射：`别名(小写) → 表名`。
 * 支持 `FROM users u`、`FROM users AS u`、`JOIN orders o`、`INTO t x` 等写法，
 * 也支持反引号包裹的表名/别名。用于「输入别名. 时联想对应表字段」（体验优化）。
 */
export function extractTableAliases(prefix: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  const re = /(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:`([^`]+)`|([\w$]+))(?:\s+AS\s+|\s+)(?:`([^`]+)`|([\w$]+))(?=\s|,|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prefix)) !== null) {
    const table = m[1] ?? m[2] ?? '';
    const aliasRaw = m[3] ?? m[4] ?? '';
    const alias = aliasRaw.replace(/`/g, '');
    if (alias && alias.toLowerCase() !== table.toLowerCase() && !isKeyword(table) && !isKeyword(alias)) {
      aliases[alias.toLowerCase()] = table;
    }
  }
  const fromStart = Math.max(
    prefix.lastIndexOf(' FROM '),
    prefix.lastIndexOf(' JOIN '),
    prefix.lastIndexOf(' INTO '),
    prefix.lastIndexOf(' UPDATE '),
    prefix.lastIndexOf(' TABLE '),
  );
  if (fromStart < 0) return aliases;
  const afterFrom = prefix.slice(fromStart);
  const clauseEnd = afterFrom.search(/\b(?:WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT)\b/i);
  const fromClause = clauseEnd > 0 ? afterFrom.slice(0, clauseEnd) : afterFrom;
  const commaRe = /,\s*(?:`([^`]+)`|([\w$]+))(?:\s+AS\s+|\s+)(?:`([^`]+)`|([\w$]+))(?=\s|,|$)/gi;
  let cm: RegExpExecArray | null;
  while ((cm = commaRe.exec(fromClause)) !== null) {
    const table = cm[1] ?? cm[2] ?? '';
    const aliasRaw = cm[3] ?? cm[4] ?? '';
    const alias = aliasRaw.replace(/`/g, '');
    if (alias && alias.toLowerCase() !== table.toLowerCase() && !isKeyword(table) && !isKeyword(alias)) {
      aliases[alias.toLowerCase()] = table;
    }
  }
  return aliases;
}

/** 从 prefix 中提取 FROM/JOIN 子句引用的表（含库名），用于 SELECT 列表位置字段补全。 */
export function extractFromTables(prefix: string): Array<{ db?: string; table: string }> {
  const tables: Array<{ db?: string; table: string }> = [];
  const re = /(?:FROM|JOIN)\s+(?:`([^`]+)`\s*\.\s*`([^`]+)`|([\w$]+)\s*\.\s*([\w$]+)|`([^`]+)`|([\w$]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prefix)) !== null) {
    if (m[1] && m[2]) tables.push({ db: m[1], table: m[2] });
    else if (m[3] && m[4]) tables.push({ db: m[3], table: m[4] });
    else if (m[5]) tables.push({ table: m[5] });
    else if (m[6] && !SQL_KEYWORDS.includes(m[6].toUpperCase())) tables.push({ table: m[6] });
  }
  return tables;
}

/** 返回光标前最近的一个 SQL 关键字（小写）；无则返回 null。 */
export function lastKeyword(prefix: string): string | null {
  const words = prefix
    .replace(/[`'"()]/g, ' ')
    .split(/[\s,;\n]+/)
    .filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i].toLowerCase();
    if (SQL_KEYWORDS.includes(w)) return w;
  }
  return null;
}

/** 简单的 SQL 关键字检测（防正则误匹配 SELECT 列表中的逗号分隔项）。 */
function isKeyword(word: string): boolean {
  return SQL_KEYWORDS.includes(word.toUpperCase());
}

/** 是否以 `.` 结尾（需要补字段/表）。 */
export function isDotEnding(prefix: string): boolean {
  return /\.\s*$/.test(prefix);
}

function dedupe(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const out: CompletionItem[] = [];
  for (const it of items) {
    const key = `${it.category}:${it.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function filterByWord(items: CompletionItem[], word: string): CompletionItem[] {
  const w = word.trim().toLowerCase();
  return w ? items.filter((it) => it.label.toLowerCase().startsWith(w)) : items;
}

function sortItems(items: CompletionItem[]): CompletionItem[] {
  return [...items].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.label.localeCompare(b.label),
  );
}

/**
 * V1 规则补全 provider。
 * 支持异步跨库补全（通过注入的 SchemaLoader），
 * 无 loader 时保持同步兼容。
 */
export class SchemaCompletionProvider implements CompletionProvider {
  readonly kind = 'schema' as const;

  private dbTablesCache = new Map<string, TableMeta[]>();
  private dbColumnsCache = new Map<string, ColumnMeta[]>();

  constructor(
    private snapshot: SchemaSnapshot | null = null,
    private loader: SchemaLoader | null = null,
  ) {}

  /** 连接切换 / schema 刷新时重建数据（架构铁律：重建而非增量）。 */
  update(snapshot: SchemaSnapshot | null): void {
    this.snapshot = snapshot;
    this.dbTablesCache.clear();
    this.dbColumnsCache.clear();
  }

  provideCompletions(context: CompletionContext): CompletionItem[] | Promise<CompletionItem[]> {
    const base = getKeywordCompletionItems();
    if (!this.snapshot) return base;

    const word = context.word;
    const prefix = context.prefix ?? '';

    // 1) 字段/表上下文：`xxx.`
    if (isDotEnding(prefix)) {
      const parsed = parseQualifiedDot(prefix);
      if (!parsed) return base;

      const { db, table: qualifier } = parsed;

      if (db && qualifier) {
        // 库名.表名. → 该表字段（支持跨库异步）
        return this.getColumnsForTable(db, qualifier, base, word);
      }

      if (qualifier) {
        // 表名. → 该表字段（当前库优先）
        if (this.snapshot.tables.some((t) => t.name === qualifier)) {
          const cols = this.snapshot.columnsByTable[qualifier] ?? [];
          return sortItems(
            dedupe(
              filterByWord(
                [...base, ...cols.map((c) => colItem(c))],
                word,
              ),
            ),
          );
        }
        // 别名. → 该表字段（体验优化：FROM users u 之后 u. 联想 users 字段）
        const aliases = extractTableAliases(prefix);
        const tableForAlias = aliases[qualifier.toLowerCase()];
        if (tableForAlias && this.snapshot.tables.some((t) => t.name === tableForAlias)) {
          const cols = this.snapshot.columnsByTable[tableForAlias] ?? [];
          return sortItems(
            dedupe(
              filterByWord(
                [...base, ...cols.map((c) => colItem(c))],
                word,
              ),
            ),
          );
        }
        // 库名. → 该库表（支持跨库异步）
        if (this.snapshot.databases.includes(qualifier)) {
          return this.getTablesForDatabase(qualifier, base, word);
        }
      }
    }

    // 2.5) SELECT/WHERE 上下文：从FROM子句取表，光标在字段位置时联想该表字段（含注释）。
    //      不能直接用 isTableContext（它扫描整段，prefix 含 from 就算表上下文，误伤 SELECT 列表）
    {
      const lastKw = lastKeyword(prefix);
      // FROM/JOIN/UPDATE/INTO 后紧跟的是表名位置，此时走表上下文；其余（SELECT/WHERE/逗号/ON后）走字段
      const fieldPosition = lastKw === null || ['select', 'where', 'group', 'order', 'having', 'and', 'or', 'on', 'in', 'using', 'values', 'by'].includes(lastKw) || /,\s*$/.test(prefix);
      if (fieldPosition) {
        const fromTables = extractFromTables(prefix);
        if (fromTables.length > 0) {
        const fromFields = fromTables.map((t) => this.getFromFieldItems(t.db, t.table, base, word));
        // 合并多个表的字段，去重
        return Promise.all(fromFields).then((results) => {
          const merged = results.flat();
          const seen = new Set<string>();
          const unique = merged.filter((it) => {
            const key = `${it.category}:${it.label.toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return sortItems(dedupe(filterByWord([...base, ...unique], word)));
        });
      }
      }
    }

    // 2) 表上下文：最近关键字提示要写表名
    if (isTableContext(prefix)) {
      return sortItems(
        dedupe(
          filterByWord(
            [
              ...base,
              ...this.snapshot.tables.map((t) => tableItem(t)),
              ...this.snapshot.databases.map((d) => dbItem(d)),
            ],
            word,
          ),
        ),
      );
    }

    // 3) 默认：关键字 + 表 + 库名
    return sortItems(
      dedupe(
        filterByWord(
          [
            ...base,
            ...this.snapshot.tables.map((t) => tableItem(t)),
            ...this.snapshot.databases.map((d) => dbItem(d)),
          ],
          word,
        ),
      ),
    );
  }

  /** 获取指定库的表列表（支持跨库异步）。 */
  private async getTablesForDatabase(
    db: string,
    base: CompletionItem[],
    word: string,
  ): Promise<CompletionItem[]> {
    const snapshot = this.snapshot;
    if (!snapshot) return base;

    let tables: TableMeta[];
    if (db === snapshot.database) {
      tables = snapshot.tables;
    } else if (this.loader) {
      const cached = this.dbTablesCache.get(db);
      if (cached) {
        tables = cached;
      } else {
        try {
          tables = await this.loader.tables(db);
          this.dbTablesCache.set(db, tables);
        } catch {
          tables = [];
        }
      }
    } else {
      tables = [];
    }
    return sortItems(
      dedupe(
        filterByWord(
          [
            ...base,
            ...tables.map((t) => tableItem(t)),
            ...snapshot.databases.map((d) => dbItem(d)),
          ],
          word,
        ),
      ),
    );
  }

  /** 获取指定库某表的字段列表（支持跨库异步）。 */
  private async getColumnsForTable(
    db: string,
    table: string,
    base: CompletionItem[],
    word: string,
  ): Promise<CompletionItem[]> {
    const snapshot = this.snapshot;
    if (!snapshot) return base;

    let cols: ColumnMeta[];
    if (db === snapshot.database) {
      cols = snapshot.columnsByTable[table] ?? [];
      if (cols.length === 0 && this.loader) {
        const cacheKey = `${db}.${table}`;
        const cached = this.dbColumnsCache.get(cacheKey);
        if (cached) {
          cols = cached;
        } else {
          try {
            cols = await this.loader.columns(db, table);
            this.dbColumnsCache.set(cacheKey, cols);
          } catch {
            cols = [];
          }
        }
      }
    } else if (this.loader) {
      const cacheKey = `${db}.${table}`;
      const cached = this.dbColumnsCache.get(cacheKey);
      if (cached) {
        cols = cached;
      } else {
        try {
          cols = await this.loader.columns(db, table);
          this.dbColumnsCache.set(cacheKey, cols);
        } catch {
          cols = [];
        }
      }
    } else {
      cols = [];
    }
    return sortItems(
      dedupe(
        filterByWord(
          [...base, ...cols.map((c) => colItem(c))],
          word,
        ),
      ),
    );
  }

  /** 获取 FROM 子句某表的字段候选（用于 SELECT 列表位置补全，显示注释）。 */
  private async getFromFieldItems(
    db: string | undefined,
    table: string,
    base: CompletionItem[],
    word: string,
  ): Promise<CompletionItem[]> {
    const snapshot = this.snapshot;
    if (!snapshot) return [];

    // 如果用户输入了库名，用该库；否则使用当前库
    const effectiveDb = db ?? snapshot.database ?? '';
    let cols: ColumnMeta[];

    if (effectiveDb === snapshot.database) {
      cols = snapshot.columnsByTable[table] ?? [];
      if (cols.length === 0 && this.loader) {
        const cacheKey = `${effectiveDb}.${table}`;
        const cached = this.dbColumnsCache.get(cacheKey);
        if (cached) {
          cols = cached;
        } else {
          try {
            cols = await this.loader.columns(effectiveDb, table);
            this.dbColumnsCache.set(cacheKey, cols);
          } catch {
            cols = [];
          }
        }
      }
    } else if (this.loader) {
      const cacheKey = `${effectiveDb}.${table}`;
      const cached = this.dbColumnsCache.get(cacheKey);
      if (cached) {
        cols = cached;
      } else {
        try {
          cols = await this.loader.columns(effectiveDb, table);
          this.dbColumnsCache.set(cacheKey, cols);
        } catch {
          cols = [];
        }
      }
    } else {
      cols = [];
    }

    return cols.map((c) => ({
      label: c.name,
      category: 'column' as CompletionCategory,
      insertText: c.name,
      detail: c.comment ? `${c.type} · ${c.comment}` : c.type,
      score: 5,
    }));
  }
}

function tableItem(t: TableMeta): CompletionItem {
  return {
    label: t.name,
    category: 'table' as CompletionCategory,
    insertText: t.name,
    detail: t.isView ? '视图' : t.comment ? `表 · ${t.comment}` : '表',
    score: 3,
  };
}

function dbItem(d: string): CompletionItem {
  return { label: d, category: 'database' as CompletionCategory, insertText: d, score: 2 };
}

function colItem(c: ColumnMeta): CompletionItem {
  return {
    label: c.name,
    category: 'column' as CompletionCategory,
    insertText: c.name,
    detail: c.type,
    score: 4,
  };
}
