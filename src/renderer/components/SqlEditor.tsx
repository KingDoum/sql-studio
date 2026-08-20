/**
 * SqlEditor 组件（任务 9 ui-editor）。
 *
 * 基于 @monaco-editor/react 封装 SQL 编辑器：
 *   - 语言：'sql'（Monaco 内置），覆盖 Monarch tokenizer 实现语义高亮
 *   - 主题：自定义深色 SQL_STUDIO_THEME（对齐 §7 色板）
 *   - 补全：注册 SchemaCompletionProvider（V1 规则补全，可插拔接口）
 *   - 格式化：sql-formatter，Ctrl+Shift+F
 *   - 执行：Ctrl+Enter（选区优先，否则取当前语句）
 *   - 连接切换：重新预取 schema 快照 → 重建补全 provider + tokenizer
 *
 * 测试策略：@monaco-editor/react 在 jsdom 中无法完整加载，
 * 本组件在测试中通过 vi.mock 替换为 stub textarea（纯逻辑测试在 sql-utils / sql-completion / monaco-language 中覆盖）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import { format } from 'sql-formatter';
import { Brain } from 'lucide-react';
import type { ColumnMeta, EditorTab, TableMeta } from '@shared/types';
import { getCurrentStatement, splitStatements } from '@renderer/lib/sql-utils';
import {
  SchemaCompletionProvider,
  type SchemaSnapshot,
} from '@renderer/lib/sql-completion';
import { buildSqlMonarchLanguage, SQL_STUDIO_THEME } from '@renderer/lib/monaco-language';
import {
  createAiInlineProvider,
  fetchAiConfig,
  type AiProviderState,
} from '@renderer/lib/ai-provider';

export interface SqlEditorProps {
  tab: EditorTab;
  connectionId: string | null;
  aiSettingsVersion?: number;
  onSqlChange(sql: string): void;
  onExecute(sql: string, database?: string): void;
  onOpenAiSettings?(): void;
}

const MAX_TABLES_FETCH = 50;

/** 预取 schema 快照。
 *  渲染进程异步拉取主进程 SchemaCache 数据，构建 SchemaSnapshot
 *  供同步的 SchemaCompletionProvider 使用（架构：可插拔接口，provider 同步）。 */
async function fetchSchemaSnapshot(
  connectionId: string,
): Promise<SchemaSnapshot | null> {
  try {
    // 先获取连接配置的默认数据库（优先于 databases[0]）
    let defaultDb: string | undefined;
    try {
      const connSummary = await window.sqlStudio['connections:get']({ id: connectionId });
      defaultDb = connSummary.database;
    } catch {
      // 获取连接详情失败，回退到 databases[0]
    }

    const databases: string[] = await window.sqlStudio['schema:databases']({
      connectionId,
    });
    if (!databases.length) return null;
    const database = defaultDb && databases.includes(defaultDb) ? defaultDb : databases[0];
    const tables: TableMeta[] = await window.sqlStudio['schema:tables']({
      connectionId,
      database,
    });
    // 并行取前 MAX_TABLES_FETCH 张表的字段
    const columnsByTable: Record<string, ColumnMeta[]> = {};
    const batch = tables.slice(0, MAX_TABLES_FETCH);
    const colResults = await Promise.allSettled(
      batch.map((t) =>
        window.sqlStudio['schema:columns']({
          connectionId,
          database,
          table: t.name,
        }),
      ),
    );
    colResults.forEach((r, i) => {
      if (r.status === 'fulfilled') columnsByTable[batch[i].name] = r.value;
    });
    return { connectionId, database, databases, tables, columnsByTable };
  } catch {
    return null;
  }
}

export function SqlEditor({
  tab,
  connectionId,
  aiSettingsVersion = 0,
  onSqlChange,
  onExecute,
  onOpenAiSettings,
}: SqlEditorProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const providerRef = useRef<SchemaCompletionProvider | null>(null);
  const snapshotRef = useRef<SchemaSnapshot | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [aiState, setAiState] = useState<AiProviderState>({ enabled: false, config: null });
  const aiProviderRef = useRef<ReturnType<typeof createAiInlineProvider> | null>(null);

  // 连接切换 → 预取 schema 快照 → 重建补全 + tokenizer
  useEffect(() => {
    if (!connectionId) {
      snapshotRef.current = null;
      providerRef.current?.update(null);
      applyTokenizer(monacoRef.current, null);
      return;
    }
    setSchemaLoading(true);
    fetchSchemaSnapshot(connectionId)
      .then((snapshot) => {
        snapshotRef.current = snapshot;
        providerRef.current?.update(snapshot);
        applyTokenizer(monacoRef.current, snapshot);
      })
      .finally(() => setSchemaLoading(false));
  }, [connectionId]);

  // 初始化 AI 行内补全 provider（+ 设置变化时刷新）
  useEffect(() => {
    fetchAiConfig().then(setAiState);
  }, [aiSettingsVersion]);

  // AI 状态变化 → 重新注册 inline provider
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    // 先 dispose 旧的
    aiProviderRef.current?.dispose();
    const provider = createAiInlineProvider(aiState);
    aiProviderRef.current = provider as unknown as ReturnType<typeof createAiInlineProvider>;
    // 注册 inline completions provider
    const disposable = monaco.languages.registerInlineCompletionsProvider('sql', provider);
    return () => {
      disposable.dispose();
      provider.dispose();
    };
  }, [aiState]);

  // 获取执行语句：选区优先，否则取当前语句
  const getExecuteSql = useCallback((): string => {
    const editor = editorRef.current;
    if (!editor) return tab.sql;
    const model = editor.getModel();
    if (!model) return tab.sql;
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty()) {
      return model.getValueInRange(sel);
    }
    const pos = editor.getPosition();
    if (!pos) return tab.sql;
    const offset = model.getOffsetAt(pos);
    // 当前语句若有选区则直接用选区结果
    const stmt = getCurrentStatement(model.getValue(), offset);
    return stmt || tab.sql;
  }, [tab.sql]);

  const handleExecute = useCallback(() => {
    const sql = getExecuteSql();
    if (!sql) return;
    const db = snapshotRef.current?.database;
    onExecute(sql, db);
  }, [getExecuteSql, onExecute]);

  // 格式化
  const handleFormat = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    try {
      const formatted = format(model.getValue(), { language: 'mysql' });
      editor.executeEdits('format', [
        { range: model.getFullModelRange(), text: formatted },
      ]);
    } catch {
      // sql-formatter 可能抛（空/语义错误），静默
    }
  }, []);

  // 注册快捷键（addAction 返回 IDisposable）
  // 用 ref 保持最新回调，effect 只在 monaco/editor 就绪后执行一次，避免重复注册
  const executeRef = useRef(handleExecute);
  executeRef.current = handleExecute;
  const formatRef = useRef(handleFormat);
  formatRef.current = handleFormat;

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const action1 = editor.addAction({
      id: 'sql-studio.execute',
      label: '执行',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => executeRef.current(),
    });
    const action2 = editor.addAction({
      id: 'sql-studio.format',
      label: '格式化',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
      run: () => formatRef.current(),
    });
    return () => {
      action1.dispose();
      action2.dispose();
    };
  }, [monacoRef.current, editorRef.current]);

  // 模块级补全 provider 注册守卫（只注册一次，避免 key={tab.id} 切换导致重复注册）
let completionProviderRegistered = false;
let globalCompletionDisposable: { dispose(): void } | null = null;

const beforeMount: BeforeMount = useCallback((monaco) => {
    // 注册主题
    monaco.editor.defineTheme('sql-studio-dark', SQL_STUDIO_THEME);

    // 补全 provider：全局只注册一次
    if (!completionProviderRegistered) {
      completionProviderRegistered = true;
      providerRef.current = new SchemaCompletionProvider(null);
      globalCompletionDisposable = monaco.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: ['.', '`'],
        provideCompletionItems: (
          model: {
            getWordUntilPosition(pos: unknown): { word: string; startColumn: number; endColumn: number };
            getValueInRange(range: unknown): string;
          },
          position: { lineNumber: number; column: number },
        ) => {
          const provider = providerRef.current;
          if (!provider) return { suggestions: [] };
          const word = model.getWordUntilPosition(position);
          const prefix = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          const items = provider.provideCompletions({
            prefix,
            word: word.word,
            connectionId: snapshotRef.current?.connectionId,
            database: snapshotRef.current?.database,
          });
          return {
            suggestions: items.map((it) => ({
              label: it.label,
              kind: categoryToMonacoKind(it.category),
              insertText: it.insertText ?? it.label,
              detail: it.detail,
              range: {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
              },
            })),
          };
        },
      });
    }
  }, []);

  const onMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.updateOptions({ theme: 'sql-studio-dark' });
    // 初装 tokenizer（空 schema）
    applyTokenizer(monaco, null);
    // 聚焦
    editor.focus();
  }, []);

  return (
    <div className="sql-editor-container">
      <div className="sql-editor-toolbar">
        <span className="sql-editor-db">
          {schemaLoading
            ? '加载 schema…'
            : snapshotRef.current
              ? `📁 ${snapshotRef.current.database}`
              : connectionId
                ? 'schema 加载失败'
                : '未连接'}
        </span>
        <button
          className="sql-editor-btn"
          title="格式化 (Ctrl+Shift+F)"
          onClick={handleFormat}
        >
          格式化
        </button>
        <button
          className={`sql-editor-btn${aiState.enabled ? ' ai-active' : ''}`}
          title={aiState.enabled ? 'AI 补全已开启' : 'AI 补全未配置'}
          onClick={onOpenAiSettings}
        >
          <Brain size={13} /> AI
        </button>
        <button
          className="sql-editor-btn sql-editor-run"
          title="执行 (Ctrl+Enter)"
          onClick={handleExecute}
        >
          ▶ 执行
        </button>
      </div>
      <div className="sql-editor-wrap">
        <Editor
          key={tab.id}
          language="sql"
          theme="sql-studio-dark"
          value={tab.sql}
          beforeMount={beforeMount}
          onMount={onMount}
          onChange={(val) => {
            if (val !== undefined) onSqlChange(val);
          }}
          options={{
            fontSize: 13,
            fontFamily: "'JetBrains Mono', Consolas, monospace",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: 'on',
            lineNumbers: 'on',
            renderWhitespace: 'selection',
            tabSize: 2,
            padding: { top: 8 },
            suggestOnTriggerCharacters: true,
            quickSuggestions: true,
            bracketPairColorization: { enabled: true },
          }}
          loading={<div className="editor-loading">编辑器加载中…</div>}
        />
      </div>
    </div>
  );
}

// ── 辅助 ──

function categoryToMonacoKind(
  cat: string,
): number {
  // Monaco CompletionItemKind enum
  const kinds: Record<string, number> = {
    keyword: 14, // Keyword
    database: 0,  // Method/property? use 0 (Method)
    table: 1,     // Function? use 1 (Function)
    column: 4,    // Field
    ai: 13,       // Snippet
    function: 1,
  };
  return kinds[cat] ?? 9; // 9 = Text
}

function applyTokenizer(
  monaco: Parameters<OnMount>[1] | null,
  snapshot: SchemaSnapshot | null,
): void {
  if (!monaco) return;
  const ids = {
    tables: snapshot?.tables?.map((t) => t.name) ?? [],
    columns: snapshot
      ? Object.values(snapshot.columnsByTable).flat().map((c) => c.name)
      : [],
    databases: snapshot?.databases ?? [],
  };
  monaco.languages.setMonarchTokensProvider(
    'sql',
    buildSqlMonarchLanguage(ids) as unknown as Parameters<
      typeof monaco.languages.setMonarchTokensProvider
    >[1],
  );
  monaco.editor.getModels().forEach((m: { getLanguageId(): string; getLineCount(): number; tokenization: { forceTokenization(n: number): void } }) => {
    if (m.getLanguageId() === 'sql') {
      m.tokenization.forceTokenization(m.getLineCount());
    }
  });
}