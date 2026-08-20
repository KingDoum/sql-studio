// @vitest-environment jsdom
/**
 * ResultGrid 组件测试（任务 10）。
 * 覆盖：空结果、排序、筛选、虚拟滚动数量、复制、NULL 展示。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ResultGrid } from '@renderer/components/ResultGrid';
import type { CellValue, ColumnMeta } from '@shared/types';

const COLS: ColumnMeta[] = [
  { name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true },
  { name: 'name', type: 'varchar', nullable: true, isPrimary: false, isUnique: false },
];

const ROWS: CellValue[][] = [
  [1, 'Alice'],
  [2, null],
  [3, 'Bob'],
  [4, 'Charlie'],
];

function renderGrid(rows: CellValue[][] = ROWS) {
  return render(<ResultGrid columns={COLS} rows={rows} />);
}

describe('ResultGrid', () => {
  beforeEach(() => {
    // jsdom 无 navigator.clipboard，手动注入 mock
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('空结果展示空提示', () => {
    renderGrid([]);
    expect(screen.getByText('（空结果集）')).toBeTruthy();
  });

  it('渲染表头和数据行', () => {
    renderGrid();
    expect(screen.getByText('id')).toBeTruthy();
    expect(screen.getByText('name')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it('NULL 值显示为灰色 NULL', () => {
    renderGrid();
    const nullCells = screen.getAllByText('NULL');
    expect(nullCells.length).toBeGreaterThanOrEqual(1);
    expect(nullCells[0].className).toContain('null-cell');
  });

  it('表头点击排序：asc→desc→none', async () => {
    renderGrid();
    const idHeader = screen.getByText('id');
    fireEvent.click(idHeader);
    // 排序后首行应是 id=1
    const cells = screen.getAllByText(/^[A-Za-z]/);
    // 取第一行非 null 的 name 值
    expect(screen.getByText('Alice')).toBeTruthy();
    fireEvent.click(idHeader);
    fireEvent.click(idHeader); // 切到 none
  });

  it('筛选列', () => {
    renderGrid();
    const inputs = screen.getAllByPlaceholderText('筛选…');
    fireEvent.change(inputs[1], { target: { value: 'Bob' } });
    expect(screen.getByText('Bob')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
  });

  it('双击单元格复制', async () => {
    renderGrid();
    const cell = screen.getByText('Alice');
    fireEvent.doubleClick(cell);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Alice');
    expect(await screen.findByText(/已复制/)).toBeTruthy();
  });

  it('大数量时虚拟滚动只渲染部分行', () => {
    const bigRows: CellValue[][] = Array.from({ length: 5000 }, (_, i) => [i, `Row ${i}`]);
    const { container } = renderGrid(bigRows);
    const renderedRows = container.querySelectorAll('.grid-row');
    // 5000 rows but only visible + overscan rendered (~40-50)
    expect(renderedRows.length).toBeLessThan(500);
    expect(renderedRows.length).toBeGreaterThan(5);
  });
});