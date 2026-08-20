// @vitest-environment jsdom
/**
 * SqlEditor 组件测试（任务 9）。
 * @monaco-editor/react 在 jsdom 无法完整加载，mock 为受控 textarea stub：
 *   - 校验 onChange 回传
 *   - 校验工具栏（连接库提示/格式化/执行按钮）渲染
 *   - 校验未连接时执行有守卫（不崩溃）
 * 补全/tokenizer/语句切分等纯逻辑在 sql-completion / monaco-language / sql-utils 测试中覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SqlEditor } from '@renderer/components/SqlEditor';
import type { EditorTab } from '@shared/types';

// mock @monaco-editor/react：受控 stub（vi.mock 会被 vitest 提升到顶部）
vi.mock('@monaco-editor/react', () => ({
  default: function MockEditor({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (v: string | undefined) => void;
  }) {
    return (
      <textarea
        data-testid="monaco-stub"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      />
    );
  },
  loader: { config: vi.fn(), init: vi.fn() },
}));

const tab: EditorTab = {
  id: 't1',
  title: 'a.sql',
  sql: 'SELECT 1;',
  filePath: '/x/a.sql',
  isDirty: false,
};

describe('SqlEditor', () => {
  beforeEach(() => {
    // connectionId 有值时 SqlEditor 会 fetch schema，给空实现
    (window as unknown as { sqlStudio?: unknown }).sqlStudio = {
      'schema:databases': vi.fn(async () => []),
      'schema:tables': vi.fn(async () => []),
      'schema:columns': vi.fn(async () => []),
    };
  });

  it('渲染 stub 编辑器并回传内容变更', async () => {
    const onSqlChange = vi.fn();
    render(
      <SqlEditor
        tab={tab}
        connectionId={null}
        onSqlChange={onSqlChange}
        onExecute={() => {}}
      />,
    );
    const stub = await screen.findByTestId('monaco-stub');
    fireEvent.change(stub, { target: { value: 'SELECT 2;' } });
    expect(onSqlChange).toHaveBeenCalledWith('SELECT 2;');
  });

  it('未连接时工具栏提示「未连接」，执行按钮点击不崩溃', async () => {
    const onExecute = vi.fn();
    render(
      <SqlEditor
        tab={tab}
        connectionId={null}
        onSqlChange={() => {}}
        onExecute={onExecute}
      />,
    );
    expect(await screen.findByText('未连接')).toBeTruthy();
    fireEvent.click(screen.getByText('▶ 执行'));
  });

  it('工具栏含格式化与执行按钮', async () => {
    render(
      <SqlEditor
        tab={tab}
        connectionId={null}
        onSqlChange={() => {}}
        onExecute={() => {}}
      />,
    );
    expect(await screen.findByText('格式化')).toBeTruthy();
    expect(screen.getByText('▶ 执行')).toBeTruthy();
  });
});