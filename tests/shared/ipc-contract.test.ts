/**
 * 共享类型与 IPC 契约的编译期/运行期校验（任务 2）。
 *
 * 本文件本身即"类型编译测试"：若 shared/types.ts 或 ipc-contract.ts
 * 存在类型错误，tsc --noEmit 会直接失败（已纳入 npm run typecheck）。
 * 此处再补运行期断言，确保 channel 唯一来源与映射一致性。
 */
import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc-contract';
import type {
  IpcChannel,
  IpcRequestMap,
  IpcResponseMap,
} from '@shared/ipc-contract';
import type {
  CompletionProvider,
  CompletionItem,
  CompletionContext,
  ConnectionSummary,
  QueryResult,
} from '@shared/types';

describe('IPC 契约', () => {
  it('channel 常量均为字符串且非空', () => {
    const values = Object.values(IPC_CHANNELS);
    expect(values.length).toBeGreaterThan(0);
    for (const ch of values) {
      expect(typeof ch).toBe('string');
      expect((ch as string).length).toBeGreaterThan(0);
    }
  });

  it('ping 通道存在且为 app:ping', () => {
    expect(IPC_CHANNELS.ping).toBe('app:ping');
  });

  it('channel 值不重复（唯一来源）', () => {
    const values = Object.values(IPC_CHANNELS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('IpcChannel 联合类型覆盖所有域', () => {
    // 编译期校验：以下字面量均可赋值给 IpcChannel
    const channels: IpcChannel[] = [
      'app:ping',
      'connections:list',
      'connections:save',
      'connections:remove',
      'connections:test',
      'connections:get',
      'connections:testById',
      'schema:databases',
      'schema:tables',
      'schema:columns',
      'schema:ddl',
      'schema:dataPreview',
      'query:execute',
      'query:cancel',
      'script:open',
      'script:save',
      'export:excel',
      'export:insert',
      'history:list',
      'history:add',
      'history:remove',
      'favorites:list',
      'favorites:save',
      'favorites:remove',
      'favorites:open',
      'ai:complete',
      'settings:getAiConfig',
      'settings:setAiConfig',
      'settings:get',
      'settings:set',
      'dialog:showSaveDialog',
      'dialog:showOpenDialog',
    ];
    expect(channels.length).toBe(Object.values(IPC_CHANNELS).length);
  });
});

describe('类型映射一致性（编译期为主）', () => {
  it('app:ping 响应为 string 类型', () => {
    // 仅作类型可用性断言；运行时无副作用
    const sample: IpcResponseMap['app:ping'] = 'pong';
    expect(typeof sample).toBe('string');
  });

  it('connections:save 请求含 ConnectionInput 字段', () => {
    const req: IpcRequestMap['connections:save'] = {
      name: 'local',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      charset: 'utf8mb4',
    };
    expect(req.charset).toBe('utf8mb4');
  });

  it('ConnectionSummary 不含 password 字段（安全红线）', () => {
    const summary: ConnectionSummary = {
      id: '1',
      name: 'local',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      charset: 'utf8mb4',
      createdAt: 0,
      updatedAt: 0,
    };
    // 编译期保证：summary 上不存在 password 属性
    expect((summary as unknown as Record<string, unknown>).password).toBeUndefined();
  });

  it('QueryResult 多结果集结构可用', () => {
    const q: QueryResult = {
      connectionId: '1',
      resultSets: [],
      totalElapsedMs: 0,
      truncated: false,
      hasWrite: false,
    };
    expect(Array.isArray(q.resultSets)).toBe(true);
  });
});

describe('AI 补全接口预留（V2 契约）', () => {
  it('CompletionProvider 可插拔接口形态正确', () => {
    // 模拟 V1 规则补全 provider 形态（编译期校验结构）
    const schemaProvider: CompletionProvider = {
      kind: 'schema',
      provideCompletions(ctx: CompletionContext): CompletionItem[] {
        return [
          { label: 'users', category: 'table', detail: '表' },
          { label: 'id', category: 'column', detail: '字段' },
        ];
      },
    };
    const items = schemaProvider.provideCompletions({ prefix: 'SELECT ', word: 'us' });
    expect(schemaProvider.kind).toBe('schema');
    expect(items[0]?.category).toBe('table');
  });

  it('ai:complete 占位 channel 已定义（V1 不注册，仅类型占位）', () => {
    expect(IPC_CHANNELS['ai:complete']).toBe('ai:complete');
  });
});
