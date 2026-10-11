/**
 * Short display form of an offline-unique sale number. Desktop numbers are `V-` plus the sale
 * UUID; mobile numbers are `V-YYYYMMDD-` plus the UUID's last twelve hex digits. Both end in
 * the sale ID's last eight hex digits, so a sale shows the same `V-XXXXXXXX` on every device.
 * Other numbers are returned unchanged; receipts and printouts keep the stored number whole.
 */
export function shortReceiptNumber(number: string): string {
  const match = /^V-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}|\d{8}-[0-9a-f]{4})([0-9a-f]{8})$/i.exec(number);
  return match === null ? number : `V-${match[1]!.toUpperCase()}`;
}
