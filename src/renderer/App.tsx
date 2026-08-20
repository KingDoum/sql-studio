import { useState } from 'react';
import { Database, History, Star } from 'lucide-react';
import { ConnectionManager } from '@renderer/components/ConnectionManager';
import { ObjectExplorer } from '@renderer/components/ObjectExplorer';
import { EditorTabs } from '@renderer/components/EditorTabs';
import { SqlEditor } from '@renderer/components/SqlEditor';
import { ResultTabs } from '@renderer/components/ResultTabs';
import { ExportMenu } from '@renderer/components/ExportMenu';
import { HistoryPanel } from '@renderer/components/HistoryPanel';
import { FavoritesPanel } from '@renderer/components/FavoritesPanel';
import { AiSettingsPanel } from '@renderer/components/AiSettingsPanel';
import { useWorkspace, useActiveTab } from '@renderer/store/workspace';
import { buildSelectSql, splitStatements } from '@renderer/lib/sql-utils';
import { hasWriteStatements } from '@renderer/lib/cell-format';

/**
 * 工作台（任务 8-9 UI 集成）。
 * 左侧：连接管理 + 对象浏览器；右侧：EditorTabs + SqlEditor 编辑器工作台。
 * 任务 10 将结果面板（execution）渲染到编辑器下方。
 */
function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showFavorites, setShowFavorites] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [aiSettingsVersion, setAiSettingsVersion] = useState(0);
  const {
    tabs,
    activeTabId,
    currentConnectionId,
    setConnection,
    newTab,
    openTabFromFile,
    closeTab,
    setActiveTab,
    updateSql,
    markSaved,
    setExecution,
  } = useWorkspace();
  const activeTab = useActiveTab();

  const handleSelectConnection = (id: string) => {
    setSelectedId(id);
    setConnection(id);
  };

  // ── 脚本动作（新建/打开/保存/另存为）──
  const handleOpen = async () => {
    const filePath = window.prompt('输入要打开的 .sql 文件路径');
    if (!filePath) return;
    try {
      const { content } = await window.sqlStudio['script:open']({ filePath });
      openTabFromFile(filePath, content);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '打开失败');
    }
  };

  const handleSaveAs = async () => {
    if (!activeTab) return;
    const filePath = window.prompt('输入保存路径（.sql）');
    if (!filePath) return;
    try {
      await window.sqlStudio['script:save']({ filePath, content: activeTab.sql });
      markSaved(activeTab.id, filePath);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '保存失败');
    }
  };

  const handleSave = async () => {
    if (!activeTab) return;
    if (activeTab.filePath) {
      try {
        await window.sqlStudio['script:save']({
          filePath: activeTab.filePath,
          content: activeTab.sql,
        });
        markSaved(activeTab.id, activeTab.filePath);
      } catch (err) {
        window.alert(err instanceof Error ? err.message : '保存失败');
      }
    } else {
      await handleSaveAs();
    }
  };

  // ── 查询执行（任务 9/10/11：执行 + 写确认 + 结果入 store + 自动记录历史）──
  const handleExecute = async (sql: string, database?: string) => {
    if (!currentConnectionId) {
      window.alert('请先选择连接');
      return;
    }
    if (
      hasWriteStatements(splitStatements(sql)) &&
      !window.confirm('该 SQL 包含写入操作（INSERT/UPDATE/DELETE 等），确定执行？')
    ) {
      return;
    }
    try {
      const result = await window.sqlStudio['query:execute']({
        connectionId: currentConnectionId,
        sql,
        database,
      });
      setExecution({
        tabId: activeTabId ?? '',
        connectionId: currentConnectionId,
        sql,
        database,
        result,
        executedAt: Date.now(),
      });
      // 自动记录历史（fire-and-forget）
      window.sqlStudio['history:add']({
        connectionId: currentConnectionId,
        sql,
        success: true,
        rowCount: result.resultSets.reduce((n, s) => n + s.rows.length, 0),
        elapsedMs: result.totalElapsedMs,
      }).catch(() => {});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setExecution({
        tabId: activeTabId ?? '',
        connectionId: currentConnectionId,
        sql,
        database,
        error: errMsg,
        executedAt: Date.now(),
      });
      // 记录失败历史
      window.sqlStudio['history:add']({
        connectionId: currentConnectionId,
        sql,
        success: false,
        rowCount: 0,
        elapsedMs: 0,
      }).catch(() => {});
    }
  };

  // ── 历史收藏动作（任务 11）──
  const handleBackfillSql = (sql: string) => {
    const id = newTab();
    updateSql(id, sql);
  };

  const handleSaveAsFavorite = async (sql: string) => {
    const name = window.prompt('收藏名称');
    if (!name) return;
    try {
      await window.sqlStudio['favorites:save']({ name, sql, connectionId: currentConnectionId ?? undefined });
      window.alert(`已收藏：${name}`);
    } catch (err) {
      window.alert(`收藏失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleOpenFavorite = async (name: string) => {
    try {
      const { content, filePath } = await window.sqlStudio['favorites:open']({ name });
      openTabFromFile(filePath, content);
    } catch (err) {
      window.alert(`打开收藏失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 对象树双击表 → 生成 SELECT 新标签
  const handleOpenTable = (db: string, table: string) => {
    const id = openTabFromFile(`${db}.${table}`, buildSelectSql(db, table));
    setActiveTab(id);
  };

  const handleCloseTab = (id: string) => closeTab(id);

  return (
    <div className="app-shell">
      {/* 左侧边栏 */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-logo">
            <Database size={18} strokeWidth={1.8} />
          </span>
          <span className="sidebar-title">SQL Studio</span>
        </div>

        <div className="sidebar-panel panel-connections">
          <ConnectionManager onSelect={handleSelectConnection} selectedId={selectedId ?? undefined} />
        </div>

        {selectedId && (
          <div className="sidebar-panel panel-explorer">
            <ObjectExplorer
              connectionId={selectedId}
              onPreviewTable={(db, table) => {
                console.log('预览表:', db, table);
              }}
              onOpenTable={handleOpenTable}
            />
          </div>
        )}
        {!selectedId && (
          <div className="sidebar-hint">
            <p>请选择一个连接以浏览数据库对象</p>
          </div>
        )}
      </aside>

      {/* 中央工作区 */}
      <main className="main-area">
        <EditorTabs
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActiveTab}
          onClose={handleCloseTab}
          onNew={newTab}
          onOpen={() => void handleOpen()}
          onSave={() => void handleSave()}
          onSaveAs={() => void handleSaveAs()}
        />
        <div className="toolbar-extras">
          <button className="toolbar-btn" onClick={() => setShowHistory(true)} title="执行历史">
            <History size={13} /> 历史
          </button>
          <button className="toolbar-btn" onClick={() => setShowFavorites(true)} title="命名收藏">
            <Star size={13} /> 收藏
          </button>
          {activeTab && <ExportMenu />}
        </div>
        {activeTab ? (
          <div className="editor-pane">
            <SqlEditor
              key={activeTab.id}
              tab={activeTab}
              connectionId={currentConnectionId}
              onSqlChange={(sql) => updateSql(activeTab.id, sql)}
              onExecute={(sql, db) => void handleExecute(sql, db)}
              onOpenAiSettings={() => setShowAiSettings(true)}
              aiSettingsVersion={aiSettingsVersion}
            />
            <ResultTabs />
          </div>
        ) : (
          <div className="workspace-placeholder">
            <Database size={48} strokeWidth={1.2} className="placeholder-icon" />
            <p>点击「新建」开始编写 SQL 脚本</p>
            <p className="placeholder-hint">
              或选择连接后在对象浏览器中双击表生成 SELECT
            </p>
          </div>
        )}
      </main>
      <HistoryPanel
        open={showHistory}
        onClose={() => setShowHistory(false)}
        onBackfillSql={handleBackfillSql}
        onSaveAsFavorite={handleSaveAsFavorite}
      />
      <FavoritesPanel
        open={showFavorites}
        onClose={() => setShowFavorites(false)}
        onOpen={(name) => void handleOpenFavorite(name)}
      />
      <AiSettingsPanel
        open={showAiSettings}
        onClose={() => setShowAiSettings(false)}
        onSettingsChanged={() => setAiSettingsVersion((v) => v + 1)}
      />
    </div>
  );
}

export default App;