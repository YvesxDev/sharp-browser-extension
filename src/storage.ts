import type {
  AutomationExecutionSettings,
  AutomationEventExecutionSettings,
  ExtensionSnapshot,
  ManagedWalletGroup,
  SharpChain,
  SiteId,
  WalletExecutionPlan
} from "./protocol";

export interface StoredConnection {
  id: string;
  endpoint: string;
  remote: boolean;
  discordUserId?: string;
  clientIp?: string;
  apiKey?: string;
}

export interface PendingPairing {
  requestId: string;
  checksum: string;
  origin: string;
  createdAt: number;
  connections: StoredConnection[];
}

export interface StoredState {
  schemaVersion: 1;
  enabled: boolean;
  connections: StoredConnection[];
  selectedClientIdsByChain: Partial<Record<SharpChain, string[]>>;
  siteEnabled: Record<SiteId, boolean>;
  quickAmounts: Record<SharpChain, number[]>;
  quickSellPercentages: Record<SharpChain, number[]>;
  automationExecution: AutomationExecutionSettings;
  walletTradeSellExecution: Record<SharpChain, AutomationEventExecutionSettings>;
  walletTradeSellExecutionByClient: Record<string, AutomationEventExecutionSettings>;
  walletPlansByClient: Record<string, WalletExecutionPlan>;
  sellWalletPlansByClient: Record<string, WalletExecutionPlan>;
  walletGroupsByClient: Record<string, ManagedWalletGroup[]>;
  compatibilityDisabledSites: SiteId[];
  compatibilityExpiresAt?: string;
  pendingPairing?: PendingPairing;
}

const sites: Record<SiteId, boolean> = {
  axiom: true,
  padre: true,
  gmgn: true,
  basedbot: true,
  pumpfun: true,
  fomo: true,
  dexscreener: true
};

const defaults: StoredState = {
  schemaVersion: 1,
  enabled: true,
  connections: Array.from({ length: 11 }, (_, index) => ({
    id: `local-${8686 + index}`,
    endpoint: `http://127.0.0.1:${8686 + index}`,
    remote: false
  })),
  selectedClientIdsByChain: {},
  siteEnabled: sites,
  quickAmounts: {
    solana: [0.1, 0.25, 0.5, 1],
    bsc: [0.01, 0.05, 0.1, 0.25],
    base: [0.005, 0.01, 0.025, 0.05],
    robinhood: [0.01, 0.05, 0.1, 0.25]
  },
  quickSellPercentages: {
    solana: [10, 25, 50, 100],
    bsc: [10, 25, 50, 100],
    base: [10, 25, 50, 100],
    robinhood: [10, 25, 50, 100]
  },
  automationExecution: {
    senders: [],
    senderOverrides: {}
  },
  walletTradeSellExecution: {
    solana: { enabled: false, senders: [] },
    bsc: { enabled: false, senders: [] },
    base: { enabled: false, senders: [] },
    robinhood: { enabled: false, senders: [] }
  },
  walletTradeSellExecutionByClient: {},
  walletPlansByClient: {},
  sellWalletPlansByClient: {},
  walletGroupsByClient: {},
  compatibilityDisabledSites: []
};

const storageKey = "sharpStateV1";

export async function readStoredState(): Promise<StoredState> {
  const value = await browser.storage.local.get([
    storageKey,
    "api_key",
    "remote_ip",
    "discord_id",
    "user_ip"
  ]);
  const stored = value[storageKey] as Partial<StoredState> | undefined;
  if (!stored || stored.schemaVersion !== 1) {
    const apiKey = typeof value.api_key === "string" ? value.api_key : "";
    const remoteIp = typeof value.remote_ip === "string" ? value.remote_ip.trim() : "";
    if (apiKey && remoteIp) {
      const host = remoteIp.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const migrated = structuredClone(defaults);
      migrated.connections.push(...Array.from({ length: 11 }, (_, index) => ({
        id: `legacy-remote-${8686 + index}`,
        endpoint: `https://${host}:${8686 + index}`,
        remote: true,
        apiKey,
        ...(typeof value.discord_id === "string" ? { discordUserId: value.discord_id } : {}),
        ...(typeof value.user_ip === "string" ? { clientIp: value.user_ip } : {})
      })));
      await writeStoredState(migrated);
      return migrated;
    }
    return structuredClone(defaults);
  }
  return {
    ...structuredClone(defaults),
    ...stored,
    siteEnabled: { ...sites, ...stored.siteEnabled },
    quickAmounts: { ...defaults.quickAmounts, ...stored.quickAmounts },
    quickSellPercentages: { ...defaults.quickSellPercentages, ...stored.quickSellPercentages },
    automationExecution: {
      ...defaults.automationExecution,
      ...stored.automationExecution,
      senders: stored.automationExecution?.senders ?? [],
      senderOverrides: stored.automationExecution?.senderOverrides ?? {}
    },
    walletTradeSellExecution: {
      ...defaults.walletTradeSellExecution,
      ...stored.walletTradeSellExecution
    },
    walletTradeSellExecutionByClient: stored.walletTradeSellExecutionByClient ?? {},
    walletPlansByClient: stored.walletPlansByClient ?? {},
    sellWalletPlansByClient: stored.sellWalletPlansByClient ?? {},
    walletGroupsByClient: stored.walletGroupsByClient ?? {},
    selectedClientIdsByChain: stored.selectedClientIdsByChain ?? {},
    compatibilityDisabledSites: stored.compatibilityDisabledSites ?? [],
    connections: stored.connections?.length ? stored.connections : structuredClone(defaults.connections)
  };
}

export async function writeStoredState(state: StoredState): Promise<void> {
  await browser.storage.local.set({ [storageKey]: state });
  if (browser.storage.local.setAccessLevel) {
    await browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
}

export function publicSnapshot(
  state: StoredState,
  clients: ExtensionSnapshot["clients"]
): ExtensionSnapshot {
  const pendingPairing = state.pendingPairing && Date.now() - state.pendingPairing.createdAt < 10 * 60_000
    ? {
        requestId: state.pendingPairing.requestId,
        checksum: state.pendingPairing.checksum,
        origin: state.pendingPairing.origin,
        createdAt: state.pendingPairing.createdAt,
        connectionCount: state.pendingPairing.connections.length,
        permissionOrigins: [...new Set(state.pendingPairing.connections.flatMap((connection) => {
          try {
            const url = new URL(connection.endpoint);
            return [`${url.protocol}//${url.hostname}/*`];
          } catch {
            return [];
          }
        }))]
      }
    : undefined;
  return {
    enabled: state.enabled,
    clients,
    selectedClientIdsByChain: state.selectedClientIdsByChain,
    siteEnabled: state.siteEnabled,
    quickAmounts: state.quickAmounts,
    quickSellPercentages: state.quickSellPercentages,
    automationExecution: state.automationExecution,
    walletTradeSellExecution: state.walletTradeSellExecution,
    walletTradeSellExecutionByClient: state.walletTradeSellExecutionByClient,
    walletPlansByClient: state.walletPlansByClient,
    sellWalletPlansByClient: state.sellWalletPlansByClient,
    walletGroupsByClient: state.walletGroupsByClient,
    compatibilityDisabledSites: state.compatibilityDisabledSites,
    ...(pendingPairing ? { pendingPairing } : {}),
    lastUpdatedAt: Date.now()
  };
}
