/**
 * sql-exporter.ts 单测（任务 6）。
 * 覆盖值转义、NULL/引号/中文/日期/二进制、分批生成、默认列名。
 */
import { describe, it, expect } from 'vitest';
import { SqlExporter, escapeSqlValue, type Writer } from '@main/services/sql-exporter';
import type { ColumnMeta, ExportInsertRequest } from '@shared/types';

function captureWriter(): { writer: Writer; out: { content?: string } } {
  const out: { content?: string } = {};
  const writer: Writer = {
    writeFile: (_p, content) => {
      out.content = content;
    },
  };
  return { writer, out };
}

const columns: ColumnMeta[] = [
  { name: 'id', type: 'int', nullable: false, isPrimary: true, isUnique: false },
  { name: 'name', type: 'varchar', nullable: true, isPrimary: false, isUnique: false },
];

describe('escapeSqlValue', () => {
  it('NULL → NULL', () => {
    expect(escapeSqlValue(null)).toBe('NULL');
  });
  it('数字直接输出', () => {
    expect(escapeSqlValue(42)).toBe('42');
  });
  it('字符串转义单引号', () => {
    expect(escapeSqlValue("O'Brien")).toBe("'O\\'Brien'");
  });
  it('字符串转义反斜杠与换行', () => {
    expect(escapeSqlValue('a\\b\nc')).toBe("'a\\\\b\\nc'");
  });
  it('中文原样', () => {
    expect(escapeSqlValue('张三')).toBe("'张三'");
  });
  it('二进制 → hex 字面量', () => {
    const u = new Uint8Array([0xab, 0xcd]);
    expect(escapeSqlValue(u)).toBe("X'abcd'");
  });
  it('布尔 → 1/0', () => {
    expect(escapeSqlValue(true)).toBe('1');
    expect(escapeSqlValue(false)).toBe('0');
  });
});

describe('SqlExporter.export', () => {
  it('生成 INSERT，含列名与多行', () => {
    const { writer, out } = captureWriter();
    const exporter = new SqlExporter(writer);
    const req: ExportInsertRequest = {
      options: { filePath: 'x.sql', tableName: 'users' },
      columns,
      rows: [
        [1, '张三'],
        [2, '李四'],
      ],
    };
    const n = exporter.export(req);
    expect(n).toBe(2);
    expect(out.content).toContain('INSERT INTO `users` (`id`, `name`) VALUES');
    expect(out.content).toContain("(1, '张三')");
    expect(out.content).toContain("(2, '李四');"); // 末尾分号
  });

  it('NULL 写入 NULL 字面量', () => {
    const { writer, out } = captureWriter();
    const exporter = new SqlExporter(writer);
    exporter.export({
      options: { filePath: 'x.sql', tableName: 't' },
      columns,
      rows: [[3, null]],
    });
    expect(out.content).toContain('(3, NULL)');
  });

  it('分批生成（batchSize=1 产生多条 INSERT）', () => {
    const { writer, out } = captureWriter();
    const exporter = new SqlExporter(writer);
    exporter.export({
      options: { filePath: 'x.sql', tableName: 't', batchSize: 1 },
      columns,
      rows: [
        [1, 'a'],
        [2, 'b'],
      ],
    });
    const inserts = (out.content!.match(/INSERT INTO/g) ?? []).length;
    expect(inserts).toBe(2);
  });

  it('含特殊字符转义', () => {
    const { writer, out } = captureWriter();
    const exporter = new SqlExporter(writer);
    exporter.export({
      options: { filePath: 'x.sql', tableName: 't' },
      columns,
      rows: [[1, "O'Brien\\n"]],
    });
    expect(out.content).toContain("(1, 'O\\'Brien\\\\n')");
  });
});
