import { z } from "zod";

export const chains = ["solana", "bsc", "base", "robinhood"] as const;
export type SharpChain = (typeof chains)[number];
export type SiteId = "axiom" | "padre" | "gmgn" | "basedbot" | "pumpfun" | "fomo" | "dexscreener";
export type TradeAction = "buy" | "sell";
export type AutomationTaskType = "dev" | "ticker" | "mint";
export type AutomationLifecycle = "creation" | "migration" | "both";
export const solanaSenders = [
  "rpc",
  "jito",
  "nextblock",
  "temporal",
  "bloxroute",
  "zeroslot",
  "astralane",
  "blockrazor",
  "hellomoon",
  "helius",
  "stellium",
  "soyas",
  "blocksprint",
  "falcon"
] as const;
export type SolanaSender = (typeof solanaSenders)[number];

export interface SenderExecutionOverride {
  priorityFee?: number;
  tip?: number;
}

export interface AutomationExecutionSettings {
  senders: SolanaSender[];
  priorityFee?: number;
  tip?: number;
  senderOverrides: Partial<Record<SolanaSender, SenderExecutionOverride>>;
}

export interface PresetExecutionState {
  clientId: string;
  clientName: string;
  senders: SolanaSender[];
  buyAmount?: number;
}

export interface ManagedWalletSummary {
  name: string;
  address: string;
  balance?: number;
  wrappedBalance?: number;
  nonceAccounts?: string[];
}

export interface ManagedWalletGroup {
  id: string;
  name: string;
  wallets: string[];
  creatorSell?: CreatorSellSettings;
  creatorSellWallets?: string[];
  autosell?: PositionAutosellSettings;
  autosellWallets?: string[];
}

export interface ManagedWalletState {
  clientId: string;
  chain?: SharpChain;
  nativeSymbol?: string;
  wallets: ManagedWalletSummary[];
  groups: ManagedWalletGroup[];
  lookupTables?: ManagedLookupTable[];
}

export interface ManagedLookupTable {
  address: string;
  authorityWallet: string;
  selected: boolean;
}

export interface ActiveWalletBalance {
  address: string;
  name?: string;
  balance: number;
  wrappedBalance?: number;
}

export interface ExecutionFeeDefaults {
  chain: string;
  priorityFeeGwei?: number;
}

export interface WalletAllocation {
  walletName: string;
  walletAddress?: string;
  weight: number;
  automation?: PositionAutomationPolicy;
  autosell?: PositionAutosellSettings;
}

export interface PositionAutosellSettings {
  tpsl: string;
  sl: string;
  tsl: string;
}

export interface AutosellPresetNames {
  tpsl: string[];
  sl: string[];
  tsl: string[];
}

export interface PositionAutomationPolicy {
  creatorSell: boolean;
  migrationSell: boolean;
  walletTradeSell: boolean;
  creatorSellSettings?: Pick<CreatorSellSettings, "enabled" | "minimumPercentage" | "sellPercentage">;
}

export interface WalletWordlist {
  name: string;
  entries: string[];
}

export interface WalletExecutionPlan {
  allocations: WalletAllocation[];
  groupId?: string;
  randomizationBps?: number;
  autoRebalance?: boolean;
}

export interface AutomationTaskOptions {
  label?: string;
  ticker?: string;
  matchTokenName?: boolean;
  markets?: string[];
  minimumQuoteLiquidity?: number;
  minimumCreationQuoteLiquidity?: number;
  maximumLaunchFeePercent?: number;
  maximumPriceImpactPercent?: number;
  allowToken2022TransferHook?: boolean;
  allowOneSidedDammV2?: boolean;
  skipPresetFilters?: boolean;
  cashbackFilter?: "allow" | "exclude" | "only";
  mayhemFilter?: "allow" | "exclude" | "only";
  priorityFee?: number;
  tip?: number;
  slippage?: number;
  senders?: SolanaSender[];
  senderOverrides?: Partial<Record<SolanaSender, SenderExecutionOverride>>;
  useExtensionDefaults?: boolean;
  spamEnabled?: boolean;
  startDelaySeconds?: number;
  stopOnPoolOpen?: boolean;
  stopAfterPoolOpenSeconds?: number;
  transactionsPerSecond?: number;
  stopAfterSeconds?: number;
  maxTotalFeesSol?: number;
  oneShot?: boolean;
  maxMatches?: number;
  transfer?: {
    destinationWallet: string;
    percentage: number;
  };
}

export const capabilitiesSchema = z.object({
  backend_version: z.string(),
  client_id: z.string(),
  client_name: z.string().nullish(),
  module: z.string(),
  chain: z.enum(chains),
  wallet: z.object({
    address: z.string(),
    label: z.string().nullish()
  }).nullish(),
  preset: z.object({
    label: z.string().nullish()
  }).nullish(),
  paper_trade: z.boolean(),
  markets: z.array(z.string()),
  features: z.object({
    buy: z.boolean(),
    sell: z.boolean(),
    snipe_tasks: z.boolean(),
    creator_sell: z.boolean()
  })
});

export type SharpCapabilities = z.infer<typeof capabilitiesSchema>;

export interface ClientState {
  endpointId: string;
  endpoint: string;
  connected: boolean;
  authenticated: boolean;
  error?: string;
  capabilities?: SharpCapabilities;
}

function executableTradeClients(
  clients: ClientState[],
  selectedClientIds: string[],
  chain: SharpChain,
  action: TradeAction
): ClientState[] {
  const executable = clients.filter((client) =>
    client.connected
    && client.authenticated
    && client.capabilities?.chain === chain
    && client.capabilities.module !== "unknown"
    && client.capabilities.features[action]
  );
  const selected = executable.filter((client) => selectedClientIds.includes(client.endpointId));
  if (selected.length || selectedClientIds.length === 0) return selected;
  // Migrate the legacy controller selection only when it cannot fan out.
  return selectedClientIds.length === 1
    && selectedClientIds[0] === "local-8686"
    && executable.length === 1
    ? executable
    : [];
}

export function routableTradeClients(
  clients: ClientState[],
  selectedClientIds: string[],
  chain: SharpChain,
  action: TradeAction
): ClientState[] {
  const selected = executableTradeClients(clients, selectedClientIds, chain, action);
  if (selected.length || selectedClientIds.length > 0) return selected;

  const compatible = clients.filter((client) =>
    client.connected
    && client.authenticated
    && client.capabilities?.chain === chain
    && client.capabilities.module !== "unknown"
    && client.capabilities.features[action]
  );
  return compatible.length === 1 ? compatible : [];
}

export interface TradeContext {
  site: SiteId;
  surface: "detail" | "quick_list" | "position";
  chain: SharpChain;
  address: string;
  addressKind?: "token" | "pool";
  symbol?: string;
  creator?: string;
  creatorStatus?: "resolving" | "resolved" | "unavailable" | "failed";
  creatorError?: string;
  marketHint?: string;
}

export interface TradeCommand {
  context: TradeContext;
  action: TradeAction;
  clientIds: string[];
  amount: {
    mode: "preset" | "native" | "percentage" | "token_amount";
    value?: number;
  };
  overrides?: {
    priorityFee?: number;
    tip?: number;
    slippage?: number;
  };
  walletPlan?: WalletExecutionPlan;
  walletPlansByClient?: Record<string, WalletExecutionPlan>;
  positionIdsByClient?: Record<string, string[]>;
}

export interface TradeResult {
  endpointId: string;
  clientName: string;
  requestId: string;
  status: "accepted" | "failed" | "timed_out";
  message: string;
  errorCode?: string;
  walletResult?: {
    selectedWallets: number;
    queuedPositions: number;
    adjustedPercentage: number;
    exhaustedWallets: string[];
    failedWallets: string[];
  };
}

export type SnipeTaskStatus =
  | "draft" | "armed" | "matched" | "executing" | "landed"
  | "completed" | "paused" | "expired" | "failed";

export interface SnipeTaskSummary {
  id: string;
  revision: number;
  label: string;
  task_type: "dev" | "ticker" | "mint_spam";
  status: SnipeTaskStatus;
  target: {
    creator_wallet?: string;
    creator_wallets?: string[];
    mint?: string;
    ticker?: string;
    tickers?: string[];
    ticker_match?: "exact" | "contains";
  };
  buy_overrides?: { amount?: number };
  last_result?: string;
  updated_at: number;
}

export interface AutomationEventExecutionSettings {
  enabled: boolean;
  senders: SolanaSender[];
  priorityFee?: number;
  tip?: number;
}

export interface CreatorSellSettings {
  enabled: boolean;
  minimumPercentage: number;
  sellPercentage: number;
  execution?: AutomationEventExecutionSettings;
}

export interface MigrationSellSettings {
  enabled: boolean;
  percentage: number;
  delayMs: number;
  execution?: AutomationEventExecutionSettings;
}

export interface WalletTradeSellTrigger {
  id: string;
  enabled: boolean;
  chain: SharpChain;
  wallet: string;
  token: string;
  event: "buy" | "sell" | "both";
  minimumSellPercentage?: number;
  sellPercentage: number;
  execution?: AutomationEventExecutionSettings;
}

export interface SharpPosition extends Record<string, unknown> {
  token_udid?: string;
  tokenUDID?: string;
  id?: string;
  tokenID?: string;
  tokenName?: string;
  tokenSymbol?: string;
  mode?: string;
  market?: string;
  realCurrentHoldings?: number;
  initialSwapAmount?: number;
  lifetimeSwapAmount?: number;
  currentSold?: number;
  totalFees?: number;
  pnl?: number;
  marketCap?: number;
  price?: number;
  soldAll?: boolean;
  additionalData?: Record<string, unknown>;
}

export interface CustomTradePresetSummary {
  id: string;
  name: string;
  module: string;
}

export interface CustomTradeRuntimeStatus {
  runtime_id: string;
  chain: SharpChain;
  state: "starting" | "running" | "degraded" | "failed" | "stopped";
  preset_id: string;
  wallet: string;
  paper_trade: boolean;
  endpoint?: string;
  error?: string;
}

export interface CustomTradeLauncherChain {
  chain: SharpChain;
  module: string;
  presets: CustomTradePresetSummary[];
  wallets: string[];
  runtime?: CustomTradeRuntimeStatus;
}

export interface CustomTradeLauncherState {
  controllerId: string;
  chains: CustomTradeLauncherChain[];
}

export interface DevWordlist {
  name: string;
  mode: "whitelist" | "blacklist";
  entries: string[];
}

export interface ExtensionSnapshot {
  enabled: boolean;
  clients: ClientState[];
  selectedClientIdsByChain: Partial<Record<SharpChain, string[]>>;
  siteEnabled: Record<SiteId, boolean>;
  quickAmounts: Record<SharpChain, number[]>;
  quickSellPercentages: Record<SharpChain, number[]>;
  automationExecution: AutomationExecutionSettings;
  walletTradeSellExecution: Record<SharpChain, AutomationEventExecutionSettings>;
  walletTradeSellExecutionByClient: Record<string, AutomationEventExecutionSettings>;
  walletPlansByClient?: Record<string, WalletExecutionPlan>;
  sellWalletPlansByClient?: Record<string, WalletExecutionPlan>;
  walletGroupsByClient?: Record<string, ManagedWalletGroup[]>;
  compatibilityDisabledSites: SiteId[];
  pendingPairing?: {
    requestId: string;
    checksum: string;
    origin: string;
    createdAt: number;
    connectionCount: number;
  };
  lastUpdatedAt: number;
}

export interface PanelPreferences {
  open?: boolean;
  position?: { x: number; y: number };
  transparent?: boolean;
  opacity?: number;
}

export type RuntimeRequest =
  | { type: "sharp:get-state" }
  | { type: "sharp:get-custom-trade-launcher" }
  | { type: "sharp:start-custom-trade-runtime"; controllerId: string; chain: SharpChain; presetId: string; wallet: string; paperTrade: boolean }
  | { type: "sharp:get-panel-preferences" }
  | { type: "sharp:update-panel-preferences"; preferences: PanelPreferences }
  | { type: "sharp:refresh" }
  | { type: "sharp:prewarm"; context: TradeContext; leaseId: string }
  | { type: "sharp:release-prewarm"; leaseId: string }
  | { type: "sharp:trade"; command: TradeCommand }
  | { type: "sharp:sell-initial"; clientId: string; positionIds: string[] }
  | { type: "sharp:list-tasks"; clientId: string }
  | { type: "sharp:create-task"; clientId: string; taskType: AutomationTaskType; target: string; amount?: number; match?: "exact" | "contains"; lifecycle?: AutomationLifecycle; options?: AutomationTaskOptions; arm?: boolean }
  | { type: "sharp:task-action"; clientId: string; action: "arm" | "pause" | "delete"; taskId: string }
  | { type: "sharp:get-positions"; clientId: string }
  | { type: "sharp:update-position-automation"; clientId: string; context: TradeContext; walletName: string; automation: PositionAutomationPolicy }
  | { type: "sharp:get-autosell-presets"; clientId: string }
  | { type: "sharp:update-position-autosell"; clientId: string; context: TradeContext; walletName: string; settings: PositionAutosellSettings }
  | { type: "sharp:get-managed-wallets"; clientId: string; balances?: boolean }
  | { type: "sharp:get-active-wallet-balance"; clientId: string }
  | { type: "sharp:get-execution-fee-defaults"; clientId: string }
  | { type: "sharp:create-managed-wallet"; clientId: string; name: string }
  | { type: "sharp:create-managed-wallet-nonce"; clientId: string; walletName: string; count?: number }
  | { type: "sharp:rename-managed-wallet"; clientId: string; oldName: string; name: string }
  | { type: "sharp:update-wallet-groups"; clientId: string; groups: ManagedWalletGroup[] }
  | { type: "sharp:update-wallet-plan"; clientId: string; action: TradeAction; plan: WalletExecutionPlan }
  | { type: "sharp:create-lookup-table"; clientId: string; authorityWallet: string }
  | { type: "sharp:update-lookup-tables"; clientId: string; selectedTables: string[] }
  | { type: "sharp:get-migration-sell"; clientId: string }
  | { type: "sharp:update-migration-sell"; clientId: string; settings: MigrationSellSettings }
  | { type: "sharp:get-creator-sell"; clientId: string }
  | { type: "sharp:update-creator-sell"; clientId: string; settings: CreatorSellSettings }
  | { type: "sharp:get-wallet-trade-sell-triggers"; clientId: string }
  | { type: "sharp:update-wallet-trade-sell-triggers"; clientId: string; triggers: WalletTradeSellTrigger[] }
  | { type: "sharp:get-preset-execution"; clientId: string }
  | { type: "sharp:list-dev-lists"; clientId: string }
  | { type: "sharp:update-dev-list"; clientId: string; creator: string; mode: "whitelist" | "blacklist"; file: string }
  | { type: "sharp:list-wallet-lists"; clientId: string }
  | { type: "sharp:append-wallet-list"; clientId: string; wallet: string; chain: SharpChain; file: string }
  | { type: "sharp:update-settings"; patch: Partial<Pick<ExtensionSnapshot, "enabled" | "selectedClientIdsByChain" | "siteEnabled" | "quickAmounts" | "quickSellPercentages" | "automationExecution" | "walletTradeSellExecution" | "walletTradeSellExecutionByClient">> }
  | { type: "sharp:pairing-approve"; requestId: string }
  | { type: "sharp:pairing-reject"; requestId: string }
  | { type: "sharp:wipe-remote" };

export type RuntimeResponse =
  | { ok: true; snapshot?: ExtensionSnapshot; panelPreferences?: PanelPreferences; results?: TradeResult[]; tasks?: SnipeTaskSummary[]; positions?: SharpPosition[]; managedWallets?: ManagedWalletState; activeWalletBalance?: ActiveWalletBalance; executionFeeDefaults?: ExecutionFeeDefaults; autosellPresets?: AutosellPresetNames; creatorSell?: CreatorSellSettings; migrationSell?: MigrationSellSettings; walletTradeSellTriggers?: WalletTradeSellTrigger[]; presetExecution?: PresetExecutionState; devLists?: DevWordlist[]; walletLists?: WalletWordlist[]; customTradeLauncher?: CustomTradeLauncherState; prewarm?: { requestedAddress: string; resolvedAddress: string; creator?: string; clientIds: string[] } }
  | { ok: false; error: string };
