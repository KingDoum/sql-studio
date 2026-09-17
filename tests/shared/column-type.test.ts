/**
 * column-type.ts 单测。
 * 该判定同时被 Main（Excel 导出是否数值化）与 Renderer（结果网格是否右对齐）使用，
 * 因此边界必须明确：字符串/日期/二进制类型一律不算数值。
 */
import { describe, it, expect } from 'vitest';
import { columnTypeFromCode, columnTypeFromRaw, isNumericColumnType } from '@shared/column-type';

describe('isNumericColumnType', () => {
  it('识别基础数值类型', () => {
    const numeric = [
      'int',
      'integer',
      'bigint',
      'decimal',
      'numeric',
      'float',
      'double',
      'real',
      'tinyint',
      'smallint',
      'mediumint',
    ];
    for (const t of numeric) expect(isNumericColumnType(t)).toBe(true);
  });

  it('容忍长度、unsigned 等修饰与大小写/空白', () => {
    expect(isNumericColumnType('decimal(10,2)')).toBe(true);
    expect(isNumericColumnType('bigint unsigned')).toBe(true);
    expect(isNumericColumnType('INT UNSIGNED')).toBe(true);
    expect(isNumericColumnType('  Double(8,3) ')).toBe(true);
  });

  it('字符串/日期/二进制类型不算数值（前导零与编码不该被改写或右对齐）', () => {
    const notNumeric = [
      'varchar',
      'varchar(64)',
      'char(11)',
      'text',
      'longtext',
      'date',
      'datetime',
      'timestamp',
      'time',
      'year',
      'json',
      'blob',
      'longblob',
      'bit',
      'bit(1)',
      'enum',
      'set',
      'boolean',
      'geometry',
    ];
    for (const t of notNumeric) expect(isNumericColumnType(t)).toBe(false);
  });

  it('缺省 / 未知类型返回 false', () => {
    expect(isNumericColumnType(undefined)).toBe(false);
    expect(isNumericColumnType('')).toBe(false);
    expect(isNumericColumnType('unknown')).toBe(false);
  });

  it('不误判含数值字样的其它类型', () => {
    expect(isNumericColumnType('int4range')).toBe(false);
    expect(isNumericColumnType('point')).toBe(false);
  });
});

describe('columnTypeFromRaw（原始类型名 → ColumnType）', () => {
  it('基础类型与长度修饰', () => {
    expect(columnTypeFromRaw('int(11)')).toBe('int');
    expect(columnTypeFromRaw('bigint(20) unsigned')).toBe('bigint');
    expect(columnTypeFromRaw('varchar(64)')).toBe('varchar');
    expect(columnTypeFromRaw('char(11)')).toBe('char');
    expect(columnTypeFromRaw('decimal(10,2)')).toBe('decimal');
    expect(columnTypeFromRaw('double(8,3)')).toBe('double');
    expect(columnTypeFromRaw('json')).toBe('json');
  });

  it('日期时间：datetime 优先于 date、timestamp 优先于 time', () => {
    expect(columnTypeFromRaw('datetime')).toBe('datetime');
    expect(columnTypeFromRaw('timestamp')).toBe('timestamp');
    expect(columnTypeFromRaw('date')).toBe('date');
    expect(columnTypeFromRaw('time')).toBe('time');
  });

  it('文本与二进制：blob 家族统一归 blob（不再把 longblob 当 text）', () => {
    expect(columnTypeFromRaw('longtext')).toBe('text');
    expect(columnTypeFromRaw('mediumtext')).toBe('text');
    expect(columnTypeFromRaw('blob')).toBe('blob');
    expect(columnTypeFromRaw('longblob')).toBe('blob');
    expect(columnTypeFromRaw('mediumblob')).toBe('blob');
    expect(columnTypeFromRaw('tinyblob')).toBe('blob');
  });

  it('未识别类型原样返回（BIT 归一化依赖此行为做前缀识别）', () => {
    expect(columnTypeFromRaw('bit(1)')).toBe('bit(1)');
    expect(columnTypeFromRaw('bit')).toBe('bit');
  });

  it('已知口径（历史行为，本次收敛未改变）：含 "int" 子串的类型会归到 int', () => {
    // 例如 spatial 的 point / linestring。属既有实现的行为，
    // 若将来要收紧，需单独作为一次行为变更处理并补测试。
    expect(columnTypeFromRaw('point')).toBe('int');
  });
});

describe('columnTypeFromCode（mysql2 类型码 → ColumnType）', () => {
  it('常见码值', () => {
    expect(columnTypeFromCode(3)).toBe('int');
    expect(columnTypeFromCode(8)).toBe('bigint');
    expect(columnTypeFromCode(246)).toBe('decimal');
    expect(columnTypeFromCode(253)).toBe('varchar');
    expect(columnTypeFromCode(10)).toBe('date');
    expect(columnTypeFromCode(12)).toBe('datetime');
    expect(columnTypeFromCode(16)).toBe('bit');
    expect(columnTypeFromCode(245)).toBe('json');
    expect(columnTypeFromCode(254)).toBe('char');
  });

  it('blob 家族（249-252）统一为 blob', () => {
    for (const code of [249, 250, 251, 252]) expect(columnTypeFromCode(code)).toBe('blob');
  });

  it('未识别码返回 unknown', () => {
    expect(columnTypeFromCode(9999)).toBe('unknown');
  });

  it('与 columnTypeFromRaw 口径一致：longblob 不会一侧 blob 一侧 text', () => {
    expect(columnTypeFromRaw('longblob')).toBe(columnTypeFromCode(252));
  });
});
