import type { SharpPosition } from "./protocol";

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function positionId(position: SharpPosition): string | undefined {
  const record = position as Record<string, unknown>;
  return stringValue(position.token_udid)
    ?? stringValue(position.tokenUDID)
    ?? stringValue(position.id)
    ?? stringValue(record.uuid)
    ?? stringValue(record.token_uuid);
}

function positionAssetAddresses(position: SharpPosition): string[] {
  const record = position as Record<string, unknown>;
  return [
    position.tokenID,
    record.token_id,
    position.address,
    position.mint,
    position.contractAddress,
    record.contract_address,
    record.contract,
    position.identifier
  ].flatMap((value) => stringValue(value) ?? []);
}

export function positionMatchesAsset(position: SharpPosition, address: string): boolean {
  const target = address.trim().toLowerCase();
  return Boolean(target) && positionAssetAddresses(position)
    .some((candidate) => candidate.toLowerCase() === target);
}

export function positionExecutionWallet(position: SharpPosition): string | undefined {
  const record = position as Record<string, unknown>;
  const additional = (position.additionalData ?? record.additional_data ?? {}) as Record<string, unknown>;
  return stringValue(additional.execution_wallet_address)
    ?? stringValue(additional.executionWalletAddress)
    ?? stringValue(record.execution_wallet_address)
    ?? stringValue(record.executionWalletAddress)
    ?? stringValue(additional.execution_wallet)
    ?? stringValue(additional.executionWallet)
    ?? stringValue(record.execution_wallet)
    ?? stringValue(record.executionWallet);
}
