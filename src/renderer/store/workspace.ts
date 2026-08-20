/**
 * 工作台状态（zustand，任务 9 建立，任务 10/11 扩展）。
 *
 * 职责（任务 9）：
 *  - 多标签页（tabs + activeTabId）：新建/打开/关闭/切换/内容更新/保存标记。
 *  - 当前连接（currentConnectionId）：与左侧连接面板联动。
 *  - lastResult：最近一次查询结果（任务 10 渲染；此处先落位）。
 */
import { create } from 'zustand';
import type { EditorTab, QueryResult } from '@shared/types';
import { basename } from '@renderer/lib/sql-utils';

let tabSeq = 0;
let titleSeq = 0;

function newTabId(): string {
  return `tab_${Date.now().toString(36)}_${(++tabSeq).toString(36)}`;
}

function newTitle(): string {
  return `未命名-${++titleSeq}`;
}

export interface ExecutionRecord {
  tabId: string;
  connectionId: string;
  sql: string;
  database?: string;
  result?: QueryResult;
  error?: string;
  executedAt: number;
}

/** 查询执行中状态（停止按钮数据源）。 */
export interface ExecutingState {
  /** 发起查询的标签 id。 */
  tabId: string;
  connectionId: string;
  /** 渲染进程生成的查询 id（对应主进程 query:cancel 的 queryId）。 */
  clientQueryId: string;
}

interface WorkspaceState {
  currentConnectionId: string | null;
  tabs: EditorTab[];
  activeTabId: string | null;
  /** 最近一次执行记录（任务 10 结果面板数据源）。 */
  execution: ExecutionRecord | null;
  /** 当前执行中的查询（体验优化：停止按钮）。 */
  executing: ExecutingState | null;

  setConnection(id: string | null): void;

  /** 新建空标签，返回其 id。 */
  newTab(): string;
  /** 从文件打开新标签（已存在同 filePath 则激活之），返回激活 tab id。 */
  openTabFromFile(filePath: string, sql: string): string;
  /** 关闭标签（调用方先确认 dirty）。 */
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  /** 编辑器内容变化：标记 dirty。 */
  updateSql(id: string, sql: string): void;
  /** 保存成功后标记干净并记录路径。 */
  markSaved(id: string, filePath: string): void;
  setExecution(rec: ExecutionRecord): void;
  setExecuting(state: ExecutingState | null): void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  currentConnectionId: null,
  tabs: [],
  activeTabId: null,
  execution: null,
  executing: null,

  setConnection: (id) => set({ currentConnectionId: id }),

  newTab: () => {
    const tab: EditorTab = { id: newTabId(), title: newTitle(), sql: '', isDirty: false };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  openTabFromFile: (filePath, sql) => {
    const existing = get().tabs.find((t) => t.filePath === filePath);
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const tab: EditorTab = {
      id: newTabId(),
      title: basename(filePath),
      sql,
      filePath,
      isDirty: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  closeTab: (id) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (s.activeTabId === id) {
        const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
        activeTabId = neighbor ? neighbor.id : null;
      }
      return { tabs, activeTabId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateSql: (id, sql) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, sql, isDirty: true } : t)),
    }));
  },

  markSaved: (id, filePath) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, filePath, title: basename(filePath), isDirty: false } : t,
      ),
    }));
  },

  setExecution: (rec) => set({ execution: rec, executing: null }),
  setExecuting: (state) => set({ executing: state }),
}));

/** 取活跃标签（便捷选择器）。 */
export function useActiveTab(): EditorTab | null {
  return useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);
}