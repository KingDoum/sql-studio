// @vitest-environment jsdom
/**
 * 任务 8 UI 组件测试（ObjectExplorer）。
 * mock window.sqlStudio 的 schema:* 通道，验证库/表/字段懒加载树、双击表回调、预览按钮。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ObjectExplorer } from '@renderer/components/ObjectExplorer';
import type { TableMeta, ColumnMeta } from '@shared/types';

const TABLES: TableMeta[] = [
  { name: 'users', type: 'table', isView: false, comment: '用户表' },
  { name: 'v_active', type: 'view', isView: true },
];

const COLUMNS: ColumnMeta[] = [
  { name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true },
  { name: 'email', type: 'varchar', nullable: false, isPrimary: false, isUnique: false },
  { name: 'bio', type: 'text', nullable: true, isPrimary: false, isUnique: false },
];

/** mock window.sqlStudio 的 schema 通道。 */
function mockSchema() {
  const sqlStudio = {
    'schema:databases': vi.fn(async () => ['test_db', 'information_schema']),
    'schema:tables': vi.fn(async () => TABLES),
    'schema:columns': vi.fn(async () => COLUMNS),
  };
  (window as unknown as { sqlStudio: unknown }).sqlStudio = sqlStudio;
  return sqlStudio;
}

describe('ObjectExplorer', () => {
  beforeEach(() => {
    mockSchema();
  });

  it('加载数据库列表并按库名渲染', async () => {
    render(<ObjectExplorer connectionId="c1" />);
    expect(await screen.findByText(/test_db/)).toBeTruthy();
    expect(screen.getByText(/information_schema/)).toBeTruthy();
  });

  it('展开库时懒加载表并渲染表节点', async () => {
    render(<ObjectExplorer connectionId="c1" />);
    fireEvent.click(await screen.findByText(/test_db/));
    expect(await screen.findByText(/users/)).toBeTruthy();
    expect(screen.getByText(/v_active/)).toBeTruthy();
  });

  it('展开表时懒加载字段，主键列有 pk 样式', async () => {
    render(<ObjectExplorer connectionId="c1" />);
    fireEvent.click(await screen.findByText(/test_db/));
    fireEvent.click(await screen.findByText(/users/));
    expect(await screen.findByText('id', { exact: false })).toBeTruthy();
    expect(screen.getByText('email', { exact: false })).toBeTruthy();
    const pkRow = screen.getByText('id', { exact: false }).closest('li');
    expect(pkRow?.className).toContain('pk');
  });

  it('点击预览按钮触发 onPreviewTable 回调', async () => {
    const onPreview = vi.fn();
    render(<ObjectExplorer connectionId="c1" onPreviewTable={onPreview} />);
    fireEvent.click(await screen.findByText(/test_db/));
    // 第一个「预览」按钮在 users 行上
    const previewBtns = await screen.findAllByText('预览');
    expect(previewBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(previewBtns[0]);
    expect(onPreview).toHaveBeenCalledWith('test_db', 'users');
  });

  it('双击表触发 onOpenTable 回调（生成 SELECT 到编辑器）', async () => {
    const onOpen = vi.fn();
    render(<ObjectExplorer connectionId="c1" onOpenTable={onOpen} />);
    fireEvent.click(await screen.findByText(/test_db/));
    fireEvent.dblClick(await screen.findByText(/users/));
    expect(onOpen).toHaveBeenCalledWith('test_db', 'users');
  });

  it('加载失败展示错误信息', async () => {
    (window as unknown as { sqlStudio: { 'schema:databases': () => Promise<never> } }).sqlStudio = {
      'schema:databases': vi.fn(async () => {
        throw new Error('连接已断开');
      }),
    };
    render(<ObjectExplorer connectionId="c1" />);
    expect(await screen.findByText('连接已断开')).toBeTruthy();
  });

  it('连接切换后重载数据库列表', async () => {
    render(<ObjectExplorer connectionId="c1" />);
    expect(await screen.findByText(/test_db/)).toBeTruthy();
    const store = window.sqlStudio as unknown as { 'schema:databases': ReturnType<typeof vi.fn> };
    const firstCall = store['schema:databases'].mock.calls.length;
    render(<ObjectExplorer connectionId="c2" />);
    await waitFor(() => expect(firstCall + 1).toBeLessThanOrEqual(store['schema:databases'].mock.calls.length));
  });

  it('阶段6：大量数据库/表时由 .db-list 统一纵向滚动（结构调整为单滚动容器）', async () => {
    // 40 个库，每库 5 张表，模拟内容超出的场景
    const manyDbs = Array.from({ length: 40 }, (_, i) => `db_${i}`);
    const manyTables: TableMeta[] = Array.from({ length: 5 }, (_, i) => ({ name: `t_${i}`, type: 'table', isView: false }));
    (window as unknown as { sqlStudio: { [k: string]: () => Promise<unknown> } }).sqlStudio = {
      'schema:databases': vi.fn(async () => manyDbs),
      'schema:tables': vi.fn(async () => manyTables),
      'schema:columns': vi.fn(async () => COLUMNS),
    };
    const { container } = render(<ObjectExplorer connectionId="c1" />);
    // 全部库渲染（第一条与最后一条都在）
    expect(await screen.findByText(/db_0/)).toBeTruthy();
    expect(await screen.findByText(/db_39/)).toBeTruthy();
    // 结构约束：.explorer（高度容器）→ .db-list（唯一顶层滚动容器）
    const explorer = container.querySelector('.explorer') as HTMLElement;
    expect(explorer).toBeTruthy();
    const dbList = container.querySelector('.db-list') as HTMLElement;
    expect(dbList).toBeTruthy();
    // 展开一个库，确认表/字段列表是 db-list 的子级（共享同一滚动源），而非独立滚动区
    fireEvent.click(await screen.findByText(/db_0/));
    expect(await screen.findByText(/t_0/)).toBeTruthy();
    const tableList = container.querySelector('.table-list') as HTMLElement;
    // 嵌套列表不另设内联 overflow（避免多个 ul 各自抢滚动；CSS 由真实浏览器 e2e 验证）
    expect(tableList).toBeTruthy();
    expect(tableList?.getAttribute('style')).toBeNull();
    expect(dbList.contains(tableList)).toBe(true);
  });
});