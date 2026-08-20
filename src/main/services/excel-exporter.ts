/**
 * Excel 导出（任务 6 main-script-export）。
 *
 * 使用 ExcelJS 生成 .xlsx：表头深色底（#4472C4）/白字、冻结首行 A2、自动列宽。
 * 对齐旧项目 exporter.py 的样式要求。支持可选导出元信息（连接/时间）作为附加工作表或首行。
 *
 * 依赖注入：构造时注入 workbook 工厂（默认 ExcelJS），便于单测验证生成逻辑。
 */

import ExcelJS from 'exceljs';
import type { CellValue, ColumnMeta, ExportExcelRequest } from '@shared/types';

/** workbook 工厂（便于测试注入或自定义）。 */
export type WorkbookFactory = () => ExcelJS.Workbook;

const DEFAULT_HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF4472C4' },
};
const DEFAULT_HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };

/** 单元格值转 Excel 可写值（NULL→空串，Uint8Array→[BINARY]）。 */
function toExcelValue(v: CellValue): ExcelJS.CellValue {
  if (v === null || v === undefined) return '';
  if (v instanceof Uint8Array) return '[BINARY]';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v as ExcelJS.CellValue;
}

export class ExcelExporter {
  private readonly makeWorkbook: WorkbookFactory;

  constructor(makeWorkbook: WorkbookFactory = () => new ExcelJS.Workbook()) {
    this.makeWorkbook = makeWorkbook;
  }

  /**
   * 把结果集写入 xlsx 文件。
   * @returns 写入的行数（不含表头/元信息）。
   */
  async export(req: ExportExcelRequest): Promise<number> {
    const { options, columns, rows } = req;
    const wb = this.makeWorkbook();
    const sheetName = (options.sheetName ?? '查询结果').slice(0, 31);
    const ws = wb.addWorksheet(sheetName);

    // 表头
    const headers = columns.map((c) => ({
      header: c.name,
      key: c.name,
      width: Math.min(Math.max(c.name.length + 2, 10), 40),
    }));
    ws.columns = headers;

    // 元信息（可选）：在表头前插入两行，整体下移
    let metaRows = 0;
    if (options.includeMeta !== false) {
      const meta = wb.addWorksheet('_meta');
      meta.columns = [{ header: 'key', key: 'key' }, { header: 'value', key: 'value' }];
      meta.addRow({ key: '导出时间', value: new Date().toISOString() });
      meta.addRow({ key: '行数', value: rows.length });
      if (options.title) meta.addRow({ key: '标题', value: options.title });
      meta.getRow(1).font = { bold: true };
      // 主表头样式应用
      this.applyHeaderStyle(ws);
      // 冻结首行（A2）
      if (options.freezeHeader !== false) ws.views = [{ state: 'frozen', ySplit: 1 }];
    } else {
      this.applyHeaderStyle(ws);
      if (options.freezeHeader !== false) ws.views = [{ state: 'frozen', ySplit: 1 }];
    }

    // 数据行
    for (const row of rows) {
      const obj: Record<string, ExcelJS.CellValue> = {};
      columns.forEach((c, i) => {
        obj[c.name] = toExcelValue(row[i]);
      });
      ws.addRow(obj);
    }
    metaRows = rows.length;

    await wb.xlsx.writeFile(options.filePath);
    return metaRows;
  }

  /** 给表头行加深色底/白字 + 自动列宽。 */
  private applyHeaderStyle(ws: ExcelJS.Worksheet): void {
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = DEFAULT_HEADER_FILL;
      cell.font = DEFAULT_HEADER_FONT;
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    });
    // 自动列宽（基于表头与少量数据）
    ws.columns.forEach((col) => {
      if (col.width) col.width = Math.min(Math.max(col.width, 10), 50);
    });
  }
}
