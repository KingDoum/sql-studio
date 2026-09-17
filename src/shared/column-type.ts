/**
 * 列类型判定与归一化（Main 与 Renderer 共用；铁律 R5：判定逻辑单一来源）。
 *
 * 同一份判定被多处使用，若各写一份必然漂移：
 *   - `columnTypeFromCode` / `columnTypeFromRaw`：把 mysql2 类型码或原始类型名
 *     归一为 `ColumnType`。曾被 `query-service`（结果集表头）与 `schema-cache`
 *     （对象浏览器字段列表）各实现一份，且 **longblob 口径不同**（一个 `text`
 *     一个 `blob`）→ 同一列在两处显示不同类型名。
 *   - `isNumericColumnType`：Main 的 Excel 导出是否数值化 + Renderer 的网格是否右对齐。
 */
import type { ColumnType } from './types';

/** 数值型基础类型名（已去掉长度/unsigned 等修饰）。 */
const NUMERIC_COLUMN_TYPES = new Set([
  'decimal',
  'numeric',
  'int',
  'integer',
  'bigint',
  'mediumint',
  'smallint',
  'tinyint',
  'float',
  'double',
  'real',
]);

/**
 * 列类型是否为数值型。
 * 容忍原始写法：`decimal(10,2)`、`bigint unsigned`、`INT UNSIGNED` 等。
 *
 * 注意：刻意**不包含** varchar/char —— 那些列里的数字串（工号、编码、手机号）
 * 既不该在网格里右对齐，也不该在导出时被转成数值。
 */
export function isNumericColumnType(type?: string): boolean {
  if (typeof type !== 'string') return false;
  const base = type.trim().toLowerCase().replace(/\(.*$/, '').split(/\s+/)[0];
  return NUMERIC_COLUMN_TYPES.has(base);
}

/**
 * 原始类型名 → ColumnType。用于 `SHOW FULL COLUMNS` 的 `Type` 列（如 `int(11)`）
 * 以及 mysql2 以字符串给出类型的情况。
 *
 * 判断顺序有讲究：`datetime` 必须在 `date` 前、`timestamp` 必须在 `time` 前。
 * 未识别的类型**原样返回**（例如 `bit(1)` 会保持 `bit(1)`，供 BIT 归一化按前缀识别）。
 *
 * 口径统一（相对历史实现的行为变化）：`longblob` 归 `blob` 而非 `text`。
 * 理由：mysql2 类型码路径本就把 249~252（tinyblob/blob/mediumblob/longblob）
 * 全部映射为 `blob`，字符串路径应与之一致，且"二进制列"不该标成文本。
 */
export function columnTypeFromRaw(raw: string): ColumnType {
  const t = String(raw).toLowerCase();
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

/**
 * mysql2 数字类型码（`field.type`）→ ColumnType。
 * 码值取自 MySQL 协议字段类型；未识别返回 `'unknown'`。
 */
export function columnTypeFromCode(code: number): ColumnType {
  switch (code) {
    case 0:
    case 246:
      return 'decimal';
    case 1:
      return 'tinyint';
    case 2:
      return 'smallint';
    case 3:
      return 'int';
    case 4:
      return 'float';
    case 5:
      return 'double';
    case 7:
    case 12:
      return 'datetime';
    case 8:
      return 'bigint';
    case 9:
      return 'mediumint';
    case 10:
      return 'date';
    case 11:
      return 'time';
    case 13:
      return 'year';
    case 15:
    case 253:
      return 'varchar';
    case 16:
      return 'bit';
    case 245:
      return 'json';
    case 247:
      return 'enum';
    case 248:
      return 'set';
    case 249:
    case 250:
    case 251:
    case 252:
      return 'blob';
    case 254:
      return 'char';
    case 255:
      return 'geometry';
    default:
      return 'unknown';
  }
}
