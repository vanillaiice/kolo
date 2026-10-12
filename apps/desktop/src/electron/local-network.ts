import { createServer,type Server,type IncomingMessage,type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { localNetworkUrl,formatLocalJoinLink,MAX_LOCAL_PACKET_BYTES } from "@kolo/contracts/local-sync";
import { joinRequestSchema,type JoinOffer,type JoinEnrollment } from "@kolo/contracts/sync";
import { prepareJoinOffer,inspectJoinCandidate,prepareJoinEnrollment,type JoinStart,type JoinCandidate } from "@kolo/core/application/join";
import { cancelPairingInvite } from "@kolo/core/application/pairing";
import { keyFingerprint } from "@kolo/core/application/server-sync";
import { answerLocalExchange } from "@kolo/core/application/local-sync";
import { ensureEncryptionKey,type SealingCrypto } from "@kolo/core/application/sealed-sync";
import { capabilities } from "@kolo/core/application/queries";
import type { WorkspacePorts,OperationContext } from "@kolo/core/identity/types";
import type { SnapshotPort } from "@kolo/core/backup/types";
import type { JoinCodeView,JoinStatusView } from "../shared/service.js";
import { CommandError } from "./host.ts";

interface Mailbox{start:JoinStart;offer:JoinOffer;candidate?:JoinCandidate;requestDigest?:string;enrollment?:JoinEnrollment;}
/** Owns one app-local HTTP listener. It transports authenticated pairing/encrypted facts; it has no separate database or account system. */
export class LocalNetwork {
  #server:Server|undefined;#port=0;#busy=0;#work=new Set<Promise<unknown>>();#mailboxes=new Map<string,Mailbox>();#starting:Promise<void>|undefined;#generation=0;
  private readonly ports:WorkspacePorts;private readonly crypto:SealingCrypto;private readonly files:SnapshotPort;private readonly actor:()=>OperationContext|undefined;private readonly changed:()=>void;
  constructor(ports:WorkspacePorts,crypto:SealingCrypto,files:SnapshotPort,actor:()=>OperationContext|undefined,changed:()=>void){this.ports=ports;this.crypto=crypto;this.files=files;this.actor=actor;this.changed=changed;}
  /** Current literal LAN addresses of this listener, preferring the common Wi-Fi range over container/VPN ranges. */
  urls():string[]{if(this.#server===undefined)return [];return Object.values(networkInterfaces()).flatMap(list=>(list??[]).filter(x=>x.family==="IPv4"&&!x.internal&&localNetworkUrl(`http://${x.address}:${this.#port}`)!==undefined).map(x=>`http://${x.address}:${this.#port}`)).sort((a,b)=>Number(!a.startsWith("http://192.168."))-Number(!b.startsWith("http://192.168.")));}
  /** Whether this installation currently accepts direct local connections. */
  running():boolean{return this.#server!==undefined;}
  #context():OperationContext{const context=this.actor();if(context===undefined)throw new CommandError("locked");if(!capabilities(context).includes("business.settings"))throw new CommandError("permission_denied");return context;}
  /** Restarts the saved listener only while unlocked; first use chooses and persists an available port. */
  async start(enable=true):Promise<void>{
    if(this.#starting!==undefined)return this.#starting;
    const task=this.#start(enable);this.#starting=task;try{await task;}finally{if(this.#starting===task)this.#starting=undefined;}
  }
  async #start(enable:boolean):Promise<void>{
    const generation=this.#generation;
    this.#context();if(this.#server!==undefined)return;
    const stored=this.ports.database.get(`SELECT * FROM local_network_listener WHERE id=1`);
    if(!enable&&stored?.["enabled"]!==1)return;
    const server=createServer((req,res)=>{const task=this.#handle(req,res).catch(()=>{if(!res.headersSent)this.#reply(res,400,{error:{code:"invalid_request"}});else res.destroy();});this.#work.add(task);void task.finally(()=>this.#work.delete(task));});
    server.maxConnections=8;server.requestTimeout=35_000;server.headersTimeout=10_000;server.keepAliveTimeout=1000;
    try{await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(stored===undefined?0:Number(stored["port"]),"0.0.0.0",()=>{server.removeListener("error",reject);resolve();});});}
    catch{server.close();throw new CommandError("local_network_unavailable");}
    const address=server.address();if(address===null||typeof address==="string"){server.close();throw new CommandError("local_network_unavailable");}
    try{this.#context();if(generation!==this.#generation)throw new CommandError("locked");}catch(error){server.close();throw error;}
    this.#server=server;this.#port=address.port;
    server.on("error",()=>{void this.close();});
    this.ports.database.run(`INSERT INTO local_network_listener(id,port,enabled) VALUES(1,?,1) ON CONFLICT(id) DO UPDATE SET port=excluded.port,enabled=1`,[this.#port]);
    this.changed();
  }
  /** Stops accepting peers and forgets QR secrets immediately. Owned in-flight work is drained before database disposal. */
  async close(disable=false):Promise<void>{
    this.#generation++;
    const server=this.#server;this.#server=undefined;this.#mailboxes.clear();
    if(disable)this.ports.database.run(`UPDATE local_network_listener SET enabled=0 WHERE id=1`);
    if(server!==undefined){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
    await Promise.allSettled([...this.#work]);
  }
  /** Starts a single-use ten-minute local QR invitation. Only an address of this actual listener can be advertised. */
  async invite(authorityAllowed:boolean,url?:string):Promise<JoinCodeView>{
    await this.start();const context=this.#context(),addresses=this.urls(),address=url??addresses[0];
    if(address===undefined||!addresses.includes(address))throw new CommandError("local_network_unavailable");
    this.#prune();if(this.#mailboxes.size>=5)throw new CommandError("pairing_pending");
    await ensureEncryptionKey(context);
    const own=this.ports.database.get(`SELECT public_key FROM local_installation WHERE id=1`)!,fingerprint=await keyFingerprint(String(own["public_key"]),this.crypto);
    const prepared=await prepareJoinOffer(context,this.crypto,{url:address,fingerprint,authorityAllowed,expiresAt:new Date(Date.now()+600_000).toISOString()});
    this.#context();this.#mailboxes.set(prepared.start.joinId,prepared);
    return {joinId:prepared.start.joinId,code:prepared.start.display,link:formatLocalJoinLink({url:address,fingerprint,code:prepared.start.code}),url:address,expiresAt:prepared.start.expiresAt,authorityAllowed};
  }
  /** Reads a live invite's candidate name without granting device access. */
  status(id:string):JoinStatusView{this.#context();this.#prune();const box=this.#mailboxes.get(id);return box===undefined?{state:"expired"}:box.candidate===undefined?{state:"waiting"}:{state:"requested",label:box.candidate.label,platform:box.candidate.platform};}
  /** Owner approval builds the encrypted baseline once and leaves it available until the QR expires. */
  async approve(id:string):Promise<void>{const context=this.#context(),box=this.#mailboxes.get(id);if(box?.candidate===undefined)throw new CommandError("join_not_found");if(box.enrollment!==undefined)return;
    const enrollment=await prepareJoinEnrollment(context,this.crypto,this.files,box.start,box.candidate);this.#context();if(this.#mailboxes.get(id)!==box)throw new CommandError("join_not_found");box.enrollment=enrollment;
    const request=JSON.parse(box.candidate.requestText) as {request:{device_id:string}};
    this.ports.database.run(`INSERT OR IGNORE INTO local_peer_connections(business_id,device_id,url) VALUES(?,?,NULL)`,[context.businessId,request.request.device_id]);this.changed();}
  /** Removes the mailbox and revokes an unapproved invite; already approved device trust is retained. */
  cancel(id:string):void{const context=this.#context(),box=this.#mailboxes.get(id);if(box===undefined)return;this.#mailboxes.delete(id);if(box.enrollment===undefined)cancelPairingInvite(context,box.start.inviteId);}
  #prune():void{for(const [id,box] of this.#mailboxes)if(Date.parse(box.start.expiresAt)<=Date.now()){this.#mailboxes.delete(id);try{if(box.enrollment===undefined)cancelPairingInvite(this.#context(),box.start.inviteId);}catch{/* Expired and locked: no reachable mailbox remains. */}}}
  #reply(res:ServerResponse,status:number,value?:unknown):void{res.writeHead(status,{"content-type":"application/json","cache-control":"no-store","connection":"close"});res.end(value===undefined?"":JSON.stringify(value));}
  async #body(req:IncomingMessage):Promise<unknown>{
    if(req.headers["content-type"]!=="application/json"||Number(req.headers["content-length"]??0)>MAX_LOCAL_PACKET_BYTES)throw new Error("invalid body");
    const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>MAX_LOCAL_PACKET_BYTES){req.destroy();throw new Error("too large");}chunks.push(bytes);}return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async #handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    const remote=(req.socket.remoteAddress??"").replace(/^::ffff:/,"");
    if(req.headers["origin"]!==undefined||localNetworkUrl(`http://${remote}:1234`)===undefined){this.#reply(res,403);return;}
    if(this.#busy>=2){this.#reply(res,503);return;}this.#busy++;
    try{
      let context:OperationContext;try{context=this.#context();}catch{this.#reply(res,423);return;}this.#prune();
      if(req.method==="POST"&&req.url==="/api/local/v1/exchange"){const answer=await answerLocalExchange(context,await this.#body(req),this.crypto);this.#context();this.changed();this.#reply(res,200,answer);return;}
      const match=/^\/api\/v2\/join\/([a-f0-9]{64})(?:\/(request|enrollment))?$/.exec(req.url??""),box=match===null?undefined:this.#mailboxes.get(match[1]!);
      if(match===null||box===undefined){this.#reply(res,404,{error:{code:"join_not_found"}});return;}
      if(req.method==="GET"&&match[2]===undefined){this.#reply(res,200,box.offer);return;}
      if(req.method==="GET"&&match[2]==="enrollment"){this.#reply(res,box.enrollment===undefined?204:200,box.enrollment);return;}
      if(req.method==="POST"&&match[2]==="request"){
        const parsed=joinRequestSchema.safeParse(await this.#body(req));if(!parsed.success){this.#reply(res,400);return;}
        if(box.requestDigest!==undefined&&box.requestDigest!==parsed.data.request.digest){this.#reply(res,409,{error:{code:"join_conflict"}});return;}
        const candidate=await inspectJoinCandidate(parsed.data,this.crypto,box.start);this.#context();box.candidate=candidate;box.requestDigest=parsed.data.request.digest;this.changed();this.#reply(res,204);return;
      }
      this.#reply(res,405);
    }finally{this.#busy--;}
  }
}
