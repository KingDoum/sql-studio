/**
 * CsvExporter 纯逻辑测试（会话8c）。
 * 覆盖：字段转义（逗号/引号/换行）、行转 CSV、BOM 表头、真实临时文件写入。
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { CsvExporter, escapeCsvField, rowToCsvLine } from '@main/services/csv-exporter';
import type { ColumnMeta } from '@shared/types';

const COLS: ColumnMeta[] = [
  { name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true },
  { name: 'name', type: 'varchar', nullable: true, isPrimary: false, isUnique: false },
  { name: 'note', type: 'text', nullable: true, isPrimary: false, isUnique: false },
];

describe('escapeCsvField', () => {
  it('null → 空串', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });
  it('普通值原样', () => {
    expect(escapeCsvField(123)).toBe('123');
    expect(escapeCsvField('abc')).toBe('abc');
  });
  it('含逗号 → 引号包裹', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });
  it('含引号 → 翻倍转义', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });
  it('含换行 → 引号包裹', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });
  it('二进制 → [BINARY]', () => {
    expect(escapeCsvField(new Uint8Array([1, 2]))).toBe('[BINARY]');
  });
});

describe('rowToCsvLine', () => {
  it('多字段拼接逗号 + 换行', () => {
    expect(rowToCsvLine([1, 'Alice', null])).toBe('1,Alice,\n');
  });
});

describe('CsvExporter.export', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-export-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('写入真实文件：BOM + 表头 + 数据行，resolve 行数', async () => {
    const filePath = path.join(dir, 'out.csv');
    const exporter = new CsvExporter();
    const n = await exporter.export({
      options: { filePath },
      columns: COLS,
      rows: [
        [1, 'Alice', 'a,b'],
        [2, 'Bob', null],
      ],
    });
    expect(n).toBe(2);
    const text = fs.readFileSync(filePath, 'utf8');
    // BOM
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('id,name,note\n');
    expect(text).toContain('1,Alice,"a,b"\n');
    expect(text).toContain('2,Bob,\n');
  });
});