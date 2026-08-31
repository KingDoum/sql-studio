import { useState, useRef, useEffect } from 'react';
import {
  Database,
  History,
  Star,
  Settings,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Circle,
} from 'lucide-react';
import { ConnectionManager, type ConnStatus } from '@renderer/components/ConnectionManager';
import { ObjectExplorer } from '@renderer/components/ObjectExplorer';
import { EditorTabs } from '@renderer/components/EditorTabs';
import { SqlEditor, type SqlEditorHandle } from '@renderer/components/SqlEditor';
import { ResultTabs } from '@renderer/components/ResultTabs';
import { TableFieldsPanel } from '@renderer/components/TableFieldsPanel';
import { HistoryPanel } from '@renderer/components/HistoryPanel';
import { FavoritesPanel } from '@renderer/components/FavoritesPanel';
import { AiSettingsPanel } from '@renderer/components/AiSettingsPanel';
import { SettingsPanel } from '@renderer/components/SettingsPanel';
import { ensureDebugLogging } from '@renderer/lib/debug-log';
import type { ConnectionSummary, ThemeMode } from '@shared/types';
import { DataPreviewModal } from '@renderer/components/DataPreviewModal';
import { Modal } from '@renderer/components/Modal';
import { useWorkspace, useActiveTab } from '@renderer/store/workspace';
import { buildSelectSql, splitStatements } from '@renderer/lib/sql-utils';
import { hasWriteStatements } from '@renderer/lib/cell-format';

/** 连接状态 → 图标（顶部应用栏，图标+颜色+文字组合）。 */
const CONN_STATUS_META: Record<string, { icon: typeof Circle; text: string }> = {
  ok: { icon: CheckCircle2, text: '已连接' },
  error: { icon: AlertCircle, text: '连接失败' },
  testing: { icon: Loader2, text: '连接中' },
  unknown: { icon: Circle, text: '未测试' },
};

/**
 * 工作台（任务 8-9 UI 集成）。
 * 左侧：连接管理 + 对象浏览器；右侧：EditorTabs + SqlEditor 编辑器工作台。
 * 任务 10 将结果面板（execution）渲染到编辑器下方。
 */
function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [connStatuses, setConnStatuses] = useState<Record<string, ConnStatus>>({});
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
  const [showTableFields, setShowTableFields] = useState(true);
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
      if (v) { const n = parseInt(v, 10); if (n >= 10 && n <= 30) applyFontSize(n); }
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
    root.style.setProperty('--fs-md', `${Math.min(size + 1, 32)}px`);
    root.style.setProperty('--fs-lg', `${Math.min(size + 2, 34)}px`);
    root.style.setProperty('--fs-xl', `${Math.min(size + 4, 36)}px`);
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
    execution,
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

  // 当前连接摘要（顶部应用栏/底部状态栏展示）
  const currentConn = connections.find((c) => c.id === selectedId) ?? null;
  const currentConnStatus: ConnStatus | undefined = selectedId ? connStatuses[selectedId] : undefined;

  const handleConnectionsChange = (
    list: ConnectionSummary[],
    statuses: Record<string, ConnStatus>,
  ) => {
    setConnections(list);
    setConnStatuses(statuses);
  };

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
      !window.confirm('该 SQL 包含写入操作或无法识别的语句（将按高风险执行），确定执行？')
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

  // 右侧表字段导航 → 插入纯字段名（不带库.表.前缀，2026-08-31 新增）
  const handleInsertField = (field: string) => {
    sqlEditorRef.current?.insertTextAtCursor(field);
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

  // ── 顶部应用栏 / 底部状态栏派生数据 ──
  const statusKey = currentConnStatus ?? 'unknown';
  const StatusIcon = CONN_STATUS_META[statusKey].icon;
  const statusText = CONN_STATUS_META[statusKey].text;
  const totalRows = execution?.result?.resultSets.reduce((n, rs) => n + rs.rows.length, 0) ?? 0;
  const queryStatusText = executing
    ? '执行中'
    : execution?.error
      ? '执行失败'
      : execution?.result
        ? '执行完成'
        : '就绪';
  const currentDb = execution?.database ?? currentConn?.database;

  return (
    <div className="app-shell">
      {/* 顶部应用栏：品牌 | 当前连接 | 连接状态 | 设置 */}
      <header className="top-bar">
        <div className="top-bar-brand">
          <span className="top-bar-logo">
            <Database size={16} strokeWidth={1.8} />
          </span>
          <span className="top-bar-title">SQL Studio</span>
        </div>
        <div className="top-bar-conn">
          {currentConn ? (
            <>
              <span className={`conn-status conn-status-${statusKey}`} title={statusText} />
              <span className="top-bar-conn-name">{currentConn.name}</span>
              <span className="top-bar-conn-meta">
                {currentConn.user}@{currentConn.host}:{currentConn.port}
                {currentConn.database ? `/${currentConn.database}` : ''}
              </span>
              <span className={`top-bar-conn-state top-bar-conn-state-${statusKey}`}>
                <StatusIcon size={13} className={statusKey === 'testing' ? 'spin' : ''} />
                {statusText}
              </span>
            </>
          ) : (
            <span className="top-bar-conn-empty">未连接</span>
          )}
        </div>
        <div className="top-bar-actions">
          <button className="top-bar-icon-btn" onClick={() => setShowHistory(true)} title="执行历史">
            <History size={15} />
          </button>
          <button className="top-bar-icon-btn" onClick={() => setShowFavorites(true)} title="命名收藏">
            <Star size={15} />
          </button>
          <button className="top-bar-icon-btn" onClick={() => setShowSettings(true)} title="设置">
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* 主工作区：资源侧栏 + 中央工作区 */}
      <div className="app-body">
        {/* 左侧资源侧栏：连接 + Schema */}
        <aside className="sidebar">
          <div className="sidebar-panel panel-connections">
            <ConnectionManager
              onSelect={handleSelectConnection}
              selectedId={selectedId ?? undefined}
              onConnectionsChange={handleConnectionsChange}
            />
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
          {activeTab ? (
            <div className="editor-workbench">
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
              <TableFieldsPanel
                sql={activeTab.sql}
                connectionId={currentConnectionId}
                database={currentDb}
                onInsertField={handleInsertField}
                open={showTableFields}
                onToggle={() => setShowTableFields((v) => !v)}
              />
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
      </div>

      {/* 底部状态栏：连接 | 数据库 | 查询状态 | 耗时 | 行数 | 截断 */}
      <footer className="status-bar">
        <span className="status-item">连接：{currentConn?.name ?? '未连接'}</span>
        <span className="status-item">数据库：{currentDb ?? '—'}</span>
        <span className="status-item">状态：{queryStatusText}</span>
        {execution?.result && !executing && (
          <>
            <span className="status-item">耗时：{execution.result.totalElapsedMs} ms</span>
            <span className="status-item">行数：{totalRows}</span>
          </>
        )}
        {execution?.result?.truncated && (
          <span className="status-item status-warn"><AlertTriangle size={11} /> 结果超出上限已截断（前 5 万行）</span>
        )}
      </footer>

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
      {/* 收藏命名弹窗（统一 Modal） */}
      <Modal
        open={favoriteName !== null}
        onClose={() => setFavoriteName(null)}
        title="收藏命名"
        width={400}
        footer={
          <>
            <button className="ai-settings-btn" onClick={() => setFavoriteName(null)}>
              取消
            </button>
            <button className="ai-settings-btn primary" onClick={() => void doSaveFavorite()}>
              保存收藏
            </button>
          </>
        }
      >
        <div style={{ padding: '12px 16px' }}>
          <label className="ai-settings-field">
            <span>收藏名称</span>
            <input
              value={favoriteName ?? ''}
              autoFocus
              placeholder="如 每日活跃用户统计"
              onChange={(e) => setFavoriteName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doSaveFavorite(); }}
            />
          </label>
        </div>
      </Modal>
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