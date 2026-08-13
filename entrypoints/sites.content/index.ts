import {
  routableTradeClients,
  type ExtensionSnapshot,
  type RuntimeRequest,
  type RuntimeResponse,
  type SharpPosition,
  type TradeAction,
  type TradeCommand,
  type TradeContext,
  type TradeResult
} from "../../src/protocol";
import {
  currentPageTradeContext,
  instantTradeQuoteFor,
  nativeAmountFor,
  scanTradeSurfaces
} from "../../src/adapters";
import { watchLocationChanges, type LocationWatcher } from "../../src/location-watcher";
import {
  createSharpAutomationPanel,
  createSharpToasts,
  summarizeSellResults,
  type SharpToastController
} from "./site-ui";
import "./style.css";

const matches = [
  "https://axiom.trade/*",
  "https://trade.padre.gg/*",
  "https://gmgn.ai/*",
  "https://trade.basedbot.app/*",
  "https://basedbot.app/*",
  "https://pump.fun/*",
  "https://www.pump.fun/*",
  "https://fomo.family/*",
  "https://dexscreener.com/*",
  "https://www.dexscreener.com/*"
];

interface Mount {
  nativeButton: HTMLElement;
  hitTarget: HTMLSpanElement;
  originalAriaLabel: string | null;
  context: TradeContext;
  action: TradeAction;
  fixedAmount: TradeCommand["amount"] | undefined;
  menuHost: HTMLDivElement | undefined;
  clickHandler: (event: MouseEvent) => void;
  busy: boolean;
  resetTimer: number | undefined;
}

export default defineContentScript({
  matches,
  runAt: "document_idle",
  main(ctx) {
    const mounts = new Map<HTMLElement, Mount>();
    let snapshot: ExtensionSnapshot | undefined;
    let scanTimer: number | undefined;
    let lastPrewarmKey = "";
    const prewarmLeaseId = crypto.randomUUID();
    let prewarmPort: ReturnType<typeof browser.runtime.connect> | undefined;
    let prewarmHeartbeatTimer: number | undefined;
    let contentInvalidated = false;
    let pageSuspended = false;
    let reconnectTimer: number | undefined;
    let discoveryTimer: number | undefined;
    let observer: MutationObserver | undefined;
    let locationWatcher: LocationWatcher | undefined;
    let contentDestroyed = false;
    let shutdownContent = () => {
      contentInvalidated = true;
    };
    let activePrewarm:
      | { address: string; promise: Promise<void> }
      | undefined;
    let prewarmReadyClientIds = new Set<string>();
    let resolvedPageAddress:
      | { requestedAddress: string; resolvedAddress: string; creator?: string }
      | undefined;
    let prewarmStatus: "idle" | "resolving" | "ready" | "failed" = "idle";
    let prewarmError = "";
    let connectedClientIds = new Set<string>();
    let openMount: Mount | undefined;
    const mutationScanSelector = [
      "button",
      "[role='button']",
      "[tabindex]:not(input)",
      "[class*='cursor-pointer']",
      "[data-chain]",
      "[data-address]",
      "[data-token-address]",
      "[data-contract-address]",
      "[data-mint]",
      "[data-clipboard-text]",
      "[data-copy]",
      "a[href]"
    ].join(",");
    const toasts = createSharpToasts();
    const localPositionKey = "sharp:automation-position:v1";
    const localOpenKey = "sharp:automation-open:v1";
    const localTransparentKey = "sharp:automation-transparent:v2";
    const localOpacityKey = "sharp:automation-opacity:v2";
    const readLocalPosition = () => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(localPositionKey) || "null") as {
          x?: unknown;
          y?: unknown;
        } | null;
        return parsed
          && typeof parsed.x === "number"
          && typeof parsed.y === "number"
          ? { x: parsed.x, y: parsed.y }
          : undefined;
      } catch {
        return undefined;
      }
    };
    const readLocalOpen = () => {
      try {
        const value = window.localStorage.getItem(localOpenKey);
        return value === "true" ? true : value === "false" ? false : undefined;
      } catch {
        return undefined;
      }
    };
    const writeLocalPreference = (key: string, value: string) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {}
    };
    const isExtensionContextError = (error: unknown) =>
      /extension context invalidated|message port closed|receiving end does not exist/i.test(
        error instanceof Error ? error.message : String(error)
      );
    const request = async (message: RuntimeRequest): Promise<RuntimeResponse> => {
      if (contentInvalidated) {
        return { ok: false, error: "Extension was reloaded. Refresh this page to reconnect Sharp." };
      }
      try {
        return await browser.runtime.sendMessage(message) as RuntimeResponse;
      } catch (error) {
        if (isExtensionContextError(error)) {
          shutdownContent();
          return { ok: false, error: "Extension was reloaded. Refresh this page to reconnect Sharp." };
        }
        throw error;
      }
    };
    const automationPanel = createSharpAutomationPanel({
      request,
      toasts,
      loadPosition: async () => {
        const local = readLocalPosition();
        if (local) return local;
        const response = await request({ type: "sharp:get-panel-preferences" });
        return response.ok ? response.panelPreferences?.position : undefined;
      },
      savePosition: (position) => {
        writeLocalPreference(localPositionKey, JSON.stringify(position));
        return request({ type: "sharp:update-panel-preferences", preferences: { position } }).then(() => undefined);
      },
      loadOpen: async () => {
        const local = readLocalOpen();
        if (local !== undefined) return local;
        const response = await request({ type: "sharp:get-panel-preferences" });
        return response.ok ? response.panelPreferences?.open ?? true : true;
      },
      saveOpen: (open) => {
        writeLocalPreference(localOpenKey, String(open));
        return request({ type: "sharp:update-panel-preferences", preferences: { open } }).then(() => undefined);
      },
      loadTransparency: async () => {
        try {
          const transparent = window.localStorage.getItem(localTransparentKey);
          const opacity = Number(window.localStorage.getItem(localOpacityKey));
          if (transparent === "true" || transparent === "false") {
            return {
              enabled: transparent === "true",
              opacity: Number.isFinite(opacity) && opacity >= 0 ? opacity : 1
            };
          }
        } catch {}
        const response = await request({ type: "sharp:get-panel-preferences" });
        return response.ok ? {
          enabled: response.panelPreferences?.transparent ?? false,
          opacity: response.panelPreferences?.opacity ?? 1
        } : undefined;
      },
      saveTransparency: ({ enabled, opacity }) => {
        writeLocalPreference(localTransparentKey, String(enabled));
        writeLocalPreference(localOpacityKey, String(opacity));
        return request({
          type: "sharp:update-panel-preferences",
          preferences: { transparent: enabled, opacity }
        }).then(() => undefined);
      }
    });

    const restore = (mount: Mount) => {
      closeMenu(mount);
      mount.nativeButton.removeAttribute("data-sharp-replaced");
      mount.nativeButton.removeAttribute("data-sharp-action");
      mount.nativeButton.removeAttribute("data-sharp-amount-mode");
      mount.nativeButton.removeAttribute("data-sharp-amount-value");
      mount.nativeButton.removeAttribute("data-sharp-state");
      mount.nativeButton.removeEventListener("click", mount.clickHandler, true);
      if (mount.resetTimer !== undefined) window.clearTimeout(mount.resetTimer);
      if (mount.originalAriaLabel === null) {
        mount.nativeButton.removeAttribute("aria-label");
      } else {
        mount.nativeButton.setAttribute("aria-label", mount.originalAriaLabel);
      }
      mount.hitTarget.remove();
      mounts.delete(mount.nativeButton);
    };

    const restoreAll = () => {
      for (const mount of [...mounts.values()]) restore(mount);
    };

    shutdownContent = () => {
      if (contentDestroyed) return;
      contentDestroyed = true;
      contentInvalidated = true;
      if (scanTimer !== undefined) window.clearTimeout(scanTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (discoveryTimer !== undefined) window.clearTimeout(discoveryTimer);
      if (prewarmHeartbeatTimer !== undefined) window.clearInterval(prewarmHeartbeatTimer);
      scanTimer = undefined;
      reconnectTimer = undefined;
      discoveryTimer = undefined;
      prewarmHeartbeatTimer = undefined;
      try {
        prewarmPort?.disconnect();
      } catch {}
      prewarmPort = undefined;
      observer?.disconnect();
      locationWatcher?.stop();
      locationWatcher = undefined;
      restoreAll();
      automationPanel.destroy();
      toasts.destroy();
    };

    const connectPrewarmPort = () => {
      if (contentInvalidated || pageSuspended || prewarmPort) return;
      try {
        const port = browser.runtime.connect({ name: `sharp-prewarm:${prewarmLeaseId}` });
        prewarmPort = port;
        const keepAlive = () => {
          if (prewarmPort !== port || contentInvalidated || pageSuspended) return;
          try {
            port.postMessage({ type: "sharp:keepalive", at: Date.now() });
          } catch (error) {
            if (isExtensionContextError(error)) shutdownContent();
          }
        };
        keepAlive();
        prewarmHeartbeatTimer = window.setInterval(keepAlive, 2_000);
        port.onDisconnect.addListener(() => {
          try {
            void chrome.runtime.lastError;
          } catch {}
          if (prewarmPort === port) {
            prewarmPort = undefined;
            if (prewarmHeartbeatTimer !== undefined) {
              window.clearInterval(prewarmHeartbeatTimer);
              prewarmHeartbeatTimer = undefined;
            }
          }
          if (contentInvalidated || pageSuspended) return;
          lastPrewarmKey = "";
          activePrewarm = undefined;
          prewarmReadyClientIds.clear();
          resolvedPageAddress = undefined;
          prewarmStatus = "idle";
          prewarmError = "";
          scheduleScan();
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined;
            connectPrewarmPort();
          }, 500);
        });
      } catch (error) {
        if (isExtensionContextError(error)) shutdownContent();
        else throw error;
      }
    };
    connectPrewarmPort();

    const trade = async (
      context: TradeContext,
      action: TradeAction,
      amount: TradeCommand["amount"]
    ): Promise<TradeResult[]> => {
      if (!snapshot) return [];
      const prefersPrewarm = action === "buy"
        && context.chain === "solana"
        && context.surface === "detail";
      if (prefersPrewarm) {
        const pending = activePrewarm;
        const pendingMatches = pending && (
          pending.address === context.address
          || resolvedPageAddress?.requestedAddress === pending.address
            && resolvedPageAddress.resolvedAddress === context.address
        );
        if (pendingMatches) await pending.promise;
      }
      const preferredClientIds = snapshot.selectedClientIdsByChain[context.chain] ?? [];
      const preparedClientIds = preferredClientIds.filter((clientId) =>
        prewarmReadyClientIds.has(clientId)
      );
      const selectedClientIds = prefersPrewarm && preparedClientIds.length
        ? preparedClientIds
        : preferredClientIds.length
          ? preferredClientIds
          : [...prewarmReadyClientIds];
      const response = await request({
        type: "sharp:trade",
        command: {
          context,
          action,
          clientIds: selectedClientIds,
          amount
        }
      });
      if (!response.ok) throw new Error(response.error);
      return response.results ?? [];
    };

    const buttonLabel = (mount: Pick<Mount, "action" | "fixedAmount">) => {
      if (mount.fixedAmount?.value !== undefined) {
        return `S ${mount.fixedAmount.value}${mount.fixedAmount.mode === "percentage" ? "%" : ""}`;
      }
      return mount.action === "buy" ? "Sharp Buy" : "Sharp Sell";
    };

    const acceptedNativeQuotes = (chain: TradeContext["chain"]) => {
      if (chain === "solana") return new Set(["SOL"]);
      if (chain === "bsc") return new Set(["BNB"]);
      return new Set(["ETH", "WETH"]);
    };

    const nativeQuoteName = (chain: TradeContext["chain"]) => {
      if (chain === "solana") return "SOL";
      if (chain === "bsc") return "BNB";
      return "ETH";
    };

    const resetButtonLabel = (mount: Mount, delay = 0) => {
      if (mount.resetTimer !== undefined) window.clearTimeout(mount.resetTimer);
      mount.resetTimer = window.setTimeout(() => {
        mount.hitTarget.textContent = buttonLabel(mount);
        mount.nativeButton.removeAttribute("data-sharp-state");
        mount.resetTimer = undefined;
      }, delay);
    };

    const submitAmount = async (mount: Mount, amount: TradeCommand["amount"]) => {
      if (mount.busy) return;
      mount.busy = true;
      let pending: ReturnType<SharpToastController["pending"]> | undefined;
      mount.hitTarget.textContent = mount.action === "buy" ? "Pending…" : "Attempting…";
      mount.nativeButton.dataset.sharpState = "submitting";
      try {
        pending = mount.action === "buy"
          ? toasts.pending("Pending buy…", "Waiting for Sharp transaction result")
          : toasts.pending("Attempting to sell…", "Waiting for Sharp transaction result");
        const results = await trade(
          mount.context,
          mount.action,
          amount
        );
        const succeeded = results.length > 0 && results.every((result) => result.status === "accepted");
        mount.hitTarget.textContent = succeeded
          ? mount.action === "buy" ? "Buy confirmed" : "Sell confirmed"
          : "Sharp failed";
        mount.nativeButton.dataset.sharpState = succeeded ? "accepted" : "failed";
        if (results.length === 0) {
          const message = "No selected Sharp client is available for this chain.";
          pending.settle("error", mount.action === "buy" ? "Buy failed" : "Sell failed", message);
        } else {
          if (mount.action === "buy") {
            const failed = results.filter((result) => result.status !== "accepted");
            pending.settle(
              failed.length === 0 ? "success" : "error",
              failed.length === 0 ? "Buy confirmed" : failed.some((result) => result.status === "timed_out") ? "Buy timed out" : "Buy failed",
              results.map((result) => `${result.clientName}: ${result.message}`).join(" · ")
            );
          } else {
            const summary = summarizeSellResults(results);
            pending.settle(summary.kind === "success" ? "success" : "error", summary.title, summary.message);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sharp command failed";
        mount.hitTarget.textContent = "Sharp failed";
        mount.nativeButton.dataset.sharpState = "failed";
        pending?.settle("error", mount.action === "buy" ? "Buy failed" : "Sell failed", message);
      } finally {
        mount.busy = false;
        resetButtonLabel(mount, 1_800);
      }
    };

    const submitNativeAmount = async (mount: Mount) => {
      const value = nativeAmountFor(mount.nativeButton);
      if (value === undefined) {
        mount.hitTarget.textContent = "Enter an amount";
        mount.nativeButton.dataset.sharpState = "failed";
        toasts.show(
          "error",
          `${mount.action === "buy" ? "Buy" : "Sell"} failed`,
          "Enter a positive amount before submitting."
        );
        resetButtonLabel(mount, 1_500);
        return;
      }
      await submitAmount(mount, {
        mode: mount.action === "buy" ? "native" : "token_amount",
        value
      });
    };

    function removeMenuListeners(mount: Mount) {
      const listeners = mount.menuHost?.dataset.listeners;
      if (!listeners) return;
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      document.removeEventListener("keydown", handleMenuKeydown, true);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      if (mount.menuHost) delete mount.menuHost.dataset.listeners;
    }

    function closeMenu(mount: Mount) {
      removeMenuListeners(mount);
      mount.menuHost?.remove();
      mount.menuHost = undefined;
      if (openMount === mount) openMount = undefined;
    }

    function handleOutsidePointer(event: PointerEvent) {
      if (!openMount) return;
      const target = event.target;
      if (target instanceof Node && (
        openMount.hitTarget.contains(target) ||
        openMount.menuHost?.contains(target)
      )) return;
      closeMenu(openMount);
    }

    function handleMenuKeydown(event: KeyboardEvent) {
      if (event.key === "Escape" && openMount) closeMenu(openMount);
    }

    function handleViewportChange() {
      if (openMount) positionMenu(openMount);
    }

    function positionMenu(mount: Mount) {
      const host = mount.menuHost;
      if (!host) return;
      const rect = mount.nativeButton.getBoundingClientRect();
      const viewportPadding = 8;
      const menuWidth = Math.min(300, Math.max(264, rect.width));
      const maxLeft = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
      const left = Math.min(maxLeft, Math.max(viewportPadding, rect.right - menuWidth));
      host.style.setProperty("--sharp-menu-width", `${menuWidth}px`);
      host.style.left = `${left}px`;
      host.style.top = `${rect.bottom + 6}px`;
      const menuHeight = host.getBoundingClientRect().height;
      if (rect.bottom + 6 + menuHeight > window.innerHeight - viewportPadding && rect.top > menuHeight + 6) {
        host.style.top = `${Math.max(viewportPadding, rect.top - menuHeight - 6)}px`;
      }
    }

    const openMenu = (mount: Mount) => {
      if (openMount === mount) {
        closeMenu(mount);
        return;
      }
      if (openMount) closeMenu(openMount);

      const computed = getComputedStyle(mount.nativeButton);
      const host = document.createElement("div");
      host.dataset.sharpMenuPortal = "";
      host.style.setProperty("--sharp-site-font", computed.fontFamily);
      host.style.setProperty("--sharp-site-font-size", computed.fontSize);
      host.style.setProperty("--sharp-site-font-weight", computed.fontWeight);
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = injectedStyles;
      const menu = document.createElement("div");
      menu.className = "sharp-menu";
      shadow.append(style, menu);
      document.documentElement.append(host);
      mount.menuHost = host;
      openMount = mount;

      const header = document.createElement("div");
      header.className = "sharp-menu-head";
      const title = document.createElement("strong");
      title.textContent = `${mount.action === "buy" ? "Buy" : "Sell"} with Sharp`;
      const token = document.createElement("span");
      token.textContent = `${mount.context.chain} · ${mount.context.address.slice(0, 5)}…${mount.context.address.slice(-4)}`;
      header.append(title, token);

      const clients = document.createElement("div");
      clients.className = "sharp-clients";
      const selected = snapshot?.selectedClientIdsByChain[mount.context.chain] ?? [];
      const eligibleClients = snapshot?.clients.filter((item) =>
        selected.includes(item.endpointId) &&
        item.capabilities?.chain === mount.context.chain
      ) ?? [];
      for (const client of eligibleClients) {
        const row = document.createElement("span");
        row.textContent = `${client.capabilities?.client_name || client.endpointId} · ${client.capabilities?.paper_trade ? "PAPER" : "REAL"}`;
        row.className = client.capabilities?.paper_trade ? "paper" : "real";
        clients.append(row);
      }
      if (eligibleClients.length === 0) {
        const row = document.createElement("span");
        row.textContent = "No selected client for this chain";
        clients.append(row);
      }

      const choices = document.createElement("div");
      choices.className = "sharp-choices";
      const values = mount.action === "buy" ? snapshot?.quickAmounts[mount.context.chain] ?? [] : [25, 50, 75, 100];
      const preset = document.createElement("button");
      preset.type = "button";
      preset.textContent = "Preset";
      choices.append(preset);
      for (const value of values) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = mount.action === "buy" ? String(value) : `${value}%`;
        button.onclick = () => execute({ mode: mount.action === "buy" ? "native" : "percentage", value });
        choices.append(button);
      }
      const status = document.createElement("div");
      status.className = "sharp-status";
      const execute = async (amount: TradeCommand["amount"]) => {
        for (const button of choices.querySelectorAll("button")) button.disabled = true;
        status.textContent = mount.action === "buy" ? "Pending buy…" : "Attempting to sell…";
        const pending = mount.action === "buy"
          ? toasts.pending("Pending buy…", "Waiting for Sharp transaction result")
          : toasts.pending("Attempting to sell…", "Waiting for Sharp transaction result");
        try {
          const results = await trade(mount.context, mount.action, amount);
          if (results.length === 0) {
            status.textContent = "No selected Sharp client is available for this chain.";
            pending.settle("error", mount.action === "buy" ? "Buy failed" : "Sell failed", status.textContent);
          } else {
            status.replaceChildren(...results.map((result) => {
              const item = document.createElement("span");
              item.className = result.status;
              item.textContent = `${result.clientName}: ${result.message}`;
              return item;
            }));
            if (mount.action === "buy") {
              const failed = results.filter((result) => result.status !== "accepted");
              pending.settle(
                failed.length === 0 ? "success" : "error",
                failed.length === 0 ? "Buy confirmed" : failed.some((result) => result.status === "timed_out") ? "Buy timed out" : "Buy failed",
                results.map((result) => `${result.clientName}: ${result.message}`).join(" · ")
              );
            } else {
              const summary = summarizeSellResults(results);
              pending.settle(summary.kind === "success" ? "success" : "error", summary.title, summary.message);
            }
          }
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Sharp command failed";
          pending.settle("error", mount.action === "buy" ? "Buy failed" : "Sell failed", status.textContent);
        } finally {
          for (const button of choices.querySelectorAll("button")) button.disabled = false;
        }
      };
      preset.onclick = () => execute(
        mount.action === "buy"
          ? { mode: "preset" }
          : { mode: "percentage", value: 100 }
      );
      menu.append(header, clients, choices, status);

      host.dataset.listeners = "true";
      document.addEventListener("pointerdown", handleOutsidePointer, true);
      document.addEventListener("keydown", handleMenuKeydown, true);
      window.addEventListener("resize", handleViewportChange);
      window.addEventListener("scroll", handleViewportChange, true);
      positionMenu(mount);
      requestAnimationFrame(() => positionMenu(mount));
    };

    const mountControl = (
      nativeButton: HTMLElement,
      context: TradeContext,
      action: TradeAction,
      fixedAmount?: TradeCommand["amount"]
    ) => {
      const existing = mounts.get(nativeButton);
      if (existing) {
        existing.context = context;
        existing.action = action;
        existing.fixedAmount = fixedAmount;
        existing.hitTarget.textContent = buttonLabel(existing);
        nativeButton.dataset.sharpAction = action;
        if (fixedAmount?.value !== undefined) {
          nativeButton.dataset.sharpAmountMode = fixedAmount.mode;
          nativeButton.dataset.sharpAmountValue = String(fixedAmount.value);
        } else {
          nativeButton.removeAttribute("data-sharp-amount-mode");
          nativeButton.removeAttribute("data-sharp-amount-value");
        }
        return;
      }

      const hitTarget = document.createElement("span");
      hitTarget.dataset.sharpHitTarget = "";
      hitTarget.textContent = buttonLabel({ action, fixedAmount });
      const originalAriaLabel = nativeButton.getAttribute("aria-label");
      nativeButton.dataset.sharpReplaced = "";
      nativeButton.dataset.sharpAction = action;
      if (fixedAmount?.value !== undefined) {
        nativeButton.dataset.sharpAmountMode = fixedAmount.mode;
        nativeButton.dataset.sharpAmountValue = String(fixedAmount.value);
      }
      nativeButton.setAttribute("aria-label", hitTarget.textContent);
      nativeButton.append(hitTarget);

      let mount: Mount;
      const clickHandler = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (mount.fixedAmount) {
          const quote = mount.fixedAmount.mode === "native"
            ? instantTradeQuoteFor(mount.nativeButton)
            : undefined;
          const expectedQuotes = acceptedNativeQuotes(mount.context.chain);
          if (quote && !expectedQuotes.has(quote)) {
            const nativeQuote = nativeQuoteName(mount.context.chain);
            mount.hitTarget.textContent = `Select ${nativeQuote}`;
            mount.nativeButton.dataset.sharpState = "failed";
            toasts.show(
              "error",
              `Sharp buy requires ${nativeQuote}`,
              `${quote} quick-trade amounts are not supported by this Sharp client. Select ${nativeQuote} first.`
            );
            resetButtonLabel(mount, 1_800);
            return;
          }
          void submitAmount(mount, mount.fixedAmount);
        } else if (nativeAmountFor(mount.nativeButton) !== undefined) {
          void submitNativeAmount(mount);
        } else {
          openMenu(mount);
        }
      };
      mount = {
        nativeButton,
        hitTarget,
        originalAriaLabel,
        context,
        action,
        fixedAmount,
        menuHost: undefined,
        clickHandler,
        busy: false,
        resetTimer: undefined
      };
      mounts.set(nativeButton, mount);
      nativeButton.addEventListener("click", clickHandler, true);

      for (const eventName of ["pointerdown", "mousedown"]) {
        hitTarget.addEventListener(eventName, (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        });
      }
    };

    const scan = () => {
      if (contentInvalidated || pageSuspended || !snapshot) return;
      const routeContext = currentPageTradeContext();
      const preferredPrewarmClients = routeContext
          ? routableTradeClients(
            snapshot.clients,
            snapshot.selectedClientIdsByChain[routeContext.chain] ?? [],
            routeContext.chain,
            "buy"
          )
        : [];
      const prewarmClients = preferredPrewarmClients
        .map((client) => client.endpointId)
        .sort();
      const hasResolvedPage = Boolean(
        routeContext && resolvedPageAddress?.requestedAddress === routeContext.address
      );
      const resolvedCreator = resolvedPageAddress?.creator || routeContext?.creator;
      const creatorStatus: TradeContext["creatorStatus"] = resolvedCreator
        ? "resolved"
        : routeContext?.chain !== "solana"
          ? "unavailable"
          : hasResolvedPage
            ? "unavailable"
            : prewarmStatus === "failed"
              ? "failed"
              : prewarmClients.length > 0
                ? "resolving"
                : "unavailable";
      const pageContext = routeContext
        ? {
            ...routeContext,
            ...(hasResolvedPage
              ? {
                  address: resolvedPageAddress!.resolvedAddress,
                  addressKind: "token" as const
                }
              : {}),
            ...(resolvedCreator ? { creator: resolvedCreator } : {}),
            creatorStatus,
            ...(creatorStatus === "failed" && prewarmError ? { creatorError: prewarmError } : {})
          }
        : undefined;
      automationPanel.update(snapshot, pageContext);
      const prewarmKey = routeContext && prewarmClients.length
        ? `${routeContext.chain}:${routeContext.marketHint || "custom"}:${routeContext.address}:${prewarmClients.join(",")}`
        : "";
      if (prewarmKey && prewarmKey !== lastPrewarmKey) {
        lastPrewarmKey = prewarmKey;
        prewarmStatus = "resolving";
        prewarmError = "";
        prewarmReadyClientIds.clear();
        if (resolvedPageAddress?.requestedAddress !== routeContext!.address) {
          resolvedPageAddress = undefined;
        }
        const promise = request({
          type: "sharp:prewarm",
          context: routeContext!,
          leaseId: prewarmLeaseId
        }).then((response) => {
          if (
            response.ok &&
            response.prewarm &&
            currentPageTradeContext()?.address === response.prewarm.requestedAddress
          ) {
            resolvedPageAddress = response.prewarm;
            prewarmReadyClientIds = new Set(response.prewarm.clientIds);
            prewarmStatus = "ready";
          } else if (lastPrewarmKey === prewarmKey) {
            prewarmStatus = "failed";
            prewarmError = response.ok
              ? "Sharp could not resolve this Axiom pool"
              : response.error;
          }
        }).catch((error: unknown) => {
          if (lastPrewarmKey === prewarmKey) {
            prewarmStatus = "failed";
            prewarmError = error instanceof Error ? error.message : "Developer lookup failed";
          }
        }).finally(() => {
          if (activePrewarm?.promise === promise) activePrewarm = undefined;
          scheduleScan();
        });
        activePrewarm = { address: routeContext!.address, promise };
      } else if (!prewarmKey) {
        if (lastPrewarmKey || activePrewarm || prewarmReadyClientIds.size) {
          void request({
            type: "sharp:release-prewarm",
            leaseId: prewarmLeaseId
          }).catch(() => undefined);
        }
        lastPrewarmKey = "";
        activePrewarm = undefined;
        prewarmReadyClientIds.clear();
        resolvedPageAddress = undefined;
        prewarmStatus = "idle";
        prewarmError = "";
      }
      const wanted = new Map(scanTradeSurfaces(snapshot).map((surface) => [surface.nativeButton, surface]));
      for (const mount of [...mounts.values()]) {
        if (!mount.nativeButton.isConnected || !mount.hitTarget.isConnected || !wanted.has(mount.nativeButton)) restore(mount);
      }
      for (const surface of wanted.values()) {
        mountControl(surface.nativeButton, surface.context, surface.action, surface.amount);
      }
    };

    const scheduleScan = () => {
      if (contentInvalidated || pageSuspended || scanTimer !== undefined) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = undefined;
        scan();
      }, 250);
    };

    const mutationCanChangeTradeSurfaces = (mutation: MutationRecord) => {
      const target = mutation.target instanceof Element
        ? mutation.target
        : mutation.target.parentElement;
      if (target?.closest("[data-sharp-root]")) return false;
      if (mutation.type === "attributes") return true;
      if (target?.matches(mutationScanSelector)) return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
        if (node instanceof Element) {
          if (node.closest("[data-sharp-root]")) return false;
          return node.matches(mutationScanSelector) || Boolean(node.querySelector(mutationScanSelector));
        }
        return node.parentElement?.matches(mutationScanSelector) ?? false;
      });
    };

    const scheduleClientDiscovery = () => {
      if (contentInvalidated || pageSuspended || discoveryTimer !== undefined) return;
      if (snapshot?.clients.some((client) => client.connected && client.authenticated)) return;
      discoveryTimer = window.setTimeout(async () => {
        discoveryTimer = undefined;
        const response = await request({ type: "sharp:refresh" });
        if (response.ok && response.snapshot) {
          snapshot = response.snapshot;
          scheduleScan();
        }
        scheduleClientDiscovery();
      }, 4_000);
    };

    void request({ type: "sharp:get-state" }).then((response) => {
      if (response.ok && response.snapshot) {
        snapshot = response.snapshot;
        connectedClientIds = new Set(
          response.snapshot.clients
            .filter((client) => client.connected && client.authenticated)
            .map((client) => client.endpointId)
        );
        scan();
      }
      scheduleClientDiscovery();
    });
    browser.runtime.onMessage.addListener((message: {
      type?: string;
      snapshot?: ExtensionSnapshot;
      clientId?: string;
      positions?: SharpPosition[];
    }) => {
      if (message.type === "sharp:state-changed" && message.snapshot) {
        const nextConnectedClientIds = new Set(
          message.snapshot.clients
            .filter((client) => client.connected && client.authenticated)
            .map((client) => client.endpointId)
        );
        const clientReconnected = [...nextConnectedClientIds]
          .some((clientId) => !connectedClientIds.has(clientId));
        connectedClientIds = nextConnectedClientIds;
        if (clientReconnected) {
          lastPrewarmKey = "";
          activePrewarm = undefined;
          prewarmReadyClientIds.clear();
          resolvedPageAddress = undefined;
          prewarmStatus = "idle";
          prewarmError = "";
        }
        snapshot = message.snapshot;
        scheduleScan();
        scheduleClientDiscovery();
      } else if (
        message.type === "sharp:positions-changed"
        && message.clientId
        && message.positions
      ) {
        automationPanel.updatePositions(message.clientId, message.positions);
      }
    });
    observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationCanChangeTradeSurfaces)) scheduleScan();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-chain",
        "data-address",
        "data-token-address",
        "data-contract-address",
        "data-mint",
        "data-clipboard-text",
        "data-copy",
        "href"
      ]
    });
    ctx.addEventListener(document, "click", scheduleScan, true);
    ctx.addEventListener(window, "popstate", scheduleScan);
    ctx.addEventListener(window, "hashchange", scheduleScan);
    locationWatcher = watchLocationChanges(scheduleScan);
    ctx.addEventListener(window, "pagehide", () => {
      pageSuspended = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (discoveryTimer !== undefined) window.clearTimeout(discoveryTimer);
      if (prewarmHeartbeatTimer !== undefined) window.clearInterval(prewarmHeartbeatTimer);
      reconnectTimer = undefined;
      discoveryTimer = undefined;
      prewarmHeartbeatTimer = undefined;
      locationWatcher?.stop();
      locationWatcher = undefined;
      try {
        prewarmPort?.disconnect();
      } catch {}
      prewarmPort = undefined;
    });
    ctx.addEventListener(window, "pageshow", () => {
      if (contentInvalidated) return;
      pageSuspended = false;
      connectPrewarmPort();
      locationWatcher ??= watchLocationChanges(scheduleScan);
      locationWatcher.check();
      scheduleScan();
      scheduleClientDiscovery();
    });
    ctx.onInvalidated(shutdownContent);
  }
});

const injectedStyles = `
  :host {
    all: initial;
    position: fixed;
    z-index: 2147483647;
    width: var(--sharp-menu-width, 270px);
    font-family: var(--sharp-site-font, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: var(--sharp-site-font-size, 13px);
    font-weight: var(--sharp-site-font-weight, 400);
    font-feature-settings: normal;
  }
  * { box-sizing: border-box; }
  button { font: inherit; }
  .sharp-menu { width: 100%; border: 1px solid rgba(59,130,246,.32); border-radius: 8px; padding: 12px; background: #0a1019; color: #f8fafc; box-shadow: 0 16px 44px rgba(0,0,0,.56); }
  .sharp-menu-head strong, .sharp-menu-head span { display: block; }
  .sharp-menu-head strong { color: #f8fafc; font-size: 1em; font-weight: 650; }
  .sharp-menu-head span { color: #94a3b8; font-size: .78em; margin-top: 4px; text-transform: capitalize; }
  .sharp-clients { display: flex; flex-wrap: wrap; gap: 4px; margin: 9px 0; }
  .sharp-clients span { padding: 3px 6px; border-radius: 4px; background: #0f172a; color: #94a3b8; font-size: .72em; }
  .sharp-clients .real { color: #f87171; background: rgba(239,68,68,.1); }
  .sharp-clients .paper { color: #60a5fa; background: rgba(59,130,246,.15); }
  .sharp-choices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
  .sharp-choices button { min-height: 32px; border: 1px solid rgba(148,163,184,.2); border-radius: 5px; padding: 6px 4px; background: #0f172a; color: #f1f5f9; font-size: .86em; font-weight: 550; cursor: pointer; }
  .sharp-choices button:hover { border-color: rgba(59,130,246,.55); background: rgba(59,130,246,.15); color: #60a5fa; }
  .sharp-choices button:disabled { opacity: .5; cursor: wait; }
  .sharp-status { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; color: #94a3b8; font-size: .76em; line-height: 1.4; }
  .sharp-status .accepted { color: #10b981; }
  .sharp-status .failed, .sharp-status .timed_out { color: #f87171; }
`;
