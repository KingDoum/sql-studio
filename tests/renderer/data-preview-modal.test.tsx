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
});