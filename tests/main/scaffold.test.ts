import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/ipc-contract';
import pkg from '../../package.json';

describe('任务 1 骨架冒烟', () => {
  it('IPC 契约定义了 ping channel', () => {
    expect(IPC_CHANNELS.ping).toBe('app:ping');
  });

  it('package.json main 指向主进程构建产物', () => {
    expect(pkg.main).toBe('dist/main/main.cjs');
  });

  it('必备脚本齐全（dev/build/typecheck/test/package）', () => {
    const scripts = ['dev', 'build', 'typecheck', 'test', 'package'] as const;
    for (const script of scripts) {
      expect(typeof pkg.scripts[script]).toBe('string');
    }
  });

  it('共享契约目录结构存在', () => {
    // 静态验证：ipc-contract 是唯一 channel 来源，应被主进程与 preload 引用
    expect(IPC_CHANNELS).toBeDefined();
  });
});
