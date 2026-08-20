// @vitest-environment jsdom
/**
 * ExportMenu 组件测试（任务 11）。
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExportMenu } from '@renderer/components/ExportMenu';
import { useWorkspace } from '@renderer/store/workspace';

function setResult() {
  useWorkspace.setState({
    execution: {
      tabId: 't1',
      connectionId: 'c1',
      sql: 'SELECT 1',
      executedAt: Date.now(),
      result: {
        connectionId: 'c1',
        totalElapsedMs: 1,
        truncated: false,
        hasWrite: false,
        resultSets: [{
          index: 0, statement: 'SELECT 1',
          columns: [{ name: 'a', type: 'int', nullable: true, isPrimary: false, isUnique: false }],
          rows: [[1]],
          affectedRows: 0, truncated: false, elapsedMs: 1,
        }],
      },
    },
  });
}

describe('ExportMenu', () => {
  beforeEach(() => {
    useWorkspace.setState({ execution: null });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn() }, writable: true, configurable: true,
    });
    vi.spyOn(window, 'prompt').mockReturnValue('/out/test.xlsx');
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    (window as unknown as { sqlStudio?: unknown }).sqlStudio = {
      'export:excel': vi.fn(async () => ({ filePath: '/out/test.xlsx', rowCount: 1 })),
      'export:insert': vi.fn(async () => ({ filePath: '/out/test.sql', rowCount: 1 })),
      'export:csv': vi.fn(async () => ({ filePath: '/out/test.csv', rowCount: 1 })),
      'settings:get': vi.fn(async () => null),
      'settings:set': vi.fn(async () => ({ saved: true })),
      'dialog:showSaveDialog': vi.fn(async () => '/out/test.xlsx'),
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('无结果时按钮禁用', () => {
    render(<ExportMenu />);
    expect(screen.getByTitle('导出结果')).toBeDisabled();
  });

  it('有结果时点击展开下拉菜单', async () => {
    setResult();
    render(<ExportMenu />);
    fireEvent.click(screen.getByTitle('导出结果'));
    expect(await screen.findByText('导出 Excel（全量）')).toBeTruthy();
    expect(screen.getByText('导出 SQL INSERT')).toBeTruthy();
  });

  it('导出 Excel 调用 export:excel', async () => {
    setResult();
    const store = window.sqlStudio as unknown as Record<string, ReturnType<typeof vi.fn>>;
    render(<ExportMenu />);
    fireEvent.click(screen.getByTitle('导出结果'));
    fireEvent.click(await screen.findByText('导出 Excel（全量）'));
    await waitFor(() => expect(store['export:excel']).toHaveBeenCalled());
  });
});