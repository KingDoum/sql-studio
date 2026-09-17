/**
 * Excel 导出（任务 6 main-script-export）。
 *
 * 使用 ExcelJS 生成 .xlsx：表头深色底（#4472C4）/白字、冻结首行 A2、自动列宽。
 * 对齐旧项目 exporter.py 的样式要求。支持可选导出元信息（连接/时间）作为附加工作表或首行。
 *
 * 取值约定：NULL→空串；Uint8Array→`[BINARY]` 占位；数值型列（decimal/bigint…）的
 * 字符串值在**精度安全**时转为真数值（便于 Excel 求和），超 15 位有效数字或超安全
 * 整数范围则保持文本，避免静默丢精度。
 *
 * 依赖注入：构造时注入 workbook 工厂（默认 ExcelJS），便于单测验证生成逻辑。
 */

import ExcelJS from 'exceljs';
import type { CellValue, ColumnMeta, ExportExcelRequest } from '@shared/types';
import { isNumericColumnType } from '@shared/column-type';

/** workbook 工厂（便于测试注入或自定义）。 */
export type WorkbookFactory = () => ExcelJS.Workbook;

const DEFAULT_HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF4472C4' },
};
const DEFAULT_HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };

/** 单元格值转 Excel 可写值（NULL→空串，Uint8Array→[BINARY]）。 */
function toExcelValue(v: CellValue, columnType?: string): ExcelJS.CellValue {
  if (v === null || v === undefined) return '';
  if (v instanceof Uint8Array) return '[BINARY]';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  // 数值型列的字符串值（mysql2 的 DECIMAL 恒为字符串，以保证精度）转为真数值，
  // 否则 Excel 里是文本格式：左对齐、绿三角、无法直接求和（金额列尤其明显）。
  if (typeof v === 'string' && isNumericColumnType(columnType)) {
    const n = toSafeExcelNumber(v);
    if (n !== null) return n;
  }
  return v as ExcelJS.CellValue;
}

/** 纯十进制数字串（刻意不接受科学计数法、十六进制、千分位）。 */
const PLAIN_NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

/** 十进制字符串的有效数字位数（忽略符号、小数点、前导零与小数尾部零）。 */
function significantDigits(s: string): number {
  const digits = s.replace(/^[+-]/, '').replace('.', '').replace(/^0+/, '');
  const trimmed = digits.replace(/0+$/, '');
  return trimmed.length === 0 ? 1 : trimmed.length;
}

/**
 * 数值字符串 → number；不安全时返回 null（调用方保持文本）。
 *
 * Excel 只保证 **15 位有效数字**，整数还受 IEEE754 安全整数范围约束。
 * 超出任一上限时转数值会静默丢精度（如 9007199254740993 → …992），
 * 因此宁可用文本，也不写出错误的数字。
 */
function toSafeExcelNumber(s: string): number | null {
  if (!PLAIN_NUMBER_RE.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // 小数：按有效数字位数判断（15 位内 Excel 可精确呈现）
  if (s.includes('.')) return significantDigits(s) <= 15 ? n : null;
  // 整数：必须落在安全整数范围内才精确
  return Number.isSafeInteger(n) ? n : null;
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

    // 表头：ExcelJS 的列 key 必须唯一。结果集可能含同名列（如 JOIN 的 a.id / b.id），
    // 若用列名当 key，同名两列共享一个 key，addRow 时后值覆盖前值（导出的两列变成同一份数据）。
    // 因此 key 使用列下标，表头文本仍显示真实列名。CSV / SQL 导出按下标取值，不受影响。
    const headers = columns.map((c, idx) => ({
      header: c.name,
      key: `col_${idx}`,
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

    // 数据行（分批写入：每批让出事件循环，避免大结果集阻塞主进程 UI）
    const BATCH = 2000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      for (const row of batch) {
        const obj: Record<string, ExcelJS.CellValue> = {};
        columns.forEach((col, colIdx) => {
          // 与 ws.columns 的 key 保持一致（列下标），保证同名列各占一列、值不互相覆盖
          // 传入列类型：数值型列的字符串值需转成真数值（见 toExcelValue）
          obj[`col_${colIdx}`] = toExcelValue(row[colIdx], col.type);
        });
        ws.addRow(obj);
      }
      if (i + BATCH < rows.length) {
        // 让主进程事件循环有机会处理其他消息（窗口不冻结）
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
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
