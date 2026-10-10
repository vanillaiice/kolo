/** What a chosen transfer file is, recognized from its structure before any password or key work. */
export type TransferFileKind = "backup" | "enrollment" | "exchange" | "receipt" | "invite" | "request";

/** Recognizes a KOLO transfer file by its public header; anything else is `undefined` (an invalid file). */
export function transferFileKind(text: string): TransferFileKind | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  const record = (item: unknown): Record<string, unknown> | undefined => item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
  const root = record(value), header = record(root?.["header"]);
  if (header?.["format"] === "kolo.encrypted") {
    const purpose = header["purpose"];
    return purpose === "backup" || purpose === "enrollment" || purpose === "exchange" || purpose === "receipt" ? purpose : undefined;
  }
  if (record(root?.["invite"])?.["format"] === "kolo.pairing-invite") return "invite";
  if (record(root?.["request"])?.["format"] === "kolo.pairing-request") return "request";
  return undefined;
}
