import React from 'react';
import ReactDOM from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import App from './App';
import './styles/index.css';
import './styles/theme.css';

// 配置 Monaco 本地加载（生产构建不走 CDN，避免 CSP 拦截）
loader.config({ monaco });

// 预热 Monaco 实例（首次打开编辑器时无需等待加载，提升标签切换/新建体验）
void loader.init();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);