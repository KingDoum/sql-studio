/**
 * 连接表单（任务 8 ui-connection）。
 * 受控表单：名称/主机/端口/用户/密码/数据库/字符集；保存 + 测试连接。
 * 不直接持有密码下发——仅向主进程 connections:save / connections:test 发送（铁律 R6）。
 *
 * 表单校验（任务 8 验收项）：必填由 HTML required 兜底；端口范围 1-65535 自定义校验，
 * 不通过时阻止提交并显示错误消息。
 */
import { useState } from 'react';
import type { ConnectionInput } from '@shared/types';

export interface ConnectionFormProps {
  initial?: Partial<ConnectionInput>;
  onSave: (input: ConnectionInput) => void | Promise<void>;
  onTest: (input: ConnectionInput) => void | Promise<void>;
}

const PORT_MIN = 1;
const PORT_MAX = 65535;

export function ConnectionForm({ initial, onSave, onTest }: ConnectionFormProps) {
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
    void onSave(input);
  };

  return (
    <form className="connection-form" onSubmit={handleSubmit} noValidate>
      <label>
        名称
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        主机
        <input value={host} onChange={(e) => setHost(e.target.value)} required />
      </label>
      <label>
        端口
        <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} required />
      </label>
      <label>
        用户
        <input value={user} onChange={(e) => setUser(e.target.value)} required />
      </label>
      <label>
        密码
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label>
        数据库(可选)
        <input value={database} onChange={(e) => setDatabase(e.target.value)} />
      </label>
      <label>
        字符集
        <input value={charset} onChange={(e) => setCharset(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit">保存</button>
        <button
          type="button"
          disabled={testing}
          onClick={async () => {
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
          }}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>
      {formError && <p className="form-error">{formError}</p>}
      {testMsg && <p className="test-msg">{testMsg}</p>}
    </form>
  );
}