import type { SharpPosition } from "./protocol";

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export interface PositionMetrics {
  bought: number;
  sold: number;
  fees: number;
  holding: number | undefined;
  pnl: number | undefined;
  pnlPercent: number | undefined;
}

interface PositionMetricAccumulator {
  bought: number;
  sold: number;
  fees: number;
  holding: number;
  hasHolding: boolean;
}

function nativePositionMetrics(position: SharpPosition | undefined): PositionMetrics {
  const remainingBasis = finiteNumber(position?.initialSwapAmount) ?? 0;
  const bought = finiteNumber(position?.lifetimeSwapAmount) ?? remainingBasis;
  const sold = finiteNumber(position?.currentSold) ?? 0;
  const fees = finiteNumber(position?.totalFees) ?? 0;
  const holdings = finiteNumber(position?.realCurrentHoldings) ?? 0;
  const price = finiteNumber(position?.price);
  const holding = price === undefined ? undefined : holdings * price;
  const pnl = holding === undefined ? undefined : holding + sold - bought;
  return {
    bought,
    sold,
    fees,
    holding,
    pnl,
    pnlPercent: pnl === undefined || bought <= 0 ? undefined : (pnl / bought) * 100
  };
}

export function aggregatePositionMetrics(positions: SharpPosition[]): PositionMetrics {
  const totals = positions.reduce<PositionMetricAccumulator>(
    (aggregate, position) => {
      const metrics = nativePositionMetrics(position);
      aggregate.bought += metrics.bought;
      aggregate.sold += metrics.sold;
      aggregate.fees += metrics.fees;
      if (metrics.holding !== undefined) {
        aggregate.holding += metrics.holding;
        aggregate.hasHolding = true;
      }
      return aggregate;
    },
    { bought: 0, sold: 0, fees: 0, holding: 0, hasHolding: false }
  );
  const holding = totals.hasHolding ? totals.holding : undefined;
  const pnl = holding === undefined
    ? undefined
    : holding + totals.sold - totals.bought;
  return {
    bought: totals.bought,
    sold: totals.sold,
    fees: totals.fees,
    holding,
    pnl,
    pnlPercent: pnl === undefined || totals.bought <= 0 ? undefined : (pnl / totals.bought) * 100
  };
}
