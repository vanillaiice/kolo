import { canonicalJson } from "@kolo/contracts/canonical";
import { localPacketSchema,localExchangePayloadSchema,localNetworkUrl,MAX_LOCAL_PACKET_BYTES,type LocalPacket,type LocalExchangePayload } from "@kolo/contracts/local-sync";
import type { OperationContext } from "../identity/types.ts";
import { authorizedOperation,nextId,timestamp } from "../identity/internal-authority.ts";
import { ExchangeError } from "../exchange/types.ts";
import { signMessage,createJournalBatch,importJournalBatch,createPeerReceipt,acknowledgeDelivery } from "./event-delivery.ts";
import { ensureEncryptionKey,type SealingCrypto } from "./sealed-sync.ts";
import { retryDeferred } from "./event-application.ts";
import type { FetchPort } from "./http-sync-transport.ts";

const packetMessage=(packet:Omit<LocalPacket,"signature">):string=>`kolo.local-sync.v1\u0000${canonicalJson(packet,MAX_LOCAL_PACKET_BYTES)}`;
// A full 8 MiB journal batch can travel together with its receipt, while base64 and the signed header still fit.
const MAX_LOCAL_PLAINTEXT_BYTES=MAX_LOCAL_PACKET_BYTES*3/4-8192;
function material(context:OperationContext,peerId?:string){return authorizedOperation(context,["business.settings"],(_db,tx,ports)=>{
  const own=tx.get(`SELECT public_key,key_reference FROM local_installation WHERE id=1`)!;
  const peer=peerId===undefined?undefined:tx.get(`SELECT t.public_key FROM trusted_exchange_devices t JOIN devices d ON d.business_id=t.business_id AND d.id=t.device_id WHERE t.business_id=? AND t.device_id=? AND t.active=1 AND d.active=1`,[context.businessId,peerId]);
  if(peerId!==undefined&&(peer===undefined||peerId===context.deviceId))throw new ExchangeError("untrusted_device");
  return {ports,reference:String(own["key_reference"]),peerKey:peer===undefined?undefined:String(peer["public_key"])};
});}
/** Encrypts to an approved device's X25519 key and signs the complete header/ciphertext with the native identity. */
export async function sealLocalPacket(context:OperationContext,peerId:string,recipientKey:string,payload:LocalExchangePayload,crypto:SealingCrypto,replyTo:string|null=null):Promise<LocalPacket>{
  material(context,peerId);const own=await ensureEncryptionKey(context);if(own===undefined)throw new ExchangeError("locked");
  const {publicKey,shared}=await crypto.ephemeralAgreement(recipientKey);
  const {ports}=material(context,peerId),header:LocalPacket["header"]={format:"kolo.local-sync",version:1,id:nextId(ports),business_id:context.businessId,sender_device_id:context.deviceId,receiver_device_id:peerId,reply_to:replyTo,encryption_public_key:own,ephemeral_public_key:publicKey,nonce:crypto.randomHex(12)};
  const key=await crypto.hkdf(shared,await crypto.sha256(`${publicKey}\u0000${recipientKey}`),"kolo.local-sync.v1",32);
  const bytes=crypto.encodeText(canonicalJson(localExchangePayloadSchema.parse(payload),MAX_LOCAL_PLAINTEXT_BYTES));
  try{const encrypted=await crypto.encrypt(key,header.nonce,bytes,canonicalJson(header));const packet={header,...encrypted};
    const {signature}=await signMessage(context,crypto,packetMessage(packet));material(context,peerId);return {...packet,signature};
  }finally{bytes.fill(0);}
}
/** Verifies current shop/device trust before decryption; private keys never leave the vault. */
export async function openLocalPacket(context:OperationContext,input:unknown,crypto:SealingCrypto,replyTo:string|null=null):Promise<{packet:LocalPacket;payload:LocalExchangePayload}>{
  const parsed=localPacketSchema.safeParse(input);if(!parsed.success)throw new ExchangeError("invalid_payload");const packet=parsed.data,h=packet.header;
  if(h.business_id!==context.businessId||h.receiver_device_id!==context.deviceId||h.reply_to!==replyTo)throw new ExchangeError("scope_mismatch");
  const {ports,reference,peerKey}=material(context,h.sender_device_id);
  if(!await crypto.verify(peerKey!,packetMessage({header:h,ciphertext:packet.ciphertext,tag:packet.tag}),packet.signature))throw new ExchangeError("invalid_signature");
  if(ports.credentials.encryptionKey===undefined||ports.credentials.agree===undefined)throw new ExchangeError("locked");
  const own=await ports.credentials.encryptionKey(reference),shared=await ports.credentials.agree(reference,h.ephemeral_public_key);
  const key=await crypto.hkdf(shared,await crypto.sha256(`${h.ephemeral_public_key}\u0000${own}`),"kolo.local-sync.v1",32);
  let bytes:Uint8Array;try{bytes=await crypto.decrypt(key,h.nonce,packet.ciphertext,packet.tag,canonicalJson(h));}catch{throw new ExchangeError("invalid_signature");}
  try{
    if(bytes.length>MAX_LOCAL_PLAINTEXT_BYTES)throw new ExchangeError("invalid_payload");
    let value:unknown;try{value=JSON.parse(crypto.decodeText(bytes));}catch{throw new ExchangeError("invalid_payload");}
    const body=localExchangePayloadSchema.safeParse(value);if(!body.success)throw new ExchangeError("invalid_payload");
    if(body.data.batch!==null&&(body.data.batch.batch.sender_device_id!==h.sender_device_id||body.data.batch.batch.receiver_device_id!==context.deviceId))throw new ExchangeError("scope_mismatch");
    material(context,h.sender_device_id);return {packet,payload:body.data};
  }finally{bytes.fill(0);}
}
function destination(context:OperationContext,peerId:string):string{return authorizedOperation(context,["business.settings"],(_db,tx)=>{
  material(context,peerId);const row=tx.get(`SELECT id FROM exchange_destinations WHERE business_id=? AND receiver_device_id=? AND kind='peer' AND active=1`,[context.businessId,peerId]);
  if(row===undefined)throw new ExchangeError("invalid_destination");return String(row["id"]);
});}
async function apply(context:OperationContext,peerId:string,payload:LocalExchangePayload,crypto:SealingCrypto):Promise<number>{
  const dest=destination(context,peerId);
  if(payload.receipt!==null)await acknowledgeDelivery(context,dest,payload.receipt,crypto);
  if(payload.batch===null)return 0;
  const outcomes=await importJournalBatch(context,payload.batch,crypto);retryDeferred(context);
  return outcomes.filter(x=>x.outcome==="applied").length;
}
async function outgoing(context:OperationContext,peerId:string,crypto:SealingCrypto):Promise<LocalExchangePayload>{
  await ensureEncryptionKey(context);
  const batch=await createJournalBatch(context,destination(context,peerId),crypto,200);
  const last=authorizedOperation(context,["business.settings"],(_db,tx)=>tx.get(`SELECT batch_id FROM import_batches WHERE business_id=? AND sender_device_id=? AND receiver_device_id=? AND status='complete' ORDER BY rowid DESC LIMIT 1`,[context.businessId,peerId,context.deviceId]));
  const receipt=last===undefined?undefined:await createPeerReceipt(context,String(last["batch_id"]),crypto);
  return {batch:batch??null,receipt:receipt??null};
}
/** Desktop-side direct exchange: apply authenticated facts/receipts and return an encrypted signed response. */
export async function answerLocalExchange(context:OperationContext,input:unknown,crypto:SealingCrypto):Promise<LocalPacket>{
  const {packet,payload}=await openLocalPacket(context,input,crypto);
  await apply(context,packet.header.sender_device_id,payload,crypto);
  const response=await sealLocalPacket(context,packet.header.sender_device_id,packet.header.encryption_public_key,await outgoing(context,packet.header.sender_device_id,crypto),crypto,packet.header.id);
  authorizedOperation(context,["business.settings"],(_db,tx,ports)=>tx.run(`INSERT INTO local_peer_connections(business_id,device_id,url,last_attempt_at,last_success_at) VALUES(?,?,NULL,?,?) ON CONFLICT(business_id,device_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,last_error=NULL`,[context.businessId,packet.header.sender_device_id,timestamp(ports),timestamp(ports)]));
  return response;
}
/** Connects a paired device to a literal LAN address. This device-local setting never becomes a signed business fact. */
export function connectLocalPeer(context:OperationContext,peerId:string,url:string):void{
  const address=localNetworkUrl(url);if(address===undefined)throw new ExchangeError("invalid_destination");material(context,peerId);destination(context,peerId);
  authorizedOperation(context,["business.settings"],(_db,tx)=>{tx.run(`INSERT INTO local_peer_connections(business_id,device_id,url) VALUES(?,?,?) ON CONFLICT(business_id,device_id) DO UPDATE SET url=excluded.url,active=1,last_error=NULL`,[context.businessId,peerId,address]);});
}
/** A known local host and the last delivery outcome, scoped to the unlocked shop. */
export interface LocalPeerConnection{readonly deviceId:string;readonly label:string;readonly url:string|null;readonly lastSuccessAt:string|null;readonly lastError:string|null;}
/** Paired local hosts configured on this device only. */
export function localPeerConnections(context:OperationContext):readonly LocalPeerConnection[]{return authorizedOperation(context,["business.settings"],(_db,tx)=>tx.all(`SELECT l.*,d.label FROM local_peer_connections l JOIN devices d ON d.id=l.device_id AND d.business_id=l.business_id JOIN trusted_exchange_devices t ON t.device_id=d.id AND t.business_id=d.business_id WHERE l.business_id=? AND l.active=1 AND d.active=1 AND t.active=1`,[context.businessId]).map(r=>({deviceId:String(r["device_id"]),label:String(r["label"]),url:r["url"]===null?null:String(r["url"]),lastSuccessAt:r["last_success_at"] as string|null,lastError:r["last_error"] as string|null})));}
/** Client-side bidirectional sync with retry-safe journal facts and durable receiver receipts, over a local HTTP connection. */
export async function synchronizeLocalPeer(context:OperationContext,peerId:string,crypto:SealingCrypto,fetcher:FetchPort=(url,init)=>fetch(url,init)):Promise<{sent:number;received:number}>{
  const connection=localPeerConnections(context).find(x=>x.deviceId===peerId);if(connection===undefined||connection.url===null||localNetworkUrl(connection.url)===undefined)throw new ExchangeError("invalid_destination");
  const key=authorizedOperation(context,["business.settings"],(_db,tx)=>tx.get(`SELECT public_key FROM device_encryption_keys WHERE business_id=? AND device_id=?`,[context.businessId,peerId]));
  if(key===undefined)throw new ExchangeError("invalid_payload");let sent=0,received=0;
  const record=(error:string|null):void=>{authorizedOperation(context,["business.settings"],(_db,tx,ports)=>tx.run(`UPDATE local_peer_connections SET last_attempt_at=?,last_success_at=CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,last_error=? WHERE business_id=? AND device_id=?`,[timestamp(ports),error,timestamp(ports),error,context.businessId,peerId]));};
  try{
    // Each subsequent request acknowledges the previous response; bounded rounds leave any remaining work durable.
    for(let round=0;round<6;round++){
      const payload=await outgoing(context,peerId,crypto),request=await sealLocalPacket(context,peerId,String(key["public_key"]),payload,crypto);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30_000);
      let response:{status:number;text():Promise<string>},text:string;try{response=await fetcher(`${connection.url}/api/local/v1/exchange`,{method:"POST",headers:{"content-type":"application/json"},body:canonicalJson(request,MAX_LOCAL_PACKET_BYTES),signal:controller.signal,redirect:"error"});text=await response.text();}finally{clearTimeout(timer);}
      if(response.status!==200||text.length>MAX_LOCAL_PACKET_BYTES)throw new ExchangeError("invalid_payload");
      let value:unknown;try{value=JSON.parse(text);}catch{throw new ExchangeError("invalid_payload");}
      const answer=await openLocalPacket(context,value,crypto,request.header.id);if(answer.packet.header.sender_device_id!==peerId)throw new ExchangeError("scope_mismatch");
      received+=await apply(context,peerId,answer.payload,crypto);sent+=payload.batch?.batch.events.length??0;
      if(payload.batch===null&&answer.payload.batch===null)break;
    }
    record(null);return {sent,received};
  }catch(error){try{record("local_unreachable");}catch{/* A lock keeps the earlier durable status. */}throw error;}
}
/** Foreground schedule shared by desktop and mobile; individual host failures never prevent another host or local sales. */
export class LocalSyncScheduler{
  #running=false;#next=0;
  private readonly crypto:SealingCrypto;private readonly fetcher:FetchPort|undefined;private readonly now:()=>number;
  constructor(crypto:SealingCrypto,fetcher?:FetchPort,now=()=>Date.now()){this.crypto=crypto;this.fetcher=fetcher;this.now=now;}
  /** Brings the next exchange forward after a local change or return to the foreground. */
  soon():void{this.#next=Math.min(this.#next,this.now()+5000);}
  /** Runs at most one pass at a time, only while a valid signed-in context is available. */
  async tick(context:OperationContext|undefined):Promise<void>{
    if(context===undefined||this.#running||this.now()<this.#next)return;this.#running=true;this.#next=this.now()+60_000;
    try{for(const peer of localPeerConnections(context)){if(peer.url===null)continue;try{await synchronizeLocalPeer(context,peer.deviceId,this.crypto,this.fetcher);}catch{/* Queue stays pending; retry next minute or after a local change. */}}}finally{this.#running=false;}
  }
}
