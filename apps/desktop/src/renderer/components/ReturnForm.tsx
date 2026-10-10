import { useEffect, useRef, useState } from "react";
import { moneyEntry, quantityEntry, quantityInput } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import type { ReturnRequest, ShopService } from "../../shared/service.ts";
import { ErrorText, ReadState, Select, call, useAction, useRead, useText } from "./ui.tsx";

/**
 * Partial or full return of a sale or purchase. The preview and the commit both use the host's
 * exact rules; the request names the predecessor it was made from, so a concurrent return makes
 * it stale instead of double-returning. An uncertain outcome freezes the draft for an identical retry.
 * It opens as a modal dialog over the record; Escape or Cancel closes it unless a recording is in flight.
 */
export function ReturnForm({service,sessionId,revision,kind,originalId,onDone}:{readonly service:ShopService;readonly sessionId:string;readonly revision:number;readonly kind:"SALE"|"PURCHASE";readonly originalId:string;readonly onDone:(saved:boolean)=>void}):React.JSX.Element{
  const {t,language}=useText(),action=useAction();
  const [reload,setReload]=useState(0),[quantities,setQuantities]=useState<Record<string,string>>({}),[refundText,setRefundText]=useState<string|null>(null),[accountId,setAccountId]=useState(""),[reason,setReason]=useState("");
  const [uncertain,setUncertain]=useState(false),pending=useRef<ReturnRequest|undefined>(undefined),frozen=action.busy||uncertain;
  const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{dialog.current?.showModal();heading.current?.focus();},[]);
  const source=useRead(()=>service.returnSource({sessionId,kind,originalId}),[service,sessionId,kind,originalId,reload]);
  const accounts=useRead(()=>service.listPaymentAccounts({sessionId,limit:100}),[service,sessionId,revision]);
  let items:{originalItemId:string;quantity:number}[]=[],valid=true;
  try{items=(source.data?.items??[]).map(item=>({originalItemId:item.id,quantity:quantityEntry(quantities[item.id]??"0")})).filter(item=>item.quantity>0);}catch{valid=false;}
  const key=JSON.stringify(items);
  const preview=useRead(()=>items.length===0||!valid?Promise.resolve({ok:true as const,value:null}):service.previewReturn({sessionId,kind,originalId,items}),[service,sessionId,kind,originalId,key,reload]);
  const total=preview.data?.totalMinor??0,counterparty=source.data?.hasCounterparty===true,refundable=source.data?.refundableMinor??0;
  let refund=0;try{refund=refundText===null?(counterparty?0:total):refundText.trim()===""?0:moneyEntry(refundText);}catch{valid=false;}
  const account=accountId||accounts.data?.items[0]?.id||"",remainder=total-refund;
  const blocker=refund>total?"refundTooLarge":refund>refundable?"refundExceedsPaid":remainder>0&&!counterparty?"needsFullRefund":undefined;
  const change=(next:()=>void):void=>{pending.current=undefined;next();action.setError(undefined);};
  const submit=async():Promise<void>=>{
    const saved=await action.run(async()=>{
      pending.current??={sessionId,requestId:crypto.randomUUID(),kind,originalId,...(source.data?.priorId===undefined?{}:{priorId:source.data.priorId}),reason,items,...(refund>0?{refund:{accountId:account,amountMinor:refund}}:{})};
      const result=await call(()=>service.recordReturn(pending.current!));
      setUncertain(!result.ok&&result.error.code==="unavailable");
      if(result.ok)pending.current=undefined;return result;
    });
    if(saved!==undefined)onDone(true);
  };
  const remaining=(source.data?.items??[]).filter(item=>item.originalQuantity>item.returnedQuantity);
  return <dialog ref={dialog} className="form-dialog return-form" aria-labelledby="return-title" onCancel={event=>{event.preventDefault();if(!frozen)onDone(false);}}><h2 id="return-title" ref={heading} tabIndex={-1}>{t(kind==="SALE"?"returnItems":"returnGoods")}</h2>
    <ReadState loading={source.loading} error={source.error} empty={remaining.length===0} emptyText={t("nothingReturnable")} retry={source.retry}>
      <form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={frozen}>
        <div className="actions spaced"><button type="button" className="secondary" onClick={()=>change(()=>setQuantities(Object.fromEntries(remaining.map(item=>[item.id,quantityInput(item.originalQuantity-item.returnedQuantity)]))))}>{t("fullReturn")}</button></div>
        <div className="table-wrap"><table><thead><tr><th>{t("name")}</th><th className="numeric">{t("returnable")}</th><th>{t("returnQuantity")}</th></tr></thead><tbody>
          {remaining.map(item=><tr key={item.id}><td>{item.name}</td><td className="numeric">{formatQuantity(item.originalQuantity-item.returnedQuantity,language)}</td>
            <td><input className="cell-input" aria-label={`${t("returnQuantity")} · ${item.name}`} inputMode="decimal" value={quantities[item.id]??""} placeholder="0" onChange={event=>change(()=>setQuantities(current=>({...current,[item.id]:event.target.value})))}/></td></tr>)}
        </tbody></table></div>
        <div className="total-line"><span>{t("returnValue")}</span><strong>{preview.data?formatMoney(total,language):"—"}</strong></div>
        {preview.data&&<><div className="two-fields"><label className="field" htmlFor="return-refund"><span>{t(kind==="SALE"?"refundSale":"refundPurchase")}</span><input id="return-refund" inputMode="decimal" autoComplete="off" value={refundText??String(refund)} onChange={event=>change(()=>setRefundText(event.target.value))}/></label>
          {counterparty&&<p className="hint">{t("refundableUpTo")} {formatMoney(Math.min(total,refundable),language)}</p>}
          {refund>0&&<Select id="return-account" label={t("refundAccount")} value={account} onChange={value=>change(()=>setAccountId(value))} options={(accounts.data?.items??[]).map(item=>({value:item.id,label:item.name}))}/>}</div>
          {remainder>0&&counterparty&&<div className="settlement-line"><span>{t(kind==="SALE"?"toCustomerAccount":"toSupplierAccount")}</span><strong>{formatMoney(remainder,language)}</strong></div>}</>}
        <label className="field" htmlFor="return-reason"><span>{t("reason")}</span><input id="return-reason" value={reason} maxLength={200} required onChange={event=>change(()=>setReason(event.target.value))}/></label>
      </fieldset>
      {blocker!==undefined&&<p className="hint negative">{t(blocker)}</p>}{preview.error!==undefined&&<ErrorText message={preview.error}/>}<ErrorText message={action.error}/>
      <div className="actions"><button className="primary" type="submit" disabled={action.busy||!valid||!uncertain&&(preview.data==null||blocker!==undefined||refund>0&&account===""||reason.trim()==="")}>{action.busy?t("recording"):uncertain?t("retry"):t("recordReturn")}</button>
        {action.error?.code==="stale_return"&&<button type="button" className="secondary" onClick={()=>{pending.current=undefined;action.setError(undefined);setReload(value=>value+1);}}>{t("reload")}</button>}
        <button type="button" className="secondary" disabled={frozen} onClick={()=>onDone(false)}>{t("cancel")}</button></div></form>
    </ReadState></dialog>;
}
