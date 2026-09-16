// @vitest-environment jsdom
/**
 * 任务 8 UI 组件测试（ConnectionManager + ConnectionForm）。
 * mock window.sqlStudio，验证列表加载、保存、测试、删除交互。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionManager } from '@renderer/components/ConnectionManager';
import { ConnectionForm } from '@renderer/components/ConnectionForm';
import type { ConnectionSummary } from '@shared/types';

/** mock window.sqlStudio。 */
function mockSqlStudio(overrides: Record<string, unknown> = {}) {
  const base = {
    'connections:list': vi.fn(async (): Promise<ConnectionSummary[]> => [
      { id: 'c1', name: '本地', host: '127.0.0.1', port: 3306, user: 'root', charset: 'utf8mb4', createdAt: 1, updatedAt: 1 },
    ]),
    'connections:save': vi.fn(async () => ({ id: 'c2', name: 'new', host: '', port: 3306, user: '', charset: 'utf8mb4', createdAt: 1, updatedAt: 1 })),
    'connections:remove': vi.fn(async () => ({ removed: true })),
    'connections:test': vi.fn(async () => ({ ok: true, message: '连接成功' })),
    'connections:testById': vi.fn(async () => ({ ok: true, message: 'ok' })),
    ...overrides,
  };
  (window as unknown as { sqlStudio: typeof base }).sqlStudio = base;
  return base;
}

describe('ConnectionManager', () => {
  beforeEach(() => {
    mockSqlStudio();
  });

  it('加载连接列表并展示', async () => {
    render(<ConnectionManager onSelect={() => {}} />);
    expect(await screen.findByText('本地')).toBeTruthy();
    expect(screen.getByText('root@127.0.0.1:3306')).toBeTruthy();
  });

  it('新建连接表单可保存并刷新', async () => {
    const store = mockSqlStudio();
    render(<ConnectionManager onSelect={() => {}} />);
    fireEvent.click(await screen.findByText('新建'));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的库' } });
    fireEvent.change(screen.getByLabelText('主机'), { target: { value: '127.0.0.1' } });
    fireEvent.change(screen.getByLabelText('用户'), { target: { value: 'root' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(store['connections:save']).toHaveBeenCalled());
    expect(store['connections:save']).toHaveBeenCalledWith(
      expect.objectContaining({ name: '我的库' }),
    );
  });

  it('选中连接回调', async () => {
    const onSelect = vi.fn();
    render(<ConnectionManager onSelect={onSelect} />);
    fireEvent.click(await screen.findByText('本地'));
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('删除连接（更多菜单 → 删除）', async () => {
    const store = mockSqlStudio();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ConnectionManager onSelect={() => {}} />);
    fireEvent.click(await screen.findByText('本地').then((el) => el.closest('li')!.querySelector('.conn-more-btn')!));
    fireEvent.click(await screen.findByText('删除'));
    await waitFor(() => expect(store['connections:remove']).toHaveBeenCalledWith({ id: 'c1' }));
  });

  it('切换编辑目标时表单重置（不会把 A 的值写进 B）', async () => {
    const twoConns: ConnectionSummary[] = [
      { id: 'c1', name: '本地', host: '10.0.0.1', port: 3306, user: 'root', database: 'db_a', charset: 'utf8mb4', createdAt: 1, updatedAt: 1 },
      { id: 'c2', name: '远程', host: '10.0.0.2', port: 3307, user: 'admin', database: 'db_b', charset: 'utf8mb4', createdAt: 2, updatedAt: 2 },
    ];
    mockSqlStudio({ 'connections:list': vi.fn(async () => twoConns) });
    render(<ConnectionManager onSelect={() => {}} />);
    await screen.findByText('本地');

    // 打开 A 的「编辑」
    fireEvent.click(screen.getByText('本地').closest('li')!.querySelector('.conn-more-btn')!);
    fireEvent.click(await screen.findByText('编辑'));
    expect((screen.getByLabelText('主机') as HTMLInputElement).value).toBe('10.0.0.1');

    // 不关闭表单，直接切到 B 的「编辑」
    fireEvent.click(screen.getByText('远程').closest('li')!.querySelector('.conn-more-btn')!);
    fireEvent.click(await screen.findByText('编辑'));

    // 关键：表单必须重置为 B 的值。
    // 历史 bug：ConnectionForm 无 key，state 不重置 → 显示 A 的 host/user 但 connectionId 已是 B，
    // 点「保存修改」会把 A 的配置静默覆盖到 B。
    await waitFor(() => {
      expect((screen.getByLabelText('主机') as HTMLInputElement).value).toBe('10.0.0.2');
    });
    expect((screen.getByLabelText('用户') as HTMLInputElement).value).toBe('admin');
  });

  it('删除未选中的连接时不清空当前选中（不中断正在使用的会话）', async () => {
    const twoConns: ConnectionSummary[] = [
      { id: 'c1', name: '本地', host: '10.0.0.1', port: 3306, user: 'root', charset: 'utf8mb4', createdAt: 1, updatedAt: 1 },
      { id: 'c2', name: '远程', host: '10.0.0.2', port: 3307, user: 'admin', charset: 'utf8mb4', createdAt: 2, updatedAt: 2 },
    ];
    mockSqlStudio({ 'connections:list': vi.fn(async () => twoConns) });
    const onSelect = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ConnectionManager onSelect={onSelect} selectedId="c1" />);
    await screen.findByText('本地');
    // 确保已选中的是 c1
    onSelect.mockClear();

    // 删除「远程」(c2) —— 它不是当前选中连接
    fireEvent.click(screen.getByText('远程').closest('li')!.querySelector('.conn-more-btn')!);
    fireEvent.click(await screen.findByText('删除'));

    await waitFor(() =>
      expect((window as unknown as { sqlStudio: Record<string, ReturnType<typeof vi.fn>> }).sqlStudio['connections:remove']).toHaveBeenCalledWith({ id: 'c2' }),
    );
    // 不得因为删除别的连接而清空 c1 的选中
    expect(onSelect).not.toHaveBeenCalledWith(null);
  });
});

describe('ConnectionForm', () => {
  it('测试连接显示成功消息', async () => {
    const store = mockSqlStudio();
    render(<ConnectionForm onSave={() => {}} onTest={(store as never)['connections:test']} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 't' } });
    fireEvent.change(screen.getByLabelText('主机'), { target: { value: 'h' } });
    fireEvent.change(screen.getByLabelText('用户'), { target: { value: 'u' } });
    fireEvent.click(screen.getByText('测试连接'));
    expect(await screen.findByText('连接成功')).toBeTruthy();
  });

  it('测试连接失败显示错误', async () => {
    const store = mockSqlStudio({
      'connections:test': vi.fn(async () => {
        throw new Error('连接被拒绝');
      }),
    });
    render(<ConnectionForm onSave={() => {}} onTest={(store as never)['connections:test']} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 't' } });
    fireEvent.change(screen.getByLabelText('主机'), { target: { value: 'h' } });
    fireEvent.change(screen.getByLabelText('用户'), { target: { value: 'u' } });
    fireEvent.click(screen.getByText('测试连接'));
    expect(await screen.findByText('连接被拒绝')).toBeTruthy();
  });
});
