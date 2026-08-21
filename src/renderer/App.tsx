import { useState, useRef, useEffect } from 'react';
import { Database, History, Star, Settings, X } from 'lucide-react';
import { ConnectionManager } from '@renderer/components/ConnectionManager';
import { ObjectExplorer } from '@renderer/components/ObjectExplorer';
import { EditorTabs } from '@renderer/components/EditorTabs';
import { SqlEditor, type SqlEditorHandle } from '@renderer/components/SqlEditor';
import { ResultTabs } from '@renderer/components/ResultTabs';
import { ExportMenu } from '@renderer/components/ExportMenu';
import { HistoryPanel } from '@renderer/components/HistoryPanel';
import { FavoritesPanel } from '@renderer/components/FavoritesPanel';
import { AiSettingsPanel } from '@renderer/components/AiSettingsPanel';
import { SettingsPanel } from '@renderer/components/SettingsPanel';
import { ensureDebugLogging } from '@renderer/lib/debug-log';
import type { ThemeMode } from '@shared/types';
import { DataPreviewModal } from '@renderer/components/DataPreviewModal';
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
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [debugMode, setDebugMode] = useState(false);
  const [fontSize, setFontSize] = useState(12);
  const [fontFamily, setFontFamily] = useState('jetbrains');
  const [preview, setPreview] = useState<{ connectionId: string; database: string; table: string } | null>(null);
  const [favoriteName, setFavoriteName] = useState<string | null>(null);
  const [favoriteSql, setFavoriteSql] = useState('');
  const sqlEditorRef = useRef<SqlEditorHandle | null>(null);
  // 启动时读取主题/调试模式设置并应用
  useEffect(() => {
    void window.sqlStudio['settings:get']({ key: 'theme' }).then((v) => {
      if (v === 'light' || v === 'dark') applyTheme(v as ThemeMode);
    });
    void window.sqlStudio['settings:get']({ key: 'debugMode' }).then((v) => {
      if (v === '1' || v === 'true') {
        setDebugMode(true);
        ensureDebugLogging(true);
      }
    });
    // 读取字体设置
    void window.sqlStudio['settings:get']({ key: 'fontSize' }).then((v) => {
      if (v) { const n = parseInt(v, 10); if (n >= 10 && n <= 18) applyFontSize(n); }
    });
    void window.sqlStudio['settings:get']({ key: 'fontFamily' }).then((v) => {
      if (v) setFontFamily(v);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyTheme = (t: ThemeMode) => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    void window.sqlStudio['settings:set']({ key: 'theme', value: t });
  };

  const handleThemeChange = (t: ThemeMode) => applyTheme(t);

  const applyFontSize = (size: number) => {
    setFontSize(size);
    const root = document.documentElement;
    root.style.setProperty('--fs-xs', `${Math.max(size - 2, 9)}px`);
    root.style.setProperty('--fs-sm', `${Math.max(size - 1, 10)}px`);
    root.style.setProperty('--fs-base', `${size}px`);
    root.style.setProperty('--fs-md', `${Math.min(size + 1, 20)}px`);
    root.style.setProperty('--fs-lg', `${Math.min(size + 2, 22)}px`);
    root.style.setProperty('--fs-xl', `${Math.min(size + 4, 24)}px`);
    void window.sqlStudio['settings:set']({ key: 'fontSize', value: String(size) });
  };

  const FONT_FAMILIES: Record<string, string> = {
    jetbrains: "'JetBrains Mono', Consolas, 'Courier New', monospace",
    firacode: "'Fira Code', 'JetBrains Mono', Consolas, monospace",
    sourcecode: "'Source Code Pro', 'JetBrains Mono', Consolas, monospace",
    cascadia: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
    system: "Consolas, 'Courier New', monospace",
  };

  const handleFontSizeChange = (size: number) => applyFontSize(size);

  const handleFontFamilyChange = (family: string) => {
    setFontFamily(family);
    const font = FONT_FAMILIES[family] ?? FONT_FAMILIES.jetbrains;
    document.documentElement.style.setProperty('--font-mono', font);
    void window.sqlStudio['settings:set']({ key: 'fontFamily', value: family });
  };


  const handleDebugModeChange = (enabled: boolean) => {
    setDebugMode(enabled);
    ensureDebugLogging(enabled);
    void window.sqlStudio['settings:set']({ key: 'debugMode', value: enabled ? '1' : '0' });
  };
  const {
    tabs,
    activeTabId,
    currentConnectionId,
    executing,
    setConnection,
    newTab,
    openTabFromFile,
    closeTab,
    setActiveTab,
    updateSql,
    markSaved,
    setExecution,
    setExecuting,
  } = useWorkspace();
  const activeTab = useActiveTab();

  const handleSelectConnection = (id: string | null) => {
    setSelectedId(id);
    setConnection(id ?? null);
  };

  // ── 脚本动作（新建/打开/保存/另存为）──
  // 记忆最近脚本目录（settings:lastScriptDir），对话框 defaultPath 用它
  const lastScriptDirRef = useRef<string>('');

  const ensureScriptDir = async (filePath: string) => {
    const dir = filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
    if (dir && dir !== lastScriptDirRef.current) {
      lastScriptDirRef.current = dir;
      void window.sqlStudio['settings:set']({ key: 'lastScriptDir', value: dir });
    }
  };

  useEffect(() => {
    void window.sqlStudio['settings:get']({ key: 'lastScriptDir' }).then((dir) => {
      if (dir) lastScriptDirRef.current = dir;
    });
  }, []);

  const handleOpen = async () => {
    let filePath: string | null = null;
    try {
      filePath = await window.sqlStudio['dialog:showOpenDialog']({
        title: '打开 SQL 脚本',
        defaultPath: lastScriptDirRef.current || undefined,
        filters: [{ name: 'SQL 文件', extensions: ['sql'] }],
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '无法打开文件对话框');
      return;
    }
    if (!filePath) return;
    try {
      const { content } = await window.sqlStudio['script:open']({ filePath });
      openTabFromFile(filePath, content);
      void ensureScriptDir(filePath);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '打开失败');
    }
  };

  const handleSaveAs = async () => {
    if (!activeTab) return;
    let filePath: string | null = null;
    try {
      filePath = await window.sqlStudio['dialog:showSaveDialog']({
        title: '保存 SQL 脚本',
        defaultPath: lastScriptDirRef.current
          ? `${lastScriptDirRef.current.replace(/[\\/]$/, '')}/未命名.sql`
          : '未命名.sql',
        filters: [{ name: 'SQL 文件', extensions: ['sql'] }],
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '无法打开保存对话框');
      return;
    }
    if (!filePath) return;
    const finalPath = filePath.endsWith('.sql') ? filePath : `${filePath}.sql`;
    try {
      await window.sqlStudio['script:save']({ filePath: finalPath, content: activeTab.sql });
      markSaved(activeTab.id, finalPath);
      void ensureScriptDir(finalPath);
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
    const clientQueryId = crypto.randomUUID();
    setExecuting({ tabId: activeTabId ?? '', connectionId: currentConnectionId, clientQueryId });
    try {
      const result = await window.sqlStudio['query:execute']({
        connectionId: currentConnectionId,
        sql,
        database,
        clientQueryId,
      });
      setExecution({
        tabId: activeTabId ?? '',
        connectionId: currentConnectionId,
        sql,
        database,
        result,
        executedAt: Date.now(),
      });
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
    }
    // setExecution 已设置 executing: null
  };

  // ── 查询取消（体验优化 §14）──
  const handleCancelQuery = () => {
    if (!executing) return;
    void window.sqlStudio['query:cancel']({
      connectionId: executing.connectionId,
      queryId: executing.clientQueryId,
    });
  };

  // ── 历史收藏动作（任务 11）──
  const handleBackfillSql = (sql: string) => {
    const id = newTab();
    updateSql(id, sql);
  };

  const handleSaveAsFavorite = async (sql: string) => {
    setFavoriteSql(sql);
    setFavoriteName('');
  };

  const doSaveFavorite = async () => {
    const name = favoriteName?.trim();
    if (!name) return;
    try {
      await window.sqlStudio['favorites:save']({ name, sql: favoriteSql, connectionId: currentConnectionId ?? undefined });
      window.alert(`已收藏：${name}`);
      setFavoriteName(null);
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

  // 对象树双击表 → 生成 SELECT 新标签（未保存，避免假 filePath）
  const handleOpenTable = (db: string, table: string) => {
    const id = newTab();
    updateSql(id, buildSelectSql(db, table));
  };

  // 数据预览 → 弹窗展示前 100 行（不污染编辑器标签）
  const handlePreviewTable = (db: string, table: string) => {
    if (!selectedId) return;
    setPreview({ connectionId: selectedId, database: db, table });
  };

  // 双击字段 → 插入到编辑器光标处（体验优化 §14）
  const handleInsertColumn = (db: string, table: string, column: string) => {
    sqlEditorRef.current?.insertTextAtCursor(`\`${db}\`.\`${table}\`.\`${column}\``);
  };

  // 右键菜单「查看 DDL」→ schema:ddl 取 DDL 文本到新标签
  const handleDdlTable = async (db: string, table: string) => {
    if (!currentConnectionId) return;
    try {
      const { ddl } = await window.sqlStudio['schema:ddl']({ connectionId: currentConnectionId, database: db, table });
      const id = newTab();
      updateSql(id, `-- DDL for \`${db}\`.\`${table}\`\n${ddl}`);
    } catch (err) {
      window.alert(`获取 DDL 失败：${err instanceof Error ? err.message : String(err)}`);
    }
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
              onPreviewTable={handlePreviewTable}
              onOpenTable={handleOpenTable}
              onInsertColumn={handleInsertColumn}
              onDdlTable={handleDdlTable}
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
          <button className="toolbar-btn" onClick={() => setShowSettings(true)} title="设置">
            <Settings size={13} /> 设置
          </button>
          {activeTab && <ExportMenu />}
        </div>
        {activeTab ? (
          <div className="editor-pane">
            <SqlEditor
              ref={sqlEditorRef}
              tab={activeTab}
              connectionId={currentConnectionId}
              isExecuting={
                executing?.tabId === activeTab.id &&
                executing.connectionId === currentConnectionId
              }
              onSqlChange={(sql) => updateSql(activeTab.id, sql)}
              onExecute={(sql, db) => void handleExecute(sql, db)}
              onCancelQuery={handleCancelQuery}
              onOpenAiSettings={() => setShowAiSettings(true)}
              onSave={handleSave}
              aiSettingsVersion={aiSettingsVersion}
              theme={theme}
              fontSize={fontSize}
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
      {/* 收藏命名弹窗 */}
      {favoriteName !== null && (
        <div className="modal-overlay" onClick={() => setFavoriteName(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()} style={{ width: 400 }}>
            <div className="modal-header">
              <h3>收藏命名</h3>
              <button className="modal-close" onClick={() => setFavoriteName(null)}><X size={16} /></button>
            </div>
            <div className="modal-body" style={{ padding: '12px 16px' }}>
              <label className="ai-settings-field">
                <span>收藏名称</span>
                <input
                  value={favoriteName}
                  autoFocus
                  placeholder="如 每日活跃用户统计"
                  onChange={(e) => setFavoriteName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void doSaveFavorite(); }}
                />
              </label>
              <div className="ai-settings-actions">
                <button className="ai-settings-btn primary" onClick={() => void doSaveFavorite()}>
                  保存收藏
                </button>
                <button className="ai-settings-btn" onClick={() => setFavoriteName(null)}>
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <SettingsPanel
        open={showSettings}
        theme={theme}
        debugMode={debugMode}
        fontSize={fontSize}
        fontFamily={fontFamily}
        onThemeChange={handleThemeChange}
        onDebugModeChange={handleDebugModeChange}
        onFontSizeChange={handleFontSizeChange}
        onFontFamilyChange={handleFontFamilyChange}
        onClose={() => setShowSettings(false)}
      />
      <AiSettingsPanel
        open={showAiSettings}
        onClose={() => setShowAiSettings(false)}
        onSettingsChanged={() => setAiSettingsVersion((v) => v + 1)}
      />
      {preview && preview.connectionId === selectedId && (
        <DataPreviewModal
          open
          connectionId={preview.connectionId}
          database={preview.database}
          table={preview.table}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

export default App;