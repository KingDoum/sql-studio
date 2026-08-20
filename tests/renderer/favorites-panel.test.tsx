// @vitest-environment jsdom
/**
 * FavoritesPanel 组件测试（任务 11）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FavoritesPanel } from '@renderer/components/FavoritesPanel';
import type { FavoriteItem } from '@shared/types';

const MOCK_FAVS: FavoriteItem[] = [
  { filePath: '/queries/活跃用户.sql', name: '活跃用户', sql: 'SELECT COUNT(*) FROM users', connectionId: 'c1', tags: ['活跃', '日报'], createdAt: Date.now() - 86400000, updatedAt: Date.now() },
  { filePath: '/queries/订单汇总.sql', name: '订单汇总', sql: 'SELECT * FROM orders', createdAt: Date.now(), updatedAt: Date.now() },
];

describe('FavoritesPanel', () => {
  beforeEach(() => {
    (window as unknown as { sqlStudio?: unknown }).sqlStudio = {
      'favorites:list': vi.fn(async () => MOCK_FAVS),
      'favorites:remove': vi.fn(async () => ({ removed: true })),
      'favorites:open': vi.fn(async () => ({ filePath: '/queries/x.sql', content: 'SELECT 1' })),
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('open=false 时不渲染', () => {
    const { container } = render(<FavoritesPanel open={false} onClose={() => {}} onOpen={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('open=true 加载收藏列表', async () => {
    render(<FavoritesPanel open={true} onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText('活跃用户')).toBeTruthy();
    expect(screen.getByText('订单汇总')).toBeTruthy();
  });

  it('点击收藏名称触发 onOpen', async () => {
    const onOpen = vi.fn();
    render(<FavoritesPanel open={true} onClose={() => {}} onOpen={onOpen} />);
    fireEvent.click(await screen.findByText('活跃用户'));
    expect(onOpen).toHaveBeenCalledWith('活跃用户');
  });

  it('删除按钮调用 favorites:remove', async () => {
    const store = window.sqlStudio as unknown as Record<string, ReturnType<typeof vi.fn>>;
    render(<FavoritesPanel open={true} onClose={() => {}} onOpen={() => {}} />);
    const delBtns = await screen.findAllByText('删除');
    fireEvent.click(delBtns[0]);
    await waitFor(() => expect(store['favorites:remove']).toHaveBeenCalledWith({ name: '活跃用户' }));
  });
});