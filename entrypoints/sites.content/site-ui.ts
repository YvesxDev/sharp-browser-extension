import type {
  AutomationLifecycle,
  CreatorSellSettings,
  DevWordlist,
  ExtensionSnapshot,
  ManagedWalletGroup,
  ManagedWalletState,
  MigrationSellSettings,
  AutosellPresetNames,
  PositionAutomationPolicy,
  PositionAutosellSettings,
  RuntimeRequest,
  RuntimeResponse,
  SharpChain,
  SharpPosition,
  SnipeTaskSummary,
  SolanaSender,
  TradeContext,
  TradeResult,
  WalletExecutionPlan,
  WalletTradeSellTrigger,
  WalletWordlist
} from "../../src/protocol";
import { solanaSenders } from "../../src/protocol";
import { aggregatePositionMetrics } from "../../src/position-metrics";
import {
  positionExecutionWallet,
  positionId,
  positionIsOpen,
  positionMatchesAsset
} from "../../src/position-identity";
import { reconcileWalletPlan } from "../../src/wallet-routing";

const defaultPositionAutomation = (): PositionAutomationPolicy => ({
  creatorSell: true,
  migrationSell: true,
  walletTradeSell: true
});

const defaultPositionAutosell = (): PositionAutosellSettings => ({
  tpsl: "PRESET",
  sl: "PRESET",
  tsl: "PRESET"
});

export type SharpToastKind = "success" | "error" | "info";

export interface SharpToastController {
  show(kind: SharpToastKind, title: string, message: string): void;
  pending(title: string, message: string): {
    settle(kind: "success" | "error", title: string, message: string): void;
    dismiss(): void;
  };
  destroy(): void;
}

export function summarizeSellResults(results: TradeResult[]): {
  kind: SharpToastKind;
  title: string;
  message: string;
} {
  const hardFailures = results.filter((result) => result.status !== "accepted");
  const walletFailures = results.filter((result) => result.walletResult?.failedWallets.length);
  const partial = hardFailures.length > 0 || walletFailures.length > 0;
  const allFailed = results.length > 0 && hardFailures.length === results.length;
  const details = results.map((result) => {
    const notes: string[] = [];
    const failedWallets = result.walletResult?.failedWallets ?? [];
    if (failedWallets.length && !failedWallets.every((wallet) => result.message.includes(wallet))) {
      notes.push(`Failed wallets: ${failedWallets.join(", ")}`);
    }
    const exhaustedWallets = result.walletResult?.exhaustedWallets ?? [];
    if (exhaustedWallets.length) notes.push(`No remaining position: ${exhaustedWallets.join(", ")}`);
    return `${result.clientName}: ${result.message}${notes.length ? `\n${notes.join(" · ")}` : ""}`;
  });
  return {
    kind: partial ? "error" : "success",
    title: allFailed ? "Sell failed" : partial ? "Sell partially failed" : "Sell confirmed",
    message: details.join("\n")
  };
}

export function createSharpToasts(): SharpToastController {
  const host = document.createElement("div");
  host.dataset.sharpToastPortal = "";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = toastStyles;
  const stack = document.createElement("div");
  stack.className = "stack";
  stack.setAttribute("aria-live", "polite");
  shadow.append(style, stack);
  document.documentElement.append(host);

  const createToast = (
    kind: SharpToastKind | "pending",
    title: string,
    message: string,
    autoDismiss: boolean
  ) => {
      const signature = JSON.stringify([kind, title, message]);
      const duplicate = [...stack.children].find(
        (item) => item instanceof HTMLElement && item.dataset.signature === signature
      );
      if (duplicate instanceof HTMLElement) {
        stack.prepend(duplicate);
        return duplicate;
      }
      const toast = document.createElement("div");
      toast.className = `toast ${kind}`;
      toast.dataset.signature = signature;
      const marker = document.createElement("span");
      marker.className = "marker";
      marker.textContent = kind === "success" ? "✓" : kind === "error" ? "!" : kind === "pending" ? "" : "i";
      const copy = document.createElement("div");
      copy.className = "toast-copy";
      const heading = document.createElement("strong");
      heading.textContent = title;
      const detail = document.createElement("span");
      detail.className = "toast-detail";
      detail.textContent = message;
      copy.append(heading, detail);
      const close = document.createElement("button");
      close.type = "button";
      close.setAttribute("aria-label", "Dismiss notification");
      close.textContent = "×";
      close.onclick = () => toast.remove();
      toast.append(marker, copy, close);
      stack.prepend(toast);
      while (stack.children.length > 5) stack.lastElementChild?.remove();
      if (autoDismiss) {
        window.setTimeout(() => {
          toast.classList.add("leaving");
          window.setTimeout(() => toast.remove(), 180);
        }, kind === "error" ? 7_000 : 4_500);
      }
      return toast;
  };
  return {
    show(kind, title, message) {
      createToast(kind, title, message, true);
    },
    pending(title, message) {
      const toast = createToast("pending", title, message, false);
      return {
        settle(kind, nextTitle, nextMessage) {
          if (!toast.isConnected) return;
          toast.className = `toast ${kind}`;
          toast.dataset.signature = JSON.stringify([kind, nextTitle, nextMessage]);
          const marker = toast.querySelector<HTMLElement>(".marker");
          const heading = toast.querySelector<HTMLElement>("strong");
          const detail = toast.querySelector<HTMLElement>(".toast-detail");
          if (marker) marker.textContent = kind === "success" ? "✓" : "!";
          if (heading) heading.textContent = nextTitle;
          if (detail) detail.textContent = nextMessage;
          window.setTimeout(() => {
            toast.classList.add("leaving");
            window.setTimeout(() => toast.remove(), 180);
          }, kind === "error" ? 7_000 : 4_500);
        },
        dismiss() {
          toast.remove();
        }
      };
    },
    destroy() {
      host.remove();
    }
  };
}

interface AutomationPanelOptions {
  request(message: RuntimeRequest): Promise<RuntimeResponse>;
  toasts: SharpToastController;
  loadPosition?: () => Promise<{ x: number; y: number } | undefined>;
  savePosition?: (position: { x: number; y: number }) => Promise<void> | void;
  loadOpen?: () => Promise<boolean | undefined>;
  saveOpen?: (open: boolean) => Promise<void> | void;
  loadTransparency?: () => Promise<{ enabled: boolean; opacity: number } | undefined>;
  saveTransparency?: (appearance: { enabled: boolean; opacity: number }) => Promise<void> | void;
}

export interface SharpAutomationPanel {
  update(snapshot: ExtensionSnapshot, context?: TradeContext): void;
  updatePositions(clientId: string, positions: SharpPosition[]): void;
  destroy(): void;
}

type AutomationTab = "trade" | "migration" | "dev-buy" | "dev-sell" | "sell-auto" | "position-autosell";
type SnipeDraftKind = "dev" | "ticker" | "spam";
const senderLabels: Record<SolanaSender, string> = {
  rpc: "RPC",
  jito: "Jito",
  nextblock: "NextBlock",
  temporal: "Temporal",
  bloxroute: "Bloxroute",
  zeroslot: "0Slot",
  astralane: "Astralane",
  blockrazor: "BlockRazor",
  hellomoon: "HelloMoon",
  helius: "Helius",
  stellium: "Stellium",
  soyas: "Soyas",
  blocksprint: "BlockSprint",
  falcon: "Falcon"
};

interface SnipeDraft {
  id: string;
  kind: SnipeDraftKind;
  label: string;
  target: string;
  ticker: string;
  match: "exact" | "contains";
  lifecycle: AutomationLifecycle;
  amount: string;
  priorityFee: string;
  tip: string;
  slippage: string;
  startDelaySeconds: string;
  transactionsPerSecond: string;
  stopAfterSeconds: string;
  maxTotalFeesSol: string;
  stopOnPoolOpen: boolean;
  stopAfterPoolOpenSeconds: string;
  transferEnabled: boolean;
  transferWallet: string;
  transferPercentage: string;
}

export function createSharpAutomationPanel({
  request,
  toasts,
  loadPosition,
  savePosition,
  loadOpen,
  saveOpen,
  loadTransparency,
  saveTransparency
}: AutomationPanelOptions): SharpAutomationPanel {
  const host = document.createElement("div");
  host.dataset.sharpAutomationPortal = "";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = automationStyles;
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "launcher";
  launcher.setAttribute("aria-label", "Open Sharp automations");
  launcher.innerHTML = '<span>SHARP</span><small aria-hidden="true"></small>';
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.hidden = Boolean(loadOpen);
  launcher.hidden = true;
  shadow.append(style, launcher, panel);
  document.documentElement.append(host);

  let snapshot: ExtensionSnapshot | undefined;
  let context: TradeContext | undefined;
  let activeTab: AutomationTab = "trade";
  let migrationSubtab: "sell" | "buy" = "sell";
  let selectedClientId = "";
  let pendingClientSelection = "";
  let creatorSell: CreatorSellSettings | undefined;
  let creatorSellClientId = "";
  let creatorSellSaveTimer: number | undefined;
  let creatorSellSaveRevision = 0;
  let autosellPresets: AutosellPresetNames = { tpsl: [], sl: [], tsl: [] };
  let autosellPresetsClientId = "";
  let autosellPresetsLoading = false;
  let selectedAutosellGroupId = "";
  let autosellControlFocused = false;
  let tasks: SnipeTaskSummary[] = [];
  let tasksClientId = "";
  let tasksLoading = false;
  let devLists: DevWordlist[] = [];
  let devListsClientId = "";
  let devListsLoading = false;
  let selectedDevList = "dev_blacklist.txt";
  let selectedWalletWordlist = "";
  let walletWordlists: WalletWordlist[] = [];
  let walletWordlistsClientId = "";
  let walletWordlistsLoading = false;
  let walletSellAddresses = "";
  let walletAddressPromptOpen = false;
  let walletAddressPromptDraft = "";
  let selectedCreatorSellGroupId = "";
  const creatorSellWalletSelectionByGroup = new Map<string, Set<string>>();
  let creatorSellWalletScopeOpen = false;
  let busy = false;
  let panelPosition: { x: number; y: number } | undefined;
  let positionMovedByUser = false;
  let activeDragCleanup: (() => void) | undefined;
  let lastUpdateKey = "";
  let renderAfterDrag = false;
  let firstUpdate = true;
  let snipeDrafts: SnipeDraft[] = [];
  let migrationAmount = "";
  let migrationCustomExecution = false;
  let migrationPriorityFee = "";
  let migrationTip = "";
  let migrationSenders: SolanaSender[] = [];
  let migrationDeveloperOpen = false;
  let migrationWatchesOpen = false;
  let expandedPanelWidth = 360;
  let suppressLauncherClick = false;
  const positionsByClient = new Map<string, SharpPosition[]>();
  let tradeQuickEditing = false;
  let tradeQuickChain: SharpChain = "solana";
  let tradeQuickAmounts: string[] = [];
  let tradeSellQuickEditing = false;
  let tradeSellQuickChain: SharpChain = "solana";
  let tradeSellQuickPercentages: string[] = [];
  let tradeSellPercentage = "100";
  let migrationSell: MigrationSellSettings | undefined;
  let migrationSellClientId = "";
  let walletTradeSellTriggers: WalletTradeSellTrigger[] = [];
  let walletTradeSellTriggersClientId = "";
  let migrationSellPercentage = "100";
  let migrationSellDelay = "0";
  let tradeStateLoading = false;
  const managedWalletsByClient = new Map<string, ManagedWalletState>();
  const localSellWalletPlansByClient = new Map<string, WalletExecutionPlan>();
  let managedWalletsLoadingClientId = "";
  let managedWalletBalancesLoadingClientId = "";
  const walletRoutingOpen = { buy: false, sell: false };
  const anyWalletRoutingOpen = () => walletRoutingOpen.buy || walletRoutingOpen.sell;
  let panelTransparent = false;
  let panelOpacity = 1;
  let appearanceMenuOpen = false;
  let sellAutomationPopout: HTMLDetailsElement | undefined;
  let walletFlyoutContent: HTMLElement | undefined;
  let walletFlyoutSummary: HTMLElement | undefined;

  const normalizePanelOpacity = (value: number) =>
    Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1)) * 100) / 100;

  const applyPanelAppearance = () => {
    panel.classList.toggle("transparent", panelTransparent);
    panel.style.setProperty("--sharp-panel-opacity", String(panelOpacity));
  };

  const persistPanelAppearance = () => {
    if (!saveTransparency) return;
    void Promise.resolve(saveTransparency({
      enabled: panelTransparent,
      opacity: panelOpacity
    })).catch(() => undefined);
  };

  const handleAppearanceOutsideClick = (event: MouseEvent) => {
    if (!appearanceMenuOpen) return;
    const insideAppearanceControls = event.composedPath().some((target) =>
      target instanceof Element
      && (target.classList.contains("appearance") || target.classList.contains("appearance-menu"))
    );
    if (insideAppearanceControls) return;
    appearanceMenuOpen = false;
    render();
  };

  document.addEventListener("click", handleAppearanceOutsideClick);

  const handleWalletOutsideClick = (event: MouseEvent) => {
    if (!anyWalletRoutingOpen()) return;
    const insideWalletControls = event.composedPath().some((target) =>
      target instanceof Element
      && (target.classList.contains("managed-wallets") || target.classList.contains("managed-wallet-content"))
    );
    if (insideWalletControls) return;
    walletRoutingOpen.buy = false;
    walletRoutingOpen.sell = false;
    render();
  };

  document.addEventListener("click", handleWalletOutsideClick);

  applyPanelAppearance();
  if (loadTransparency) {
    void loadTransparency().then((appearance) => {
      if (!appearance) return;
      panelTransparent = appearance.enabled;
      panelOpacity = normalizePanelOpacity(appearance.opacity);
      applyPanelAppearance();
      if (!panel.hidden) render();
    }).catch(() => undefined);
  }

  const newSnipeDraft = (kind: SnipeDraftKind): SnipeDraft => ({
    id: crypto.randomUUID(),
    kind,
    label: "",
    target: "",
    ticker: "",
    match: "exact",
    lifecycle: "both",
    amount: "",
    priorityFee: "",
    tip: "",
    slippage: "",
    startDelaySeconds: "0",
    transactionsPerSecond: "10",
    stopAfterSeconds: "20",
    maxTotalFeesSol: "0.05",
    stopOnPoolOpen: true,
    stopAfterPoolOpenSeconds: "0",
    transferEnabled: false,
    transferWallet: "",
    transferPercentage: "100"
  });

  const updateKey = (nextSnapshot: ExtensionSnapshot, nextContext?: TradeContext) =>
    JSON.stringify({
      enabled: nextSnapshot.enabled,
      site: nextContext?.site,
      chain: nextContext?.chain,
      address: nextContext?.address,
      creator: nextContext?.creator,
      creatorStatus: nextContext?.creatorStatus,
      creatorError: nextContext?.creatorError,
      siteEnabled: nextContext?.site ? nextSnapshot.siteEnabled[nextContext.site] : false,
      compatibilityDisabled: nextContext?.site
        ? nextSnapshot.compatibilityDisabledSites.includes(nextContext.site)
        : false,
      preferredClients: nextSnapshot.selectedClientIdsByChain,
      automationExecution: nextSnapshot.automationExecution,
      clients: nextSnapshot.clients
        .map((client) => ({
          endpointId: client.endpointId,
          connected: client.connected,
          authenticated: client.authenticated,
          name: client.capabilities?.client_name,
          module: client.capabilities?.module,
          chain: client.capabilities?.chain,
          paperTrade: client.capabilities?.paper_trade,
          features: client.capabilities?.features
        }))
    });

  const clampPosition = (position: { x: number; y: number }) => {
    const rect = host.getBoundingClientRect();
    const renderedPanelWidth = panel.offsetWidth;
    if (renderedPanelWidth > 0) expandedPanelWidth = renderedPanelWidth;
    const width = panel.hidden
      ? launcher.offsetWidth || rect.width || 88
      : renderedPanelWidth || rect.width || expandedPanelWidth;
    const height = panel.hidden
      ? launcher.offsetHeight || rect.height || 36
      : panel.offsetHeight || rect.height;
    return {
      x: Math.min(Math.max(8, window.innerWidth - width - 8), Math.max(8, position.x)),
      y: Math.min(Math.max(8, window.innerHeight - height - 8), Math.max(8, position.y))
    };
  };

  const positionSellAutomationPopout = () => {
    const section = sellAutomationPopout;
    if (!section?.open) return;
    const panelRect = panel.getBoundingClientRect();
    const width = Math.max(160, Math.min(270, window.innerWidth - 16));
    const left = Math.max(8, panelRect.left - width + 1);
    const preferredTop = panelRect.top + 88;
    const maxTop = Math.max(8, window.innerHeight - Math.min(section.scrollHeight, window.innerHeight - 16) - 8);
    section.style.setProperty("--sharp-automations-width", `${width}px`);
    section.style.left = `${left}px`;
    section.style.top = `${Math.max(8, Math.min(preferredTop, maxTop))}px`;
    section.style.maxHeight = `${Math.max(160, window.innerHeight - 16)}px`;
  };

  const positionWalletFlyout = () => {
    const content = walletFlyoutContent;
    const summary = walletFlyoutSummary;
    if (!anyWalletRoutingOpen() || !content || !summary?.isConnected) return;
    const rect = summary.getBoundingClientRect();
    const width = Math.max(180, Math.min(248, window.innerWidth - 16));
    content.style.width = `${width}px`;
    content.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    content.style.top = `${rect.bottom + 6}px`;
    content.style.maxHeight = `${Math.max(150, window.innerHeight - rect.bottom - 16)}px`;
  };

  const positionTradeStatsBreakdown = (breakdown: HTMLElement, anchor: HTMLElement) => {
    const panelRect = panel.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const panelWidth = panelRect.width || 360;
    const width = Math.min(
      window.innerWidth - 16,
      Math.max(280, Math.min(440, panelWidth * .78))
    );
    const gap = 6;
    const fitsLeft = panelRect.left >= width + gap + 8;
    const left = fitsLeft
      ? panelRect.left - width - gap
      : Math.min(window.innerWidth - width - 8, panelRect.right + gap);
    breakdown.dataset.side = fitsLeft ? "left" : "right";
    breakdown.style.width = `${width}px`;
    breakdown.style.left = `${Math.max(8, left)}px`;
    breakdown.style.right = "auto";
    breakdown.style.bottom = "auto";
    breakdown.style.visibility = "hidden";
    breakdown.style.display = "flex";
    const height = breakdown.getBoundingClientRect().height;
    const top = Math.max(8, Math.min(anchorRect.bottom - height, window.innerHeight - height - 8));
    breakdown.style.top = `${top}px`;
    breakdown.style.removeProperty("display");
    breakdown.style.removeProperty("visibility");
  };

  const applyPosition = (position: { x: number; y: number }) => {
    panelPosition = clampPosition(position);
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.left = `${panelPosition.x}px`;
    host.style.top = `${panelPosition.y}px`;
    positionSellAutomationPopout();
    positionWalletFlyout();
  };

  const normalizePosition = () => {
    const rect = host.getBoundingClientRect();
    applyPosition(panelPosition ?? { x: rect.left, y: rect.top });
  };

  const handleViewportResize = () => {
    if (panelPosition) applyPosition(panelPosition);
    else {
      positionSellAutomationPopout();
      positionWalletFlyout();
    }
  };
  window.addEventListener("resize", handleViewportResize);

  if (loadPosition) {
    void loadPosition()
      .then((position) => {
        if (position && !positionMovedByUser) applyPosition(position);
      })
      .catch(() => undefined);
  }

  if (loadOpen) {
    void loadOpen()
      .then((open) => {
        const shouldOpen = open ?? true;
        panel.hidden = !shouldOpen;
        launcher.hidden = shouldOpen;
        if (shouldOpen) {
          render();
          requestAnimationFrame(normalizePosition);
        }
      })
      .catch(() => {
        panel.hidden = false;
        launcher.hidden = true;
        render();
        requestAnimationFrame(normalizePosition);
      });
  }

  const connectedClients = (chain: SharpChain) =>
    snapshot?.clients.filter((client) =>
      client.connected &&
      client.authenticated &&
      client.capabilities?.chain === chain &&
      client.capabilities.module !== "unknown"
    ) ?? [];

  const connectedSolanaClients = () => connectedClients("solana");

  const chainLabel = (chain: SharpChain) => ({
    solana: "Solana",
    bsc: "BSC",
    base: "Base",
    robinhood: "Robinhood"
  }[chain]);

  const nativeSymbol = (chain: SharpChain) => ({
    solana: "SOL",
    bsc: "BNB",
    base: "ETH",
    robinhood: "ETH"
  }[chain]);

  const taskClients = () =>
    connectedSolanaClients().filter((client) => client.capabilities?.features.snipe_tasks);

  const availableClients = () => {
    if (activeTab === "trade" || activeTab === "sell-auto" || activeTab === "position-autosell") {
      return context
        ? connectedClients(context.chain).filter((client) =>
            client.capabilities?.features.buy || client.capabilities?.features.sell
          )
        : [];
    }
    return activeTab === "dev-sell" ? connectedSolanaClients() : taskClients();
  };

  const selectedClient = () => {
    const available = availableClients();
    const selected = available.find((client) => client.endpointId === selectedClientId);
    if (selected) return selected;
    const preferredChain = activeTab === "trade" || activeTab === "sell-auto" || activeTab === "position-autosell" ? context?.chain : "solana";
    const preferredIds = preferredChain
      ? snapshot?.selectedClientIdsByChain[preferredChain] ?? []
      : [];
    return available.find((client) => preferredIds.includes(client.endpointId)) ?? available[0];
  };

  const ensureSelectedClient = () => {
    const selected = selectedClient();
    selectedClientId = selected?.endpointId ?? "";
    return selected;
  };

  const persistClientSelection = async (chain: SharpChain, clientId: string) => {
    if (!snapshot || !clientId) return;
    const key = `${chain}:${clientId}`;
    if (pendingClientSelection === key) return;
    pendingClientSelection = key;
    try {
      const response = await request({
        type: "sharp:update-settings",
        patch: {
          selectedClientIdsByChain: {
            ...snapshot.selectedClientIdsByChain,
            [chain]: [clientId]
          }
        }
      });
      if (response.ok && response.snapshot) snapshot = response.snapshot;
    } finally {
      if (pendingClientSelection === key) pendingClientSelection = "";
    }
  };

  const showResponse = (
    response: RuntimeResponse,
    successTitle: string,
    successMessage: string
  ) => {
    if (response.ok) {
      toasts.show("success", successTitle, successMessage);
    } else {
      const subject = successTitle.replace(/\s+(started|updated)$/i, "");
      toasts.show("error", `${subject} failed`, response.error);
    }
  };

  const loadTasks = async (force = false) => {
    const client = ensureSelectedClient();
    if (!client || activeTab === "dev-sell" || activeTab === "trade") {
      tasks = [];
      tasksClientId = "";
      return;
    }
    if (!force && (tasksLoading || tasksClientId === client.endpointId)) return;
    tasksLoading = true;
    tasksClientId = client.endpointId;
    render();
    try {
      const response = await request({ type: "sharp:list-tasks", clientId: client.endpointId });
      if (tasksClientId !== client.endpointId) return;
      if (response.ok) {
        tasks = response.tasks ?? [];
      } else {
        tasksClientId = "";
        toasts.show("error", "Tasks unavailable", response.error);
      }
    } catch (error) {
      tasksClientId = "";
      toasts.show("error", "Tasks unavailable", error instanceof Error ? error.message : "The extension request failed.");
    } finally {
      tasksLoading = false;
      render();
    }
  };

  const loadDevLists = async (force = false) => {
    const client = ensureSelectedClient();
    if (!client || (!force && (devListsLoading || devListsClientId === client.endpointId))) return;
    devListsLoading = true;
    devListsClientId = client.endpointId;
    try {
      const response = await request({ type: "sharp:list-dev-lists", clientId: client.endpointId });
      if (devListsClientId !== client.endpointId) return;
      if (response.ok) {
        devLists = response.devLists ?? [];
        if (!devLists.some((list) => list.name === selectedDevList)) {
          selectedDevList = devLists.find((list) => list.mode === "blacklist")?.name
            ?? devLists[0]?.name
            ?? "dev_blacklist.txt";
        }
      } else {
        devListsClientId = "";
      }
    } finally {
      devListsLoading = false;
      render();
    }
  };

  const loadWalletLists = async (force = false) => {
    const client = ensureSelectedClient();
    if (!client || (!force && (walletWordlistsLoading || walletWordlistsClientId === client.endpointId))) return;
    walletWordlistsLoading = true;
    walletWordlistsClientId = client.endpointId;
    try {
      const response = await request({ type: "sharp:list-wallet-lists", clientId: client.endpointId });
      if (walletWordlistsClientId !== client.endpointId) return;
      if (response.ok) {
        walletWordlists = response.walletLists ?? [];
        if (!walletWordlists.some((list) => list.name === selectedWalletWordlist)) {
          selectedWalletWordlist = walletWordlists[0]?.name ?? "wallet_watchlist.txt";
        }
      } else {
        walletWordlistsClientId = "";
        toasts.show("error", "Wallet lists unavailable", response.error);
      }
    } catch (error) {
      walletWordlistsClientId = "";
      toasts.show("error", "Wallet lists unavailable", error instanceof Error ? error.message : "The extension request failed.");
    } finally {
      walletWordlistsLoading = false;
      render();
    }
  };

  const loadTradeState = async (force = false) => {
    const client = ensureSelectedClient();
    if (!client || (activeTab !== "trade" && activeTab !== "sell-auto" && activeTab !== "migration" && activeTab !== "position-autosell")) return;
    const includesCreatorSell = context?.chain === "solana";
    const positionClients = context
      ? connectedClients(context.chain).filter((candidate) => candidate.capabilities?.features.sell)
      : [];
    const positionsLoaded = positionClients.every((candidate) =>
      positionsByClient.has(candidate.endpointId)
    );
    if (
      !force
      && (tradeStateLoading || (
        positionsLoaded
        && walletTradeSellTriggersClientId === client.endpointId
        && migrationSellClientId === client.endpointId
        && (!includesCreatorSell || creatorSellClientId === client.endpointId)
      ))
    ) return;
    tradeStateLoading = true;
    render();
    try {
      const positionResponses = await Promise.all(positionClients.map(async (positionClient) => {
        try {
          return {
            clientId: positionClient.endpointId,
            response: await request({
              type: "sharp:get-positions",
              clientId: positionClient.endpointId
            })
          };
        } catch (error) {
          return {
            clientId: positionClient.endpointId,
            response: {
              ok: false as const,
              error: error instanceof Error ? error.message : "Failed to load positions"
            }
          };
        }
      }));
      if (selectedClientId !== client.endpointId || (activeTab !== "trade" && activeTab !== "sell-auto" && activeTab !== "migration" && activeTab !== "position-autosell")) return;
      for (const { clientId, response } of positionResponses) {
        if (response.ok) positionsByClient.set(clientId, response.positions ?? []);
        else if (clientId === client.endpointId) {
          toasts.show("error", "Positions unavailable", response.error);
        }
      }
      const walletTradePromise = request({ type: "sharp:get-wallet-trade-sell-triggers", clientId: client.endpointId });
      const [migrationResponse, creatorResponse, walletTradeResponse] = await Promise.all([
            request({ type: "sharp:get-migration-sell", clientId: client.endpointId }),
            includesCreatorSell
              ? request({ type: "sharp:get-creator-sell", clientId: client.endpointId })
              : Promise.resolve(undefined),
            walletTradePromise
          ]);
      if (selectedClientId !== client.endpointId || (activeTab !== "trade" && activeTab !== "sell-auto" && activeTab !== "migration" && activeTab !== "position-autosell")) return;
      if (migrationResponse?.ok && migrationResponse.migrationSell) {
        migrationSell = migrationResponse.migrationSell;
        migrationSellClientId = client.endpointId;
        migrationSellPercentage = String(migrationSell.percentage);
        migrationSellDelay = String(migrationSell.delayMs);
      } else if (migrationResponse && !migrationResponse.ok) {
        toasts.show("error", "Migration Sell unavailable", migrationResponse.error);
      }
      if (creatorResponse?.ok && creatorResponse.creatorSell) {
        creatorSell = creatorResponse.creatorSell;
        creatorSellClientId = client.endpointId;
      } else if (creatorResponse && !creatorResponse.ok) {
        toasts.show("error", "Dev Sell unavailable", creatorResponse.error);
      }
      if (walletTradeResponse.ok) {
        walletTradeSellTriggers = walletTradeResponse.walletTradeSellTriggers ?? [];
        walletTradeSellTriggersClientId = client.endpointId;
      } else {
        toasts.show("error", "Wallet Trade Sell unavailable", walletTradeResponse.error);
      }
    } catch (error) {
      toasts.show("error", "Trade state unavailable", error instanceof Error ? error.message : "The extension request failed.");
    } finally {
      tradeStateLoading = false;
      if (!(activeTab === "position-autosell" && autosellControlFocused)) render();
    }
  };

  const loadAutosellPresets = async (force = false) => {
    const client = ensureSelectedClient();
    if (!client || (!force && (autosellPresetsLoading || autosellPresetsClientId === client.endpointId))) return;
    autosellPresetsLoading = true;
    try {
      const response = await request({ type: "sharp:get-autosell-presets", clientId: client.endpointId });
      if (selectedClientId !== client.endpointId) return;
      if (response.ok) {
        autosellPresets = response.autosellPresets ?? { tpsl: [], sl: [], tsl: [] };
        autosellPresetsClientId = client.endpointId;
      } else {
        autosellPresetsClientId = "";
        toasts.show("error", "Auto Sell setups unavailable", response.error);
      }
    } catch (error) {
      autosellPresetsClientId = "";
      toasts.show("error", "Auto Sell setups unavailable", error instanceof Error ? error.message : "The extension request failed.");
    } finally {
      autosellPresetsLoading = false;
      if (!(activeTab === "position-autosell" && autosellControlFocused)) render();
    }
  };

  const loadManagedWalletBalances = async (clientId: string) => {
    if (managedWalletBalancesLoadingClientId === clientId) return;
    managedWalletBalancesLoadingClientId = clientId;
    render();
    try {
      const cached = await request({ type: "sharp:get-active-wallet-balance", clientId });
      if (cached?.ok && cached.activeWalletBalance) {
        const current = managedWalletsByClient.get(clientId);
        if (current) {
          const active = cached.activeWalletBalance;
          managedWalletsByClient.set(clientId, {
            ...current,
            wallets: current.wallets.map((wallet) =>
              wallet.address.toLowerCase() === active.address.toLowerCase()
                || (active.name && wallet.name === active.name)
                ? {
                    ...wallet,
                    balance: active.balance,
                    ...(active.wrappedBalance !== undefined ? { wrappedBalance: active.wrappedBalance } : {})
                  }
                : wallet
            )
          });
          if (!(activeTab === "position-autosell" && autosellControlFocused)) render();
        }
      }

      const response = await request({ type: "sharp:get-managed-wallets", clientId, balances: true });
      if (response.ok && response.managedWallets) {
        const current = managedWalletsByClient.get(clientId);
        const previousBalances = new Map(
          current?.wallets
            .filter((wallet) => wallet.balance !== undefined || wallet.wrappedBalance !== undefined)
            .map((wallet) => [wallet.address, {
              balance: wallet.balance,
              wrappedBalance: wallet.wrappedBalance
            }]) ?? []
        );
        managedWalletsByClient.set(clientId, {
          ...response.managedWallets,
          wallets: response.managedWallets.wallets.map((wallet) => {
            const previous = previousBalances.get(wallet.address);
            if (!previous) return wallet;
            return {
              ...wallet,
              ...(wallet.balance === undefined && previous.balance !== undefined
                ? { balance: previous.balance }
                : {}),
              ...(wallet.wrappedBalance === undefined && previous.wrappedBalance !== undefined
                ? { wrappedBalance: previous.wrappedBalance }
                : {})
            };
          })
        });
      }
    } catch {} finally {
      if (managedWalletBalancesLoadingClientId === clientId) managedWalletBalancesLoadingClientId = "";
      if (!(activeTab === "position-autosell" && autosellControlFocused)) render();
    }
  };

  const loadManagedWallets = async (force = false) => {
    const client = ensureSelectedClient();
    if (!client || (activeTab !== "trade" && activeTab !== "dev-sell" && activeTab !== "position-autosell") || !context) return;
    if (managedWalletsLoadingClientId === client.endpointId) return;
    if (!force && managedWalletsByClient.has(client.endpointId)) return;
    managedWalletsLoadingClientId = client.endpointId;
    render();
    try {
      const response = await request({ type: "sharp:get-managed-wallets", clientId: client.endpointId });
      if (response.ok && response.managedWallets) {
        managedWalletsByClient.set(client.endpointId, response.managedWallets);
        void loadManagedWalletBalances(client.endpointId);
      } else if (!response.ok) {
        toasts.show("error", "Wallets unavailable", response.error);
      }
    } catch (error) {
      toasts.show("error", "Wallets unavailable", error instanceof Error ? error.message : "The extension request failed.");
    } finally {
      if (managedWalletsLoadingClientId === client.endpointId) managedWalletsLoadingClientId = "";
      if (!(activeTab === "position-autosell" && autosellControlFocused)) render();
    }
  };

  const clientSelect = (compact = false) => {
    const wrap = document.createElement("label");
    wrap.className = compact ? "field header-client no-drag" : "field";
    const label = document.createElement("span");
    label.textContent = "Sharp client";
    const select = document.createElement("select");
    const clients = availableClients();
    if (clients.length === 0) {
      const option = document.createElement("option");
      const tradeChain = activeTab === "trade" || activeTab === "sell-auto" || activeTab === "position-autosell" ? context?.chain : undefined;
      option.textContent = tradeChain
        ? `No ${tradeChain ? chainLabel(tradeChain) : "trading"} client connected`
        : activeTab === "dev-sell"
          ? "No Solana client connected"
        : "No Sniping client connected";
      select.append(option);
      select.disabled = true;
    } else {
      for (const client of clients) {
        const option = document.createElement("option");
        option.value = client.endpointId;
        option.textContent = `${client.capabilities?.client_name || client.endpointId}${client.capabilities?.paper_trade ? " · PAPER" : " · REAL"}`;
        select.append(option);
      }
      ensureSelectedClient();
      select.value = selectedClientId;
      select.onchange = () => {
        selectedClientId = select.value;
        const chain = activeTab === "trade" || activeTab === "sell-auto" || activeTab === "position-autosell" ? context?.chain : "solana";
        if (chain) void persistClientSelection(chain, selectedClientId);
        creatorSell = undefined;
        creatorSellClientId = "";
        tasks = [];
        tasksClientId = "";
        migrationSell = undefined;
        migrationSellClientId = "";
        render();
        if (activeTab === "dev-sell") void loadCreatorSell();
        else if (activeTab === "trade") void loadTradeState();
        else if (activeTab === "sell-auto") { void loadTradeState(); void loadWalletLists(); }
        else if (activeTab === "position-autosell") {
          autosellPresetsClientId = "";
          void loadTradeState();
          void loadManagedWallets();
          void loadAutosellPresets();
        }
        else if (activeTab === "migration") { void loadTasks(); void loadTradeState(); }
        else void loadTasks();
      };
    }
    select.setAttribute("aria-label", "Sharp client");
    if (compact) wrap.append(select);
    else wrap.append(label, select);
    return wrap;
  };

  const inputField = (
    labelText: string,
    placeholder: string,
    inputMode: "text" | "decimal" = "text"
  ) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const label = document.createElement("span");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.placeholder = placeholder;
    input.inputMode = inputMode;
    wrap.append(label, input);
    return { wrap, input };
  };

  const actionButton = (label: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary";
    button.textContent = busy ? "Working…" : label;
    button.disabled = busy;
    return button;
  };

  const taskTarget = (task: SnipeTaskSummary) =>
    task.target.mint ??
    task.target.creator_wallet ??
    task.target.creator_wallets?.[0] ??
    task.target.ticker ??
    task.target.tickers?.[0] ??
    "";

  const shortTarget = (target: string) =>
    target.length > 18 ? `${target.slice(0, 7)}…${target.slice(-6)}` : target;

  const taskStatusLabel = (status: SnipeTaskSummary["status"]) => ({
    draft: "Not started",
    armed: "Running",
    matched: "Matched",
    executing: "Executing",
    landed: "Landed",
    completed: "Completed",
    paused: "Stopped",
    expired: "Expired",
    failed: "Failed"
  }[status]);

  const friendlyTaskResult = (result: string) => result
    .replace(/\bTask re-armed\b/gi, "Task started again")
    .replace(/\bre-armed\b/gi, "restarted")
    .replace(/\bdisarmed\b/gi, "stopped")
    .replace(/\barmed\b/gi, "started")
    .replace(/\bPaused by user\b/gi, "Stopped by user")
    .replace(/\bPaused after client restart\b/gi, "Stopped after client restart");

  const runTaskAction = async (
    task: SnipeTaskSummary,
    action: "arm" | "pause" | "delete"
  ) => {
    if (!selectedClientId || busy) return;
    busy = true;
    render();
    try {
      const response = await request({
        type: "sharp:task-action",
        clientId: selectedClientId,
        action,
        taskId: task.id
      });
      if (response.ok) {
        tasks = response.tasks ?? [];
        tasksClientId = selectedClientId;
        const verb = action === "delete" ? "deleted" : action === "pause" ? "stopped" : "started";
        toasts.show("success", `Task ${verb}`, `${task.label || shortTarget(taskTarget(task))} was ${verb}.`);
      } else {
        toasts.show("error", "Task action failed", response.error);
      }
    } catch (error) {
      toasts.show("error", "Task action failed", error instanceof Error ? error.message : "The extension request failed.");
    } finally {
      busy = false;
      render();
    }
  };

  const renderTaskList = (body: HTMLElement, taskType: "dev" | "mint_spam" | "all") => {
    const visibleTasks = taskType === "all"
      ? tasks
      : tasks.filter((task) => task.task_type === taskType);
    const collapsible = taskType === "mint_spam";
    const section = document.createElement(collapsible ? "details" : "section");
    section.className = "task-section";
    if (section instanceof HTMLDetailsElement) {
      section.open = migrationWatchesOpen;
      section.ontoggle = () => { migrationWatchesOpen = section.open; };
      const summary = document.createElement("summary");
      summary.className = "task-collapse-summary";
      summary.textContent = `Migration watches · ${visibleTasks.length}`;
      section.append(summary);
    }
    const heading = document.createElement("div");
    heading.className = "task-heading";
    const title = document.createElement("strong");
    title.textContent = taskType === "all"
      ? "Running and saved tasks"
      : taskType === "dev" ? "Developer watches" : "Saved watches";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = tasksLoading ? "Loading…" : "Refresh";
    refresh.disabled = tasksLoading;
    refresh.onclick = () => void loadTasks(true);
    heading.append(title, refresh);
    section.append(heading);

    if (tasksLoading && tasksClientId !== selectedClientId) {
      const loading = document.createElement("p");
      loading.textContent = "Loading tasks…";
      section.append(loading);
    } else if (visibleTasks.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No saved watches on this client.";
      section.append(empty);
    } else {
      const list = document.createElement("div");
      list.className = "task-list";
      if (visibleTasks.length > 2) list.classList.add("scrollable");
      for (const task of visibleTasks) {
        const row = document.createElement("article");
        row.className = "task-row";
        const copy = document.createElement("div");
        const label = document.createElement("strong");
        label.textContent = task.label || (
          task.task_type === "dev" ? "Dev Buy" :
            task.task_type === "ticker" ? "Ticker Snipe" : "Mint Spam"
        );
        const details = document.createElement("span");
        const amount = task.buy_overrides?.amount;
        details.textContent = `${shortTarget(taskTarget(task))}${amount === undefined ? " · Preset" : ` · ${amount}`}`;
        copy.append(label, details);
        const state = document.createElement("span");
        state.className = `task-state ${task.status}`;
        state.textContent = taskStatusLabel(task.status);
        const actions = document.createElement("div");
        actions.className = "task-actions";
        if (task.status === "armed") {
          const pause = document.createElement("button");
          pause.type = "button";
          pause.textContent = "Stop";
          pause.disabled = busy;
          pause.onclick = () => void runTaskAction(task, "pause");
          actions.append(pause);
        } else if (!["matched", "executing", "landed", "completed"].includes(task.status)) {
          const arm = document.createElement("button");
          arm.type = "button";
          arm.textContent = "Start";
          arm.disabled = busy;
          arm.onclick = () => void runTaskAction(task, "arm");
          actions.append(arm);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger";
        remove.textContent = "Delete";
        remove.disabled = busy;
        remove.onclick = () => void runTaskAction(task, "delete");
        actions.append(remove);
        row.append(copy, state, actions);
        if (task.last_result) {
          const result = document.createElement("small");
          result.textContent = friendlyTaskResult(task.last_result);
          result.title = task.last_result;
          row.append(result);
        }
        list.append(row);
      }
      section.append(list);
      if (visibleTasks.length > 2) {
        requestAnimationFrame(() => {
          const rows = [...list.querySelectorAll<HTMLElement>(".task-row")];
          const firstTwoHeight = rows.slice(0, 2).reduce((total, row) => total + row.offsetHeight, 0);
          if (firstTwoHeight > 0) list.style.maxHeight = `${firstTwoHeight + 7}px`;
        });
      }
    }
    body.append(section);
  };

  const finiteNumber = (value: unknown): number | undefined => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  };

  const compactNumber = (value: unknown, suffix = "") => {
    const number = finiteNumber(value);
    if (number === undefined) return "0";
    const absolute = Math.abs(number);
    const formatted = absolute >= 1_000_000
      ? `${(number / 1_000_000).toFixed(2)}M`
      : absolute >= 1_000
        ? `${(number / 1_000).toFixed(2)}K`
        : number.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return `${formatted}${suffix}`;
  };


  const positionAutomationPolicy = (position: SharpPosition): PositionAutomationPolicy => {
    const raw = position.additionalData?.automation_policy
      ?? position.additionalData?.automationPolicy;
    const policy = typeof raw === "object" && raw !== null
      ? raw as Record<string, unknown>
      : {};
    const enabled = (camel: string, snake: string) =>
      typeof policy[camel] === "boolean"
        ? policy[camel] as boolean
        : typeof policy[snake] === "boolean"
          ? policy[snake] as boolean
          : true;
    const rawCreatorSettings = policy.creatorSellSettings ?? policy.creator_sell_settings;
    const creatorSettings = typeof rawCreatorSettings === "object" && rawCreatorSettings !== null
      ? rawCreatorSettings as Record<string, unknown>
      : undefined;
    const minimumPercentage = Number(creatorSettings?.minimumPercentage ?? creatorSettings?.minimum_percentage);
    const sellPercentage = Number(creatorSettings?.sellPercentage ?? creatorSettings?.sell_percentage);
    return {
      creatorSell: enabled("creatorSell", "creator_sell"),
      migrationSell: enabled("migrationSell", "migration_sell"),
      walletTradeSell: enabled("walletTradeSell", "wallet_trade_sell"),
      ...(creatorSettings
        && typeof creatorSettings.enabled === "boolean"
        && Number.isFinite(minimumPercentage)
        && Number.isFinite(sellPercentage)
        ? {
            creatorSellSettings: {
              enabled: creatorSettings.enabled,
              minimumPercentage,
              sellPercentage
            }
          }
        : {})
    };
  };

  const positionWalletLabel = (position: SharpPosition): string => {
    const wallet = positionExecutionWallet(position);
    if (wallet) {
      const normalized = wallet.toLowerCase();
      for (const inventory of managedWalletsByClient.values()) {
        const match = inventory.wallets.find((candidate) =>
          candidate.name === wallet || candidate.address.toLowerCase() === normalized
        );
        if (match) return match.name;
      }
      return wallet;
    }
    return "Active wallet";
  };

  const perWalletBreakdown = (positions: SharpPosition[]) => {
    const groups = new Map<string, SharpPosition[]>();
    for (const position of positions) {
      const key = positionWalletLabel(position);
      const list = groups.get(key);
      if (list) list.push(position);
      else groups.set(key, [position]);
    }
    return [...groups.entries()].map(([wallet, group]) => ({ wallet, metrics: aggregatePositionMetrics(group) }));
  };

  const renderStatsBreakdown = (breakdown: HTMLElement, positions: SharpPosition[], chain: SharpChain | undefined) => {
    const groups = perWalletBreakdown(positions);
    if (!positions.length || !groups.length) {
      breakdown.replaceChildren();
      return;
    }
    const title = document.createElement("div");
    title.className = "trade-stats-breakdown-title";
    title.textContent = groups.length === 1 ? "Wallet position" : `${groups.length} wallets`;
    const unit = chain ? nativeSymbol(chain) : "";
    const rows = groups.map(({ wallet, metrics }) => {
      const row = document.createElement("div");
      row.className = "trade-stats-breakdown-row";
      const head = document.createElement("div");
      head.className = "trade-stats-breakdown-head";
      const name = document.createElement("strong");
      name.textContent = wallet.length > 18 ? shortTarget(wallet) : wallet;
      name.title = wallet;
      head.append(name);
      const values = document.createElement("div");
      values.className = "trade-stats-breakdown-values";
      const pct = metrics.pnlPercent;
      const entries: Array<[string, string, string, boolean]> = [
        ["Bought", compactNumber(metrics.bought), "", true],
        ["Sold", compactNumber(metrics.sold), "", true],
        ["Holding", metrics.holding === undefined ? "—" : compactNumber(metrics.holding), "", true],
        ["PnL", pct === undefined ? "—" : compactNumber(pct, "%"), pct === undefined ? "" : pct < 0 ? "negative" : "positive", false],
      ];
      for (const [label, text, tone, showCurrency] of entries) {
        const metric = document.createElement("span");
        if (tone) metric.classList.add(tone);
        const caption = document.createElement("small");
        caption.textContent = label;
        const amount = document.createElement("b");
        amount.title = showCurrency ? `${text} ${unit}`.trim() : text;
        amount.replaceChildren(
          ...(showCurrency ? [currencyMark(chain)] : []),
          document.createTextNode(text)
        );
        metric.append(caption, amount);
        values.append(metric);
      }
      row.append(head, values);
      return row;
    });
    breakdown.replaceChildren(title, ...rows);
  };

  const currencyMark = (chain: SharpChain | undefined) => {
    const mark = document.createElement("i");
    mark.className = "trade-currency-mark";
    if (chain === "solana") {
      mark.classList.add("solana");
      mark.innerHTML = `<svg viewBox="0 0 397.7 311.7" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="sharp-sol-a" x1="360.88" y1="351.46" x2="141.21" y2="-69.29" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00ffa3"/><stop offset="1" stop-color="#dc1fff"/></linearGradient>
          <linearGradient id="sharp-sol-b" x1="264.83" y1="401.6" x2="45.16" y2="-19.15" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00ffa3"/><stop offset="1" stop-color="#dc1fff"/></linearGradient>
          <linearGradient id="sharp-sol-c" x1="312.55" y1="376.69" x2="92.88" y2="-44.06" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00ffa3"/><stop offset="1" stop-color="#dc1fff"/></linearGradient>
        </defs>
        <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1z" fill="url(#sharp-sol-a)"/>
        <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1z" fill="url(#sharp-sol-b)"/>
        <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1z" fill="url(#sharp-sol-c)"/>
      </svg>`;
    } else if (chain === "base" || chain === "robinhood") {
      mark.classList.add("ethereum");
      mark.innerHTML = `<svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 1.5 7.2 16 16 21.1Z" fill="#8a92b2"/>
        <path d="M16 1.5 24.8 16 16 21.1Z" fill="#62688f"/>
        <path d="M16 22.8 7.2 17.6 16 30.5Z" fill="#8a92b2"/>
        <path d="M16 22.8 24.8 17.6 16 30.5Z" fill="#62688f"/>
        <path d="m7.2 16 8.8-4v9.1Z" fill="#62688f" opacity=".72"/>
        <path d="m24.8 16-8.8-4v9.1Z" fill="#454a75" opacity=".82"/>
      </svg>`;
    } else {
      mark.textContent = chain ? nativeSymbol(chain).slice(0, 1) : "$";
    }
    return mark;
  };

  const setTradeStat = (
    stat: HTMLElement,
    value: unknown,
    label: string,
    chain: SharpChain | undefined,
    labelSuffix = ""
  ) => {
    const strong = stat.querySelector("strong")!;
    const unit = chain ? nativeSymbol(chain) : "USD";
    const children: Node[] = [currencyMark(chain), document.createTextNode(compactNumber(value))];
    if (chain !== "solana") {
      const unitLabel = document.createElement("small");
      unitLabel.textContent = unit;
      children.push(unitLabel);
    }
    strong.replaceChildren(...children);
    strong.title = `${compactNumber(value)} ${unit}`;
    const caption = stat.querySelector<HTMLElement>(".trade-stat-label");
    if (caption) caption.textContent = labelSuffix ? `${label} · ${labelSuffix}` : label;
  };

  const currentPositionOwners = () => {
    if (!context) return [];
    const target = context.address.toLowerCase();
    const clients = connectedClients(context.chain)
      .filter((client) => client.capabilities?.features.sell)
      .sort((left, right) =>
        Number(right.endpointId === selectedClientId) - Number(left.endpointId === selectedClientId)
      );
    const seen = new Set<string>();
    return clients.flatMap((client) =>
      (positionsByClient.get(client.endpointId) ?? []).flatMap((position, index) => {
        if (!positionMatchesAsset(position, target)) return [];
        const key = positionId(position) ?? `${client.endpointId}:${index}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ clientId: client.endpointId, position }];
      })
    );
  };

  const currentPositionSourceLabel = (owners = currentPositionOwners()) => {
    const ownerIds = [...new Set(owners.map(({ clientId }) => clientId))];
    if (ownerIds.length > 1) return `${ownerIds.length} modules`;
    const ownerId = ownerIds[0];
    if (!ownerId || ownerId === selectedClientId) return "";
    const owner = snapshot?.clients.find((client) => client.endpointId === ownerId);
    return owner?.capabilities?.module || owner?.capabilities?.client_name || ownerId;
  };

  const sellWalletPlanForClient = (clientId: string): WalletExecutionPlan => {
    const storedPlan = localSellWalletPlansByClient.get(clientId)
      ?? snapshot?.walletPlansByClient?.[clientId];
    if (!storedPlan) return { allocations: [] };
    const inventory = managedWalletsByClient.get(clientId);
    return inventory
      ? reconcileWalletPlan(storedPlan, inventory.wallets) ?? { allocations: [] }
      : storedPlan;
  };

  const sellWalletAliasesForClient = (clientId: string): Set<string> => {
    const aliases = new Set<string>();
    const inventory = managedWalletsByClient.get(clientId);
    const plan = sellWalletPlanForClient(clientId);
    if (plan?.allocations.length) {
      for (const allocation of plan.allocations) {
        aliases.add(allocation.walletName.toLowerCase());
        const wallet = inventory?.wallets.find((candidate) => candidate.name === allocation.walletName);
        if (wallet) aliases.add(wallet.address.toLowerCase());
      }
      return aliases;
    }
    const client = snapshot?.clients.find((candidate) => candidate.endpointId === clientId);
    const activeAddress = client?.capabilities?.wallet?.address?.toLowerCase();
    if (activeAddress) {
      aliases.add(activeAddress);
      const wallet = inventory?.wallets.find((candidate) => candidate.address.toLowerCase() === activeAddress);
      if (wallet) aliases.add(wallet.name.toLowerCase());
    }
    return aliases;
  };

  const positionMatchesSellScope = (clientId: string, position: SharpPosition): boolean => {
    const aliases = sellWalletAliasesForClient(clientId);
    const wallet = positionExecutionWallet(position);
    if (!aliases.size) return !wallet;
    if (wallet) return aliases.has(wallet.toLowerCase());
    // Legacy positions remain safe because sells target the owning module by exact position ID.
    return true;
  };

  const currentSellPositionOwners = () => currentPositionOwners()
    .filter(({ clientId, position }) =>
      positionIsOpen(position) && positionMatchesSellScope(clientId, position)
    );

  const currentSellPositions = () => currentSellPositionOwners().map(({ position }) => position);

  const refreshTradePositionDom = () => {
    const stats = shadow.querySelector<HTMLElement>(".trade-stats");
    if (!stats) return;
    const owners = currentSellPositionOwners();
    const positions = owners.map(({ position }) => position);
    const positionSourceLabel = currentPositionSourceLabel(owners);
    const metrics = aggregatePositionMetrics(positions);
    const pnl = metrics.pnlPercent;
    const values = [metrics.bought, metrics.sold, metrics.holding, metrics.pnl];
    [...stats.children].forEach((stat, index) => {
      const labels = ["Bought", "Sold", "Holding", "PnL"];
      setTradeStat(
        stat as HTMLElement,
        values[index],
        labels[index]!,
        context?.chain,
        index === 2 && positionSourceLabel
          ? positionSourceLabel
          : index === 3 ? compactNumber(metrics.pnlPercent ?? 0, "%") : ""
      );
      if (index === 3) {
        stat.classList.toggle("negative", pnl !== undefined && pnl < 0);
        stat.classList.toggle("positive", pnl !== undefined && pnl >= 0);
      }
    });
    const breakdown = shadow.querySelector<HTMLElement>(".trade-stats-breakdown");
    if (breakdown) renderStatsBreakdown(breakdown, positions, context?.chain);
    for (const button of shadow.querySelectorAll<HTMLButtonElement>(".trade-quick.sell button")) {
      button.disabled = busy || positions.length === 0;
    }
    const sellInitial = shadow.querySelector<HTMLButtonElement>(".trade-sell-initial");
    if (sellInitial) {
      sellInitial.disabled = busy || !positions.some((position) => positionId(position));
    }
  };

  const renderManagedWalletPanel = (target: HTMLElement, instance: "buy" | "sell") => {
    if (!context || !selectedClientId || !snapshot) return;
    const panelContext = context;
    const inventory = managedWalletsByClient.get(selectedClientId);
    const storedPlan = instance === "sell"
      ? sellWalletPlanForClient(selectedClientId)
      : snapshot.walletPlansByClient?.[selectedClientId];
    const savedPlan = storedPlan && inventory
      ? reconcileWalletPlan(storedPlan, inventory.wallets)
      : undefined;
    const saved = savedPlan?.allocations ?? [];
    const savedWeights = new Map(saved.map((allocation) => [allocation.walletName, allocation.weight]));
    const automationPolicies = new Map(saved.map((allocation) => [
      allocation.walletName,
      allocation.automation ?? defaultPositionAutomation()
    ]));
    const autosellPolicies = new Map(saved.map((allocation) => [
      allocation.walletName,
      allocation.autosell ?? defaultPositionAutosell()
    ]));
    let selectedGroupId = savedPlan?.groupId ?? "";
    const section = document.createElement("details");
    section.className = "managed-wallets";
    section.open = walletRoutingOpen[instance];
    section.ontoggle = () => {
      if (!section.isConnected) return;
      walletRoutingOpen[instance] = section.open;
      if (!section.open) return;
      walletFlyoutContent = content;
      walletFlyoutSummary = summary;
      requestAnimationFrame(positionWalletFlyout);
      if (!managedWalletsByClient.has(selectedClientId) && managedWalletsLoadingClientId !== selectedClientId) {
        void loadManagedWallets();
      } else if (
        inventory
        && inventory.wallets.some((wallet) => wallet.balance === undefined)
        && managedWalletBalancesLoadingClientId !== selectedClientId
      ) {
        void loadManagedWalletBalances(selectedClientId);
      }
    };
    const summary = document.createElement("summary");
    const selectedCount = saved.length;
    const walletCount = selectedCount || 1;
    const scopeLabel = instance === "sell" ? "sell" : "trade";
    summary.setAttribute("aria-label", `Select ${scopeLabel} wallets`);
    summary.title = selectedCount
      ? `${selectedCount} selected ${scopeLabel} wallet${selectedCount === 1 ? "" : "s"}`
      : `Using the active Sharp wallet`;
    summary.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 2 18V6a1.5 1.5 0 0 1 1.5-1.5H17"/><path d="M16 11.5h4v4h-4a2 2 0 0 1 0-4Z"/><circle cx="16.5" cy="13.5" r=".5"/></svg><strong>${walletCount}</strong><span>⌄</span>`;
    section.append(summary);
    const content = document.createElement("div");
    content.className = "managed-wallet-content";
    if (section.open) {
      walletFlyoutContent = content;
      walletFlyoutSummary = summary;
    }
    if (!inventory) {
      const loading = document.createElement("div");
      loading.className = "wallet-loading";
      const loadingCopy = document.createElement("span");
      loadingCopy.textContent = managedWalletsLoadingClientId === selectedClientId
        ? "Loading wallets from Sharp"
        : "Wallet inventory is not loaded";
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "wallet-link";
      refresh.disabled = managedWalletsLoadingClientId === selectedClientId;
      refresh.textContent = refresh.disabled ? "Loading" : "Retry";
      refresh.onclick = () => void loadManagedWallets(true);
      loading.append(loadingCopy, refresh);
      content.append(loading);
      section.append(content);
      target.append(section);
      if (section.open) requestAnimationFrame(positionWalletFlyout);
      return;
    }

    const openPositionsByWallet = new Map<string, SharpPosition[]>();
    if (instance === "sell") {
      for (const { clientId, position } of currentPositionOwners()) {
        if (clientId !== selectedClientId) continue;
        const executionWallet = positionExecutionWallet(position)?.toLowerCase()
          ?? snapshot.clients.find((client) => client.endpointId === clientId)
            ?.capabilities?.wallet?.address.toLowerCase();
        if (!executionWallet) continue;
        const wallet = inventory.wallets.find((candidate) =>
          candidate.name.toLowerCase() === executionWallet
          || candidate.address.toLowerCase() === executionWallet
        );
        if (!wallet) continue;
        const positions = openPositionsByWallet.get(wallet.name);
        if (positions) positions.push(position);
        else openPositionsByWallet.set(wallet.name, [position]);
        automationPolicies.set(wallet.name, positionAutomationPolicy(position));
      }
    }

    const persistSelection = async () => {
      if (busy) return;
      const names = [...list.querySelectorAll<HTMLElement>(".wallet-row.selected")]
        .map((row) => row.dataset.walletName || "")
        .filter(Boolean);
      const evenShare = names.length ? 100 / names.length : 0;
      const scopedGroup = selectedGroupId
        ? inventory.groups.find((group) => group.id === selectedGroupId)
        : undefined;
      const scopedCreatorSell = scopedGroup?.creatorSell;
      const scopedCreatorWallets = scopedGroup
        ? new Set(scopedGroup.creatorSellWallets ?? scopedGroup.wallets)
        : undefined;
      const scopedAutosellWallets = scopedGroup
        ? new Set(scopedGroup.autosellWallets ?? scopedGroup.wallets)
        : undefined;
      const allocations = names.map((walletName) => ({
        walletName,
        ...(inventory.wallets.find((wallet) => wallet.name === walletName)?.address
          ? { walletAddress: inventory.wallets.find((wallet) => wallet.name === walletName)!.address }
          : {}),
        weight: evenShare,
        automation: {
          ...(automationPolicies.get(walletName) ?? defaultPositionAutomation()),
          ...(scopedCreatorSell ? {
            creatorSell: scopedCreatorSell.enabled && (scopedCreatorWallets?.has(walletName) ?? false),
            creatorSellSettings: {
              enabled: scopedCreatorSell.enabled && (scopedCreatorWallets?.has(walletName) ?? false),
              minimumPercentage: scopedCreatorSell.minimumPercentage,
              sellPercentage: scopedCreatorSell.sellPercentage
            }
          } : {})
        },
        autosell: scopedGroup?.autosell && scopedAutosellWallets?.has(walletName)
          ? scopedGroup.autosell
          : autosellPolicies.get(walletName) ?? defaultPositionAutosell()
      }));
      const nextPlan: WalletExecutionPlan = {
        allocations,
        ...(selectedGroupId ? { groupId: selectedGroupId } : {}),
        ...(savedPlan?.randomizationBps ? { randomizationBps: savedPlan.randomizationBps } : {}),
        ...(savedPlan?.autoRebalance ? { autoRebalance: true } : {})
      };
      if (instance === "sell") {
        localSellWalletPlansByClient.set(selectedClientId, nextPlan);
        const counter = summary.querySelector("strong");
        if (counter) counter.textContent = String(names.length || 1);
        refreshTradePositionDom();
        return;
      }
      busy = true;
      try {
        const response = await request({
          type: "sharp:update-wallet-plan",
          clientId: selectedClientId,
          action: instance,
          plan: nextPlan
        });
        if (response.ok) {
          if (response.snapshot) snapshot = response.snapshot;
          const counter = summary.querySelector("strong");
          if (counter) counter.textContent = String(names.length || 1);
        } else {
          toasts.show("error", "Trade wallets not saved", response.error);
        }
      } catch (error) {
        toasts.show("error", "Trade wallets not saved", error instanceof Error ? error.message : "The extension request failed.");
      } finally {
        busy = false;
      }
    };

    const groupsLabel = document.createElement("span");
    groupsLabel.className = "wallet-flyout-label";
    groupsLabel.textContent = "Groups";

    const groups = document.createElement("div");
    groups.className = "wallet-groups";
    const active = document.createElement("button");
    active.type = "button";
    active.textContent = "Active wallet only";
    active.classList.toggle("selected", !selectedGroupId && saved.length === 0);
    active.onclick = () => {
      selectedGroupId = "";
      for (const button of groups.querySelectorAll("button")) button.classList.remove("selected");
      active.classList.add("selected");
      for (const row of list.querySelectorAll<HTMLElement>(".wallet-row")) {
        const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (checkbox) checkbox.checked = false;
        row.classList.remove("selected");
      }
      void persistSelection();
    };
    groups.append(active);
    for (const group of inventory.groups) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = group.name;
      button.classList.toggle("selected", selectedGroupId === group.id);
      button.onclick = () => {
        selectedGroupId = group.id;
        for (const candidate of groups.querySelectorAll("button")) candidate.classList.remove("selected");
        button.classList.add("selected");
        const groupNames = new Set(group.wallets);
        for (const row of list.querySelectorAll<HTMLElement>(".wallet-row")) {
          const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
          const checked = groupNames.has(row.dataset.walletName || "");
          if (checkbox) checkbox.checked = checked;
          row.classList.toggle("selected", checked);
        }
        void persistSelection();
      };
      groups.append(button);
    }

    const walletsLabel = document.createElement("span");
    walletsLabel.className = "wallet-flyout-label";
    walletsLabel.textContent = "Wallets";

    const formatWalletBalance = (value: number) =>
      value.toLocaleString(undefined, {
        maximumFractionDigits: Math.abs(value) < 0.01 ? 6 : 4
      });
    const list = document.createElement("div");
    list.className = "wallet-list";
    for (const wallet of inventory.wallets) {
      const item = document.createElement("div");
      item.className = "wallet-row-item";
      const row = document.createElement("div");
      row.className = "wallet-row";
      row.dataset.walletName = wallet.name;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = savedWeights.has(wallet.name);
      row.classList.toggle("selected", checkbox.checked);
      const name = document.createElement("strong");
      name.textContent = wallet.name;
      name.title = wallet.address;
      const balance = document.createElement("span");
      balance.className = "wallet-row-balance";
      const openPositions = openPositionsByWallet.get(wallet.name) ?? [];
      if (instance === "sell") {
        if (!openPositions.length) {
          balance.textContent = "No position";
          balance.classList.add("muted");
        } else {
          const metrics = aggregatePositionMetrics(openPositions);
          const bought = document.createElement("span");
          bought.textContent = `${compactNumber(metrics.bought)} ${nativeSymbol(context.chain)} bought`;
          balance.append(bought);
          if (metrics.holding !== undefined) {
            const holding = document.createElement("small");
            holding.textContent = `${compactNumber(metrics.holding)} ${nativeSymbol(context.chain)} holding`;
            balance.append(holding);
          }
        }
      } else if (wallet.balance === undefined) {
        balance.textContent = managedWalletBalancesLoadingClientId === selectedClientId ? "…" : "—";
        balance.classList.add("muted");
      } else {
        const native = document.createElement("span");
        native.textContent = `${formatWalletBalance(wallet.balance)} ${inventory.nativeSymbol ?? nativeSymbol(context.chain)}`;
        balance.append(native);
        if (wallet.wrappedBalance !== undefined && wallet.wrappedBalance > 0) {
          const wrapped = document.createElement("small");
          wrapped.textContent = `${formatWalletBalance(wallet.wrappedBalance)} WSOL`;
          balance.append(wrapped);
        }
      }
      checkbox.onchange = () => {
        selectedGroupId = "";
        for (const button of groups.querySelectorAll("button")) button.classList.remove("selected");
        row.classList.toggle("selected", checkbox.checked);
        void persistSelection();
      };
      row.append(checkbox, name, balance);
      const openPosition = openPositions[0];
      if (instance === "buy" || openPosition) {
        const automationButton = document.createElement("button");
        automationButton.type = "button";
        automationButton.className = "wallet-auto-button";
        automationButton.setAttribute("aria-label", `Configure automatic sells for ${wallet.name}`);
        const policy = automationPolicies.get(wallet.name) ?? defaultPositionAutomation();
        automationPolicies.set(wallet.name, policy);
        const automationOptions = context.chain === "solana"
          ? ([
              ["creatorSell", "Dev"],
              ["migrationSell", "Migration"],
              ["walletTradeSell", "Wallet"]
            ] as const)
          : ([
              ["migrationSell", "Migration"],
              ["walletTradeSell", "Wallet"]
            ] as const);
        const updateButton = () => {
          const current = automationPolicies.get(wallet.name) ?? defaultPositionAutomation();
          const enabled = automationOptions.filter(([key]) => current[key]).length;
          automationButton.textContent = `Auto ${enabled}`;
        };
        updateButton();
        const automationPanel = document.createElement("div");
        automationPanel.className = "wallet-auto-panel";
        for (const [key, label] of automationOptions) {
          const option = document.createElement("label");
          option.classList.toggle("active", policy[key]);
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = policy[key];
          const copy = document.createElement("span");
          copy.textContent = label;
          input.onchange = async () => {
            const previous = automationPolicies.get(wallet.name) ?? defaultPositionAutomation();
            const next = {
              ...previous,
              [key]: input.checked
            };
            automationPolicies.set(wallet.name, next);
            option.classList.toggle("active", input.checked);
            updateButton();
            if (instance === "buy") {
              if (row.classList.contains("selected")) void persistSelection();
              return;
            }
            input.disabled = true;
            try {
              const response = await request({
                type: "sharp:update-position-automation",
                clientId: selectedClientId,
                context: panelContext,
                walletName: wallet.name,
                automation: next
              });
              if (!response.ok) throw new Error(response.error);
              positionsByClient.set(selectedClientId, response.positions ?? []);
              toasts.show("success", "Sell automation updated", `${wallet.name} was updated for this position.`);
            } catch (error) {
              automationPolicies.set(wallet.name, previous);
              input.checked = previous[key];
              option.classList.toggle("active", previous[key]);
              updateButton();
              toasts.show("error", "Sell automation not updated", error instanceof Error ? error.message : "The extension request failed.");
            } finally {
              input.disabled = false;
            }
          };
          option.append(input, copy);
          automationPanel.append(option);
        }
        automationButton.onclick = () => {
          const open = !item.classList.contains("automation-open");
          for (const candidate of list.querySelectorAll(".wallet-row-item.automation-open")) {
            candidate.classList.remove("automation-open");
          }
          item.classList.toggle("automation-open", open);
        };
        row.append(automationButton);
        item.append(row, automationPanel);
      } else {
        item.append(row);
      }
      list.append(item);
    }

    content.append(groupsLabel, groups, walletsLabel, list);
    section.append(content);
    target.append(section);
    if (section.open) requestAnimationFrame(positionWalletFlyout);
  };

  const submitPanelTrade = async (
    action: "buy" | "sell",
    amount: { mode: "preset" | "native" | "percentage"; value?: number }
  ) => {
    const client = ensureSelectedClient();
    if (busy) return;
    if (!context) {
      toasts.show("error", `${action === "buy" ? "Buy" : "Sell"} unavailable`, "Open a supported token page first.");
      return;
    }
    if (!client) {
      toasts.show("error", `${action === "buy" ? "Buy" : "Sell"} unavailable`, `No connected ${chainLabel(context.chain)} Custom Trade client is available.`);
      return;
    }
    let sellOwners = currentSellPositionOwners();
    const executionWalletKey = (clientId: string, position: SharpPosition) => {
      const inventory = managedWalletsByClient.get(clientId);
      const rawWallet = positionExecutionWallet(position)
        ?? snapshot?.clients.find((candidate) => candidate.endpointId === clientId)
          ?.capabilities?.wallet?.address;
      if (!rawWallet) return undefined;
      const wallet = inventory?.wallets.find((candidate) =>
        candidate.name.toLowerCase() === rawWallet.toLowerCase()
        || candidate.address.toLowerCase() === rawWallet.toLowerCase()
      );
      return (wallet?.address ?? rawWallet).toLowerCase();
    };
    if (action === "sell") {
      const clientsByExecutionWallet = new Map<string, string[]>();
      for (const { clientId, position } of sellOwners) {
        const key = executionWalletKey(clientId, position);
        if (!key) continue;
        const owners = clientsByExecutionWallet.get(key) ?? [];
        if (!owners.includes(clientId)) owners.push(clientId);
        clientsByExecutionWallet.set(key, owners);
      }
      const chosenClientByExecutionWallet = new Map(
        [...clientsByExecutionWallet].map(([key, owners]) => [
          key,
          owners.includes(selectedClientId) ? selectedClientId : owners[0]!
        ])
      );
      sellOwners = sellOwners.filter(({ clientId, position }) => {
        const key = executionWalletKey(clientId, position);
        return !key || chosenClientByExecutionWallet.get(key) === clientId;
      });
    }
    const sellClientIds = [...new Set(sellOwners.map(({ clientId }) => clientId))];
    if (action === "sell" && sellClientIds.length === 0) {
      toasts.show("error", "Sell unavailable", "No open Sharp position is available for this token.");
      return;
    }
    const pending = toasts.pending(
      action === "buy" ? "Pending buy…" : "Attempting to sell…",
      `${client.capabilities?.client_name || client.endpointId}: Waiting for Sharp transaction result`
    );
    busy = true;
    render();
    try {
      const sellWalletPlansByClient = action === "sell"
        ? Object.fromEntries(sellClientIds.map((clientId) => [clientId, sellWalletPlanForClient(clientId)]))
        : undefined;
      const positionIdsByClient = action === "sell"
        ? Object.fromEntries(sellClientIds.map((clientId) => [
            clientId,
            sellOwners
              .filter((owner) => owner.clientId === clientId)
              .map(({ position }) => positionId(position))
              .filter((id): id is string => Boolean(id))
          ]))
        : undefined;
      const response = await request({
        type: "sharp:trade",
        command: {
          context,
          action,
          clientIds: action === "sell" ? sellClientIds : [client.endpointId],
          amount,
          ...(sellWalletPlansByClient ? { walletPlansByClient: sellWalletPlansByClient } : {}),
          ...(positionIdsByClient ? { positionIdsByClient } : {})
        }
      });
      if (!response.ok) {
        pending.settle("error", action === "buy" ? "Buy failed" : "Sell failed", response.error);
      } else if (!response.results?.length) {
        const message = "No compatible Sharp client returned a transaction result.";
        pending.settle("error", action === "buy" ? "Buy failed" : "Sell failed", message);
      } else {
        const result = response.results[0]!;
        if (action === "buy") {
          pending.settle(
            result.status === "accepted" ? "success" : "error",
            result.status === "accepted" ? "Buy confirmed" : result.status === "timed_out" ? "Buy timed out" : "Buy failed",
            `${result.clientName}: ${result.message}`
          );
        } else {
          const summary = summarizeSellResults(response.results);
          pending.settle(summary.kind === "error" ? "error" : "success", summary.title, summary.message);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The extension request failed.";
      pending.settle("error", action === "buy" ? "Buy failed" : "Sell failed", message);
    } finally {
      busy = false;
      render();
    }
  };

  const renderTrade = (body: HTMLElement) => {
    const tradeChain = context?.chain;
    if (tradeQuickEditing && tradeChain !== tradeQuickChain) tradeQuickEditing = false;
    if (tradeSellQuickEditing && tradeChain !== tradeSellQuickChain) tradeSellQuickEditing = false;
    const positions = currentSellPositions();
    const positionOwners = currentSellPositionOwners();
    const positionSourceLabel = currentPositionSourceLabel(currentSellPositionOwners());
    const statsWrap = document.createElement("div");
    statsWrap.className = "trade-stats-wrap";
    const stats = document.createElement("div");
    stats.className = "trade-stats";
    const metrics = aggregatePositionMetrics(positions);
    const pnl = metrics.pnlPercent;
    const values: Array<[string, unknown, string?, string?]> = [
      ["Bought", metrics.bought],
      ["Sold", metrics.sold],
      ["Holding", metrics.holding, "", positionSourceLabel],
      ["PnL", metrics.pnl, pnl === undefined ? "" : pnl < 0 ? "negative" : "positive", compactNumber(pnl ?? 0, "%")]
    ];
    for (const [label, value, className, labelSuffix] of values) {
      const stat = document.createElement("div");
      if (className) stat.className = className;
      const strong = document.createElement("strong");
      const span = document.createElement("span");
      span.className = "trade-stat-label";
      span.textContent = label;
      stat.append(strong, span);
      setTradeStat(stat, value, label, tradeChain, labelSuffix);
      stats.append(stat);
    }
    const statsBreakdown = document.createElement("div");
    statsBreakdown.className = "trade-stats-breakdown";
    renderStatsBreakdown(statsBreakdown, positions, tradeChain);
    statsWrap.append(stats, statsBreakdown);
    statsWrap.addEventListener("mouseenter", () => {
      if (statsBreakdown.childElementCount) positionTradeStatsBreakdown(statsBreakdown, statsWrap);
    });
    const buy = document.createElement("section");
    buy.className = "trade-block";
    const buyHeading = document.createElement("div");
    buyHeading.className = "trade-heading";
    const buyTitle = document.createElement("strong");
    buyTitle.textContent = context ? `Buy ${shortTarget(context.address)}` : "Buy";
    const buyTools = document.createElement("div");
    buyTools.className = "trade-heading-tools";
    const quote = document.createElement("span");
    quote.textContent = tradeQuickEditing
      ? "Edit amounts"
      : tradeChain ? nativeSymbol(tradeChain) : "Native";
    const quickSettings = document.createElement("button");
    quickSettings.type = "button";
    quickSettings.className = tradeQuickEditing ? "quick-settings active" : "quick-settings";
    quickSettings.setAttribute("aria-label", tradeQuickEditing ? "Save quick amounts" : "Edit quick amounts");
    quickSettings.title = tradeQuickEditing ? "Save quick amounts" : "Edit quick amounts";
    quickSettings.innerHTML = tradeQuickEditing
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.7 1.8h2.6l.4 1.5c.3.1.6.3.9.5l1.5-.5 1.3 2.2-1.1 1.1v1.2l1.1 1.1-1.3 2.2-1.5-.5-.9.5-.4 1.5H6.7l-.4-1.5-.9-.5-1.5.5-1.3-2.2 1.1-1.1V6.6L2.6 5.5l1.3-2.2 1.5.5.9-.5.4-1.5Z"/><circle cx="8" cy="7.2" r="1.8"/></svg>';
    quickSettings.onclick = async () => {
      if (!snapshot || !tradeChain || busy) return;
      if (!tradeQuickEditing) {
        tradeQuickChain = tradeChain;
        const storedQuickAmounts = snapshot.quickAmounts[tradeChain];
        tradeQuickAmounts = Array.from(
          { length: 8 },
          (_, index) => String(storedQuickAmounts[index] ?? 0)
        );
        tradeQuickEditing = true;
        render();
        return;
      }
      const amounts = tradeQuickAmounts.map(finiteNumber);
      if (amounts.some((value) => value === undefined || value < 0) || !amounts.some((value) => (value ?? 0) > 0)) {
        toasts.show("error", "Invalid quick amounts", "Use zero for hidden buttons and keep at least one amount greater than zero.");
        return;
      }
      const chainAmounts = amounts as number[];
      try {
        const response = await request({
          type: "sharp:update-settings",
          patch: {
            quickAmounts: {
              ...snapshot.quickAmounts,
              [tradeQuickChain]: chainAmounts
            }
          }
        });
        if (!response.ok) {
          toasts.show("error", "Quick amounts not saved", response.error);
          return;
        }
        snapshot = response.snapshot ?? {
          ...snapshot,
          quickAmounts: {
            ...snapshot.quickAmounts,
            [tradeQuickChain]: chainAmounts
          }
        };
        tradeQuickEditing = false;
        render();
      } catch (error) {
        toasts.show("error", "Quick amounts not saved", error instanceof Error ? error.message : "The extension request failed.");
      }
    };
    buyTools.append(quote);
    renderManagedWalletPanel(buyTools, "buy");
    buyTools.append(quickSettings);
    buyHeading.append(buyTitle, buyTools);
    const quick = document.createElement("div");
    quick.className = "trade-quick";
    const quickValues = tradeQuickEditing
      ? tradeQuickAmounts
      : (tradeChain
          ? (snapshot?.quickAmounts[tradeChain] ?? []).slice(0, 8).filter((value) => value > 0)
          : []).map(String);
    for (const [index, rawValue] of quickValues.entries()) {
      if (tradeQuickEditing) {
        const input = document.createElement("input");
        input.inputMode = "decimal";
        input.value = rawValue;
        input.setAttribute("aria-label", `Quick buy amount ${index + 1}`);
        input.oninput = () => { tradeQuickAmounts[index] = input.value; };
        quick.append(input);
      } else {
        const value = Number(rawValue);
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = rawValue;
        button.disabled = busy || !tradeChain;
        button.onclick = () => void submitPanelTrade("buy", { mode: "native", value });
        quick.append(button);
      }
    }
    buy.append(buyHeading, quick);
    body.append(buy);

    const sell = document.createElement("section");
    sell.className = "trade-block";
    const sellHeading = document.createElement("div");
    sellHeading.className = "trade-heading";
    const sellTitle = document.createElement("strong");
    sellTitle.textContent = "Sell";
    const sellTools = document.createElement("div");
    sellTools.className = "trade-heading-tools";
    const sellQuote = document.createElement("span");
    sellQuote.textContent = tradeSellQuickEditing ? "Edit percentages" : "Position %";
    const sellQuickSettings = document.createElement("button");
    sellQuickSettings.type = "button";
    sellQuickSettings.className = tradeSellQuickEditing ? "quick-settings active" : "quick-settings";
    sellQuickSettings.setAttribute("aria-label", tradeSellQuickEditing ? "Save quick sell percentages" : "Edit quick sell percentages");
    sellQuickSettings.title = tradeSellQuickEditing ? "Save quick sell percentages" : "Edit quick sell percentages";
    sellQuickSettings.innerHTML = tradeSellQuickEditing
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.7 1.8h2.6l.4 1.5c.3.1.6.3.9.5l1.5-.5 1.3 2.2-1.1 1.1v1.2l1.1 1.1-1.3 2.2-1.5-.5-.9.5-.4 1.5H6.7l-.4-1.5-.9-.5-1.5.5-1.3-2.2 1.1-1.1V6.6L2.6 5.5l1.3-2.2 1.5.5.9-.5.4-1.5Z"/><circle cx="8" cy="7.2" r="1.8"/></svg>';
    sellQuickSettings.onclick = async () => {
      if (!snapshot || !tradeChain || busy) return;
      if (!tradeSellQuickEditing) {
        tradeSellQuickChain = tradeChain;
        tradeSellQuickPercentages = snapshot.quickSellPercentages[tradeChain].map(String);
        tradeSellQuickEditing = true;
        render();
        return;
      }
      const percentages = tradeSellQuickPercentages.map(finiteNumber);
      if (!percentages.length || percentages.some((value) => value === undefined || value <= 0 || value > 100)) {
        toasts.show("error", "Invalid sell percentages", "Every quick-sell percentage must be greater than 0 and at most 100.");
        return;
      }
      const chainPercentages = percentages as number[];
      try {
        const response = await request({
          type: "sharp:update-settings",
          patch: {
            quickSellPercentages: {
              ...snapshot.quickSellPercentages,
              [tradeSellQuickChain]: chainPercentages
            }
          }
        });
        if (!response.ok) {
          toasts.show("error", "Sell percentages not saved", response.error);
          return;
        }
        snapshot = response.snapshot ?? {
          ...snapshot,
          quickSellPercentages: {
            ...snapshot.quickSellPercentages,
            [tradeSellQuickChain]: chainPercentages
          }
        };
        tradeSellQuickEditing = false;
        render();
      } catch (error) {
        toasts.show("error", "Sell percentages not saved", error instanceof Error ? error.message : "The extension request failed.");
      }
    };
    sellTools.append(sellQuote);
    renderManagedWalletPanel(sellTools, "sell");
    sellTools.append(sellQuickSettings);
    sellHeading.append(sellTitle, sellTools);
    const sellQuick = document.createElement("div");
    sellQuick.className = "trade-quick sell";
    const sellQuickValues = tradeSellQuickEditing
      ? tradeSellQuickPercentages
      : (tradeChain ? snapshot?.quickSellPercentages[tradeChain] ?? [] : []).map(String);
    for (const [index, rawValue] of sellQuickValues.entries()) {
      if (tradeSellQuickEditing) {
        const input = document.createElement("input");
        input.inputMode = "decimal";
        input.value = rawValue;
        input.setAttribute("aria-label", `Quick sell percentage ${index + 1}`);
        input.oninput = () => { tradeSellQuickPercentages[index] = input.value; };
        sellQuick.append(input);
      } else {
        const percentage = Number(rawValue);
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${rawValue}%`;
        button.className = tradeSellPercentage === rawValue ? "selected" : "";
        button.disabled = busy || positions.length === 0;
        button.onclick = () => {
          tradeSellPercentage = rawValue;
          void submitPanelTrade("sell", { mode: "percentage", value: percentage });
        };
        sellQuick.append(button);
      }
    }
    const sellInitial = actionButton("Sell initial");
    sellInitial.classList.add("trade-sell-initial");
    const initialPositionsByClient = new Map<string, string[]>();
    for (const { clientId, position } of positionOwners) {
      const id = positionId(position);
      if (!id) continue;
      initialPositionsByClient.set(clientId, [...(initialPositionsByClient.get(clientId) ?? []), id]);
    }
    const positionIds = [...initialPositionsByClient.values()].flat();
    sellInitial.disabled = busy || positionIds.length === 0;
    sellInitial.title = "Sell enough of the current position to recover its initial investment";
    sellInitial.onclick = async () => {
      if (!initialPositionsByClient.size) {
        toasts.show("error", "Sell Initial unavailable", "No open Sharp position is available for this token.");
        return;
      }
      busy = true;
      render();
      try {
        const results = await Promise.all([...initialPositionsByClient].map(async ([clientId, ids]) => ({
          clientId,
          response: await request({
            type: "sharp:sell-initial",
            clientId,
            positionIds: [...new Set(ids)]
          })
        })));
        const failed = results.filter(({ response }) => !response.ok);
        if (!failed.length) {
          toasts.show(
            "success",
            "Sell Initial accepted",
            `${results.length} position module${results.length === 1 ? "" : "s"}: Sent to Sharp`
          );
        } else {
          const firstFailure = failed[0]!.response;
          toasts.show(
            "error",
            failed.length === results.length ? "Sell Initial failed" : "Sell Initial partially failed",
            firstFailure.ok ? "Sharp rejected the request" : firstFailure.error
          );
        }
      } catch (error) {
        toasts.show(
          "error",
          "Sell Initial failed",
          error instanceof Error ? error.message : "The extension request failed."
        );
      } finally {
        busy = false;
        render();
      }
    };
    sell.append(sellHeading, sellQuick, sellInitial);
    body.append(sell);
    body.append(statsWrap);
  };

  const renderMigrationSell = (body: HTMLElement) => {
    const section = document.createElement("div");
    section.className = "sell-automations-tab migration-sell-section";
    const card = document.createElement("div");
    card.className = "automation-card";
    const heading = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = "Migration Sell";
    const status = document.createElement("span");
    status.textContent = migrationSell?.enabled ? "Active" : "Inactive";
    heading.append(name, status);
    const fields = document.createElement("div");
    fields.className = "automation-inputs";
    const migrationPercentInput = document.createElement("input");
    migrationPercentInput.inputMode = "decimal";
    migrationPercentInput.value = migrationSellPercentage;
    migrationPercentInput.placeholder = "Sell %";
    migrationPercentInput.oninput = () => { migrationSellPercentage = migrationPercentInput.value; };
    const migrationDelayInput = document.createElement("input");
    migrationDelayInput.inputMode = "decimal";
    migrationDelayInput.value = migrationSellDelay;
    migrationDelayInput.placeholder = "Delay ms";
    migrationDelayInput.oninput = () => { migrationSellDelay = migrationDelayInput.value; };
    for (const [labelText, input, hintText] of [
      ["Sell position %", migrationPercentInput, "How much of your position to sell"],
      ["Delay (ms)", migrationDelayInput, "Wait after migration before selling"]
    ] as const) {
      const wrap = document.createElement("label");
      wrap.className = "automation-field";
      const label = document.createElement("strong");
      label.textContent = labelText;
      const hint = document.createElement("small");
      hint.textContent = hintText;
      wrap.append(label, input, hint);
      fields.append(wrap);
    }
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = migrationSell?.enabled ? "automation-toggle active" : "automation-toggle";
    toggle.textContent = migrationSell?.enabled ? "Stop" : "Activate";
    toggle.disabled = busy || !selectedClientId || !migrationSell;
    toggle.onclick = async () => {
      if (!migrationSell) return;
      const percentage = finiteNumber(migrationSellPercentage);
      const delayMs = finiteNumber(migrationSellDelay);
      if (percentage === undefined || percentage <= 0 || percentage > 100 || delayMs === undefined || delayMs < 0) {
        toasts.show("error", "Invalid Migration Sell settings", "Sell percentage must be 1 to 100 and delay cannot be negative.");
        return;
      }
      busy = true;
      render();
      const enabled = !migrationSell.enabled;
      try {
        const response = await request({
          type: "sharp:update-migration-sell",
          clientId: selectedClientId,
          settings: {
            enabled,
            percentage,
            delayMs,
            ...(migrationSell.execution ? { execution: migrationSell.execution } : {})
          }
        });
        if (response.ok && response.migrationSell) migrationSell = response.migrationSell;
        showResponse(response, "Migration Sell updated", enabled ? "Migration Sell is active." : "Migration Sell is stopped.");
      } catch (error) {
        toasts.show("error", "Migration Sell failed", error instanceof Error ? error.message : "The extension request failed.");
      } finally {
        busy = false;
        render();
      }
    };
    card.append(heading, fields, toggle);
    section.append(card);
    body.append(section);
  };

  const renderSellAutomations = (body: HTMLElement) => {
    const section = document.createElement("div");
    section.className = "sell-automations-tab";
    const walletListClient = ensureSelectedClient();
    void loadWalletLists();
    const tokenWalletTriggers = walletTradeSellTriggers.filter((trigger) =>
      trigger.chain === context?.chain && trigger.token.toLowerCase() === context?.address.toLowerCase()
    );
    const tokenWalletTrigger = tokenWalletTriggers[0];
    const tokenWalletActive = tokenWalletTriggers.some((trigger) => trigger.enabled);
    const walletExecutionDefaults = tokenWalletTrigger?.execution
      ?? (selectedClientId ? snapshot?.walletTradeSellExecutionByClient[selectedClientId] : undefined)
      ?? (context?.chain ? snapshot?.walletTradeSellExecution[context.chain] : undefined)
      ?? { enabled: false, senders: [] };

    const walletWordlistSelect = document.createElement("select");
    walletWordlistSelect.setAttribute("aria-label", "Watched wallet wordlist");
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = !walletListClient
      ? "Connect a Solana client to load lists"
      : walletWordlistsLoading
        ? "Loading wallet lists…"
        : "No wordlist";
    walletWordlistSelect.append(noneOption);
    for (const list of walletWordlists) {
      const option = document.createElement("option");
      option.value = list.name;
      option.textContent = `${list.name} · ${list.entries.length}`;
      walletWordlistSelect.append(option);
    }
    if (selectedWalletWordlist && !walletWordlists.some((list) => list.name === selectedWalletWordlist)) {
      selectedWalletWordlist = "";
    }
    walletWordlistSelect.value = selectedWalletWordlist;
    walletWordlistSelect.disabled = busy || walletWordlistsLoading || !walletListClient;
    walletWordlistSelect.onchange = () => {
      selectedWalletWordlist = walletWordlistSelect.value;
      render();
    };
    const eventSelect = document.createElement("select");
    eventSelect.setAttribute("aria-label", "Watched wallet event");
    for (const [value, label] of [["buy", "Buys"], ["sell", "Sells"], ["both", "Buys or sells"]] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = (tokenWalletTrigger?.event ?? "both") === value;
      eventSelect.append(option);
    }
    const walletSellPercentage = document.createElement("input");
    walletSellPercentage.inputMode = "decimal";
    walletSellPercentage.value = String(tokenWalletTrigger?.sellPercentage ?? 100);
    walletSellPercentage.placeholder = "Sell %";
    const minimumWatchedSellPercentage = document.createElement("input");
    minimumWatchedSellPercentage.inputMode = "decimal";
    minimumWatchedSellPercentage.value = String(tokenWalletTrigger?.minimumSellPercentage ?? 0);
    minimumWatchedSellPercentage.placeholder = "0";
    const walletCard = document.createElement("div");
    walletCard.className = "automation-card wallet-trade-automation";
    const walletHeading = document.createElement("div");
    const walletTitle = document.createElement("strong");
    walletTitle.textContent = "Wallet Trade Sell";
    const walletStatus = document.createElement("span");
    walletStatus.textContent = tokenWalletActive
      ? (tokenWalletTriggers.length > 1 ? `Active · ${tokenWalletTriggers.length} wallets` : "Active")
      : "Inactive";
    walletHeading.append(walletTitle, walletStatus);
    const walletFields = document.createElement("div");
    walletFields.className = "automation-inputs wallet-trade-fields";
    const appendWalletField = (labelText: string, control: HTMLElement, hintText: string) => {
      const field = document.createElement(control.classList.contains("wallet-address-picker") ? "div" : "label");
      field.className = "automation-field";
      const label = document.createElement("strong");
      label.textContent = labelText;
      const hint = document.createElement("small");
      hint.textContent = hintText;
      field.append(label, control, hint);
      walletFields.append(field);
      return field;
    };
    const parseWalletAddresses = (value: string) => Array.from(new Set(value
      .split(/[\s,;|]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)));
    const walletAddressPicker = document.createElement("div");
    walletAddressPicker.className = "wallet-address-picker";
    const selectedWalletAddresses = parseWalletAddresses(walletSellAddresses);
    if (selectedWalletAddresses.length) {
      const selectedList = document.createElement("div");
      selectedList.className = "wallet-address-chips";
      for (const selectedAddress of selectedWalletAddresses) {
        const chip = document.createElement("span");
        chip.className = "wallet-address-chip";
        chip.title = selectedAddress;
        const addressCopy = document.createElement("span");
        addressCopy.textContent = shortTarget(selectedAddress);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${selectedAddress}`);
        remove.textContent = "×";
        remove.onclick = () => {
          walletSellAddresses = selectedWalletAddresses
            .filter((address) => address !== selectedAddress)
            .join("\n");
          render();
        };
        chip.append(addressCopy, remove);
        selectedList.append(chip);
      }
      walletAddressPicker.append(selectedList);
    }
    const addWallets = document.createElement("button");
    addWallets.type = "button";
    addWallets.className = "wallet-address-add";
    addWallets.innerHTML = selectedWalletAddresses.length
      ? "<strong>+ Add more wallets</strong>"
      : "<strong>+ Add wallets</strong><small>Paste one or multiple addresses</small>";
    addWallets.onclick = () => {
      walletAddressPromptOpen = true;
      walletAddressPromptDraft = "";
      render();
      requestAnimationFrame(() => shadow.querySelector<HTMLTextAreaElement>(".wallet-address-prompt textarea")?.focus());
    };
    walletAddressPicker.append(addWallets);
    if (walletAddressPromptOpen) {
      const prompt = document.createElement("div");
      prompt.className = "wallet-address-prompt";
      const editor = document.createElement("textarea");
      editor.rows = 3;
      editor.placeholder = "Paste wallet addresses, separated by commas or new lines";
      editor.value = walletAddressPromptDraft;
      editor.oninput = () => { walletAddressPromptDraft = editor.value; };
      const appendToList = document.createElement("label");
      appendToList.className = "check-row compact wallet-address-persist";
      const appendToListInput = document.createElement("input");
      appendToListInput.type = "checkbox";
      appendToListInput.disabled = !selectedWalletWordlist || !selectedClientId;
      const appendToListCopy = document.createElement("span");
      appendToListCopy.innerHTML = selectedWalletWordlist
        ? `<strong>Append to ${selectedWalletWordlist}</strong><small>Save these wallets to the selected list now</small>`
        : "<strong>Append to selected file</strong><small>Select a wallet list first</small>";
      appendToList.append(appendToListInput, appendToListCopy);
      const actions = document.createElement("div");
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.onclick = () => {
        walletAddressPromptOpen = false;
        walletAddressPromptDraft = "";
        render();
      };
      const add = document.createElement("button");
      add.type = "button";
      add.className = "primary-inline";
      add.textContent = "Add wallets";
      add.onclick = async () => {
        const additions = parseWalletAddresses(editor.value);
        if (!additions.length) return;
        if (appendToListInput.checked && selectedWalletWordlist && selectedClientId && context?.chain) {
          add.disabled = true;
          cancel.disabled = true;
          editor.disabled = true;
          add.textContent = "Saving…";
          for (const wallet of additions) {
            const appendResponse = await request({
              type: "sharp:append-wallet-list",
              clientId: selectedClientId,
              wallet,
              chain: context.chain,
              file: selectedWalletWordlist
            });
            if (!appendResponse.ok) {
              toasts.show("error", "Wallet list not updated", appendResponse.error);
              add.disabled = false;
              cancel.disabled = false;
              editor.disabled = false;
              add.textContent = "Add wallets";
              return;
            }
            walletWordlists = appendResponse.walletLists ?? walletWordlists;
          }
          walletWordlistsClientId = selectedClientId;
        }
        walletSellAddresses = Array.from(new Set([...selectedWalletAddresses, ...additions])).join("\n");
        walletAddressPromptOpen = false;
        walletAddressPromptDraft = "";
        render();
      };
      actions.append(cancel, add);
      prompt.append(editor, appendToList, actions);
      walletAddressPicker.append(prompt);
    }
    appendWalletField("Wallet list", walletWordlistSelect, "Saved under config/wordlists");
    appendWalletField("Single wallets", walletAddressPicker, "Optional · combined with the selected list");
    appendWalletField("When it", eventSelect, "Trade that triggers your sell");
    appendWalletField("Your position to sell %", walletSellPercentage, "How much of your position to sell");
    const minimumSellField = appendWalletField(
      "Minimum watched-wallet sell %",
      minimumWatchedSellPercentage,
      "Ignore smaller sells · 0 disables the filter"
    );
    minimumSellField.classList.add("wallet-minimum-sell-field");
    const syncMinimumSellVisibility = () => {
      minimumSellField.hidden = eventSelect.value === "buy";
    };
    eventSelect.onchange = syncMinimumSellVisibility;
    syncMinimumSellVisibility();
    const walletExecution = document.createElement("details");
    walletExecution.className = "wallet-trade-execution";
    const walletExecutionSummary = document.createElement("summary");
    walletExecutionSummary.textContent = "Execution";
    const walletExecutionBody = document.createElement("div");
    walletExecutionBody.className = "wallet-trade-execution-body";
    const executionMode = document.createElement("select");
    executionMode.setAttribute("aria-label", "Wallet Trade Sell execution mode");
    for (const [value, label] of [["preset", "Trading preset"], ["custom", "Custom"]] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = (walletExecutionDefaults.enabled ? "custom" : "preset") === value;
      executionMode.append(option);
    }
    const walletSenderGrid = document.createElement("div");
    walletSenderGrid.className = "wallet-trade-senders";
    const selectedWalletSenders = new Set<SolanaSender>(walletExecutionDefaults.senders);
    for (const sender of solanaSenders) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = sender;
      button.classList.toggle("active", selectedWalletSenders.has(sender));
      button.onclick = () => {
        if (selectedWalletSenders.has(sender)) selectedWalletSenders.delete(sender);
        else selectedWalletSenders.add(sender);
        button.classList.toggle("active", selectedWalletSenders.has(sender));
      };
      walletSenderGrid.append(button);
    }
    walletSenderGrid.hidden = context?.chain !== "solana";
    const walletPriorityFee = document.createElement("input");
    walletPriorityFee.inputMode = "decimal";
    walletPriorityFee.placeholder = context?.chain === "solana" ? "Priority fee (SOL)" : "Priority fee";
    walletPriorityFee.value = walletExecutionDefaults.priorityFee?.toString() ?? "";
    const walletTip = document.createElement("input");
    walletTip.inputMode = "decimal";
    walletTip.placeholder = "Relay tip (SOL)";
    walletTip.value = walletExecutionDefaults.tip?.toString() ?? "";
    walletTip.hidden = context?.chain !== "solana";
    const walletCustomExecution = document.createElement("div");
    walletCustomExecution.className = "wallet-trade-custom-execution";
    walletCustomExecution.append(walletSenderGrid, walletPriorityFee, walletTip);
    const syncWalletExecutionMode = () => {
      walletCustomExecution.hidden = executionMode.value !== "custom";
    };
    executionMode.onchange = syncWalletExecutionMode;
    syncWalletExecutionMode();
    walletExecutionBody.append(executionMode, walletCustomExecution);
    walletExecution.append(walletExecutionSummary, walletExecutionBody);
    const walletToggle = document.createElement("button");
    walletToggle.type = "button";
    walletToggle.className = tokenWalletActive ? "automation-toggle active" : "automation-toggle";
    walletToggle.textContent = tokenWalletActive ? "Stop" : "Activate";
    walletToggle.disabled = busy || !selectedClientId;
    walletToggle.onclick = async () => {
      const token = context?.address;
      const chain = context?.chain;
      if (!token || !chain) return;
      const otherTriggers = walletTradeSellTriggers.filter((trigger) =>
        trigger.chain !== chain || trigger.token.toLowerCase() !== token.toLowerCase()
      );
      let triggers: WalletTradeSellTrigger[];
      if (tokenWalletActive) {
        triggers = otherTriggers;
      } else {
        const wordlist = walletWordlists.find((list) => list.name === selectedWalletWordlist);
        const singleWallets = parseWalletAddresses(walletSellAddresses);
        const wallets = Array.from(new Set([
          ...(wordlist?.entries ?? []).map((entry) => entry.trim()),
          ...singleWallets
        ].filter(Boolean)));
        const sellPercentage = finiteNumber(walletSellPercentage.value);
        const minimumSellPercentage = finiteNumber(minimumWatchedSellPercentage.value);
        const priorityFee = finiteNumber(walletPriorityFee.value);
        const tip = finiteNumber(walletTip.value);
        if (wallets.length === 0) {
          toasts.show("error", "No wallets to watch", "Choose a wallet list or enter at least one wallet address.");
          return;
        }
        if (sellPercentage === undefined || sellPercentage <= 0 || sellPercentage > 100) {
          toasts.show("error", "Invalid Wallet Trade Sell settings", "Enter a sell percentage from 1 to 100.");
          return;
        }
        if (minimumSellPercentage === undefined || minimumSellPercentage < 0 || minimumSellPercentage > 100) {
          toasts.show("error", "Invalid watched-wallet threshold", "Enter a minimum sell percentage from 0 to 100.");
          return;
        }
        if ((walletPriorityFee.value.trim() && (priorityFee === undefined || priorityFee < 0))
          || (walletTip.value.trim() && (tip === undefined || tip < 0))) {
          toasts.show("error", "Invalid execution settings", "Fees and tips must be zero or greater.");
          return;
        }
        if (chain === "solana" && executionMode.value === "custom" && selectedWalletSenders.size === 0) {
          toasts.show("error", "Invalid execution settings", "Select at least one sender or use the trading preset.");
          return;
        }
        if (otherTriggers.length + wallets.length > 50) {
          toasts.show("error", "Too many watched wallets", "Sharp supports at most 50 watched-wallet triggers per client.");
          return;
        }
        const execution: WalletTradeSellTrigger["execution"] = {
          enabled: executionMode.value === "custom",
          senders: chain === "solana" ? [...selectedWalletSenders] : [],
          ...(walletPriorityFee.value.trim() && priorityFee !== undefined ? { priorityFee } : {}),
          ...(chain === "solana" && walletTip.value.trim() && tip !== undefined ? { tip } : {})
        };
        const existingByWallet = new Map(
          tokenWalletTriggers.map((trigger) => [trigger.wallet.toLowerCase(), trigger] as const)
        );
        triggers = [
          ...otherTriggers,
          ...wallets.map((wallet): WalletTradeSellTrigger => ({
            id: existingByWallet.get(wallet.toLowerCase())?.id ?? crypto.randomUUID(),
            enabled: true,
            chain,
            wallet,
            token,
            event: eventSelect.value as WalletTradeSellTrigger["event"],
            minimumSellPercentage: eventSelect.value === "buy" ? 0 : minimumSellPercentage,
            sellPercentage,
            execution
          }))
        ];
      }
      const enabled = !tokenWalletActive;
      busy = true;
      render();
      try {
        const response = await request({
          type: "sharp:update-wallet-trade-sell-triggers",
          clientId: selectedClientId,
          triggers
        });
        if (response.ok) {
          walletTradeSellTriggers = response.walletTradeSellTriggers ?? triggers;
          walletTradeSellTriggersClientId = selectedClientId;
        }
        showResponse(response, "Wallet Trade Sell updated", enabled ? "Wallet Trade Sell is active." : "Wallet Trade Sell is stopped.");
      } catch (error) {
        toasts.show("error", "Wallet Trade Sell failed", error instanceof Error ? error.message : "The extension request failed.");
      } finally {
        busy = false;
        render();
      }
    };
    walletCard.append(walletHeading, walletFields, walletExecution, walletToggle);
    section.append(walletCard);
    body.append(section);
  };

  const positionAutosellSettings = (position: SharpPosition): PositionAutosellSettings => {
    const record = position as Record<string, unknown>;
    const additional = (position.additionalData ?? record.additional_data ?? {}) as Record<string, unknown>;
    const rawSettings = additional.autosell_settings ?? additional.autosellSettings;
    if (typeof rawSettings === "object" && rawSettings !== null) {
      const values = rawSettings as Record<string, unknown>;
      return {
        tpsl: typeof values.tpsl === "string" && values.tpsl ? values.tpsl : "PRESET",
        sl: typeof values.sl === "string" && values.sl ? values.sl : "PRESET",
        tsl: typeof values.tsl === "string" && values.tsl ? values.tsl : "PRESET"
      };
    }
    const triggers = typeof record.triggers === "object" && record.triggers !== null
      ? record.triggers as Record<string, unknown>
      : {};
    const selected = (key: string) => typeof triggers[key] === "string" && triggers[key]
      ? triggers[key] as string
      : "PRESET";
    return {
      tpsl: selected("TPSL_PRESET"),
      sl: selected("SL_PRESET"),
      tsl: selected("TSL_PRESET")
    };
  };

  const renderPositionAutosell = (body: HTMLElement) => {
    const client = ensureSelectedClient();
    if (!client || !context) {
      const hint = document.createElement("p");
      hint.textContent = "Open a token and connect a Sharp trading client to configure Auto Sell.";
      body.append(hint);
      return;
    }
    const panelContext = context;
    const inventory = managedWalletsByClient.get(client.endpointId);
    const savedPlan = snapshot?.walletPlansByClient?.[client.endpointId];
    const livePositions = currentPositionOwners()
      .filter((owner) => owner.clientId === client.endpointId);
    const walletNames = savedPlan?.allocations.map((allocation) => allocation.walletName) ?? [];
    for (const { position } of livePositions) {
      const name = positionWalletLabel(position);
      if (!walletNames.includes(name)) walletNames.push(name);
    }
    if (!walletNames.length) {
      const activeAddress = client.capabilities?.wallet?.address?.toLowerCase();
      const active = inventory?.wallets.find((wallet) => wallet.address.toLowerCase() === activeAddress);
      if (active) walletNames.push(active.name);
    }

    const header = document.createElement("div");
    header.className = "autosell-head";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Position Auto Sell";
    const subtitle = document.createElement("span");
    subtitle.textContent = "CLI setups · saved per wallet";
    copy.append(title, subtitle);
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "refresh-clients";
    reload.title = "Reload setups from CLI files";
    reload.setAttribute("aria-label", "Reload Auto Sell setups");
    reload.textContent = "↻";
    reload.onclick = () => void loadAutosellPresets(true);
    header.append(copy, reload);
    body.append(header);

    if (!walletNames.length) {
      const empty = document.createElement("p");
      empty.textContent = "Select a buy wallet in Trade first.";
      body.append(empty);
      return;
    }

    const appendOptions = (select: HTMLSelectElement, names: string[], value: string, mixed = false) => {
      select.className = "autosell-select";
      select.onfocus = () => { autosellControlFocused = true; };
      select.onblur = () => { autosellControlFocused = false; };
      if (mixed) {
        const option = document.createElement("option");
        option.value = "__MIXED__";
        option.textContent = "Mixed";
        option.disabled = true;
        select.append(option);
      }
      for (const [optionValue, label] of [["PRESET", "Preset"], ["DISABLED", "Off"]] as const) {
        const option = document.createElement("option");
        option.value = optionValue;
        option.textContent = label;
        select.append(option);
      }
      for (const name of names) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        select.append(option);
      }
      if (![...select.options].some((option) => option.value === value)) {
        const missing = document.createElement("option");
        missing.value = value;
        missing.textContent = `${value} (missing)`;
        select.append(missing);
      }
      select.value = value;
    };

    const settingsForWallet = (walletName: string) => {
      const allocation = savedPlan?.allocations.find((item) => item.walletName === walletName);
      const livePosition = livePositions.find(({ position }) => positionWalletLabel(position) === walletName)?.position;
      return allocation?.autosell ?? (livePosition ? positionAutosellSettings(livePosition) : defaultPositionAutosell());
    };

    const persistSettings = async (
      updates: Map<string, PositionAutosellSettings>,
      updatedGroup?: ManagedWalletGroup
    ) => {
      if (busy || !updates.size) return;
      const basePlan = savedPlan ?? { allocations: [] };
      const allocations = [...basePlan.allocations];
      for (const [walletName, settings] of updates) {
        const index = allocations.findIndex((item) => item.walletName === walletName);
        if (index >= 0) {
          const walletAddress = inventory?.wallets.find((wallet) => wallet.name === walletName)?.address;
          allocations[index] = {
            ...allocations[index]!,
            ...(walletAddress ? { walletAddress } : {}),
            autosell: settings
          };
        }
        else allocations.push({
          walletName,
          ...(inventory?.wallets.find((wallet) => wallet.name === walletName)?.address
            ? { walletAddress: inventory.wallets.find((wallet) => wallet.name === walletName)!.address }
            : {}),
          weight: 1,
          autosell: settings
        });
      }
      const nextPlan: WalletExecutionPlan = {
        ...basePlan,
        allocations,
        ...(updatedGroup ? { groupId: updatedGroup.id } : {})
      };
      busy = true;
      render();
      try {
        if (updatedGroup && inventory) {
          const groupResponse = await request({
            type: "sharp:update-wallet-groups",
            clientId: client.endpointId,
            groups: inventory.groups.map((group) => group.id === updatedGroup.id ? updatedGroup : group)
          });
          if (!groupResponse.ok) throw new Error(groupResponse.error);
          if (groupResponse.managedWallets) managedWalletsByClient.set(client.endpointId, groupResponse.managedWallets);
        }
        const planResponse = await request({
          type: "sharp:update-wallet-plan",
          clientId: client.endpointId,
          action: "buy",
          plan: nextPlan
        });
        if (!planResponse.ok) throw new Error(planResponse.error);
        if (planResponse.snapshot) snapshot = planResponse.snapshot;
        const liveUpdates = [...updates].filter(([walletName]) =>
          livePositions.some(({ position }) => positionWalletLabel(position) === walletName)
        );
        const liveResults = await Promise.allSettled(liveUpdates.map(async ([walletName, settings]) => {
          const positionResponse = await request({
            type: "sharp:update-position-autosell",
            clientId: client.endpointId,
            context: panelContext,
            walletName,
            settings
          });
          if (!positionResponse.ok) throw new Error(`${walletName}: ${positionResponse.error}`);
          return positionResponse.positions;
        }));
        const liveUpdated = liveResults.filter((result) => result.status === "fulfilled").length;
        const liveFailures = liveResults.flatMap((result) =>
          result.status === "rejected"
            ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
            : []
        );
        if (liveUpdates.length) {
          const refreshedPositions = await request({
            type: "sharp:get-positions",
            clientId: client.endpointId
          });
          if (refreshedPositions.ok && refreshedPositions.positions) {
            positionsByClient.set(client.endpointId, refreshedPositions.positions);
          }
        }
        const scope = updates.size === 1 ? [...updates.keys()][0]! : `${updates.size} wallets`;
        if (liveFailures.length) {
          toasts.show(
            "error",
            "Auto Sell partially updated",
            `${scope} saved for next buys; ${liveUpdated}/${liveUpdates.length} current positions updated. ${liveFailures.join(" · ")}`
          );
        } else {
          toasts.show("success", "Auto Sell updated", `${scope} · next buys${liveUpdated ? " + current positions" : ""}`);
        }
      } catch (error) {
        toasts.show("error", "Auto Sell not updated", error instanceof Error ? error.message : "The extension request failed.");
      } finally {
        busy = false;
        autosellControlFocused = false;
        render();
      }
    };

    if (inventory?.groups.length) {
      if (selectedAutosellGroupId && !inventory.groups.some((group) => group.id === selectedAutosellGroupId)) {
        selectedAutosellGroupId = "";
      }
      const bundleScope = document.createElement("div");
      bundleScope.className = "autosell-bundle-scope";
      const bundleLabel = document.createElement("span");
      bundleLabel.textContent = "Apply bundle";
      const bundleGroups = document.createElement("div");
      bundleGroups.className = "wallet-groups autosell-groups";
      const scopes: Array<[string, string]> = [["", "Current"]];
      for (const group of inventory.groups) scopes.push([group.id, group.name]);
      for (const [id, label] of scopes) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.classList.toggle("selected", selectedAutosellGroupId === id);
        button.onclick = () => {
          selectedAutosellGroupId = id;
          render();
        };
        bundleGroups.append(button);
      }
      bundleScope.append(bundleLabel, bundleGroups);
      body.append(bundleScope);

      const selectedGroup = inventory.groups.find((group) => group.id === selectedAutosellGroupId);
      const targetNames = selectedGroup?.wallets ?? walletNames;
      const targetSettings = targetNames.map(settingsForWallet);
      const commonValue = (key: keyof PositionAutosellSettings) => {
        const first = targetSettings[0]?.[key] ?? "PRESET";
        return targetSettings.every((settings) => settings[key] === first) ? first : "__MIXED__";
      };
      const bundleEnabled = targetSettings.map((settings) => Object.values(settings).some((value) => value !== "DISABLED"));
      const bundleRow = document.createElement("div");
      bundleRow.className = "autosell-bundle-row";
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = bundleEnabled.every(Boolean);
      enabled.indeterminate = bundleEnabled.some(Boolean) && !bundleEnabled.every(Boolean);
      enabled.title = "Enable or disable Auto Sell for this bundle";
      enabled.onchange = () => {
        const fallback = selectedGroup?.autosell ?? defaultPositionAutosell();
        const settings = enabled.checked ? fallback : { tpsl: "DISABLED", sl: "DISABLED", tsl: "DISABLED" };
        const updates = new Map(targetNames.map((walletName) => [walletName, settings]));
        const group = selectedGroup ? {
          ...selectedGroup,
          autosell: fallback,
          autosellWallets: enabled.checked ? [...selectedGroup.wallets] : []
        } : undefined;
        void persistSettings(updates, group);
      };
      const bundleName = document.createElement("strong");
      bundleName.textContent = selectedGroup?.name ?? "Current wallets";
      const bundleSelects = (["tpsl", "sl", "tsl"] as const).map((key) => {
        const select = document.createElement("select");
        const value = commonValue(key);
        appendOptions(select, autosellPresets[key], value, value === "__MIXED__");
        select.onchange = () => {
          if (select.value === "__MIXED__") return;
          const updates = new Map(targetNames.map((walletName) => [
            walletName,
            { ...settingsForWallet(walletName), [key]: select.value }
          ]));
          const first = updates.values().next().value ?? defaultPositionAutosell();
          const group = selectedGroup ? {
            ...selectedGroup,
            autosell: { ...(selectedGroup.autosell ?? first), [key]: select.value },
            autosellWallets: selectedGroup.autosellWallets ?? [...selectedGroup.wallets]
          } : undefined;
          void persistSettings(updates, group);
        };
        return select;
      });
      bundleRow.append(enabled, bundleName, ...bundleSelects);
      body.append(bundleRow);
    }

    const table = document.createElement("div");
    table.className = "autosell-table";
    const labels = document.createElement("div");
    labels.className = "autosell-labels";
    for (const label of ["", "Wallet", "TP / SL", "SL", "TSL"]) {
      const span = document.createElement("span");
      span.textContent = label;
      labels.append(span);
    }
    table.append(labels);

    for (const walletName of walletNames) {
      const livePosition = livePositions.find(({ position }) => positionWalletLabel(position) === walletName)?.position;
      const current = settingsForWallet(walletName);
      const row = document.createElement("div");
      row.className = "autosell-row";
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = Object.values(current).some((value) => value !== "DISABLED");
      enabled.title = `Enable or disable Auto Sell for ${walletName}`;
      const name = document.createElement("strong");
      name.textContent = walletName;
      name.title = inventory?.wallets.find((wallet) => wallet.name === walletName)?.address ?? walletName;
      if (livePosition) name.dataset.live = "";
      const tpsl = document.createElement("select");
      const sl = document.createElement("select");
      const tsl = document.createElement("select");
      appendOptions(tpsl, autosellPresets.tpsl, current.tpsl);
      appendOptions(sl, autosellPresets.sl, current.sl);
      appendOptions(tsl, autosellPresets.tsl, current.tsl);
      const save = async () => {
        const settings = { tpsl: tpsl.value, sl: sl.value, tsl: tsl.value };
        const selectedGroup = inventory?.groups.find((group) =>
          group.id === selectedAutosellGroupId && group.wallets.includes(walletName)
        );
        const updatedGroup = selectedGroup ? {
          ...selectedGroup,
          autosellWallets: [...new Set([...(selectedGroup.autosellWallets ?? selectedGroup.wallets), walletName])]
        } : undefined;
        await persistSettings(new Map([[walletName, settings]]), updatedGroup);
      };
      enabled.onchange = () => {
        const group = inventory?.groups.find((candidate) =>
          candidate.id === selectedAutosellGroupId && candidate.wallets.includes(walletName)
        );
        const fallback = group?.autosell ?? defaultPositionAutosell();
        const settings = enabled.checked ? fallback : { tpsl: "DISABLED", sl: "DISABLED", tsl: "DISABLED" };
        const selected = new Set(group?.autosellWallets ?? group?.wallets ?? []);
        if (enabled.checked) selected.add(walletName);
        else selected.delete(walletName);
        const updatedGroup = group ? { ...group, autosellWallets: [...selected] } : undefined;
        void persistSettings(new Map([[walletName, settings]]), updatedGroup);
      };
      tpsl.onchange = () => void save();
      sl.onchange = () => void save();
      tsl.onchange = () => void save();
      row.append(enabled, name, tpsl, sl, tsl);
      table.append(row);
    }
    body.append(table);
  };

  const renderMigration = (body: HTMLElement) => {
    const token = document.createElement("div");
    token.className = "context";
    const title = document.createElement("span");
    title.textContent = context?.addressKind === "pool" ? "Axiom pool" : "Resolved mint";
    const address = document.createElement("strong");
    address.textContent = context?.chain === "solana"
      ? `${context.address.slice(0, 7)}…${context.address.slice(-6)}`
      : "Open a Solana token page";
    if (context?.chain === "solana") address.title = context.address;
    token.append(title, address);
    body.append(token);
    const subtabs = document.createElement("div");
    subtabs.className = "migration-subtabs";
    for (const [value, label] of [["sell", "Sell"], ["buy", "Buy"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = migrationSubtab === value ? "active" : "";
      button.textContent = label;
      button.setAttribute("aria-pressed", String(migrationSubtab === value));
      button.onclick = () => {
        if (migrationSubtab === value) return;
        migrationSubtab = value;
        render();
      };
      subtabs.append(button);
    }
    body.append(subtabs);
    if (migrationSubtab === "sell") {
      renderMigrationSell(body);
      return;
    }
    void loadDevLists();
    const creator = context?.creator?.trim();
    const creatorActions = document.createElement("details");
    creatorActions.className = "creator-actions";
    creatorActions.open = migrationDeveloperOpen;
    creatorActions.ontoggle = () => { migrationDeveloperOpen = creatorActions.open; };
    const creatorContext = document.createElement("summary");
    const creatorLabel = document.createElement("span");
    creatorLabel.textContent = "Developer";
    const creatorValue = document.createElement("strong");
    creatorValue.textContent = creator
      ? `${creator.slice(0, 7)}…${creator.slice(-6)}`
      : context?.creatorStatus === "resolving" ? "Resolving…" : "Unavailable";
    if (creator) creatorValue.title = creator;
    if (!creator && context?.creatorError) creatorValue.title = context.creatorError;
    creatorContext.append(creatorLabel, creatorValue);
    creatorActions.append(creatorContext);
    const buttons = document.createElement("div");
    const watch = document.createElement("button");
    watch.type = "button";
    watch.className = "secondary-action";
    watch.textContent = "Watch dev";
    watch.disabled = busy || !selectedClientId || !creator;
    watch.onclick = async () => {
      if (!selectedClientId || !creator || busy) return;
      busy = true;
      render();
      try {
        const response = await request({
          type: "sharp:create-task",
          clientId: selectedClientId,
          taskType: "dev",
          target: creator,
          lifecycle: "both",
          arm: true
        });
        if (response.ok) {
          tasks = response.tasks ?? [];
          tasksClientId = selectedClientId;
        }
        showResponse(response, "Developer watch started", `${shortTarget(creator)} will be watched for future launches.`);
      } catch (error) {
        toasts.show("error", "Developer watch failed", error instanceof Error ? error.message : "The extension request failed.");
      } finally {
        busy = false;
        render();
      }
    };
    const listField = document.createElement("label");
    listField.className = "field compact-field";
    const listLabel = document.createElement("span");
    listLabel.textContent = "Developer wordlist";
    const listSelect = document.createElement("select");
    const availableLists: DevWordlist[] = devLists.length
      ? devLists
      : [
          { name: "dev_blacklist.txt", mode: "blacklist", entries: [] },
          { name: "dev_whitelist.txt", mode: "whitelist", entries: [] }
        ];
    for (const list of availableLists) {
      const option = document.createElement("option");
      option.value = list.name;
      option.textContent = `${list.mode === "blacklist" ? "Blacklist" : "Whitelist"} · ${list.name}`;
      listSelect.append(option);
    }
    if (!availableLists.some((list) => list.name === selectedDevList)) {
      selectedDevList = availableLists[0]!.name;
    }
    listSelect.value = selectedDevList;
    listSelect.disabled = busy || devListsLoading;
    listSelect.onchange = () => {
      selectedDevList = listSelect.value;
      render();
    };
    listField.append(listLabel, listSelect);
    creatorActions.append(listField);

    const addToList = document.createElement("button");
    addToList.type = "button";
    const selectedList = availableLists.find((list) => list.name === selectedDevList)!;
    addToList.className = selectedList.mode === "blacklist" ? "danger-action" : "secondary-action";
    addToList.textContent = "Add to list";
    addToList.disabled = busy || !selectedClientId || !creator;
    addToList.onclick = async () => {
      if (!selectedClientId || !creator || busy) return;
      busy = true;
      render();
      try {
        const response = await request({
          type: "sharp:update-dev-list",
          clientId: selectedClientId,
          creator,
          mode: selectedList.mode,
          file: selectedList.name
        });
        showResponse(
          response,
          selectedList.mode === "blacklist" ? "Developer blacklisted" : "Developer whitelisted",
          `${shortTarget(creator)} was saved to ${selectedList.name} and the active preset.`
        );
      } catch (error) {
        toasts.show("error", "Developer list update failed", error instanceof Error ? error.message : "The extension request failed.");
      } finally {
        busy = false;
        render();
      }
    };
    buttons.append(watch, addToList);
    creatorActions.append(buttons);
    body.append(creatorActions);
    const amount = inputField("Buy amount", "Preset amount", "decimal");
    amount.input.value = migrationAmount;
    amount.input.oninput = () => { migrationAmount = amount.input.value; };
    body.append(amount.wrap);
    const executionDefaults = snapshot?.automationExecution ?? { senders: [], senderOverrides: {} };
    const execution = document.createElement("details");
    execution.className = "execution-panel";
    execution.open = migrationCustomExecution;
    const executionSummary = document.createElement("summary");
    const defaultParts = [
      executionDefaults.senders.length
        ? `${executionDefaults.senders.length} sender${executionDefaults.senders.length === 1 ? "" : "s"}`
        : "preset senders",
      executionDefaults.priorityFee === undefined ? "" : `${executionDefaults.priorityFee} priority`,
      executionDefaults.tip === undefined ? "" : `${executionDefaults.tip} tip`
    ].filter(Boolean);
    executionSummary.textContent = `Execution · ${defaultParts.join(" · ")}`;
    execution.append(executionSummary);
    const customToggle = document.createElement("label");
    customToggle.className = "check-row compact";
    const customInput = document.createElement("input");
    customInput.type = "checkbox";
    customInput.checked = migrationCustomExecution;
    const customCopy = document.createElement("span");
    customCopy.innerHTML = "<strong>Override for this task</strong><small>Otherwise extension defaults are used</small>";
    customInput.onchange = () => {
      migrationCustomExecution = customInput.checked;
      if (migrationCustomExecution &&
        !migrationPriorityFee &&
        !migrationTip &&
        migrationSenders.length === 0) {
        migrationPriorityFee = executionDefaults.priorityFee?.toString() ?? "";
        migrationTip = executionDefaults.tip?.toString() ?? "";
        migrationSenders = [...executionDefaults.senders];
      }
      render();
    };
    customToggle.append(customInput, customCopy);
    execution.append(customToggle);
    if (migrationCustomExecution) {
      const senderGrid = document.createElement("div");
      senderGrid.className = "sender-grid";
      for (const sender of solanaSenders) {
        const label = document.createElement("label");
        label.className = migrationSenders.includes(sender) ? "sender-chip selected" : "sender-chip";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = migrationSenders.includes(sender);
        input.onchange = () => {
          migrationSenders = input.checked
            ? [...new Set([...migrationSenders, sender])]
            : migrationSenders.filter((item) => item !== sender);
          label.classList.toggle("selected", input.checked);
        };
        const text = document.createElement("span");
        text.textContent = senderLabels[sender];
        label.append(input, text);
        senderGrid.append(label);
      }
      execution.append(senderGrid);
      const feeGrid = document.createElement("div");
      feeGrid.className = "field-grid";
      const priority = inputField("Priority fee (SOL)", "Preset", "decimal");
      priority.input.value = migrationPriorityFee;
      priority.input.oninput = () => { migrationPriorityFee = priority.input.value; };
      const tip = inputField("Relay tip (SOL)", "Preset", "decimal");
      tip.input.value = migrationTip;
      tip.input.oninput = () => { migrationTip = tip.input.value; };
      feeGrid.append(priority.wrap, tip.wrap);
      execution.append(feeGrid);
      const customHint = document.createElement("p");
      customHint.textContent = migrationSenders.length
        ? "Only selected senders run. Empty fee fields inherit the Sharp preset."
        : "No senders selected means inherit the Sharp preset's enabled senders.";
      execution.append(customHint);
    }
    body.append(execution);
    const hint = document.createElement("p");
    hint.textContent = context?.addressKind === "pool"
      ? "Resolving this pool to its underlying mint before a migration watch can be started."
      : "Starts a one-shot buy for this token's migration. Leave amount empty to use the active preset.";
    body.append(hint);
    const button = actionButton("Start migration buy");
    button.disabled = button.disabled ||
      !selectedClientId ||
      context?.chain !== "solana" ||
      context.addressKind === "pool";
    button.onclick = async () => {
      if (!context || context.chain !== "solana" || !selectedClientId) return;
      const amountRaw = amount.input.value.trim();
      migrationAmount = amount.input.value;
      const amountValue = amountRaw ? Number(amountRaw) : undefined;
      if (amountValue !== undefined && (!Number.isFinite(amountValue) || amountValue <= 0)) {
        toasts.show("error", "Migration Buy failed", "Enter a positive amount or leave it empty to use the preset.");
        return;
      }
      const parseExecutionValue = (raw: string, label: string) => {
        if (!raw.trim()) return undefined;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be zero or greater.`);
        return parsed;
      };
      let priorityFee: number | undefined;
      let tipValue: number | undefined;
      try {
        priorityFee = migrationCustomExecution
          ? parseExecutionValue(migrationPriorityFee, "Priority fee")
          : undefined;
        tipValue = migrationCustomExecution
          ? parseExecutionValue(migrationTip, "Relay tip")
          : undefined;
      } catch (error) {
        toasts.show("error", "Migration Buy failed", error instanceof Error ? error.message : "Invalid execution override.");
        return;
      }
      busy = true;
      render();
      try {
        const response = await request({
          type: "sharp:create-task",
          clientId: selectedClientId,
          taskType: "mint",
          target: context.address,
          lifecycle: "migration",
          arm: true,
          ...(amountValue === undefined ? {} : { amount: amountValue }),
          ...(migrationCustomExecution ? {
            options: {
              useExtensionDefaults: false,
              senders: migrationSenders,
              ...(priorityFee === undefined ? {} : { priorityFee }),
              ...(tipValue === undefined ? {} : { tip: tipValue })
            }
          } : {})
        });
        if (response.ok) {
          tasks = response.tasks ?? [];
          tasksClientId = selectedClientId;
        }
        showResponse(response, "Migration Buy started", `${context.address.slice(0, 7)}…${context.address.slice(-6)} is being watched.`);
      } catch (error) {
        toasts.show("error", "Migration Buy failed", error instanceof Error ? error.message : "The extension request failed.");
      } finally {
        busy = false;
        render();
      }
    };
    body.append(button);
    renderTaskList(body, "mint_spam");
  };

  const renderDevBuy = (body: HTMLElement) => {
    const editor = document.createElement("section");
    editor.className = "snipe-editor";
    const heading = document.createElement("div");
    heading.className = "task-heading";
    const title = document.createElement("strong");
    title.textContent = "New snipe tasks";
    const addControls = document.createElement("div");
    addControls.className = "add-task";
    const kindSelect = document.createElement("select");
    for (const [value, label] of [
      ["dev", "Dev"],
      ["ticker", "Ticker"],
      ["spam", "Spam"]
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      kindSelect.append(option);
    }
    kindSelect.setAttribute("aria-label", "New snipe task type");
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "+";
    add.title = "Add snipe task";
    add.onclick = () => {
      snipeDrafts.push(newSnipeDraft(kindSelect.value as SnipeDraftKind));
      render();
    };
    addControls.append(kindSelect, add);
    heading.append(title, addControls);
    editor.append(heading);

    if (snipeDrafts.length === 0) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "empty-add";
      empty.innerHTML = "<strong>+ Add a snipe task</strong><span>Dev wallet, ticker, or known-mint spam</span>";
      empty.onclick = () => {
        snipeDrafts.push(newSnipeDraft("dev"));
        render();
      };
      editor.append(empty);
    }

    const numberValue = (
      value: string,
      label: string,
      { optional = true, min = 0, max }: { optional?: boolean; min?: number; max?: number } = {}
    ) => {
      if (!value.trim() && optional) return undefined;
      const number = Number(value);
      if (!Number.isFinite(number) || number < min || (max !== undefined && number > max)) {
        throw new Error(`${label} must be ${min === 0 ? "zero or greater" : `at least ${min}`}${max === undefined ? "" : ` and at most ${max}`}.`);
      }
      return number;
    };

    const draftField = (
      draft: SnipeDraft,
      key: keyof SnipeDraft,
      label: string,
      placeholder: string,
      inputMode: "text" | "decimal" = "text"
    ) => {
      const field = inputField(label, placeholder, inputMode);
      field.input.value = String(draft[key]);
      field.input.oninput = () => {
        (draft as unknown as Record<string, string>)[key] = field.input.value;
      };
      return field.wrap;
    };

    const pagePresetFor = (draft: SnipeDraft): { label: string; value: string } | undefined => {
      if (draft.kind === "dev" && context?.creator) {
        return { label: "Use current developer", value: context.creator };
      }
      if (
        draft.kind === "spam"
        && context?.chain === "solana"
        && context.addressKind !== "pool"
      ) {
        return { label: "Use current token", value: context.address };
      }
      if (draft.kind === "ticker" && context?.symbol) {
        return { label: "Use current ticker", value: context.symbol };
      }
      return undefined;
    };

    const submitDraft = async (draft: SnipeDraft) => {
      if (!selectedClientId || busy) return;
      const target = draft.target.trim();
      if (!target) {
        toasts.show(
          "error",
          "Snipe task failed",
          draft.kind === "dev" ? "Enter the developer's Solana wallet." :
            draft.kind === "ticker" ? "Enter a ticker." : "Enter the known token mint."
        );
        return;
      }
      try {
        const amount = numberValue(draft.amount, "Buy amount", { min: Number.MIN_VALUE });
        const priorityFee = numberValue(draft.priorityFee, "Priority fee");
        const tip = numberValue(draft.tip, "Tip");
        const slippage = numberValue(draft.slippage, "Slippage", { max: 100 });
        const startDelaySeconds = draft.kind === "spam"
          ? numberValue(draft.startDelaySeconds, "Start delay", { optional: false })
          : undefined;
        const transactionsPerSecond = draft.kind === "spam"
          ? numberValue(draft.transactionsPerSecond, "TPS", { optional: false, min: Number.MIN_VALUE })
          : undefined;
        const stopAfterSeconds = draft.kind === "spam"
          ? numberValue(draft.stopAfterSeconds, "Spam duration", { optional: false, min: 1, max: 86_400 })
          : undefined;
        const maxTotalFeesSol = draft.kind === "spam"
          ? numberValue(draft.maxTotalFeesSol, "Maximum fees", { optional: false, min: Number.MIN_VALUE, max: 100 })
          : undefined;
        const stopAfterPoolOpenSeconds = draft.kind === "spam"
          ? numberValue(draft.stopAfterPoolOpenSeconds, "Pool-open delay", { optional: false, max: 86_400 })
          : undefined;
        const transferPercentage = draft.transferEnabled
          ? numberValue(draft.transferPercentage, "Transfer percentage", { optional: false, min: Number.MIN_VALUE, max: 100 })
          : undefined;
        if (draft.kind === "spam" && draft.transferEnabled && !draft.transferWallet.trim()) {
          throw new Error("Enter the destination wallet for the post-buy transfer.");
        }
        busy = true;
        render();
        const response = await request({
          type: "sharp:create-task",
          clientId: selectedClientId,
          taskType: draft.kind === "spam" ? "mint" : draft.kind,
          target,
          lifecycle: draft.kind === "spam" ? "creation" : draft.lifecycle,
          match: draft.match,
          arm: true,
          ...(amount === undefined ? {} : { amount }),
          options: {
            ...(draft.kind === "spam" ? { spamEnabled: true } : {}),
            ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
            ...(draft.kind === "dev" && draft.ticker.trim() ? { ticker: draft.ticker.trim() } : {}),
            ...(priorityFee === undefined ? {} : { priorityFee }),
            ...(tip === undefined ? {} : { tip }),
            ...(slippage === undefined ? {} : { slippage }),
            ...(startDelaySeconds === undefined ? {} : { startDelaySeconds }),
            ...(transactionsPerSecond === undefined ? {} : { transactionsPerSecond }),
            ...(stopAfterSeconds === undefined ? {} : { stopAfterSeconds }),
            ...(maxTotalFeesSol === undefined ? {} : { maxTotalFeesSol }),
            ...(stopAfterPoolOpenSeconds === undefined ? {} : { stopAfterPoolOpenSeconds }),
            ...(draft.kind === "spam" ? { stopOnPoolOpen: draft.stopOnPoolOpen } : {}),
            ...(draft.kind === "spam" && draft.transferEnabled && transferPercentage !== undefined ? {
              transfer: {
                destinationWallet: draft.transferWallet.trim(),
                percentage: transferPercentage
              }
            } : {})
          }
        });
        if (response.ok) {
          tasks = response.tasks ?? [];
          tasksClientId = selectedClientId;
          snipeDrafts = snipeDrafts.filter((item) => item.id !== draft.id);
        }
        showResponse(
          response,
          "Snipe task started",
          `${draft.kind === "dev" ? "Developer" : draft.kind === "ticker" ? "Ticker" : "Mint spam"} task is now running.`
        );
      } catch (error) {
        toasts.show("error", "Snipe task failed", error instanceof Error ? error.message : "The extension request failed.");
      } finally {
        busy = false;
        render();
      }
    };

    for (const [index, draft] of snipeDrafts.entries()) {
      const row = document.createElement("article");
      row.className = "draft-row";
      row.dataset.kind = draft.kind;
      const rowHeader = document.createElement("div");
      rowHeader.className = "draft-header";
      const number = document.createElement("span");
      number.className = "draft-number";
      number.textContent = String(index + 1);
      const type = document.createElement("select");
      type.className = "draft-type";
      for (const [value, label] of [
        ["dev", "Dev wallet"],
        ["ticker", "Ticker"],
        ["spam", "Mint spam"]
      ] as const) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        type.append(option);
      }
      type.value = draft.kind;
      type.onchange = () => {
        draft.kind = type.value as SnipeDraftKind;
        draft.target = "";
        render();
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-draft";
      remove.setAttribute("aria-label", "Remove draft");
      remove.textContent = "×";
      remove.onclick = () => {
        snipeDrafts = snipeDrafts.filter((item) => item.id !== draft.id);
        render();
      };
      rowHeader.append(number, type, remove);
      row.append(rowHeader);

      const fields = document.createElement("div");
      fields.className = "draft-fields";
      const pagePreset = pagePresetFor(draft);
      if (pagePreset) {
        const preset = document.createElement("button");
        preset.type = "button";
        preset.className = "context-preset";
        const presetLabel = document.createElement("span");
        presetLabel.textContent = pagePreset.label;
        const presetValue = document.createElement("strong");
        presetValue.textContent = shortTarget(pagePreset.value);
        preset.append(presetLabel, presetValue);
        preset.onclick = () => {
          draft.target = pagePreset.value;
          render();
        };
        fields.append(preset);
      }
      fields.append(draftField(draft, "label", "Label (optional)", "e.g. Whale 1"));
      fields.append(draftField(
        draft,
        "target",
        draft.kind === "dev" ? "Developer wallet" : draft.kind === "ticker" ? "Ticker" : "Token mint",
        draft.kind === "dev" ? "Solana creator address" : draft.kind === "ticker" ? "e.g. SHARP" : "Known mint address"
      ));

      if (draft.kind === "dev") {
        const ticker = draftField(draft, "ticker", "Ticker (optional)", "Only match this ticker");
        const match = document.createElement("label");
        match.className = "field";
        match.innerHTML = "<span>Ticker match</span>";
        const select = document.createElement("select");
        select.innerHTML = '<option value="exact">Exact (case-insensitive)</option><option value="contains">Contains</option>';
        select.value = draft.match;
        select.onchange = () => { draft.match = select.value as "exact" | "contains"; };
        match.append(select);
        fields.append(ticker, match);
      } else if (draft.kind === "ticker") {
        const match = document.createElement("label");
        match.className = "field";
        match.innerHTML = "<span>Match</span>";
        const select = document.createElement("select");
        select.innerHTML = '<option value="exact">Exact (case-insensitive)</option><option value="contains">Contains</option>';
        select.value = draft.match;
        select.onchange = () => { draft.match = select.value as "exact" | "contains"; };
        match.append(select);
        fields.append(match);
      }

      if (draft.kind !== "spam") {
        const lifecycle = document.createElement("label");
        lifecycle.className = "field";
        lifecycle.innerHTML = "<span>Buy on</span>";
        const select = document.createElement("select");
        select.innerHTML = '<option value="both">Creation + migration</option><option value="creation">Creation</option><option value="migration">Migration</option>';
        select.value = draft.lifecycle;
        select.onchange = () => { draft.lifecycle = select.value as AutomationLifecycle; };
        lifecycle.append(select);
        fields.append(lifecycle);
      }

      const execution = document.createElement("div");
      execution.className = "field-grid";
      execution.append(
        draftField(draft, "amount", "Amount (SOL)", "Preset", "decimal"),
        draftField(draft, "priorityFee", "Priority (SOL)", "Preset", "decimal"),
        draftField(draft, "tip", "Tip (SOL)", "Preset", "decimal"),
        draftField(draft, "slippage", "Slippage (%)", "Preset", "decimal")
      );
      fields.append(execution);

      if (draft.kind === "spam") {
        const spamGrid = document.createElement("div");
        spamGrid.className = "field-grid";
        spamGrid.append(
          draftField(draft, "startDelaySeconds", "Start after (sec)", "0", "decimal"),
          draftField(draft, "transactionsPerSecond", "TPS", "10", "decimal"),
          draftField(draft, "stopAfterSeconds", "Run for (sec)", "20", "decimal"),
          draftField(draft, "maxTotalFeesSol", "Max fees (SOL)", "0.05", "decimal")
        );
        fields.append(spamGrid);
        const stop = document.createElement("label");
        stop.className = "check-row";
        const stopInput = document.createElement("input");
        stopInput.type = "checkbox";
        stopInput.checked = draft.stopOnPoolOpen;
        const stopCopy = document.createElement("span");
        stopCopy.innerHTML = "<strong>Stop spamming on pool open</strong><small>Optionally continue for a short delay</small>";
        stopInput.onchange = () => {
          draft.stopOnPoolOpen = stopInput.checked;
          render();
        };
        stop.append(stopInput, stopCopy);
        fields.append(stop);
        if (draft.stopOnPoolOpen) {
          fields.append(draftField(draft, "stopAfterPoolOpenSeconds", "Continue after pool opens (sec)", "0", "decimal"));
        }
        const transfer = document.createElement("label");
        transfer.className = "check-row";
        const transferInput = document.createElement("input");
        transferInput.type = "checkbox";
        transferInput.checked = draft.transferEnabled;
        const transferCopy = document.createElement("span");
        transferCopy.innerHTML = "<strong>Transfer tokens after buy</strong><small>Runs after the spam buy confirms</small>";
        transferInput.onchange = () => {
          draft.transferEnabled = transferInput.checked;
          render();
        };
        transfer.append(transferInput, transferCopy);
        fields.append(transfer);
        if (draft.transferEnabled) {
          const transferGrid = document.createElement("div");
          transferGrid.className = "transfer-grid";
          transferGrid.append(
            draftField(draft, "transferWallet", "Destination wallet", "Solana address"),
            draftField(draft, "transferPercentage", "Transfer %", "100", "decimal")
          );
          fields.append(transferGrid);
        }
      }

      const arm = actionButton(`Start ${draft.kind === "dev" ? "dev" : draft.kind} task`);
      arm.disabled = arm.disabled || !selectedClientId;
      arm.onclick = () => void submitDraft(draft);
      fields.append(arm);
      row.append(fields);
      editor.append(row);
    }
    body.append(editor);
    renderTaskList(body, "all");
  };

  const loadCreatorSell = async () => {
    const client = ensureSelectedClient();
    if (!client || creatorSellClientId === client.endpointId) {
      render();
      return;
    }
    creatorSell = undefined;
    creatorSellClientId = client.endpointId;
    render();
    try {
      const response = await request({ type: "sharp:get-creator-sell", clientId: client.endpointId });
      if (creatorSellClientId !== client.endpointId) return;
      if (response.ok) {
        creatorSell = response.creatorSell;
      } else {
        creatorSellClientId = "";
        toasts.show("error", "Dev Sell unavailable", response.error);
      }
    } catch (error) {
      creatorSellClientId = "";
      toasts.show("error", "Dev Sell unavailable", error instanceof Error ? error.message : "The extension request failed.");
    }
    render();
  };

  const queueCreatorSellSave = (
    settings: CreatorSellSettings,
    immediate = false
  ) => {
    if (!selectedClientId) return;
    if (creatorSellSaveTimer !== undefined) window.clearTimeout(creatorSellSaveTimer);
    const revision = ++creatorSellSaveRevision;
    const clientId = selectedClientId;
    const groupId = selectedCreatorSellGroupId;
    const currentGroup = managedWalletsByClient.get(clientId)?.groups.find((group) => group.id === groupId);
    const creatorSellWallets = currentGroup
      ? [...(creatorSellWalletSelectionByGroup.get(groupId)
          ?? new Set(currentGroup.creatorSellWallets ?? currentGroup.wallets))]
      : undefined;
    const queuedSettings: CreatorSellSettings = {
      ...settings,
      ...(settings.execution
        ? { execution: { ...settings.execution, senders: [...settings.execution.senders] } }
        : {})
    };
    const presetSettings: CreatorSellSettings = creatorSell
      ? {
          ...creatorSell,
          ...(queuedSettings.execution
            ? { execution: { ...queuedSettings.execution, senders: [...queuedSettings.execution.senders] } }
            : {})
        }
      : queuedSettings;
    if (!groupId) creatorSell = queuedSettings;
    creatorSellSaveTimer = window.setTimeout(async () => {
      creatorSellSaveTimer = undefined;
      try {
        const inventory = managedWalletsByClient.get(clientId);
        const response = groupId && inventory
          ? await request({
              type: "sharp:update-wallet-groups",
              clientId,
              groups: inventory.groups.map((group) => group.id === groupId
                ? { ...group, creatorSell: queuedSettings, creatorSellWallets: creatorSellWallets ?? [] }
                : group)
            })
          : await request({
              type: "sharp:update-creator-sell",
              clientId,
              settings: queuedSettings
            });
        if (revision !== creatorSellSaveRevision || clientId !== selectedClientId) return;
        if (response.ok) {
          if (groupId && response.managedWallets) {
            if (queuedSettings.execution) {
              const presetResponse = await request({
                type: "sharp:update-creator-sell",
                clientId,
                settings: presetSettings
              });
              if (!presetResponse.ok) {
                toasts.show("error", "Dev Sell execution not updated", presetResponse.error);
                return;
              }
              creatorSell = presetResponse.creatorSell ?? presetSettings;
            }
            managedWalletsByClient.set(clientId, response.managedWallets);
            const plan = snapshot?.walletPlansByClient?.[clientId];
            const group = response.managedWallets.groups.find((candidate) => candidate.id === groupId);
            if (plan?.groupId === groupId && group) {
              const groupWallets = new Set(group.wallets);
              const enabledWallets = new Set(group.creatorSellWallets ?? group.wallets);
              const planResponse = await request({
                type: "sharp:update-wallet-plan",
                clientId,
                action: "buy",
                plan: {
                  ...plan,
                  allocations: plan.allocations.map((allocation) => groupWallets.has(allocation.walletName)
                    ? {
                        ...allocation,
                        automation: {
                          ...(allocation.automation ?? defaultPositionAutomation()),
                          creatorSell: queuedSettings.enabled && enabledWallets.has(allocation.walletName),
                          creatorSellSettings: {
                            enabled: queuedSettings.enabled && enabledWallets.has(allocation.walletName),
                            minimumPercentage: queuedSettings.minimumPercentage,
                            sellPercentage: queuedSettings.sellPercentage
                          }
                        }
                      }
                    : allocation)
                }
              });
              if (planResponse.ok && planResponse.snapshot) snapshot = planResponse.snapshot;
            }
          } else {
            creatorSell = response.creatorSell ?? queuedSettings;
          }
        }
        else toasts.show("error", "Dev Sell not updated", response.error);
      } catch (error) {
        if (revision !== creatorSellSaveRevision || clientId !== selectedClientId) return;
        toasts.show("error", "Dev Sell not updated", error instanceof Error ? error.message : "The extension request failed.");
      }
    }, immediate ? 0 : 400);
  };

  const renderDevSell = (body: HTMLElement) => {
    if (!selectedClientId) {
      const hint = document.createElement("p");
      hint.textContent = "Connect a Solana Sharp client to configure Creator / Dev Sell.";
      body.append(hint);
      return;
    }
    if (!creatorSell) {
      const loading = document.createElement("div");
      loading.className = "loading";
      loading.textContent = "Loading active preset…";
      body.append(loading);
      return;
    }
    const walletInventory = managedWalletsByClient.get(selectedClientId);
    if (selectedCreatorSellGroupId && !walletInventory?.groups.some((group) => group.id === selectedCreatorSellGroupId)) {
      selectedCreatorSellGroupId = "";
    }
    const selectedCreatorGroup = walletInventory?.groups.find((group) => group.id === selectedCreatorSellGroupId);
    const displayedCreatorSell = selectedCreatorGroup?.creatorSell ?? creatorSell;
    if (walletInventory?.groups.length) {
      const scope = document.createElement("details");
      scope.className = "creator-wallet-scope";
      scope.open = creatorSellWalletScopeOpen;
      scope.ontoggle = () => { creatorSellWalletScopeOpen = scope.open; };
      const scopeSummary = document.createElement("summary");
      const savedSelection = selectedCreatorGroup
        ? creatorSellWalletSelectionByGroup.get(selectedCreatorGroup.id)
          ?? new Set(selectedCreatorGroup.creatorSellWallets ?? selectedCreatorGroup.wallets)
        : new Set(walletInventory.wallets.map((wallet) => wallet.name));
      scopeSummary.innerHTML = `<span>Wallet scope</span><strong>${selectedCreatorGroup?.name ?? "Default"} · ${savedSelection.size}</strong><i>⌄</i>`;
      const scopeBody = document.createElement("div");
      scopeBody.className = "creator-wallet-scope-body";
      const groupsLabel = document.createElement("span");
      groupsLabel.className = "wallet-flyout-label";
      groupsLabel.textContent = "Bundles";
      const groups = document.createElement("div");
      groups.className = "wallet-groups";
      const defaultGroup = document.createElement("button");
      defaultGroup.type = "button";
      defaultGroup.textContent = "Default · all";
      defaultGroup.classList.toggle("selected", !selectedCreatorSellGroupId);
      defaultGroup.onclick = () => {
        selectedCreatorSellGroupId = "";
        render();
      };
      groups.append(defaultGroup);
      for (const group of walletInventory.groups) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${group.name} · ${group.wallets.length}`;
        button.classList.toggle("selected", group.id === selectedCreatorSellGroupId);
        button.onclick = () => {
          selectedCreatorSellGroupId = group.id;
          if (!creatorSellWalletSelectionByGroup.has(group.id)) {
            creatorSellWalletSelectionByGroup.set(
              group.id,
              new Set(group.creatorSellWallets ?? group.wallets)
            );
          }
          render();
        };
        groups.append(button);
      }
      scopeBody.append(groupsLabel, groups);
      if (selectedCreatorGroup) {
        const walletsLabel = document.createElement("span");
        walletsLabel.className = "wallet-flyout-label";
        walletsLabel.textContent = "Wallets";
        const list = document.createElement("div");
        list.className = "wallet-list";
        const selection = creatorSellWalletSelectionByGroup.get(selectedCreatorGroup.id)
          ?? new Set(selectedCreatorGroup.creatorSellWallets ?? selectedCreatorGroup.wallets);
        creatorSellWalletSelectionByGroup.set(selectedCreatorGroup.id, selection);
        for (const walletName of selectedCreatorGroup.wallets) {
          const wallet = walletInventory.wallets.find((candidate) => candidate.name === walletName);
          if (!wallet) continue;
          const row = document.createElement("label");
          row.className = "wallet-row";
          row.classList.toggle("selected", selection.has(wallet.name));
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = selection.has(wallet.name);
          const name = document.createElement("strong");
          name.textContent = wallet.name;
          name.title = wallet.address;
          const balance = document.createElement("span");
          balance.className = "wallet-row-balance";
          if (wallet.balance === undefined) {
            balance.textContent = managedWalletBalancesLoadingClientId === selectedClientId ? "…" : "—";
            balance.classList.add("muted");
          } else {
            const native = document.createElement("span");
            native.textContent = `${wallet.balance.toLocaleString(undefined, { maximumFractionDigits: 3 })} SOL`;
            balance.append(native);
            if (wallet.wrappedBalance !== undefined && wallet.wrappedBalance > 0) {
              const wrapped = document.createElement("small");
              wrapped.textContent = `${wallet.wrappedBalance.toLocaleString(undefined, { maximumFractionDigits: 3 })} WSOL`;
              balance.append(wrapped);
            }
          }
          checkbox.onchange = () => {
            if (checkbox.checked) selection.add(wallet.name);
            else selection.delete(wallet.name);
            row.classList.toggle("selected", checkbox.checked);
            creatorSellWalletSelectionByGroup.set(selectedCreatorGroup.id, selection);
            scopeSummary.querySelector("strong")!.textContent = `${selectedCreatorGroup.name} · ${selection.size}`;
            queueCreatorSellSave(displayedCreatorSell, true);
          };
          row.append(checkbox, name, balance);
          list.append(row);
        }
        scopeBody.append(walletsLabel, list);
      }
      scope.append(scopeSummary, scopeBody);
      body.append(scope);
    }
    const enabled = document.createElement("label");
    enabled.className = "switch-row";
    const enabledCopy = document.createElement("span");
    enabledCopy.innerHTML = "<strong>Follow developer sells</strong><small>Enable before buying so Sharp tracks the developer for that position</small>";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = displayedCreatorSell.enabled;
    enabled.append(enabledCopy, enabledInput);
    const threshold = inputField("Developer sell threshold %", "1", "decimal");
    threshold.input.type = "number";
    threshold.input.min = "0";
    threshold.input.max = "100";
    threshold.input.value = String(displayedCreatorSell.minimumPercentage);
    const percentage = inputField("Your position to sell %", "100", "decimal");
    percentage.input.type = "number";
    percentage.input.min = "1";
    percentage.input.max = "100";
    percentage.input.value = String(displayedCreatorSell.sellPercentage);
    body.append(enabled, threshold.wrap, percentage.wrap);

    const executionState = creatorSell.execution ?? {
      enabled: false,
      senders: []
    };
    creatorSell.execution = executionState;
    const queueCurrentSettings = (reportInvalid = false, immediate = false) => {
      const minimumPercentage = Number(threshold.input.value);
      const sellPercentage = Number(percentage.input.value);
      if (
        !Number.isFinite(minimumPercentage)
        || minimumPercentage < 0
        || minimumPercentage > 100
        || !Number.isFinite(sellPercentage)
        || sellPercentage <= 0
        || sellPercentage > 100
      ) {
        if (reportInvalid) {
          toasts.show("error", "Dev Sell not updated", "Use a developer threshold from 0 to 100 and a sell percentage above 0 up to 100");
        }
        return;
      }
      const priorityFee = executionState.priorityFee;
      const tip = executionState.tip;
      if (
        (priorityFee !== undefined && (!Number.isFinite(priorityFee) || priorityFee < 0))
        || (tip !== undefined && (!Number.isFinite(tip) || tip < 0))
      ) {
        if (reportInvalid) {
          toasts.show("error", "Dev Sell not updated", "Priority fee and relay tip must be zero or greater");
        }
        return;
      }
      queueCreatorSellSave({
        enabled: enabledInput.checked,
        minimumPercentage,
        sellPercentage,
        execution: executionState
      }, immediate);
    };
    enabledInput.onchange = () => queueCurrentSettings(true, true);
    threshold.input.oninput = () => queueCurrentSettings();
    threshold.input.onchange = () => queueCurrentSettings(true, true);
    percentage.input.oninput = () => queueCurrentSettings();
    percentage.input.onchange = () => queueCurrentSettings(true, true);
    const execution = document.createElement("details");
    execution.className = "execution-panel";
    execution.open = executionState.enabled;
    const executionSummary = document.createElement("summary");
    executionSummary.textContent = executionState.enabled
      ? `Execution override · ${executionState.senders.length || "preset"} sender${executionState.senders.length === 1 ? "" : "s"}`
      : "Execution · preset sell settings";
    execution.append(executionSummary);
    const customToggle = document.createElement("label");
    customToggle.className = "check-row compact";
    const customInput = document.createElement("input");
    customInput.type = "checkbox";
    customInput.checked = executionState.enabled;
    const customCopy = document.createElement("span");
    customCopy.innerHTML = "<strong>Override for developer sells</strong><small>Otherwise the active preset's sell routes and fees are used</small>";
    customInput.onchange = () => {
      executionState.enabled = customInput.checked;
      queueCurrentSettings(true, true);
      render();
    };
    customToggle.append(customInput, customCopy);
    execution.append(customToggle);
    if (executionState.enabled) {
      const senderGrid = document.createElement("div");
      senderGrid.className = "sender-grid";
      for (const sender of solanaSenders) {
        const label = document.createElement("label");
        label.className = executionState.senders.includes(sender) ? "sender-chip selected" : "sender-chip";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = executionState.senders.includes(sender);
        input.onchange = () => {
          executionState.senders = input.checked
            ? [...new Set([...executionState.senders, sender])]
            : executionState.senders.filter((item) => item !== sender);
          label.classList.toggle("selected", input.checked);
          queueCurrentSettings(true, true);
        };
        const text = document.createElement("span");
        text.textContent = senderLabels[sender];
        label.append(input, text);
        senderGrid.append(label);
      }
      execution.append(senderGrid);
      const feeGrid = document.createElement("div");
      feeGrid.className = "field-grid";
      const priority = inputField("Priority fee (SOL)", "Preset", "decimal");
      priority.input.value = executionState.priorityFee?.toString() ?? "";
      priority.input.oninput = () => {
        const value = priority.input.value.trim();
        if (value) executionState.priorityFee = Number(value);
        else delete executionState.priorityFee;
        queueCurrentSettings();
      };
      priority.input.onchange = () => queueCurrentSettings(true, true);
      const tip = inputField("Relay tip (SOL)", "Preset", "decimal");
      tip.input.value = executionState.tip?.toString() ?? "";
      tip.input.oninput = () => {
        const value = tip.input.value.trim();
        if (value) executionState.tip = Number(value);
        else delete executionState.tip;
        queueCurrentSettings();
      };
      tip.input.onchange = () => queueCurrentSettings(true, true);
      feeGrid.append(priority.wrap, tip.wrap);
      execution.append(feeGrid);
      const customHint = document.createElement("p");
      customHint.textContent = executionState.senders.length
        ? "Only selected routes run for this developer sell"
        : "No routes selected means the active preset's sell routes are used";
      execution.append(customHint);
    }
    body.append(execution);
  };

  const render = () => {
    activeDragCleanup?.();
    panel.replaceChildren();
    ensureSelectedClient();
    const header = document.createElement("header");
    const brand = document.createElement("div");
    brand.innerHTML = "<strong>SHARP</strong>";
    const status = document.createElement("span");
    status.className = "status";
    const connected = context?.chain
      ? connectedClients(context.chain).length
      : snapshot?.clients.filter((client) => client.connected && client.authenticated).length ?? 0;
    status.textContent = `${connected} online`;
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "refresh-clients";
    refresh.setAttribute("aria-label", "Refresh Sharp clients");
    refresh.title = "Refresh Sharp clients";
    refresh.textContent = "↻";
    refresh.onclick = async (event) => {
      event.stopPropagation();
      refresh.disabled = true;
      try {
        const response = await request({ type: "sharp:refresh" });
        if (response.ok && response.snapshot) {
          snapshot = response.snapshot;
          ensureSelectedClient();
          render();
        } else if (!response.ok) {
          toasts.show("error", "Client refresh failed", response.error);
        }
      } finally {
        refresh.disabled = false;
      }
    };
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "collapse";
    collapse.setAttribute("aria-label", "Collapse Sharp automations");
    collapse.textContent = "-";
    collapse.onclick = () => {
      appearanceMenuOpen = false;
      const rect = panel.getBoundingClientRect();
      if (rect.width > 0) expandedPanelWidth = rect.width;
      panelPosition ??= { x: rect.left, y: rect.top };
      panel.hidden = true;
      launcher.hidden = false;
      applyPosition(panelPosition);
      if (saveOpen) void Promise.resolve(saveOpen(false)).catch(() => undefined);
    };
    const appearance = document.createElement("button");
    appearance.type = "button";
    appearance.className = panelTransparent ? "appearance active" : "appearance";
    appearance.setAttribute("aria-label", "Panel appearance");
    appearance.title = "Panel appearance";
    appearance.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.7 1.8h2.6l.4 1.5c.3.1.6.3.9.5l1.5-.5 1.3 2.2-1.1 1.1v1.2l1.1 1.1-1.3 2.2-1.5-.5-.9.5-.4 1.5H6.7l-.4-1.5-.9-.5-1.5.5-1.3-2.2 1.1-1.1V6.6L2.6 5.5l1.3-2.2 1.5.5.9-.5.4-1.5Z"/><circle cx="8" cy="7.2" r="1.8"/></svg>';
    appearance.onclick = (event) => {
      event.stopPropagation();
      appearanceMenuOpen = !appearanceMenuOpen;
      render();
    };
    header.append(brand, status, clientSelect(true), refresh, appearance, collapse);
    panel.append(header);

    if (appearanceMenuOpen) {
      const menu = document.createElement("div");
      menu.className = "appearance-menu no-drag";
      const transparencyPercent = panelTransparent
        ? Math.round((1 - panelOpacity) * 100)
        : 0;
      const rangeHeader = document.createElement("div");
      rangeHeader.className = "appearance-range-header";
      const rangeLabel = document.createElement("span");
      rangeLabel.textContent = "Transparency";
      const value = document.createElement("strong");
      value.textContent = `${transparencyPercent}%`;
      rangeHeader.append(rangeLabel, value);
      const range = document.createElement("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.step = "1";
      range.value = String(transparencyPercent);
      range.setAttribute("aria-label", "Panel transparency");
      range.oninput = () => {
        const nextTransparency = Number(range.value);
        panelTransparent = nextTransparency > 0;
        panelOpacity = normalizePanelOpacity(1 - nextTransparency / 100);
        value.textContent = `${nextTransparency}%`;
        applyPanelAppearance();
      };
      range.onchange = persistPanelAppearance;
      menu.append(rangeHeader, range);
      panel.append(menu);
    }

    const tabs = document.createElement("nav");
    const tabLabels: Array<[AutomationTab, string]> = [
      ["trade", "Trade"],
      ["migration", "Migration"],
      ["dev-buy", "Snipes"],
      ["dev-sell", "Dev S"],
      ["sell-auto", "Wallet S"],
      ["position-autosell", "Auto S"]
    ];
    for (const [tab, label] of tabLabels) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = tab === activeTab ? "active" : "";
      const activate = () => {
        if (tab === activeTab) return;
        autosellControlFocused = false;
        activeTab = tab;
        creatorSell = undefined;
        creatorSellClientId = "";
        ensureSelectedClient();
        if (tab === "position-autosell") {
          selectedAutosellGroupId = snapshot?.walletPlansByClient?.[selectedClientId]?.groupId ?? "";
        }
        render();
        if (tab === "dev-sell") { void loadCreatorSell(); void loadManagedWallets(); }
        else if (tab === "trade") { void loadTradeState(); void loadManagedWallets(); }
        else if (tab === "sell-auto") { void loadTradeState(); void loadWalletLists(); }
        else if (tab === "position-autosell") {
          void loadTradeState();
          void loadManagedWallets();
          void loadAutosellPresets();
        }
        else if (tab === "migration") { void loadTasks(); void loadTradeState(); }
        else void loadTasks();
      };
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        activate();
      });
      button.onclick = activate;
      tabs.append(button);
    }
    panel.append(tabs);

    const body = document.createElement("div");
    body.className = "body";
    if (activeTab === "trade") renderTrade(body);
    else if (activeTab === "sell-auto") renderSellAutomations(body);
    else if (activeTab === "position-autosell") renderPositionAutosell(body);
    else if (activeTab === "migration") renderMigration(body);
    else if (activeTab === "dev-buy") renderDevBuy(body);
    else renderDevSell(body);
    panel.append(body);

    header.addEventListener("pointerdown", (event) => {
      if (
        event.button !== 0 ||
        (event.target as Element).closest("button, input, select, .no-drag")
      ) return;
      event.preventDefault();
      positionMovedByUser = true;
      normalizePosition();
      const pointerId = event.pointerId;
      const startPointer = { x: event.clientX, y: event.clientY };
      const startPosition = { ...panelPosition! };
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      try {
        header.setPointerCapture(pointerId);
      } catch {}

      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        applyPosition({
          x: startPosition.x + moveEvent.clientX - startPointer.x,
          y: startPosition.y + moveEvent.clientY - startPointer.y
        });
      };

      let stopped = false;
      const stop = (stopEvent?: PointerEvent) => {
        if (stopped || (stopEvent && stopEvent.pointerId !== pointerId)) return;
        stopped = true;
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", stop, true);
        document.removeEventListener("pointercancel", stop, true);
        header.removeEventListener("lostpointercapture", stop);
        try {
          if (header.hasPointerCapture(pointerId)) header.releasePointerCapture(pointerId);
        } catch {}
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        activeDragCleanup = undefined;
        if (panelPosition && savePosition) {
          void Promise.resolve(savePosition(panelPosition)).catch(() => undefined);
        }
        if (renderAfterDrag) {
          renderAfterDrag = false;
          requestAnimationFrame(render);
        }
      };
      activeDragCleanup = () => stop();
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", stop, true);
      document.addEventListener("pointercancel", stop, true);
      header.addEventListener("lostpointercapture", stop);
    });

    if (panelPosition) requestAnimationFrame(() => applyPosition(panelPosition!));
  };

  launcher.onclick = () => {
    if (suppressLauncherClick) {
      suppressLauncherClick = false;
      return;
    }
    launcher.hidden = true;
    panel.hidden = false;
    if (saveOpen) void Promise.resolve(saveOpen(true)).catch(() => undefined);
    render();
    requestAnimationFrame(normalizePosition);
    if (activeTab === "dev-sell") void loadCreatorSell();
    else if (activeTab === "trade" || activeTab === "sell-auto" || activeTab === "position-autosell") void loadTradeState(true);
    else if (activeTab === "migration") { void loadTasks(); void loadTradeState(true); }
    else void loadTasks();
  };

  launcher.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    positionMovedByUser = true;
    normalizePosition();
    const pointerId = event.pointerId;
    const startPointer = { x: event.clientX, y: event.clientY };
    const startPosition = { ...panelPosition! };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    try {
      launcher.setPointerCapture(pointerId);
    } catch {}

    let moved = false;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const deltaX = moveEvent.clientX - startPointer.x;
      const deltaY = moveEvent.clientY - startPointer.y;
      if (Math.abs(deltaX) + Math.abs(deltaY) >= 3) moved = true;
      if (!moved) return;
      applyPosition({
        x: startPosition.x + deltaX,
        y: startPosition.y + deltaY
      });
    };

    let stopped = false;
    const stop = (stopEvent?: PointerEvent) => {
      if (stopped || (stopEvent && stopEvent.pointerId !== pointerId)) return;
      stopped = true;
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
      launcher.removeEventListener("lostpointercapture", stop);
      try {
        if (launcher.hasPointerCapture(pointerId)) launcher.releasePointerCapture(pointerId);
      } catch {}
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      activeDragCleanup = undefined;
      suppressLauncherClick = moved;
      if (moved && panelPosition && savePosition) {
        void Promise.resolve(savePosition(panelPosition)).catch(() => undefined);
      }
    };
    activeDragCleanup = () => stop();
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", stop, true);
    document.addEventListener("pointercancel", stop, true);
    launcher.addEventListener("lostpointercapture", stop);
  });

  return {
    update(nextSnapshot, nextContext) {
      const nextUpdateKey = updateKey(nextSnapshot, nextContext);
      const changed = nextUpdateKey !== lastUpdateKey;
      lastUpdateKey = nextUpdateKey;
      snapshot = nextSnapshot;
      context = nextContext;
      const site = nextContext?.site;
      host.style.display = nextSnapshot.enabled &&
        site &&
        nextSnapshot.siteEnabled[site] &&
        !nextSnapshot.compatibilityDisabledSites.includes(site)
        ? "block"
        : "none";
      const previousClientId = selectedClientId;
      ensureSelectedClient();
      const selectionChain = activeTab === "trade" || activeTab === "sell-auto" || activeTab === "position-autosell" ? nextContext?.chain : "solana";
      if (
        selectionChain
        && selectedClientId
        && !(nextSnapshot.selectedClientIdsByChain[selectionChain] ?? []).includes(selectedClientId)
      ) {
        void persistClientSelection(selectionChain, selectedClientId);
      }
      if (previousClientId !== selectedClientId) {
        if (creatorSellSaveTimer !== undefined) window.clearTimeout(creatorSellSaveTimer);
        creatorSellSaveTimer = undefined;
        creatorSellSaveRevision += 1;
        creatorSell = undefined;
        creatorSellClientId = "";
        tasks = [];
        tasksClientId = "";
        devLists = [];
        devListsClientId = "";
        walletWordlists = [];
        walletWordlistsClientId = "";
        migrationSell = undefined;
        migrationSellClientId = "";
        if (!panel.hidden && (activeTab === "trade" || activeTab === "position-autosell") && selectedClientId) {
          void loadTradeState(true);
          if (activeTab === "trade") void loadManagedWallets(true);
          else if (activeTab === "position-autosell") {
            void loadManagedWallets(true);
            void loadAutosellPresets(true);
          }
        }
        else if (!panel.hidden && activeTab === "migration") { void loadTasks(); void loadTradeState(true); }
        else if (!panel.hidden && activeTab !== "dev-sell" && activeTab !== "position-autosell") void loadTasks();
      }
      if (!panel.hidden && changed) {
        if (activeDragCleanup) renderAfterDrag = true;
        else if (!(activeTab === "position-autosell" && autosellControlFocused)) render();
      }
      if (firstUpdate) {
        firstUpdate = false;
        if (!panel.hidden && activeTab === "trade") { void loadTradeState(); void loadManagedWallets(); }
        else if (!panel.hidden && activeTab === "position-autosell") {
          void loadTradeState();
          void loadManagedWallets();
          void loadAutosellPresets();
        }
        else if (!panel.hidden && activeTab === "migration") { void loadTasks(); void loadTradeState(); }
        else if (!panel.hidden && activeTab !== "dev-sell" && activeTab !== "position-autosell") void loadTasks();
      }
      if (
        !panel.hidden
        && (activeTab === "trade" || activeTab === "position-autosell")
        && nextContext
        && connectedClients(nextContext.chain)
          .filter((client) => client.capabilities?.features.sell)
          .some((client) => !positionsByClient.has(client.endpointId))
      ) {
        void loadTradeState();
      }
    },
    updatePositions(clientId, positions) {
      positionsByClient.set(clientId, positions);
      if (!panel.hidden && (activeTab === "trade" || activeTab === "position-autosell") && context?.chain && connectedClients(context.chain)
        .some((client) => client.endpointId === clientId)) {
        if (activeTab === "trade") refreshTradePositionDom();
        else if (!autosellControlFocused) render();
      }
    },
    destroy() {
      activeDragCleanup?.();
      if (creatorSellSaveTimer !== undefined) window.clearTimeout(creatorSellSaveTimer);
      sellAutomationPopout = undefined;
      document.removeEventListener("click", handleAppearanceOutsideClick);
      document.removeEventListener("click", handleWalletOutsideClick);
      window.removeEventListener("resize", handleViewportResize);
      host.remove();
    }
  };
}

const toastStyles = `
  :host { all: initial; position: fixed; z-index: 2147483647; top: 14px; right: 14px; font-family: Geist, system-ui, -apple-system, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  .stack { display: flex; width: min(360px, calc(100vw - 28px)); flex-direction: column; gap: 8px; }
  .toast { display: grid; grid-template-columns: 24px 1fr 22px; gap: 9px; align-items: start; border: 1px solid rgba(59,130,246,.30); border-radius: 8px; padding: 11px; background: #0a1019; color: #f8fafc; box-shadow: 0 14px 38px rgba(0,0,0,.52); animation: sharp-toast-in .18s ease-out; }
  .toast.error { border-color: rgba(239,68,68,.45); }
  .toast.info { border-color: rgba(148,163,184,.28); }
  .toast.leaving { animation: sharp-toast-out .18s ease-in forwards; }
  .marker { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 50%; background: rgba(59,130,246,.17); color: #60a5fa; font-size: 13px; font-weight: 800; }
  .error .marker { background: rgba(239,68,68,.14); color: #f87171; }
  .info .marker { background: rgba(148,163,184,.12); color: #cbd5e1; }
  .pending .marker::before { width: 11px; height: 11px; border: 2px solid rgba(96,165,250,.25); border-top-color: #60a5fa; border-radius: 50%; content: ""; animation: sharp-toast-spin .7s linear infinite; }
  strong, span { display: block; }
  strong { font-size: 13px; font-weight: 650; line-height: 1.3; }
  .toast-copy { min-width: 0; }
  .toast-detail { margin-top: 3px; color: #aab8c8; font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; white-space: pre-line; }
  button { border: 0; padding: 0; background: transparent; color: #64748b; font: inherit; font-size: 18px; line-height: 18px; cursor: pointer; }
  button:hover { color: #f8fafc; }
  @keyframes sharp-toast-in { from { opacity: 0; transform: translateX(14px); } }
  @keyframes sharp-toast-out { to { opacity: 0; transform: translateX(14px); } }
  @keyframes sharp-toast-spin { to { transform: rotate(360deg); } }
`;

const automationStyles = `
  :host { all: initial; position: fixed; z-index: 2147483645; right: 18px; bottom: 18px; display: block; color-scheme: dark; font-family: Geist, system-ui, -apple-system, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  button, input, select { font: inherit; }
  .launcher { display: grid; width: 88px; height: 36px; grid-template-columns: 1fr 12px; align-items: center; gap: 8px; border: 1px solid rgba(96,165,250,.92); border-radius: 8px; padding: 0 10px 0 12px; background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; box-shadow: 0 0 0 2px rgba(4,8,12,.88), 0 9px 24px rgba(37,99,235,.35); cursor: grab; touch-action: none; user-select: none; }
  .launcher:active { cursor: grabbing; transform: scale(.985); }
  .launcher:hover { border-color: #bfdbfe; background: linear-gradient(135deg, #3b82f6, #2563eb); box-shadow: 0 0 0 2px rgba(4,8,12,.9), 0 11px 28px rgba(37,99,235,.48); }
  .launcher span { justify-self: start; font-size: 11px; font-weight: 850; letter-spacing: .11em; line-height: 1; }
  .launcher small { width: 12px; height: 16px; opacity: .62; background-image: radial-gradient(circle, #dbeafe 1.2px, transparent 1.4px); background-position: 0 0; background-size: 6px 6px; }
  .panel { position: relative; display: flex; width: 360px; max-height: calc(100vh - 16px); overflow: hidden; flex-direction: column; border: 1px solid rgba(59,130,246,.28); border-radius: 9px; background: #070c12; color: #f8fafc; box-shadow: 0 18px 48px rgba(0,0,0,.58); }
  .panel.transparent { border-color: rgba(226,232,240,.18); background: rgba(5,9,16,var(--sharp-panel-opacity,.2)); box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 0 0 1px rgba(148,163,184,.10), 0 12px 34px rgba(0,0,0,.34); }
  .panel[hidden], .launcher[hidden] { display: none; }
  header { display: flex; height: 42px; flex: 0 0 42px; align-items: center; gap: 9px; border-bottom: 1px solid rgba(148,163,184,.12); padding: 0 10px 0 12px; cursor: grab; touch-action: none; user-select: none; }
  header:active { cursor: grabbing; }
  header > div { display: flex; min-width: 0; align-items: baseline; gap: 7px; }
  header strong { color: #60a5fa; font-size: 12px; font-weight: 800; letter-spacing: .09em; }
  header div span { color: #94a3b8; font-size: 11px; }
  .status { margin-left: auto; flex: 0 0 auto; color: #64748b; font-size: 10px; }
  .header-client { min-width: 0; width: min(142px, 42vw); }
  .header-client select { height: 25px; min-width: 0; padding: 0 22px 0 7px; border-radius: 5px; font-size: 9px; text-overflow: ellipsis; }
  .refresh-clients { width: 24px; height: 24px; flex: 0 0 24px; border: 0; border-radius: 4px; background: transparent; color: #64748b; font-size: 14px; cursor: pointer; }
  .refresh-clients:hover { background: rgba(148,163,184,.10); color: #dbeafe; }
  .refresh-clients:disabled { cursor: wait; opacity: .5; }
  .appearance { display: grid; width: 24px; height: 24px; flex: 0 0 24px; place-items: center; border: 0; border-radius: 4px; padding: 0; background: transparent; color: #64748b; cursor: pointer; }
  .appearance:hover, .appearance.active { background: rgba(148,163,184,.10); color: #dbeafe; }
  .appearance svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .appearance-menu { position: absolute; z-index: 10; top: 38px; right: 38px; display: grid; width: 220px; overflow: hidden; border: 1px solid rgba(255,255,255,.10); border-radius: 7px; background: #080d14; color: #fff; box-shadow: 0 18px 42px rgba(0,0,0,.70); }
  .appearance-range-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 4px; color: rgba(255,255,255,.55); font-size: 10px; }
  .appearance-range-header strong { color: rgba(255,255,255,.72); font-family: monospace; font-size: 10px; }
  .appearance-menu input[type="range"] { width: calc(100% - 24px); height: 22px; margin: 0 12px 8px; padding: 0; border: 0; background: transparent; accent-color: #3b82f6; cursor: pointer; }
  .collapse { width: 24px; height: 24px; border: 0; border-radius: 4px; background: transparent; color: #94a3b8; font-size: 18px; cursor: pointer; }
  .collapse:hover { background: rgba(148,163,184,.10); color: #fff; }
  nav { display: grid; flex: 0 0 auto; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 2px; padding: 6px; }
  nav button { height: 27px; border: 0; border-radius: 5px; background: transparent; color: #94a3b8; font-size: 10px; font-weight: 600; cursor: pointer; }
  nav button:hover { background: rgba(148,163,184,.08); color: #cbd5e1; }
  nav button.active { background: rgba(59,130,246,.15); color: #60a5fa; }
  .migration-subtabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; padding: 2px; border: 1px solid rgba(148,163,184,.12); border-radius: 6px; background: rgba(148,163,184,.035); }
  .migration-subtabs button { height: 26px; border: 0; border-radius: 4px; background: transparent; color: #94a3b8; font-size: 10px; font-weight: 650; cursor: pointer; }
  .migration-subtabs button:hover { background: rgba(148,163,184,.08); color: #cbd5e1; }
  .migration-subtabs button.active { background: rgba(59,130,246,.16); color: #60a5fa; }
  .body { display: grid; min-height: 0; overflow-y: auto; gap: 4px; border-top: 1px solid rgba(148,163,184,.10); padding: 6px 8px 8px; }
  .field { display: grid; gap: 5px; }
  .field > span, .context span { color: #94a3b8; font-size: 10px; font-weight: 550; }
  input, select { width: 100%; height: 34px; border: 1px solid rgba(148,163,184,.18); border-radius: 5px; padding: 0 9px; outline: none; background: #0c1220; color: #f8fafc; font-size: 11px; }
  input:focus, select:focus { border-color: rgba(59,130,246,.6); box-shadow: 0 0 0 2px rgba(59,130,246,.10); }
  input::placeholder, textarea::placeholder { color: #536174; }
  textarea { width: 100%; border: 1px solid rgba(148,163,184,.18); border-radius: 5px; padding: 7px 9px; outline: none; background: #0c1220; color: #f8fafc; font: inherit; font-size: 11px; resize: vertical; }
  textarea:focus { border-color: rgba(59,130,246,.6); box-shadow: 0 0 0 2px rgba(59,130,246,.10); }
  .panel.transparent input:not([type="checkbox"]):not([type="range"]), .panel.transparent select, .panel.transparent textarea { background: rgba(5,11,18,.30); border-color: rgba(255,255,255,.10); }
  select:disabled { opacity: .55; }
  .context { display: flex; align-items: center; justify-content: space-between; border: 1px solid rgba(148,163,184,.12); border-radius: 5px; padding: 8px 9px; background: rgba(148,163,184,.035); }
  .context strong { color: #cbd5e1; font-size: 11px; font-weight: 600; }
  .trade-stats { display: grid; grid-template-columns: repeat(4, 1fr); overflow: hidden; border: 1px solid rgba(148,163,184,.12); border-radius: 6px; background: rgba(148,163,184,.025); }
  .trade-stats > div { display: grid; gap: 1px; min-width: 0; border-right: 1px solid rgba(148,163,184,.10); padding: 5px 4px; text-align: center; }
  .trade-stats > div:last-child { border-right: 0; }
  .trade-stats strong { display: flex; min-width: 0; align-items: center; justify-content: center; gap: 3px; overflow: hidden; color: #e2e8f0; font-size: 10px; font-weight: 650; white-space: nowrap; text-overflow: ellipsis; }
  .trade-stats strong small { color: #64748b; font-size: 7px; font-style: normal; font-weight: 650; letter-spacing: .03em; }
  .trade-currency-mark { display: grid; width: 10px; height: 10px; flex: 0 0 10px; place-items: center; color: #64748b; font-size: 7px; font-style: normal; font-weight: 750; }
  .trade-currency-mark svg { display: block; width: 10px; height: 10px; }
  .trade-stats span { color: #64748b; font-size: 8px; }
  .trade-stats .positive strong { color: #34d399; }
  .trade-stats .negative strong { color: #fb7185; }
  .trade-stats-wrap { position: relative; }
  .trade-stats-wrap:has(.trade-stats-breakdown:not(:empty)) .trade-stats { cursor: help; }
  .trade-stats-breakdown { position: fixed; z-index: 25; display: none; flex-direction: column; gap: 3px; margin: 0; padding: 8px; border: 1px solid rgba(96,165,250,.28); border-radius: 7px; background: #0a1119; box-shadow: 0 14px 34px rgba(0,0,0,.72); }
  .trade-stats-breakdown::after { content: ""; position: absolute; top: 0; bottom: 0; width: 7px; }
  .trade-stats-breakdown[data-side="left"]::after { left: 100%; }
  .trade-stats-breakdown[data-side="right"]::after { right: 100%; }
  .trade-stats-wrap:hover .trade-stats-breakdown:not(:empty) { display: flex; }
  .trade-stats-breakdown-title { color: #64748b; font-size: 8px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .trade-stats-breakdown-row { display: grid; grid-template-columns: minmax(78px,.85fr) minmax(0,3fr); align-items: center; gap: 8px; border-top: 1px solid rgba(148,163,184,.09); padding-top: 4px; }
  .trade-stats-breakdown-row:first-of-type { border-top: 0; padding-top: 1px; }
  .trade-stats-breakdown-head { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: 8px; }
  .trade-stats-breakdown-row strong { overflow: hidden; color: #dbe7f5; font-size: 10px; font-weight: 650; white-space: nowrap; text-overflow: ellipsis; }
  .trade-stats-breakdown-values { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 4px; }
  .trade-stats-breakdown-values > span { display: grid; min-width: 0; gap: 1px; }
  .trade-stats-breakdown-values small { color: #536174; font-size: 7px; font-weight: 700; letter-spacing: .035em; text-transform: uppercase; }
  .trade-stats-breakdown-values b { display: flex; min-width: 0; align-items: center; gap: 2px; overflow: hidden; color: #cbd5e1; font-size: 9px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; text-overflow: ellipsis; }
  .trade-stats-breakdown-values .trade-currency-mark, .trade-stats-breakdown-values .trade-currency-mark svg { width: 9px; height: 9px; flex-basis: 9px; }
  .trade-stats-breakdown-values .positive b { color: #34d399; }
  .trade-stats-breakdown-values .negative b { color: #fb7185; }
  .autosell-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .autosell-head > div { display: grid; gap: 1px; }
  .autosell-head strong { color: #dbe7f5; font-size: 11px; }
  .autosell-head span { color: #64748b; font-size: 8px; }
  .autosell-bundle-scope { display: grid; gap: 4px; }
  .autosell-bundle-scope > span { color: #64748b; font-size: 8px; font-weight: 700; text-transform: uppercase; }
  .autosell-groups { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 1px; }
  .autosell-groups button { flex: 0 0 auto; }
  .autosell-bundle-row { display: grid; grid-template-columns: 14px minmax(72px,1.1fr) repeat(3,minmax(0,1fr)); align-items: center; gap: 5px; padding: 6px 7px; border: 1px solid rgba(59,130,246,.28); border-radius: 7px; background: rgba(30,64,175,.08); }
  .autosell-bundle-row > strong { overflow: hidden; color: #93c5fd; font-size: 9px; white-space: nowrap; text-overflow: ellipsis; }
  .autosell-table { display: grid; overflow: hidden; border: 1px solid rgba(148,163,184,.14); border-radius: 7px; background: rgba(5,11,18,.22); }
  .autosell-labels, .autosell-row { display: grid; grid-template-columns: 14px minmax(72px,1.1fr) repeat(3,minmax(0,1fr)); align-items: center; gap: 5px; padding: 5px 7px; }
  .autosell-labels { border-bottom: 1px solid rgba(148,163,184,.10); color: #64748b; font-size: 7px; font-weight: 700; letter-spacing: .035em; text-transform: uppercase; }
  .autosell-row + .autosell-row { border-top: 1px solid rgba(148,163,184,.08); }
  .autosell-row > strong { position: relative; overflow: hidden; color: #cbd5e1; font-size: 9px; font-weight: 650; white-space: nowrap; text-overflow: ellipsis; }
  .autosell-row > strong[data-live]::after { content: ""; display: inline-block; width: 5px; height: 5px; margin-left: 4px; border-radius: 50%; background: #34d399; vertical-align: 1px; }
  .autosell-select { height: 27px; min-width: 0; padding: 0 5px; font-size: 8px; text-overflow: ellipsis; }
  .autosell-row > input, .autosell-bundle-row > input { width: 11px; height: 11px; margin: 0; accent-color: #3b82f6; }
  .managed-wallets { position: relative; display: grid; flex: 0 0 auto; }
  .panel.transparent .trade-block, .panel.transparent .creator-actions, .panel.transparent .execution-panel { background: rgba(5,11,18,.18); border-color: rgba(255,255,255,.08); }
  .managed-wallets > summary { display: flex; height: 25px; align-items: center; gap: 4px; border: 1px solid rgba(148,163,184,.16); border-radius: 999px; padding: 0 7px; background: rgba(148,163,184,.035); color: #94a3b8; cursor: pointer; list-style: none; }
  .managed-wallets > summary::-webkit-details-marker { display: none; }
  .managed-wallets > summary:hover, .managed-wallets[open] > summary { border-color: rgba(96,165,250,.38); background: rgba(59,130,246,.10); color: #bfdbfe; }
  .managed-wallets > summary svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .managed-wallets > summary strong { color: #cbd5e1; font-size: 9px; font-weight: 700; }
  .managed-wallets > summary span { color: #64748b; font-size: 9px; transition: transform .14s ease; }
  .managed-wallets[open] > summary span { transform: rotate(180deg); }
  .managed-wallet-content { position: fixed; z-index: 30; display: grid; width: 240px; max-height: min(480px, calc(100vh - 40px)); overflow-y: auto; gap: 6px; border: 1px solid rgba(96,165,250,.28); border-radius: 8px; padding: 8px; background: #0a1119; box-shadow: 0 18px 44px rgba(0,0,0,.74); }
  .wallet-flyout-label { color: #64748b; font-size: 7px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .wallet-flyout-label + .wallet-groups, .wallet-flyout-label + .wallet-list { margin-top: -2px; }
  .wallet-loading { display: flex; min-height: 38px; align-items: center; justify-content: space-between; gap: 8px; color: #64748b; font-size: 9px; }
  .wallet-groups { display: flex; flex-wrap: wrap; gap: 4px; }
  .wallet-groups button, .wallet-link { min-height: 24px; border: 1px solid rgba(59,130,246,.25); border-radius: 4px; padding: 0 7px; background: rgba(59,130,246,.08); color: #93c5fd; font-size: 8px; cursor: pointer; }
  .wallet-groups button:hover, .wallet-link:hover { border-color: rgba(96,165,250,.58); background: rgba(59,130,246,.14); }
  .wallet-groups button.selected { border-color: rgba(96,165,250,.65); background: rgba(59,130,246,.18); color: #bfdbfe; }
  .wallet-link:disabled { cursor: wait; opacity: .65; }
  .wallet-list { display: grid; overflow: hidden; border: 1px solid rgba(148,163,184,.11); border-radius: 5px; }
  .wallet-row-item { display: grid; border-top: 1px solid rgba(148,163,184,.08); }
  .wallet-row-item:first-child { border-top: 0; }
  .wallet-row { display: grid; min-width: 0; grid-template-columns: 14px minmax(0,1fr) auto auto; align-items: center; gap: 8px; padding: 7px 8px; background: rgba(148,163,184,.012); transition: background .12s ease; cursor: pointer; }
  .wallet-row-balance { display: grid; gap: 1px; justify-items: end; color: #94a3b8; font-size: 8px; font-weight: 600; white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
  .wallet-row-balance.muted { color: #64748b; }
  .wallet-row-balance small { color: #64748b; font-size: 7px; font-weight: 600; }
  .wallet-row:hover { background: rgba(148,163,184,.035); }
  .wallet-row.selected { background: rgba(59,130,246,.055); }
  .wallet-row > input[type="checkbox"] { width: 14px; height: 14px; accent-color: #3b82f6; }
  .wallet-row > span { min-width: 0; }
  .wallet-row > span:nth-child(2) { display: grid; gap: 1px; }
  .wallet-row strong { overflow: hidden; color: #dbe7f5; font-size: 10px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .wallet-row small { overflow: hidden; color: #536174; font-size: 7px; text-overflow: ellipsis; white-space: nowrap; }
  .wallet-auto-button { height: 18px; border: 1px solid rgba(148,163,184,.16); border-radius: 4px; padding: 0 5px; background: transparent; color: #64748b; font-size: 7px; font-weight: 700; cursor: pointer; }
  .wallet-auto-button:hover, .wallet-row-item.automation-open .wallet-auto-button { border-color: rgba(59,130,246,.34); background: rgba(59,130,246,.10); color: #93c5fd; }
  .wallet-auto-panel { display: none; align-items: center; justify-content: flex-end; gap: 4px; padding: 0 8px 7px; }
  .wallet-row-item.automation-open .wallet-auto-panel { display: flex; }
  .wallet-auto-panel label { display: inline-flex; align-items: center; gap: 3px; height: 18px; border: 1px solid rgba(148,163,184,.14); border-radius: 4px; padding: 0 5px; background: rgba(15,23,42,.35); color: #64748b; font-size: 7px; font-weight: 700; cursor: pointer; }
  .wallet-auto-panel label.active { border-color: rgba(52,211,153,.28); background: rgba(52,211,153,.08); color: #6ee7b7; }
  .wallet-auto-panel input { width: 9px; height: 9px; margin: 0; accent-color: #34d399; }
  .creator-wallet-scope { display: grid; gap: 7px; border: 1px solid rgba(148,163,184,.12); border-radius: 6px; padding: 8px; background: rgba(148,163,184,.025); }
  .creator-wallet-scope > summary { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 8px; color: #94a3b8; font-size: 10px; cursor: pointer; list-style: none; }
  .creator-wallet-scope > summary::-webkit-details-marker { display: none; }
  .creator-wallet-scope > summary strong { overflow: hidden; color: #cbd5e1; font-size: 10px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
  .creator-wallet-scope > summary i { color: #64748b; font-style: normal; transition: transform .14s ease; }
  .creator-wallet-scope[open] > summary i { transform: rotate(180deg); }
  .creator-wallet-scope-body { display: grid; gap: 6px; padding-top: 2px; }
  .trade-block { display: grid; gap: 6px; border: 0; border-radius: 0; padding: 7px 3px; background: transparent; }
  .trade-block + .trade-block { border-top: 1px solid rgba(148,163,184,.12); }
  .trade-heading { display: flex; align-items: center; justify-content: space-between; }
  .trade-heading strong { color: #cbd5e1; font-size: 12px; }
  .trade-heading span { color: #64748b; font-size: 9px; }
  .trade-heading-tools { display: flex; align-items: center; gap: 5px; }
  .quick-settings { display: grid; width: 24px; height: 24px; place-items: center; border: 1px solid transparent; border-radius: 4px; padding: 0; background: transparent; color: #64748b; cursor: pointer; }
  .quick-settings:hover { border-color: rgba(148,163,184,.16); background: rgba(148,163,184,.07); color: #cbd5e1; }
  .quick-settings.active { border-color: rgba(96,165,250,.34); background: rgba(59,130,246,.12); color: #60a5fa; }
  .quick-settings svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .trade-quick { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .trade-quick input { height: 27px; padding: 0 4px; font-size: 9px; text-align: center; }
  .trade-quick button { height: 32px; border: 1px solid rgba(148,163,184,.14); border-radius: 6px; background: #0b111a; color: #cbd5e1; font-size: 10px; font-weight: 650; cursor: pointer; }
  .panel.transparent .trade-quick button { border-color: rgba(255,255,255,.12); background: rgba(5,11,18,.30); }
  .trade-quick button:hover, .trade-quick button.selected { border-color: rgba(96,165,250,.48); background: rgba(59,130,246,.12); color: #60a5fa; }
  .trade-quick.sell button { border-color: rgba(244,63,94,.20); color: #fda4af; }
  .trade-quick.sell button:hover, .trade-quick.sell button.selected { border-color: rgba(244,63,94,.50); background: rgba(244,63,94,.10); color: #fb7185; }
  .trade-quick button:disabled { cursor: not-allowed; opacity: .55; }
  .trade-quick:not(.sell) button:not(:disabled) { border-color: rgba(52,211,153,.46); background: rgba(16,185,129,.06); color: #86efac; }
  .trade-quick:not(.sell) button:not(:disabled):hover { border-color: rgba(52,211,153,.76); background: rgba(16,185,129,.13); color: #bbf7d0; }
  .trade-sell-initial { height: 28px; }
  .sell-automations-tab { display: grid; gap: 8px; }
  .sell-automations-tab .automation-card:first-child { border-top: 0; padding-top: 2px; }
  .automation-card { display: grid; grid-template-columns: 1fr auto; gap: 6px 8px; border-top: 1px solid rgba(148,163,184,.10); padding-top: 8px; }
  .automation-card > div:first-child { display: grid; gap: 2px; }
  .automation-card > div:first-child strong { color: #cbd5e1; font-size: 10px; }
  .automation-card > div:first-child span { color: #64748b; font-size: 8px; }
  .automation-inputs { display: grid; grid-column: 1 / -1; grid-row: 2; grid-template-columns: 1fr 1fr; gap: 5px; }
  .automation-field { display: grid; min-width: 0; gap: 3px; }
  .automation-field strong { color: #94a3b8; font-size: 8px; font-weight: 650; }
  .automation-field small { min-height: 20px; color: #536174; font-size: 7px; line-height: 1.35; }
  .automation-field input { height: 29px; font-size: 9px; }
  .automation-toggle { grid-column: 2; grid-row: 1; min-width: 58px; height: 27px; border: 1px solid rgba(59,130,246,.32); border-radius: 4px; background: rgba(59,130,246,.10); color: #60a5fa; font-size: 9px; font-weight: 650; cursor: pointer; }
  .automation-toggle.active { border-color: rgba(239,68,68,.30); background: rgba(239,68,68,.08); color: #f87171; }
  .automation-toggle:disabled { cursor: not-allowed; opacity: .4; }
  .wallet-trade-fields .automation-field:first-child { grid-column: 1 / -1; }
  .wallet-trade-fields .automation-field:nth-child(2) { grid-column: 1 / -1; }
  .wallet-trade-fields .wallet-minimum-sell-field { grid-column: 1 / -1; }
  .wallet-trade-fields .wallet-minimum-sell-field[hidden] { display: none; }
  .wallet-trade-fields .check-row { grid-column: 1 / -1; }
  .wallet-address-picker { display: grid; gap: 5px; }
  .wallet-address-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .wallet-address-chip { display: inline-flex; min-width: 0; align-items: center; gap: 4px; border: 1px solid rgba(96,165,250,.24); border-radius: 999px; padding: 3px 4px 3px 7px; background: rgba(59,130,246,.08); color: #bfdbfe; font: 500 8px/1.2 monospace; }
  .wallet-address-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wallet-address-chip button { display: grid; width: 15px; height: 15px; place-items: center; border: 0; border-radius: 50%; padding: 0; background: rgba(148,163,184,.10); color: #94a3b8; font-size: 11px; cursor: pointer; }
  .wallet-address-chip button:hover { background: rgba(244,63,94,.16); color: #fb7185; }
  .wallet-address-add { display: grid; min-height: 34px; place-items: center; gap: 1px; border: 1px dashed rgba(96,165,250,.30); border-radius: 5px; padding: 5px 8px; background: rgba(59,130,246,.045); color: #60a5fa; cursor: pointer; }
  .wallet-address-add:hover { border-color: rgba(96,165,250,.62); background: rgba(59,130,246,.10); }
  .wallet-address-add strong { color: inherit; font-size: 9px; font-weight: 650; }
  .wallet-address-add small { color: #64748b; font-size: 7px; }
  .wallet-address-prompt { display: grid; gap: 6px; border: 1px solid rgba(96,165,250,.28); border-radius: 6px; padding: 7px; background: rgba(5,11,18,.72); box-shadow: 0 8px 22px rgba(0,0,0,.24); }
  .wallet-address-prompt textarea { min-height: 58px; }
  .wallet-address-prompt > div { display: flex; justify-content: flex-end; gap: 5px; }
  .wallet-address-prompt > div button { height: 25px; border: 1px solid rgba(148,163,184,.18); border-radius: 4px; padding: 0 9px; background: rgba(148,163,184,.06); color: #94a3b8; font-size: 8px; font-weight: 650; cursor: pointer; }
  .wallet-address-prompt > div button:hover { border-color: rgba(148,163,184,.34); color: #cbd5e1; }
  .wallet-address-prompt > div button.primary-inline { border-color: rgba(96,165,250,.38); background: rgba(59,130,246,.14); color: #60a5fa; }
  .wallet-trade-fields select { height: 29px; font-size: 9px; }
  .wallet-trade-execution { grid-column: 1 / -1; grid-row: 3; border-top: 1px solid rgba(148,163,184,.08); padding-top: 6px; }
  .wallet-trade-execution > summary { color: #94a3b8; font-size: 8px; font-weight: 650; cursor: pointer; }
  .wallet-trade-execution-body { display: grid; gap: 5px; padding-top: 5px; }
  .wallet-trade-execution-body > select, .wallet-trade-custom-execution > input { height: 29px; font-size: 9px; }
  .wallet-trade-custom-execution { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
  .wallet-trade-custom-execution[hidden] { display: none; }
  .wallet-trade-senders { display: grid; grid-column: 1 / -1; grid-template-columns: repeat(3, 1fr); gap: 3px; }
  .wallet-trade-senders button { min-width: 0; height: 23px; overflow: hidden; border: 1px solid rgba(148,163,184,.14); border-radius: 4px; background: transparent; color: #64748b; font-size: 7px; text-overflow: ellipsis; cursor: pointer; }
  .wallet-trade-senders button.active { border-color: rgba(59,130,246,.44); background: rgba(59,130,246,.12); color: #93c5fd; }
  .creator-actions { display: grid; gap: 7px; border: 1px solid rgba(148,163,184,.12); border-radius: 6px; padding: 8px; background: rgba(148,163,184,.025); }
  .creator-actions summary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 28px; color: #94a3b8; cursor: pointer; list-style: none; }
  .creator-actions summary::-webkit-details-marker { display: none; }
  .creator-actions summary strong { justify-self: end; }
  .creator-actions summary::after { content: "Expand"; min-width: 52px; border: 1px solid rgba(96,165,250,.30); border-radius: 4px; padding: 4px 6px; background: rgba(59,130,246,.08); color: #60a5fa; font-size: 8px; font-weight: 650; text-align: center; }
  .creator-actions[open] summary::after { content: "Collapse"; }
  .creator-actions summary:hover::after { border-color: rgba(96,165,250,.62); background: rgba(59,130,246,.15); color: #bfdbfe; }
  .creator-actions span { color: #94a3b8; font-size: 10px; font-weight: 550; }
  .creator-actions strong { color: #cbd5e1; font-size: 10px; font-weight: 600; }
  .creator-actions > div:last-child { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .creator-actions .compact-field { margin: 0; }
  .secondary-action, .danger-action { height: 29px; border-radius: 5px; font-size: 9px; font-weight: 650; cursor: pointer; }
  .secondary-action { border: 1px solid rgba(59,130,246,.32); background: rgba(59,130,246,.10); color: #60a5fa; }
  .secondary-action:hover { border-color: #60a5fa; background: rgba(59,130,246,.17); }
  .danger-action { border: 1px solid rgba(239,68,68,.3); background: rgba(239,68,68,.08); color: #f87171; }
  .danger-action:hover { border-color: rgba(248,113,113,.58); background: rgba(239,68,68,.14); }
  .secondary-action:disabled, .danger-action:disabled { cursor: not-allowed; opacity: .4; }
  p { margin: 0; color: #64748b; font-size: 10px; line-height: 1.45; }
  .primary { height: 34px; border: 1px solid rgba(59,130,246,.48); border-radius: 5px; background: rgba(59,130,246,.17); color: #60a5fa; font-size: 11px; font-weight: 650; cursor: pointer; }
  .primary:hover { border-color: #60a5fa; background: rgba(59,130,246,.24); }
  .primary:disabled { cursor: not-allowed; opacity: .4; }
  .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid rgba(148,163,184,.12); border-radius: 5px; padding: 8px 9px; background: rgba(148,163,184,.035); }
  .switch-row span { display: grid; gap: 2px; }
  .switch-row strong { color: #cbd5e1; font-size: 11px; font-weight: 600; }
  .switch-row small { color: #64748b; font-size: 9px; }
  .switch-row input { width: 14px; height: 14px; padding: 0; accent-color: #3b82f6; }
  .loading { padding: 14px; color: #64748b; font-size: 10px; text-align: center; }
  .task-section { display: grid; gap: 7px; border-top: 1px solid rgba(148,163,184,.12); padding-top: 10px; }
  details.task-section { border: 1px solid rgba(148,163,184,.12); border-radius: 6px; padding: 8px; background: rgba(148,163,184,.025); }
  .task-collapse-summary { color: #94a3b8; font-size: 10px; font-weight: 650; cursor: pointer; user-select: none; }
  details.task-section[open] .task-collapse-summary { margin-bottom: 2px; color: #cbd5e1; }
  .task-heading { display: flex; align-items: center; justify-content: space-between; }
  .task-heading strong { color: #cbd5e1; font-size: 10px; font-weight: 650; }
  .task-heading button { border: 0; padding: 2px 0; background: transparent; color: #60a5fa; font-size: 9px; cursor: pointer; }
  .task-heading button:disabled { color: #64748b; cursor: default; }
  .task-list { display: grid; gap: 7px; min-height: 0; }
  .task-list.scrollable { max-height: 176px; overflow-y: auto; overscroll-behavior: contain; padding-right: 3px; scrollbar-width: thin; scrollbar-color: rgba(96,165,250,.45) transparent; }
  .task-list.scrollable::-webkit-scrollbar { width: 4px; }
  .task-list.scrollable::-webkit-scrollbar-thumb { border-radius: 999px; background: rgba(96,165,250,.42); }
  .task-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 7px; border: 1px solid rgba(148,163,184,.13); border-radius: 6px; padding: 8px; background: rgba(148,163,184,.035); }
  .task-row > div:first-child { min-width: 0; }
  .task-row strong, .task-row span { display: block; }
  .task-row strong { overflow: hidden; color: #dbe5f1; font-size: 10px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .task-row div > span { margin-top: 2px; color: #64748b; font-size: 9px; }
  .task-state { align-self: start; border-radius: 999px; padding: 2px 6px; background: rgba(148,163,184,.10); color: #94a3b8; font-size: 8px; text-transform: capitalize; }
  .task-state.armed { background: rgba(59,130,246,.15); color: #60a5fa; }
  .task-state.failed, .task-state.expired { background: rgba(239,68,68,.12); color: #f87171; }
  .task-state.completed, .task-state.landed { background: rgba(34,197,94,.12); color: #4ade80; }
  .task-actions { display: flex; grid-column: 1 / -1; gap: 6px; }
  .task-actions button { height: 24px; border: 1px solid rgba(148,163,184,.18); border-radius: 4px; padding: 0 8px; background: rgba(148,163,184,.05); color: #94a3b8; font-size: 9px; cursor: pointer; }
  .task-actions button:hover { border-color: rgba(96,165,250,.5); color: #60a5fa; }
  .task-actions button.danger:hover { border-color: rgba(248,113,113,.45); color: #f87171; }
  .task-actions button:disabled { cursor: not-allowed; opacity: .45; }
  .task-row small { grid-column: 1 / -1; overflow: hidden; color: #64748b; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
  .snipe-editor { display: grid; gap: 8px; }
  .add-task { display: flex; align-items: center; gap: 4px; }
  .add-task select { width: 78px; height: 25px; padding: 0 6px; font-size: 9px; }
  .add-task button { display: grid; width: 25px; height: 25px; place-items: center; border: 1px solid rgba(59,130,246,.32); border-radius: 4px; background: rgba(59,130,246,.12); color: #60a5fa; font-size: 16px; line-height: 1; cursor: pointer; }
  .add-task button:hover { border-color: #60a5fa; background: rgba(59,130,246,.2); }
  .empty-add { display: grid; gap: 3px; width: 100%; border: 1px dashed rgba(59,130,246,.3); border-radius: 6px; padding: 13px; background: rgba(59,130,246,.04); color: #60a5fa; text-align: left; cursor: pointer; }
  .empty-add:hover { background: rgba(59,130,246,.08); }
  .empty-add strong { font-size: 10px; font-weight: 650; }
  .empty-add span { color: #64748b; font-size: 9px; }
  .draft-row { overflow: hidden; border: 1px solid rgba(148,163,184,.14); border-radius: 7px; background: rgba(148,163,184,.025); }
  .draft-header { display: grid; grid-template-columns: 22px minmax(0, 1fr) 25px; align-items: center; gap: 6px; border-bottom: 1px solid rgba(148,163,184,.1); padding: 6px; background: rgba(148,163,184,.035); }
  .draft-number { display: grid; width: 20px; height: 20px; place-items: center; border-radius: 4px; background: rgba(59,130,246,.13); color: #60a5fa; font-size: 9px; font-weight: 700; }
  .draft-type { height: 27px; border: 0; padding: 0 5px; background: transparent; color: #dbe5f1; font-size: 10px; font-weight: 650; }
  .draft-type:focus { box-shadow: none; }
  .remove-draft { display: grid; width: 24px; height: 24px; place-items: center; border: 0; border-radius: 4px; background: transparent; color: #64748b; font-size: 16px; cursor: pointer; }
  .remove-draft:hover { background: rgba(239,68,68,.09); color: #f87171; }
  .draft-fields { display: grid; gap: 8px; padding: 9px; }
  .context-preset { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 31px; border: 1px solid rgba(59,130,246,.28); border-radius: 6px; padding: 6px 8px; background: rgba(59,130,246,.08); color: #60a5fa; text-align: left; cursor: pointer; }
  .context-preset:hover { background: rgba(59,130,246,.14); }
  .context-preset span { font-size: 10px; font-weight: 600; }
  .context-preset strong { color: #bfdbfe; font-size: 10px; font-weight: 600; }
  .field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
  .field-grid .field { min-width: 0; }
  .execution-panel { display: grid; gap: 8px; border: 1px solid rgba(148,163,184,.12); border-radius: 6px; padding: 8px; background: rgba(148,163,184,.025); }
  .execution-panel summary { color: #94a3b8; font-size: 10px; font-weight: 600; cursor: pointer; user-select: none; }
  .execution-panel[open] summary { margin-bottom: 8px; color: #cbd5e1; }
  .execution-panel > *:not(summary) { margin-top: 7px; }
  .check-row.compact { padding: 6px 7px; }
  .sender-grid { display: flex; flex-wrap: wrap; gap: 5px; }
  .sender-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid rgba(148,163,184,.16); border-radius: 4px; padding: 5px 6px; background: rgba(148,163,184,.03); color: #94a3b8; font-size: 8px; cursor: pointer; }
  .sender-chip input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .sender-chip.selected { border-color: rgba(59,130,246,.48); background: rgba(59,130,246,.14); color: #60a5fa; }
  .check-row { display: flex; align-items: center; gap: 8px; border: 1px solid rgba(148,163,184,.12); border-radius: 5px; padding: 7px 8px; background: rgba(148,163,184,.025); cursor: pointer; }
  .check-row input { width: 14px; height: 14px; flex: 0 0 14px; padding: 0; accent-color: #3b82f6; }
  .check-row span { display: grid; gap: 2px; }
  .check-row strong { color: #cbd5e1; font-size: 10px; font-weight: 600; }
  .check-row small { color: #64748b; font-size: 8px; }
  .transfer-grid { display: grid; grid-template-columns: minmax(0, 1fr) 82px; gap: 7px; }
  @media (max-width: 390px) {
    .panel { width: calc(100vw - 16px); }
  }
`;
