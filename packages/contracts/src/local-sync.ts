import { z } from "zod";
import { normalizeJoinCode, formatJoinCode } from "./sync.ts";
import { signedJournalBatchSchema, signedPeerReceiptSchema } from "./delivery.ts";

/** Maximum sealed direct-peer packet, including base64 overhead for a signed journal batch. */
export const MAX_LOCAL_PACKET_BYTES = 12 * 1024 * 1024;
const uuid = z.uuid().refine(value => value === value.toLowerCase());
/** Authenticated encrypted direct-peer envelope; the header binds both devices, shop, purpose and request identity. */
export const localPacketSchema = z.strictObject({
  header: z.strictObject({ format:z.literal("kolo.local-sync"),version:z.literal(1),id:uuid,business_id:uuid,sender_device_id:uuid,receiver_device_id:uuid,
    reply_to:uuid.nullable(),encryption_public_key:z.string().min(1).max(1024),ephemeral_public_key:z.string().min(1).max(1024),nonce:z.string().regex(/^[a-f0-9]{24}$/) }),
  ciphertext:z.string().min(1).max(MAX_LOCAL_PACKET_BYTES).regex(/^[A-Za-z0-9+/]+={0,2}$/),tag:z.string().regex(/^[a-f0-9]{32}$/),signature:z.string().regex(/^[a-f0-9]{128}$/)
});
/** Wire representation of an encrypted peer request or response. */
export type LocalPacket = z.infer<typeof localPacketSchema>;
/** Same signed facts and durable acknowledgements as file exchange, inside a device-encrypted packet. */
export const localExchangePayloadSchema=z.strictObject({batch:signedJournalBatchSchema.nullable(),receipt:signedPeerReceiptSchema.nullable()});
/** Plaintext visible only inside the two approved apps. */
export type LocalExchangePayload=z.infer<typeof localExchangePayloadSchema>;

/** Literal private/loopback IPv4 addresses only: no DNS, redirects, credentials or public endpoints. */
export function localNetworkUrl(value:string):string | undefined {
  try {
    const u=new URL(value);
    if(u.protocol!=="http:"||u.username||u.password||u.search||u.hash||u.pathname!=="/"||!u.port)return undefined;
    const p=u.hostname.split(".").map(Number);
    if(p.length!==4||p.some(x=>!Number.isInteger(x)||x<0||x>255))return undefined;
    const [a,b]=p;
    if(!(a===10||a===127||a===192&&b===168||a===172&&b!>=16&&b!<=31))return undefined;
    return u.origin;
  }catch{return undefined;}
}
/** QR invitation to a desktop on this Wi-Fi/hotspot; contains no shop data or reusable unlock credential. */
export function formatLocalJoinLink(input:{url:string;fingerprint:string;code:string}):string {
  const url=localNetworkUrl(input.url),code=normalizeJoinCode(input.code);
  if(url===undefined||code===undefined||!/^[a-f0-9]{32}$/.test(input.fingerprint))throw new Error("invalid local link");
  return `kolo://local?${new URLSearchParams({u:url,f:input.fingerprint,c:formatJoinCode(code)}).toString()}`;
}
/** Reads an exact local QR/pasted link, refusing public addresses and ambiguous duplicate parameters. */
export function parseLocalJoinLink(value:string):{url:string;fingerprint:string;code:string}|undefined {
  if(typeof value!=="string"||value.length>4096)return undefined;
  try {
    const u=new URL(value.trim());if(u.protocol!=="kolo:"||u.hostname!=="local"||u.hash||u.username||u.password||u.pathname!=="")return undefined;
    if([...u.searchParams.keys()].sort().join(",")!=="c,f,u")return undefined;
    const url=localNetworkUrl(u.searchParams.get("u")??""),code=normalizeJoinCode(u.searchParams.get("c")??""),fingerprint=u.searchParams.get("f")??"";
    return url===undefined||code===undefined||!/^[a-f0-9]{32}$/.test(fingerprint)?undefined:{url,code,fingerprint};
  }catch{return undefined;}
}
