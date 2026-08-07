import { routableTradeClients, type RuntimeRequest, type RuntimeResponse, type TradeCommand, type TradeResult } from "../src/protocol";
import { fetchCompatibility } from "../src/compatibility";
import { SocketRegistry } from "../src/socket-registry";
import { materializeWalletPlan, rebalanceWalletRoute, reconcileWalletPlan } from "../src/wallet-routing";
import {
  publicSnapshot,
  readStoredState,
  writeStoredState,
  type PendingPairing,
  type StoredConnection,
  type StoredState
} from "../src/storage";

export default defineBackground(() => {
  const registry = new SocketRegistry();
  const automationPositionKey = "sharpAutomationPanelPositionV1";
  const automationOpenKey = "sharpAutomationPanelOpenV1";
  const automationTransparentKey = "sharpAutomationPanelTransparentV2";
  const automationOpacityKey = "sharpAutomationPanelOpacityV2";
  let state: StoredState;

  const initialize = async () => {
    state = await readStoredState();
    registry.setChangeListener(broadcastState);
    registry.setPositionsChangeListener((clientId, positions) => {
      browser.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
          if (tab.id !== undefined) {
            browser.tabs.sendMessage(tab.id, {
              type: "sharp:positions-changed",
              clientId,
              positions
            }).catch(() => undefined);
          }
        }
      }).catch(() => undefined);
    });
    await registry.replaceConnections(state.connections);
  };
  const ready = initialize();

  const snapshot = () => publicSnapshot(state, registry.states());

  const broadcastState = () => {
    browser.runtime.sendMessage({ type: "sharp:state-changed", snapshot: snapshot() }).catch(() => undefined);
    browser.tabs.query({}).then((tabs) => {
      for (const tab of tabs) {
        if (tab.id !== undefined) {
          browser.tabs.sendMessage(tab.id, { type: "sharp:state-changed", snapshot: snapshot() }).catch(() => undefined);
        }
      }
    }).catch(() => undefined);
  };

  const refreshCompatibility = async () => {
    try {
      const compatibility = await fetchCompatibility();
      state.compatibilityDisabledSites = compatibility.disabledSites;
      state.compatibilityExpiresAt = compatibility.expiresAt;
      await writeStoredState(state);
      broadcastState();
    } catch (error) {
      console.warn("Sharp compatibility update was ignored", error);
    }
  };

  const handleTrade = async (command: TradeCommand): Promise<RuntimeResponse> => {
    const selectedIds = command.clientIds.length
      ? command.clientIds
      : state.selectedClientIdsByChain[command.context.chain] ?? [];
    const compatible = routableTradeClients(
      registry.states(),
      selectedIds,
      command.context.chain,
      command.action
    );
    if (!compatible.length) return { ok: false, error: "No selected compatible Sharp client is connected" };
    let reconciledStateChanged = false;
    const settled = await Promise.allSettled(compatible.map(async (client): Promise<TradeResult> => {
        const savedPlan = command.walletPlansByClient?.[client.endpointId]
          ?? command.walletPlan
          ?? (command.action === "sell"
          ? state.sellWalletPlansByClient[client.endpointId]
            ?? state.walletPlansByClient[client.endpointId]
          : state.walletPlansByClient[client.endpointId]);
        if (!savedPlan || savedPlan.allocations.length === 0) {
          return registry.trade(client.endpointId, command);
        }
        const includeBalances = savedPlan.autoRebalance === true && command.action === "buy";
        const inventory = await registry.getManagedWallets(client.endpointId, includeBalances);
        const reconciledPlan = reconcileWalletPlan(savedPlan, inventory.wallets);
        if (!reconciledPlan) {
          throw new Error(`The selected ${command.action} wallets no longer exist in this Sharp client. Refresh the wallet selection.`);
        }
        const plans = command.action === "sell" ? state.sellWalletPlansByClient : state.walletPlansByClient;
        if (plans[client.endpointId]) {
          plans[client.endpointId] = reconciledPlan;
          reconciledStateChanged = true;
        }
        const materializedPlan = materializeWalletPlan(reconciledPlan, command.action);
        const requestedAmount = Number(command.amount.value);
        const route = materializedPlan.autoRebalance
          && command.action === "buy"
          && Number.isFinite(requestedAmount)
          && requestedAmount > 0
          ? rebalanceWalletRoute(
              materializedPlan,
              command.action,
              requestedAmount,
              inventory.wallets
            )
          : { amount: requestedAmount, plan: materializedPlan };
        return registry.trade(client.endpointId, {
          ...command,
          amount: Number.isFinite(route.amount)
            ? { ...command.amount, value: route.amount }
            : command.amount,
          walletPlan: route.plan
        });
      }));
    if (reconciledStateChanged) {
      try {
        await writeStoredState(state);
      } catch (error) {
        console.warn("Sharp wallet identity refresh could not be persisted", error);
      }
    }
    const results = settled.map((result, index): TradeResult => {
      if (result.status === "fulfilled") return result.value;
      const client = compatible[index]!;
      return {
        endpointId: client.endpointId,
        clientName: client.capabilities?.client_name || client.endpointId,
        requestId: crypto.randomUUID(),
        status: "failed",
        errorCode: "WALLET_ROUTING_FAILED",
        message: result.reason instanceof Error ? result.reason.message : "Could not prepare managed-wallet routing"
      };
    });
    return { ok: true, results };
  };

  browser.runtime.onMessage.addListener((message: RuntimeRequest) => {
    return (async (): Promise<RuntimeResponse> => {
      await ready;
      switch (message.type) {
        case "sharp:get-state":
          return { ok: true, snapshot: snapshot() };
        case "sharp:get-custom-trade-launcher": {
          const controllers = registry.states().filter((client) =>
            client.connected && client.authenticated
          );
          const controller = controllers.find((client) => client.endpointId === "local-8686")
            ?? controllers.find((client) => client.capabilities?.module === "unknown")
            ?? controllers[0];
          if (!controller) return { ok: false, error: "Start the Sharp CLI before launching Custom Trade" };
          try {
            return {
              ok: true,
              customTradeLauncher: await registry.getCustomTradeLauncher(controller.endpointId)
            };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to load Custom Trade configuration" };
          }
        }
        case "sharp:start-custom-trade-runtime":
          try {
            await registry.startCustomTradeRuntime(
              message.controllerId,
              message.chain,
              message.presetId,
              message.wallet,
              message.paperTrade
            );
            await registry.replaceConnections(state.connections);
            return {
              ok: true,
              customTradeLauncher: await registry.getCustomTradeLauncher(message.controllerId)
            };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to start Custom Trade" };
          }
        case "sharp:get-panel-preferences": {
          const stored = await browser.storage.local.get([
            automationPositionKey,
            automationOpenKey,
            automationTransparentKey,
            automationOpacityKey
          ]);
          const position = stored[automationPositionKey];
          const validPosition = typeof position === "object"
            && position !== null
            && typeof (position as { x?: unknown }).x === "number"
            && typeof (position as { y?: unknown }).y === "number";
          return {
            ok: true,
            panelPreferences: {
              ...(typeof stored[automationOpenKey] === "boolean"
                ? { open: stored[automationOpenKey] as boolean }
                : {}),
              ...(typeof stored[automationTransparentKey] === "boolean"
                ? { transparent: stored[automationTransparentKey] as boolean }
                : {}),
              ...(typeof stored[automationOpacityKey] === "number"
                ? { opacity: Math.min(1, Math.max(0, stored[automationOpacityKey] as number)) }
                : {}),
              ...(validPosition ? { position: position as { x: number; y: number } } : {})
            }
          };
        }
        case "sharp:update-panel-preferences": {
          const changes: Record<string, unknown> = {};
          if (typeof message.preferences.open === "boolean") {
            changes[automationOpenKey] = message.preferences.open;
          }
          if (message.preferences.position) {
            changes[automationPositionKey] = message.preferences.position;
          }
          if (typeof message.preferences.transparent === "boolean") {
            changes[automationTransparentKey] = message.preferences.transparent;
          }
          if (typeof message.preferences.opacity === "number" && Number.isFinite(message.preferences.opacity)) {
            changes[automationOpacityKey] = Math.min(1, Math.max(0, message.preferences.opacity));
          }
          if (Object.keys(changes).length) await browser.storage.local.set(changes);
          return { ok: true, panelPreferences: message.preferences };
        }
        case "sharp:refresh":
          await registry.replaceConnections(state.connections);
          return { ok: true, snapshot: snapshot() };
        case "sharp:prewarm": {
          registry.releasePrewarmLease(message.leaseId);
          const selected = state.selectedClientIdsByChain[message.context.chain] ?? [];
          const compatible = routableTradeClients(
            registry.states(),
            selected,
            message.context.chain,
            "buy"
          );
          const results = await Promise.allSettled(
            compatible.map((client) => {
              const walletNames = state.walletPlansByClient[client.endpointId]
                ?.allocations.map((allocation) => allocation.walletName) ?? [];
              return registry.prewarm(
                client.endpointId,
                message.context,
                message.leaseId,
                walletNames
              );
            })
          );
          const ready = results.flatMap((result, index) =>
            result.status === "fulfilled"
              ? [{ clientId: compatible[index]!.endpointId, value: result.value }]
              : []
          );
          const resolved = ready[0]?.value;
          return {
            ok: true,
            ...(resolved ? {
              prewarm: {
                requestedAddress: message.context.address,
                resolvedAddress: resolved.resolvedAddress,
                ...(resolved.creator ? { creator: resolved.creator } : {}),
                clientIds: ready.map(({ clientId }) => clientId)
              }
            } : {})
          };
        }
        case "sharp:release-prewarm":
          registry.releasePrewarmLease(message.leaseId);
          return { ok: true };
        case "sharp:trade":
          return handleTrade(message.command);
        case "sharp:sell-initial":
          try {
            await registry.sellInitial(message.clientId, message.positionIds);
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Sell Initial failed" };
          }
        case "sharp:list-tasks":
          try {
            return { ok: true, tasks: await registry.listTasks(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to list tasks" };
          }
        case "sharp:create-task":
          try {
            const executionDefaults = state.automationExecution;
            const useDefaults = message.options?.useExtensionDefaults !== false;
            const taskOptions = {
              ...message.options,
              ...(useDefaults && message.options?.senders === undefined && executionDefaults.senders.length
                ? { senders: executionDefaults.senders }
                : {}),
              ...(useDefaults && message.options?.priorityFee === undefined && executionDefaults.priorityFee !== undefined
                ? { priorityFee: executionDefaults.priorityFee }
                : {}),
              ...(useDefaults && message.options?.tip === undefined && executionDefaults.tip !== undefined
                ? { tip: executionDefaults.tip }
                : {}),
              ...(useDefaults
                && message.options?.senderOverrides === undefined
                && Object.keys(executionDefaults.senderOverrides).length
                ? { senderOverrides: executionDefaults.senderOverrides }
                : {})
            };
            await registry.createTask(
              message.clientId,
              message.taskType,
              message.target,
              message.amount,
              message.match,
              message.lifecycle,
              taskOptions,
              message.arm
            );
            return { ok: true, tasks: await registry.listTasks(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to create task" };
          }
        case "sharp:task-action":
          try {
            await registry.taskAction(message.clientId, message.action, message.taskId);
            return { ok: true, tasks: await registry.listTasks(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Task action failed" };
          }
        case "sharp:get-positions":
          try {
            return { ok: true, positions: await registry.getPositions(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to load positions" };
          }
        case "sharp:update-position-automation":
          try {
            const walletName = message.walletName.trim();
            if (!walletName) throw new Error("Select a wallet");
            const automation = message.automation;
            if (
              typeof automation.creatorSell !== "boolean"
              || typeof automation.migrationSell !== "boolean"
              || typeof automation.walletTradeSell !== "boolean"
            ) {
              throw new Error("Position automation settings are invalid");
            }
            const creator = automation.creatorSellSettings;
            if (creator && (
              typeof creator.enabled !== "boolean"
              || !Number.isFinite(creator.minimumPercentage)
              || creator.minimumPercentage < 0
              || creator.minimumPercentage > 100
              || !Number.isFinite(creator.sellPercentage)
              || creator.sellPercentage <= 0
              || creator.sellPercentage > 100
            )) throw new Error("Position Dev Sell settings are invalid");
            await registry.updatePositionAutomation(
              message.clientId,
              message.context,
              walletName,
              automation
            );
            return { ok: true, positions: await registry.getPositions(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to update position automation" };
          }
        case "sharp:get-autosell-presets":
          try {
            return {
              ok: true,
              autosellPresets: await registry.getPositionAutosellPresets(message.clientId)
            };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to load Auto Sell setups" };
          }
        case "sharp:update-position-autosell":
          try {
            const walletName = message.walletName.trim();
            if (!walletName) throw new Error("Select a wallet");
            for (const value of [message.settings.tpsl, message.settings.sl, message.settings.tsl]) {
              if (typeof value !== "string" || !value.trim()) throw new Error("Auto Sell settings are invalid");
            }
            await registry.updatePositionAutosell(
              message.clientId,
              message.context,
              walletName,
              message.settings
            );
            return { ok: true, positions: await registry.getPositions(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to update position Auto Sell" };
          }
        case "sharp:get-managed-wallets":
          try {
            const managedWallets = await registry.getManagedWallets(message.clientId, message.balances === true);
            if (managedWallets.chain !== "solana") {
              managedWallets.groups = state.walletGroupsByClient[message.clientId] ?? [];
            }
            return {
              ok: true,
              managedWallets
            };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to load managed wallets" };
          }
        case "sharp:get-active-wallet-balance":
          try {
            return {
              ok: true,
              activeWalletBalance: await registry.getActiveWalletBalance(message.clientId)
            };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to load active wallet balance" };
          }
        case "sharp:get-execution-fee-defaults":
          try {
            return {
              ok: true,
              executionFeeDefaults: await registry.getExecutionFeeDefaults(message.clientId)
            };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to load execution fee defaults" };
          }
        case "sharp:create-managed-wallet":
          try {
            const name = message.name.trim();
            if (!name) throw new Error("Enter a wallet name");
            const managedWallets = await registry.createManagedWallet(message.clientId, name);
            if (managedWallets.chain !== "solana") {
              managedWallets.groups = state.walletGroupsByClient[message.clientId] ?? [];
            }
            return {
              ok: true,
              managedWallets
            };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to create managed wallet" };
          }
        case "sharp:create-managed-wallet-nonce":
          try {
            const walletName = message.walletName.trim();
            if (!walletName) throw new Error("Select a wallet");
            const requested = Math.trunc(message.count ?? 1);
            if (!Number.isFinite(requested) || requested < 1) throw new Error("Enter how many nonces to create");
            const count = Math.min(requested, 50);
            let managedWallets = await registry.createManagedWalletNonce(message.clientId, walletName, 1, count);
            for (let created = 1; created < count; created += 1) {
              managedWallets = await registry.createManagedWalletNonce(
                message.clientId,
                walletName,
                created + 1,
                count
              );
            }
            return { ok: true, managedWallets };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to create durable nonce" };
          }
        case "sharp:rename-managed-wallet":
          try {
            const oldName = message.oldName.trim();
            const name = message.name.trim();
            if (!oldName || !name) throw new Error("Enter a wallet name");
            return {
              ok: true,
              managedWallets: await registry.renameManagedWallet(message.clientId, oldName, name)
            };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to rename managed wallet" };
          }
        case "sharp:update-wallet-groups":
          try {
            const inventory = await registry.getManagedWallets(message.clientId);
            const known = new Set(inventory.wallets.map((wallet) => wallet.name));
            const ids = new Set<string>();
            const names = new Set<string>();
            if (message.groups.length > 50) throw new Error("Create no more than 50 wallet groups");
            const groups = message.groups.map((group) => {
              const id = group.id.trim();
              const name = group.name.trim();
              const wallets = [...new Set(group.wallets.map((wallet) => wallet.trim()).filter(Boolean))];
              if (!id || !name || name.length > 48) throw new Error("Every wallet group needs a name up to 48 characters");
              if (ids.has(id)) throw new Error(`Duplicate wallet group id: ${id}`);
              if (names.has(name.toLowerCase())) throw new Error(`Duplicate wallet group name: ${name}`);
              if (!wallets.length || wallets.length > 20) throw new Error("Each wallet group must contain 1 to 20 wallets");
              for (const wallet of wallets) {
                if (!known.has(wallet)) throw new Error(`Unknown Sharp wallet: ${wallet}`);
              }
              ids.add(id);
              names.add(name.toLowerCase());
              const creatorSell = group.creatorSell;
              const creatorSellWallets = group.creatorSellWallets === undefined
                ? undefined
                : [...new Set(group.creatorSellWallets.map((wallet) => wallet.trim()).filter(Boolean))];
              if (creatorSellWallets?.some((wallet) => !wallets.includes(wallet))) {
                throw new Error(`Dev Sell selection for ${name} contains a wallet outside that group`);
              }
              if (creatorSell && (
                typeof creatorSell.enabled !== "boolean"
                || !Number.isFinite(creatorSell.minimumPercentage)
                || creatorSell.minimumPercentage < 0
                || creatorSell.minimumPercentage > 100
                || !Number.isFinite(creatorSell.sellPercentage)
                || creatorSell.sellPercentage <= 0
                || creatorSell.sellPercentage > 100
              )) throw new Error(`Invalid Dev Sell settings for ${name}`);
              const autosell = group.autosell;
              const autosellWallets = group.autosellWallets === undefined
                ? undefined
                : [...new Set(group.autosellWallets.map((wallet) => wallet.trim()).filter(Boolean))];
              if (autosellWallets?.some((wallet) => !wallets.includes(wallet))) {
                throw new Error(`Auto Sell selection for ${name} contains a wallet outside that group`);
              }
              if (autosell && Object.values(autosell).some((value) => typeof value !== "string" || !value.trim())) {
                throw new Error(`Invalid Auto Sell settings for ${name}`);
              }
              return {
                id,
                name,
                wallets,
                ...(creatorSell ? { creatorSell } : {}),
                ...(creatorSellWallets !== undefined ? { creatorSellWallets } : {}),
                ...(autosell ? { autosell } : {}),
                ...(autosellWallets !== undefined ? { autosellWallets } : {})
              };
            });
            if (inventory.chain !== "solana") {
              state.walletGroupsByClient = {
                ...state.walletGroupsByClient,
                [message.clientId]: groups
              };
              await writeStoredState(state);
              broadcastState();
              return { ok: true, managedWallets: { ...inventory, groups }, snapshot: snapshot() };
            }
            return { ok: true, managedWallets: await registry.updateManagedWalletGroups(message.clientId, groups) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to save wallet groups" };
          }
        case "sharp:create-lookup-table":
          try {
            return {
              ok: true,
              managedWallets: await registry.createManagedLookupTable(message.clientId, message.authorityWallet)
            };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to create lookup table" };
          }
        case "sharp:update-lookup-tables":
          try {
            return {
              ok: true,
              managedWallets: await registry.updateManagedLookupTables(message.clientId, message.selectedTables)
            };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to update lookup tables" };
          }
        case "sharp:update-wallet-plan":
          try {
            const inventory = await registry.getManagedWallets(message.clientId);
            const known = new Set(inventory.wallets.map((wallet) => wallet.name));
            const seen = new Set<string>();
            const groupId = message.plan.groupId?.trim();
            const group = groupId ? inventory.groups.find((candidate) => candidate.id === groupId) : undefined;
            if (groupId && !group) throw new Error("Selected Sharp wallet group no longer exists");
            const requestedByWallet = new Map(
              message.plan.allocations.map((allocation) => [allocation.walletName.trim(), allocation])
            );
            const allocations = group
              ? group.wallets.map((walletName) => ({
                  walletName,
                  weight: 1,
                  ...(requestedByWallet.get(walletName)?.automation
                    ? { automation: requestedByWallet.get(walletName)!.automation }
                    : {}),
                  ...(requestedByWallet.get(walletName)?.autosell
                    ? { autosell: requestedByWallet.get(walletName)!.autosell }
                    : {})
                }))
              : message.plan.allocations.map((allocation) => ({
                  walletName: allocation.walletName.trim(),
                  weight: Number(allocation.weight),
                  ...(allocation.automation ? { automation: allocation.automation } : {}),
                  ...(allocation.autosell ? { autosell: allocation.autosell } : {})
                }));
            if (allocations.length > 20) throw new Error("Select no more than 20 wallets");
            for (const allocation of allocations) {
              if (!known.has(allocation.walletName)) throw new Error(`Unknown Sharp wallet: ${allocation.walletName}`);
              if (seen.has(allocation.walletName)) throw new Error(`Wallet selected more than once: ${allocation.walletName}`);
              if (!Number.isFinite(allocation.weight) || allocation.weight <= 0) throw new Error("Every selected wallet needs a positive allocation");
              if (allocation.automation) {
                const automation = allocation.automation;
                if (
                  typeof automation.creatorSell !== "boolean"
                  || typeof automation.migrationSell !== "boolean"
                  || typeof automation.walletTradeSell !== "boolean"
                ) throw new Error(`Managed wallet automation settings are invalid for ${allocation.walletName}`);
                const creator = automation.creatorSellSettings;
                if (creator && (
                  typeof creator.enabled !== "boolean"
                  || !Number.isFinite(creator.minimumPercentage)
                  || creator.minimumPercentage < 0
                  || creator.minimumPercentage > 100
                  || !Number.isFinite(creator.sellPercentage)
                  || creator.sellPercentage <= 0
                  || creator.sellPercentage > 100
                )) throw new Error(`Managed wallet Dev Sell settings are invalid for ${allocation.walletName}`);
              }
              if (allocation.autosell) {
                for (const value of [allocation.autosell.tpsl, allocation.autosell.sl, allocation.autosell.tsl]) {
                  if (typeof value !== "string" || !value.trim()) {
                    throw new Error(`Managed wallet Auto Sell settings are invalid for ${allocation.walletName}`);
                  }
                }
              }
              seen.add(allocation.walletName);
            }
            const randomizationBps = Number(message.plan.randomizationBps ?? 0);
            if (!Number.isFinite(randomizationBps) || randomizationBps < 0 || randomizationBps > 5_000) {
              throw new Error("Buy split variation must be between 0% and 50%");
            }
            if (allocations.length === 1) allocations[0]!.weight = 1;
            const autoRebalance = message.plan.autoRebalance === true;
            const nextPlan = {
              allocations,
              ...(group ? { groupId: group.id } : {}),
              ...(randomizationBps > 0 ? { randomizationBps } : {}),
              ...(autoRebalance ? { autoRebalance: true } : {})
            };
            if (message.action === "sell") {
              state.sellWalletPlansByClient = {
                ...state.sellWalletPlansByClient,
                [message.clientId]: nextPlan
              };
            } else {
              state.walletPlansByClient = {
                ...state.walletPlansByClient,
                [message.clientId]: nextPlan
              };
            }
            await writeStoredState(state);
            broadcastState();
            return { ok: true, snapshot: snapshot(), managedWallets: inventory };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to save wallet selection" };
          }
        case "sharp:get-migration-sell":
          try {
            return { ok: true, migrationSell: await registry.getMigrationSell(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to load Migration Sell" };
          }
        case "sharp:update-migration-sell":
          try {
            await registry.updateMigrationSell(message.clientId, message.settings);
            return { ok: true, migrationSell: await registry.getMigrationSell(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to update Migration Sell" };
          }
        case "sharp:get-creator-sell":
          try {
            return { ok: true, creatorSell: await registry.getCreatorSell(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to load Creator Sell" };
          }
        case "sharp:update-creator-sell":
          try {
            await registry.updateCreatorSell(message.clientId, message.settings);
            return { ok: true, creatorSell: await registry.getCreatorSell(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to update Creator Sell" };
          }
        case "sharp:get-wallet-trade-sell-triggers":
          try {
            return { ok: true, walletTradeSellTriggers: await registry.getWalletTradeSellTriggers(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to load watched-wallet triggers" };
          }
        case "sharp:update-wallet-trade-sell-triggers":
          try {
            await registry.updateWalletTradeSellTriggers(message.clientId, message.triggers);
            return { ok: true, walletTradeSellTriggers: await registry.getWalletTradeSellTriggers(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to save watched-wallet triggers" };
          }
        case "sharp:get-preset-execution":
          try {
            return {
              ok: true,
              presetExecution: await registry.getPresetExecution(message.clientId)
            };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : "Failed to load preset execution"
            };
          }
        case "sharp:list-dev-lists":
          try {
            return { ok: true, devLists: await registry.listDevWordlists(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to list developer wordlists" };
          }
        case "sharp:update-dev-list":
          try {
            await registry.updateDevList(message.clientId, message.creator, message.mode, message.file);
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to update developer list" };
          }
        case "sharp:list-wallet-lists":
          try {
            return { ok: true, walletLists: await registry.listWalletWordlists(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to list wallet wordlists" };
          }
        case "sharp:append-wallet-list":
          try {
            await registry.appendWalletWordlist(
              message.clientId,
              message.wallet.trim(),
              message.chain,
              message.file.trim()
            );
            return { ok: true, walletLists: await registry.listWalletWordlists(message.clientId) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Failed to update wallet wordlist" };
          }
        case "sharp:update-settings":
          state = { ...state, ...message.patch };
          await writeStoredState(state);
          broadcastState();
          return { ok: true, snapshot: snapshot() };
        case "sharp:pairing-approve": {
          const pending = state.pendingPairing;
          if (!pending || pending.requestId !== message.requestId) return { ok: false, error: "Pairing request expired" };
          state.connections = [
            ...state.connections.filter((connection) => !connection.remote),
            ...pending.connections
          ];
          delete state.pendingPairing;
          await writeStoredState(state);
          await browser.action.setBadgeText({ text: "" });
          await registry.replaceConnections(state.connections);
          return { ok: true, snapshot: snapshot() };
        }
        case "sharp:pairing-reject":
          if (state.pendingPairing?.requestId === message.requestId) {
            delete state.pendingPairing;
            await writeStoredState(state);
            await browser.action.setBadgeText({ text: "" });
          }
          return { ok: true, snapshot: snapshot() };
        case "sharp:wipe-remote":
          state.connections = state.connections.filter((connection) => !connection.remote);
          delete state.pendingPairing;
          await writeStoredState(state);
          await registry.replaceConnections(state.connections);
          return { ok: true, snapshot: snapshot() };
      }
    })();
  });

  browser.runtime.onConnect.addListener((port) => {
    const prefix = "sharp-prewarm:";
    if (!port.name.startsWith(prefix)) return;
    const leaseId = port.name.slice(prefix.length);
    if (!leaseId) return;
    port.onMessage.addListener((message: unknown) => {
      if (
        message
        && typeof message === "object"
        && (message as { type?: unknown }).type === "sharp:keepalive"
      ) {
        try {
          port.postMessage({ type: "sharp:keepalive-ack" });
        } catch {}
      }
    });
    port.onDisconnect.addListener(() => {
      void ready.then(() => registry.releasePrewarmLease(leaseId));
    });
  });

  browser.runtime.onMessageExternal.addListener((message: unknown, sender) => {
    return (async () => {
      await ready;
      const origin = sender.origin || "";
      if (!["https://webui.yvesdev.com", "http://localhost:7072", "http://127.0.0.1:7072"].includes(origin)) {
        return { ok: false, error: "Pairing origin is not allowed" };
      }
      const offer = message as { type?: string; requestId?: string; connections?: StoredConnection[] };
      if (offer.type !== "sharp:pairing-offer" || !offer.requestId || !Array.isArray(offer.connections)) {
        return { ok: false, error: "Invalid pairing offer" };
      }
      const connections = offer.connections.slice(0, 16).filter((connection) => {
        try {
          const url = new URL(connection.endpoint);
          return url.protocol === "https:"
            && connection.remote === true
            && typeof connection.id === "string"
            && connection.id.length > 0
            && connection.id.length <= 80
            && typeof connection.apiKey === "string"
            && connection.apiKey.length > 0
            && connection.apiKey.length <= 512;
        } catch {
          return false;
        }
      }).map((connection) => ({
        id: connection.id,
        endpoint: connection.endpoint,
        remote: true,
        apiKey: connection.apiKey!,
        ...(typeof connection.discordUserId === "string" ? { discordUserId: connection.discordUserId } : {}),
        ...(typeof connection.clientIp === "string" ? { clientIp: connection.clientIp } : {})
      }));
      if (!connections.length) return { ok: false, error: "Pairing offer has no secure remote endpoints" };
      const checksum = offer.requestId.replaceAll("-", "").slice(0, 6).toUpperCase();
      const pending: PendingPairing = {
        requestId: offer.requestId,
        checksum,
        origin,
        createdAt: Date.now(),
        connections
      };
      state.pendingPairing = pending;
      await writeStoredState(state);
      await browser.action.setBadgeText({ text: "PAIR" });
      await browser.action.setBadgeBackgroundColor({ color: "#3b82f6" });
      return { ok: true, checksum };
    })();
  });

  browser.alarms.create("sharp-refresh", { periodInMinutes: 1 });
  browser.alarms.create("sharp-compatibility", { periodInMinutes: 360 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "sharp-refresh") ready.then(() => registry.replaceConnections(state.connections)).catch(() => undefined);
    if (alarm.name === "sharp-compatibility") ready.then(refreshCompatibility).catch(() => undefined);
  });
  ready.then(refreshCompatibility).catch(() => undefined);
  ready.catch((error) => console.error("Sharp extension initialization failed", error));
});
