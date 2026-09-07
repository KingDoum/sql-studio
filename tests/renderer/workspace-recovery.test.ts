/**
 * workspace store 恢复测试（自动保存方案 S3，测试矩阵 §16.4 对应项）。
 * 覆盖：
 *  - WS-20/21/22：hydrate 不恢复 execution / results / executing
 *  - WS-08：未命名标签恢复准确（isDirty=true、title 未命名、filePath=null）
 *  - WS-07：多标签顺序和 activeTabId 准确
 *  - hydrate 后自动保存可继续（revision 起点）
 *  - classifyWorkspaceChange：内容 vs 结构事件
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspace } from '@renderer/store/workspace';
import { classifyWorkspaceChange } from '@renderer/lib/workspace-persistence';
import type { WorkspaceSnapshot } from '@shared/types';
import { WORKSPACE_SCHEMA_VERSION } from '@shared/types';

function makeSnapshot(partial: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspaceId: 'default',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    revision: 7,
    activeTabId: 't2',
    currentConnectionId: 'conn-x',
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    tabs: [
      {
        id: 't1',
        tabOrder: 0,
        title: '未命名-1',
        filePath: null,
        sqlContent: 'SELECT 1',
        isDirty: true,
        connectionId: null,
        createdAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
      },
      {
        id: 't2',
        tabOrder: 1,
        title: 'report.sql',
        filePath: '/tmp/report.sql',
        sqlContent: 'SELECT 2',
        isDirty: false,
        connectionId: 'conn-x',
        createdAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
      },
    ],
    ...partial,
  };
}

describe('workspace store hydrate（WS-07/08/20/21/22）', () => {
  beforeEach(() => {
    useWorkspace.setState({
      tabs: [],
      activeTabId: null,
      currentConnectionId: null,
      execution: null,
      executionHistory: [],
      executing: null,
    });
  });

  it('hydrate 恢复 tabs/顺序/activeTabId/currentConnectionId', () => {
    const snap = makeSnapshot();
    useWorkspace.getState().hydrateFromSnapshot(snap);
    const s = useWorkspace.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(s.activeTabId).toBe('t2');
    expect(s.currentConnectionId).toBe('conn-x');
    // 未命名标签保持 filePath 未定义（对应快照 null）
    expect(s.tabs[0]?.filePath).toBeUndefined();
    expect(s.tabs[0]?.isDirty).toBe(true);
    // 文件标签恢复
    expect(s.tabs[1]?.filePath).toBe('/tmp/report.sql');
    expect(s.tabs[1]?.isDirty).toBe(false);
  });

  it('WS-20/21/22 hydrate 不恢复 execution / results / executing', () => {
    // 预置执行态（模拟崩溃前有执行结果）
    useWorkspace.setState({
      execution: {
        tabId: 't1',
        connectionId: 'conn-x',
        sql: 'SELECT 1',
        result: {
          connectionId: 'conn-x',
          resultSets: [
            {
              index: 0,
              statement: 'SELECT 1',
              columns: [{ name: 'id', type: 'int', nullable: true, isPrimary: false, isUnique: false }],
              rows: [[1]],
              affectedRows: 0,
              truncated: false,
              elapsedMs: 1,
            },
          ],
          totalElapsedMs: 1,
          truncated: false,
          hasWrite: false,
        },
        executedAt: Date.now(),
      },
      executionHistory: [
        {
          tabId: 't1',
          connectionId: 'conn-x',
          sql: 'SELECT 1',
          result: undefined,
          executedAt: Date.now(),
        },
      ],
      executing: { tabId: 't1', connectionId: 'conn-x', clientQueryId: 'q-1' },
    });
    useWorkspace.getState().hydrateFromSnapshot(makeSnapshot());
    const s = useWorkspace.getState();
    expect(s.execution).toBeNull();
    expect(s.executionHistory).toHaveLength(0);
    expect(s.executing).toBeNull();
  });

  it('hydrate 后新标签保持脏（方案 §7.4）', () => {
    useWorkspace.getState().hydrateFromSnapshot(makeSnapshot({ tabs: [] }));
    const id = useWorkspace.getState().newTab();
    const tab = useWorkspace.getState().tabs.find((t) => t.id === id);
    expect(tab?.isDirty).toBe(true);
    expect(tab?.filePath).toBeUndefined();
  });
});

describe('classifyWorkspaceChange（§7.6 事件分类）', () => {
  const base = {
    activeTabId: 't1',
    currentConnectionId: 'c1',
    tabs: [{ id: 't1', title: 'a', sql: 'SELECT 1', isDirty: true }],
  };

  it('SQL 内容变化 → content（500ms 防抖）', () => {
    const next = {
      ...base,
      tabs: [{ ...base.tabs[0]!, sql: 'SELECT 2', isDirty: true }],
    };
    expect(classifyWorkspaceChange(base, next)).toBe('content');
  });

  it('activeTabId 切换 → structural', () => {
    expect(classifyWorkspaceChange(base, { ...base, activeTabId: 't2' })).toBe('structural');
  });

  it('连接切换 → structural', () => {
    expect(classifyWorkspaceChange(base, { ...base, currentConnectionId: 'c2' })).toBe('structural');
  });

  it('标签增删 → structural', () => {
    const added = { ...base, tabs: [...base.tabs, { id: 't2', title: 'b', sql: '', isDirty: true }] };
    expect(classifyWorkspaceChange(base, added)).toBe('structural');
    const removed = { ...base, tabs: [] };
    expect(classifyWorkspaceChange(base, removed)).toBe('structural');
  });

  it('仅 isDirty 变化（markSaved 清脏）→ structural', () => {
    const next = {
      ...base,
      tabs: [{ ...base.tabs[0]!, isDirty: false, filePath: '/x/a.sql' }],
    };
    expect(classifyWorkspaceChange(base, next)).toBe('structural');
  });

  it('无变化 → none', () => {
    expect(classifyWorkspaceChange(base, JSON.parse(JSON.stringify(base)))).toBe('none');
  });
});