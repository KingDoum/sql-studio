/**
 * monaco-language 纯逻辑测试（任务 9）。
 * 校验 Monarch tokenizer 动态标识符注入与主题 token 规则（不加载真实 Monaco）。
 */
import { describe, it, expect } from 'vitest';
import { buildSqlMonarchLanguage, SQL_STUDIO_THEME } from '@renderer/lib/monaco-language';

describe('buildSqlMonarchLanguage', () => {
  it('空 schema 时不注入动态表（不会把 undefined 拼进正则）', () => {
    const def = buildSqlMonarchLanguage({ tables: [], columns: [], databases: [] });
    const root = def.tokenizer as unknown as { root: unknown[] };
    expect(Array.isArray(root.root)).toBe(true);
    expect(root.root.length).toBeGreaterThan(5);
  });

  it('动态表/字段/库名注入 cases 与标识符表', () => {
    const def = buildSqlMonarchLanguage({
      tables: ['users', 'orders'],
      columns: ['id', 'email', 'amount'],
      databases: ['app'],
    }) as unknown as {
      tables: string[];
      columns: string[];
      databases: string[];
      tokenizer: { root: Array<unknown> };
    };
    expect(def.tables).toContain('users');
    expect(def.columns).toContain('email');
    expect(def.databases).toContain('app');
    // root 中存在 cases 包含 @databases/@tables/@columns 的标识符规则
    const identRule = def.tokenizer.root.find(
      (r) => Array.isArray(r) && JSON.stringify(r).includes('@databases'),
    );
    expect(identRule).toBeTruthy();
    expect(JSON.stringify(def.tokenizer.root)).toContain('@tables');
    expect(JSON.stringify(def.tokenizer.root)).toContain('@columns');
  });

  it('custom token 输出 sql-table / sql-column / sql-db', () => {
    const def = buildSqlMonarchLanguage({
      tables: ['users'],
      columns: ['email'],
      databases: ['app'],
    });
    const json = JSON.stringify(def);
    expect(json).toContain('sql-table');
    expect(json).toContain('sql-column');
    expect(json).toContain('sql-db');
    expect(json).toContain('keyword');
  });

  it('注释/字符串/数字规则存在（基础 SQL 语法继承）', () => {
    const def = buildSqlMonarchLanguage({ tables: [], columns: [], databases: [] });
    const json = JSON.stringify(def);
    expect(json).toContain('comment');
    expect(json).toContain('string');
    expect(json).toContain('number');
  });
});

describe('SQL_STUDIO_THEME', () => {
  it('深色主题含自定义语义 token 配色', () => {
    expect(SQL_STUDIO_THEME.base).toBe('vs-dark');
    const rules = SQL_STUDIO_THEME.rules ?? [];
    expect(rules.some((r) => r.token === 'sql-table')).toBe(true);
    expect(rules.some((r) => r.token === 'sql-column')).toBe(true);
    expect(rules.some((r) => r.token === 'sql-db')).toBe(true);
    expect(rules.some((r) => r.token === 'keyword')).toBe(true);
  });

  it('背景色对齐 §7 色板 #16171F', () => {
    expect(SQL_STUDIO_THEME.colors?.['editor.background']).toBe('#16171F');
  });
});