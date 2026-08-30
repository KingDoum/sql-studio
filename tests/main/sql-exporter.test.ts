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

describe('标识符转义（S2）', () => {
  it('表名含反引号被转义，不破坏 SQL 结构', () => {
    const { writer, out } = captureWriter();
    const exporter = new SqlExporter(writer);
    exporter.export({
      options: { filePath: 'x.sql', tableName: 'we`ird' },
      columns,
      rows: [[1, 'a']],
    });
    expect(out.content).toContain('INSERT INTO `we``ird` (`id`, `name`) VALUES');
    // 转义后的标识符内部反引号成对出现，不得产生未配对的闭合逃逸
    const m = out.content!.match(/INSERT INTO (.+?) \(/);
    expect(m?.[1]).toBe('`we``ird`');
  });

  it('列名含反引号被转义', () => {
    const { writer, out } = captureWriter();
    const exporter = new SqlExporter(writer);
    const cols: ColumnMeta[] = [
      { name: 'a`b', type: 'int', nullable: false, isPrimary: false, isUnique: false },
    ];
    exporter.export({
      options: { filePath: 'x.sql', tableName: 't' },
      columns: cols,
      rows: [[1]],
    });
    expect(out.content).toContain('(`a``b`)');
  });

  it('database.table 前缀按两段标识符转义', () => {
    const { writer, out } = captureWriter();
    const exporter = new SqlExporter(writer);
    exporter.export({
      options: { filePath: 'x.sql', tableName: 'mydb.users' },
      columns,
      rows: [[1, 'a']],
    });
    expect(out.content).toContain('INSERT INTO `mydb`.`users` (`id`, `name`) VALUES');
  });

  it('恶意输入被拒绝（禁止把 SQL 片段当标识符拼接）', () => {
    const { writer } = captureWriter();
    const exporter = new SqlExporter(writer);
    // 分号/注释等结构字符直接抛错，而不是产出可执行片段
    expect(() =>
      exporter.export({
        options: { filePath: 'x.sql', tableName: 'users; DROP TABLE x; --' },
        columns,
        rows: [[1, 'a']],
      }),
    ).toThrow(/非法字符|无效表名/);
  });

  it('空表名抛错', () => {
    const { writer } = captureWriter();
    const exporter = new SqlExporter(writer);
    expect(() =>
      exporter.export({
        options: { filePath: 'x.sql', tableName: '   ' },
        columns,
        rows: [[1, 'a']],
      }),
    ).toThrow();
  });
});

describe('batchSize 校验（S2）', () => {
  it('batchSize=0 抛错（避免死循环）', () => {
    const { writer } = captureWriter();
    const exporter = new SqlExporter(writer);
    expect(() =>
      exporter.export({
        options: { filePath: 'x.sql', tableName: 't', batchSize: 0 },
        columns,
        rows: [[1, 'a']],
      }),
    ).toThrow();
  });

  it('batchSize 负数抛错', () => {
    const { writer } = captureWriter();
    const exporter = new SqlExporter(writer);
    expect(() =>
      exporter.export({
        options: { filePath: 'x.sql', tableName: 't', batchSize: -5 },
        columns,
        rows: [[1, 'a']],
      }),
    ).toThrow();
  });

  it('batchSize 非整数抛错', () => {
    const { writer } = captureWriter();
    const exporter = new SqlExporter(writer);
    expect(() =>
      exporter.export({
        options: { filePath: 'x.sql', tableName: 't', batchSize: 2.5 },
        columns,
        rows: [[1, 'a']],
      }),
    ).toThrow();
  });

  it('大批量行不会死循环且行数正确', () => {
    const { writer, out } = captureWriter();
    const exporter = new SqlExporter(writer);
    const rows = Array.from({ length: 1000 }, (_, i) => [i, `v${i}`]);
    const n = exporter.export({
      options: { filePath: 'x.sql', tableName: 't', batchSize: 250 },
      columns,
      rows,
    });
    expect(n).toBe(1000);
    expect((out.content!.match(/INSERT INTO/g) ?? []).length).toBe(4);
  });
});

describe('值边界（S2 补齐）', () => {
  it('NUL、回车、换行、反斜杠、单引号全部转义', () => {
    expect(escapeSqlValue('a\0b')).toBe("'a\\0b'");
    expect(escapeSqlValue('a\rb')).toBe("'a\\rb'");
    expect(escapeSqlValue('a\nb')).toBe("'a\\nb'");
    expect(escapeSqlValue("it's \\ fine")).toBe("'it\\'s \\\\ fine'");
  });

  it('显式 columns 覆盖结果集列名', () => {
    const { writer, out } = captureWriter();
    const exporter = new SqlExporter(writer);
    exporter.export({
      options: { filePath: 'x.sql', tableName: 't', columns: ['c1', 'c2'] },
      columns,
      rows: [[1, 'a']],
    });
    expect(out.content).toContain('(`c1`, `c2`)');
  });
});
