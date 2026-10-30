/**
 * 阶段二：企业内部 MCP、钉钉 DWS CLI 与安全沙盒的核心契约。
 */

/** 1. 企业内部 MCP 服务节点配置契约 */
export interface EnterpriseMcpServerConfig {
  id: string;
  name: string;
  domain: 'code' | 'data' | 'log' | 'apidoc' | 'business' | 'general';
  transport: 'stdio' | 'sse' | 'streamable-http';
  endpointOrCommand: string;
  args?: string[];
  envOrHeaders?: Record<string, string>;
  timeoutMs: number;
  enabled: boolean;
  maxResultChars: number;
}

/** 2. 钉钉原生 DWS CLI 执行契约 */
export interface DwsCommandRequest {
  domain: 'doc' | 'wiki' | 'calendar' | 'todo' | 'contact' | 'approval';
  subcommand: string;
  flags: Record<string, string | number | boolean>;
  operatorStaffId: string;
}

/** 3. 安全沙盒执行契约 */
export interface SandboxExecRequest {
  language: 'javascript' | 'python' | 'bash';
  code: string;
  inputDatasets?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated: boolean;
}

/** 沙盒工作区：hostDir 供宿主读写，sandboxDir 是脚本内看到的路径 */
export interface WorkspacePaths {
  hostDir: string;
  sandboxDir: string;
}

/** 对外暴露的 MCP 工具描述（工具名已做命名空间映射） */
export interface McpToolDescriptor {
  serverId: string;
  serverName: string;
  domain: EnterpriseMcpServerConfig['domain'];
  originalName: string;
  namespacedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  maxResultChars: number;
}

/** 单次 MCP 工具调用结果 */
export interface McpToolCallResult {
  text: string;
  isError: boolean;
  raw: unknown;
}

export interface McpToolCallOptions {
  stepId?: string;
  signal?: AbortSignal;
}

/** 大结果卸载到沙盒工作区后的描述 */
export interface OffloadedObservation {
  datasetPath: string;
  datasetKey: string;
  sizeChars: number;
  schema: string;
  sample: unknown;
  previewCount: number;
}

export interface SandboxWorkspaceFile {
  key: string;
  sandboxPath: string;
  sizeChars: number;
}

export interface SandboxDatasetSnapshot {
  datasets: Record<string, unknown>;
  files: SandboxWorkspaceFile[];
  totalChars: number;
}
