/**
 * Schema 缓存（任务 5 main-schema-query 的一部分）。
 *
 * 职责：
 *   1. 惰性拉取：库列表 / 某库表列表 / 表字段 / 表 DDL，首次访问触发查询并缓存。
 *   2. 内存缓存 + 手动刷新（refresh* 清理对应缓存）。
 *   3. 与对象树、补全、语义高亮共用同一份缓存（避免重复查询）。
 *
 * 依赖注入：传入 executor（执行单条 SQL 拿到结果集）。真实环境由 ConnectionManager
 * 提供；单测注入 mock。
 *
 * 铁律 R5：缓存键命名集中；查询 SQL 常量集中。
 */

import type { ColumnMeta, TableMeta } from '@shared/types';

/** executor：执行单条只读 SQL，返回行（每行字段不定）。 */
export type SchemaExecutor = (sql: string) => Promise<Record<string, unknown>[]>;

/** 缓存结构。 */
interface Cache {
  databases: string[] | null;
  /** 库名 → 表列表（含视图） */
  tables: Map<string, TableMeta[] | null>;
  /** `${db}.${table}` → 字段列表 */
  columns: Map<string, ColumnMeta[] | null>;
  /** `${db}.${table}` → DDL */
  ddls: Map<string, string | null>;
}

/** 常用只读查询 SQL（集中常量）。 */
export const SCHEMA_SQL = {
  listDatabases: 'SHOW DATABASES',
  listTables: (db: string) => `SHOW FULL TABLES FROM \`${db}\``,
  getColumns: (db: string, table: string) => `SHOW FULL COLUMNS FROM \`${table}\` FROM \`${db}\``,
  getDdl: (db: string, table: string) => `SHOW CREATE TABLE \`${db}\`.\`${table}\``,
} as const;

/** 把 mysql2 原始类型名（如 int(11)）粗略归一为 ColumnType。 */
function normalizeType(raw: string): ColumnMeta['type'] {
  const t = raw.toLowerCase();
  if (t.includes('int')) return t.includes('big') ? 'bigint' : 'int';
  if (t.includes('decimal') || t.includes('numeric')) return 'decimal';
  if (t.includes('float')) return 'float';
  if (t.includes('double')) return 'double';
  if (t.includes('varchar')) return 'varchar';
  if (t.includes('char') && !t.includes('varchar')) return 'char';
  if (t.includes('text')) return 'text';
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

export class SchemaCache {
  private readonly executor: SchemaExecutor;
  private readonly cache: Cache = {
    databases: null,
    tables: new Map(),
    columns: new Map(),
    ddls: new Map(),
  };

  constructor(executor: SchemaExecutor) {
    this.executor = executor;
  }

  /** 列出全部数据库（缓存命中优先）。 */
  async listDatabases(force = false): Promise<string[]> {
    if (!force && this.cache.databases) return this.cache.databases;
    const rows = await this.executor(SCHEMA_SQL.listDatabases);
    const dbs = rows.map((r) => String(Object.values(r)[0] ?? '')).filter(Boolean);
    this.cache.databases = dbs;
    return dbs;
  }

  /** 列出某库的表/视图（缓存命中优先）。 */
  async listTables(db: string, force = false): Promise<TableMeta[]> {
    const key = db;
    if (!force && this.cache.tables.has(key)) return this.cache.tables.get(key) ?? [];
    const rows = await this.executor(SCHEMA_SQL.listTables(db));
    const tables: TableMeta[] = rows.map((r) => {
      const values = Object.values(r);
      const name = String(values[0] ?? '');
      const tableType = String(values[1] ?? '');
      return {
        name,
        type: tableType.toUpperCase() === 'VIEW' ? 'view' : 'table',
        isView: tableType.toUpperCase() === 'VIEW',
      } satisfies TableMeta;
    });
    this.cache.tables.set(key, tables);
    return tables;
  }

  /** 列出某表的字段（缓存命中优先）。 */
  async getColumns(db: string, table: string, force = false): Promise<ColumnMeta[]> {
    const key = `${db}.${table}`;
    if (!force && this.cache.columns.has(key)) return this.cache.columns.get(key) ?? [];
    const rows = await this.executor(SCHEMA_SQL.getColumns(db, table));
    const columns: ColumnMeta[] = rows.map((r) => {
      const get = (k: string) => (r[k] !== undefined ? String(r[k]) : undefined);
      const field = get('Field') ?? '';
      const type = get('Type') ?? 'unknown';
      const nullVal = get('Null');
      const keyVal = get('Key') ?? '';
      return {
        name: field,
        type: normalizeType(type),
        nullable: nullVal ? nullVal.toUpperCase() === 'YES' : true,
        isPrimary: keyVal.toUpperCase() === 'PRI',
        isUnique: keyVal.toUpperCase() === 'UNI',
        defaultValue: (get('Default') as string | null) ?? null,
        comment: get('Comment') || undefined,
      } satisfies ColumnMeta;
    });
    this.cache.columns.set(key, columns);
    return columns;
  }

  /** 获取表 DDL（缓存命中优先）。 */
  async getDdl(db: string, table: string, force = false): Promise<string> {
    const key = `${db}.${table}`;
    if (!force && this.cache.ddls.has(key)) return this.cache.ddls.get(key) ?? '';
    const rows = await this.executor(SCHEMA_SQL.getDdl(db, table));
    const row = rows[0] ?? {};
    const ddl = String(row['Create Table'] ?? row['Create View'] ?? '');
    this.cache.ddls.set(key, ddl);
    return ddl;
  }

  /** 清空全部缓存（连接切换 / 手动刷新全部）。 */
  clearAll(): void {
    this.cache.databases = null;
    this.cache.tables.clear();
    this.cache.columns.clear();
    this.cache.ddls.clear();
  }

  /** 刷新某库表列表。 */
  refreshTables(db: string): void {
    this.cache.tables.delete(db);
  }

  /** 刷新某表字段与 DDL。 */
  refreshTable(db: string, table: string): void {
    this.cache.columns.delete(`${db}.${table}`);
    this.cache.ddls.delete(`${db}.${table}`);
  }
}
