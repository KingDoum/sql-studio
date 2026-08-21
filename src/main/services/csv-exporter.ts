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

/** 转义单个 CSV 字段（RFC 4180 + Excel 公式注入防护）。 */
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
  // Excel 公式注入防护：以 = + - @ 开头的文本前置单引号
  // （CSV 安全最佳实践，Beekeeper 等工具同样处理）
  if (/^[=+\-@]/.test(s)) {
    s = `'${s}`;
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

      const header = '\uFEFF' + columns.map((c) => escapeCsvField(c.name)).join(',') + '\n';
      let idx = 0;
      let headerWritten = false;

      // 事件驱动写入：write() 返回 false 时暂停，等待 drain 再续写（backpressure 处理）
      const writeNext = () => {
        let ok = true;
        if (!headerWritten) {
          ok = stream.write(header);
          headerWritten = true;
        }
        while (ok && idx < rows.length) {
          ok = stream.write(rowToCsvLine(rows[idx]));
          idx += 1;
        }
        if (!ok) {
          // 缓冲已满，等待 drain
          stream.once('drain', writeNext);
        } else {
          stream.end();
        }
      };
      writeNext();
    });
  }
}