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
});