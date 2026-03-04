import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  timeout?: number; // Timeout in seconds for server initialization
}

export interface MCPClientConnection {
  name: string;
  client: Client;
  transport: Transport;
  connected: boolean;
  lastError?: string;
}

export interface AggregatedToolsResponse {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: object;
    serverName: string;
  }>;
  totalServers: number;
  connectedServers: number;
}


export interface ToolCallRequest {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface ToolCallResponse {
  content: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
}

export interface ServerStatus {
  name: string;
  connected: boolean;
  lastError?: string;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  servers: ServerStatus[];
  timestamp: string;
}

export interface FilterOptions {
  serverNames?: string[];
  namePattern?: string;
  excludeServers?: string[];
}

export interface ToolsQueryParams {
  servers?: string;
  exclude?: string;
  pattern?: string;
  sessionId?: string;
}

// ── CLI IPC Types ──

export type IPCMethod = 'tools' | 'search' | 'info' | 'call' | 'stats' | 'daemon-status';

export interface IPCRequest {
  id: string;
  method: IPCMethod;
  params?: Record<string, unknown>;
}

export interface IPCResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface CLIConfig {
  payloadThreshold?: number;   // chars, default 500
  autoStartDaemon?: boolean;   // default true
  daemonLogLevel?: string;     // default 'info'
}

export interface DaemonStatusResult {
  running: boolean;
  pid: number;
  uptime: number;
  servers: ServerStatus[];
  toolCount: number;
  compressedCount: number;
  socketPath: string;
}

export interface ToolEntry {
  server: string;
  tool: string;
  description: string;
}

export interface ToolInfoResult {
  name: string;
  server: string;
  description: string;
  inputSchema: object;
}

