import type { ManagedWalletSummary, TradeAction, WalletExecutionPlan } from "./protocol";

function secureUnitRandom(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]! / 0xffff_ffff;
}

export function materializeWalletPlan(
  plan: WalletExecutionPlan,
  action: TradeAction,
  random: () => number = secureUnitRandom
): WalletExecutionPlan {
  const randomizationBps = Number(plan.randomizationBps ?? 0);
  if (action !== "buy" || plan.allocations.length < 2 || randomizationBps <= 0) return plan;
  const span = Math.min(randomizationBps, 5_000) / 10_000;
  const targetTotal = plan.allocations.reduce((sum, allocation) => sum + allocation.weight, 0);
  const varied = plan.allocations.map((allocation) => {
    const offset = (Math.min(1, Math.max(0, random())) * 2 - 1) * span;
    return { ...allocation, weight: allocation.weight * (1 + offset) };
  });
  const variedTotal = varied.reduce((sum, allocation) => sum + allocation.weight, 0);
  const scale = targetTotal > 0 && variedTotal > 0 ? targetTotal / variedTotal : 1;
  return {
    ...plan,
    allocations: varied.map((allocation) => ({
      ...allocation,
      weight: allocation.weight * scale
    }))
  };
}

export interface MaterializedWalletRoute {
  amount: number;
  plan: WalletExecutionPlan;
}

export function reconcileWalletPlan(
  plan: WalletExecutionPlan,
  wallets: ManagedWalletSummary[]
): WalletExecutionPlan | undefined {
  const knownWallets = new Map(wallets.map((wallet) => [wallet.name, wallet]));
  const allocations = plan.allocations.flatMap((allocation) => {
    const wallet = knownWallets.get(allocation.walletName);
    if (!wallet) return [];
    if (allocation.walletAddress
      && allocation.walletAddress.toLowerCase() !== wallet.address.toLowerCase()) return [];
    return [{ ...allocation, walletAddress: wallet.address }];
  });
  if (!allocations.length) return undefined;
  if (allocations.length === plan.allocations.length) {
    return { ...plan, allocations };
  }

  const { groupId: _staleGroupId, ...safePlan } = plan;
  return {
    ...safePlan,
    allocations: allocations.map((allocation) => ({
      ...allocation,
      ...(allocations.length === 1 ? { weight: 1 } : {})
    }))
  };
}

export function rebalanceWalletRoute(
  plan: WalletExecutionPlan,
  action: TradeAction,
  amount: number,
  wallets: ManagedWalletSummary[]
): MaterializedWalletRoute {
  if (action !== "buy" || !plan.autoRebalance || plan.allocations.length < 2 || amount <= 0) {
    return { amount, plan };
  }

  const balances = new Map(wallets.map((wallet) => [wallet.name, wallet.balance]));
  const missing = plan.allocations.find((allocation) => {
    const balance = balances.get(allocation.walletName);
    return balance === undefined || !Number.isFinite(balance) || balance < 0;
  });
  if (missing) {
    throw new Error(`Balance unavailable for ${missing.walletName}. Refresh wallets or update the selected Sharp client.`);
  }

  const totalWeight = plan.allocations.reduce((sum, allocation) => sum + allocation.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return { amount, plan };

  const capacities = plan.allocations.map((allocation) => balances.get(allocation.walletName) ?? 0);
  const allocations = plan.allocations.map((allocation, index) =>
    Math.min(amount * (allocation.weight / totalWeight), capacities[index]!)
  );
  let remaining = Math.max(0, amount - allocations.reduce((sum, value) => sum + value, 0));

  for (let pass = 0; pass < plan.allocations.length && remaining > 1e-9; pass += 1) {
    const eligible = plan.allocations
      .map((allocation, index) => ({ index, weight: allocation.weight, room: capacities[index]! - allocations[index]! }))
      .filter((entry) => entry.room > 1e-9);
    const eligibleWeight = eligible.reduce((sum, entry) => sum + entry.weight, 0);
    if (!eligible.length || eligibleWeight <= 0) break;
    let distributed = 0;
    for (const entry of eligible) {
      const addition = Math.min(entry.room, remaining * (entry.weight / eligibleWeight));
      allocations[entry.index]! += addition;
      distributed += addition;
    }
    if (distributed <= 1e-9) break;
    remaining = Math.max(0, remaining - distributed);
  }

  const fundedAmount = allocations.reduce((sum, value) => sum + value, 0);
  if (fundedAmount <= 1e-9) throw new Error("The selected wallets do not have enough balance for this buy.");
  return {
    amount: fundedAmount,
    plan: {
      ...plan,
      allocations: plan.allocations.map((allocation, index) => ({
        ...allocation,
        weight: allocations[index]!
      }))
    }
  };
}
