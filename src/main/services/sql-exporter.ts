/**
 * SQL INSERT 导出（任务 6 main-script-export）。
 *
 * 把结果集转为 INSERT 语句：值转义、NULL/日期/二进制处理、按 batchSize 分批生成。
 * 供用户在别的库/环境回放数据。
 *
 * 依赖注入：构造时注入写入器（默认 node:fs），便于单测捕获内容。
 */

import fs from 'node:fs';
import type { CellValue, ColumnMeta, ExportInsertRequest } from '@shared/types';

/** 写入器抽象（便于单测）。 */
export interface Writer {
  writeFile(p: string, content: string): void;
}

const nodeWriter: Writer = {
  writeFile: (p, content) => fs.writeFileSync(p, content, 'utf-8'),
};

/** 单个值转 SQL 字面量。 */
export function escapeSqlValue(v: CellValue): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return 'X\'' + Buffer.from(v).toString('hex') + '\'';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  // 字符串：转义单引号与反斜杠
  const escaped = String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0');
  return `'${escaped}'`;
}

/**
 * 反引号转义单个标识符（库名/表名/列名）。
 * MySQL 中把反引号写成两个反引号即可安全内嵌，其余字符无需特殊处理。
 */
export function escapeIdent(name: string): string {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

/**
 * 把用户输入的“表名”解析为安全标识符：
 * - 仅允许普通表名（table）或 database.table 两段；多余点号或非法分隔视为错误。
 * - 任何段都只按标识符转义，禁止把 SQL 片段（分号、括号、注释）拼进输出。
 * @throws 表名包含非法字符或为空时抛错。
 */
export function resolveTableIdent(tableName: string): string {
  const trimmed = String(tableName ?? '').trim();
  if (!trimmed) throw new Error('导出表名为空');
  const parts = trimmed.split('.');
  if (parts.length > 2) {
    throw new Error(`无效表名: ${tableName}`);
  }
  return parts.map((p) => {
    const seg = p.trim();
    if (!seg) throw new Error(`无效表名: ${tableName}`);
    // 标识符内不允许注释/语句分隔等结构字符（反引号本身由 escapeIdent 转义）
    if (/[;()\n\r]/.test(seg)) {
      throw new Error(`表名包含非法字符: ${tableName}`);
    }
    return escapeIdent(seg);
  }).join('.');
}

/** 校验 batchSize：必须是有限正整数；非法值抛错（0/负数会导致死循环或空批）。 */
function validateBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return 500;
  if (!Number.isFinite(batchSize) || !Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`无效 batchSize: ${batchSize}，必须是正整数`);
  }
  return batchSize;
}

export class SqlExporter {
  private readonly writer: Writer;

  constructor(writer: Writer = nodeWriter) {
    this.writer = writer;
  }

  /**
   * 生成 INSERT 文件。列名优先用 req.options.columns（显式），否则用 result.columns。
   * @returns 写入的行数。
   */
  export(req: ExportInsertRequest): number {
    const { options, columns, rows } = req;
    const colNames = options.columns ?? columns.map((c) => c.name);
    const tableIdent = resolveTableIdent(options.tableName);
    const batchSize = validateBatchSize(options.batchSize);

    const header = `-- 由 SQL Studio 导出\n-- 表: ${options.tableName}\n-- 行数: ${rows.length}\n`;
    const chunks: string[] = [header];

    let i = 0;
    while (i < rows.length) {
      const batch = rows.slice(i, i + batchSize);
      const valueLines = batch
        .map((row) => {
          const vals = colNames.map((_, idx) => escapeSqlValue(row[idx]));
          return `(${vals.join(', ')})`;
        })
        .join(',\n  ');
      chunks.push(
        `INSERT INTO ${tableIdent} (${colNames.map(escapeIdent).join(', ')}) VALUES\n  ${valueLines};`,
      );
      i += batchSize;
    }

    const content = chunks.join('\n\n') + '\n';
    this.writer.writeFile(options.filePath, content);
    return rows.length;
  }
}
