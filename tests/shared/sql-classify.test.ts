/**
 * sql-classify 共享分类模块测试（S3）。
 * 覆盖：明确写、明确读、CTE 写/读、CALL、多语句混合、注释/字符串/括号干扰、
 * 大小写与前置空白、未知语句按高风险。
 */
import { describe, it, expect } from 'vitest';
import {
  classifyStatement,
  classifyStatements,
  isExplicitWrite,
  requiresWriteConfirm,
  firstKeyword,
} from '@shared/sql-classify';

describe('firstKeyword', () => {
  it('跳过前置空白与大小写', () => {
    expect(firstKeyword('  \n\tSELECT 1')).toBe('SELECT');
    expect(firstKeyword('insert into t')).toBe('INSERT');
  });
  it('跳过前置行/块注释', () => {
    expect(firstKeyword('-- hello\nSELECT 1')).toBe('SELECT');
    expect(firstKeyword('/* block */ UPDATE t')).toBe('UPDATE');
    expect(firstKeyword('# hash comment\nDELETE FROM t')).toBe('DELETE');
  });
  it('跳过前置括号（嵌套查询包裹）', () => {
    expect(firstKeyword('(SELECT 1)')).toBe('SELECT');
    expect(firstKeyword('((WITH c AS (SELECT 1) SELECT * FROM c))')).toBe('WITH');
  });
  it('纯注释/空白返回 null', () => {
    expect(firstKeyword('-- only comment')).toBeNull();
    expect(firstKeyword('   \n  ')).toBeNull();
  });
});

describe('classifyStatement 明确写', () => {
  it('INSERT/UPDATE/DELETE/REPLACE', () => {
    expect(classifyStatement('INSERT INTO t VALUES (1)')).toBe('write');
    expect(classifyStatement('UPDATE t SET a=1')).toBe('write');
    expect(classifyStatement('DELETE FROM t WHERE id=1')).toBe('write');
    expect(classifyStatement('REPLACE INTO t VALUES (1)')).toBe('write');
  });
  it('ALTER/DROP/TRUNCATE/CREATE/RENAME', () => {
    expect(classifyStatement('ALTER TABLE t ADD c INT')).toBe('write');
    expect(classifyStatement('DROP TABLE t')).toBe('write');
    expect(classifyStatement('TRUNCATE TABLE t')).toBe('write');
    expect(classifyStatement('CREATE TABLE t (id INT)')).toBe('write');
    expect(classifyStatement('RENAME TABLE a TO b')).toBe('write');
  });
  it('GRANT/REVOKE/LOCK/UNLOCK/LOAD 视为写', () => {
    expect(classifyStatement('GRANT SELECT ON *.* TO u')).toBe('write');
    expect(classifyStatement('LOCK TABLES t WRITE')).toBe('write');
    expect(classifyStatement('LOAD DATA INFILE "x" INTO TABLE t')).toBe('write');
  });
});

describe('classifyStatement 明确读', () => {
  it('SELECT/SHOW/EXPLAIN/DESCRIBE/USE/SET', () => {
    expect(classifyStatement('SELECT * FROM t')).toBe('read');
    expect(classifyStatement('SHOW TABLES')).toBe('read');
    expect(classifyStatement('EXPLAIN SELECT 1')).toBe('read');
    expect(classifyStatement('DESCRIBE t')).toBe('read');
    expect(classifyStatement('USE mydb')).toBe('read');
    expect(classifyStatement('SET @x = 1')).toBe('read');
  });
  it('大小写不敏感', () => {
    expect(classifyStatement('select 1')).toBe('read');
    expect(classifyStatement('SeLeCt 1')).toBe('read');
    expect(classifyStatement('insert into t values (1)')).toBe('write');
  });
});

describe('classifyStatement CTE', () => {
  it('WITH ... SELECT 为读', () => {
    expect(classifyStatement('WITH c AS (SELECT 1) SELECT * FROM c')).toBe('read');
    expect(classifyStatement('WITH RECURSIVE c AS (SELECT 1 UNION SELECT 2) SELECT * FROM c')).toBe('read');
  });
  it('WITH ... INSERT/UPDATE/DELETE 为写', () => {
    expect(classifyStatement('WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c')).toBe('write');
    expect(classifyStatement('WITH c AS (SELECT 1) UPDATE t JOIN c ON t.id=c.id SET t.x=1')).toBe('write');
    expect(classifyStatement('WITH c AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT id FROM c)')).toBe('write');
  });
  it('多 CTE 列表', () => {
    expect(classifyStatement('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b')).toBe('read');
    expect(classifyStatement('WITH a AS (SELECT 1), b AS (SELECT 2) REPLACE INTO t SELECT * FROM a')).toBe('write');
  });
});

describe('classifyStatement 干扰与不确定', () => {
  it('前置注释包裹的写操作识别为写', () => {
    expect(classifyStatement('-- 导出\n/* hint */ INSERT INTO t VALUES (1)')).toBe('write');
    expect(classifyStatement('/* hint */ DELETE FROM t')).toBe('write');
  });
  it('字符串/标识符内的关键字不误判', () => {
    expect(classifyStatement("SELECT 'INSERT INTO t'")).toBe('read');
    expect(classifyStatement('SELECT `update` FROM t')).toBe('read');
    expect(classifyStatement("SELECT 'select' FROM t WHERE x='delete'")).toBe('read');
  });
  it('CALL 为 unknown（存储过程可能写，需确认）', () => {
    expect(classifyStatement('CALL refresh_stats()')).toBe('unknown');
    expect(classifyStatement('call p()')).toBe('unknown');
  });
  it('无法识别的其它语句按 unknown 高风险', () => {
    expect(classifyStatement('HELP something')).toBe('unknown');
    expect(classifyStatement('DO SLEEP(1)')).toBe('unknown');
  });
  it('空串/纯注释为 read（无操作）', () => {
    expect(classifyStatement('')).toBe('read');
    expect(classifyStatement('   ')).toBe('read');
    expect(classifyStatement('-- just a comment')).toBe('read');
  });
});

describe('classifyStatements / 确认策略', () => {
  it('多语句含写 → write', () => {
    expect(classifyStatements(['SELECT 1', 'UPDATE t SET a=1', 'SELECT 2'])).toBe('write');
  });
  it('纯读多语句 → read', () => {
    expect(classifyStatements(['SELECT 1', 'SHOW TABLES', 'SELECT 2'])).toBe('read');
  });
  it('含 unknown → unknown（高风险）', () => {
    expect(classifyStatements(['SELECT 1', 'CALL p()'])).toBe('unknown');
  });
  it('requiresWriteConfirm：write/unknown 均需确认', () => {
    expect(requiresWriteConfirm(['SELECT 1', 'UPDATE t SET a=1'])).toBe(true);
    expect(requiresWriteConfirm(['CALL p()'])).toBe(true);
    expect(requiresWriteConfirm(['SELECT 1', 'SELECT 2'])).toBe(false);
  });
  it('isExplicitWrite 仅明确写为 true', () => {
    expect(isExplicitWrite('INSERT INTO t VALUES (1)')).toBe(true);
    expect(isExplicitWrite('CALL p()')).toBe(false);
    expect(isExplicitWrite('SELECT 1')).toBe(false);
  });
});