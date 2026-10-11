import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";

/**
 * Kubernetes Compute rules on the caller's own Configuration that preparation or the Gateway
 * entrypoint would otherwise apply only after a dedicated deployment stopped its predecessors
 * (`requiresStoppedPredecessors`; nothing rolls back). Deployment admission and provisioning
 * (`validateHarnessAuth`, `kubernetesGatewayConfigurationDocument`) and preparation call the
 * same functions, so the refusal names the setting while the running revision still serves.
 * Each error names the setting and what is accepted, never the submitted value.
 */
type SettingError = (setting: string, requirement: string) => Error;

export const OPENCLAW_GATEWAY_PASSWORD = "OPENCLAW_GATEWAY_PASSWORD";

/**
 * Whether `gateway.auth` uses the Gateway password Compute generates. Any other password,
 * a literal or another environment variable, is refused: the Gateway reads only
 * OPENCLAW_GATEWAY_PASSWORD from its transport Secret.
 */
export function usesGatewayPasswordEnvironment(
  auth: Readonly<Record<string, unknown>>,
  createError: SettingError,
): boolean {
  if (auth.password === undefined) {
    return false;
  }
  const reference = asRecord(auth.password);
  if (reference?.source !== "env" || reference.id !== OPENCLAW_GATEWAY_PASSWORD) {
    throw createError(
      "gateway.auth.password",
      `must be the ${OPENCLAW_GATEWAY_PASSWORD} environment reference, whose value Kubernetes Compute generates`,
    );
  }
  return true;
}

/**
 * A Gateway that hosts the Agent's workspace node needs the file-transfer plugin. The Gateway
 * entrypoint keeps its own copy of this rule (`requireWorkspaceNodePlugins` in
 * runtime-entrypoints.ts) and exits on it at every start; a parity test pins the two. A
 * `plugins.deny` that is not a list also stops that copy (or the Gateway's own schema).
 */
export function requireWorkspaceNodePlugins(
  configuration: Readonly<OpenClawConfigurationDocument>,
  createError: SettingError,
): void {
  const plugins = asRecord(configuration.plugins);
  const deny = plugins?.deny;
  if (deny !== undefined && deny !== null && !Array.isArray(deny)) {
    throw createError("plugins.deny", "must be a list");
  }
  const requirement = "the Agent's workspace node requires the file-transfer plugin";
  if (Array.isArray(deny) && deny.includes("file-transfer")) {
    throw createError("plugins.deny", `must not list file-transfer: ${requirement}`);
  }
  if (asRecord(asRecord(plugins?.entries)?.["file-transfer"])?.enabled === false) {
    throw createError("plugins.entries.file-transfer.enabled", `must not be false: ${requirement}`);
  }
}

/**
 * Enabled channels need a dedicated Agent workload and an Installation channel runtime
 * (`runtime.channels`: isolated credentials and a reviewed proxy). `providers` lists the
 * enabled channel providers, in Configuration order.
 */
export function requireChannelTopology(
  providers: readonly string[],
  topology: { readonly embedded: boolean; readonly channelRuntime: boolean },
  createError: SettingError,
): void {
  const [provider] = providers;
  if (provider === undefined) {
    return;
  }
  if (topology.embedded) {
    throw createError(
      `channels.${provider}`,
      "is enabled, but channels require a dedicated Agent workload",
    );
  }
  if (!topology.channelRuntime) {
    throw createError(
      `channels.${provider}`,
      "is enabled, but this Installation has no channel runtime: enabled channels require isolated credentials and a reviewed proxy",
    );
  }
}
