/**
 * AiCompletionProvider（V2：AI 行内灰色预测）。
 *
 * 注册为 Monaco `registerInlineCompletionsProvider`，在用户输入时
 * 通过 IPC `ai:complete` 向主进程请求 AI 建议，返回灰色行内预测文本。
 *
 * 与 SchemaCompletionProvider（弹窗补全）并列运行，可独立开关。
 * 开关由 AiConfig.enabled 控制——通过 `settings:getAiConfig` 读取。
 */
import type { AiConfig } from '@shared/types';

export interface AiProviderState {
  enabled: boolean;
  config: AiConfig | null;
}

/**
 * 注册 AI 行内补全 provider 到 Monaco。
 * 每次连接切换或设置变更时调用 update() 更新状态。
 * 调用时机：`monaco.languages.registerInlineCompletionsProvider('sql', provider)`
 * 返回 provider 实例（含 dispose() 方法）。
 *
 * 注意：Monaco 的 InlineCompletionsProvider 是 async 接口，
 * 直接返回 `Promise<InlineCompletionsResult>` 实现灰色预测。
 */
function getSqlStudio() {
  return (window as unknown as Record<string, unknown>).sqlStudio as Record<string, (arg: unknown) => Promise<unknown>>;
}

export function createAiInlineProvider(
  state: AiProviderState,
): {
  provideInlineCompletions: (
    model: unknown,
    position: { lineNumber: number; column: number },
    _context: unknown,
    _token: unknown,
  ) => Promise<{ items: Array<{ insertText: string; range: unknown }> }>;
  dispose: () => void;
} {
  let cancelled = false;
  return {
    provideInlineCompletions: async (_model, position, _context, _token) => {
      if (!state.enabled || !state.config?.apiKey) {
        return { items: [] };
      }
      cancelled = false;
      try {
        const model = _model as {
          getValueInRange: (r: { startLineNumber: number; endLineNumber: number; startColumn: number; endColumn: number }) => string;
          getLineContent: (line: number) => string;
        };
        // 光标前文本（当前行光标之前）
        const prefix = model.getValueInRange({
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: 1,
          endColumn: position.column,
        });
        if (!prefix.trim()) return { items: [] };

        const raw = await getSqlStudio()['ai:complete']({
          prefix,
          maxTokens: 512,
        });
        const resp = raw as { suggestion: string };

        if (cancelled || !resp.suggestion) return { items: [] };

        return {
          items: [
            {
              insertText: resp.suggestion,
              range: {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: position.column,
                endColumn: position.column + resp.suggestion.length,
              },
            },
          ],
        };
      } catch (err) {
        if (typeof window !== 'undefined' && window.console) {
          console.error('[AI] 行内补全请求失败:', err instanceof Error ? err.message : String(err));
        }
        return { items: [] };
      }
    },
    dispose: () => {
      cancelled = true;
    },
  };
}

/** 读取 AI 设置（从主进程）。 */
export async function fetchAiConfig(): Promise<AiProviderState> {
  try {
    const config = await getSqlStudio()['settings:getAiConfig'](undefined) as AiConfig | null;
    return { enabled: config?.enabled ?? false, config };
  } catch {
    return { enabled: false, config: null };
  }
}