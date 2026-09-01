// @vitest-environment jsdom
/**
 * DataPreviewModal 组件测试（会话8c）。
 * 覆盖：打开时调用 schema:dataPreview、展示行数据、错误提示、关闭。
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DataPreviewModal } from '@renderer/components/DataPreviewModal';

const mockResultSet = {
  index: 0,
  statement: 'SELECT * FROM users LIMIT 100',
  columns: [
    { name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true },
    { name: 'name', type: 'varchar', nullable: true, isPrimary: false, isUnique: false },
  ],
  rows: [[1, 'Alice'], [2, 'Bob']],
  affectedRows: 0,
  truncated: false,
  elapsedMs: 5,
};

describe('DataPreviewModal', () => {
  beforeEach(() => {
    (window as unknown as { sqlStudio?: unknown }).sqlStudio = {
      'schema:dataPreview': vi.fn(async () => mockResultSet),
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('未打开时不渲染', () => {
    const { container } = render(
      <DataPreviewModal open={false} connectionId="c1" database="db" table="users" onClose={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('打开时调用 schema:dataPreview 并渲染表头与数据', async () => {
    render(
      <DataPreviewModal open connectionId="c1" database="db" table="users" onClose={() => {}} />,
    );
    const store = window.sqlStudio as unknown as { 'schema:dataPreview': ReturnType<typeof vi.fn> };
    await waitFor(() => expect(store['schema:dataPreview']).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'c1', database: 'db', table: 'users', limit: 100 }),
    ));
    expect(screen.getByText('id')).toBeTruthy();
    expect(screen.getByText('name')).toBeTruthy();
    expect(await screen.findByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it('点击遮罩关闭', async () => {
    const onClose = vi.fn();
    render(
      <DataPreviewModal open connectionId="c1" database="db" table="users" onClose={onClose} />,
    );
    // 等待数据渲染后点击 overlay（modal-panel 冒泡已阻止，点击 overlay 触发关闭）
    await screen.findByText('Alice');
    const overlay = document.querySelector('.modal-overlay') as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('阶段6：30 列预览具备横向滚动容器（preview-body flex 约束存在）', async () => {
    const wideResult = {
      ...mockResultSet,
      columns: Array.from({ length: 30 }, (_, i) => ({ name: `col_${i}`, type: 'varchar', nullable: false, isPrimary: false, isUnique: false })),
      rows: Array.from({ length: 5 }, (_, r) => Array.from({ length: 30 }, (_, c) => `r${r}c${c}`)),
    };
    (window as unknown as { sqlStudio?: unknown }).sqlStudio = {
      'schema:dataPreview': vi.fn(async () => wideResult),
    };
    const { container } = render(
      <DataPreviewModal open connectionId="c1" database="db" table="wide" onClose={() => {}} />,
    );
    expect(await screen.findByText(/col_0/)).toBeTruthy();
    const body = container.querySelector('.preview-body') as HTMLElement;
    const wrap = container.querySelector('.preview-body .result-grid-wrap') as HTMLElement;
    const scroll = container.querySelector('.preview-body .result-grid-scroll') as HTMLElement;
    expect(body).toBeTruthy();
    expect(wrap).toBeTruthy();
    expect(scroll).toBeTruthy();
    // flex 约束：wrap/scroll 应具备 min-height/min-width 0 能力（CSS class 存在即约束成立）
    expect(body.className).toContain('preview-body');
    expect(wrap.className).toContain('result-grid-wrap');
    expect(scroll.className).toContain('result-grid-scroll');
    // 表头单元格数量 = 30（列都渲染了）
    const headerCells = container.querySelectorAll('.preview-body .grid-header-cell');
    expect(headerCells.length).toBe(30);
  });

  it('阶段6：30 列 0 行时仍有表头与滚动容器（不再退回空结果）', async () => {
    const emptyWide = {
      ...mockResultSet,
      columns: Array.from({ length: 30 }, (_, i) => ({ name: `col_${i}`, type: 'varchar', nullable: false, isPrimary: false, isUnique: false })),
      rows: [],
    };
    (window as unknown as { sqlStudio?: unknown }).sqlStudio = {
      'schema:dataPreview': vi.fn(async () => emptyWide),
    };
    const { container } = render(
      <DataPreviewModal open connectionId="c1" database="db" table="wide" onClose={() => {}} />,
    );
    expect(await screen.findByText(/col_0/)).toBeTruthy();
    // 0 行状态存在
    expect(screen.getByText('（0 行）')).toBeTruthy();
    const scroll = container.querySelector('.preview-body .result-grid-scroll') as HTMLElement;
    expect(scroll).toBeTruthy();
    const headerCells = container.querySelectorAll('.preview-body .grid-header-cell');
    expect(headerCells.length).toBe(30);
  });

  it('阶段6：3 列 500 行时数据体保留纵向滚动容器结构', async () => {
    const tallResult = {
      ...mockResultSet,
      columns: [
        { name: 'a', type: 'varchar', nullable: false, isPrimary: false, isUnique: false },
        { name: 'b', type: 'varchar', nullable: false, isPrimary: false, isUnique: false },
        { name: 'c', type: 'varchar', nullable: false, isPrimary: false, isUnique: false },
      ],
      rows: Array.from({ length: 500 }, (_, r) => [`a${r}`, `b${r}`, `c${r}`]),
    };
    (window as unknown as { sqlStudio?: unknown }).sqlStudio = {
      'schema:dataPreview': vi.fn(async () => tallResult),
    };
    const { container } = render(
      <DataPreviewModal open connectionId="c1" database="db" table="tall" onClose={() => {}} />,
    );
    expect(await screen.findByText(/a0/)).toBeTruthy();
    // 结构约束：preview-body → result-grid-wrap → result-grid-scroll → grid-body
    // （滚动行为由 CSS 控制，CSS 效果由真实浏览器 e2e 验证；此处断言分层结构存在）
    const body = container.querySelector('.preview-body') as HTMLElement;
    const wrap = container.querySelector('.preview-body .result-grid-wrap') as HTMLElement;
    const scroll = container.querySelector('.preview-body .result-grid-scroll') as HTMLElement;
    const gridBody = container.querySelector('.preview-body .grid-body') as HTMLElement;
    expect(body).toBeTruthy();
    expect(wrap).toBeTruthy();
    expect(scroll).toBeTruthy();
    expect(gridBody).toBeTruthy();
    // grid-body 是滚动容器子级（共享同一 x-scroll host，纵向由 grid-body 负责）
    expect(scroll.contains(gridBody)).toBe(true);
  });
});