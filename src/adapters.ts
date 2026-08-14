import type {
  ExtensionSnapshot,
  SharpChain,
  SiteId,
  TradeAction,
  TradeCommand,
  TradeContext
} from "./protocol";
import { routableTradeClients } from "./protocol";

interface SiteDefinition {
  id: SiteId;
  hosts: string[];
  fixedChain?: SharpChain;
  addressAttributes: string[];
}

export interface TradeSurface {
  nativeButton: HTMLElement;
  context: TradeContext;
  action: TradeAction;
  amount?: TradeCommand["amount"];
}

const siteDefinitions: SiteDefinition[] = [
  { id: "axiom", hosts: ["axiom.trade"], addressAttributes: ["data-token-address", "data-mint", "data-address"] },
  { id: "padre", hosts: ["trade.padre.gg"], addressAttributes: ["data-token-address", "data-mint", "data-contract-address"] },
  { id: "gmgn", hosts: ["gmgn.ai"], addressAttributes: ["data-address", "data-token-address", "data-contract"] },
  { id: "basedbot", hosts: ["trade.basedbot.app"], fixedChain: "base", addressAttributes: ["data-token", "data-address", "data-contract-address"] },
  { id: "basedbot", hosts: ["basedbot.app"], addressAttributes: ["data-token", "data-address", "data-contract-address"] },
  { id: "pumpfun", hosts: ["pump.fun", "www.pump.fun"], fixedChain: "solana", addressAttributes: ["data-mint", "data-token-address"] },
  { id: "fomo", hosts: ["fomo.family"], addressAttributes: ["data-token-address", "data-address", "data-contract-address"] },
  { id: "dexscreener", hosts: ["dexscreener.com", "www.dexscreener.com"], addressAttributes: ["data-token-address", "data-address"] }
];

const chainAliases: Record<string, SharpChain> = {
  sol: "solana",
  solana: "solana",
  bsc: "bsc",
  bnb: "bsc",
  base: "base",
  rhc: "robinhood",
  robinhood: "robinhood"
};

const solanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const evmAddress = /^0x[a-fA-F0-9]{40}$/;
type InstantTradeQuote =
  | "SOL" | "USDC" | "USDT" | "USD1" | "USDG" | "VIRTUAL" | "uSOL"
  | "ETH" | "WETH" | "BNB";

let axiomEvmAddressCache:
  | { href: string; routeAddress?: string; address: string; source: Element }
  | undefined;
let lastAxiomEvmAddressScan = 0;
let lastAxiomEvmAddressScanHref = "";
let axiomSolanaAddressCache:
  | { href: string; routeAddress?: string; address: string; source: Element }
  | undefined;
let axiomInstantTradePanelCache:
  | { href: string; panels: Element[] }
  | undefined;
const interactiveControlSelector =
  "button, [role='button'], [tabindex]:not(input), [class*='cursor-pointer']";
const localizedBuyTerm = "(?:buy|kaufen|kopen|beli|al|acheter|comprar|compra|acquista|köp|kjøp|kup|купить|매수)";
const localizedSellTerm = "(?:sell|verkaufen|verkopen|jual|sat|vendre|vender|vende|vendi|sälj|selg|sprzedaj|продать|매도)";
const localizedQuickPrefix = "(?:(?:quick|schnell|snel|rapide|rápid[oa]|rápido)\\s*)?";
const localizedBuyStart = new RegExp(`^${localizedQuickPrefix}${localizedBuyTerm}\\b`, "iu");
const localizedSellStart = new RegExp(`^${localizedQuickPrefix}${localizedSellTerm}\\b`, "iu");
const localizedBuyAnywhere = new RegExp(`\\b${localizedBuyTerm}\\b`, "iu");
const localizedSellAnywhere = new RegExp(`\\b${localizedSellTerm}\\b`, "iu");

function isPrimaryInteractiveControl(element: HTMLElement): boolean {
  let parent = element.parentElement;
  for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
    if (normalizedLabel(parent) !== normalizedLabel(element)) break;
    if (parent.matches(interactiveControlSelector)) return false;
  }
  return true;
}

type InteractiveControlCache = Map<ParentNode, HTMLElement[]>;

function interactiveControls(
  container: ParentNode,
  cache?: InteractiveControlCache
): HTMLElement[] {
  const cached = cache?.get(container);
  if (cached) return cached;
  const controls = [...container.querySelectorAll<HTMLElement>(interactiveControlSelector)]
    .filter(isPrimaryInteractiveControl);
  cache?.set(container, controls);
  return controls;
}

function currentSite(): SiteDefinition | undefined {
  return siteDefinitions.find((site) => site.hosts.includes(location.hostname));
}

export function currentPageTradeContext(): TradeContext | undefined {
  const site = currentSite();
  if (!site) return undefined;
  const chain = findChain(site, document.documentElement);
  if (!chain) return undefined;
  const address = tradeAddressCandidate(site, chain, document.documentElement);
  if (!address) return undefined;
  // Axiom pages can contain thousands of live wallet-tracker rows. Searching the
  // entire document for a creator on every state refresh blocks its main thread;
  // Sharp's prewarm response resolves the creator for Axiom instead.
  const creator = chain === "solana" && site.id !== "axiom"
    ? creatorCandidate(site, document.documentElement)
    : undefined;
  const marketHint = marketHintCandidate(site, chain, document.documentElement);
  return {
    site: site.id,
    surface: "detail",
    chain,
    address,
    ...(creator ? { creator } : {}),
    addressKind: tradeAddressKind(site, chain, address),
    marketHint
  };
}

function marketHintCandidate(
  site: SiteDefinition,
  chain: SharpChain,
  root: ParentNode
): string {
  if (site.id !== "axiom" || chain !== "robinhood") return "custom";
  const markets = new Map<string, string>([
    ["flap", "flap"],
    ["flap pve", "flap_pve"],
    ["flap stocks", "flap_stocks"],
    ["uniswap v3", "uniswap-v3"],
    ["uniswap v4", "uniswap-v4"]
  ]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let inspected = 0;
  while (walker.nextNode() && inspected < 2_000) {
    inspected += 1;
    const text = walker.currentNode.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const match = text.match(
      /\b(?:USD|ETH|WETH)\s+on\s+(Flap(?:\s+(?:PVE|Stocks))?|Uniswap\s+V[34])\b/i
    );
    if (!match) continue;
    const market = markets.get(match[1]!.toLowerCase());
    if (market) return market;
  }
  return "custom";
}

function creatorCandidate(site: SiteDefinition, root: ParentNode): string | undefined {
  const attributeCandidates = [
    "data-creator",
    "data-creator-wallet",
    "data-dev",
    "data-dev-wallet",
    "data-deployer"
  ];
  for (const attribute of attributeCandidates) {
    const element = root.querySelector<HTMLElement>(`[${attribute}]`);
    const value = element?.getAttribute(attribute)?.trim();
    if (value && solanaAddress.test(value)) return value;
  }
  if (site.id !== "axiom") return undefined;
  const scored: Array<{ address: string; score: number }> = [];
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    const addresses = [
      ...url.pathname.split("/"),
      url.searchParams.get("address"),
      url.searchParams.get("wallet"),
      url.searchParams.get("account")
    ].filter((value): value is string => Boolean(value && solanaAddress.test(value)));
    if (addresses.length === 0) continue;
    let context = link.textContent ?? "";
    let parent = link.parentElement;
    for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
      if (parent === document.body || parent === document.documentElement) break;
      context += ` ${parent.textContent ?? ""}`;
    }
    const normalized = context.toLowerCase();
    const score = ["dev", "developer", "creator", "deployer"]
      .some((label) => normalized.includes(label)) ? 2 : 0;
    if (score > 0) {
      for (const address of addresses) scored.push({ address, score });
    }
  }
  const routeAddress = canonicalRouteAddress(site, new URL(location.href));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const labelledRows: Element[] = [];
  while (walker.nextNode() && labelledRows.length < 12) {
    const text = walker.currentNode.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (/^(?:DA|Dev(?:eloper)?|Creator|Deployer)(?:\s+(?:address|wallet))?\s*:?\s*$/i.test(text)) {
      const parent = walker.currentNode.parentElement;
      if (parent) labelledRows.push(parent);
    }
  }
  for (const label of labelledRows) {
    let container: Element | null = label;
    for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
      const direct = [
        container.textContent,
        ...container.getAttributeNames().map((attribute) => container!.getAttribute(attribute)),
        ...[...container.querySelectorAll<HTMLElement>("a[href], [data-address], [data-wallet], [title], [aria-label]")]
          .flatMap((element) => [
            element.textContent,
            ...element.getAttributeNames().map((attribute) => element.getAttribute(attribute))
          ])
      ]
        .filter((value): value is string => typeof value === "string")
        .flatMap((value) => value.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [])
        .find((address) => solanaAddress.test(address) && address !== routeAddress);
      if (direct) return direct;
      const react = reactCreatorAddress(container, routeAddress);
      if (react) return react;
    }
  }
  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.address;
}

function reactCreatorAddress(element: Element, routeAddress?: string): string | undefined {
  const roots: unknown[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactProps$")) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor && "value" in descriptor) roots.push(descriptor.value);
      }
    }
  }
  const seen = new WeakSet<object>();
  const queue = roots.map((value) => ({ value, path: "", depth: 0 }));
  let inspected = 0;
  while (queue.length > 0 && inspected < 2_500) {
    const item = queue.shift()!;
    if (!item.value || typeof item.value !== "object") continue;
    if (item.value instanceof Node || seen.has(item.value)) continue;
    seen.add(item.value);
    inspected += 1;
    for (const key of Object.getOwnPropertyNames(item.value)) {
      if (key === "child" || key === "sibling" || key === "stateNode") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const value = descriptor.value;
      const path = `${item.path}.${key}`.toLowerCase();
      const addresses = typeof value === "string"
        ? value.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? []
        : [];
      if (
        /(?:creator|developer|deployer|dev)(?:_|-)?(?:address|wallet)?$/.test(key.toLowerCase())
        || /(?:creator|developer|deployer|dev).*(?:address|wallet)/.test(path)
      ) {
        const address = addresses.find((candidate) =>
          solanaAddress.test(candidate) && candidate !== routeAddress
        );
        if (address) return address;
      }
      if (key === "return") {
        if (item.depth < 12 && value && typeof value === "object") {
          queue.push({ value, path, depth: item.depth + 1 });
        }
        continue;
      }
      if (item.depth < 8 && value && typeof value === "object") {
        queue.push({ value, path, depth: item.depth + 1 });
      }
    }
  }
  return undefined;
}

function findChain(site: SiteDefinition, node: Element): SharpChain | undefined {
  if (site.fixedChain) return site.fixedChain;
  const url = new URL(location.href);
  const candidates = [
    url.searchParams.get("chain"),
    url.searchParams.get("network"),
    node.closest("[data-chain]")?.getAttribute("data-chain"),
    document.documentElement.getAttribute("data-chain"),
    ...url.pathname.toLowerCase().split("/")
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const chain = chainAliases[candidate.toLowerCase()];
    if (chain) return chain;
  }
  return undefined;
}

function validAddress(chain: SharpChain, value: string): boolean {
  return chain === "solana" ? solanaAddress.test(value) : evmAddress.test(value);
}

function tradeAddressKind(
  site: SiteDefinition,
  chain: SharpChain,
  address?: string
): NonNullable<TradeContext["addressKind"]> {
  if (site.id === "axiom" && chain === "solana" && address) {
    const routeAddress = canonicalRouteAddress(site, new URL(location.href));
    if (routeAddress && address !== routeAddress) return "token";
  }
  return chain === "solana" && (site.id === "axiom" || site.id === "padre")
    ? "pool"
    : "token";
}

function canonicalRouteAddress(site: SiteDefinition, url: URL): string | undefined {
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment).trim();
      } catch {
        return segment.trim();
      }
    });
  if (site.id === "axiom") {
    const memeIndex = segments.findIndex((segment) => segment.toLowerCase() === "meme");
    return memeIndex >= 0 ? segments[memeIndex + 1] : undefined;
  }
  if (site.id === "gmgn") {
    const tokenIndex = segments.findIndex((segment) => segment.toLowerCase() === "token");
    return tokenIndex >= 0 ? segments[tokenIndex + 1] : undefined;
  }
  if (site.id === "padre") {
    const tradeIndex = segments.findIndex((segment) => segment.toLowerCase() === "trade");
    const routeChain = tradeIndex >= 0 ? segments[tradeIndex + 1]?.toLowerCase() : undefined;
    const marketOrToken = tradeIndex >= 0 ? segments[tradeIndex + 2] : undefined;
    if (routeChain !== "solana" && marketOrToken) {
      const parts = marketOrToken.split("_");
      if (parts.length === 3 && evmAddress.test(parts[1]!) && evmAddress.test(parts[2]!)) {
        return parts[2];
      }
    }
    return marketOrToken;
  }
  if (site.id === "basedbot") {
    const tokenIndex = segments.findIndex((segment) => segment.toLowerCase() === "token");
    return tokenIndex >= 0 ? segments[tokenIndex + 2] : undefined;
  }
  if (site.id === "fomo") {
    const tokenIndex = segments.findIndex((segment) => segment.toLowerCase() === "tokens");
    return tokenIndex >= 0 ? segments[tokenIndex + 2] : undefined;
  }
  if (site.id === "dexscreener") {
    return segments.length >= 2 && chainAliases[segments[0]!.toLowerCase()]
      ? segments[1]
      : undefined;
  }
  return undefined;
}

function addressCandidates(site: SiteDefinition, node: Element): string[] {
  const values: string[] = [];
  const url = new URL(location.href);
  const routeAddress = canonicalRouteAddress(site, url);
  if (routeAddress) values.push(routeAddress);
  for (const key of ["address", "token", "mint", "contract", "ca"]) {
    const value = url.searchParams.get(key);
    if (value) values.push(value);
  }
  values.push(...url.pathname.split("/"));
  let current: Element | null = node;
  for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
    for (const attribute of site.addressAttributes) {
      const value = current.getAttribute(attribute);
      if (value) values.push(value);
    }
    const links = [
      ...(current.matches("a[href]") ? [current as HTMLAnchorElement] : []),
      ...current.querySelectorAll<HTMLAnchorElement>(":scope > a[href]")
    ];
    for (const link of links) {
      try {
        const href = new URL(link.href);
        values.push(...href.pathname.split("/"));
        for (const key of ["address", "token", "mint", "contract", "ca"]) {
          const value = href.searchParams.get(key);
          if (value) values.push(value);
        }
      } catch {}
    }
  }
  return [...new Set(values.map((value) => {
    try {
      return decodeURIComponent(value).trim();
    } catch {
      return value.trim();
    }
  }))];
}

function evmAddresses(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.match(/0x[a-fA-F0-9]{40}/g) ?? [];
}

function elementAddressCandidates(element: Element): string[] {
  const values = [
    element.textContent,
    ...element.getAttributeNames().map((attribute) => element.getAttribute(attribute))
  ];
  if (element instanceof HTMLAnchorElement) values.push(element.href);
  if (element instanceof HTMLInputElement) values.push(element.value);
  return values.flatMap(evmAddresses);
}

function solanaAddresses(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
}

function elementSolanaAddressCandidates(element: Element): string[] {
  const values = [
    element.textContent,
    ...element.getAttributeNames().map((attribute) => element.getAttribute(attribute))
  ];
  if (element instanceof HTMLAnchorElement) values.push(element.href);
  if (element instanceof HTMLInputElement) values.push(element.value);
  return values.flatMap(solanaAddresses);
}

function reactSolanaTokenAddress(element: Element, routeAddress?: string): string | undefined {
  const roots: unknown[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactProps$")) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor && "value" in descriptor) roots.push(descriptor.value);
      }
    }
  }
  const seen = new WeakSet<object>();
  const queue = roots.map((value) => ({ value, path: "", depth: 0 }));
  let inspected = 0;
  while (queue.length > 0 && inspected < 2_500) {
    const item = queue.shift()!;
    if (!item.value || typeof item.value !== "object" || item.value instanceof Node) continue;
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    inspected += 1;
    for (const key of Object.getOwnPropertyNames(item.value)) {
      if (key === "child" || key === "sibling" || key === "stateNode") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const value = descriptor.value;
      const path = `${item.path}.${key}`.toLowerCase();
      if (key === "return") {
        if (item.depth < 12 && value && typeof value === "object") {
          queue.push({ value, path, depth: item.depth + 1 });
        }
        continue;
      }
      const tokenKey = /(?:token|mint)(?:_|-)?(?:address|id)?$/.test(key.toLowerCase())
        || /(?:base|token|asset)\.(?:address|mint|id)$/.test(path);
      if (tokenKey) {
        const match = solanaAddresses(value).find((address) => address !== routeAddress);
        if (match) return match;
      }
      if (item.depth < 8 && value && typeof value === "object") {
        queue.push({ value, path, depth: item.depth + 1 });
      }
    }
  }
  return undefined;
}

function axiomSolanaTokenCandidate(root: ParentNode, routeAddress?: string): string | undefined {
  if (
    axiomSolanaAddressCache?.href === location.href
    && axiomSolanaAddressCache.routeAddress === routeAddress
    && axiomSolanaAddressCache.source.isConnected
  ) {
    return axiomSolanaAddressCache.address;
  }
  const cache = (address: string, source: Element) => {
    axiomSolanaAddressCache = {
      href: location.href,
      ...(routeAddress ? { routeAddress } : {}),
      address,
      source
    };
    return address;
  };
  const explicit = root.querySelectorAll<Element>([
    "[data-token-address]",
    "[data-mint]",
    "[data-clipboard-text]",
    "[data-copy]",
    'a[href*="solscan.io/token/"]'
  ].join(","));
  const scored: Array<{ address: string; score: number; source: Element }> = [];
  for (const element of explicit) {
    const contexts = [normalizedLabel(element)];
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
      contexts.push(normalizedLabel(parent));
    }
    const localContexts = contexts.slice(0, 2).map((value) => value.toLowerCase());
    const tokenLabelled = localContexts.some((value) => (
      /\bca\b|contract address|token address|mint address/.test(value)
    ));
    const developerLabelled = localContexts.some((value) => (
      /\bda\b|\bdev\b|developer|deployer|creator/.test(value)
    ));
    const poolLabelled = localContexts.some((value) => /\bpair\b|\bpool\b/.test(value));
    let score = 0;
    if (element.matches("[data-token-address], [data-mint]")) score += 24;
    if (tokenLabelled) score += 20;
    if (developerLabelled && !tokenLabelled) score -= 24;
    if (poolLabelled && !tokenLabelled) score -= 12;
    for (const address of elementSolanaAddressCandidates(element)) {
      if (address === routeAddress) score -= 20;
      scored.push({ address, score, source: element });
    }
  }
  scored.sort((left, right) => right.score - left.score);
  const explicitToken = scored.find(({ address, score }) => score > 0 && address !== routeAddress);
  if (explicitToken) return cache(explicitToken.address, explicitToken.source);

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!/^(?:CA|Contract Address|Token Address|Mint Address)\s*:/i.test(text)) continue;
    const label = walker.currentNode.parentElement;
    if (!label) continue;
    let container: Element | null = label;
    for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
      const address = elementSolanaAddressCandidates(container)
        .find((candidate) => candidate !== routeAddress);
      if (address) return cache(address, label);
    }
    const address = reactSolanaTokenAddress(label, routeAddress);
    if (address) return cache(address, label);
  }
  return undefined;
}

function reactTokenAddress(element: Element, routeAddress?: string): string | undefined {
  const roots: unknown[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactProps$")) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor && "value" in descriptor) roots.push(descriptor.value);
      }
    }
  }
  const seen = new WeakSet<object>();
  const queue = roots.map((value) => ({ value, path: "", depth: 0 }));
  let inspected = 0;
  while (queue.length > 0 && inspected < 2_500) {
    const item = queue.shift()!;
    if (!item.value || typeof item.value !== "object") continue;
    if (item.value instanceof Node) continue;
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    inspected += 1;
    for (const key of Object.getOwnPropertyNames(item.value)) {
      if (key === "child" || key === "sibling" || key === "stateNode") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const value = descriptor.value;
      const path = `${item.path}.${key}`.toLowerCase();
      if (key === "return") {
        if (item.depth < 12 && value && typeof value === "object") {
          queue.push({ value, path, depth: item.depth + 1 });
        }
        continue;
      }
      const addresses = evmAddresses(value);
      const tokenKey = /(?:token|contract|mint)(?:_|-)?address$/.test(key.toLowerCase())
        || /(?:base|token|asset)\.(?:address|contract)$/.test(path);
      if (tokenKey) {
        const match = addresses.find((address) => address.toLowerCase() !== routeAddress?.toLowerCase());
        if (match) return match;
      }
      if (
        item.depth < 8
        && value
        && typeof value === "object"
        && !path.includes(".child")
        && !path.includes(".sibling")
      ) {
        queue.push({ value, path, depth: item.depth + 1 });
      }
    }
  }
  return undefined;
}

function axiomEvmTokenCandidate(root: ParentNode, routeAddress?: string): string | undefined {
  if (
    axiomEvmAddressCache
    && axiomEvmAddressCache.routeAddress === routeAddress
  ) {
    return axiomEvmAddressCache.address;
  }

  const cache = (address: string, source: Element) => {
    axiomEvmAddressCache = {
      href: location.href,
      ...(routeAddress ? { routeAddress } : {}),
      address,
      source
    };
    return address;
  };
  const routeLower = routeAddress?.toLowerCase();
  const explicit = root.querySelectorAll<Element>(
    [
      "[data-token-address]",
      "[data-contract-address]",
      "[data-mint]",
      "[data-address]",
      "[data-clipboard-text]",
      "[data-copy]",
      '[title*="0x"]',
      '[aria-label*="0x"]',
      'a[href*="0x"]'
    ].join(",")
  );
  const scored: Array<{
    address: string;
    score: number;
    source: Element;
    explicitlyTokenLabelled: boolean;
  }> = [];
  for (const element of explicit) {
    const nearestContext = `${normalizedLabel(element)} ${element.parentElement ? normalizedLabel(element.parentElement) : ""}`.toLowerCase();
    let context = normalizedLabel(element);
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
      context += ` ${normalizedLabel(parent)}`;
    }
    const normalized = context.toLowerCase();
    const explicitlyTokenLabelled = /\bca\b|contract address|token address/.test(normalized);
    let score = 0;
    if (element.matches("[data-token-address], [data-contract-address], [data-mint]")) score += 20;
    if (/\bca\b|contract address|token address/.test(nearestContext)) score += 20;
    if (/\bda\b|\bdev\b|developer|deployer|creator/.test(nearestContext)) score -= 20;
    if (/\bca\b|contract address|token address/.test(normalized)) score += 12;
    if (/\btoken\b|\bcontract\b/.test(normalized)) score += 4;
    if (/\bda\b|\bdev\b|developer|deployer|creator/.test(normalized)) score -= 12;
    if (/\bpair\b|\bpool\b/.test(normalized)) score -= 8;
    for (const address of elementAddressCandidates(element)) {
      if (address.toLowerCase() === routeLower) score -= 20;
      scored.push({ address, score, source: element, explicitlyTokenLabelled });
    }
  }
  scored.sort((left, right) => right.score - left.score);
  const explicitToken = scored.find(({ address, score, explicitlyTokenLabelled }) =>
    score > 0
    && (address.toLowerCase() !== routeLower || explicitlyTokenLabelled)
  );
  if (explicitToken) return cache(explicitToken.address, explicitToken.source);

  const now = Date.now();
  if (lastAxiomEvmAddressScanHref === location.href && now - lastAxiomEvmAddressScan < 750) {
    return undefined;
  }
  lastAxiomEvmAddressScan = now;
  lastAxiomEvmAddressScanHref = location.href;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const labels: Element[] = [];
  while (walker.nextNode() && labels.length < 12) {
    const text = walker.currentNode.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (/^(?:CA|Contract Address|Token Address)\s*:/i.test(text)) {
      const parent = walker.currentNode.parentElement;
      if (parent) labels.push(parent);
    }
  }
  for (const label of labels) {
    let container: Element | null = label;
    for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
      const candidates = elementAddressCandidates(container);
      const address = candidates.find((candidate) => candidate.toLowerCase() === routeLower)
        ?? candidates.find((candidate) => candidate.toLowerCase() !== routeLower);
      if (address) return cache(address, label);
    }
    // Axiom routes may contain a pair address, so the labelled tokenAddress is authoritative.
    const address = reactTokenAddress(label);
    if (address) return cache(address, label);
  }
  return undefined;
}

function tradeAddressCandidate(
  site: SiteDefinition,
  chain: SharpChain,
  node: Element
): string | undefined {
  const routeAddress = canonicalRouteAddress(site, new URL(location.href));
  if (site.id === "axiom" && chain === "solana") {
    return axiomSolanaTokenCandidate(document, routeAddress)
      ?? axiomSolanaTokenCandidate(node, routeAddress)
      ?? addressCandidates(site, node).find((candidate) => validAddress(chain, candidate));
  }
  if (site.id === "axiom" && chain !== "solana") {
    const detected = axiomEvmTokenCandidate(document, routeAddress)
      ?? axiomEvmTokenCandidate(node, routeAddress);
    if (detected) return detected;

    // Axiom may replace token metadata during hydration; the Robinhood route is a stable fallback.
    if (chain === "robinhood" && routeAddress && validAddress(chain, routeAddress)) {
      return routeAddress;
    }
    return undefined;
  }
  if (site.id === "dexscreener") {
    return dexScreenerTokenCandidate(document, chain, routeAddress)
      ?? dexScreenerTokenCandidate(node, chain, routeAddress);
  }
  return addressCandidates(site, node).find((candidate) => validAddress(chain, candidate));
}

function dexScreenerTokenCandidate(
  root: ParentNode,
  chain: SharpChain,
  pairAddress?: string
): string | undefined {
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const tokenIndex = segments.findIndex((segment) => segment.toLowerCase() === "token");
    if (tokenIndex < 0) continue;
    const candidate = segments[tokenIndex + 1];
    if (
      candidate
      && candidate !== pairAddress
      && validAddress(chain, candidate)
    ) return candidate;
  }
  return undefined;
}

function surfaceType(button: HTMLElement): TradeContext["surface"] {
  if (button.closest("table, [role='row'], [data-row], [data-card], article")) return "quick_list";
  return "detail";
}

function actionFor(button: HTMLElement): TradeAction | undefined {
  if (button.dataset.sharpAction === "buy" || button.dataset.sharpAction === "sell") {
    return button.dataset.sharpAction;
  }
  const label = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`.trim().toLowerCase();
  if (/\b(buy crypto|buy with|buy credits|buy subscription)\b/.test(label)) return undefined;
  if (/^sell\s*init\b/.test(label)) return undefined;
  if (localizedBuyStart.test(label) || /^(?:schnellkauf|购买|購買|买入|買入|購入)/u.test(label)) return "buy";
  if (localizedSellStart.test(label) || /^(?:schnellverkauf|卖出|賣出|売却)/u.test(label)) return "sell";
  return undefined;
}

function isPairedActionToggle(
  site: SiteDefinition,
  button: HTMLElement,
  controlCache?: InteractiveControlCache
): boolean {
  if (site.id === "dexscreener") return false;
  let container = button.parentElement;
  for (let depth = 0; container && depth < 2; depth += 1, container = container.parentElement) {
    const nearbyButtons = interactiveControls(container, controlCache)
      .filter((candidate) => candidate.parentElement === container || candidate.parentElement?.parentElement === container);
    if (nearbyButtons.length !== 2 || !nearbyButtons.includes(button)) continue;
    const actions = new Set(nearbyButtons.map(actionFor));
    if (actions.has("buy") && actions.has("sell")) return true;
  }
  return false;
}

function normalizedLabel(element: Element): string {
  return (element.textContent || "").replace(/\s+/g, " ").trim();
}

function hasPresetTabs(labels: Set<string>): boolean {
  return [
    ["P1", "P2", "P3"],
    ["PRESET 1", "PRESET 2", "PRESET 3"]
  ].some((tabs) => tabs.every((tab) => labels.has(tab)));
}

function instantTradePanel(
  button: HTMLElement,
  controlCache?: InteractiveControlCache
): Element | undefined {
  let container = button.parentElement;
  for (let depth = 0; container && depth < 16; depth += 1, container = container.parentElement) {
    if (container === document.body || container === document.documentElement) break;
    const buttons = interactiveControls(container, controlCache);
    const labels = new Set(buttons.map(normalizedLabel));
    const isInstantPanel = hasPresetTabs(labels)
      && (container.textContent || "").includes("Buy")
      && (container.textContent || "").includes("Sell");
    if (isInstantPanel) return container;
  }
  return undefined;
}

function instantTradePanels(controlCache?: InteractiveControlCache): Element[] {
  if (
    axiomInstantTradePanelCache?.href === location.href
    && axiomInstantTradePanelCache.panels.length > 0
    && axiomInstantTradePanelCache.panels.every((panel) => panel.isConnected)
  ) {
    return axiomInstantTradePanelCache.panels;
  }
  const panels = new Set<Element>();
  const presetTabs = document.querySelectorAll<HTMLElement>("button, [role='button']");
  for (const control of presetTabs) {
    if (!["P1", "PRESET 1"].includes(normalizedLabel(control))) continue;
    const panel = instantTradePanel(control, controlCache);
    if (panel) panels.add(panel);
  }
  const result = [...panels];
  if (result.length > 0) {
    axiomInstantTradePanelCache = { href: location.href, panels: result };
  }
  return result;
}

function quickPresetValue(
  control: HTMLElement,
  mode: "native" | "percentage"
): number | undefined {
  const mountedMode = control.dataset.sharpAmountMode;
  const mountedValue = Number(control.dataset.sharpAmountValue);
  if (mountedMode === mode && Number.isFinite(mountedValue) && mountedValue > 0) {
    return mountedValue;
  }
  const label = normalizedLabel(control);
  const number = "((?:0|[1-9]\\d*)(?:\\.\\d+)?)";
  const match = mode === "native"
    ? label.match(new RegExp(
        `^(?:${localizedQuickPrefix}${localizedBuyTerm}\\s+)?${number}\\s*(?:SOL|ETH|WETH|BNB)?(?:\\s+${localizedBuyTerm})?$`,
        "iu"
      ))
    : label.match(new RegExp(
        `^(?:${localizedQuickPrefix}${localizedSellTerm}\\s+)?${number}\\s*%$`,
        "iu"
      ));
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return mode === "percentage" && value > 100 ? undefined : value;
}

function quickTradePanel(button: HTMLElement): Element | undefined {
  let container = button.parentElement;
  for (let depth = 0; container && depth < 14; depth += 1, container = container.parentElement) {
    if (container === document.body || container === document.documentElement) break;
    const controls = interactiveControls(container);
    const native = controls.filter((control) => quickPresetValue(control, "native") !== undefined);
    const percentages = controls.filter(
      (control) => quickPresetValue(control, "percentage") !== undefined
    );
    const text = normalizedLabel(container);
    const localizedBuyPresets = native.filter((control) => {
      const label = normalizedLabel(control);
      return localizedBuyAnywhere.test(label) || /(?:购买|購買|买入|買入|購入)/u.test(label);
    });
    const localizedSellPresets = percentages.filter((control) => {
      const label = normalizedLabel(control);
      return localizedSellAnywhere.test(label) || /(?:卖出|賣出|売却)/u.test(label);
    });
    const labelledOneSidedRow = (/\b(?:quick\s*(?:buy|sell)|schnell(?:kauf|verkauf))\b/i.test(text)
      && (native.length >= 2 || percentages.length >= 2))
      || localizedBuyPresets.length >= 2
      || localizedSellPresets.length >= 2;
    const labelledTradePanel = /\b(?:instant|quick|one[ -]click)\s+trad(?:e|ing)\b/i.test(text)
      || /\bschnell(?:er|es)?\s+(?:handel|kauf|verkauf)\b/i.test(text)
      || ((localizedBuyAnywhere.test(text) || /(?:购买|購買|买入|買入|購入)/u.test(text))
        && (localizedSellAnywhere.test(text) || /(?:卖出|賣出|売却)/u.test(text)))
      || labelledOneSidedRow;
    const enoughPresets = native.length >= 2 && percentages.length >= 2;
    if (
      (native.includes(button) || percentages.includes(button))
      && labelledTradePanel
      && (enoughPresets || labelledOneSidedRow)
    ) return container;
  }
  return undefined;
}

function siteTradePanels(
  site: SiteDefinition,
  controlCache?: InteractiveControlCache
): Element[] {
  if (site.id === "axiom") return instantTradePanels(controlCache);
  const panels = new Set<Element>();
  for (const control of interactiveControls(document, controlCache)) {
    if (
      quickPresetValue(control, "native") === undefined
      && quickPresetValue(control, "percentage") === undefined
    ) continue;
    const panel = quickTradePanel(control);
    if (panel) panels.add(panel);
  }
  return [...panels];
}

function backgroundIsPainted(element: Element): boolean {
  const background = getComputedStyle(element).backgroundColor.trim().toLowerCase();
  if (!background || background === "transparent") return false;
  const rgba = background.match(/^rgba?\(([^)]+)\)$/);
  if (!rgba) return true;
  const components = rgba[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  return components.length < 4 || (Number.isFinite(components[3]) && components[3]! > 0.02);
}

function activeInstantTradeQuote(panel: Element): InstantTradeQuote | undefined {
  const quoteNames = [
    "SOL", "USDC", "USDT", "USD1", "USDG", "VIRTUAL", "uSOL", "ETH", "WETH", "BNB"
  ] as const;
  const descendants = [...panel.querySelectorAll<HTMLElement>("*")];
  const candidates = quoteNames.map((quote) => {
    const exact = descendants.filter((element) => normalizedLabel(element) === quote);
    const surfaces = new Set<HTMLElement>();
    for (const element of exact) {
      let current: HTMLElement | null = element;
      for (let depth = 0; current && depth < 3; depth += 1, current = current.parentElement) {
        if (normalizedLabel(current) !== quote) break;
        surfaces.add(current);
      }
    }
    return { quote, surfaces: [...surfaces] };
  });
  const explicitlyActive = candidates.filter(({ surfaces }) => surfaces.some((element) =>
    element.getAttribute("aria-selected") === "true"
    || element.getAttribute("aria-pressed") === "true"
    || element.getAttribute("data-state") === "active"
    || element.getAttribute("data-selected") === "true"
    || element.getAttribute("data-active") === "true"
  ));
  if (explicitlyActive.length === 1) return explicitlyActive[0]!.quote;
  const painted = candidates.filter(({ surfaces }) => surfaces.some(backgroundIsPainted));
  return painted.length === 1 ? painted[0]!.quote : undefined;
}

export function instantTradeQuoteFor(
  button: HTMLElement
): InstantTradeQuote | undefined {
  const panel = instantTradePanel(button) ?? quickTradePanel(button);
  return panel ? activeInstantTradeQuote(panel) : undefined;
}

function isInstantPresetRow(
  button: HTMLElement,
  mode: "native" | "percentage",
  controlCache?: InteractiveControlCache
): boolean {
  const matchesMode = (candidate: HTMLElement) => {
    if (candidate.dataset.sharpAmountMode) {
      return candidate.dataset.sharpAmountMode === mode;
    }
    const label = normalizedLabel(candidate);
    return mode === "native"
      ? /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(label)
      : /^\d+(?:\.\d+)?%$/.test(label);
  };
  let container = button.parentElement;
  for (let depth = 0; container && depth < 10; depth += 1, container = container.parentElement) {
    if (container === document.body || container === document.documentElement) break;
    const controls = interactiveControls(container, controlCache);
    const matching = controls.filter(matchesMode);
    const labels = new Set(controls.map(normalizedLabel));
    const containsPresetTabs = [
      "P1", "P2", "P3", "PRESET 1", "PRESET 2", "PRESET 3"
    ].some((label) => labels.has(label));
    if (
      matching.includes(button)
      && matching.length >= 3
      && matching.length <= 4
      && !containsPresetTabs
    ) {
      return true;
    }
  }
  return false;
}

function instantTradePreset(
  site: SiteDefinition,
  button: HTMLElement,
  knownPanel?: Element,
  controlCache?: InteractiveControlCache
): { action: TradeAction; amount: TradeCommand["amount"] } | undefined {
  if (site.id !== "axiom") return undefined;
  const panel = knownPanel ?? instantTradePanel(button, controlCache);
  if (!panel) return undefined;
  const mountedMode = button.dataset.sharpAmountMode;
  const mountedValue = Number(button.dataset.sharpAmountValue);
  if (
    (mountedMode === "native" || mountedMode === "percentage") &&
    Number.isFinite(mountedValue) &&
    mountedValue > 0
  ) {
    if (!isInstantPresetRow(button, mountedMode, controlCache)) return undefined;
    return {
      action: mountedMode === "native" ? "buy" : "sell",
      amount: { mode: mountedMode, value: mountedValue }
    };
  }
  const label = normalizedLabel(button);
  const buyValue = /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(label) ? Number(label) : undefined;
  const sellMatch = label.match(/^(\d+(?:\.\d+)?)%$/);
  if (sellMatch) {
    const percentage = Number(sellMatch[1]);
    return percentage > 0 && percentage <= 100 && isInstantPresetRow(button, "percentage", controlCache)
      ? { action: "sell", amount: { mode: "percentage", value: percentage } }
      : undefined;
  }
  if (
    buyValue === undefined
    || !Number.isFinite(buyValue)
    || buyValue <= 0
    || !isInstantPresetRow(button, "native", controlCache)
  ) return undefined;
  return { action: "buy", amount: { mode: "native", value: buyValue } };
}

function quickTradePreset(
  site: SiteDefinition,
  button: HTMLElement
): { action: TradeAction; amount: TradeCommand["amount"] } | undefined {
  if (site.id === "axiom" || !quickTradePanel(button)) return undefined;
  const percentage = quickPresetValue(button, "percentage");
  if (percentage !== undefined) {
    return { action: "sell", amount: { mode: "percentage", value: percentage } };
  }
  const native = quickPresetValue(button, "native");
  return native === undefined
    ? undefined
    : { action: "buy", amount: { mode: "native", value: native } };
}

function siteTradePreset(
  site: SiteDefinition,
  button: HTMLElement,
  knownPanel?: Element,
  controlCache?: InteractiveControlCache
): { action: TradeAction; amount: TradeCommand["amount"] } | undefined {
  return site.id === "axiom"
    ? instantTradePreset(site, button, knownPanel, controlCache)
    : quickTradePreset(site, button);
}

export function nativeAmountFor(
  button: HTMLElement,
  site: SiteDefinition | undefined = currentSite()
): number | undefined {
  if (site?.id === "fomo") return undefined;
  let container = button.parentElement;
  for (let depth = 0; container && depth < 8; depth += 1, container = container.parentElement) {
    const candidates = [...container.querySelectorAll<HTMLInputElement>("input")].filter((input) => {
      const type = input.type.toLowerCase();
      return !input.disabled && !["hidden", "checkbox", "radio", "range", "file"].includes(type);
    });
    const values = candidates.map((input) => {
      const descriptor = [
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute("aria-label"),
        input.getAttribute("data-testid"),
        input.parentElement?.textContent
      ].filter(Boolean).join(" ").toLowerCase();
      const normalized = input.value.trim().replace(/\s/g, "").replace(",", ".");
      const value = Number(normalized);
      return {
        value,
        score: /\b(amount|quantity|qty|size)\b/.test(descriptor) ? 1 : 0
      };
    }).filter(({ value }) => Number.isFinite(value) && value > 0);
    if (values.length > 0) {
      values.sort((left, right) => right.score - left.score);
      return values[0]?.value;
    }
  }
  return undefined;
}

export function scanTradeSurfaces(snapshot: ExtensionSnapshot): TradeSurface[] {
  const site = currentSite();
  if (
    !site
    || !snapshot.enabled
    || !snapshot.siteEnabled[site.id]
    || snapshot.compatibilityDisabledSites.includes(site.id)
  ) return [];
  const surfaces: TradeSurface[] = [];
  const controlCache: InteractiveControlCache = new Map();
  const panels = siteTradePanels(site, controlCache);
  const marketHints = new Map<SharpChain, string>();
  const buttons = new Set<HTMLElement>();
  const panelByControl = new Map<HTMLElement, Element>();
  if (site.id !== "axiom") {
    for (const button of document.querySelectorAll<HTMLElement>("button:not([data-sharp-control])")) {
      buttons.add(button);
    }
  }
  for (const panel of panels) {
    for (const control of interactiveControls(panel, controlCache)) {
      if (!control.hasAttribute("data-sharp-control")) {
        buttons.add(control);
        panelByControl.set(control, panel);
      }
    }
  }
  for (const button of buttons) {
    if (
      (button instanceof HTMLButtonElement && button.disabled)
      || button.getAttribute("aria-disabled") === "true"
      || !button.isConnected
      || button.closest("[data-sharp-root]")
    ) continue;
    const knownPanel = panelByControl.get(button);
    const instantPreset = knownPanel
      ? siteTradePreset(site, button, knownPanel, controlCache)
      : undefined;
    if (button.dataset.sharpAmountMode && !instantPreset) continue;
    const action = instantPreset?.action ?? actionFor(button);
    if (!action) continue;
    if (!instantPreset && isPairedActionToggle(site, button, controlCache)) continue;
    const chain = findChain(site, button);
    if (!chain) continue;
    let marketHint = marketHints.get(chain);
    if (!marketHint) {
      marketHint = marketHintCandidate(site, chain, document.documentElement);
      marketHints.set(chain, marketHint);
    }
    const selectedClientIds = snapshot.selectedClientIdsByChain[chain] ?? [];
    if (!routableTradeClients(snapshot.clients, selectedClientIds, chain, action).length) continue;
    const address = tradeAddressCandidate(site, chain, button);
    if (!address) continue;
    surfaces.push({
      nativeButton: button,
      action,
      ...(instantPreset ? { amount: instantPreset.amount } : {}),
      context: {
        site: site.id,
        surface: action === "sell" ? "position" : surfaceType(button),
        chain,
        address,
        addressKind: tradeAddressKind(site, chain, address),
        marketHint
      }
    });
  }
  return surfaces;
}
