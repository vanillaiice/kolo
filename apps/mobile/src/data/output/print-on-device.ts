import * as Print from "expo-print";
import { Share } from "react-native";

/**
 * Opens Android's print dialog for a document; any printer with a system print service works and
 * "Save as PDF" is always offered. Cancelling resolves normally: nothing about the sale changes.
 */
export async function printDocument(html: string): Promise<void> {
  await Print.printAsync({ html });
}

/** Opens the OS share sheet with plain text; a dismissed sheet is not an error. */
export async function shareText(message: string): Promise<void> {
  await Share.share({ message });
}
