import React from 'react';
import ReactDOM from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import App from './App';
import './styles/index.css';
import './styles/theme.css';

// ── Monaco worker 本地化（Vite ?worker 打包，不走 data: URL）──
// 默认 Monaco ESM 在未配置 MonacoEnvironment.getWorker 时，会用
// data:text/javascript;base64,... 动态 import worker 模块，被 CSP script-src
// 拦截（日志：Failed to fetch dynamically imported module ... editorWorkerService）。
// 这里改用 Vite 打包的独立 worker chunk（worker-src 'self' 即可放行）。
// 注意：monaco-editor package.json exports 为 `./*.js` → `./esm/vs/*.js`，
// 所以此处导入路径省略 `esm/vs/` 前缀（直接写 editor/editor.worker.js），
// 否则会按 exports 二次拼接成 esm/vs/esm/vs/... 导致 Rollup 无法解析。
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(_moduleId: string, _label: string): Worker;
    };
  }
}

window.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// 配置 Monaco 本地加载（生产构建不走 CDN，避免 CSP 拦截）
loader.config({ monaco });

// 预热 Monaco 实例（首次打开编辑器时无需等待加载，提升标签切换/新建体验）
void loader.init();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
