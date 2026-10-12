import { localNetworkUrl,parseLocalJoinLink } from "@kolo/contracts/local-sync";
import { keyFingerprint,type SyncTransport } from "./server-sync.ts";
import { lookupJoin,finishJoin,requestJoin,type JoinInvitation } from "./join.ts";
import type { SealingCrypto } from "./sealed-sync.ts";
import type { WorkspacePorts } from "../identity/types.ts";
import type { SnapshotPort } from "../backup/types.ts";
import { TransferError } from "../backup/types.ts";
import type { SignedPairingInvite,SignedPairingRequest } from "@kolo/contracts/transfer";
import { createHttpSyncTransport } from "./http-sync-transport.ts";

/** LAN-only mailbox HTTP transport. Redirects are refused so a private QR cannot send a request to a public endpoint. */
export function localJoinTransport(url:string):SyncTransport{
  const address=localNetworkUrl(url);if(address===undefined)throw new TransferError("invalid_pairing");
  return createHttpSyncTransport(address,{fetch:(target,init)=>fetch(target,{...init,redirect:"error"})});
}

/** A verified invitation from a local desktop; the owner identity is pinned by the QR and code authentication. */
export async function lookupLocalJoin(link:string,transport:SyncTransport,crypto:SealingCrypto):Promise<JoinInvitation>{
  const parsed=parseLocalJoinLink(link);if(parsed===undefined)throw new TransferError("invalid_pairing");
  const invitation=await lookupJoin(transport,crypto,parsed.code),signed=JSON.parse(invitation.inviteText) as SignedPairingInvite;
  if(await keyFingerprint(signed.invite.source_public_key,crypto)!==parsed.fingerprint)throw new TransferError("authentication_failed");
  return invitation;
}
/** Posts this installation's signed local join request using the existing recipient-bound pairing protocol. */
export async function requestLocalJoin(link:string,invitation:JoinInvitation,input:{label:string;platform:"DESKTOP"|"ANDROID"|"IOS";secret:string},ports:WorkspacePorts,transport:SyncTransport,crypto:SealingCrypto):Promise<void>{
  const parsed=parseLocalJoinLink(link);if(parsed===undefined)throw new TransferError("invalid_pairing");
  await requestJoin(parsed.code,invitation,input,ports,transport,crypto);
}
/** Finishes owner-approved local enrollment and stores only this device's host address, after validating the signed snapshot. */
export async function finishLocalJoin(link:string,ports:WorkspacePorts,files:SnapshotPort,transport:SyncTransport,crypto:SealingCrypto):ReturnType<typeof finishJoin>{
  const parsed=parseLocalJoinLink(link);if(parsed===undefined||localNetworkUrl(parsed.url)===undefined)throw new TransferError("invalid_pairing");
  const row=ports.database.get(`SELECT intent FROM workspace_enrollment WHERE id=1`);if(row===undefined)throw new TransferError("pairing_pending");
  const intent=JSON.parse(String(row["intent"])) as {signed?:SignedPairingRequest};if(intent.signed===undefined)throw new TransferError("pairing_pending");
  const invite=intent.signed.request.invite.invite;
  if(await keyFingerprint(invite.source_public_key,crypto)!==parsed.fingerprint)throw new TransferError("authentication_failed");
  // Persist the host in the already-verified staging database before its atomic activation, so a crash cannot
  // activate the new shop and lose the connection address. Sanitized incoming snapshots still contain no endpoints.
  const localFiles:SnapshotPort={...files,open:async bytes=>{const candidate=await files.open(bytes);return {...candidate,activate:async target=>{
    candidate.database.run(`INSERT INTO local_peer_connections(business_id,device_id,url) VALUES(?,?,?) ON CONFLICT(business_id,device_id) DO UPDATE SET url=excluded.url,active=1`,[invite.business_id,invite.source_device_id,parsed.url]);
    return candidate.activate(target);
  }};}};
  return finishJoin(parsed.code,ports,localFiles,transport,crypto);
}
