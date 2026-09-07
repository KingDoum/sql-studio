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
    defaultValue,
    onChange,
  }: {
    value?: string;
    defaultValue?: string;
    onChange?: (v: string | undefined) => void;
  }) {
    return (
      <textarea
        data-testid="monaco-stub"
        value={value ?? defaultValue ?? ''}
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
    'settings:get': vi.fn(async () => null),
    'settings:set': vi.fn(async () => ({ saved: true })),
    'dialog:showSaveDialog': vi.fn(async () => '/save/script.sql'),
    'dialog:showOpenDialog': vi.fn(async () => '/save/script.sql'),
    'connections:testById': vi.fn(async () => ({ ok: true, message: 'ok' })),
    'schema:ddl': vi.fn(async () => ({ ddl: 'CREATE TABLE users (id int)' })),
    // 工作区恢复（S3/S5）
    'workspace:load': vi.fn(async () => ({
      snapshot: null,
      recoveredTabCount: 0,
      quarantinedTabCount: 0,
      warnings: [],
    })),
    'workspace:save': vi.fn(async (arg: { snapshot: { revision: number } }) => ({
      saved: true,
      acceptedRevision: arg.snapshot.revision,
      storedRevision: arg.snapshot.revision,
      reason: 'saved' as const,
    })),
    'workspace:clear': vi.fn(async () => ({ cleared: true })),
    // 持久日志（S4）
    'logs:append': vi.fn(async () => ({ accepted: 0, dropped: 0 })),
    'logs:read': vi.fn(async () => ({ entries: [], timezone: 'Asia/Shanghai', truncated: false })),
    'logs:clear': vi.fn(async () => ({ cleared: true, removedFileCount: 0 })),
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
    fireEvent.dblClick(table.closest('div') as HTMLElement);
    const stub = await screen.findByTestId('monaco-stub');
    expect((stub as HTMLTextAreaElement).value).toContain('SELECT * FROM `test_db`.`users`');
    // 新标签为未命名（不再用假 filePath）
    expect(screen.getByText(/未命名/)).toBeTruthy();
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

describe('App · 工作区恢复（S3/S5）', () => {
  beforeEach(() => {
    useWorkspace.setState({
      currentConnectionId: null,
      tabs: [],
      activeTabId: null,
      execution: null,
      executionHistory: [],
      executing: null,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  function snapshotWith(partial: Record<string, unknown>) {
    return {
      workspaceId: 'default',
      schemaVersion: 1,
      revision: 3,
      activeTabId: 't1',
      currentConnectionId: 'c1',
      createdAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-07T00:00:00.000Z',
      tabs: [
        {
          id: 't1',
          tabOrder: 0,
          title: '未命名-1',
          filePath: null,
          sqlContent: 'SELECT 恢复内容',
          isDirty: true,
          connectionId: null,
          createdAt: '2026-09-07T00:00:00.000Z',
          updatedAt: '2026-09-07T00:00:00.000Z',
        },
      ],
      ...partial,
    };
  }

  it('WS-02 正常重启恢复标签顺序、内容与活动项', async () => {
    mockFullSqlStudio({
      'workspace:load': vi.fn(async () => ({
        snapshot: snapshotWith({}),
        recoveredTabCount: 1,
        quarantinedTabCount: 0,
        warnings: [],
      })),
    });
    render(<App />);
    const stub = await screen.findByTestId('monaco-stub');
    await waitFor(() => expect((stub as HTMLTextAreaElement).value).toBe('SELECT 恢复内容'));
    // 未命名标签保持未命名且为脏
    expect(screen.getByText(/未命名-1/)).toBeTruthy();
    expect(document.querySelector('.tab-dirty')).toBeTruthy();
  });

  it('WS-19 恢复的连接已删除 → currentConnectionId 回退 null（文本仍恢复）', async () => {
    mockFullSqlStudio({
      // 连接列表只有 c2；快照 currentConnectionId=c1（已删除）
      'connections:list': vi.fn(async () => [
        { id: 'c2', name: '新连接', host: 'h', port: 3306, user: 'u', charset: 'utf8mb4', createdAt: 1, updatedAt: 1 },
      ]),
      'workspace:load': vi.fn(async () => ({
        snapshot: snapshotWith({ currentConnectionId: 'c1' }),
        recoveredTabCount: 1,
        quarantinedTabCount: 0,
        warnings: [],
      })),
    });
    render(<App />);
    // SQL 文本恢复不因连接失效受阻
    const stub = await screen.findByTestId('monaco-stub');
    await waitFor(() => expect((stub as HTMLTextAreaElement).value).toBe('SELECT 恢复内容'));
    // 连接回退 null
    await waitFor(() => expect(useWorkspace.getState().currentConnectionId).toBeNull());
  });

  it('WS-06 恢复失败（load reject）→ 启动空工作区不白屏', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFullSqlStudio({
      'workspace:load': vi.fn(async () => {
        throw new Error('数据库损坏');
      }),
    });
    render(<App />);
    // 应用仍渲染完整外壳（不白屏）
    expect(await screen.findByText('SQL Studio')).toBeTruthy();
    expect(screen.getByText(/请选择一个连接/)).toBeTruthy();
    expect(useWorkspace.getState().tabs).toHaveLength(0);
    errSpy.mockRestore();
  });

  it('WS-12/13 自动保存不写真实文件：恢复后编辑触发 workspace:save 而非 script:save', async () => {
    const store = mockFullSqlStudio({
      'workspace:load': vi.fn(async () => ({
        snapshot: snapshotWith({}),
        recoveredTabCount: 1,
        quarantinedTabCount: 0,
        warnings: [],
      })),
    });
    render(<App />);
    // 恢复完成后编辑内容 → 500ms 防抖自动保存
    const stub = await screen.findByTestId('monaco-stub');
    fireEvent.change(stub, { target: { value: 'SELECT 编辑后内容;' } });
    // 自动保存只走 workspace:save，绝不 script:save（§7.3/§16.6）
    await waitFor(() => expect(store['workspace:save']).toHaveBeenCalled(), { timeout: 2000 });
    expect(store['script:save']).not.toHaveBeenCalled();
  });
});

describe('App · 外观主题（阶段 E）', () => {
  beforeEach(() => {
    useWorkspace.setState({
      currentConnectionId: null,
      tabs: [],
      activeTabId: null,
      execution: null,
    });
    vi.spyOn(window, 'prompt').mockReturnValue('/save/script.sql');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // 重置 dataset.theme，避免用例间主题状态泄漏
    delete document.documentElement.dataset.theme;
  });

  /** 让 settings:get 对指定 key 返回值。 */
  function mockThemeSetting(value: string | null) {
    return mockFullSqlStudio({
      'settings:get': vi.fn(async ({ key }: { key: string }) => {
        if (key === 'theme') return value;
        return null;
      }),
    });
  }

  it('启动读取 titanium → dataset.theme 为 titanium 且写入 settings', async () => {
    const store = mockThemeSetting('titanium');
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('titanium'),
    );
    await waitFor(() =>
      expect(store['settings:set']).toHaveBeenCalledWith({ key: 'theme', value: 'titanium' }),
    );
  });

  it('启动读取 light → dataset.theme 为 light（dark/light 行为不回归）', async () => {
    mockThemeSetting('light');
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('light'),
    );
  });

  it('未知主题值回退 dark（不清空、不写非法值）', async () => {
    const store = mockThemeSetting('neon');
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('dark'),
    );
    // 不应把非法值写回设置
    const setCalls = (store['settings:set'] as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls.some((c) => c[0]?.value === 'neon')).toBe(false);
  });

  it('顶部栏「外观」按钮可打开外观面板（三种主题可见）', async () => {
    mockThemeSetting(null);
    render(<App />);
    fireEvent.click(screen.getByTitle('外观（主题与字体）'));
    expect(await screen.findByText('钛灰')).toBeTruthy();
    expect(screen.getByText('深色')).toBeTruthy();
    expect(screen.getByText('白天')).toBeTruthy();
  });
});