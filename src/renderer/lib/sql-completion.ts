/**
 * SchemaCompletionProvider（任务 9：V1 规则补全，可插拔接口 CompletionProvider 的实现）。
 *
 * 架构铁律（§3 AI 预留）：补全 provider 为可插拔接口——V1 实装规则补全，
 * V2 新增 AiCompletionProvider 并列注册/可切换，不影响已有规则补全。
 *
 * 数据来源：连接成功后渲染进程经 schema:* IPC 预取 SchemaSnapshot（内存快照），
 * 连接切换 / schema 刷新时通过 update() 重建（架构：连接切换时重建）。
 *
 * 补全策略（纯函数可单测）：
 *  - 未连接/无快照 → 仅关键字。
 *  - 前缀以 `xxx.` 结尾 → xxx 是表名则给字段；是库名则给该库的表（V1 仅当前库有表数据）。
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
  // 关键字 + 表名（反引号或普通标识符）+ 可选 AS + 别名（反引号或普通标识符）
  // 表名和别名的反引号组优先匹配完整反引号段
  const re = /(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:`([^`]+)`|([\w$]+))(?:\s+AS\s+|\s+)(?:`([^`]+)`|([\w$]+))(?=\s|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prefix)) !== null) {
    const table = m[1] ?? m[2] ?? '';
    const aliasRaw = m[3] ?? m[4] ?? '';
    const alias = aliasRaw.replace(/`/g, '');
    if (alias && alias.toLowerCase() !== table.toLowerCase()) {
      aliases[alias.toLowerCase()] = table;
    }
  }
  return aliases;
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
 * 同步接口（CompletionProvider.provideCompletions 为同步），
 * schema 数据由外部预取后注入（update），符合可插拔设计。
 */
export class SchemaCompletionProvider implements CompletionProvider {
  readonly kind = 'schema' as const;

  constructor(private snapshot: SchemaSnapshot | null = null) {}

  /** 连接切换 / schema 刷新时重建数据（架构铁律：重建而非增量）。 */
  update(snapshot: SchemaSnapshot | null): void {
    this.snapshot = snapshot;
  }

  provideCompletions(context: CompletionContext): CompletionItem[] {
    const base = getKeywordCompletionItems();
    if (!this.snapshot) return base;

    const word = context.word;
    const prefix = context.prefix ?? '';

    // 1) 字段/表上下文：`xxx.`
    if (isDotEnding(prefix)) {
      const qualifier = endWithQualifiedDot(prefix);
      if (qualifier) {
        if (this.snapshot.tables.some((t) => t.name === qualifier)) {
          // 表名. → 该表字段
          const cols = this.snapshot.columnsByTable[qualifier] ?? [];
          return sortItems(
            dedupe(
              filterByWord(
                [
                  ...base,
                  ...cols.map((c) => ({
                    label: c.name,
                    category: 'column' as CompletionCategory,
                    insertText: c.name,
                    detail: c.type,
                    score: 4,
                  })),
                ],
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
                [
                  ...base,
                  ...cols.map((c) => ({
                    label: c.name,
                    category: 'column' as CompletionCategory,
                    insertText: c.name,
                    detail: c.type,
                    score: 4,
                  })),
                ],
                word,
              ),
            ),
          );
        }
        if (this.snapshot.databases.includes(qualifier)) {
          // 库名. → 该库表（V1 仅当前库有表数据；非当前库退化为库名列表）
          const tables =
            qualifier === this.snapshot.database ? this.snapshot.tables : [];
          return sortItems(
            dedupe(
              filterByWord(
                [
                  ...base,
                  ...tables.map((t) => tableItem(t)),
                  ...this.snapshot.databases.map((d) => dbItem(d)),
                ],
                word,
              ),
            ),
          );
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