import { z } from "zod";
import { chains, type SiteId } from "./protocol";

const siteIds = ["axiom", "padre", "gmgn", "basedbot", "pumpfun", "fomo", "dexscreener"] as const;
const publicKeySpkiBase64 = "MCowBQYDK2VwAyEAWvsl/SDcuJsEyapHuUc8bJYjjIXF4AqXRgWiAkI/Jn0=";
const compatibilityUrl = "https://webui.yvesdev.com/extension/compatibility/v1.json";

const documentSchema = z.object({
  version: z.literal(1),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  disabled_sites: z.array(z.enum(siteIds)).max(siteIds.length),
  chains: z.array(z.enum(chains)).optional()
}).strict();

const envelopeSchema = z.object({
  payload: z.string().max(16_384),
  signature: z.string().max(512)
}).strict();

function bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function fetchCompatibility(): Promise<{
  disabledSites: SiteId[];
  expiresAt: string;
}> {
  const response = await fetch(compatibilityUrl, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error"
  });
  if (!response.ok) throw new Error(`Compatibility service returned ${response.status}`);
  const envelope = envelopeSchema.parse(await response.json());
  const key = await crypto.subtle.importKey(
    "spki",
    bytes(publicKeySpkiBase64),
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    bytes(envelope.signature),
    new TextEncoder().encode(envelope.payload)
  );
  if (!valid) throw new Error("Compatibility signature is invalid");
  const document = documentSchema.parse(JSON.parse(envelope.payload));
  const now = Date.now();
  const issuedAt = Date.parse(document.issued_at);
  const expiresAt = Date.parse(document.expires_at);
  if (issuedAt > now + 5 * 60_000 || expiresAt <= now || expiresAt - issuedAt > 370 * 24 * 60 * 60_000) {
    throw new Error("Compatibility document is outside its validity window");
  }
  return { disabledSites: document.disabled_sites, expiresAt: document.expires_at };
}
