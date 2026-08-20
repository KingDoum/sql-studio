/**
 * sql-utils 纯逻辑测试（任务 9）。
 */
import { describe, it, expect } from 'vitest';
import {
  splitStatements,
  getCurrentStatement,
  buildSelectSql,
  basename,
} from '@renderer/lib/sql-utils';

describe('splitStatements', () => {
  it('按分号拆分多语句', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('忽略字符串与注释内的分号', () => {
    const sql = "SELECT 'a;b'; -- c;d\nSELECT 2/* ; */;";
    // 语句边界只认代码区 ;；行内注释是语句的前缀内容，保留（与 MySQL 行为一致）
    expect(splitStatements(sql)).toEqual(["SELECT 'a;b'", '-- c;d\nSELECT 2/* ; */']);
  });

  it('反引号内的分号不切分', () => {
    expect(splitStatements('SELECT `x;y` FROM t;')).toEqual(['SELECT `x;y` FROM t']);
  });

  it('过滤空语句段', () => {
    expect(splitStatements('SELECT 1;;  ; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('无结尾分号收尾语句也返回', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('getCurrentStatement', () => {
  it('取光标所在语句', () => {
    const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
    // 光标在第 2 条语句内部
    const idx = sql.indexOf('SELECT 2') + 5;
    expect(getCurrentStatement(sql, idx)).toBe('SELECT 2');
  });

  it('首尾边界正常', () => {
    expect(getCurrentStatement('SELECT 1; SELECT 2', 2)).toBe('SELECT 1');
    // offset 超出串长时收敛到末尾
    expect(getCurrentStatement('SELECT 1; SELECT 2', 999)).toBe('SELECT 2');
  });

  it('空输入返回空串', () => {
    expect(getCurrentStatement('', 0)).toBe('');
  });
});

describe('buildSelectSql', () => {
  it('生成反引号限定的 SELECT', () => {
    expect(buildSelectSql('mydb', 'users')).toBe('SELECT * FROM `mydb`.`users`;');
  });

  it('转义标识符内的反引号', () => {
    expect(buildSelectSql('db`a', 't`b')).toBe('SELECT * FROM `db``a`.`t``b`;');
  });
});

describe('basename', () => {
  it('取路径末段，兼容 \\ 与 /', () => {
    expect(basename('/a/b/c.sql')).toBe('c.sql');
    expect(basename('C:\\x\\y.sql')).toBe('y.sql');
  });
});