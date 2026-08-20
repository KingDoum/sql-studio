import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * 主进程 + preload 构建配置。
 * 双入口输出为 CommonJS（Electron 要求），npm 包与 node 内置模块全部 external，
 * 运行时从 node_modules 加载，避免重复打包（原生模块如 better-sqlite3 必须 external）。
 */
export default defineConfig({
  build: {
    outDir: 'dist/main',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: 'node20',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/main/index.ts'),
        preload: path.resolve(__dirname, 'src/preload/index.ts'),
      },
      output: {
        entryFileNames: '[name].cjs',
        chunkFileNames: 'chunks/[name]-[hash].cjs',
        format: 'cjs',
        exports: 'auto',
      },
      external: (id) => {
        // 项目内部模块：相对路径或以盘符/斜杠开头的绝对路径
        if (id.startsWith('.') || id.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(id)) {
          return false;
        }
        // 其余（electron、node:xx、npm 包）一律 external
        return true;
      },
    },
  },
});
