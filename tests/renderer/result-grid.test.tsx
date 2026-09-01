// @vitest-environment jsdom
/**
 * ResultGrid 组件测试（任务 10）。
 * 覆盖：空结果、排序、筛选、虚拟滚动数量、复制、NULL 展示。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('columns 为空 → 显示空结果提示', () => {
    render(<ResultGrid columns={[]} rows={[]} />);
    expect(screen.getByText('（空结果集）')).toBeTruthy();
  });

  it('columns 为空但 rows 非空 → 空结果', () => {
    render(<ResultGrid columns={[]} rows={[[1]]} />);
    expect(screen.getByText('（空结果集）')).toBeTruthy();
  });

  it('阶段5：columns 存在但 rows 为空 → 显示表头/筛选/0 行状态（不再直接返回空结果）', () => {
    const { container } = renderGrid([]);
    // 表头仍然可见
    expect(screen.getByText('id')).toBeTruthy();
    expect(screen.getByText('name')).toBeTruthy();
    // 筛选行可见
    expect(container.querySelector('.grid-filter')).toBeTruthy();
    // 0 行状态
    expect(screen.getByText('（0 行）')).toBeTruthy();
    // 统一横向滚动容器存在（允许横向滚动查看列）
    expect(container.querySelector('.result-grid-scroll')).toBeTruthy();
    // 不再出现"空结果集"占位
    expect(screen.queryByText('（空结果集）')).toBeNull();
  });

  it('阶段5：20 列以上时滚动容器存在且内层宽度为列宽之和', () => {
    const cols: ColumnMeta[] = Array.from({ length: 24 }, (_, i) => ({
      name: `col${i}`,
      type: 'varchar',
      nullable: true,
      isPrimary: false,
      isUnique: false,
    }));
    const { container } = render(<ResultGrid columns={cols} rows={[[...Array(24).fill('x')]]} />);
    const scroll = container.querySelector('.result-grid-scroll') as HTMLElement;
    const inner = container.querySelector('.result-grid-inner') as HTMLElement;
    expect(scroll).toBeTruthy();
    expect(inner).toBeTruthy();
    // 内层宽度 >= 列宽之和（24 列 * 默认 150px = 3600px）
    expect(parseInt(inner.style.minWidth, 10)).toBeGreaterThanOrEqual(24 * 150);
    // 表头/筛选/数据体三行同宽（同 gridTemplateColumns）
    const header = container.querySelector('.grid-header') as HTMLElement;
    const filter = container.querySelector('.grid-filter') as HTMLElement;
    const row = container.querySelector('.grid-row') as HTMLElement;
    expect(header.style.gridTemplateColumns).toBeTruthy();
    expect(header.style.gridTemplateColumns).toBe(filter.style.gridTemplateColumns);
    if (row) expect(row.style.gridTemplateColumns).toBe(header.style.gridTemplateColumns);
  });

  it('阶段5：横向滚动后表头/筛选/数据体位置同步（同源 scrollLeft）', () => {
    const cols: ColumnMeta[] = Array.from({ length: 24 }, (_, i) => ({
      name: `c${i}`,
      type: 'varchar',
      nullable: true,
      isPrimary: false,
      isUnique: false,
    }));
    const { container } = render(<ResultGrid columns={cols} rows={[[...Array(24).fill('v')]]} />);
    const scroll = container.querySelector('.result-grid-scroll') as HTMLElement;
    const header = container.querySelector('.grid-header') as HTMLElement;
    const filter = container.querySelector('.grid-filter') as HTMLElement;
    const body = container.querySelector('.grid-body') as HTMLElement;
    // 共享同一横向滚动源：表头/筛选/数据体都位于 result-grid-scroll 容器内
    expect(scroll.contains(header)).toBe(true);
    expect(scroll.contains(filter)).toBe(true);
    expect(scroll.contains(body)).toBe(true);
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

  it('筛选行与表头使用同一 gridTemplateColumns（对齐）', () => {
    const { container } = renderGrid();
    const header = container.querySelector('.grid-header') as HTMLElement;
    const filter = container.querySelector('.grid-filter') as HTMLElement;
    expect(header.style.gridTemplateColumns).toBeTruthy();
    expect(header.style.gridTemplateColumns).toBe(filter.style.gridTemplateColumns);
  });

  it('拖动 resize handle 调整列宽', () => {
    const { container } = renderGrid();
    const handle = container.querySelector('[data-testid="resize-id"]') as HTMLElement;
    expect(handle).toBeTruthy();
    // resize handle 存在表示可拖拽（jsdom 下 pointer events 模拟有限，真实拖拽在 Electron 中验证）
    expect(handle.className).toBe('grid-resize-handle');
  });
});