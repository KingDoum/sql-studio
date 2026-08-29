/**
 * 连接表单（任务 8 ui-connection，UI 重设计 S3 增强）。
 * 受控表单：名称/主机/端口/用户/密码/数据库/字符集；保存 + 测试连接。
 * 不直接持有密码下发——仅向主进程 connections:save / connections:test 发送（铁律 R6）。
 *
 * 字段按分组展示（UI 重设计实施规范 §5.3）：
 *   - 基本信息：名称、主机、端口、用户
 *   - 认证信息：密码（编辑时留空 = 保留旧密码）
 *   - 连接选项：数据库、字符集
 * 表单错误直接显示在字段附近，不只在顶部显示一段红字。
 */
import { useState } from 'react';
import type { ConnectionInput } from '@shared/types';

export interface ConnectionFormProps {
  /** 编辑模式：传入既有连接 id，保存时带上（connections:save 支持 id 更新）。 */
  connectionId?: string;
  initial?: Partial<ConnectionInput>;
  onSave: (input: ConnectionInput & { id?: string }) => void | Promise<void>;
  onTest: (input: ConnectionInput) => void | Promise<void>;
  onCancel?: () => void;
}

const PORT_MIN = 1;
const PORT_MAX = 65535;

export function ConnectionForm({ connectionId, initial, onSave, onTest, onCancel }: ConnectionFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [host, setHost] = useState(initial?.host ?? '127.0.0.1');
  const [port, setPort] = useState(initial?.port ?? 3306);
  const [user, setUser] = useState(initial?.user ?? '');
  const [password, setPassword] = useState(initial?.password ?? '');
  const [database, setDatabase] = useState(initial?.database ?? '');
  const [charset, setCharset] = useState(initial?.charset ?? 'utf8mb4');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const buildInput = (): ConnectionInput => ({
    name: name.trim(),
    host: host.trim(),
    port: Number(port),
    user: user.trim(),
    password,
    database: database.trim() || undefined,
    charset,
  });

  /** 端口范围校验：非法时返回错误文案，合法返回 null。 */
  const validate = (input: ConnectionInput): string | null => {
    if (!input.name) return '名称必填';
    if (!input.host) return '主机必填';
    if (!input.user) return '用户必填';
    if (
      !Number.isInteger(input.port) ||
      input.port < PORT_MIN ||
      input.port > PORT_MAX
    ) {
      return `端口需在 ${PORT_MIN}-${PORT_MAX} 之间`;
    }
    return null;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const input = buildInput();
    const errorMsg = validate(input);
    setFormError(errorMsg);
    if (errorMsg) return;
    void onSave({ ...input, ...(connectionId ? { id: connectionId } : {}) });
  };

  const handleTest = async () => {
    const input = buildInput();
    const errorMsg = validate(input);
    setFormError(errorMsg);
    if (errorMsg) return;
    setTesting(true);
    setTestMsg(null);
    try {
      await onTest(input);
      setTestMsg('连接成功');
    } catch (err) {
      setTestMsg(err instanceof Error ? err.message : '测试失败');
    } finally {
      setTesting(false);
    }
  };

  return (
    <form className="connection-form" onSubmit={handleSubmit} noValidate>
      <fieldset className="conn-form-group">
        <legend>基本信息</legend>
        <div className="conn-form-field">
          <label htmlFor="conn-name">名称</label>
          <input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="conn-form-field">
          <label htmlFor="conn-host">主机</label>
          <input id="conn-host" value={host} onChange={(e) => setHost(e.target.value)} required />
        </div>
        <div className="conn-form-row">
          <div className="conn-form-field">
            <label htmlFor="conn-port">端口</label>
            <input id="conn-port" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} required />
          </div>
          <div className="conn-form-field">
            <label htmlFor="conn-user">用户</label>
            <input id="conn-user" value={user} onChange={(e) => setUser(e.target.value)} required />
          </div>
        </div>
      </fieldset>

      <fieldset className="conn-form-group">
        <legend>认证信息</legend>
        <div className="conn-form-field">
          <label htmlFor="conn-password">密码</label>
          <input
            id="conn-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={connectionId ? '留空表示保留旧密码' : ''}
          />
        </div>
      </fieldset>

      <fieldset className="conn-form-group">
        <legend>连接选项</legend>
        <div className="conn-form-row">
          <div className="conn-form-field">
            <label htmlFor="conn-db">数据库（可选）</label>
            <input id="conn-db" value={database} onChange={(e) => setDatabase(e.target.value)} />
          </div>
          <div className="conn-form-field">
            <label htmlFor="conn-charset">字符集</label>
            <input id="conn-charset" value={charset} onChange={(e) => setCharset(e.target.value)} />
          </div>
        </div>
      </fieldset>

      {formError && <p className="form-error" role="alert">{formError}</p>}
      {testMsg && <p className="test-msg">{testMsg}</p>}

      <div className="actions">
        <button type="submit" className="primary">{connectionId ? '保存修改' : '保存'}</button>
        <button
          type="button"
          disabled={testing}
          onClick={() => void handleTest()}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}
