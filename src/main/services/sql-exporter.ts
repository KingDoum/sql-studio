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
    const tableName = options.tableName;
    const batchSize = options.batchSize ?? 500;

    const header = `-- 由 SQL Studio 导出\n-- 表: ${tableName}\n-- 行数: ${rows.length}\n`;
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
        `INSERT INTO \`${tableName}\` (\`${colNames.join('`, `')}\`) VALUES\n  ${valueLines};`,
      );
      i += batchSize;
    }

    const content = chunks.join('\n\n') + '\n';
    this.writer.writeFile(options.filePath, content);
    return rows.length;
  }
}
