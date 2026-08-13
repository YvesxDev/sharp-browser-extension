import { useEffect, useMemo, useRef, useState } from "react";
import {
  solanaSenders,
  type AutomationLifecycle,
  type AutomationTaskOptions,
  type AutomationTaskType,
  type AutomationEventExecutionSettings,
  type CreatorSellSettings,
  type CustomTradeLauncherState,
  type ExtensionSnapshot,
  type ManagedWalletState,
  type MigrationSellSettings,
  type PositionAutomationPolicy,
  type RuntimeResponse,
  type SharpChain,
  type SiteId,
  type SnipeTaskSummary,
  type SolanaSender,
  type WalletExecutionPlan
} from "../../src/protocol";

const defaultPositionAutomation = (): PositionAutomationPolicy => ({
  creatorSell: true,
  migrationSell: true,
  walletTradeSell: true
});

const chainLabels: Record<SharpChain, string> = {
  solana: "Solana",
  bsc: "BSC",
  base: "Base",
  robinhood: "Robinhood"
};
const siteLabels: Record<SiteId, string> = {
  axiom: "Axiom",
  padre: "Terminal / Padre",
  gmgn: "GMGN",
  basedbot: "BasedBot",
  pumpfun: "Pump.fun",
  fomo: "Fomo",
  dexscreener: "DEX Screener"
};
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

const marketLabels: Record<string, string> = {
  pumpfun: "PumpFun",
  pumpfun_amm: "PumpFun AMM",
  moonshot: "Moonshot",
  raydium_camm: "Raydium CAMM",
  raydium_cpmm: "Raydium CPMM",
  raydium_launchpad: "Raydium Launchpad",
  meteora_dammv2: "Meteora DAMM V2",
  meteora_dyn: "Meteora DYN",
  meteora_dlmm: "Meteora DLMM",
  meteora_dbc: "Meteora DBC",
  heavendex: "HeavenDex"
};

const marketLabel = (market: string) => marketLabels[market]
  ?? market.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
const sharpWebUiUrl = "https://webui.yvesdev.com";
const sharpApiKeyPattern = /^SHARP-[A-Z0-9]{5}(?:-[A-Z0-9]{5}){3}$/;
const remotePermissionOrigin = (endpoint: string) => {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.hostname}/*`;
};

interface RemoteConnectionDraft {
  id: string;
  endpoint: string;
  remote: true;
  apiKey: string;
  discordUserId: string;
  clientIp: string;
}

const openSharpWebUi = () => {
  void browser.tabs.create({ url: sharpWebUiUrl });
};

const snipeTaskStatusLabel = (status: SnipeTaskSummary["status"]) => ({
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

type TaskFeatureFilter = "allow" | "exclude" | "only";

interface PopupTaskDraft {
  taskType: AutomationTaskType;
  label: string;
  target: string;
  ticker: string;
  match: "exact" | "contains";
  matchTokenName: boolean;
  lifecycle: AutomationLifecycle;
  markets: string[];
  minimumQuoteLiquidity: string;
  minimumCreationQuoteLiquidity: string;
  maximumLaunchFeePercent: string;
  maximumPriceImpactPercent: string;
  allowToken2022TransferHook: boolean;
  allowOneSidedDammV2: boolean;
  skipPresetFilters: boolean;
  cashbackFilter: TaskFeatureFilter;
  mayhemFilter: TaskFeatureFilter;
  amount: string;
  priorityFee: string;
  tip: string;
  slippage: string;
  inheritExecution: boolean;
  senders: SolanaSender[];
  senderOverrides: Partial<Record<SolanaSender, { priorityFee: string; tip: string }>>;
  spamEnabled: boolean;
  startDelaySeconds: string;
  transactionsPerSecond: string;
  stopAfterSeconds: string;
  maxTotalFeesSol: string;
  stopOnPoolOpen: boolean;
  stopAfterPoolOpenSeconds: string;
  transferEnabled: boolean;
  transferWallet: string;
  transferPercentage: string;
  oneShot: boolean;
  maxMatches: string;
  arm: boolean;
}

const newPopupTaskDraft = (): PopupTaskDraft => ({
  taskType: "dev",
  label: "",
  target: "",
  ticker: "",
  match: "exact",
  matchTokenName: false,
  lifecycle: "both",
  markets: [],
  minimumQuoteLiquidity: "",
  minimumCreationQuoteLiquidity: "",
  maximumLaunchFeePercent: "",
  maximumPriceImpactPercent: "",
  allowToken2022TransferHook: true,
  allowOneSidedDammV2: true,
  skipPresetFilters: false,
  cashbackFilter: "allow",
  mayhemFilter: "allow",
  amount: "",
  priorityFee: "",
  tip: "",
  slippage: "",
  inheritExecution: true,
  senders: [],
  senderOverrides: {},
  spamEnabled: false,
  startDelaySeconds: "0",
  transactionsPerSecond: "10",
  stopAfterSeconds: "20",
  maxTotalFeesSol: "0.05",
  stopOnPoolOpen: true,
  stopAfterPoolOpenSeconds: "0",
  transferEnabled: false,
  transferWallet: "",
  transferPercentage: "100",
  oneShot: false,
  maxMatches: "100",
  arm: true
});

async function request(message: object): Promise<RuntimeResponse> {
  return browser.runtime.sendMessage(message) as Promise<RuntimeResponse>;
}

function QuickAmountsEditor({
  chain,
  values,
  onChange
}: {
  chain: SharpChain;
  values: number[];
  onChange: (values: number[]) => void;
}) {
  const paddedValues = Array.from({ length: 8 }, (_, index) => values[index] ?? 0);
  const [drafts, setDrafts] = useState(() => paddedValues.map(String));

  useEffect(() => {
    setDrafts(paddedValues.map(String));
  }, [values]);

  const commitSlot = (index: number) => {
    const parsed = Number(drafts[index]);
    const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    const next = paddedValues.map((amount, slot) => slot === index ? value : amount);
    setDrafts(next.map(String));
    onChange(next);
  };

  return (
    <div className="amountEditor">
      <div className="amountSlotGrid">
        {drafts.map((draft, index) => (
          <label className={Number(draft) > 0 ? "amountSlot active" : "amountSlot"} key={index}>
            <small>{index + 1}</small>
            <input
              aria-label={`${chain} quick amount ${index + 1}`}
              inputMode="decimal"
              value={draft}
              onChange={(event) => setDrafts((current) => current.map((value, slot) => slot === index ? event.target.value : value))}
              onBlur={() => commitSlot(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function EventExecutionEditor({
  title,
  value,
  allowedSenders = solanaSenders,
  showSenders = true,
  showTip = true,
  feeLabel = "Priority fee (SOL)",
  presetPriorityFee,
  canSave,
  onSave
}: {
  title: string;
  value: AutomationEventExecutionSettings;
  allowedSenders?: readonly SolanaSender[];
  showSenders?: boolean;
  showTip?: boolean;
  feeLabel?: string;
  presetPriorityFee?: number | undefined;
  canSave: boolean;
  onSave: (value: AutomationEventExecutionSettings) => Promise<void>;
}) {
  const priorityFeePlaceholder = presetPriorityFee != null ? String(presetPriorityFee) : "Preset";
  const valueKey = JSON.stringify(value);
  const [draft, setDraft] = useState(value);
  const [priorityFee, setPriorityFee] = useState(value.priorityFee?.toString() ?? "");
  const [tip, setTip] = useState(value.tip?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(value);
    setPriorityFee(value.priorityFee?.toString() ?? "");
    setTip(value.tip?.toString() ?? "");
  }, [valueKey]);
  const parse = (raw: string, label: string) => {
    if (!raw.trim()) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be zero or greater.`);
    return parsed;
  };
  return (
    <section className="field eventExecution">
      <div className="fieldHead"><strong>{title}</strong></div>
      <div className="senderMode" role="group" aria-label={`${title} route mode`}>
        <button type="button" className={!draft.enabled ? "active" : ""} onClick={() => setDraft({ ...draft, enabled: false })}>Trading preset</button>
        <button type="button" className={draft.enabled ? "active" : ""} onClick={() => setDraft({ ...draft, enabled: true })}>Custom</button>
      </div>
      {draft.enabled && <>
        {showSenders && <div className="eventSenderGrid">
          {allowedSenders.map((sender) => {
            const selected = draft.senders.includes(sender);
            return <button type="button" key={sender} className={selected ? "active" : ""} onClick={() => setDraft({
              ...draft,
              senders: selected ? draft.senders.filter((item) => item !== sender) : [...draft.senders, sender]
            })}>{senderLabels[sender]}</button>;
          })}
        </div>}
        <div className={showTip ? "executionFields" : "executionFields single"}>
          <label>{feeLabel}<input inputMode="decimal" placeholder={priorityFeePlaceholder} value={priorityFee} onChange={(event) => setPriorityFee(event.target.value)} /></label>
          {showTip && <label>Relay tip (SOL)<input inputMode="decimal" placeholder="Preset" value={tip} onChange={(event) => setTip(event.target.value)} /></label>}
        </div>
      </>}
      {error && <div className="error">{error}</div>}
      <button
        className="secondary eventExecutionSave"
        disabled={saving || !canSave}
        title={canSave ? undefined : "Connect a compatible client to save"}
        onClick={async () => {
        try {
          setSaving(true);
          setError("");
          const parsedPriorityFee = parse(priorityFee, "Priority fee");
          const parsedTip = parse(tip, "Relay tip");
          const { priorityFee: _priorityFee, tip: _tip, ...base } = draft;
          await onSave({
            ...base,
            senders: showSenders ? base.senders : [],
            ...(parsedPriorityFee === undefined ? {} : { priorityFee: parsedPriorityFee }),
            ...(showTip && parsedTip !== undefined ? { tip: parsedTip } : {})
          });
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : `Could not save ${title}.`);
        } finally {
          setSaving(false);
        }
      }}>{saving ? "Saving…" : "Save"}</button>
    </section>
  );
}

function MultiWalletManager({
  snapshot,
  onSnapshot,
  clientId
}: {
  snapshot: ExtensionSnapshot;
  onSnapshot: (snapshot: ExtensionSnapshot) => void;
  clientId: string;
}) {
  const clients = snapshot.clients.filter((client) =>
    client.connected
    && client.authenticated
    && client.capabilities
    && client.capabilities.module !== "unknown"
  );
  const [inventory, setInventory] = useState<ManagedWalletState>();
  const [shares, setShares] = useState<Record<string, number>>({});
  const [automationByWallet, setAutomationByWallet] = useState<Record<string, PositionAutomationPolicy>>({});
  const [expandedAutomationWallet, setExpandedAutomationWallet] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [randomize, setRandomize] = useState(false);
  const [variation, setVariation] = useState(10);
  const [autoRebalance, setAutoRebalance] = useState(false);
  const [lookupSelection, setLookupSelection] = useState<string[]>([]);
  const [newWallet, setNewWallet] = useState("");
  const [nonceCounts, setNonceCounts] = useState<Record<string, string>>({});
  const [newGroupName, setNewGroupName] = useState("");
  const [activeWalletName, setActiveWalletName] = useState("");
  const [copiedWallet, setCopiedWallet] = useState("");
  const [renamingGroupId, setRenamingGroupId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingWallet, setRenamingWallet] = useState("");
  const [renameWalletDraft, setRenameWalletDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [planSyncing, setPlanSyncing] = useState(false);
  const hydratedPlanClient = useRef("");
  const planRevision = useRef(0);

  const copyAddress = async (wallet: string, address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedWallet(wallet);
      setTimeout(() => setCopiedWallet((current) => current === wallet ? "" : current), 1200);
    } catch {
      setError("Could not copy the wallet address");
    }
  };

  const renameWallet = async (currentName: string) => {
    const name = renameWalletDraft.trim();
    if (!name || name === currentName) { setRenamingWallet(""); return; }
    if (inventory?.wallets.some((wallet) => wallet.name.toLowerCase() === name.toLowerCase())) {
      setError("A wallet with this name already exists");
      return;
    }
    setBusy("rename-wallet");
    const response = await request({ type: "sharp:rename-managed-wallet", clientId, oldName: currentName, name });
    if (response.ok && response.managedWallets) {
      setInventory(response.managedWallets);
      setShares((current) => {
        if (!Object.hasOwn(current, currentName)) return current;
        const next: Record<string, number> = {};
        for (const [key, value] of Object.entries(current)) {
          next[key === currentName ? name : key] = value;
        }
        return next;
      });
      setAutomationByWallet((current) => {
        if (!Object.hasOwn(current, currentName)) return current;
        const next = { ...current, [name]: current[currentName]! };
        delete next[currentName];
        return next;
      });
      if (expandedAutomationWallet === currentName) setExpandedAutomationWallet(name);
      if (activeWalletName === currentName) setActiveWalletName(name);
      setRenamingWallet("");
      setError("");
    } else setError(response.ok ? "Sharp did not return the renamed wallet" : response.error);
    setBusy("");
  };

  const saveGroups = async (groups: ManagedWalletState["groups"], busyKey: string) => {
    if (!clientId) return false;
    setBusy(busyKey);
    const response = await request({ type: "sharp:update-wallet-groups", clientId, groups });
    if (response.ok && response.managedWallets) {
      setInventory(response.managedWallets);
      setError("");
      setBusy("");
      return true;
    }
    setError(response.ok ? "Sharp did not return the saved wallet groups" : response.error);
    setBusy("");
    return false;
  };

  const load = async (target = clientId) => {
    if (!target) return;
    setBusy("refresh");
    const response = await request({ type: "sharp:get-managed-wallets", clientId: target, balances: true });
    if (!response.ok || !response.managedWallets) {
      setError(response.ok ? "Sharp did not return managed wallets" : response.error);
      setBusy("");
      return;
    }
    const next = response.managedWallets;
    const activeResponse = await request({ type: "sharp:get-active-wallet-balance", clientId: target });
    const active = activeResponse.ok ? activeResponse.activeWalletBalance : undefined;
    setActiveWalletName(active
      ? next.wallets.find((wallet) => wallet.address === active.address)?.name ?? active.name ?? ""
      : "");
    const hydrated = active ? {
      ...next,
      wallets: next.wallets.map((wallet) =>
        wallet.address.toLowerCase() === active.address.toLowerCase()
          || (active.name && wallet.name === active.name)
          ? {
              ...wallet,
              balance: active.balance,
              ...(active.wrappedBalance !== undefined ? { wrappedBalance: active.wrappedBalance } : {})
            }
          : wallet
      )
    } : next;
    const plan = snapshot.walletPlansByClient?.[target];
    const total = plan?.allocations.reduce((sum, allocation) => sum + allocation.weight, 0) ?? 0;
    setInventory(hydrated);
    setShares(Object.fromEntries((plan?.allocations ?? []).map((allocation) => [
      allocation.walletName,
      total > 0 ? Number(((allocation.weight / total) * 100).toFixed(2)) : 0
    ])));
    setAutomationByWallet(Object.fromEntries((plan?.allocations ?? []).map((allocation) => [
      allocation.walletName,
      allocation.automation ?? defaultPositionAutomation()
    ])));
    setSelectedGroupId(plan?.groupId && next.groups.some((group) => group.id === plan.groupId)
      ? plan.groupId
      : "");
    setRandomize((plan?.randomizationBps ?? 0) > 0);
    setVariation((plan?.randomizationBps ?? 1_000) / 100);
    setAutoRebalance(plan?.autoRebalance === true);
    setLookupSelection((next.lookupTables ?? []).filter((table) => table.selected).map((table) => table.address));
    hydratedPlanClient.current = target;
    setError("");
    setBusy("");
  };

  useEffect(() => {
    setInventory(undefined);
    setActiveWalletName("");
    setRenamingGroupId("");
    setPlanSyncing(false);
    if (clientId) void load(clientId);
  }, [clientId]);

  const selectedNames = Object.keys(shares);
  const splitTotal = Object.values(shares).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const setSelected = (names: string[], groupId = "") => {
    const even = names.length ? Number((100 / names.length).toFixed(2)) : 0;
    setShares(Object.fromEntries(names.map((name) => [name, even])));
    setSelectedGroupId(groupId);
  };

  useEffect(() => {
    if (!clientId || !inventory || hydratedPlanClient.current !== clientId) return;
    const allocations = Object.entries(shares).map(([walletName, weight]) => ({
      walletName,
      weight,
      automation: automationByWallet[walletName] ?? defaultPositionAutomation()
    }));
    if (allocations.some((allocation) => !Number.isFinite(allocation.weight) || allocation.weight <= 0)) {
      setError("Every selected wallet needs a buy percentage greater than zero");
      return;
    }
    const revision = ++planRevision.current;
    const timer = window.setTimeout(async () => {
      setPlanSyncing(true);
      const plan: WalletExecutionPlan = {
        allocations,
        ...(selectedGroupId ? { groupId: selectedGroupId } : {}),
        ...(randomize ? { randomizationBps: Math.round(Math.min(50, Math.max(0, variation)) * 100) } : {}),
        ...(autoRebalance ? { autoRebalance: true } : {})
      };
      try {
        const response = await request({ type: "sharp:update-wallet-plan", clientId, plan });
        if (revision !== planRevision.current) return;
        if (response.ok && response.snapshot) {
          onSnapshot(response.snapshot);
          setError("");
        } else {
          setError(response.ok ? "Sharp did not save the wallet selection" : response.error);
        }
      } catch (caught) {
        if (revision === planRevision.current) {
          setError(caught instanceof Error ? caught.message : "Sharp did not save the wallet selection");
        }
      } finally {
        if (revision === planRevision.current) setPlanSyncing(false);
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [clientId, inventory, shares, automationByWallet, selectedGroupId, randomize, variation, autoRebalance]);

  if (!clients.length) {
    return <div className="notice">Connect a live Sharp trading client to manage trade wallets.</div>;
  }

  return (
    <section className="stack walletManager">
      {!inventory ? <div className="notice">{busy ? "Loading wallets from Sharp…" : "Wallets are not loaded"}</div> : (() => {
        const balanceReady = inventory.wallets.some((wallet) => wallet.balance !== undefined);
        const selectedWallets = inventory.wallets.filter((wallet) => Object.hasOwn(shares, wallet.name));
        const balanceSource = selectedWallets.length ? selectedWallets : inventory.wallets;
        const combinedBalance = balanceSource.reduce((sum, wallet) => sum + (wallet.balance ?? 0), 0);
        const multi = selectedNames.length > 0;
        const splitBalanced = Math.abs(splitTotal - 100) < 0.5;
        return <>
        <div className="walletSummary">
          <div><strong>{inventory.wallets.length}</strong><span>Wallets</span></div>
          <div><strong>{selectedNames.length || 1}</strong><span>{multi ? "Selected" : "Active only"}</span></div>
          <div><strong>{balanceReady
            ? `${combinedBalance.toFixed(3)} ${inventory.nativeSymbol ?? ""}`
            : "-"}</strong><span>{multi ? "Selected bal." : "Balance"}</span></div>
        </div>
        <div className="popupWalletList">
          <div className="walletListBar">
            <span className="walletListTitle">Trade wallets<i>{selectedNames.length}</i></span>
            <div className="walletListTools">
              <button type="button" className={multi ? "" : "active"} onClick={() => setSelected([])}>Active</button>
              <button type="button" className={selectedNames.length === inventory.wallets.length ? "active" : ""} onClick={() => setSelected(inventory.wallets.map((wallet) => wallet.name))}>All</button>
              <button type="button" className="walletRefresh" aria-label="Refresh wallets" title="Refresh from Sharp" onClick={() => void load()} disabled={Boolean(busy)}>↻</button>
            </div>
          </div>
          <div className="popupWalletHead"><span>Wallet</span><span>Balance</span><span>Split</span></div>
          {inventory.wallets.map((wallet) => {
            const selected = Object.hasOwn(shares, wallet.name);
            const isActive = !multi && wallet.name === activeWalletName;
            const automation = automationByWallet[wallet.name] ?? defaultPositionAutomation();
            const automationOptions = inventory.chain === "solana"
              ? ([
                  ["creatorSell", "Dev"],
                  ["migrationSell", "Migration"],
                  ["walletTradeSell", "Wallet"]
                ] as const)
              : ([
                  ["migrationSell", "Migration"],
                  ["walletTradeSell", "Wallet"]
                ] as const);
            const enabledCount = automationOptions.filter(([key]) => automation[key]).length;
            const updateAutomation = (key: keyof PositionAutomationPolicy, enabled: boolean) => {
              setAutomationByWallet((current) => ({
                ...current,
                [wallet.name]: { ...(current[wallet.name] ?? defaultPositionAutomation()), [key]: enabled }
              }));
            };
            return <div className={`popupWalletItem${selected ? " selected" : ""}`} key={wallet.name}>
            <label className={`popupWalletRow${selected ? " selected" : ""}${isActive ? " active" : ""}`}>
              <input type="checkbox" checked={selected} onChange={(event) => {
                const names = event.target.checked
                  ? [...selectedNames, wallet.name]
                  : selectedNames.filter((name) => name !== wallet.name);
                setSelected(names);
              }} />
              <span className="popupWalletIdentity">
                {renamingWallet === wallet.name ? (
                  <span className="popupWalletRename">
                    <input autoFocus value={renameWalletDraft} maxLength={48}
                      onClick={(event) => event.preventDefault()}
                      onChange={(event) => setRenameWalletDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") { event.preventDefault(); void renameWallet(wallet.name); }
                        if (event.key === "Escape") setRenamingWallet("");
                      }} />
                    <button type="button" className="popupWalletRenameConfirm" title="Save name" disabled={Boolean(busy)}
                      onClick={(event) => { event.preventDefault(); void renameWallet(wallet.name); }}>Save</button>
                    <button type="button" className="popupWalletRenameCancel" title="Cancel"
                      onClick={(event) => { event.preventDefault(); setRenamingWallet(""); }}>Cancel</button>
                  </span>
                ) : (
                  <strong>
                    {wallet.name}{isActive && <i className="activeTag">Active</i>}
                    <button type="button" className="popupWalletRenameStart" title="Rename wallet"
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); setRenamingWallet(wallet.name); setRenameWalletDraft(wallet.name); }} aria-label="Rename wallet">
                      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                    </button>
                    <button type="button" className={`popupWalletAutomationButton${expandedAutomationWallet === wallet.name ? " active" : ""}`} title="Per-wallet automatic sells"
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); setExpandedAutomationWallet((current) => current === wallet.name ? "" : wallet.name); }} aria-label={`Configure automatic sells for ${wallet.name}`}>
                      Auto <i>{enabledCount}</i>
                    </button>
                  </strong>
                )}
                <button type="button" className={`popupWalletAddress${copiedWallet === wallet.name ? " copied" : ""}`} title="Copy wallet address" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void copyAddress(wallet.name, wallet.address); }}>
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  <span>{copiedWallet === wallet.name ? "Copied" : `${wallet.address.slice(0, 7)}…${wallet.address.slice(-6)}`}</span>
                </button>
              </span>
              <span className="popupWalletBalance">
                <span>{wallet.balance === undefined ? "-" : `${wallet.balance.toFixed(3)} ${inventory.nativeSymbol ?? ""}`}</span>
                {wallet.wrappedBalance !== undefined && wallet.wrappedBalance > 0 && <small>{wallet.wrappedBalance.toFixed(3)} WSOL</small>}
              </span>
              <span className="popupWalletShare"><input type="number" min="0.01" step="0.01" disabled={!selected} value={shares[wallet.name] ?? 100} onChange={(event) => {
                setSelectedGroupId("");
                setShares((current) => ({ ...current, [wallet.name]: Number(event.target.value) }));
              }} /><i>%</i></span>
            </label>
            {expandedAutomationWallet === wallet.name && <div className="popupWalletAutomation">
              <span>Automatic sells</span>
              {automationOptions.map(([key, label]) => <label className={automation[key] ? "active" : ""} key={key}>
                <input type="checkbox" checked={automation[key]} onChange={(event) => updateAutomation(key, event.target.checked)} />
                <span>{label}</span>
              </label>)}
            </div>}
            </div>;
          })}
          {multi && <div className={`walletSplitFooter${splitBalanced ? " ok" : " warn"}`}>
            <span>Combined buy split</span>
            <strong>{Number.isInteger(splitTotal) ? splitTotal : splitTotal.toFixed(2)}%</strong>
          </div>}
        </div>
        <details className="walletFold">
          <summary><span className="walletFoldTitle">Buy allocation</span>{planSyncing && <i>Saving</i>}</summary>
          <div className="walletFoldBody buyAllocationBody">
            <label className="randomizeRow">
              <input type="checkbox" checked={autoRebalance} onChange={(event) => setAutoRebalance(event.target.checked)} />
              <span><strong>Auto rebalance buys</strong><small>Move unfunded shares to selected wallets with available balance</small></span>
            </label>
            <label className="randomizeRow">
              <input type="checkbox" checked={randomize} onChange={(event) => setRandomize(event.target.checked)} />
              <span><strong>Randomize buy split</strong><small>Vary each wallet, then rebalance to the exact preset total</small></span>
              <span className="variationInput"><input type="number" min="0" max="50" step="1" disabled={!randomize} value={variation} onChange={(event) => setVariation(Number(event.target.value))} /><i>%</i></span>
            </label>
          </div>
        </details>
        <details className="walletFold">
          <summary><span className="walletFoldTitle">Wallet groups</span><i>{inventory.groups.length}</i></summary>
          <div className="walletFoldBody">
            <p className="walletFoldNote">Save the checked wallets as a reusable multi-wallet selection.</p>
            {inventory.groups.length > 0 && <div className="walletGroupList">
              {inventory.groups.map((group) => {
                const renaming = renamingGroupId === group.id;
                const commitRename = async () => {
                  const name = renameDraft.trim();
                  if (!name || name === group.name) { setRenamingGroupId(""); return; }
                  if (inventory.groups.some((other) => other.id !== group.id && other.name.toLowerCase() === name.toLowerCase())) {
                    setError("A wallet group with this name already exists");
                    return;
                  }
                  if (await saveGroups(inventory.groups.map((other) => other.id === group.id ? { ...other, name } : other), "rename-group")) {
                    setRenamingGroupId("");
                  }
                };
                return <div className={`walletGroupItem${selectedGroupId === group.id ? " selected" : ""}`} key={group.id}>
                  {renaming ? (
                    <div className="walletGroupRename">
                      <input autoFocus value={renameDraft} maxLength={48} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => {
                        if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
                        if (event.key === "Escape") setRenamingGroupId("");
                      }} />
                      <button type="button" className="walletGroupConfirm" title="Save name" disabled={Boolean(busy)} onClick={() => void commitRename()}>Save</button>
                      <button type="button" className="walletGroupCancel" title="Cancel" onClick={() => setRenamingGroupId("")}>Cancel</button>
                    </div>
                  ) : <>
                    <button type="button" className="walletGroupSelect" onClick={() => setSelected(group.wallets, group.id)}>
                      <span><strong>{group.name}</strong><small>{group.wallets.join(" · ")}</small></span>
                      <i>{group.wallets.length}</i>
                    </button>
                    <button type="button" className="walletGroupAction" title="Save checked wallets to this group" disabled={!selectedNames.length || Boolean(busy)} onClick={async () => {
                      if (await saveGroups(inventory.groups.map((other) => other.id === group.id ? { ...other, wallets: selectedNames } : other), "update-group")) {
                        setSelectedGroupId(group.id);
                      }
                    }}>Update</button>
                    <button type="button" className="walletGroupAction" title="Rename group" onClick={() => { setRenamingGroupId(group.id); setRenameDraft(group.name); }}>Rename</button>
                    <button type="button" className="walletGroupAction walletGroupDelete" title="Delete group" disabled={Boolean(busy)} onClick={async () => {
                      if (await saveGroups(inventory.groups.filter((other) => other.id !== group.id), "delete-group") && selectedGroupId === group.id) {
                        setSelectedGroupId("");
                      }
                    }}>Delete</button>
                  </>}
                </div>;
              })}
            </div>}
            <div className="walletGroupCreate">
              <input value={newGroupName} maxLength={48} placeholder="New group name" onChange={(event) => setNewGroupName(event.target.value)} />
              <button type="button" disabled={!newGroupName.trim() || !selectedNames.length || Boolean(busy)} onClick={async () => {
                const name = newGroupName.trim();
                if (inventory.groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
                  setError("A wallet group with this name already exists");
                  return;
                }
                const group = { id: crypto.randomUUID(), name, wallets: selectedNames };
                if (await saveGroups([...inventory.groups, group], "create-group")) {
                  setNewGroupName("");
                  setSelected(group.wallets, group.id);
                }
              }}>{busy === "create-group" ? "Creating…" : "Create from selected"}</button>
            </div>
          </div>
        </details>
        <details className="walletFold">
          <summary><span className="walletFoldTitle">Add wallet</span></summary>
          <div className="walletFoldBody">
            <p className="walletFoldNote">Sharp generates and stores the key; the extension never sees it.</p>
            <div className="walletCreateInline">
              <input value={newWallet} placeholder="New wallet name" onChange={(event) => setNewWallet(event.target.value)} />
              <button type="button" disabled={!newWallet.trim() || Boolean(busy)} onClick={async () => {
                setBusy("create-wallet");
                const response = await request({ type: "sharp:create-managed-wallet", clientId, name: newWallet.trim() });
                if (response.ok && response.managedWallets) {
                  setNewWallet("");
                  await load();
                } else setError(response.ok ? "Sharp did not return the new wallet" : response.error);
                setBusy("");
              }}>{busy === "create-wallet" ? "Creating…" : "Create wallet"}</button>
            </div>
          </div>
        </details>
        {inventory.chain === "solana" && <details className="lookupManager">
          <summary><strong>Durable nonces</strong><span>{inventory.wallets.reduce((total, wallet) => total + (wallet.nonceAccounts?.length ?? 0), 0)} configured</span></summary>
          <div>
            <p>Nonce accounts are created and stored separately for each wallet. Sharp watches every configured account and refreshes its hash after it advances.</p>
            {inventory.wallets.map((wallet) => {
              const raw = nonceCounts[wallet.name] ?? "1";
              const amount = Math.min(Math.max(Math.trunc(Number(raw)) || 1, 1), 50);
              const setCount = (value: string) => setNonceCounts((current) => ({ ...current, [wallet.name]: value }));
              return <div className="nonceRow" key={`nonce-${wallet.address}`}>
              <span><strong>{wallet.name}</strong><small>{wallet.nonceAccounts?.length ?? 0} nonce account{(wallet.nonceAccounts?.length ?? 0) === 1 ? "" : "s"}</small></span>
              <div className="nonceStepper" role="group" aria-label={`How many nonces to create for ${wallet.name}`}>
                <button type="button" aria-label="Fewer nonces" disabled={Boolean(busy) || amount <= 1} onClick={() => setCount(String(Math.max(1, amount - 1)))}>−</button>
                <input type="number" min={1} max={50} inputMode="numeric" value={raw} aria-label="Amount to create" disabled={Boolean(busy)} onChange={(event) => setCount(event.target.value)} onBlur={() => setCount(String(amount))} />
                <button type="button" aria-label="More nonces" disabled={Boolean(busy) || amount >= 50} onClick={() => setCount(String(Math.min(50, amount + 1)))}>+</button>
              </div>
              <button type="button" className="nonceCreate" disabled={Boolean(busy)} onClick={async () => {
                setBusy(`create-nonce-${wallet.name}`);
                const response = await request({ type: "sharp:create-managed-wallet-nonce", clientId, walletName: wallet.name, count: amount });
                if (response.ok && response.managedWallets) setInventory(response.managedWallets);
                else setError(response.ok ? "Sharp did not return the new nonce account" : response.error);
                setBusy("");
              }}>{busy === `create-nonce-${wallet.name}` ? "Creating…" : `Create ${amount}`}</button>
            </div>;
            })}
          </div>
        </details>}
        {inventory.chain === "solana" && <details className="lookupManager">
          <summary><strong>Lookup tables</strong><span>{lookupSelection.length ? `${lookupSelection.length} active` : "Sharp default"}</span></summary>
          <div>
            <p>Selected tables rotate across compatible transactions. Create your own table using one managed wallet as its authority.</p>
            {(inventory.lookupTables ?? []).map((table) => <label className="lookupRow" key={table.address}>
              <input type="checkbox" checked={lookupSelection.includes(table.address)} onChange={(event) => setLookupSelection((current) => event.target.checked ? [...new Set([...current, table.address])] : current.filter((address) => address !== table.address))} />
              <span><strong>{table.address.slice(0, 8)}…{table.address.slice(-6)}</strong><small>Authority: {table.authorityWallet}</small></span>
            </label>)}
            <button className="secondary" type="button" disabled={Boolean(busy)} onClick={async () => {
              setBusy("save-lut");
              const response = await request({ type: "sharp:update-lookup-tables", clientId, selectedTables: lookupSelection });
              if (response.ok && response.managedWallets) setInventory(response.managedWallets);
              else setError(response.ok ? "Sharp did not save lookup tables" : response.error);
              setBusy("");
            }}>{busy === "save-lut" ? "Saving…" : "Save active tables"}</button>
            {inventory.wallets.map((wallet) => {
              const tableCount = (inventory.lookupTables ?? []).filter((table) => table.authorityWallet === wallet.name).length;
              return <div className="nonceRow" key={`lut-${wallet.name}`}>
              <span><strong>{wallet.name}</strong><small>{tableCount} lookup table{tableCount === 1 ? "" : "s"}</small></span>
              <div className="nonceStepper" role="group" aria-label={`Lookup tables to create for ${wallet.name}`}>
                <button type="button" aria-label="Fewer" disabled>−</button>
                <input type="number" min={1} max={1} value="1" readOnly aria-label="Amount to create" tabIndex={-1} />
                <button type="button" aria-label="More" disabled title="Create one lookup table at a time">+</button>
              </div>
              <button type="button" className="nonceCreate" disabled={Boolean(busy)} onClick={async () => {
                setBusy(`create-lut-${wallet.name}`);
                const response = await request({ type: "sharp:create-lookup-table", clientId, authorityWallet: wallet.name });
                if (response.ok && response.managedWallets) {
                  setInventory(response.managedWallets);
                  setLookupSelection((response.managedWallets.lookupTables ?? []).filter((table) => table.selected).map((table) => table.address));
                } else setError(response.ok ? "Sharp did not return the lookup table" : response.error);
                setBusy("");
              }}>{busy === `create-lut-${wallet.name}` ? "Creating…" : "Create 1"}</button>
            </div>;
            })}
          </div>
        </details>}
        <p className="hint">Every preset buy is the combined total across the selected wallets or group; sell % applies to each wallet's position. Private keys stay inside Sharp.</p>
        </>;
      })()}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

function TaskCreator({
  clientId,
  availableMarkets,
  presetBuyAmount,
  onCreated,
  onError
}: {
  clientId: string;
  availableMarkets: string[];
  presetBuyAmount?: number | undefined;
  onCreated: (tasks: SnipeTaskSummary[]) => void;
  onError: (error: string) => void;
}) {
  const [draft, setDraft] = useState<PopupTaskDraft>(newPopupTaskDraft);
  const [submitting, setSubmitting] = useState(false);
  const set = <K extends keyof PopupTaskDraft>(key: K, value: PopupTaskDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const numberOption = (
    value: string,
    label: string,
    limits: { min?: number; max?: number } = {}
  ) => {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    if (
      !Number.isFinite(parsed)
      || (limits.min !== undefined && parsed < limits.min)
      || (limits.max !== undefined && parsed > limits.max)
    ) throw new Error(`${label} is outside its allowed range.`);
    return parsed;
  };
  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
    inputMode: "text" | "decimal" = "text"
  ) => <label className="taskField"><span>{label}</span><input
    value={value}
    placeholder={placeholder}
    inputMode={inputMode}
    onChange={(event) => onChange(event.target.value)}
  /></label>;
  const toggleSender = (sender: SolanaSender) => set("senders", draft.senders.includes(sender)
    ? draft.senders.filter((item) => item !== sender)
    : [...draft.senders, sender]);
  const submit = async () => {
    try {
      const target = draft.target.trim();
      if (!target) throw new Error(draft.taskType === "dev"
        ? "Enter at least one creator wallet."
        : draft.taskType === "ticker" ? "Enter a ticker." : "Enter the known token mint.");
      const amount = numberOption(draft.amount, "Buy amount", { min: Number.MIN_VALUE });
      const priorityFee = numberOption(draft.priorityFee, "Priority fee", { min: 0 });
      const tip = numberOption(draft.tip, "Tip", { min: 0 });
      const slippage = numberOption(draft.slippage, "Slippage", { min: 0, max: 100 });
      const minimumQuoteLiquidity = numberOption(draft.minimumQuoteLiquidity, "Minimum liquidity", { min: 0 });
      const minimumCreationQuoteLiquidity = numberOption(draft.minimumCreationQuoteLiquidity, "Creation liquidity", { min: 0 });
      const maximumLaunchFeePercent = numberOption(draft.maximumLaunchFeePercent, "Launch fee", { min: 0, max: 100 });
      const maximumPriceImpactPercent = numberOption(draft.maximumPriceImpactPercent, "Price impact", { min: 0, max: 100 });
      const maxMatches = numberOption(draft.maxMatches, "Maximum matches", { min: 1 });
      const startDelaySeconds = numberOption(draft.startDelaySeconds, "Start delay", { min: 0 });
      const transactionsPerSecond = numberOption(draft.transactionsPerSecond, "TPS", { min: Number.MIN_VALUE });
      const stopAfterSeconds = numberOption(draft.stopAfterSeconds, "Duration", { min: 1 });
      const maxTotalFeesSol = numberOption(draft.maxTotalFeesSol, "Maximum fees", { min: 0 });
      const stopAfterPoolOpenSeconds = numberOption(draft.stopAfterPoolOpenSeconds, "Pool-open delay", { min: 0 });
      const transferPercentage = numberOption(draft.transferPercentage, "Transfer percentage", { min: Number.MIN_VALUE, max: 100 });
      if (draft.transferEnabled && !draft.transferWallet.trim()) {
        throw new Error("Enter the post-buy transfer destination wallet.");
      }
      const senderOverrides = Object.fromEntries(Object.entries(draft.senderOverrides).flatMap(([sender, values]) => {
        const senderPriorityFee = numberOption(values?.priorityFee ?? "", `${sender} priority fee`, { min: 0 });
        const senderTip = numberOption(values?.tip ?? "", `${sender} tip`, { min: 0 });
        return senderPriorityFee === undefined && senderTip === undefined ? [] : [[sender, {
          ...(senderPriorityFee === undefined ? {} : { priorityFee: senderPriorityFee }),
          ...(senderTip === undefined ? {} : { tip: senderTip })
        }]];
      })) as NonNullable<AutomationTaskOptions["senderOverrides"]>;
      const options: AutomationTaskOptions = {
        useExtensionDefaults: draft.inheritExecution,
        ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
        ...(draft.taskType === "dev" && draft.ticker.trim() ? { ticker: draft.ticker.trim() } : {}),
        matchTokenName: draft.matchTokenName,
        markets: draft.markets,
        ...(minimumQuoteLiquidity === undefined ? {} : { minimumQuoteLiquidity }),
        ...(minimumCreationQuoteLiquidity === undefined ? {} : { minimumCreationQuoteLiquidity }),
        ...(maximumLaunchFeePercent === undefined ? {} : { maximumLaunchFeePercent }),
        ...(maximumPriceImpactPercent === undefined ? {} : { maximumPriceImpactPercent }),
        allowToken2022TransferHook: draft.allowToken2022TransferHook,
        allowOneSidedDammV2: draft.allowOneSidedDammV2,
        skipPresetFilters: draft.skipPresetFilters,
        cashbackFilter: draft.cashbackFilter,
        mayhemFilter: draft.mayhemFilter,
        ...(priorityFee === undefined ? {} : { priorityFee }),
        ...(tip === undefined ? {} : { tip }),
        ...(slippage === undefined ? {} : { slippage }),
        ...(!draft.inheritExecution ? { senders: draft.senders, senderOverrides } : {}),
        oneShot: draft.oneShot,
        ...(maxMatches === undefined ? {} : { maxMatches }),
        ...(draft.taskType === "mint" ? {
          spamEnabled: draft.spamEnabled,
          ...(startDelaySeconds === undefined ? {} : { startDelaySeconds }),
          ...(transactionsPerSecond === undefined ? {} : { transactionsPerSecond }),
          ...(stopAfterSeconds === undefined ? {} : { stopAfterSeconds }),
          ...(maxTotalFeesSol === undefined ? {} : { maxTotalFeesSol }),
          stopOnPoolOpen: draft.stopOnPoolOpen,
          ...(stopAfterPoolOpenSeconds === undefined ? {} : { stopAfterPoolOpenSeconds }),
          ...(draft.transferEnabled && transferPercentage !== undefined ? {
            transfer: {
              destinationWallet: draft.transferWallet.trim(),
              percentage: transferPercentage
            }
          } : {})
        } : {})
      };
      setSubmitting(true);
      const response = await request({
        type: "sharp:create-task",
        clientId,
        taskType: draft.taskType,
        target,
        ...(amount === undefined ? {} : { amount }),
        match: draft.match,
        lifecycle: draft.lifecycle,
        options,
        arm: draft.arm
      });
      if (!response.ok) throw new Error(response.error);
      onCreated(response.tasks ?? []);
      onError("");
      setDraft(newPopupTaskDraft());
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to create task");
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="taskCreate fullTaskCreate">
    <div className="taskType three">
      {(["dev", "ticker", "mint"] as const).map((taskType) => <button
        type="button"
        key={taskType}
        className={draft.taskType === taskType ? "active" : ""}
        onClick={() => setDraft((current) => ({
          ...current,
          taskType,
          target: "",
          oneShot: taskType === "mint",
          maxMatches: taskType === "mint" ? "1" : "100"
        }))}
      >{taskType === "dev" ? "Developer" : taskType === "ticker" ? "Ticker" : "Mint spam"}</button>)}
    </div>
    <div className="taskGrid">
      {field("Label", draft.label, (value) => set("label", value), "Optional task label")}
      {field(
        draft.taskType === "dev" ? "Creator wallet" : draft.taskType === "ticker" ? "Ticker" : "Known mint",
        draft.target,
        (value) => set("target", value),
        draft.taskType === "dev" ? "Solana creator" : draft.taskType === "ticker" ? "e.g. SHARP" : "Token mint"
      )}
      {draft.taskType === "dev" && field("Ticker filter", draft.ticker, (value) => set("ticker", value), "Optional")}
      {draft.taskType !== "mint" && <label className="taskField"><span>Buy lifecycle</span><select value={draft.lifecycle} onChange={(event) => set("lifecycle", event.target.value as AutomationLifecycle)}>
        <option value="both">Creation + migration</option><option value="creation">Creation only</option><option value="migration">Migration only</option>
      </select></label>}
      {draft.taskType !== "mint" && <label className="taskField"><span>Target matching</span><select value={draft.match} onChange={(event) => set("match", event.target.value as "exact" | "contains")}>
        <option value="exact">Exact</option><option value="contains">Contains</option>
      </select></label>}
      {field("Buy amount (SOL)", draft.amount, (value) => set("amount", value), presetBuyAmount != null ? `Preset: ${presetBuyAmount} SOL` : "Uses active preset", "decimal")}
    </div>

    <details className="taskSection" open>
      <summary>Filters and markets</summary><div className="taskSectionBody">
        {availableMarkets.length > 0 && <div><span className="taskSectionLabel">Markets · none means preset/all</span><div className="taskChips">{availableMarkets.map((market) => <button
          type="button" key={market} className={draft.markets.includes(market) ? "active" : ""}
          onClick={() => set("markets", draft.markets.includes(market) ? draft.markets.filter((item) => item !== market) : [...draft.markets, market])}
        >{marketLabel(market)}</button>)}</div></div>}
        <div className="taskGrid two">
          {field("Min liquidity", draft.minimumQuoteLiquidity, (value) => set("minimumQuoteLiquidity", value), "No minimum", "decimal")}
          {field("Min creation liquidity", draft.minimumCreationQuoteLiquidity, (value) => set("minimumCreationQuoteLiquidity", value), "No minimum", "decimal")}
          {field("Max launch fee %", draft.maximumLaunchFeePercent, (value) => set("maximumLaunchFeePercent", value), "No maximum", "decimal")}
          {field("Max price impact %", draft.maximumPriceImpactPercent, (value) => set("maximumPriceImpactPercent", value), "No maximum", "decimal")}
        </div>
        <div className="taskGrid two">
          <label className="taskField"><span>Cashback tokens</span><select value={draft.cashbackFilter} onChange={(event) => set("cashbackFilter", event.target.value as TaskFeatureFilter)}><option value="allow">Allow</option><option value="exclude">Exclude</option><option value="only">Only</option></select></label>
          <label className="taskField"><span>Mayhem tokens</span><select value={draft.mayhemFilter} onChange={(event) => set("mayhemFilter", event.target.value as TaskFeatureFilter)}><option value="allow">Allow</option><option value="exclude">Exclude</option><option value="only">Only</option></select></label>
        </div>
        <label className="taskCheck"><input type="checkbox" checked={draft.skipPresetFilters} onChange={(event) => set("skipPresetFilters", event.target.checked)} /><span><strong>Skip preset filters</strong><small>Use only the task filters above</small></span></label>
        <label className="taskCheck"><input type="checkbox" checked={draft.allowOneSidedDammV2} onChange={(event) => set("allowOneSidedDammV2", event.target.checked)} /><span>Allow one-sided DAMM v2 pools</span></label>
        {draft.taskType === "ticker" && <label className="taskCheck"><input type="checkbox" checked={draft.matchTokenName} onChange={(event) => set("matchTokenName", event.target.checked)} /><span>Also match token name</span></label>}
      </div>
    </details>

    <details className="taskSection" open>
      <summary>Execution and senders</summary><div className="taskSectionBody">
        <label className="taskCheck"><input type="checkbox" checked={draft.inheritExecution} onChange={(event) => set("inheritExecution", event.target.checked)} /><span><strong>Inherit extension/preset execution</strong><small>Turn off to choose senders for this task</small></span></label>
        <div className="taskGrid two">
          {field("Priority fee (SOL)", draft.priorityFee, (value) => set("priorityFee", value), "Preset", "decimal")}
          {field("Relay tip (SOL)", draft.tip, (value) => set("tip", value), "Preset", "decimal")}
          {field("Slippage %", draft.slippage, (value) => set("slippage", value), "Preset", "decimal")}
        </div>
        {!draft.inheritExecution && <><div className="taskChips senderTaskChips">{solanaSenders.map((sender) => <button type="button" key={sender} className={draft.senders.includes(sender) ? "active" : ""} onClick={() => toggleSender(sender)}>{senderLabels[sender]}</button>)}</div>
          {draft.senders.map((sender) => <div className="senderOverride" key={sender}><strong>{senderLabels[sender]}</strong>
            {field("Priority", draft.senderOverrides[sender]?.priorityFee ?? "", (value) => set("senderOverrides", { ...draft.senderOverrides, [sender]: { priorityFee: value, tip: draft.senderOverrides[sender]?.tip ?? "" } }), "Global", "decimal")}
            {sender !== "rpc" && field("Tip", draft.senderOverrides[sender]?.tip ?? "", (value) => set("senderOverrides", { ...draft.senderOverrides, [sender]: { priorityFee: draft.senderOverrides[sender]?.priorityFee ?? "", tip: value } }), "Global", "decimal")}
          </div>)}</>}
      </div>
    </details>

    {draft.taskType === "mint" && <details className="taskSection" open><summary>Mint spam policy</summary><div className="taskSectionBody">
      <label className="taskCheck"><input type="checkbox" checked={draft.spamEnabled} onChange={(event) => set("spamEnabled", event.target.checked)} /><span><strong>Enable transaction spam</strong><small>Otherwise this is a one-shot known-mint task</small></span></label>
      {draft.spamEnabled && <><div className="taskGrid two">
        {field("Start delay (sec)", draft.startDelaySeconds, (value) => set("startDelaySeconds", value), "0", "decimal")}
        {field("Transactions/sec", draft.transactionsPerSecond, (value) => set("transactionsPerSecond", value), "10", "decimal")}
        {field("Run for (sec)", draft.stopAfterSeconds, (value) => set("stopAfterSeconds", value), "20", "decimal")}
        {field("Max fees (SOL)", draft.maxTotalFeesSol, (value) => set("maxTotalFeesSol", value), "0.05", "decimal")}
      </div>
      <label className="taskCheck"><input type="checkbox" checked={draft.stopOnPoolOpen} onChange={(event) => set("stopOnPoolOpen", event.target.checked)} /><span>Stop when the pool opens</span></label>
      {draft.stopOnPoolOpen && field("Continue after open (sec)", draft.stopAfterPoolOpenSeconds, (value) => set("stopAfterPoolOpenSeconds", value), "0", "decimal")}
      <label className="taskCheck"><input type="checkbox" checked={draft.transferEnabled} onChange={(event) => set("transferEnabled", event.target.checked)} /><span>Transfer tokens after buy</span></label>
      {draft.transferEnabled && <div className="taskGrid two">{field("Destination", draft.transferWallet, (value) => set("transferWallet", value), "Solana wallet")}{field("Transfer %", draft.transferPercentage, (value) => set("transferPercentage", value), "100", "decimal")}</div>}</>}
    </div></details>}

    <details className="taskSection"><summary>Completion</summary><div className="taskSectionBody">
      <label className="taskCheck"><input type="checkbox" checked={draft.oneShot} onChange={(event) => set("oneShot", event.target.checked)} /><span>Stop after the first successful match</span></label>
      {!draft.oneShot && field("Maximum matches", draft.maxMatches, (value) => set("maxMatches", value), "100", "decimal")}
    </div></details>
    <label className="taskCheck taskArm"><input type="checkbox" checked={draft.arm} onChange={(event) => set("arm", event.target.checked)} /><span><strong>Start immediately</strong><small>Unchecked saves the task as a draft</small></span></label>
    <button className="primary" type="button" disabled={submitting || !clientId || !draft.target.trim()} onClick={submit}>{submitting ? "Saving task…" : draft.arm ? "Create and start task" : "Save task draft"}</button>
  </div>;
}

function CustomTradeLauncher({
  value,
  onChange,
  onError
}: {
  value: CustomTradeLauncherState;
  onChange: (value: CustomTradeLauncherState) => void;
  onError: (error: string) => void;
}) {
  const [drafts, setDrafts] = useState(() => Object.fromEntries(value.chains.map((item) => [item.chain, {
    presetId: item.runtime?.preset_id || item.presets[0]?.id || "",
    wallet: item.runtime?.wallet || item.wallets[0] || "",
    paperTrade: item.runtime?.paper_trade ?? false
  }])) as Record<SharpChain, { presetId: string; wallet: string; paperTrade: boolean }>);
  const [selectedChains, setSelectedChains] = useState<SharpChain[]>([]);
  const [busyChain, setBusyChain] = useState<SharpChain | "">("");
  const updateDraft = (chain: SharpChain, patch: Partial<(typeof drafts)[SharpChain]>) =>
    setDrafts((current) => ({ ...current, [chain]: { ...current[chain], ...patch } }));
  const runtimeIsRunning = (item: CustomTradeLauncherState["chains"][number]) =>
    Boolean(item.runtime && ["starting", "running", "degraded"].includes(item.runtime.state));
  const availableChains = value.chains.filter((item) => !runtimeIsRunning(item));
  const startableChains = availableChains.filter((item) => item.presets.length > 0 && item.wallets.length > 0);
  const selectedStartableChains = startableChains.filter((item) => selectedChains.includes(item.chain));

  const startSelected = async () => {
    const started: SharpChain[] = [];
    onError("");
    for (const item of selectedStartableChains) {
      const draft = drafts[item.chain];
      setBusyChain(item.chain);
      const response = await request({
        type: "sharp:start-custom-trade-runtime",
        controllerId: value.controllerId,
        chain: item.chain,
        presetId: draft.presetId,
        wallet: draft.wallet,
        paperTrade: draft.paperTrade
      });
      if (!response.ok || !response.customTradeLauncher) {
        onError(response.ok ? `Sharp did not return the ${chainLabels[item.chain]} runtime state` : response.error);
        break;
      }
      started.push(item.chain);
      onChange(response.customTradeLauncher);
    }
    setSelectedChains((current) => current.filter((chain) => !started.includes(chain)));
    setBusyChain("");
  };

  return <div className="customTradeLauncher">
    {availableChains.map((item) => {
      const draft = drafts[item.chain];
      const running = item.runtime && ["starting", "running", "degraded"].includes(item.runtime.state);
      const configurable = item.presets.length > 0 && item.wallets.length > 0;
      return <article className="customTradeChain" key={item.chain}>
        <div className="customTradeChainHead"><div className="customTradeChainTitle">
          {!running && configurable && <input type="checkbox" aria-label={`Select ${chainLabels[item.chain]}`} checked={selectedChains.includes(item.chain)} disabled={Boolean(busyChain)} onChange={(event) => setSelectedChains((current) => event.target.checked ? [...new Set([...current, item.chain])] : current.filter((chain) => chain !== item.chain))} />}
          <div><strong>{chainLabels[item.chain]}</strong><span>{running ? item.runtime!.state : selectedChains.includes(item.chain) ? "selected" : "stopped"}</span></div>
        </div>{running
          ? <span className="runtimeActive">{item.runtime!.paper_trade ? "PAPER" : "LIVE"}</span>
          : !configurable
            ? <button type="button" className="webUiConfigure" onClick={openSharpWebUi}>Configure in WebUI</button>
            : busyChain === item.chain
              ? <span className="runtimeStarting">Starting…</span>
              : <label className="customTradePaperCompact"><input type="checkbox" checked={draft.paperTrade} onChange={(event) => updateDraft(item.chain, { paperTrade: event.target.checked })} /><span>Paper trading</span></label>}
        </div>
        {!running && configurable && <div className="customTradeConfig">
          <label><span>Preset</span><select value={draft.presetId} onChange={(event) => updateDraft(item.chain, { presetId: event.target.value })}>{item.presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select></label>
          <label><span>Wallet</span><select value={draft.wallet} onChange={(event) => updateDraft(item.chain, { wallet: event.target.value })}>{item.wallets.map((wallet) => <option value={wallet} key={wallet}>{wallet}</option>)}</select></label>
        </div>}
        {!running && !configurable && <p>{item.presets.length === 0 ? "No Custom Trade preset. " : ""}{item.wallets.length === 0 ? "No configured wallet." : ""}</p>}
        {item.runtime?.error && <p className="runtimeError">{item.runtime.error}</p>}
      </article>;
    })}
    {startableChains.length > 0 && <button type="button" className="primary customTradeStartSelected" disabled={Boolean(busyChain) || selectedStartableChains.length === 0} onClick={startSelected}>
      {busyChain ? `Starting ${chainLabels[busyChain]}…` : `Start ${selectedStartableChains.length} selected chain${selectedStartableChains.length === 1 ? "" : "s"}`}
    </button>}
  </div>;
}

export function App() {
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot>();
  const [tab, setTab] = useState<"overview" | "wallets" | "tasks" | "sites" | "settings">("overview");
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<SnipeTaskSummary[]>([]);
  const [walletClient, setWalletClient] = useState("");
  const [taskClient, setTaskClient] = useState("");
  const [taskError, setTaskError] = useState("");
  const [taskPresetBuyAmount, setTaskPresetBuyAmount] = useState<number>();
  const [customTradeLauncher, setCustomTradeLauncher] = useState<CustomTradeLauncherState>();
  const [customTradeLoading, setCustomTradeLoading] = useState(false);
  const [customTradeError, setCustomTradeError] = useState("");
  const [creatorSell, setCreatorSell] = useState<CreatorSellSettings>();
  const [migrationSell, setMigrationSell] = useState<MigrationSellSettings>();
  const [executionChain, setExecutionChain] = useState<SharpChain>("solana");
  const [executionClientId, setExecutionClientId] = useState("");
  const [executionSelectionReady, setExecutionSelectionReady] = useState(false);
  const [executionPriorityFee, setExecutionPriorityFee] = useState<number>();
  const [remoteApiKey, setRemoteApiKey] = useState("");
  const [remoteDiscordUserId, setRemoteDiscordUserId] = useState("");
  const [remoteDomain, setRemoteDomain] = useState("");
  const [remoteConnections, setRemoteConnections] = useState<RemoteConnectionDraft[]>([]);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState("");
  const [remoteError, setRemoteError] = useState("");
  const executionClients = snapshot?.clients.filter((candidate) =>
    candidate.connected
    && candidate.authenticated
    && candidate.capabilities
    && candidate.capabilities.module !== "unknown"
  ) ?? [];
  const executionClientsKey = executionClients.map((client) => client.endpointId).join(":");
  const executionClient = executionClients.find((client) => client.endpointId === executionClientId);

  const load = async () => {
    const response = await request({ type: "sharp:get-state" });
    if (response.ok) setSnapshot(response.snapshot);
  };

  useEffect(() => {
    if (tab !== "settings") return;
    if (executionSelectionReady) {
      if (executionClientId && !executionClient) setExecutionClientId("");
      return;
    }
    const preferred = snapshot?.selectedClientIdsByChain[executionChain] ?? [];
    const nextClient = executionClients.find((client) => preferred.includes(client.endpointId))
      ?? executionClients.find((client) => client.capabilities?.chain === executionChain)
      ?? executionClients[0];
    setExecutionClientId(nextClient?.endpointId ?? "");
    if (nextClient?.capabilities?.chain) setExecutionChain(nextClient.capabilities.chain);
    setExecutionSelectionReady(true);
  }, [tab, executionChain, executionClientId, executionClientsKey, executionSelectionReady]);

  useEffect(() => {
    if (tab !== "settings" || !executionClient) {
      setCreatorSell(undefined);
      setMigrationSell(undefined);
      setExecutionPriorityFee(undefined);
      return;
    }
    let cancelled = false;
    setExecutionPriorityFee(undefined);
    Promise.all([
      executionChain === "solana"
        ? request({ type: "sharp:get-creator-sell", clientId: executionClient.endpointId })
        : Promise.resolve(undefined),
      request({ type: "sharp:get-migration-sell", clientId: executionClient.endpointId }),
      executionChain === "solana"
        ? Promise.resolve(undefined)
        : request({ type: "sharp:get-execution-fee-defaults", clientId: executionClient.endpointId })
    ])
      .then(([creatorResponse, migrationResponse, feeResponse]) => {
        if (cancelled) return;
        setCreatorSell(creatorResponse?.ok ? creatorResponse.creatorSell : undefined);
        setMigrationSell(migrationResponse.ok ? migrationResponse.migrationSell : undefined);
        setExecutionPriorityFee(feeResponse?.ok ? feeResponse.executionFeeDefaults?.priorityFeeGwei : undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, executionChain, executionClientId]);

  useEffect(() => {
    load();
    const listener = (message: { type?: string; snapshot?: ExtensionSnapshot }) => {
      if (message.type === "sharp:state-changed" && message.snapshot) setSnapshot(message.snapshot);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const connected = useMemo(
    () => snapshot?.clients.filter((client) =>
      client.connected
      && client.authenticated
      && client.capabilities
      && client.capabilities.module !== "unknown"
    ) ?? [],
    [snapshot]
  );
  const loadCustomTradeLauncher = async () => {
    setCustomTradeLoading(true);
    const response = await request({ type: "sharp:get-custom-trade-launcher" });
    if (response.ok && response.customTradeLauncher) {
      setCustomTradeLauncher(response.customTradeLauncher);
      setCustomTradeError("");
    } else {
      setCustomTradeLauncher(undefined);
      setCustomTradeError(response.ok ? "Sharp did not return its Custom Trade configuration" : response.error);
    }
    setCustomTradeLoading(false);
  };

  useEffect(() => {
    if (tab === "overview") void loadCustomTradeLauncher();
  }, [tab, connected.length]);
  const selectedTaskClient = executionClients.find((client) => client.endpointId === taskClient);
  const taskSupportsSnipes = selectedTaskClient?.capabilities?.features.snipe_tasks === true;

  useEffect(() => {
    if (tab !== "wallets") return;
    if (walletClient && executionClients.some((client) => client.endpointId === walletClient)) return;
    const preferred = executionClients.find((client) =>
      snapshot?.selectedClientIdsByChain[client.capabilities!.chain]?.includes(client.endpointId)
    );
    setWalletClient(preferred?.endpointId ?? executionClients[0]?.endpointId ?? "");
  }, [tab, walletClient, executionClientsKey]);

  useEffect(() => {
    if (tab !== "tasks" || selectedTaskClient) return;
    setTaskClient(executionClients[0]?.endpointId ?? "");
  }, [tab, taskClient, executionClientsKey]);

  const loadTasks = async (clientId = taskClient) => {
    if (!clientId) return;
    const response = await request({ type: "sharp:list-tasks", clientId });
    if (response.ok) {
      setTasks(response.tasks ?? []);
      setTaskError("");
    } else setTaskError(response.error);
  };

  useEffect(() => {
    if (tab !== "tasks") return;
    setTasks([]);
    setTaskError("");
    setTaskPresetBuyAmount(undefined);
    if (!selectedTaskClient) return;
    if (selectedTaskClient.capabilities?.features.snipe_tasks) {
      loadTasks();
      request({ type: "sharp:get-preset-execution", clientId: taskClient }).then((response) => {
        if (response.ok) setTaskPresetBuyAmount(response.presetExecution?.buyAmount);
      });
    }
  }, [tab, taskClient, executionClientsKey]);

  const patch = async (value: object) => {
    const response = await request({ type: "sharp:update-settings", patch: value });
    if (response.ok) setSnapshot(response.snapshot);
  };

  const discoverRemote = async () => {
    const apiKey = remoteApiKey.trim().toUpperCase();
    const discordUserId = remoteDiscordUserId.trim();
    const customDomain = remoteDomain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (!sharpApiKeyPattern.test(apiKey)) {
      setRemoteError("Enter an API key like SHARP-XXXXX-XXXXX-XXXXX-XXXXX.");
      return;
    }
    if (!/^\d{5,30}$/.test(discordUserId)) {
      setRemoteError("Enter the Discord user ID linked to this Sharp API key.");
      return;
    }
    if (customDomain && (customDomain.includes("/") || customDomain.includes(":"))) {
      setRemoteError("Enter only the custom hostname, without a scheme, port, or path.");
      return;
    }
    setRemoteBusy(true);
    setRemoteError("");
    setRemoteStatus("Finding your Sharp server…");
    setRemoteConnections([]);
    try {
      const ipResponse = await fetch("https://api.ipify.org?format=json", {
        cache: "no-store",
        credentials: "omit"
      });
      if (!ipResponse.ok) throw new Error("Could not determine this device's public IP");
      const ipPayload = await ipResponse.json() as { ip?: unknown };
      if (typeof ipPayload.ip !== "string" || !ipPayload.ip.trim()) {
        throw new Error("The public IP service returned an invalid response");
      }
      const clientIp = ipPayload.ip.trim();
      const serverResponse = await fetch("https://auth2.yvesdev.com/external/remoteServer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: clientIp,
          sharp_api_key: apiKey,
          discord_user_id: discordUserId
        })
      });
      const serverPayload = await serverResponse.json() as { remote_ip?: unknown; message?: unknown };
      if (!serverResponse.ok) {
        throw new Error(typeof serverPayload.message === "string"
          ? serverPayload.message
          : `Remote authorization failed (${serverResponse.status})`);
      }
      const discoveredHost = typeof serverPayload.remote_ip === "string"
        ? serverPayload.remote_ip.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "")
        : "";
      const host = customDomain || discoveredHost;
      if (!host) throw new Error("Sharp did not return a remote server address");
      if (host.includes("/") || (!host.startsWith("[") && host.split(":").length === 2)) {
        throw new Error("Sharp returned an invalid remote server address");
      }
      const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      const connections = Array.from({ length: 11 }, (_, index): RemoteConnectionDraft => ({
        id: `remote-client${index + 1}`,
        endpoint: `https://${hostname}:${8686 + index}`,
        remote: true,
        apiKey,
        discordUserId,
        clientIp
      }));
      for (const connection of connections) new URL(connection.endpoint);
      setRemoteApiKey(apiKey);
      setRemoteConnections(connections);
      setRemoteStatus(`Sharp server found at ${host}. Allow access to connect.`);
    } catch (error) {
      setRemoteStatus("");
      setRemoteError(error instanceof Error ? error.message : "Could not find the remote Sharp server");
    } finally {
      setRemoteBusy(false);
    }
  };

  const connectRemote = async () => {
    if (!remoteConnections.length) return;
    setRemoteBusy(true);
    setRemoteError("");
    try {
      const origins = [...new Set(remoteConnections.map((connection) => remotePermissionOrigin(connection.endpoint)))];
      const granted = await browser.permissions.request({ origins });
      if (!granted) throw new Error("Remote host access was not granted");
      const response = await request({ type: "sharp:connect-remote", connections: remoteConnections });
      if (!response.ok) throw new Error(response.error);
      if (response.snapshot) setSnapshot(response.snapshot);
      setRemoteConnections([]);
      setRemoteStatus("Remote clients saved. Connecting on ports 8686–8696…");
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : "Could not connect remote clients");
    } finally {
      setRemoteBusy(false);
    }
  };

  if (!snapshot) return <main className="shell loading">Connecting to Sharp…</main>;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brand">SHARP</div>
          <div className="subtitle">{connected.length} client{connected.length === 1 ? "" : "s"} online</div>
        </div>
        {(tab === "wallets" || tab === "tasks" || tab === "settings") && <select
          className="headerExecutionClient"
          aria-label={tab === "wallets" ? "Wallets client" : tab === "tasks" ? "Tasks client" : "Execution settings client"}
          value={tab === "wallets" ? walletClient : tab === "tasks" ? taskClient : executionClientId}
          disabled={!executionClients.length}
          onChange={(event) => {
            const clientId = event.target.value;
            if (tab === "wallets") {
              setWalletClient(clientId);
              return;
            }
            if (tab === "tasks") {
              setTaskClient(clientId);
              return;
            }
            setExecutionSelectionReady(true);
            setExecutionClientId(clientId);
            const chain = executionClients.find((client) => client.endpointId === clientId)?.capabilities?.chain;
            if (chain) setExecutionChain(chain);
          }}
        >
          <option value="">{executionClients.length ? "Select client" : "No connected client"}</option>
          {executionClients.map((client) => <option value={client.endpointId} key={client.endpointId}>
            {client.capabilities?.client_name || client.endpointId} · {client.capabilities?.module}
          </option>)}
        </select>}
        <label className="toggle">
          <input type="checkbox" checked={snapshot.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />
          <span>{snapshot.enabled ? "On" : "Off"}</span>
        </label>
      </header>

      {snapshot.pendingPairing && (
        <section className="pairing">
          <div>
            <strong>Pair remote Sharp clients?</strong>
            <span>{snapshot.pendingPairing.origin} · {snapshot.pendingPairing.connectionCount} client{snapshot.pendingPairing.connectionCount === 1 ? "" : "s"}</span>
            <code>{snapshot.pendingPairing.checksum}</code>
          </div>
          <div className="pairingActions">
            <button className="primary" onClick={async () => {
              const granted = await browser.permissions.request({ origins: snapshot.pendingPairing!.permissionOrigins });
              if (!granted) return;
              const response = await request({ type: "sharp:pairing-approve", requestId: snapshot.pendingPairing!.requestId });
              if (response.ok) setSnapshot(response.snapshot);
            }}>Approve</button>
            <button className="secondary" onClick={async () => {
              const response = await request({ type: "sharp:pairing-reject", requestId: snapshot.pendingPairing!.requestId });
              if (response.ok) setSnapshot(response.snapshot);
            }}>Reject</button>
          </div>
        </section>
      )}

      <nav className="tabs five" aria-label="Extension sections">
        {(["overview", "wallets", "tasks", "sites", "settings"] as const).map((value) => (
          <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>
            {value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <section className="stack">
          {customTradeLoading
            ? <div className="notice">Loading Custom Trade configuration…</div>
            : customTradeLauncher
              ? <CustomTradeLauncher
                  key={`${customTradeLauncher.controllerId}:${customTradeLauncher.chains.map((item) => `${item.chain}:${item.presets.map((preset) => preset.id).join(",")}:${item.wallets.join(",")}`).join("|")}`}
                  value={customTradeLauncher}
                  onChange={setCustomTradeLauncher}
                  onError={setCustomTradeError}
                />
              : !connected.length
                ? <div className="notice emptyLauncher"><span>Start the Sharp CLI on ports 8686-8696, or configure and pair it through the Sharp WebUI.</span><button type="button" className="secondary" onClick={openSharpWebUi}>Open Sharp WebUI</button></div>
                : null}
          {customTradeError && <div className="error">{customTradeError}</div>}
          {snapshot.clients.filter((client) =>
            client.connected
            && client.authenticated
            && client.capabilities
            && client.capabilities.module !== "unknown"
          ).map((client) => {
            const capability = client.capabilities;
            if (!capability) return null;
            const selected = snapshot.selectedClientIdsByChain[capability.chain]?.includes(client.endpointId) ?? false;
            return (
              <article className="client" key={client.endpointId}>
                <div className="clientHead">
                  <div>
                    <strong>{capability.client_name || client.endpointId}</strong>
                    <span>{chainLabels[capability.chain]} · {capability.module}</span>
                  </div>
                  <span className={capability.paper_trade ? "badge paper" : "badge real"}>
                    {capability.paper_trade ? "PAPER" : "REAL"}
                  </span>
                </div>
                <label className="selectRow">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(event) => {
                      const current = snapshot.selectedClientIdsByChain[capability.chain] ?? [];
                      const next = event.target.checked
                        ? [...new Set([...current, client.endpointId])]
                        : current.filter((id) => id !== client.endpointId);
                      patch({ selectedClientIdsByChain: { ...snapshot.selectedClientIdsByChain, [capability.chain]: next } });
                    }}
                  />
                  Use this client for {chainLabels[capability.chain]} controls
                </label>
              </article>
            );
          })}
          <button className="secondary" disabled={busy} onClick={async () => {
            setBusy(true);
            await request({ type: "sharp:refresh" });
            await load();
            await loadCustomTradeLauncher();
            setBusy(false);
          }}>{busy ? "Refreshing…" : "Refresh clients"}</button>
        </section>
      )}

      {tab === "wallets" && <MultiWalletManager snapshot={snapshot} onSnapshot={setSnapshot} clientId={walletClient} />}

      {tab === "tasks" && (
        <section className="stack">
          {!executionClients.length ? <div className="notice">Connect a Sharp client to manage its tasks.</div>
            : !taskSupportsSnipes ? <div className="notice">{selectedTaskClient?.capabilities?.client_name || "This client"} does not expose the Sharp sniper task module.</div>
            : <>
            <TaskCreator
              key={taskClient}
              clientId={taskClient}
              availableMarkets={selectedTaskClient?.capabilities?.markets ?? []}
              presetBuyAmount={taskPresetBuyAmount}
              onCreated={setTasks}
              onError={setTaskError}
            />
            {taskError && <div className="error">{taskError}</div>}
            {tasks.map((task) => (
              <article className="task" key={task.id}>
                <div><strong>{task.label}</strong><span>{task.task_type} · {snipeTaskStatusLabel(task.status)}</span></div>
                <div className="taskActions">
                  {task.status !== "armed" && <button onClick={async () => {
                    const response = await request({ type: "sharp:task-action", clientId: taskClient, action: "arm", taskId: task.id });
                    if (response.ok) setTasks(response.tasks ?? []); else setTaskError(response.error);
                  }}>Start</button>}
                  {task.status === "armed" && <button onClick={async () => {
                    const response = await request({ type: "sharp:task-action", clientId: taskClient, action: "pause", taskId: task.id });
                    if (response.ok) setTasks(response.tasks ?? []); else setTaskError(response.error);
                  }}>Stop</button>}
                  <button className="delete" onClick={async () => {
                    const response = await request({ type: "sharp:task-action", clientId: taskClient, action: "delete", taskId: task.id });
                    if (response.ok) setTasks(response.tasks ?? []); else setTaskError(response.error);
                  }}>Delete</button>
                </div>
              </article>
            ))}
          </>}
        </section>
      )}

      {tab === "sites" && (
        <section className="stack">
          {(Object.entries(siteLabels) as [SiteId, string][]).map(([site, label]) => (
            <label className="settingRow" key={site}>
              <span><strong>{label}</strong><small>{snapshot.compatibilityDisabledSites.includes(site) ? "Temporarily disabled by signed compatibility rules" : "Replace supported Buy/Sell controls"}</small></span>
              <input
                type="checkbox"
                checked={snapshot.siteEnabled[site]}
                disabled={snapshot.compatibilityDisabledSites.includes(site)}
                onChange={(event) => patch({ siteEnabled: { ...snapshot.siteEnabled, [site]: event.target.checked } })}
              />
            </label>
          ))}
          <p className="hint">Native controls are restored automatically whenever Sharp cannot identify the asset or find a compatible selected client.</p>
        </section>
      )}

      {tab === "settings" && (
        <section className="stack">
          <section className="field remoteConnect">
            <div className="fieldHead">
              <strong>Remote Sharp</strong>
              <small>Same connection flow as WebUI</small>
            </div>
            <label>
              <span>API key</span>
              <input
                type="password"
                autoComplete="off"
                placeholder="SHARP-XXXXX-XXXXX-XXXXX-XXXXX"
                value={remoteApiKey}
                onChange={(event) => {
                  setRemoteApiKey(event.target.value);
                  setRemoteConnections([]);
                }}
              />
            </label>
            <label>
              <span>Discord user ID</span>
              <input
                inputMode="numeric"
                placeholder="Linked Discord user ID"
                value={remoteDiscordUserId}
                onChange={(event) => {
                  setRemoteDiscordUserId(event.target.value);
                  setRemoteConnections([]);
                }}
              />
            </label>
            <label>
              <span>Custom domain <small>optional</small></span>
              <input
                placeholder="sharp.example.com"
                value={remoteDomain}
                onChange={(event) => {
                  setRemoteDomain(event.target.value);
                  setRemoteConnections([]);
                }}
              />
            </label>
            {remoteError && <div className="error">{remoteError}</div>}
            {remoteStatus && <p className="remoteStatus">{remoteStatus}</p>}
            {remoteConnections.length
              ? <button type="button" className="primary" disabled={remoteBusy} onClick={connectRemote}>
                  {remoteBusy ? "Connecting…" : "Allow access and connect"}
                </button>
              : <button type="button" className="secondary" disabled={remoteBusy} onClick={discoverRemote}>
                  {remoteBusy ? "Finding server…" : "Find remote clients"}
                </button>}
          </section>
          <div className="executionChainTabs" role="tablist" aria-label="Execution chain">
            {(Object.keys(chainLabels) as SharpChain[]).map((chain) => <button
              type="button"
              role="tab"
              aria-selected={executionChain === chain}
              className={executionChain === chain ? "active" : ""}
              key={chain}
              onClick={() => {
                setExecutionSelectionReady(true);
                setExecutionChain(chain);
                const preferred = snapshot.selectedClientIdsByChain[chain] ?? [];
                const nextClient = executionClients.find((client) =>
                  client.capabilities?.chain === chain && preferred.includes(client.endpointId)
                ) ?? executionClients.find((client) => client.capabilities?.chain === chain);
                setExecutionClientId(nextClient?.endpointId ?? "");
              }}
            >{chainLabels[chain]}</button>)}
          </div>
          <div className="executionGroupLabel">Sell events</div>
          {executionChain === "solana" && <EventExecutionEditor
            title="Dev Sell"
            value={creatorSell?.execution ?? { enabled: false, senders: [] }}
            canSave={Boolean(creatorSell && executionClient)}
            onSave={async (execution) => {
              if (!creatorSell || !executionClient) throw new Error("Select a connected client to save Dev Sell execution.");
              const response = await request({
                type: "sharp:update-creator-sell",
                clientId: executionClient.endpointId,
                settings: { ...creatorSell, execution }
              });
              if (!response.ok) throw new Error(response.error);
              if (response.creatorSell) setCreatorSell(response.creatorSell);
            }}
          />}
          <EventExecutionEditor
            title="Migration Sell"
            value={migrationSell?.execution ?? { enabled: false, senders: [] }}
            showSenders={executionChain === "solana"}
            showTip={executionChain === "solana"}
            feeLabel={executionChain === "solana" ? "Priority fee (SOL)" : "Priority fee (Gwei)"}
            presetPriorityFee={executionChain === "solana" ? undefined : executionPriorityFee}
            canSave={Boolean(migrationSell && executionClient)}
            onSave={async (execution) => {
              if (!migrationSell || !executionClient) throw new Error("Select a connected client to save Migration Sell execution.");
              const normalizedExecution = (() => {
                if (executionChain === "solana") return execution;
                const { tip: _tip, ...rpcExecution } = execution;
                return { ...rpcExecution, senders: ["rpc" as SolanaSender] };
              })();
              const response = await request({
                type: "sharp:update-migration-sell",
                clientId: executionClient.endpointId,
                settings: { ...migrationSell, execution: normalizedExecution }
              });
              if (!response.ok) throw new Error(response.error);
              if (response.migrationSell) setMigrationSell(response.migrationSell);
            }}
          />
          <EventExecutionEditor
            title="Wallet Trade Sell"
            value={snapshot.walletTradeSellExecutionByClient[executionClientId]
              ?? snapshot.walletTradeSellExecution[executionChain]}
            showSenders={executionChain === "solana"}
            showTip={executionChain === "solana"}
            feeLabel={executionChain === "solana" ? "Priority fee (SOL)" : "Priority fee (Gwei)"}
            presetPriorityFee={executionChain === "solana" ? undefined : executionPriorityFee}
            canSave={Boolean(executionClientId)}
            onSave={async (execution) => {
              if (!executionClientId) throw new Error("Select a connected client to save Wallet Trade Sell execution.");
              await patch({
                walletTradeSellExecutionByClient: {
                  ...snapshot.walletTradeSellExecutionByClient,
                  [executionClientId]: execution
                }
              });
            }}
          />
          {(Object.keys(chainLabels) as SharpChain[]).map((chain) => (
            <section className="field amountField" key={chain}>
              <div className="fieldHead">
                <strong>{chainLabels[chain]}</strong>
                <small>Set unused slots to 0</small>
              </div>
              <QuickAmountsEditor
                chain={chain}
                values={snapshot.quickAmounts[chain]}
                onChange={(amounts) => {
                  patch({ quickAmounts: { ...snapshot.quickAmounts, [chain]: amounts } });
                }}
              />
            </section>
          ))}
          <button className="danger" onClick={async () => {
            await request({ type: "sharp:wipe-remote" });
            await load();
          }}>Disconnect and wipe remote credentials</button>
          <p className="hint">Sharp credentials stay in extension-local trusted storage and are never exposed to trading-site scripts.</p>
        </section>
      )}
    </main>
  );
}
