/**
 * Monaco 语言 / 主题构建（任务 9 纯逻辑，可单测）。
 *
 * - buildSqlMonarchLanguage：自定义 Monarch tokenizer，继承 SQL 基础语法
 *   （关键字/字符串/注释/数字），并动态注入库/表/字段标识符表——
 *   表名/字段名/库名分别输出 `sql-table` / `sql-column` / `sql-db` 自定义 token，
 *   由主题（SQL_STUDIO_THEME）差异着色，实现语义化高亮（§3/§6.3-9）。
 *   连接切换 / schema 刷新时用新标识符表重建（SqlEditor 负责调用）。
 * - SQL_STUDIO_THEME：深色主题（对齐 §7 色板：关键字品牌紫蓝、表/字段青色系）。
 *
 * 类型说明：不直接依赖 monaco-editor 类型（其子路径导出在 bundler 解析下不稳定），
 * 使用本地结构类型（SqlStudioMonarchLanguage / SqlStudioThemeData），
 * 在调用方（SqlEditor）与 monaco API 形状兼容处做受控转换。
 */
import { SQL_KEYWORDS } from './sql-completion';

/** 注入 tokenizer 的动态标识符表。 */
export interface MonacoSchemaIdentifiers {
  tables: string[];
  columns: string[];
  databases: string[];
}

/** Monarch 语言定义的本地结构类型（形状兼容 monaco.languages.IMonarchLanguage）。 */
export interface SqlStudioMonarchLanguage {
  defaultToken: string;
  tokenPostfix: string;
  ignoreCase: boolean;
  keywords: string[];
  tables: string[];
  columns: string[];
  databases: string[];
  tokenizer: Record<string, Array<unknown>>;
}

/** 主题 token 规则。 */
export interface SqlStudioThemeRule {
  token: string;
  foreground: string;
  fontStyle?: string;
}

/** 主题数据（形状兼容 monaco.editor.IStandaloneThemeData）。 */
export interface SqlStudioThemeData {
  base: string;
  inherit: boolean;
  rules: SqlStudioThemeRule[];
  colors: Record<string, string>;
}

/**
 * 构建 Monarch 语言定义。
 * 标识符规则在「通用 identifier」之前匹配，保证表/字段/库名优先命中自定义 token。
 * 无 schema（未连接）时传空标识符表，只保留关键字高亮。
 */
export function buildSqlMonarchLanguage(ids: MonacoSchemaIdentifiers): SqlStudioMonarchLanguage {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 空表时用永不匹配的正则（避免把 `undefined` 拼进表达式）
  const alt = (arr: string[]) =>
    arr.length ? `(?:${arr.map(esc).join('|')})` : '(?!x)x';

  const tablePattern = alt(ids.tables);
  const columnPattern = alt(ids.columns);
  const dbPattern = alt(ids.databases);

  return {
    defaultToken: '',
    tokenPostfix: '.sql',
    ignoreCase: true,
    keywords: SQL_KEYWORDS,
    tables: ids.tables,
    columns: ids.columns,
    databases: ids.databases,
    tokenizer: {
      root: [
        // 注释
        [/(--.*$)/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        // 空白
        [/[ \t\r\n]+/, 'white'],
        // 字符串（单/双引号）
        [/'/, 'string', '@sql_string'],
        [/"/, 'string', '@sql_double'],
        // 反引号标识符 → 内部动态语义 token
        [/`/, 'delimiter', '@backtick'],
        // 数字
        [/\d+(\.\d+)?/, 'number'],
        // 标识符：库/表/字段 > 关键字 > 普通
        [
          /[\w$#]+/,
          {
            cases: {
              '@databases': 'sql-db',
              '@tables': 'sql-table',
              '@columns': 'sql-column',
              '@keywords': 'keyword',
              '@default': 'identifier',
            },
          },
        ],
        // 分隔符/运算符
        [/[(),;]/, 'delimiter'],
        [/[=<>!+\-*/%&|^~]/, 'operator'],
        [/[.]/, 'delimiter'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
      backtick: [
        [
          /[^`]+/,
          {
            cases: {
              '@databases': 'sql-db',
              '@tables': 'sql-table',
              '@columns': 'sql-column',
              '@default': 'identifier',
            },
          },
        ],
        [/`/, 'delimiter', '@pop'],
      ],
      sql_string: [
        [/[^'\\]+/, 'string'],
        [/\\./, 'string.escape'],
        [/'/, 'string', '@pop'],
      ],
      sql_double: [
        [/[^"\\]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
      ],
    },
  };
}

/** 深色主题（对齐 §7.1 色板）。 */
export const SQL_STUDIO_THEME: SqlStudioThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7C8CF8', fontStyle: 'bold' },
    { token: 'sql-table', foreground: '00D9C8' },
    { token: 'sql-column', foreground: '34C77B' },
    { token: 'sql-db', foreground: 'F5A623' },
    { token: 'identifier', foreground: 'E6E8EF' },
    { token: 'string', foreground: 'A8D08D' },
    { token: 'number', foreground: '58A6FF' },
    { token: 'comment', foreground: '5A5F73', fontStyle: 'italic' },
    { token: 'delimiter', foreground: '9BA0B0' },
    { token: 'operator', foreground: '9BA0B0' },
    { token: 'white', foreground: 'E6E8EF' },
  ],
  colors: {
    'editor.background': '#16171F',
    'editor.foreground': '#E6E8EF',
    'editorLineNumber.foreground': '#3A3F55',
    'editorLineNumber.activeForeground': '#9BA0B0',
    'editor.selectionBackground': '#264F78',
    'editor.inactiveSelectionBackground': '#1E2A44',
    'editorCursor.foreground': '#00D9C8',
    'editorIndentGuide.background': '#262738',
    'editorIndentGuide.activeBackground': '#30314A',
    'editorLineHighlightBackground': '#1E1F29',
    'editorWidget.background': '#1E1F29',
    'editorSuggestWidget.background': '#1E1F29',
    'editorSuggestWidget.selectedBackground': '#262738',
    'editorSuggestWidget.border': '#30314A',
    'editorSuggestWidget.foreground': '#E6E8EF',
  },
};

/** 浅色主题（白天模式）。 */
export const SQL_STUDIO_THEME_LIGHT: SqlStudioThemeData = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '6366F1', fontStyle: 'bold' },
    { token: 'sql-table', foreground: '0D9488' },
    { token: 'sql-column', foreground: '16A34A' },
    { token: 'sql-db', foreground: 'D97706' },
    { token: 'identifier', foreground: '1E1F2E' },
    { token: 'string', foreground: '65A30D' },
    { token: 'number', foreground: '2563EB' },
    { token: 'comment', foreground: '9CA3AF', fontStyle: 'italic' },
    { token: 'delimiter', foreground: '6B7280' },
    { token: 'operator', foreground: '6B7280' },
    { token: 'white', foreground: '1E1F2E' },
  ],
  colors: {
    'editor.background': '#F5F6FA',
    'editor.foreground': '#1E1F2E',
    'editorLineNumber.foreground': '#C8CAD4',
    'editorLineNumber.activeForeground': '#6B7280',
    'editor.selectionBackground': '#BBDEFB',
    'editor.inactiveSelectionBackground': '#E3F2FD',
    'editorCursor.foreground': '#0D9488',
    'editorIndentGuide.background': '#E5E7EB',
    'editorIndentGuide.activeBackground': '#D1D5DB',
    'editorLineHighlightBackground': '#F3F4F6',
    'editorWidget.background': '#FFFFFF',
    'editorSuggestWidget.background': '#FFFFFF',
    'editorSuggestWidget.selectedBackground': '#E5E7EB',
    'editorSuggestWidget.border': '#D1D5DB',
    'editorSuggestWidget.foreground': '#1E1F2E',
  },
};
