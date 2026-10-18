import { canonicalJson } from "@kolo/contracts/canonical";
import { JOIN_CODE_ALPHABET, formatJoinCode, formatJoinLink, type JoinRequestBody, type JoinOffer, type JoinEnrollment } from "@kolo/contracts/sync";
import type { SignedPairingInvite, SignedPairingRequest } from "@kolo/contracts/transfer";
import type { OperationContext, WorkspacePorts, Installation } from "../identity/types.ts";
import type { Database } from "../data/database/driver.ts";
import { TransferError, type SnapshotPort } from "../backup/types.ts";
import { transferFileFromText, transferFileText } from "../backup/file-kind.ts";
import { acceptPairingInvite, cancelPairingInvite, completePairing, confirmPairing, createPairingInvite, pairingVerificationCode, previewPairingInvite, previewPairingRequest } from "./pairing.ts";
import { openSealedWithVault, sealToDevice, type SealingCrypto } from "./sealed-sync.ts";
import { openServerSession, type SyncTransport } from "./server-sync.ts";

/**
 * Join by code (ADR-032): the existing pairing (signed invite, signed request, owner confirmation, encrypted shop
 * snapshot) carried through a short-lived server mailbox instead of files. A 10-character code shown on the owner's till
 * replaces the fingerprint and code comparisons: both tills tag their messages with a key derived from it, so a server
 * that swapped either message is detected. The shop file's password is random and sealed to the new till's own key, so
 * neither the server nor anyone who later learns the code can open it. The owner still approves the named till.
 */

/** A join the owner's till has opened. `token` is a network session kept only in memory while it waits. */
export interface JoinStart {
  readonly code: string; readonly display: string; readonly link: string; readonly joinId: string; readonly expiresAt: string;
  readonly token: string; readonly inviteId: string; readonly authorityAllowed: boolean;
}
/** The till asking to join, verified against the code; shown to the owner before approval. */
export interface JoinCandidate { readonly label: string; readonly platform: string; readonly requestText: string; readonly encryptionPublicKey: string }
/** What the new till learns from a code before choosing its own code: whose shop it is joining. */
export interface JoinInvitation { readonly businessName: string; readonly ownerName: string; readonly authorityAllowed: boolean; readonly inviteText: string }

const toHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
/** The server's handle for a code: a hash, so the mailbox never names the code itself. */
export async function joinIdOf(code: string, crypto: SealingCrypto): Promise<string> { return crypto.sha256(`kolo.join-id.v1\u0000${code}`); }
async function macKey(code: string, crypto: SealingCrypto): Promise<string> { return crypto.hkdf(toHex(crypto.encodeText(code)), "", "kolo.join-mac.v1", 32); }
async function mac(code: string, label: string, value: string, crypto: SealingCrypto): Promise<string> { return crypto.hmac(await macKey(code, crypto), `kolo.join.${label}.v1\u0000${value}`); }
function equal(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
/** A fresh code: 10 symbols of Crockford base32, drawn without modulo bias from native random bytes. */
function newCode(crypto: SealingCrypto): string {
  let code = "";
  // 224 is the largest multiple of 32 below 256: bytes above it are skipped so every symbol is equally likely.
  while (code.length < 10) for (const byte of hexBytes(crypto.randomHex(16))) if (byte < 224 && code.length < 10) code += JOIN_CODE_ALPHABET[byte % 32];
  return code;
}
function hexBytes(hex: string): number[] { const bytes: number[] = []; for (let index = 0; index < hex.length; index += 2) bytes.push(parseInt(hex.slice(index, index + 2), 16)); return bytes; }
const passwordAad = (joinId: string): string => `kolo.join-password.v1\u0000${joinId}`;

/** Creates the authenticated join offer without choosing a transport; also used by a desktop's local mailbox. */
export async function prepareJoinOffer(context: OperationContext, crypto: SealingCrypto,
  input: { readonly url: string; readonly fingerprint: string; readonly authorityAllowed: boolean; readonly expiresAt: string }): Promise<{ start: JoinStart; offer: JoinOffer }> {
  const document = await createPairingInvite(context, crypto, input.authorityAllowed), invite = JSON.parse(crypto.decodeText(document.bytes)) as SignedPairingInvite;
  const code = newCode(crypto), joinId = await joinIdOf(code, crypto);
  return { start: { code, display: formatJoinCode(code), link: formatJoinLink({ ...input, code }), joinId, expiresAt: input.expiresAt, token: "", inviteId: invite.invite.invite_id, authorityAllowed: input.authorityAllowed },
    offer: { join_id: joinId, invite, mac: await mac(code, "invite", invite.digest, crypto) } };
}

/** Verifies that a candidate holds the QR's secret and requests this exact invite, regardless of mailbox transport. */
export async function inspectJoinCandidate(body: JoinRequestBody, crypto: SealingCrypto, start: JoinStart): Promise<JoinCandidate> {
  if (!equal(body.mac, await mac(start.code, "request", `${body.request.digest}\u0000${body.encryption_public_key}`, crypto))) throw new TransferError("authentication_failed");
  const requestText = canonicalJson(body.request), preview = await previewPairingRequest(crypto.encodeText(requestText), crypto);
  if (body.request.request.invite.invite.invite_id !== start.inviteId) throw new TransferError("invalid_pairing");
  return { label: preview.deviceLabel, platform: body.request.request.platform, requestText, encryptionPublicKey: body.encryption_public_key };
}

/** Builds the approved snapshot and seals its random password to the candidate; the mailbox never receives its plaintext. */
export async function prepareJoinEnrollment(context: OperationContext, crypto: SealingCrypto, files: SnapshotPort, start: JoinStart, candidate: JoinCandidate): Promise<JoinEnrollment> {
  const request = crypto.encodeText(candidate.requestText), verification = (await previewPairingRequest(request, crypto)).verificationCode, password = crypto.randomHex(32);
  // JSON mailboxes carry the binary container as base64 (ADR-035); the MAC covers the carried text.
  const enrollment = transferFileText((await confirmPairing(context, request, verification, password, files, crypto)).bytes, crypto);
  const sealed = await sealToDevice(crypto, candidate.encryptionPublicKey, password, passwordAad(start.joinId));
  return { enrollment, sealed_password: sealed, mac: await mac(start.code, "enrollment", `${await crypto.sha256(enrollment)}\u0000${canonicalJson(sealed)}`, crypto) };
}

/**
 * Owner side: creates an invite for one till, opens its mailbox on the connected server and returns the code to show
 * (and the link for the QR code, which also carries the server's address and fingerprint).
 */
export async function startJoin(context: OperationContext, transport: SyncTransport, crypto: SealingCrypto,
  input: { readonly serverDeviceId: string; readonly url: string; readonly fingerprint: string; readonly authorityAllowed: boolean }): Promise<JoinStart> {
  const document = await createPairingInvite(context, crypto, input.authorityAllowed), invite = JSON.parse(crypto.decodeText(document.bytes)) as SignedPairingInvite;
  const code = newCode(crypto), joinId = await joinIdOf(code, crypto);
  const token = await openServerSession(context, transport, input.serverDeviceId, crypto);
  try {
    const { expires_at } = await transport.joinCreate(token, { join_id: joinId, invite, mac: await mac(code, "invite", invite.digest, crypto) });
    return { code, display: formatJoinCode(code), link: formatJoinLink({ url: input.url, fingerprint: input.fingerprint, code }), joinId, expiresAt: expires_at, token,
      inviteId: invite.invite.invite_id, authorityAllowed: input.authorityAllowed };
  } catch (error) { cancelPairingInvite(context, invite.invite.invite_id); await transport.endSession(token).catch(() => undefined); throw error; }
}

/** Owner side: the till that asked to join, once one has, after checking it holds the code and answers this invite. */
export async function pollJoin(transport: SyncTransport, crypto: SealingCrypto, start: JoinStart): Promise<JoinCandidate | undefined> {
  const body = await transport.joinPollRequest(start.token, start.joinId);
  if (body === null) return undefined;
  return inspectJoinCandidate(body, crypto, start);
}

/**
 * Owner side: approves the named till. Pins its key exactly like file pairing, builds the encrypted shop file with a
 * random password, seals that password to the till's own key and posts both.
 */
export async function approveJoin(context: OperationContext, transport: SyncTransport, crypto: SealingCrypto, files: SnapshotPort, start: JoinStart, candidate: JoinCandidate): Promise<void> {
  await transport.joinEnroll(start.token, start.joinId, await prepareJoinEnrollment(context, crypto, files, start, candidate));
}

/** Owner side: refuses or abandons a join; the invite can no longer be used. */
export async function endJoin(context: OperationContext, transport: SyncTransport, start: JoinStart, refused: boolean): Promise<void> {
  try { if (refused) await transport.joinCancel(start.token, start.joinId); }
  finally {
    try { cancelPairingInvite(context, start.inviteId); } catch { /* Already confirmed: nothing to cancel. */ }
    await transport.endSession(start.token).catch(() => undefined);
  }
}

/** New till: reads whose shop a code opens. Refuses an invite not tagged with this exact code. */
export async function lookupJoin(transport: SyncTransport, crypto: SealingCrypto, code: string): Promise<JoinInvitation> {
  const offer = await transport.joinRead(await joinIdOf(code, crypto));
  if (!equal(offer.mac, await mac(code, "invite", offer.invite.digest, crypto))) throw new TransferError("authentication_failed");
  const inviteText = canonicalJson(offer.invite), preview = await previewPairingInvite(crypto.encodeText(inviteText), crypto);
  return { businessName: preview.businessName, ownerName: preview.ownerName, authorityAllowed: preview.authorityAllowed, inviteText };
}

function enrollmentOf(database: Database): { installationId: string; signed?: SignedPairingRequest } | undefined {
  const row = database.get(`SELECT intent FROM workspace_enrollment WHERE id=1`);
  return row === undefined ? undefined : JSON.parse(String(row["intent"])) as { installationId: string; signed?: SignedPairingRequest };
}

/**
 * New till: provisions this device's keys with its own new code, then posts its signed request and encryption key,
 * tagged with the join code. Safe to repeat after an interruption: the same request is posted again.
 */
export async function requestJoin(code: string, invitation: JoinInvitation, input: { readonly label: string; readonly platform: "ANDROID" | "IOS" | "DESKTOP"; readonly secret: string },
  ports: WorkspacePorts, transport: SyncTransport, crypto: SealingCrypto): Promise<void> {
  const invite = crypto.encodeText(invitation.inviteText), fingerprint = (await previewPairingInvite(invite, crypto)).fingerprint;
  const accepted = await acceptPairingInvite(invite, { confirmedFingerprint: fingerprint, label: input.label, platform: input.platform, secret: input.secret }, ports, crypto);
  const intent = enrollmentOf(ports.database), native = intent === undefined ? undefined : await ports.credentials.inspect(intent.installationId);
  if (native === undefined || ports.credentials.encryptionKey === undefined) throw new TransferError("authentication_failed");
  const encryptionPublicKey = await ports.credentials.encryptionKey(native.keyReference);
  const request = JSON.parse(crypto.decodeText(accepted.document.bytes)) as SignedPairingRequest;
  const body: JoinRequestBody = { request, encryption_public_key: encryptionPublicKey, mac: await mac(code, "request", `${request.digest}\u0000${encryptionPublicKey}`, crypto) };
  await transport.joinRequest(await joinIdOf(code, crypto), body);
}

/**
 * New till: once the owner approved, opens the shop file with the sealed password and installs the shop exactly as
 * file pairing does. Returns undefined while the owner has not answered.
 */
export async function finishJoin(code: string, ports: WorkspacePorts, files: SnapshotPort, transport: SyncTransport, crypto: SealingCrypto): Promise<{ readonly database: Database; readonly installation: Installation } | undefined> {
  const joinId = await joinIdOf(code, crypto), answer = await transport.joinPollEnrollment(joinId);
  if (answer === null) return undefined;
  if (!equal(answer.mac, await mac(code, "enrollment", `${await crypto.sha256(answer.enrollment)}\u0000${canonicalJson(answer.sealed_password)}`, crypto))) throw new TransferError("authentication_failed");
  const intent = enrollmentOf(ports.database);
  if (intent?.signed === undefined) throw new TransferError("pairing_pending");
  const native = await ports.credentials.inspect(intent.installationId);
  if (native === undefined || ports.credentials.encryptionKey === undefined) throw new TransferError("authentication_failed");
  const own = await ports.credentials.encryptionKey(native.keyReference);
  let password: string;
  try { password = await openSealedWithVault(ports, native.keyReference, own, answer.sealed_password, passwordAad(joinId), crypto); }
  catch { throw new TransferError("authentication_failed"); }
  return completePairing(transferFileFromText(answer.enrollment, crypto), password, await pairingVerificationCode(intent.signed, crypto), ports, files, crypto);
}

/** True while this empty device has a join request waiting for the owner, so the app can resume waiting after a restart. */
export function joinPending(database: Database): boolean { return enrollmentOf(database)?.signed !== undefined; }
