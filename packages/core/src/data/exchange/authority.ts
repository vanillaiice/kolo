import type { Queryable } from "../database/driver.ts";
import type { JournalEnvelope } from "@kolo/contracts/events";
import { appendEvent, allocateOrigin } from "./journal.ts";
import { journalContext } from "./internal-context.ts";

/** @internal Public authority audit input; secret references/verifiers are never copied into events. */
export interface AuthorityFact { readonly eventId: string; readonly businessId: string; readonly userId: string; readonly deviceId: string; readonly action: string; readonly entityId: string; readonly at: string; readonly payload?: Record<string, unknown>; readonly actorRevision?: number; }

/** @internal Captures new authority changes only, never retroactively signs historical audit rows. */
export function captureAuthorityFact(tx: Queryable, fact: AuthorityFact): void {
  const actions = ["WORKSPACE_CREATED", "LEGACY_WORKSPACE_ADOPTED", "MEMBER_CREATED", "PERMISSION_GRANTED", "PERMISSION_REVOKED", "MEMBER_SUSPENDED", "MEMBER_REINSTATED", "MEMBER_ACCESS_RESET", "OWNER_ACCESS_RECOVERED", "DEVICE_TRUSTED", "DEVICE_REVOKED",
    "DEVICE_ENCRYPTION_KEY", "SHOP_KEY_GRANTED", "SERVER_ENDPOINT_SET", "SERVER_ENDPOINT_CLEARED", "SHOP_BACKUP_KEY"];
  if (!actions.includes(fact.action)) return;
  const installation = tx.get(`SELECT * FROM local_installation WHERE id = 1`);
  if (installation?.["business_id"] !== fact.businessId || installation["device_id"] !== fact.deviceId) return;
  tx.run(`INSERT OR IGNORE INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,1,?)`,
    [fact.businessId,fact.deviceId,installation["public_key"]!,installation["owner_id"]!]);
  const actor = tx.get(`SELECT revision FROM local_memberships WHERE business_id = ? AND user_id = ?`, [fact.businessId,fact.userId])!;
  let payload: Record<string, unknown>;
  if (fact.action === "WORKSPACE_CREATED") {
    const business = tx.get(`SELECT name FROM businesses WHERE id = ?`, [fact.businessId])!;
    const owner = tx.get(`SELECT name FROM users WHERE id = ? AND business_id = ?`, [fact.userId,fact.businessId])!;
    const device = tx.get(`SELECT label,platform FROM devices WHERE id = ? AND business_id = ?`, [fact.deviceId,fact.businessId])!;
    payload = { business: { id: fact.businessId, name: business["name"], currency: "XAF" }, owner: { id: fact.userId, name: owner["name"] },
      device: { id: fact.deviceId, label: device["label"], platform: device["platform"], public_key: installation["public_key"] },
      accounts: tx.all(`SELECT id,name,kind FROM financial_accounts WHERE business_id = ? ORDER BY id`, [fact.businessId]) };
  } else if (fact.action === "LEGACY_WORKSPACE_ADOPTED") {
    archiveLegacyHistory(tx,fact.businessId);
    payload = { business_id: fact.businessId, owner_id: fact.userId, device_id: fact.deviceId,
      public_key: installation["public_key"], provenance: "unsigned_v1_snapshot" };
  } else if (["DEVICE_TRUSTED", "DEVICE_REVOKED", "DEVICE_ENCRYPTION_KEY", "SHOP_KEY_GRANTED", "SERVER_ENDPOINT_SET", "SERVER_ENDPOINT_CLEARED", "SHOP_BACKUP_KEY"].includes(fact.action)) {
    payload = { ...fact.payload }; // Shaped by the operation that records it (trust, encryption keys, server address).
  } else {
    const target = tx.get(`SELECT m.revision,m.role,u.name FROM local_memberships m JOIN users u ON u.id=m.user_id AND u.business_id=m.business_id
      WHERE m.business_id = ? AND m.user_id = ?`, [fact.businessId,fact.entityId])!;
    payload = { user_id: fact.entityId, revision: target["revision"] };
    if (fact.action === "MEMBER_CREATED") { payload["name"] = target["name"]; payload["role"] = target["role"]; }
    if (fact.action.startsWith("PERMISSION_")) payload["permission"] = fact.payload?.["permission"];
  }
  const event: JournalEnvelope = { event_id: fact.eventId, business_id: fact.businessId, origin_device_id: fact.deviceId,
    actor_id: fact.userId, origin_sequence: allocateOrigin(tx,fact.businessId,fact.deviceId), event_type: fact.action,
    event_version: 2, occurred_at: fact.at, branch_id: null,
    authority_revision: fact.actorRevision ?? journalContext(tx)?.revision ?? Number(actor["revision"]),
    // A device announces its own encryption key whoever is signed in; every other authority fact is the owner's.
    required_permissions: fact.action === "DEVICE_ENCRYPTION_KEY" ? [] : ["users.manage"], payload: JSON.parse(JSON.stringify(payload)) as JournalEnvelope["payload"] };
  appendEvent(tx,event,"local");
  tx.run(`INSERT INTO applied_events(event_id,business_id,status,updated_at) VALUES (?,?,'applied',?)`, [event.event_id,event.business_id,event.occurred_at]);
}

/** @internal Explicit unsigned baseline/archive: preserves original IDs, source sequences and v1 queue state. */
export function archiveLegacyHistory(tx: Queryable, businessId: string): void {
  tx.run(`INSERT OR IGNORE INTO legacy_event_archive(event_id,direction,business_id,original)
    SELECT event_id,'outbox',business_id,json_object('event_id',event_id,'business_id',business_id,'user_id',user_id,'device_id',device_id,
      'type',type,'payload',json(payload),'occurred_at',occurred_at,'sequence',sequence,'state',state,'attempts',attempts,'last_error',last_error,'delivered_at',delivered_at)
    FROM sync_outbox WHERE business_id = ?`, [businessId]);
  tx.run(`INSERT OR IGNORE INTO legacy_event_archive(event_id,direction,business_id,original)
    SELECT event_id,'inbox',business_id,json_object('event_id',event_id,'business_id',business_id,'user_id',user_id,'device_id',device_id,
      'type',type,'payload',json(payload),'occurred_at',occurred_at,'server_sequence',server_sequence,'state',state,'attempts',attempts,'last_error',last_error)
    FROM sync_inbox WHERE business_id = ?`, [businessId]);
  tx.run(`INSERT OR IGNORE INTO legacy_baselines SELECT id,'unsigned_v1_snapshot',
    (SELECT count(*) FROM sync_outbox WHERE business_id = ?),(SELECT count(*) FROM sync_inbox WHERE business_id = ?),
    (SELECT next FROM sync_sequence WHERE id=1),(SELECT coalesce(max(sequence),0) FROM local_audit WHERE business_id = ?)
    FROM businesses WHERE id = ?`, [businessId,businessId,businessId,businessId]);
}
