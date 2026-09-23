import type { ServerStatus } from '../types/index.js';
import type { AuthFailureConfirmer, ManagedClientContext } from './client-manager.js';

/**
 * What a client of the proxy needs from its backend servers, by the names its
 * own configuration gives them.
 *
 * The standalone proxy hands its MCPClientManager over directly. A daemon
 * serving several clients hands each one a view of a shared pool instead,
 * where the same backend may go by a different name per client and every
 * client applies its own `excludeTools`.
 */
export interface BackendAccess {
  getConfiguredServerNames(): string[];
  /** Run work on a leased connection; see MCPClientManager.withClient. */
  withClient<T>(
    serverName: string,
    operation: (context: ManagedClientContext) => Promise<T>
  ): Promise<T>;
  isToolExcluded(serverName: string, toolName: string): boolean;
  getExcludePatterns(): string[];
  getAuthRecoveryPolicy(serverName: string): {
    authErrorPatterns: string[];
    authRetryTools: string[];
  };
  getAuthFailureConfirmer(): AuthFailureConfirmer | undefined;
  getServerStatuses(): ServerStatus[];
}
