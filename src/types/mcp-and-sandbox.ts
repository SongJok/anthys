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
  /** 运行时合并来源；手工配置省略。插件服务只用于展示与审计 */
  source?: 'manual' | 'plugin';
  pluginId?: string;
  /** 该节点工具的默认风险；未声明且无 annotations 时按 write（fail-closed） */
  defaultRisk?: 'read' | 'write' | 'destructive';
  /** 按原始工具名覆盖风险，优先级高于 annotations 与 defaultRisk */
  toolRisk?: Record<string, 'read' | 'write' | 'destructive'>;
}

/** 2. 钉钉原生 DWS CLI 执行契约 */
export interface DwsCommandRequest {
  domain:
    | 'doc'
    | 'wiki'
    | 'calendar'
    | 'todo'
    | 'contact'
    | 'approval'
    | 'report'
    | 'minutes'
    | 'aitable';
  /** 子命令路径，多段命令用空格连接，如 `event create` */
  subcommand: string;
  flags: Record<string, string | number | boolean>;
  operatorStaffId: string;
}

/** 沙盒产物受控导出配置（仅允许落盘到工作区指定子目录） */
export interface SandboxArtifactOutputOptions {
  /** 宿主机工作区根目录，最终产物写入 workspaceRoot/subdir/<fileName> */
  workspaceRoot: string;
  /** 相对工作区根目录的子目录，例如 generated/20261122/run_xxx */
  subdir: string;
  /** 单个产物大小上限（字节），默认 20MB */
  maxFileBytes?: number;
  /** 单次执行全部产物总大小上限（字节），默认 30MB */
  maxTotalBytes?: number;
  /** 单次执行最多导出文件数，默认 10 */
  maxFiles?: number;
}

/** 沙盒通过安全校验后导出的工作区产物 */
export interface SandboxGeneratedArtifact {
  /** 相对工作区的路径，可直接传给 deliver_artifact */
  workspaceRelativePath: string;
  /** 宿主机绝对路径 */
  absolutePath: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
}

/** 3. 安全沙盒执行契约 */
export interface SandboxExecRequest {
  language: 'javascript' | 'python' | 'bash';
  code: string;
  inputDatasets?: Record<string, unknown>;
  timeoutMs?: number;
  /** 开启后允许脚本把生成的图表/报表导出到工作区受控目录 */
  artifactOutput?: SandboxArtifactOutputOptions;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated: boolean;
  /** 本次执行导出并通过安全校验的产物清单 */
  generatedArtifacts?: SandboxGeneratedArtifact[];
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
  /** 连接池解析后的最终风险：toolRisk 覆盖 > annotations > defaultRisk > write */
  risk: 'read' | 'write' | 'destructive';
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
