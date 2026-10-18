import * as Print from "expo-print";
import { Directory } from "expo-file-system";
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

/**
 * Writes a text export (a `.csv`) into a folder the member picks, as UTF-8. Returns false when the picker is closed;
 * Android names a second file with the same name itself, so nothing already saved is replaced.
 */
export async function saveTextFile(filename: string, mimeType: string, text: string): Promise<boolean> {
  let directory: Directory;
  try { directory = await Directory.pickDirectoryAsync(); } catch { return false; }
  directory.createFile(filename, mimeType).write(text);
  return true;
}
