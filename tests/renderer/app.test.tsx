// @vitest-environment jsdom
/**
 * 任务 8/9 冒烟验收（渲染层集成测试）。
 * 渲染 <App/>（完整工作台 shell）+ mock window.sqlStudio，
 * 验证：连接列表 → 选中连接 → 对象浏览器出现 → 库展开为表 → 双击表生成 SELECT 标签。
 * 任务 9 追加：新建标签 → 编辑 → 保存（script:save）流程。
 * 说明：Electron GUI 冒烟需图形环境（原开发机 Windows），
 * NAS 无头环境以本集成测试作为冒烟代理（R3「能跑的都跑」）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '@renderer/App';
import { useWorkspace } from '@renderer/store/workspace';

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

function mockFullSqlStudio(overrides: Record<string, unknown> = {}) {
  const sqlStudio = {
    'app:ping': vi.fn(async () => 'pong'),
    'connections:list': vi.fn(async () => [
      { id: 'c1', name: '本地', host: '127.0.0.1', port: 3306, user: 'root', charset: 'utf8mb4', database: 'test', createdAt: 1, updatedAt: 1 },
    ]),
    'connections:save': vi.fn(async () => ({ id: 'c2', name: 'x', host: 'h', port: 3306, user: 'u', charset: 'utf8mb4', createdAt: 1, updatedAt: 1 })),
    'connections:remove': vi.fn(async () => ({ removed: true })),
    'connections:test': vi.fn(async () => ({ ok: true, message: 'ok' })),
    'schema:databases': vi.fn(async () => ['test_db']),
    'schema:tables': vi.fn(async () => [
      { name: 'users', type: 'table', isView: false },
    ]),
    'schema:columns': vi.fn(async () => [
      { name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true },
    ]),
    'script:open': vi.fn(async () => ({ filePath: '/x/old.sql', content: 'SELECT 9;' })),
    'script:save': vi.fn(async (arg: { filePath: string; content: string }) => ({ filePath: arg.filePath })),
    'query:execute': vi.fn(async () => ({
      connectionId: 'c1',
      resultSets: [],
      totalElapsedMs: 1,
      truncated: false,
      hasWrite: false,
    })),
    ...overrides,
  };
  (window as unknown as { sqlStudio: unknown }).sqlStudio = sqlStudio;
  return sqlStudio;
}

describe('App 工作台冒烟', () => {
  beforeEach(() => {
    // 重置模块级 zustand store，避免用例间状态泄漏
    useWorkspace.setState({
      currentConnectionId: null,
      tabs: [],
      activeTabId: null,
      execution: null,
    });
    mockFullSqlStudio();
    vi.spyOn(window, 'prompt').mockReturnValue('/save/script.sql');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('渲染连接列表并选中后展示对象浏览器', async () => {
    render(<App />);

    expect(screen.getByText('SQL Studio')).toBeTruthy();
    expect(await screen.findByText('本地')).toBeTruthy();
    expect(screen.getByText(/root@127.0.0.1:3306/)).toBeTruthy();
    expect(screen.getByText(/请选择一个连接/)).toBeTruthy();

    fireEvent.click(screen.getByText('本地'));
    expect(await screen.findByText('对象浏览器')).toBeTruthy();

    fireEvent.click(await screen.findByText(/test_db/));
    expect(await screen.findByText(/users/)).toBeTruthy();
  });

  it('双击表生成 SELECT 新标签', async () => {
    render(<App />);
    fireEvent.click(await screen.findByText('本地'));
    fireEvent.click(await screen.findByText(/test_db/));
    const table = await screen.findByText(/users/);
    // 双击表（注意：table-item 上有 preview 按钮，双击需落在表名上）
    fireEvent.dblClick(table.closest('div') as HTMLElement);
    const stub = await screen.findByTestId('monaco-stub');
    expect((stub as HTMLTextAreaElement).value).toContain('SELECT * FROM `test_db`.`users`');
    expect(screen.getByText(/test_db.users/)).toBeTruthy();
  });

  it('新建标签 → 编辑变脏 → 保存（另存为路径）', async () => {
    const store = mockFullSqlStudio();
    render(<App />);
    fireEvent.click(await screen.findByText('新建'));
    const stub = await screen.findByTestId('monaco-stub');
    fireEvent.change(stub, { target: { value: 'SELECT 42;' } });
    // 脏标记出现（tab id 动态生成，直接断言 .tab-dirty 存在）
    await waitFor(() => expect(document.querySelector('.tab-dirty')).toBeTruthy());
    // 保存（无 filePath → 走 prompt 另存为）
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() =>
      expect(store['script:save']).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: '/save/script.sql', content: 'SELECT 42;' }),
      ),
    );
  });

  it('打开脚本（prompt 路径）→ 标签出现', async () => {
    const store = mockFullSqlStudio();
    render(<App />);
    fireEvent.click(await screen.findByText('打开'));
    await waitFor(() => expect(store['script:open']).toHaveBeenCalledWith({ filePath: '/save/script.sql' }));
    const stub = await screen.findByTestId('monaco-stub');
    expect((stub as HTMLTextAreaElement).value).toBe('SELECT 9;');
  });
});