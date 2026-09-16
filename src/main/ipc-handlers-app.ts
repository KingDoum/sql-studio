/**
 * IPC handlers：应用信息 / 安全存储状态 / AI 补全与设置 / 通用设置 /
 * 工作区恢复 / 持久日志。
 */
import { IPC_CHANNELS } from '@shared/ipc-contract';
import { AiService } from './services/ai-service';
import { ALLOWED_SETTING_KEYS, type IpcDeps, type IpcHandle } from './ipc-deps';

export function registerAppHandlers(handle: IpcHandle, deps: IpcDeps): void {
  // ── 应用 ──
  handle(IPC_CHANNELS.ping, () => 'pong');
  // 安全存储状态：safeStorage 不可用时密码仅为 base64 混淆（非真加密），Renderer 据此提示用户
  handle(IPC_CHANNELS['app:securityStatus'], () => ({
    encryptionAvailable: deps.security?.encryptionAvailable ?? false,
  }));

  // ── AI 智能补全 ──
  handle(IPC_CHANNELS['ai:complete'], async (arg) => {
    const config = deps.metadataStore.getAiConfig();
    if (!config || !config.enabled) throw new Error('AI 补全未启用');
    const service = deps.aiService ?? new AiService();
    return service.complete(arg, config);
  });

  // ── AI 设置（Renderer 只见 AiPublicConfig，不含 apiKey）──
  handle(IPC_CHANNELS['settings:getAiConfig'], () => deps.metadataStore.getAiPublicConfig());
  handle(IPC_CHANNELS['settings:setAiConfig'], (arg) => {
    deps.metadataStore.setAiConfig(arg);
    return { saved: true };
  });

  // ── 通用设置（主题/字体/最近目录/结果区高度等持久化）──
  handle(IPC_CHANNELS['settings:get'], (arg) => deps.metadataStore.getSetting(arg.key));
  handle(IPC_CHANNELS['settings:set'], (arg) => {
    // 白名单校验：Renderer 不能写入任意 key
    if (!ALLOWED_SETTING_KEYS.has(arg.key)) {
      throw new Error(`不支持的设置项: ${arg.key}`);
    }
    deps.metadataStore.setSetting(arg.key, arg.value);
    return { saved: true };
  });

  // ── 工作区恢复（自动保存方案）──
  handle(IPC_CHANNELS['workspace:load'], (arg) => {
    const store = deps.workspaceStore;
    if (!store) throw new Error('工作区存储未初始化');
    return store.load(arg.workspaceId);
  });
  handle(IPC_CHANNELS['workspace:save'], (arg) => {
    const store = deps.workspaceStore;
    if (!store) throw new Error('工作区存储未初始化');
    return store.save(arg);
  });
  handle(IPC_CHANNELS['workspace:clear'], (arg) => {
    const store = deps.workspaceStore;
    if (!store) throw new Error('工作区存储未初始化');
    return store.clear(arg);
  });

  // ── 持久日志（自动保存方案）──
  handle(IPC_CHANNELS['logs:append'], (arg) => {
    const svc = deps.logService;
    if (!svc) throw new Error('持久日志服务未初始化');
    return svc.append(arg);
  });
  handle(IPC_CHANNELS['logs:read'], (arg) => {
    const svc = deps.logService;
    if (!svc) throw new Error('持久日志服务未初始化');
    return svc.read(arg ?? {});
  });
  handle(IPC_CHANNELS['logs:clear'], (arg) => {
    const svc = deps.logService;
    if (!svc) throw new Error('持久日志服务未初始化');
    return svc.clear(arg);
  });
}
