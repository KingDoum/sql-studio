/**
 * CSV 导出（体验优化会话8c）。
 * 把结果集写为 CSV 文件（UTF-8 BOM + RFC 4180 转义）。
 *
 * 流式写：逐行 flush 到文件流，避免大结果集全量进内存
 * （对齐 Beekeeper「streaming export」思路）。
 *
 * 依赖注入：构造时注入文件写入器（默认 fs.createWriteStream），便于单测 mock。
 */
import fs from 'node:fs';
import type { CellValue, ExportCsvRequest, ColumnMeta } from '@shared/types';

/** 转义单个 CSV 字段（RFC 4180）。 */
export function escapeCsvField(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return '[BINARY]';
  let s: string;
  if (typeof value === 'object') {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  } else {
    s = String(value);
  }
  // 含逗号/引号/换行 → 双引号包裹，内部引号翻倍
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** 把一行 CellValue[] 转为 CSV 行文本。 */
export function rowToCsvLine(row: CellValue[]): string {
  return row.map((v) => escapeCsvField(v)).join(',') + '\n';
}

export class CsvExporter {
  private readonly writeFile: (path: string) => NodeJS.WritableStream;

  constructor(writeFile: (path: string) => NodeJS.WritableStream = (p) => fs.createWriteStream(p)) {
    this.writeFile = writeFile;
  }

  /** 导出结果集为 CSV（UTF-8 BOM），返回行数。 */
  export(req: ExportCsvRequest): Promise<number> {
    return new Promise((resolve, reject) => {
      const { columns, rows } = req;
      const stream = this.writeFile(req.options.filePath);
      stream.on('error', reject);
      stream.on('finish', () => resolve(rows.length));
      // UTF-8 BOM（Excel 打开中文不乱码）
      stream.write('\uFEFF');
      // 表头
      stream.write(columns.map((c) => escapeCsvField(c.name)).join(',') + '\n');
      // 数据行（逐行流式写，小批次 backpressure 不处理，结果集已限量 5 万行）
      for (const row of rows) {
        stream.write(rowToCsvLine(row));
      }
      stream.end();
    });
  }
}