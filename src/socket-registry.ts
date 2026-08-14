import { io, type Socket } from "socket.io-client";
import {
  capabilitiesSchema,
  type ClientState,
  type CustomTradeLauncherState,
  type CustomTradeRuntimeStatus,
  type CreatorSellSettings,
  type MigrationSellSettings,
  type ManagedWalletGroup,
  type ManagedWalletState,
  type DevWordlist,
  type AutomationLifecycle,
  type AutomationTaskOptions,
  type AutomationTaskType,
  type ActiveWalletBalance,
  type ExecutionFeeDefaults,
  type PresetExecutionState,
  type PositionAutomationPolicy,
  type PositionAutosellSettings,
  type AutosellPresetNames,
  type SharpCapabilities,
  type SharpChain,
  type SharpPosition,
  type SolanaSender,
  type SnipeTaskSummary,
  type TradeCommand,
  type TradeContext,
  type TradeResult,
  type WalletTradeSellTrigger,
  type WalletWordlist
} from "./protocol";
import { positionExecutionWallet, positionId, positionMatchesAsset } from "./position-identity";
import type { StoredConnection } from "./storage";

interface ManagedSocket {
  connection: StoredConnection;
  socket: Socket;
  state: ClientState;
  prewarmed: Map<string, {
    chain: TradeContext["chain"];
    resolvedAddress: string;
    creator?: string;
    tokenUdid?: string;
    lastUsedAt: number;
    leases: Set<string>;
    pendingReleaseLeases: Set<string>;
    releaseTimer?: ReturnType<typeof setTimeout>;
  }>;
  prewarmPending: Map<string, Promise<{
    resolvedAddress: string;
    creator?: string;
    tokenUdid?: string;
  }>>;
  activeLeaseTargets: Map<string, string>;
  positions: Map<string, SharpPosition>;
  positionSnapshotTimer?: ReturnType<typeof setTimeout>;
  positionSnapshotInFlight?: Promise<void>;
  positionSnapshotQueued?: boolean;
  capabilitiesRequestId?: string;
  capabilitiesFallbackTimer?: ReturnType<typeof setTimeout>;
}

interface SocketTransportError extends Error {
  description?: unknown;
  context?: unknown;
}

function socketConnectionErrorMessage(error: SocketTransportError): string {
  const description = error.description;
  if (typeof description === "number") {
    return `WebSocket handshake failed with HTTP ${description}`;
  }
  if (description instanceof Error && description.message) {
    return `WebSocket failed: ${description.message}`;
  }
  if (typeof description === "string" && description.trim()) {
    return `WebSocket failed: ${description.trim()}`;
  }
  const context = error.context;
  if (context && typeof context === "object") {
    const candidate = context as { status?: unknown; statusText?: unknown; type?: unknown };
    if (typeof candidate.status === "number" && candidate.status > 0) {
      return `WebSocket handshake failed with HTTP ${candidate.status}${
        typeof candidate.statusText === "string" && candidate.statusText ? ` ${candidate.statusText}` : ""
      }`;
    }
    if (typeof candidate.type === "string" && candidate.type !== "error") {
      return `WebSocket failed: ${candidate.type}`;
    }
  }
  return error.message || "WebSocket connection failed";
}

const requestTimeoutMs = 15_000;
const walletInventoryTimeoutMs = 1_500;

function isFailedDevModeResponse(envelope: { type?: unknown; status?: unknown }): boolean {
  const type = typeof envelope.type === "string" ? envelope.type.toLowerCase() : "";
  const status = typeof envelope.status === "string" ? envelope.status.toLowerCase() : "";
  return type === "failed" || ["failed", "error", "failure", "rejected"].includes(status);
}

function devModeResponseMessage(
  envelope: { message?: unknown; data?: unknown },
  fallback: string
): string {
  const data = envelope.data && typeof envelope.data === "object"
    ? envelope.data as Record<string, unknown>
    : undefined;
  const nestedError = data?.error && typeof data.error === "object"
    ? data.error as Record<string, unknown>
    : undefined;
  for (const value of [envelope.message, data?.message, data?.error, nestedError?.message]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function acceptsCapabilityResponse(
  connectionId: string,
  pendingRequestId: string | undefined,
  envelope: { request_id?: unknown; runtime_id?: unknown }
): boolean {
  if (typeof envelope.request_id !== "string" || envelope.request_id !== pendingRequestId) {
    return false;
  }
  return connectionId !== "local-8686" || typeof envelope.runtime_id !== "string";
}

const devModeOperation = (event: string): string => {
  const operations: Record<string, string> = {
    acquireSubscribePriceLease: "price.lease",
    addSnipeFilterEntry: "tasks.filters.add",
    armSnipeTask: "tasks.start",
    createManagedLookupTable: "wallets.lookup_tables.create",
    createManagedEvmWallet: "wallets.managed.evm.create",
    createManagedSolanaWallet: "wallets.managed.create",
    createNonceAccount: "wallets.managed.nonces.create",
    renameManagedSolanaWallet: "wallets.managed.rename",
    saveManagedSolanaWalletGroups: "wallets.managed.groups.save",
    createSnipeTask: "tasks.create",
    deleteSnipeTask: "tasks.delete",
    deleteSubscribePrice: "price.unsubscribe",
    getBalances: "wallets.balances",
    getAllPresets: "presets.list",
    getCustomTradeRuntimes: "chains.list",
    getInitialData: "state.get",
    getManagedEvmWalletInventory: "wallets.managed.evm.inventory",
    getManagedEvmWallets: "wallets.managed.evm.list",
    getManagedSolanaWalletInventory: "wallets.managed.inventory",
    getManagedSolanaWallets: "wallets.managed.list",
    getPreset: "presets.active",
    getSnipeSpamReadiness: "tasks.readiness",
    getExecutionFeeDefaults: "execution.fee_defaults",
    listSnipeFilterFiles: "tasks.filters.list",
    listSnipeTasks: "tasks.list",
    pauseSnipeTask: "tasks.stop",
    sellTokenInitials: "position.sell_initial",
    updatePositionAutomation: "position.automation.update",
    getPositionAutosellPresets: "position.autosell.presets",
    updatePositionAutosell: "position.autosell.update",
    resolvePriceAsset: "price.resolve",
    saveManagedLookupTables: "wallets.lookup_tables.save",
    subscribePrice: "price.subscribe",
    startCustomTradeRuntime: "chains.start",
    updatePreset: "presets.update",
    getWalletTradeSellTriggers: "automations.wallet_trade_sell.get",
    saveWalletTradeSellTriggers: "automations.wallet_trade_sell.save"
  };
  const operation = operations[event];
  if (!operation) throw new Error(`Unsupported Sharp Dev Mode operation: ${event}`);
  return operation;
};

function mergeDevList(
  raw: unknown,
  creator: string,
  mode: "whitelist" | "blacklist"
): { whitelist: string; blacklist: string } {
  const parsed = (() => {
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return { whitelist: raw, blacklist: "" };
    }
  })();
  const filters = typeof parsed === "object" && parsed !== null
    ? parsed as { whitelist?: unknown; blacklist?: unknown }
    : {};
  const text = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string").join(",")
      : typeof value === "string" ? value : "";
  const entries = (value: string) =>
    value.split(/[,\n\r|]/).map((entry) => entry.trim()).filter(Boolean);
  const whitelist = entries(text(filters.whitelist));
  const blacklist = entries(text(filters.blacklist));
  const selected = mode === "whitelist" ? whitelist : blacklist;
  const opposite = mode === "whitelist" ? blacklist : whitelist;
  if (!selected.includes(creator)) selected.push(creator);
  const oppositeIndex = opposite.indexOf(creator);
  if (oppositeIndex >= 0) opposite.splice(oppositeIndex, 1);
  return {
    whitelist: whitelist.join(","),
    blacklist: blacklist.join(",")
  };
}

function buildAutomationTask(
  taskType: AutomationTaskType,
  target: string,
  amount?: number,
  match: "exact" | "contains" = "exact",
  lifecycle: AutomationLifecycle = "both",
  options: AutomationTaskOptions = {}
) {
  const isMint = taskType === "mint";
  const isSpam = isMint && options.spamEnabled === true;
  const ticker = taskType === "ticker" ? target : options.ticker?.trim();
  const buyOverrides = {
    ...(amount === undefined ? {} : { amount }),
    ...(options.priorityFee === undefined ? {} : { priority_fee: options.priorityFee }),
    ...(options.tip === undefined ? {} : { tip: options.tip }),
    ...(options.slippage === undefined ? {} : { slippage: options.slippage })
  };
  return {
    label: options.label?.trim() || (taskType === "dev"
      ? `Dev Buy ${target.slice(0, 6)}`
      : taskType === "mint"
        ? `${isSpam ? "Spam" : "Migration Buy"} ${target.slice(0, 6)}`
        : `Ticker ${target.toUpperCase()}`),
    task_type: taskType === "mint" ? "mint_spam" : taskType,
    target: {
      creator_wallets: taskType === "dev" ? [target] : [],
      creator_wallet_labels: {},
      tickers: ticker ? [ticker.toUpperCase()] : [],
      ...(taskType === "mint" ? { mint: target } : {}),
      blacklisted_tickers: [],
      blacklisted_creator_wallets: [],
      blacklisted_transaction_accounts: [],
      whitelisted_transaction_accounts: [],
      ticker_match: match,
      match_token_name: options.matchTokenName ?? false
    },
    lifecycle_triggers: {
      creation: !isSpam && (lifecycle === "creation" || lifecycle === "both"),
      migration: !isSpam && (lifecycle === "migration" || lifecycle === "both"),
      liquidity_activation: false,
      timed_activation: isSpam
    },
    markets: options.markets ?? [],
    ...(options.minimumQuoteLiquidity === undefined ? {} : {
      minimum_quote_liquidity: options.minimumQuoteLiquidity
    }),
    ...(options.minimumCreationQuoteLiquidity === undefined ? {} : {
      minimum_creation_quote_liquidity: options.minimumCreationQuoteLiquidity
    }),
    ...(options.maximumLaunchFeePercent === undefined ? {} : {
      maximum_launch_fee_percent: options.maximumLaunchFeePercent
    }),
    ...(options.maximumPriceImpactPercent === undefined ? {} : {
      maximum_price_impact_percent: options.maximumPriceImpactPercent
    }),
    buy_overrides: buyOverrides,
    senders: options.senders ?? [],
    forwarder_overrides: Object.fromEntries(
      Object.entries(options.senderOverrides ?? {}).map(([sender, overrides]) => [
        sender,
        {
          ...(overrides?.priorityFee === undefined ? {} : { priority_fee: overrides.priorityFee }),
          ...(overrides?.tip === undefined ? {} : { tip: overrides.tip })
        }
      ])
    ),
    allow_one_sided_damm_v2: options.allowOneSidedDammV2 ?? true,
    meteora_pool_types: [],
    allow_token_2022_transfer_hook: options.allowToken2022TransferHook ?? true,
    skip_preset_filters: options.skipPresetFilters ?? false,
    cashback_filter: options.cashbackFilter ?? "allow",
    mayhem_filter: options.mayhemFilter ?? "allow",
    compute_unit_overrides: {},
    market_spam: {},
    completion: {
      one_shot: options.oneShot ?? taskType === "mint",
      max_matches: options.maxMatches ?? (taskType === "mint" ? 1 : 100)
    },
    ...(isMint ? {
      spam: {
        start_mode: (options.startDelaySeconds ?? 0) > 0 ? "after_delay" : "immediately",
        start_delay_seconds: options.startDelaySeconds ?? 0,
        stop_on_pool_open: options.stopOnPoolOpen ?? true,
        stop_after_pool_open_seconds: options.stopAfterPoolOpenSeconds ?? 0,
        enabled: isSpam,
        interval_ms: 100,
        transactions_per_second: options.transactionsPerSecond ?? 10,
        transactions_per_block: 0,
        include_tips: true,
        use_durable_nonces: true,
        nonce_accounts: [],
        senders: options.senders ?? [],
        max_attempts: 0,
        compute_unit_min: 0,
        compute_unit_max: 0,
        lead_slots: 0,
        expiry_slots: 5,
        stop_after_seconds: options.stopAfterSeconds ?? 20,
        max_total_fees_sol: options.maxTotalFeesSol ?? 0.05,
        max_total_quote_amount: amount ?? 1,
        duplicate_buy_guard: "ata_creation",
        precreate_ata: false,
        max_wallet_balance_sol: 0
      }
    } : {}),
    priority: 0,
    post_buy_transfer: {
      enabled: isSpam && options.transfer !== undefined,
      destination_wallet: isSpam ? options.transfer?.destinationWallet ?? "" : "",
      ...(isSpam && options.transfer ? { percentage: options.transfer.percentage } : {}),
      confirmation_delay_ms: 0,
      retry_limit: isSpam && options.transfer ? 2 : 0
    }
  };
}

export class SocketRegistry {
  private readonly sockets = new Map<string, ManagedSocket>();
  private onChange: () => void = () => undefined;
  private onPositionsChange: (connectionId: string, positions: SharpPosition[]) => void = () => undefined;

  setChangeListener(listener: () => void): void {
    this.onChange = listener;
  }

  setPositionsChangeListener(
    listener: (connectionId: string, positions: SharpPosition[]) => void
  ): void {
    this.onPositionsChange = listener;
  }

  states(): ClientState[] {
    return [...this.sockets.values()].map(({ state }) => structuredClone(state));
  }

  async replaceConnections(connections: StoredConnection[]): Promise<void> {
    const wanted = new Set(connections.map(({ id }) => id));
    for (const [id, managed] of this.sockets) {
      if (!wanted.has(id)) {
        managed.socket.disconnect();
        this.sockets.delete(id);
      }
    }
    await Promise.all(connections.map((connection) => this.ensureConnection(connection)));
  }

  disconnectAll(): void {
    for (const managed of this.sockets.values()) managed.socket.disconnect();
    this.sockets.clear();
    this.onChange();
  }

  async trade(connectionId: string, command: TradeCommand): Promise<TradeResult> {
    const managed = this.sockets.get(connectionId);
    const clientName = managed?.state.capabilities?.client_name || connectionId;
    const requestId = crypto.randomUUID();
    if (!managed?.socket.connected || !managed.state.authenticated) {
      return { endpointId: connectionId, clientName, requestId, status: "failed", message: "Sharp client is disconnected" };
    }
    const pendingPrewarm = command.action === "buy"
      ? managed.prewarmPending.get(command.context.address)
      : undefined;
    if (pendingPrewarm && command.context.chain !== "solana") {
      // Give an in-flight EVM prewarm a chance to populate the cache without blocking submission.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 750);
        void pendingPrewarm.finally(() => {
          clearTimeout(timeout);
          resolve();
        }).catch(() => undefined);
      });
    }
    const warmed = managed.prewarmed.get(command.context.address)
      ?? [...managed.prewarmed.values()].find(
        (entry) => entry.resolvedAddress === command.context.address
      );
    if (warmed) warmed.lastUsedAt = Date.now();
    const isSolanaBuy = command.action === "buy" && command.context.chain === "solana";
    const isSolanaSell = command.action === "sell" && command.context.chain === "solana";
    const tradeAddress = warmed?.resolvedAddress ?? command.context.address;
    const completion = this.createTradeResultWaiter(
      managed.socket,
      requestId,
      isSolanaBuy ? ["confirmed", "success", "queued"] : isSolanaSell ? ["queued"] : []
    );
    const positionCompletion = isSolanaBuy
      ? this.createPositionChangeWaiter(managed, tradeAddress)
      : isSolanaSell
        ? this.createSellPositionChangeWaiter(
          managed,
          tradeAddress,
          command.walletPlan?.allocations.map((allocation) => allocation.walletName) ?? []
        )
        : undefined;
    const response = await this.request(
      managed.socket,
      "trade",
      {
        action: command.action,
        asset: {
          chain: command.context.chain,
          address: tradeAddress,
          ...(command.context.chain === "solana" && command.context.addressKind
            ? { address_kind: command.context.addressKind }
            : {})
        },
        source: {
          site: command.context.site,
          surface: command.context.surface,
          market_hint: command.context.marketHint || "custom"
        },
        amount: command.amount,
        overrides: {
          priority_fee: command.overrides?.priorityFee,
          tip: command.overrides?.tip,
          slippage: command.overrides?.slippage
        },
        ...(command.walletPlan?.allocations.length ? {
          wallet_plan: command.walletPlan.allocations.map((allocation) => ({
            name: allocation.walletName,
            weight: allocation.weight,
            ...(allocation.automation ? {
              automation: {
                creator_sell: allocation.automation.creatorSell,
                migration_sell: allocation.automation.migrationSell,
                wallet_trade_sell: allocation.automation.walletTradeSell,
                ...(allocation.automation.creatorSellSettings ? {
                  creator_sell_settings: {
                    enabled: allocation.automation.creatorSellSettings.enabled,
                    minimum_percentage: allocation.automation.creatorSellSettings.minimumPercentage,
                    sell_percentage: allocation.automation.creatorSellSettings.sellPercentage
                  }
                } : {})
              }
            } : {}),
            ...(allocation.autosell ? { autosell: allocation.autosell } : {})
          }))
        } : {}),
        ...(command.positionIdsByClient?.[connectionId]?.length ? {
          position_ids: command.positionIdsByClient[connectionId]
        } : {}),
        require_precomputed:
          command.context.chain === "solana" && command.context.surface === "detail"
      },
      requestId
    );
    if (!response.ok) {
      completion?.cancel();
      positionCompletion?.cancel();
      return {
        endpointId: connectionId,
        clientName,
        requestId,
        status: response.timeout ? "timed_out" : "failed",
        message: response.message,
        ...(response.errorCode ? { errorCode: response.errorCode } : {})
      };
    }
    if (completion) {
      const timeoutMs = response.transactionTimeoutMs ?? 30_000;
      const result = await Promise.race([
        completion.promise,
        ...(positionCompletion ? [positionCompletion.promise] : []),
        new Promise<{ ok: boolean; timeout: true; message: string }>((resolve) => {
          setTimeout(() => resolve({
            ok: false,
            timeout: true,
            message: `No transaction result received within the ${timeoutMs} ms preset timeout`
          }), timeoutMs);
        })
      ]);
      completion.cancel();
      positionCompletion?.cancel();
      return {
        endpointId: connectionId,
        clientName,
        requestId,
        status: result.ok ? "accepted" : result.timeout ? "timed_out" : "failed",
        message: result.message,
        ...("errorCode" in result && result.errorCode ? { errorCode: result.errorCode } : {}),
        ...("walletResult" in result && result.walletResult
          ? { walletResult: result.walletResult }
          : {})
      };
    }
    return {
      endpointId: connectionId,
      clientName,
      requestId,
      status: response.ok ? "accepted" : response.timeout ? "timed_out" : "failed",
      message: response.message,
      ...(response.errorCode ? { errorCode: response.errorCode } : {})
    };
  }

  private createTradeResultWaiter(
    socket: Socket,
    requestId: string,
    ignoredSuccessStatuses: string[] = []
  ): {
    promise: Promise<{
      ok: boolean;
      timeout?: boolean;
      message: string;
      errorCode?: string;
      walletResult?: NonNullable<TradeResult["walletResult"]>;
    }>;
    cancel(): void;
  } {
    let active = true;
    const events = ["devModeEvent"] as const;
    type ResultPayload = {
      request_id?: string;
      operation?: string;
      type?: string;
      status?: string;
      message?: string;
      error_code?: string;
      wallet_result?: {
        selected_wallets?: number;
        queued_positions?: number;
        adjusted_percentage?: number;
        exhausted_wallets?: string[];
        failed_wallets?: string[];
      };
      data?: {
        status?: string;
        message?: string;
        error_code?: string;
        wallet_result?: {
          selected_wallets?: number;
          queued_positions?: number;
          adjusted_percentage?: number;
          exhausted_wallets?: string[];
          failed_wallets?: string[];
        };
      };
    };
    const listeners = new Map<string, (response: ResultPayload) => void>();
    const cleanup = () => {
      for (const [event, listener] of listeners) socket.off(event, listener);
      listeners.clear();
    };
    const promise = new Promise<{
      ok: boolean;
      message: string;
      errorCode?: string;
      walletResult?: NonNullable<TradeResult["walletResult"]>;
    }>((resolve) => {
      for (const event of events) {
        const listener = (response: ResultPayload) => {
          if (
            !active
            || response.request_id !== requestId
            || response.operation !== "trade"
            || !["result", "progress"].includes(response.type || "")
          ) return;
          const result = response.data ?? response;
          if (result.status === "submitted") return;
          const walletResult = result.wallet_result ?? response.wallet_result;
          const errorCode = result.error_code ?? response.error_code;
          const isPartialQueue = result.status === "queued"
            && ((walletResult?.failed_wallets?.length ?? 0) > 0 || Boolean(errorCode));
          if (response.type === "progress" && !isPartialQueue) return;
          const ok = result.status === "confirmed" || result.status === "success" || result.status === "queued";
          if (ok && !isPartialQueue && ignoredSuccessStatuses.includes(result.status || "")) return;
          active = false;
          cleanup();
          resolve({
            ok,
            message: result.message || (ok ? "Trade accepted" : "Trade failed"),
            ...(errorCode ? { errorCode } : {}),
            ...(walletResult ? {
              walletResult: {
                selectedWallets: walletResult.selected_wallets ?? 0,
                queuedPositions: walletResult.queued_positions ?? 0,
                adjustedPercentage: walletResult.adjusted_percentage ?? 0,
                exhaustedWallets: walletResult.exhausted_wallets ?? [],
                failedWallets: walletResult.failed_wallets ?? []
              }
            } : {})
          });
        };
        listeners.set(event, listener);
        socket.on(event, listener);
      }
    });
    return {
      promise,
      cancel() {
        if (!active) return;
        active = false;
        cleanup();
      }
    };
  }

  private createPositionChangeWaiter(managed: ManagedSocket, address: string): {
    promise: Promise<{ ok: true; message: string }>;
    cancel(): void;
  } {
    const normalizedAddress = address.toLowerCase();
    const metric = () => {
      let total = 0;
      let found = false;
      for (const position of managed.positions.values()) {
        const record = position as Record<string, unknown>;
        if (!positionMatchesAsset(position, normalizedAddress)) continue;
        found = true;
        for (const value of [
          position.initialSwapAmount,
          position.realCurrentHoldings,
          record.initial_swap_amount,
          record.holdings
        ]) {
          const number = Number(value);
          if (Number.isFinite(number)) total += number;
        }
      }
      return { found, total };
    };
    const baseline = metric();
    let interval: ReturnType<typeof setInterval> | undefined;
    let active = true;
    const promise = new Promise<{ ok: true; message: string }>((resolve) => {
      interval = setInterval(() => {
        if (!active) return;
        const current = metric();
        if (!current.found || (baseline.found && current.total <= baseline.total)) return;
        active = false;
        if (interval !== undefined) clearInterval(interval);
        resolve({ ok: true, message: "Buy confirmed by the Sharp position stream" });
      }, 50);
    });
    return {
      promise,
      cancel() {
        if (!active) return;
        active = false;
        if (interval !== undefined) clearInterval(interval);
      }
    };
  }

  private createSellPositionChangeWaiter(
    managed: ManagedSocket,
    address: string,
    selectedWallets: string[]
  ): {
    promise: Promise<{ ok: true; message: string }>;
    cancel(): void;
  } {
    const normalizedAddress = address.toLowerCase();
    const selected = new Set(selectedWallets);
    const snapshot = () => {
      const positions = new Map<string, { holding: number; sold: number; soldAll: boolean }>();
      for (const [id, position] of managed.positions) {
        const record = position as Record<string, unknown>;
        if (!positionMatchesAsset(position, normalizedAddress)) continue;
        const wallet = positionExecutionWallet(position) ?? "";
        if (selected.size && !selected.has(wallet)) continue;
        positions.set(positionId(position) ?? id, {
          holding: Number(position.realCurrentHoldings ?? record.holdings ?? 0),
          sold: Number(position.currentSold ?? record.current_sold ?? 0),
          soldAll: Boolean(position.soldAll ?? record.sold_all)
        });
      }
      return positions;
    };
    const baseline = snapshot();
    let interval: ReturnType<typeof setInterval> | undefined;
    let active = true;
    const promise = new Promise<{ ok: true; message: string }>((resolve) => {
      interval = setInterval(() => {
        if (!active || baseline.size === 0) return;
        const current = snapshot();
        const allChanged = [...baseline].every(([id, before]) => {
          const after = current.get(id);
          return !after
            || after.soldAll
            || after.sold > before.sold + Number.EPSILON
            || after.holding < before.holding - Number.EPSILON;
        });
        if (!allChanged) return;
        active = false;
        if (interval !== undefined) clearInterval(interval);
        resolve({ ok: true, message: "Sell confirmed by the Sharp position stream" });
      }, 50);
    });
    return {
      promise,
      cancel() {
        if (!active) return;
        active = false;
        if (interval !== undefined) clearInterval(interval);
      }
    };
  }

  async prewarm(
    connectionId: string,
    context: TradeContext,
    leaseId: string,
    walletNames: string[] = []
  ): Promise<{ resolvedAddress: string; creator?: string }> {
    const managed = this.requireSocket(connectionId);
    if (!leaseId.trim()) throw new Error("Price prewarm lease id is required");
    const previousTarget = managed.activeLeaseTargets.get(leaseId);
    if (previousTarget && previousTarget !== context.address) {
      this.releaseManagedLease(managed, leaseId, previousTarget);
    }
    managed.activeLeaseTargets.set(leaseId, context.address);
    const existing = managed.prewarmed.get(context.address);
    if (existing) {
      if (existing.releaseTimer !== undefined) {
        clearTimeout(existing.releaseTimer);
        delete existing.releaseTimer;
      }
      if (existing.pendingReleaseLeases.delete(leaseId)) {
        existing.leases.add(leaseId);
      } else if (!existing.leases.has(leaseId)) {
        if (!existing.tokenUdid) throw new Error("Sharp returned no price-subscription id");
        await this.requestRaw(managed.socket, "acquireSubscribePriceLease", {
          chain: context.chain,
          tokenUDID: existing.tokenUdid,
          leaseID: leaseId
        });
        if (managed.activeLeaseTargets.get(leaseId) !== context.address) {
          void this.requestRaw(managed.socket, "deleteSubscribePrice", {
            chain: context.chain,
            tokenUDID: existing.tokenUdid,
            leaseID: leaseId
          }).catch(() => undefined);
        } else {
          existing.leases.add(leaseId);
        }
      }
      existing.lastUsedAt = Date.now();
      return {
        resolvedAddress: existing.resolvedAddress,
        ...(existing.creator ? { creator: existing.creator } : {})
      };
    }
    const pending = managed.prewarmPending.get(context.address);
    if (pending) {
      await pending;
      return this.prewarm(connectionId, context, leaseId);
    }
    const request = this.requestRaw<{
      token_id?: string;
      token_udid?: string;
      creator_wallet?: string;
    }>(
      managed.socket,
      "subscribePrice",
      {
        chain: context.chain,
        tokenID: context.address,
        market: context.marketHint || "custom",
        market_hint: context.marketHint,
        leaseID: leaseId,
        wallet_names: [...new Set(walletNames.map((name) => name.trim()).filter(Boolean))].slice(0, 20)
      }
    ).then((response) => ({
      resolvedAddress: response.token_id || context.address,
      ...(response.creator_wallet ? { creator: response.creator_wallet } : {}),
      ...(response.token_udid ? { tokenUdid: response.token_udid } : {})
    }));
    managed.prewarmPending.set(context.address, request);
    try {
      const response = await request;
      if (!response.tokenUdid) throw new Error("Sharp returned no price-subscription id");
      const active = managed.activeLeaseTargets.get(leaseId) === context.address;
      managed.prewarmed.set(context.address, {
        chain: context.chain,
        resolvedAddress: response.resolvedAddress,
        ...(response.creator ? { creator: response.creator } : {}),
        tokenUdid: response.tokenUdid,
        lastUsedAt: Date.now(),
        leases: new Set(active ? [leaseId] : []),
        pendingReleaseLeases: new Set()
      });
      if (!active) {
        void this.requestRaw(managed.socket, "deleteSubscribePrice", {
          chain: context.chain,
          tokenUDID: response.tokenUdid,
          leaseID: leaseId
        }).finally(() => {
          if (!managed.prewarmed.get(context.address)?.leases.size) {
            managed.prewarmed.delete(context.address);
          }
        }).catch(() => undefined);
      }
      return {
        resolvedAddress: response.resolvedAddress,
        ...(response.creator ? { creator: response.creator } : {})
      };
    } finally {
      managed.prewarmPending.delete(context.address);
    }
  }

  releasePrewarmLease(leaseId: string): void {
    for (const managed of this.sockets.values()) {
      const target = managed.activeLeaseTargets.get(leaseId);
      if (target) this.releaseManagedLease(managed, leaseId, target);
    }
  }

  private releaseManagedLease(
    managed: ManagedSocket,
    leaseId: string,
    address: string
  ): void {
    if (managed.activeLeaseTargets.get(leaseId) === address) {
      managed.activeLeaseTargets.delete(leaseId);
    }
    const entry = managed.prewarmed.get(address);
    if (!entry || !entry.leases.delete(leaseId) || !entry.tokenUdid) return;
    if (entry.leases.size > 0) {
      void this.requestRaw(managed.socket, "deleteSubscribePrice", {
        chain: entry.chain,
        tokenUDID: entry.tokenUdid,
        leaseID: leaseId
      }).catch(() => undefined);
      return;
    }
    entry.pendingReleaseLeases.add(leaseId);
    if (entry.releaseTimer !== undefined) clearTimeout(entry.releaseTimer);
    entry.releaseTimer = setTimeout(() => {
      delete entry.releaseTimer;
      const releases = [...entry.pendingReleaseLeases];
      entry.pendingReleaseLeases.clear();
      for (const releaseLeaseId of releases) {
        void this.requestRaw(managed.socket, "deleteSubscribePrice", {
          chain: entry.chain,
          tokenUDID: entry.tokenUdid,
          leaseID: releaseLeaseId
        }).catch(() => undefined);
      }
      if (entry.leases.size === 0) managed.prewarmed.delete(address);
    }, 1_500);
  }

  async listTasks(connectionId: string): Promise<SnipeTaskSummary[]> {
    const managed = this.requireSocket(connectionId);
    const response = await this.requestRaw<{ tasks?: SnipeTaskSummary[] }>(managed.socket, "listSnipeTasks", {});
    return (response.tasks ?? []).filter((task) =>
      task.task_type === "dev" ||
      task.task_type === "ticker" ||
      task.task_type === "mint_spam"
    );
  }

  async sellInitial(connectionId: string, positionIds: string[]): Promise<void> {
    const managed = this.requireSocket(connectionId);
    const ids = [...new Set(positionIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) throw new Error("No open Sharp position is available for this token");
    if (ids.length > 20) throw new Error("Sell Initial supports at most 20 positions at once");
    await Promise.all(ids.map((tokenUDID) =>
      this.requestRaw(managed.socket, "sellTokenInitials", { tokenUDID })
    ));
  }

  async getPositions(connectionId: string): Promise<SharpPosition[]> {
    const managed = this.requireSocket(connectionId);
    await this.refreshPositionSnapshot(managed, false);
    return [...managed.positions.values()].map((position) => structuredClone(position));
  }

  async updatePositionAutomation(
    connectionId: string,
    context: TradeContext,
    walletName: string,
    automation: PositionAutomationPolicy
  ): Promise<void> {
    const managed = this.requireSocket(connectionId);
    await this.requestRaw(managed.socket, "updatePositionAutomation", {
      chain: context.chain,
      token: context.address,
      wallet_name: walletName,
      automation: {
        creator_sell: automation.creatorSell,
        migration_sell: automation.migrationSell,
        wallet_trade_sell: automation.walletTradeSell,
        ...(automation.creatorSellSettings ? {
          creator_sell_settings: {
            enabled: automation.creatorSellSettings.enabled,
            minimum_percentage: automation.creatorSellSettings.minimumPercentage,
            sell_percentage: automation.creatorSellSettings.sellPercentage
          }
        } : {})
      }
    });
  }

  async getPositionAutosellPresets(connectionId: string): Promise<AutosellPresetNames> {
    const managed = this.requireSocket(connectionId);
    const response = await this.requestRaw<{ presets?: Partial<AutosellPresetNames> }>(
      managed.socket,
      "getPositionAutosellPresets",
      {}
    );
    return {
      tpsl: Array.isArray(response.presets?.tpsl) ? response.presets.tpsl : [],
      sl: Array.isArray(response.presets?.sl) ? response.presets.sl : [],
      tsl: Array.isArray(response.presets?.tsl) ? response.presets.tsl : []
    };
  }

  async updatePositionAutosell(
    connectionId: string,
    context: TradeContext,
    walletName: string,
    settings: PositionAutosellSettings
  ): Promise<void> {
    const managed = this.requireSocket(connectionId);
    await this.requestRaw(managed.socket, "updatePositionAutosell", {
      chain: context.chain,
      token: context.address,
      wallet_name: walletName,
      settings
    });
  }

  async getCustomTradeLauncher(connectionId: string): Promise<CustomTradeLauncherState> {
    const selected = this.requireSocket(connectionId);
    const controller = this.walletControllerFor(connectionId, selected);
    const [presetResponse, configResponse, runtimeResponse] = await Promise.all([
      this.requestLegacyRaw<{ presets?: Array<{ id?: unknown; name?: unknown; module?: unknown }> }>(
        controller.socket,
        "getAllPresets",
        {}
      ),
      this.requestLegacyRaw<{ files?: Array<{
        key?: unknown;
        data?: unknown;
        wallet_public_addresses?: Record<string, unknown>;
      }> }>(controller.socket, "get_config_files", {}),
      this.requestRaw<{ runtimes?: CustomTradeRuntimeStatus[] }>(
        controller.socket,
        "getCustomTradeRuntimes",
        {}
      )
    ]);
    const presets = (presetResponse.presets ?? []).flatMap((preset) =>
      typeof preset.id === "string" && typeof preset.name === "string" && typeof preset.module === "string"
        ? [{ id: preset.id, name: preset.name, module: preset.module }]
        : []
    );
    const files = configResponse.files ?? [];
    const definitions: Array<{ chain: SharpChain; module: string; walletKey: string }> = [
      { chain: "solana", module: "sol_custom_trade", walletKey: "solana_wallets" },
      { chain: "bsc", module: "bsc_custom_trade", walletKey: "bsc_wallets" },
      { chain: "base", module: "base_custom_trade", walletKey: "base_wallets" },
      { chain: "robinhood", module: "robinhood_custom_trade", walletKey: "robinhood_wallets" }
    ];
    return {
      controllerId: connectionId,
      chains: definitions.map((definition) => {
        const walletFile = files.find((file) => file.key === definition.walletKey);
        const publicWallets = Object.keys(walletFile?.wallet_public_addresses ?? {}).filter(Boolean);
        const maskedData = walletFile?.data;
        const maskedWallets = !maskedData || typeof maskedData !== "object" || Array.isArray(maskedData)
          ? []
          : Object.entries(maskedData as Record<string, unknown>).flatMap(([name, entry]) => {
              if (!name.trim() || name.startsWith("example_") || !entry || typeof entry !== "object") return [];
              const privateKey = (entry as { private_key?: unknown }).private_key;
              if (typeof privateKey !== "string" || !privateKey.trim()) return [];
              const value = privateKey.trim();
              return value === "__SHARP_SECRET_PRESENT__"
                || /^(?:0x)?[a-fA-F0-9]{64}$/.test(value)
                || value.startsWith("sharpenc:v1:")
                ? [name]
                : [];
            });
        const wallets = publicWallets.length ? publicWallets : maskedWallets;
        const runtime = (runtimeResponse.runtimes ?? []).find((item) => item.chain === definition.chain);
        return {
          chain: definition.chain,
          module: definition.module,
          presets: presets.filter((preset) => preset.module === definition.module),
          wallets,
          ...(runtime ? { runtime } : {})
        };
      })
    };
  }

  async startCustomTradeRuntime(
    connectionId: string,
    chain: SharpChain,
    presetId: string,
    wallet: string,
    paperTrade: boolean
  ): Promise<void> {
    const selected = this.requireSocket(connectionId);
    const controller = this.walletControllerFor(connectionId, selected);
    await this.requestRaw(controller.socket, "startCustomTradeRuntime", {
      chain,
      preset_id: presetId,
      wallet,
      paper_trade: paperTrade
    }, 25_000);
  }

  async getManagedWallets(connectionId: string, includeBalances = false): Promise<ManagedWalletState> {
    const selected = this.requireSocket(connectionId);
    const chain = selected.state.capabilities?.chain;
    if (chain && chain !== "solana") {
      type EvmWalletResponse = {
        chain?: unknown;
        symbol?: unknown;
        wallets?: Array<{ name?: unknown; address?: unknown; native?: unknown }>;
      };
      let response: EvmWalletResponse;
      if (includeBalances) {
        try {
          response = await this.requestRaw<EvmWalletResponse>(
            selected.socket,
            "getManagedEvmWallets",
            {},
            requestTimeoutMs
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("Unsupported Sharp Dev Mode operation")) throw error;
          try {
            response = await this.requestRaw<EvmWalletResponse>(
              selected.socket,
              "getManagedEvmWalletInventory",
              {},
              walletInventoryTimeoutMs
            );
          } catch (inventoryError) {
            const inventoryMessage = inventoryError instanceof Error ? inventoryError.message : String(inventoryError);
            const activeWallet = selected.state.capabilities?.wallet;
            if (!inventoryMessage.includes("Unsupported Sharp Dev Mode operation") || !activeWallet?.address) {
              throw inventoryError;
            }
            response = {
              chain,
              symbol: chain === "bsc" ? "BNB" : "ETH",
              wallets: [{
                name: activeWallet.label || "Active wallet",
                address: activeWallet.address
              }]
            };
          }
        }
      } else {
        response = await this.requestRaw<EvmWalletResponse>(
          selected.socket,
          "getManagedEvmWalletInventory",
          {},
          walletInventoryTimeoutMs
        );
      }
      const wallets = (response.wallets ?? []).flatMap((wallet) => {
        if (typeof wallet.name !== "string" || typeof wallet.address !== "string") return [];
        const balance = Number(wallet.native);
        return [{
          name: wallet.name,
          address: wallet.address,
          ...(wallet.native !== null && wallet.native !== undefined && Number.isFinite(balance) ? { balance } : {})
        }];
      });
      return {
        clientId: connectionId,
        chain,
        nativeSymbol: typeof response.symbol === "string" ? response.symbol : chain === "bsc" ? "BNB" : "ETH",
        wallets,
        groups: []
      };
    }
    const managed = this.walletControllerFor(connectionId, selected);
    const response = await this.requestRaw<{
      wallets?: Array<{ name?: unknown; address?: unknown; sol?: unknown; wsol?: unknown; nonce_accounts?: unknown }>;
      config?: {
        groups?: Array<{
          id?: unknown;
          name?: unknown;
          wallets?: unknown;
          creator_sell?: unknown;
          creator_sell_wallets?: unknown;
          autosell?: unknown;
          autosell_wallets?: unknown;
        }>;
      };
      lookupTables?: {
        selected_tables?: unknown;
        tables?: unknown;
      };
    }>(
      managed.socket,
      includeBalances ? "getManagedSolanaWallets" : "getManagedSolanaWalletInventory",
      {},
      includeBalances ? requestTimeoutMs : walletInventoryTimeoutMs
    );
    const wallets = (response.wallets ?? []).flatMap((wallet) => {
      if (typeof wallet.name !== "string" || typeof wallet.address !== "string") return [];
      const balance = Number(wallet.sol);
      const wrapped = Number(wallet.wsol);
      const nonceAccounts = Array.isArray(wallet.nonce_accounts)
        ? (wallet.nonce_accounts as unknown[])
            .filter((account): account is string => typeof account === "string")
        : [];
      return [{
        name: wallet.name,
        address: wallet.address,
        ...(wallet.sol !== null && wallet.sol !== undefined && Number.isFinite(balance) ? { balance } : {}),
        ...(wallet.wsol !== null && wallet.wsol !== undefined && Number.isFinite(wrapped) ? { wrappedBalance: wrapped } : {}),
        ...(nonceAccounts.length ? { nonceAccounts } : {})
      }];
    });
    const known = new Set(wallets.map((wallet) => wallet.name));
    const groups = (response.config?.groups ?? []).flatMap((group) => {
      if (typeof group.id !== "string" || typeof group.name !== "string" || !Array.isArray(group.wallets)) return [];
      const groupWallets = group.wallets.filter(
        (wallet): wallet is string => typeof wallet === "string" && known.has(wallet)
      );
      const rawCreatorSell = group.creator_sell;
      const creator = typeof rawCreatorSell === "object" && rawCreatorSell !== null
        ? rawCreatorSell as Record<string, unknown>
        : undefined;
      const minimumPercentage = Number(creator?.minimum_percentage);
      const sellPercentage = Number(creator?.sell_percentage);
      const creatorSell = creator
        && typeof creator.enabled === "boolean"
        && Number.isFinite(minimumPercentage)
        && Number.isFinite(sellPercentage)
        ? { enabled: creator.enabled, minimumPercentage, sellPercentage }
        : undefined;
      const creatorSellWallets = Array.isArray(group.creator_sell_wallets)
        ? group.creator_sell_wallets.filter(
            (wallet): wallet is string => typeof wallet === "string" && groupWallets.includes(wallet)
          )
        : undefined;
      const rawAutosell = typeof group.autosell === "object" && group.autosell !== null
        ? group.autosell as Record<string, unknown>
        : undefined;
      const autosell = rawAutosell
        && typeof rawAutosell.tpsl === "string"
        && typeof rawAutosell.sl === "string"
        && typeof rawAutosell.tsl === "string"
        ? { tpsl: rawAutosell.tpsl, sl: rawAutosell.sl, tsl: rawAutosell.tsl }
        : undefined;
      const autosellWallets = Array.isArray(group.autosell_wallets)
        ? group.autosell_wallets.filter(
            (wallet): wallet is string => typeof wallet === "string" && groupWallets.includes(wallet)
          )
        : undefined;
      return groupWallets.length ? [{
        id: group.id,
        name: group.name,
        wallets: groupWallets,
        ...(creatorSell ? { creatorSell } : {}),
        ...(creatorSellWallets ? { creatorSellWallets } : {}),
        ...(autosell ? { autosell } : {}),
        ...(autosellWallets ? { autosellWallets } : {})
      }] : [];
    });
    const selectedTables = new Set(
      Array.isArray(response.lookupTables?.selected_tables)
        ? response.lookupTables.selected_tables.filter((address): address is string => typeof address === "string")
        : []
    );
    const tableEntries = response.lookupTables?.tables;
    const lookupTables = tableEntries && typeof tableEntries === "object" && !Array.isArray(tableEntries)
      ? Object.entries(tableEntries as Record<string, unknown>).flatMap(([address, entry]) => {
          if (!entry || typeof entry !== "object") return [];
          const authorityWallet = (entry as { authority_wallet?: unknown }).authority_wallet;
          return typeof authorityWallet === "string"
            ? [{ address, authorityWallet, selected: selectedTables.has(address) }]
            : [];
        })
      : [];
    return { clientId: connectionId, chain: "solana", nativeSymbol: "SOL", wallets, groups, ...(includeBalances ? { lookupTables } : {}) };
  }

  async getExecutionFeeDefaults(connectionId: string): Promise<ExecutionFeeDefaults> {
    const managed = this.requireSocket(connectionId);
    const response = await this.requestRaw<{ chain?: unknown; priority_fee_gwei?: unknown }>(
      managed.socket,
      "getExecutionFeeDefaults",
      {}
    );
    const priorityFeeGwei = Number(response.priority_fee_gwei);
    return {
      chain: typeof response.chain === "string"
        ? response.chain
        : managed.state.capabilities?.chain ?? "",
      ...(Number.isFinite(priorityFeeGwei) && priorityFeeGwei > 0
        ? { priorityFeeGwei }
        : {})
    };
  }

  async getActiveWalletBalance(connectionId: string): Promise<ActiveWalletBalance> {
    const managed = this.requireSocket(connectionId);
    const chain = managed.state.capabilities?.chain;
    const wallet = managed.state.capabilities?.wallet;
    if (!chain || !wallet?.address) {
      throw new Error("The selected client has no active wallet");
    }
    const response = await this.requestRaw<Record<string, unknown>>(
      managed.socket,
      "getBalances",
      {},
      walletInventoryTimeoutMs
    );
    const symbol = chain === "solana" ? "SOL" : chain === "bsc" ? "BNB" : "ETH";
    const balance = Number(response[symbol]);
    if (!Number.isFinite(balance) || balance < 0) {
      throw new Error("Sharp has not cached the active wallet balance yet");
    }
    return {
      address: wallet.address,
      ...(wallet.label ? { name: wallet.label } : {}),
      balance,
      ...(chain === "solana" && Number.isFinite(Number(response.WSOL_RENT_FREE ?? response.WSOL))
        ? { wrappedBalance: Number(response.WSOL_RENT_FREE ?? response.WSOL) }
        : {})
    };
  }

  async createManagedWallet(connectionId: string, name: string): Promise<ManagedWalletState> {
    const selected = this.requireSocket(connectionId);
    if (selected.state.capabilities?.chain !== "solana") {
      const chain = selected.state.capabilities?.chain;
      try {
        await this.requestRaw(selected.socket, "createManagedEvmWallet", { name, chain });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const controller = connectionId.startsWith("local-")
          ? this.walletControllerFor(connectionId, selected)
          : selected;
        if (!message.includes("Unsupported Sharp Dev Mode operation") || controller === selected) throw error;
        await this.requestRaw(controller.socket, "createManagedEvmWallet", { name, chain });
      }
      return this.getManagedWallets(connectionId);
    }
    const managed = this.walletControllerFor(connectionId, selected);
    await this.requestRaw(managed.socket, "createManagedSolanaWallet", { name });
    return this.getManagedWallets(connectionId);
  }

  async renameManagedWallet(connectionId: string, oldName: string, name: string): Promise<ManagedWalletState> {
    const selected = this.requireSocket(connectionId);
    if (selected.state.capabilities?.chain !== "solana") {
      throw new Error("Renaming is currently available for Solana wallets");
    }
    const managed = this.walletControllerFor(connectionId, selected);
    await this.requestRaw(managed.socket, "renameManagedSolanaWallet", { old_name: oldName, name });
    return this.getManagedWallets(connectionId);
  }

  async createManagedWalletNonce(
    connectionId: string,
    walletName: string,
    batchIndex = 1,
    batchTotal = 1
  ): Promise<ManagedWalletState> {
    const selected = this.requireSocket(connectionId);
    if (selected.state.capabilities?.chain !== "solana") {
      throw new Error("Durable nonce accounts are available for Solana wallets only");
    }
    const managed = this.walletControllerFor(connectionId, selected);
    await this.requestRaw(
      managed.socket,
      "createNonceAccount",
      { wallet_name: walletName, client_id: 0, batch_index: batchIndex, batch_total: batchTotal },
      90_000
    );
    return this.getManagedWallets(connectionId, true);
  }

  async updateManagedWalletGroups(
    connectionId: string,
    groups: ManagedWalletGroup[]
  ): Promise<ManagedWalletState> {
    const selected = this.requireSocket(connectionId);
    if (selected.state.capabilities?.chain !== "solana") {
      throw new Error("Managed wallet groups are currently available for Solana clients only");
    }
    const managed = this.walletControllerFor(connectionId, selected);
    await this.requestRaw(managed.socket, "saveManagedSolanaWalletGroups", {
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        wallets: group.wallets,
        ...(group.creatorSell ? {
          creator_sell: {
            enabled: group.creatorSell.enabled,
            minimum_percentage: group.creatorSell.minimumPercentage,
            sell_percentage: group.creatorSell.sellPercentage
          }
        } : {}),
        ...(group.creatorSellWallets ? { creator_sell_wallets: group.creatorSellWallets } : {}),
        ...(group.autosell ? { autosell: group.autosell } : {}),
        ...(group.autosellWallets ? { autosell_wallets: group.autosellWallets } : {})
      }))
    });
    return this.getManagedWallets(connectionId, true);
  }

  async createManagedLookupTable(connectionId: string, authorityWallet: string): Promise<ManagedWalletState> {
    const selected = this.requireSocket(connectionId);
    if (selected.state.capabilities?.chain !== "solana") {
      throw new Error("Lookup tables are available for Solana clients only");
    }
    const managed = this.walletControllerFor(connectionId, selected);
    await this.requestRaw(managed.socket, "createManagedLookupTable", { authorityWallet }, 90_000);
    return this.getManagedWallets(connectionId, true);
  }

  async updateManagedLookupTables(connectionId: string, selectedTables: string[]): Promise<ManagedWalletState> {
    const selected = this.requireSocket(connectionId);
    if (selected.state.capabilities?.chain !== "solana") {
      throw new Error("Lookup tables are available for Solana clients only");
    }
    const inventory = await this.getManagedWallets(connectionId, true);
    const tables = Object.fromEntries((inventory.lookupTables ?? []).map((table) => [
      table.address,
      { authority_wallet: table.authorityWallet }
    ]));
    const known = new Set(Object.keys(tables));
    const normalized = [...new Set(selectedTables.filter((address) => known.has(address)))];
    const managed = this.walletControllerFor(connectionId, selected);
    await this.requestRaw(managed.socket, "saveManagedLookupTables", {
      config: { version: 1, selected_tables: normalized, tables }
    });
    return this.getManagedWallets(connectionId, true);
  }

  async getMigrationSell(connectionId: string): Promise<MigrationSellSettings> {
    const managed = this.requireSocket(connectionId);
    const response = await this.requestRaw<{ preset?: Array<{ name?: string; value?: unknown }> }>(
      managed.socket,
      "getPreset",
      {}
    );
    const presetFields = new Map((response.preset ?? []).map((field) => [field.name, field.value]));
    const raw = response.preset?.find((field) => field.name === "sell_on_migration")?.value;
    const parsed = (() => {
      if (typeof raw !== "string") return raw;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
    })();
    const value = typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
    const number = (input: unknown, fallback: number) => {
      const parsedNumber = Number(input);
      return Number.isFinite(parsedNumber) ? parsedNumber : fallback;
    };
    const enabled = value.enabled === true || String(value.enabled).toLowerCase() === "true";
    const rawExecution = presetFields.get("custom_migration_settings");
    const parsedExecution = (() => {
      if (typeof rawExecution !== "string") return rawExecution;
      try { return JSON.parse(rawExecution) as unknown; } catch { return undefined; }
    })();
    const execution = typeof parsedExecution === "object" && parsedExecution !== null
      ? parsedExecution as Record<string, unknown>
      : {};
    const executionSenders = ([
      ["rpc", "normal_tx_amount"],
      ["jito", "jito_tx_amount"],
      ["nextblock", "nextblock_tx_amount"],
      ["temporal", "temporal_tx_amount"],
      ["bloxroute", "bloxroute_tx_amount"],
      ["zeroslot", "slot_tx_amount"],
      ["astralane", "astralane_tx_amount"],
      ["blockrazor", "blockrazor_tx_amount"],
      ["hellomoon", "hellomoon_tx_amount"],
      ["helius", "helius_tx_amount"],
      ["stellium", "stellium_tx_amount"],
      ["soyas", "soyas_tx_amount"],
      ["blocksprint", "blocksprint_tx_amount"],
      ["falcon", "falcon_tx_amount"]
    ] as const).filter(([, field]) => number(execution[field], 0) > 0).map(([sender]) => sender);
    const executionTip = [
      "jito_tip_amount", "nextblock_tip_amount", "temporal_tip_amount",
      "bloxroute_tip_amount", "slot_tip_amount", "astralane_tip_amount",
      "blockrazor_tip_amount", "hellomoon_tip_amount", "helius_tip_amount",
      "stellium_tip_amount", "soyas_tip_amount", "blocksprint_tip_amount",
      "falcon_tip_amount"
    ].map((field) => number(execution[field], 0)).find((tip) => tip > 0);
    const executionPriorityFee = number(execution.priority_fee, 0);
    return {
      enabled,
      percentage: number(value.percent, 100),
      delayMs: number(value.delay, 0),
      execution: {
        enabled: execution.enabled === true || String(execution.enabled).toLowerCase() === "true",
        senders: executionSenders,
        ...(executionPriorityFee > 0 ? { priorityFee: executionPriorityFee } : {}),
        ...(executionTip === undefined ? {} : { tip: executionTip })
      }
    };
  }

  async updateMigrationSell(
    connectionId: string,
    settings: MigrationSellSettings
  ): Promise<void> {
    const managed = this.requireSocket(connectionId);
    if (
      !Number.isFinite(settings.percentage)
      || settings.percentage <= 0
      || settings.percentage > 100
      || !Number.isFinite(settings.delayMs)
      || settings.delayMs < 0
    ) throw new Error("Migration sell percentage must be between 0 and 100 and delay cannot be negative");
    if (settings.execution && (
      (settings.execution.priorityFee !== undefined && (!Number.isFinite(settings.execution.priorityFee) || settings.execution.priorityFee < 0))
      || (settings.execution.tip !== undefined && (!Number.isFinite(settings.execution.tip) || settings.execution.tip < 0))
    )) throw new Error("Migration Sell fee overrides must be zero or greater");
    const execution = settings.execution;
    const solanaExecution = managed.state.capabilities?.chain === "solana";
    const selected = new Set(solanaExecution
      ? execution?.senders ?? []
      : execution?.enabled ? ["rpc" as SolanaSender] : []);
    const relayTip = solanaExecution ? execution?.tip ?? 0 : 0;
    await this.requestRaw(managed.socket, "updatePreset", {
      preset: [{
        name: "sell_on_migration",
        value: {
          enabled: settings.enabled,
          percent: settings.percentage,
          delay: settings.delayMs
        }
      }, {
        name: "custom_migration_settings",
        value: {
          enabled: execution?.enabled ?? false,
          priority_fee: execution?.priorityFee ?? 0,
          normal_tx_amount: selected.has("rpc") ? 1 : 0,
          jito_tx_amount: selected.has("jito") ? 1 : 0,
          jito_tip_amount: selected.has("jito") ? relayTip : 0,
          nextblock_tx_amount: selected.has("nextblock") ? 1 : 0,
          nextblock_tip_amount: selected.has("nextblock") ? relayTip : 0,
          temporal_tx_amount: selected.has("temporal") ? 1 : 0,
          temporal_tip_amount: selected.has("temporal") ? relayTip : 0,
          bloxroute_tx_amount: selected.has("bloxroute") ? 1 : 0,
          bloxroute_tip_amount: selected.has("bloxroute") ? relayTip : 0,
          slot_tx_amount: selected.has("zeroslot") ? 1 : 0,
          slot_tip_amount: selected.has("zeroslot") ? relayTip : 0,
          astralane_tx_amount: selected.has("astralane") ? 1 : 0,
          astralane_tip_amount: selected.has("astralane") ? relayTip : 0,
          blockrazor_tx_amount: selected.has("blockrazor") ? 1 : 0,
          blockrazor_tip_amount: selected.has("blockrazor") ? relayTip : 0,
          hellomoon_tx_amount: selected.has("hellomoon") ? 1 : 0,
          hellomoon_tip_amount: selected.has("hellomoon") ? relayTip : 0,
          helius_tx_amount: selected.has("helius") ? 1 : 0,
          helius_tip_amount: selected.has("helius") ? relayTip : 0,
          stellium_tx_amount: selected.has("stellium") ? 1 : 0,
          stellium_tip_amount: selected.has("stellium") ? relayTip : 0,
          soyas_tx_amount: selected.has("soyas") ? 1 : 0,
          soyas_tip_amount: selected.has("soyas") ? relayTip : 0,
          blocksprint_tx_amount: selected.has("blocksprint") ? 1 : 0,
          blocksprint_tip_amount: selected.has("blocksprint") ? relayTip : 0,
          falcon_tx_amount: selected.has("falcon") ? 1 : 0,
          falcon_tip_amount: selected.has("falcon") ? relayTip : 0
        }
      }]
    });
  }

  async getWalletTradeSellTriggers(connectionId: string): Promise<WalletTradeSellTrigger[]> {
    const managed = this.requireSocket(connectionId);
    const response = await this.requestRaw<{ triggers?: Array<{
      id: string;
      enabled: boolean;
      chain?: SharpChain;
      wallet: string;
      token: string;
      event: "buy" | "sell" | "both";
      minimum_sell_percentage?: number;
      sell_percentage: number;
      execution?: { senders?: SolanaSender[]; priority_fee?: number; tip?: number };
    }> }>(managed.socket, "getWalletTradeSellTriggers", {});
    return (response.triggers ?? []).map((trigger) => ({
      id: trigger.id,
      enabled: trigger.enabled,
      chain: trigger.chain ?? managed.state.capabilities?.chain ?? "solana",
      wallet: trigger.wallet,
      token: trigger.token,
      event: trigger.event,
      ...(trigger.minimum_sell_percentage === undefined
        ? {}
        : { minimumSellPercentage: trigger.minimum_sell_percentage }),
      sellPercentage: trigger.sell_percentage,
      ...(trigger.execution ? {
        execution: {
          enabled: true,
          senders: trigger.execution.senders ?? [],
          ...(trigger.execution.priority_fee === undefined ? {} : { priorityFee: trigger.execution.priority_fee }),
          ...(trigger.execution.tip === undefined ? {} : { tip: trigger.execution.tip })
        }
      } : {})
    }));
  }

  async updateWalletTradeSellTriggers(
    connectionId: string,
    triggers: WalletTradeSellTrigger[]
  ): Promise<void> {
    const managed = this.requireSocket(connectionId);
    await this.requestRaw(managed.socket, "saveWalletTradeSellTriggers", {
      triggers: triggers.map((trigger) => ({
        id: trigger.id,
        enabled: trigger.enabled,
        chain: trigger.chain,
        wallet: trigger.wallet,
        token: trigger.token,
        event: trigger.event,
        minimum_sell_percentage: trigger.minimumSellPercentage ?? 0,
        sell_percentage: trigger.sellPercentage,
        ...(trigger.execution?.enabled ? {
          execution: {
            senders: trigger.execution.senders,
            priority_fee: trigger.execution.priorityFee,
            tip: trigger.execution.tip
          }
        } : {})
      }))
    });
  }

  async createTask(
    connectionId: string,
    taskType: AutomationTaskType,
    target: string,
    amount?: number,
    match: "exact" | "contains" = "exact",
    lifecycle: AutomationLifecycle = "both",
    options: AutomationTaskOptions = {},
    arm = false
  ): Promise<void> {
    const managed = this.requireSocket(connectionId);
    const task = buildAutomationTask(taskType, target, amount, match, lifecycle, options);
    const created = await this.requestRaw<{ task: SnipeTaskSummary }>(managed.socket, "createSnipeTask", { task });
    if (arm) await this.requestRaw(managed.socket, "armSnipeTask", { id: created.task.id });
  }

  async taskAction(connectionId: string, action: "arm" | "pause" | "delete", taskId: string): Promise<void> {
    const managed = this.requireSocket(connectionId);
    const event = action === "arm" ? "armSnipeTask" : action === "pause" ? "pauseSnipeTask" : "deleteSnipeTask";
    await this.requestRaw(managed.socket, event, { id: taskId });
  }

  async getCreatorSell(connectionId: string): Promise<CreatorSellSettings> {
    const managed = this.requireSocket(connectionId);
    const response = await this.requestRaw<{ preset?: Array<{ name?: string; value?: unknown }> }>(
      managed.socket,
      "getPreset",
      {}
    );
    const fields = new Map((response.preset ?? []).map((field) => [field.name, field.value]));
    const numberValue = (name: string, fallback: number) => {
      const value = Number(fields.get(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const enabled = String(fields.get("sell_if_creator_sells") ?? "false").toLowerCase();
    const executionEnabled = String(fields.get("creator_sell_execution_override") ?? "false").toLowerCase();
    const senderValue = fields.get("creator_sell_execution_senders");
    const parsedSenders = Array.isArray(senderValue)
      ? senderValue
      : typeof senderValue === "string"
        ? (() => {
            try {
              const parsed = JSON.parse(senderValue);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })()
        : [];
    const allowed = new Set<string>([
      "rpc", "jito", "nextblock", "temporal", "bloxroute", "zeroslot",
      "astralane", "blockrazor", "hellomoon", "helius", "stellium",
      "soyas", "blocksprint", "falcon"
    ]);
    const optionalNumber = (name: string) => {
      const raw = fields.get(name);
      if (raw === undefined || raw === null || raw === "") return undefined;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const priorityFee = optionalNumber("creator_sell_priority_fee");
    const tip = optionalNumber("creator_sell_relay_tip");
    return {
      enabled: enabled === "true" || enabled === "yes",
      minimumPercentage: numberValue("minimum_creator_sell_percentage", 0),
      sellPercentage: numberValue("creator_sell_percentage", 100),
      execution: {
        enabled: executionEnabled === "true" || executionEnabled === "yes",
        senders: parsedSenders.filter(
          (sender): sender is SolanaSender => typeof sender === "string" && allowed.has(sender)
        ),
        ...(priorityFee === undefined ? {} : { priorityFee }),
        ...(tip === undefined ? {} : { tip })
      }
    };
  }

  async getPresetExecution(connectionId: string): Promise<PresetExecutionState> {
    const managed = this.requireSocket(connectionId);
    const [response, presetResponse] = await Promise.all([
      this.requestRaw<{ preset_senders?: unknown[] }>(
        managed.socket,
        "getSnipeSpamReadiness",
        {}
      ),
      this.requestRaw<{ preset?: Array<{ name?: string; value?: unknown }> }>(
        managed.socket,
        "getPreset",
        {}
      )
    ]);
    const allowed = new Set<string>([
      "rpc", "jito", "nextblock", "temporal", "bloxroute", "zeroslot",
      "astralane", "blockrazor", "hellomoon", "helius", "stellium",
      "soyas", "blocksprint", "falcon"
    ]);
    const buyAmount = Number(
      (presetResponse.preset ?? []).find((field) => field.name === "amount_to_swap")?.value
    );
    return {
      clientId: connectionId,
      clientName: managed.state.capabilities?.client_name || connectionId,
      senders: (response.preset_senders ?? []).filter(
        (sender): sender is SolanaSender => typeof sender === "string" && allowed.has(sender)
      ),
      ...(Number.isFinite(buyAmount) && buyAmount > 0 ? { buyAmount } : {})
    };
  }

  async updateCreatorSell(connectionId: string, settings: CreatorSellSettings): Promise<void> {
    const managed = this.requireSocket(connectionId);
    if (
      !Number.isFinite(settings.minimumPercentage)
      || !Number.isFinite(settings.sellPercentage)
      || settings.minimumPercentage < 0
      || settings.minimumPercentage > 100
      || settings.sellPercentage <= 0
      || settings.sellPercentage > 100
    ) throw new Error("Creator sell percentages must be between 0 and 100");
    if (settings.execution) {
      if (
        (settings.execution.priorityFee !== undefined && (!Number.isFinite(settings.execution.priorityFee) || settings.execution.priorityFee < 0))
        || (settings.execution.tip !== undefined && (!Number.isFinite(settings.execution.tip) || settings.execution.tip < 0))
      ) throw new Error("Creator sell fee overrides must be zero or greater");
    }
    const preset: Array<{ name: string; value: unknown }> = [
        { name: "sell_if_creator_sells", value: settings.enabled },
        { name: "minimum_creator_sell_percentage", value: settings.minimumPercentage },
        { name: "creator_sell_percentage", value: settings.sellPercentage }
    ];
    if (settings.execution) {
      preset.push(
        { name: "creator_sell_execution_override", value: settings.execution.enabled },
        { name: "creator_sell_execution_senders", value: settings.execution.senders },
        { name: "creator_sell_priority_fee", value: settings.execution.priorityFee ?? null },
        { name: "creator_sell_relay_tip", value: settings.execution.tip ?? null }
      );
    }
    await this.requestRaw(managed.socket, "updatePreset", { preset });
  }

  async updateDevList(
    connectionId: string,
    creator: string,
    mode: "whitelist" | "blacklist",
    file: string
  ): Promise<void> {
    const managed = this.requireSocket(connectionId);
    await this.requestRaw(managed.socket, "addSnipeFilterEntry", {
      target: "creator",
      mode,
      entry: creator,
      file
    });
    const response = await this.requestRaw<{
      preset?: Array<{ name?: string; value?: unknown }>;
    }>(managed.socket, "getPreset", {});
    const raw = response.preset?.find((field) => field.name === "dev_filters")?.value;
    const filters = mergeDevList(raw, creator, mode);
    await this.requestRaw(managed.socket, "updatePreset", {
      preset: [{
        name: "dev_filters",
        value: filters
      }]
    });
  }

  async listDevWordlists(connectionId: string): Promise<DevWordlist[]> {
    const managed = this.requireSocket(connectionId);
    const response = await this.requestRaw<{
      files?: Array<{ name?: unknown; mode?: unknown; target?: unknown; entries?: unknown }>;
    }>(managed.socket, "listSnipeFilterFiles", {});
    const lists = (response.files ?? []).flatMap((file): DevWordlist[] => {
      if (
        typeof file.name !== "string"
        || (file.mode !== "whitelist" && file.mode !== "blacklist")
        || file.target !== "creator"
      ) return [];
      return [{
        name: file.name,
        mode: file.mode,
        entries: Array.isArray(file.entries)
          ? file.entries.filter((entry): entry is string => typeof entry === "string")
          : []
      }];
    });
    for (const mode of ["blacklist", "whitelist"] as const) {
      const name = `dev_${mode}.txt`;
      if (!lists.some((list) => list.name === name)) {
        lists.push({ name, mode, entries: [] });
      }
    }
    return lists.sort((left, right) =>
      left.mode.localeCompare(right.mode) || left.name.localeCompare(right.name)
    );
  }

  async listWalletWordlists(connectionId: string): Promise<WalletWordlist[]> {
    const selected = this.requireSocket(connectionId);
    const managed = this.walletControllerFor(connectionId, selected);
    const response = await this.requestRaw<{
      files?: Array<{ name?: unknown; target?: unknown; entries?: unknown }>;
    }>(managed.socket, "listSnipeFilterFiles", {});
    const lists = (response.files ?? []).flatMap((file): WalletWordlist[] => {
      if (typeof file.name !== "string" || file.target !== "transaction_account") return [];
      return [{
        name: file.name,
        entries: Array.isArray(file.entries)
          ? file.entries.filter((entry): entry is string => typeof entry === "string")
          : []
      }];
    });
    if (!lists.some((list) => list.name === "wallet_watchlist.txt")) {
      lists.push({ name: "wallet_watchlist.txt", entries: [] });
    }
    return lists.sort((left, right) => left.name.localeCompare(right.name));
  }

  async appendWalletWordlist(
    connectionId: string,
    wallet: string,
    chain: SharpChain,
    file: string
  ): Promise<void> {
    const selected = this.requireSocket(connectionId);
    const managed = this.walletControllerFor(connectionId, selected);
    await this.requestRaw(managed.socket, "addSnipeFilterEntry", {
      target: "transaction_account",
      mode: "whitelist",
      entry: wallet,
      chain,
      file
    });
  }

  private async ensureConnection(connection: StoredConnection): Promise<void> {
    const existing = this.sockets.get(connection.id);
    if (existing && existing.connection.endpoint === connection.endpoint) {
      if (!existing.socket.connected && !existing.socket.active) existing.socket.connect();
      else if (existing.socket.connected && existing.state.authenticated) {
        this.requestCapabilities(existing);
        await this.refreshPositionSnapshot(existing, true);
      }
      return;
    }
    existing?.socket.disconnect();
    const socket = io(connection.endpoint, {
      transports: ["websocket"],
      secure: connection.endpoint.startsWith("https://"),
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 750,
      reconnectionDelayMax: 5_000,
      timeout: 10_000
    });
    const managed: ManagedSocket = {
      connection,
      socket,
      prewarmed: new Map(),
      prewarmPending: new Map(),
      activeLeaseTargets: new Map(),
      positions: new Map(),
      state: {
        endpointId: connection.id,
        endpoint: connection.endpoint,
        connected: false,
        authenticated: false
      }
    };
    this.sockets.set(connection.id, managed);

    socket.on("connect", () => {
      managed.state.connected = true;
      delete managed.state.error;
      socket.emit("authenticationReq", {
        dev_mode: true,
        extension: true,
        external_buy: false,
        client_name: "Sharp Browser Extension",
        client_version: browser.runtime.getManifest().version,
        buy_enabled: true,
        client_ip: connection.clientIp,
        discord_user_id: connection.discordUserId,
        api_key: connection.apiKey,
        local_connection: !connection.remote
      });
      this.onChange();
    });
    socket.on("authenticationResp", (response: { status?: string; message?: string }) => {
      managed.state.authenticated = response.status === "success";
      if (response.status === "success") delete managed.state.error;
      else managed.state.error = response.message || "Authentication failed";
      if (managed.state.authenticated) {
        this.requestCapabilities(managed);
        void this.refreshPositionSnapshot(managed, true);
      }
      this.onChange();
    });
    socket.on("devModeResponse", (envelope: {
      request_id?: unknown;
      operation?: string;
      status?: string;
      data?: unknown;
      message?: string;
      runtime_id?: unknown;
    }) => {
      if (envelope.operation !== "capabilities") return;
      if (!acceptsCapabilityResponse(connection.id, managed.capabilitiesRequestId, envelope)) return;
      const parsed = capabilitiesSchema.safeParse(envelope.data);
      if (parsed.success) {
        delete managed.capabilitiesRequestId;
        if (managed.capabilitiesFallbackTimer !== undefined) {
          clearTimeout(managed.capabilitiesFallbackTimer);
          delete managed.capabilitiesFallbackTimer;
        }
        managed.state.capabilities = parsed.data as SharpCapabilities;
        delete managed.state.error;
      } else {
        managed.state.error = "Sharp client returned an incompatible capability response";
      }
      this.onChange();
    });
    const acceptLegacyCapabilities = (payload: unknown) => {
      if (!managed.capabilitiesRequestId) return;
      const parsed = capabilitiesSchema.safeParse(payload);
      if (!parsed.success) {
        managed.state.error = "Sharp client returned an incompatible capability response";
        this.onChange();
        return;
      }
      delete managed.capabilitiesRequestId;
      if (managed.capabilitiesFallbackTimer !== undefined) {
        clearTimeout(managed.capabilitiesFallbackTimer);
        delete managed.capabilitiesFallbackTimer;
      }
      managed.state.capabilities = parsed.data as SharpCapabilities;
      delete managed.state.error;
      this.onChange();
    };
    socket.on("getDevModeCapabilitiesV1Resp", acceptLegacyCapabilities);
    socket.on("getExtensionCapabilitiesV1Resp", acceptLegacyCapabilities);
    for (const event of ["newToken", "newPosition"]) {
      socket.on(event, (position: SharpPosition) => {
        this.ingestNewPosition(managed, position);
      });
    }
    for (const event of ["updatedToken", "updatedPosition"]) {
      socket.on(event, (payload: Record<string, unknown>) => {
        this.applyPositionPayload(managed, payload, false);
      });
    }
    for (const event of ["deletedToken", "deletedPosition"]) {
      socket.on(event, (payload: Record<string, unknown>) => {
        this.applyPositionPayload(managed, payload, true);
      });
    }
    socket.on("disconnect", () => {
      managed.state.connected = false;
      managed.state.authenticated = false;
      delete managed.capabilitiesRequestId;
      if (managed.capabilitiesFallbackTimer !== undefined) {
        clearTimeout(managed.capabilitiesFallbackTimer);
        delete managed.capabilitiesFallbackTimer;
      }
      managed.prewarmed.clear();
      managed.prewarmPending.clear();
      if (managed.positionSnapshotTimer !== undefined) {
        clearTimeout(managed.positionSnapshotTimer);
        delete managed.positionSnapshotTimer;
      }
      managed.positionSnapshotQueued = false;
      this.onChange();
    });
    socket.on("connect_error", (error: SocketTransportError) => {
      managed.state.connected = false;
      managed.state.authenticated = false;
      managed.state.error = socketConnectionErrorMessage(error);
      this.onChange();
    });
  }

  private requestCapabilities(managed: ManagedSocket): void {
    if (!managed.socket.connected || !managed.state.authenticated) return;
    const requestId = `capabilities:${managed.connection.id}:${crypto.randomUUID()}`;
    managed.capabilitiesRequestId = requestId;
    if (managed.capabilitiesFallbackTimer !== undefined) {
      clearTimeout(managed.capabilitiesFallbackTimer);
    }
    managed.state.error = "Connected and authenticated; waiting for Sharp capabilities";
    managed.socket.emit("devModeRequest", {
      request_id: requestId,
      operation: "capabilities",
      data: {}
    });
    managed.capabilitiesFallbackTimer = setTimeout(() => {
      delete managed.capabilitiesFallbackTimer;
      if (!managed.socket.connected || !managed.state.authenticated || !managed.capabilitiesRequestId) return;
      managed.state.error = "Connected to an older Sharp client; trying compatibility mode";
      this.onChange();
      managed.socket.emit("getDevModeCapabilitiesV1", {});
      managed.socket.emit("getExtensionCapabilitiesV1", {});
    }, 1_500);
  }

  private requireSocket(connectionId: string): ManagedSocket {
    const managed = this.sockets.get(connectionId);
    if (!managed?.socket.connected || !managed.state.authenticated) {
      throw new Error("Sharp client is disconnected");
    }
    return managed;
  }

  private walletControllerFor(connectionId: string, selected: ManagedSocket): ManagedSocket {
    if (!connectionId.startsWith("local-")) return selected;

    const controller = this.sockets.get("local-8686");
    if (!controller?.socket.connected || !controller.state.connected || !controller.state.authenticated) {
      throw new Error("Sharp wallet controller is still connecting");
    }
    return controller;
  }

  private ingestNewPosition(managed: ManagedSocket, position: SharpPosition): void {
    const key = positionId(position);
    if (!key) return;

    // newToken can carry stale wallet metadata; publish only the canonical getInitialData snapshot.
    managed.positions.set(key, position);
    this.schedulePositionSnapshotRefresh(managed);
  }

  private schedulePositionSnapshotRefresh(managed: ManagedSocket): void {
    managed.positionSnapshotQueued = true;
    if (managed.positionSnapshotTimer !== undefined || managed.positionSnapshotInFlight) return;
    managed.positionSnapshotTimer = setTimeout(() => {
      delete managed.positionSnapshotTimer;
      void this.refreshPositionSnapshot(managed, true);
    }, 50);
  }

  private async refreshPositionSnapshot(managed: ManagedSocket, emit: boolean): Promise<void> {
    if (managed.positionSnapshotInFlight) {
      if (emit) managed.positionSnapshotQueued = true;
      await managed.positionSnapshotInFlight;
      return;
    }

    managed.positionSnapshotQueued = false;
    const refresh = (async () => {
      try {
        const response = await this.requestRaw<{ tokens?: SharpPosition[] }>(
          managed.socket,
          "getInitialData",
          { clientEndpointId: managed.connection.id }
        );
        const next = new Map<string, SharpPosition>();
        for (const position of response.tokens ?? []) {
          const key = positionId(position);
          if (key) next.set(key, position);
        }
        managed.positions = next;
        if (emit) this.emitPositions(managed);
      } catch {
        // Retain the last stream state until a canonical snapshot succeeds.
      }
    })();
    managed.positionSnapshotInFlight = refresh;
    try {
      await refresh;
    } finally {
      delete managed.positionSnapshotInFlight;
      if (managed.positionSnapshotQueued) this.schedulePositionSnapshotRefresh(managed);
    }
  }

  private emitPositions(managed: ManagedSocket): void {
    this.onPositionsChange(
      managed.connection.id,
      [...managed.positions.values()].map((position) => structuredClone(position))
    );
  }

  private applyPositionPayload(
    managed: ManagedSocket,
    payload: Record<string, unknown>,
    remove: boolean
  ): void {
    const updates = Array.isArray(payload.tokenUpdates)
      ? payload.tokenUpdates.filter(
          (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null
        )
      : [payload];
    let changed = false;
    for (const update of updates) {
      const id = typeof update.id === "string" ? update.id : undefined;
      const tokenId = typeof update.tokenID === "string" ? update.tokenID : undefined;
      const byTokenId = update.byTokenID === true || payload.byTokenID === true;
      if (remove) {
        if (id) changed = managed.positions.delete(id) || changed;
        continue;
      }
      const values = typeof update.values === "object" && update.values !== null
        ? update.values as Record<string, unknown>
        : update;
      for (const [key, position] of managed.positions) {
        // Exact IDs prevent one wallet update from overwriting positions that share a mint.
        const matches = id !== undefined
          ? id === key
          : tokenId !== undefined && position.tokenID === tokenId;
        if (matches) {
          const nextValues = { ...values } as Record<string, unknown>;
          if (
            byTokenId
            && typeof values.additionalData === "object"
            && values.additionalData !== null
          ) {
            const currentAdditional = position.additionalData ?? {};
            const nextAdditional: Record<string, unknown> = {
              ...currentAdditional,
              ...values.additionalData as Record<string, unknown>
            };
            // Token-wide updates must preserve per-position ownership and automation fields.
            for (const field of [
              "execution_wallet",
              "execution_wallet_address",
              "automation_policy",
              "position_original_quote",
              "position_group_id",
              "position_group_original_quote",
              "position_group_wallet_basis"
            ]) {
              if (field in currentAdditional) nextAdditional[field] = currentAdditional[field];
              else delete nextAdditional[field];
            }
            nextValues.additionalData = nextAdditional;
          }
          managed.positions.set(key, { ...position, ...nextValues });
          changed = true;
        }
      }
    }
    if (changed) this.emitPositions(managed);
  }

  private requestRaw<T = Record<string, unknown>>(
    socket: Socket,
    event: string,
    payload: object,
    timeoutMs = requestTimeoutMs
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const operation = devModeOperation(event);
      const requestId = crypto.randomUUID();
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("devModeResponse", onResponse);
        socket.off("disconnect", onDisconnect);
      };
      const onResponse = (response: {
        request_id?: string;
        operation?: string;
        type?: string;
        status?: string;
        data?: T;
        message?: string;
        error_code?: string;
      }) => {
        if (response.request_id !== requestId || response.operation !== operation) return;
        cleanup();
        if (isFailedDevModeResponse(response)) {
          reject(new Error(devModeResponseMessage(response, `${event} failed`)));
          return;
        }
        resolve((response.data ?? response) as T);
      };
      const onDisconnect = () => {
        cleanup();
        reject(new Error(`Sharp connection closed while waiting for ${event}`));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${event}`));
      }, timeoutMs);
      socket.on("devModeResponse", onResponse);
      socket.on("disconnect", onDisconnect);
      socket.emit("devModeRequest", {
        request_id: requestId,
        operation,
        data: payload
      });
    });
  }

  private requestLegacyRaw<T>(
    socket: Socket,
    event: string,
    payload: object,
    timeoutMs = requestTimeoutMs
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const successEvent = `${event}Resp`;
      const errorEvents = [`${event}RespError`, `${event}RespNoModule`];
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off(successEvent, onSuccess);
        for (const errorEvent of errorEvents) socket.off(errorEvent, onError);
        socket.off("disconnect", onDisconnect);
      };
      const onSuccess = (response: T) => {
        cleanup();
        resolve(response);
      };
      const onError = (response: { message?: string; error?: string } | string) => {
        cleanup();
        reject(new Error(typeof response === "string"
          ? response
          : response.message || response.error || `${event} failed`));
      };
      const onDisconnect = () => {
        cleanup();
        reject(new Error("Sharp client disconnected during the request"));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Sharp ${event} request timed out`));
      }, timeoutMs);
      socket.once(successEvent, onSuccess);
      for (const errorEvent of errorEvents) socket.once(errorEvent, onError);
      socket.once("disconnect", onDisconnect);
      socket.emit(event, payload);
    });
  }

  private request(
    socket: Socket,
    event: string,
    payload: object,
    requestId: string
  ): Promise<{ ok: boolean; timeout?: boolean; message: string; errorCode?: string; transactionTimeoutMs?: number }> {
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("devModeResponse", onResponse);
        socket.off("disconnect", onDisconnect);
      };
      const onResponse = (envelope: {
        request_id?: string;
        operation?: string;
        type?: string;
        status?: string;
        message?: string;
        error_code?: string;
        data?: {
          message?: string;
          error?: string | { message?: string };
          error_code?: string;
          transaction_timeout_ms?: number;
        };
      }) => {
        if (envelope.request_id !== requestId || envelope.operation !== event) return;
        cleanup();
        const response: { message?: string; error_code?: string; transaction_timeout_ms?: number } =
          envelope.data ?? envelope;
        if (isFailedDevModeResponse(envelope)) {
          resolve({
            ok: false,
            message: devModeResponseMessage(envelope, "Sharp rejected the command"),
            ...((response.error_code ?? envelope.error_code)
              ? { errorCode: response.error_code ?? envelope.error_code }
              : {})
          });
          return;
        }
        const transactionTimeoutMs = Number.isFinite(response.transaction_timeout_ms)
          ? response.transaction_timeout_ms
          : undefined;
        resolve({
          ok: true,
          message: response.message || "Accepted by Sharp",
          ...(transactionTimeoutMs === undefined ? {} : { transactionTimeoutMs })
        });
      };
      const onDisconnect = () => {
        cleanup();
        resolve({
          ok: false,
          message: "Sharp connection was interrupted before the command was acknowledged"
        });
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve({ ok: false, timeout: true, message: "Timed out waiting for Sharp" });
      }, requestTimeoutMs);
      socket.on("devModeResponse", onResponse);
      socket.on("disconnect", onDisconnect);
      socket.emit("devModeRequest", {
        request_id: requestId,
        operation: event,
        data: payload
      });
    });
  }
}
