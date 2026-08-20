/**
 * excel-exporter.ts 单测（任务 6）。
 * 生成 .xlsx 后用 ExcelJS 读回校验：表头深色底/白字、冻结首行、行列数据、中文编码。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { ExcelExporter } from '@main/services/excel-exporter';
import type { CellValue, ColumnMeta, ExportExcelRequest } from '@shared/types';

let tmpDir: string;
let file: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlstudio-xlsx-'));
  file = path.join(tmpDir, 'out.xlsx');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const columns: ColumnMeta[] = [
  { name: 'id', type: 'int', nullable: false, isPrimary: true, isUnique: false },
  { name: '姓名', type: 'varchar', nullable: true, isPrimary: false, isUnique: false },
];
const rows: CellValue[][] = [
  [1, '张三'],
  [2, '李四'],
];

async function readBack(p: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  return wb;
}

describe('ExcelExporter', () => {
  it('生成文件并校验行列/表头/中文', async () => {
    const exporter = new ExcelExporter();
    const req: ExportExcelRequest = {
      options: { filePath: file, sheetName: '结果', freezeHeader: true, includeMeta: false },
      columns,
      rows,
    };
    const n = await exporter.export(req);
    expect(n).toBe(2);

    const wb = await readBack(file);
    const ws = wb.getWorksheet('结果')!;
    expect(ws.rowCount).toBe(3); // 表头 + 2 行
    expect(ws.getCell('A1').value).toBe('id');
    expect(ws.getCell('B1').value).toBe('姓名');
    expect(ws.getCell('A2').value).toBe(1);
    expect(ws.getCell('B2').value).toBe('张三');
  });

  it('表头深色底 + 白字', async () => {
    const exporter = new ExcelExporter();
    await exporter.export({
      options: { filePath: file, freezeHeader: true, includeMeta: false },
      columns,
      rows,
    });
    const wb = await readBack(file);
    const ws = wb.worksheets[0];
    const cell = ws.getCell('A1');
    expect((cell.fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FF4472C4');
    expect((cell.font as ExcelJS.Font).color?.argb).toBe('FFFFFFFF');
    expect((cell.font as ExcelJS.Font).bold).toBe(true);
  });

  it('冻结首行（A2）', async () => {
    const exporter = new ExcelExporter();
    await exporter.export({
      options: { filePath: file, freezeHeader: true, includeMeta: false },
      columns,
      rows,
    });
    const wb = await readBack(file);
    const ws = wb.worksheets[0];
    const view = ws.views?.[0] as ExcelJS.WorksheetViewFrozen;
    expect(view?.state).toBe('frozen');
    expect(view?.ySplit).toBe(1);
  });

  it('NULL 单元格写入空串', async () => {
    const exporter = new ExcelExporter();
    await exporter.export({
      options: { filePath: file, freezeHeader: false, includeMeta: false },
      columns,
      rows: [[3, null]],
    });
    const wb = await readBack(file);
    const ws = wb.worksheets[0];
    expect(ws.getCell('B2').value).toBe('');
  });
});
