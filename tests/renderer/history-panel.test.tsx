// @vitest-environment jsdom
/**
 * HistoryPanel 组件测试（任务 11）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HistoryPanel } from '@renderer/components/HistoryPanel';
import type { HistoryItem } from '@shared/types';

const MOCK_HISTORY: HistoryItem[] = [
  { id: 'h1', connectionId: 'c1', connectionName: '本地', sql: 'SELECT 1', success: true, rowCount: 1, elapsedMs: 12, executedAt: Date.now() - 1000 },
  { id: 'h2', connectionId: 'c1', sql: 'SELECT 2', success: false, rowCount: 0, elapsedMs: 0, executedAt: Date.now() },
];

describe('HistoryPanel', () => {
  beforeEach(() => {
    (window as unknown as { sqlStudio?: unknown }).sqlStudio = {
      'history:list': vi.fn(async () => MOCK_HISTORY),
      'history:remove': vi.fn(async () => ({ removed: true })),
    };
    vi.spyOn(window, 'prompt').mockReturnValue('my favorite');
  });
  afterEach(() => vi.restoreAllMocks());

  it('open=false 时不渲染', () => {
    const { container } = render(<HistoryPanel open={false} onClose={() => {}} onBackfillSql={() => {}} onSaveAsFavorite={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('open=true 加载历史列表', async () => {
    render(<HistoryPanel open={true} onClose={() => {}} onBackfillSql={() => {}} onSaveAsFavorite={() => {}} />);
    expect(await screen.findByText('SELECT 1')).toBeTruthy();
    expect(screen.getByText('SELECT 2')).toBeTruthy();
  });

  it('点击回填编辑器', async () => {
    const onBackfill = vi.fn();
    render(<HistoryPanel open={true} onClose={() => {}} onBackfillSql={onBackfill} onSaveAsFavorite={() => {}} />);
    fireEvent.click(await screen.findByText('SELECT 1'));
    expect(onBackfill).toHaveBeenCalledWith('SELECT 1');
  });

  it('点击收藏触发 onSaveAsFavorite', async () => {
    const onSave = vi.fn();
    render(<HistoryPanel open={true} onClose={() => {}} onBackfillSql={() => {}} onSaveAsFavorite={onSave} />);
    const favBtns = await screen.findAllByText('收藏');
    fireEvent.click(favBtns[0]);
    expect(onSave).toHaveBeenCalledWith('SELECT 1');
  });
});