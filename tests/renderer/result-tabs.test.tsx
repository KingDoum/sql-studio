// @vitest-environment jsdom
/**
 * ResultTabs 组件测试（任务 10）。
 * 覆盖：无执行、错误、多结果集、状态栏。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResultTabs } from '@renderer/components/ResultTabs';
import { useWorkspace } from '@renderer/store/workspace';

describe('ResultTabs', () => {
  beforeEach(() => {
    useWorkspace.setState({ execution: null });
    // jsdom 无 navigator.clipboard，ResultGrid 依赖它
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  it('无执行时显示空提示', () => {
    render(<ResultTabs />);
    expect(screen.getByText(/暂无查询结果/)).toBeTruthy();
  });

  it('执行错误时显示错误面板', () => {
    useWorkspace.setState({
      execution: {
        tabId: 't1',
        connectionId: 'c1',
        sql: 'SELECT * FROM bad',
        error: 'Table "bad" doesn\'t exist',
        executedAt: Date.now(),
      },
    });
    render(<ResultTabs />);
    expect(screen.getByText(/执行失败/)).toBeTruthy();
    expect(screen.getByText(/Table "bad"/)).toBeTruthy();
  });

  it('执行成功渲染结果网格', () => {
    useWorkspace.setState({
      execution: {
        tabId: 't1',
        connectionId: 'c1',
        sql: 'SELECT 1 AS a',
        executedAt: Date.now(),
        result: {
          connectionId: 'c1',
          totalElapsedMs: 12,
          truncated: false,
          hasWrite: false,
          resultSets: [
            {
              index: 0,
              statement: 'SELECT 1 AS a',
              columns: [{ name: 'a', type: 'int', nullable: true, isPrimary: false, isUnique: false }],
              rows: [[1]],
              affectedRows: 0,
              truncated: false,
              elapsedMs: 12,
            },
          ],
        },
      },
    });
    render(<ResultTabs />);
    expect(screen.getByText(/12 ms/)).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('截断状态提示', () => {
    useWorkspace.setState({
      execution: {
        tabId: 't1',
        connectionId: 'c1',
        sql: 'SELECT 1',
        executedAt: Date.now(),
        result: {
          connectionId: 'c1',
          totalElapsedMs: 5,
          truncated: true,
          hasWrite: true,
          resultSets: [
            {
              index: 0,
              statement: 'SELECT 1',
              columns: [{ name: 'a', type: 'int', nullable: true, isPrimary: false, isUnique: false }],
              rows: [[1]],
              affectedRows: 0,
              truncated: true,
              elapsedMs: 5,
            },
          ],
        },
      },
    });
    render(<ResultTabs />);
    expect(screen.getByText(/已截断/)).toBeTruthy();
    expect(screen.getByText(/写操作/)).toBeTruthy();
  });
});