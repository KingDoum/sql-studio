/**
 * sql-ident.ts 单测。
 *
 * 该模块是 SQL 标识符转义的**唯一来源**（此前有 3 份实现，其中两个同名函数
 * 一个带反引号包裹、一个不带）。因此这里把三层语义分别钉死：
 * 只转义 / 转义+包裹 / 解析限定名并拒绝片段。
 */
import { describe, it, expect } from 'vitest';
import { escapeIdentRaw, quoteIdent, quoteQualifiedIdent } from '@shared/sql-ident';

describe('escapeIdentRaw（只转义，不包裹）', () => {
  it('反引号写成两个', () => {
    expect(escapeIdentRaw('users')).toBe('users');
    expect(escapeIdentRaw('a`b')).toBe('a``b');
    expect(escapeIdentRaw('`')).toBe('``');
  });

  it('不加反引号（与 quoteIdent 的关键区别）', () => {
    expect(escapeIdentRaw('t')).not.toContain('`t`');
  });
});

describe('quoteIdent（转义 + 反引号包裹）', () => {
  it('普通名直接包裹', () => {
    expect(quoteIdent('users')).toBe('`users`');
  });

  it('内嵌反引号先转义再包裹', () => {
    expect(quoteIdent('a`b')).toBe('`a``b`');
    expect(quoteIdent('订单`表')).toBe('`订单``表`');
  });

  it('点号在单段内是合法字符，不做拆分', () => {
    expect(quoteIdent('weird.name')).toBe('`weird.name`');
  });
});

describe('quoteQualifiedIdent（解析 db.table）', () => {
  it('单段与两段', () => {
    expect(quoteQualifiedIdent('users')).toBe('`users`');
    expect(quoteQualifiedIdent('db1.users')).toBe('`db1`.`users`');
  });

  it('容忍段前后空白', () => {
    expect(quoteQualifiedIdent('  db1 . users  ')).toBe('`db1`.`users`');
  });

  it('每段独立转义', () => {
    expect(quoteQualifiedIdent('d`b.t`bl')).toBe('`d``b`.`t``bl`');
  });

  it('空输入抛错', () => {
    expect(() => quoteQualifiedIdent('')).toThrow('导出表名为空');
    expect(() => quoteQualifiedIdent('   ')).toThrow('导出表名为空');
  });

  it('超过两段抛错', () => {
    expect(() => quoteQualifiedIdent('a.b.c')).toThrow('无效表名');
  });

  it('空段抛错', () => {
    expect(() => quoteQualifiedIdent('a.')).toThrow('无效表名');
    expect(() => quoteQualifiedIdent('.a')).toThrow('无效表名');
  });

  it('拒绝把 SQL 片段当标识符（分号 / 括号 / 换行）', () => {
    expect(() => quoteQualifiedIdent('users; DROP TABLE x')).toThrow('表名包含非法字符');
    expect(() => quoteQualifiedIdent('f(1)')).toThrow('表名包含非法字符');
    expect(() => quoteQualifiedIdent('a\nb')).toThrow('表名包含非法字符');
    expect(() => quoteQualifiedIdent('a\rb')).toThrow('表名包含非法字符');
  });
});
