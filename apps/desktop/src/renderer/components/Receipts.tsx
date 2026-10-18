import { useState } from "react";
import type { Cursor } from "@kolo/core/application/queries";
import { formatMoney, formatQuantity, formatRate } from "@kolo/core/domain/money";
import { shortReceiptNumber } from "@kolo/core/domain/receipt-number";
import type { ShopService } from "../../shared/service.ts";
import { BackToList, Pager, ReadState, useRead, useRevealDetail, useText } from "./ui.tsx";
import { ReturnForm } from "./ReturnForm.tsx";
import { Balance } from "./Customers.tsx";

/** Saved receipts come from persisted historical facts, never from the cart draft. */
export function Receipts({service,sessionId,revision,initialId,canReturn,shopName,onNewSale}:{readonly service:ShopService;readonly sessionId:string;readonly revision:number;readonly initialId:string|undefined;readonly canReturn:boolean;readonly shopName:string|null;readonly onNewSale:()=>void}):React.JSX.Element{
  const {t,language}=useText(),[selected,setSelected]=useState(initialId),[cursor,setCursor]=useState<{after:Cursor;revision:number}>(),[returning,setReturning]=useState<string>();
  const history=useRead(()=>service.listReceipts({sessionId,...(cursor?.revision===revision?{after:cursor.after}: {})}),[service,sessionId,cursor,revision]);
  const detail=useRead(()=>selected===undefined?Promise.resolve({ok:true as const,value:null}):service.getReceipt({sessionId,saleId:selected}),[service,sessionId,selected,revision]),detailPanel=useRevealDetail(selected);
  return <section className="workspace-content"><div className="section-heading"><div><p className="eyebrow">{t("receipts")}</p><h1>{selected===undefined?t("receiptHistory"):t("savedReceipt")}</h1><p className="muted">{t("receiptHistoryHelp")}</p></div><button className="primary" onClick={onNewSale}>{t("newSale")} →</button></div>
    <div className={`record-layout${selected===undefined?"":" with-detail"}`}><div className="panel receipt-list"><h2>{t("receiptHistory")}</h2><ReadState loading={history.loading} error={history.error} empty={history.data?.items.length===0} emptyText={t("noReceipts")} retry={history.retry}>
      <div className="table-wrap"><table><thead><tr><th>{t("date")}</th><th>{t("receipt")}</th><th>{t("customer")}</th><th className="numeric">{t("total")}</th><th className="numeric">{t("paidAtSale")}</th><th className="numeric">{t("onAccountAtSale")}</th></tr></thead><tbody>
        {history.data?.items.map(item=><tr key={item.id} className={selected===item.id?"selected-row":""}>
          <td><button className="row-link" aria-pressed={selected===item.id} onClick={()=>setSelected(item.id)}>{new Date(item.occurredAt).toLocaleString(language==="fr"?"fr-FR":"en-GB")}</button></td>
          <td className="receipt-number" title={item.number}>{shortReceiptNumber(item.number)}</td><td>{item.customerName??"—"}</td><td className="numeric money">{formatMoney(item.totalMinor,language)}</td><td className="numeric money">{formatMoney(item.paidMinor,language)}</td><td className="numeric money">{formatMoney(item.outstandingMinor,language)}</td></tr>)}
      </tbody></table></div>
    </ReadState><Pager hasFirst={cursor!==undefined} hasNext={history.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(history.data?.next)setCursor({after:history.data.next,revision});}}/></div>
    {selected!==undefined&&<div className="panel receipt-paper" ref={detailPanel}><BackToList label={t("receiptHistory")} onBack={()=>setSelected(undefined)}/><ReadState loading={detail.loading} error={detail.error} empty={detail.data===null} emptyText={t("noResults")} retry={detail.retry}>
      {detail.data&&<><div className="receipt-header"><span className="brand">{shopName??"KOLO"}</span><h2>{t("receipt")}</h2><p className="receipt-number">{detail.data.number}</p><p className="muted">{new Date(detail.data.occurredAt).toLocaleString(language==="fr"?"fr-FR":"en-GB")}</p>{detail.data.customerName!==undefined&&<p className="receipt-customer">{t("customer")} · {detail.data.customerName}</p>}</div>
        {detail.data.lines.map(line=><div className="receipt-line" key={line.id}><strong>{line.name}</strong><span>{formatQuantity(line.quantity,language)} × {formatMoney(line.unitPriceMinor,language)}</span></div>)}
        {detail.data.discountMinor>0&&<div className="receipt-line"><span>{t("discountLabel")}</span><strong>−{formatMoney(detail.data.discountMinor,language)}</strong></div>}
        <div className="receipt-total"><span>{t("total")}</span><strong>{formatMoney(detail.data.totalMinor,language)}</strong></div>
        {detail.data.tax?.groups.map(group=><div className="receipt-line receipt-tax" key={group.rateBasisPoints}><span>{t("taxIncluded")} {detail.data!.tax!.label} {formatRate(group.rateBasisPoints,language)}</span><strong>{formatMoney(group.taxMinor,language)}</strong></div>)}
        {detail.data.tax?.registration!==undefined&&<p className="hint receipt-tax-number">{t("taxNumberShort")} {detail.data.tax.registration}</p>}
        {detail.data.payments.map(payment=><div className="receipt-line" key={payment.id}><span>{t("paid")} · {payment.name}</span><strong>{formatMoney(payment.amountMinor,language)}</strong></div>)}
        {detail.data.changeKeptMinor!==undefined&&<div className="receipt-line receipt-kept-change"><span>{t("changeKept")}</span><strong>{formatMoney(detail.data.changeKeptMinor,language)}</strong></div>}
        {detail.data.customerAccount!==undefined?<>
          <div className="receipt-line"><span>{t("balanceBeforeSale")}</span><Balance value={detail.data.customerAccount.balanceBeforeMinor}/></div>
          {detail.data.customerAccount.creditAppliedMinor>0&&<div className="receipt-line"><span>{t("creditApplied")}</span><strong>{formatMoney(detail.data.customerAccount.creditAppliedMinor,language)}</strong></div>}
          {detail.data.customerAccount.debtAddedMinor>0&&<div className="receipt-line receipt-owing"><span>{t("newDebt")}</span><strong>{formatMoney(detail.data.customerAccount.debtAddedMinor,language)}</strong></div>}
          <div className="receipt-line"><span>{t("balanceAfterSale")}</span><Balance value={detail.data.customerAccount.balanceAfterMinor}/></div>
        </>:detail.data.outstandingMinor>0&&<div className="receipt-line receipt-owing"><span>{t("onAccountAtSale")}</span><strong>{formatMoney(detail.data.outstandingMinor,language)}</strong></div>}
        {detail.data.returnedMinor>0&&<div className="receipt-line"><span>{t("returned")}</span><strong>−{formatMoney(detail.data.returnedMinor,language)}</strong></div>}
        <button className="secondary full-width no-print" onClick={()=>window.print()}>{t("printReceipt")}</button>
        {canReturn&&returning!==detail.data.id&&<button className="secondary full-width no-print" onClick={()=>setReturning(detail.data!.id)}>{t("returnItems")}</button>}
        <p className="local-line no-print"><span className="status-dot"/>{t("receiptHelp")}</p>
        <p className="receipt-brand">{t("receiptThanks")}<span>{t("receiptGenerated")} <strong>kolo</strong> · {t("receiptMadeBy")} hblabs</span></p></>}
    </ReadState></div>}
    {returning!==undefined&&returning===selected&&<ReturnForm key={returning} service={service} sessionId={sessionId} revision={revision} kind="SALE" originalId={returning} onDone={()=>setReturning(undefined)}/>}
    </div>
  </section>;
}
