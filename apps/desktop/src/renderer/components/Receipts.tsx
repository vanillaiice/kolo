import { useState } from "react";
import type { Cursor } from "@kolo/core/application/queries";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import type { ShopService } from "../../shared/service.ts";
import { Pager, ReadState, useRead, useText } from "./ui.tsx";
import { ReturnForm } from "./ReturnForm.tsx";

/** Saved receipts come from persisted historical facts, never from the cart draft. */
export function Receipts({service,sessionId,revision,initialId,canReturn,shopName,onNewSale}:{readonly service:ShopService;readonly sessionId:string;readonly revision:number;readonly initialId:string|undefined;readonly canReturn:boolean;readonly shopName:string|null;readonly onNewSale:()=>void}):React.JSX.Element{
  const {t,language}=useText(),[selected,setSelected]=useState(initialId),[cursor,setCursor]=useState<{after:Cursor;revision:number}>(),[returning,setReturning]=useState<string>();
  const history=useRead(()=>service.listReceipts({sessionId,...(cursor?.revision===revision?{after:cursor.after}: {})}),[service,sessionId,cursor,revision]);
  const detail=useRead(()=>selected===undefined?Promise.resolve({ok:true as const,value:null}):service.getReceipt({sessionId,saleId:selected}),[service,sessionId,selected,revision]);
  return <section className="workspace-content"><div className="section-heading"><div><p className="eyebrow">{t("receipts")}</p><h1>{selected===undefined?t("receiptHistory"):t("savedReceipt")}</h1><p className="muted">{t("receiptHistoryHelp")}</p></div><button className="primary" onClick={onNewSale}>{t("newSale")} →</button></div>
    <div className="receipt-layout"><div className="panel receipt-list"><h2>{t("receiptHistory")}</h2><ReadState loading={history.loading} error={history.error} empty={history.data?.items.length===0} emptyText={t("noReceipts")} retry={history.retry}>
      {history.data?.items.map(item=><button className={`receipt-choice ${selected===item.id?"selected":""}`} key={item.id} aria-pressed={selected===item.id} onClick={()=>setSelected(item.id)}><strong>{item.number}</strong><small>{new Date(item.occurredAt).toLocaleString(language==="fr"?"fr-FR":"en-GB")}</small></button>)}
    </ReadState><Pager hasFirst={cursor!==undefined} hasNext={history.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(history.data?.next)setCursor({after:history.data.next,revision});}}/></div>
    {selected!==undefined&&<div className="panel receipt-paper"><ReadState loading={detail.loading} error={detail.error} empty={detail.data===null} emptyText={t("noResults")} retry={detail.retry}>
      {detail.data&&<><div className="receipt-header"><span className="brand">{shopName??"KOLO"}</span><h2>{t("receipt")}</h2><p className="receipt-number">{detail.data.number}</p><p className="muted">{new Date(detail.data.occurredAt).toLocaleString(language==="fr"?"fr-FR":"en-GB")}</p>{detail.data.customerName!==undefined&&<p className="receipt-customer">{t("customer")} · {detail.data.customerName}</p>}</div>
        {detail.data.lines.map(line=><div className="receipt-line" key={line.id}><strong>{line.name}</strong><span>{formatQuantity(line.quantity,language)} × {formatMoney(line.unitPriceMinor,language)}</span></div>)}
        {detail.data.discountMinor>0&&<div className="receipt-line"><span>{t("discountLabel")}</span><strong>−{formatMoney(detail.data.discountMinor,language)}</strong></div>}
        <div className="receipt-total"><span>{t("total")}</span><strong>{formatMoney(detail.data.totalMinor,language)}</strong></div>
        {detail.data.payments.map(payment=><div className="receipt-line" key={payment.id}><span>{t("paid")} · {payment.name}</span><strong>{formatMoney(payment.amountMinor,language)}</strong></div>)}
        {detail.data.outstandingMinor>0&&<div className="receipt-line receipt-owing"><span>{t("outstanding")}</span><strong>{formatMoney(detail.data.outstandingMinor,language)}</strong></div>}
        {detail.data.returnedMinor>0&&<div className="receipt-line"><span>{t("returned")}</span><strong>−{formatMoney(detail.data.returnedMinor,language)}</strong></div>}
        <button className="secondary full-width no-print" onClick={()=>window.print()}>{t("printReceipt")}</button>
        {canReturn&&returning!==detail.data.id&&<button className="secondary full-width no-print" onClick={()=>setReturning(detail.data!.id)}>{t("returnItems")}</button>}
        <p className="local-line"><span className="status-dot"/>{t("receiptHelp")}</p></>}
    </ReadState></div>}
    {returning!==undefined&&returning===selected&&<ReturnForm key={returning} service={service} sessionId={sessionId} revision={revision} kind="SALE" originalId={returning} onDone={()=>setReturning(undefined)}/>}
    </div>
  </section>;
}
