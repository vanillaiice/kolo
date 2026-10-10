import type { Database } from "@kolo/core/data/database/driver";
import { migrate } from "@kolo/core/data/database/migrations";
import { lockWorkspace } from "@kolo/core/identity/workspace";
import type { WorkspacePorts } from "@kolo/core/identity/types";
import type { SnapshotPort } from "@kolo/core/backup/types";
import { restoreWorkspace, type BackupPreview } from "@kolo/core/application/backup";
import type { SlotControl } from "../database/open-on-device.ts";

/**
 * Replaces this phone's shop with a checked backup of any shop. The restore runs into an empty
 * stage bound to the current slot, so the durable pointer moves only when it succeeds; on failure
 * the current shop is untouched. The previous shop's file and credentials stay on the device.
 */
export async function replaceShop(preview: BackupPreview, request: { readonly deviceLabel: string; readonly platform: "ANDROID" | "IOS"; readonly secret: string },
  ports: WorkspacePorts, files: SnapshotPort, slots: SlotControl): Promise<Database> {
  lockWorkspace(ports.database);
  const empty = await files.empty();
  try {
    migrate(empty.database); slots.alias(empty.database, ports.database);
    const result = await restoreWorkspace(preview, { confirmedBusinessId: preview.businessId, ...request }, { ...ports, database: empty.database });
    return result.database;
  } finally { await empty.discard(); }
}
