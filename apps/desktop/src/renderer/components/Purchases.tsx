import { useEffect, useRef, useState } from "react";
import { moneyEntry, quantityEntry } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import { lineTotal, subtotalOf } from "@kolo/core/rules/pricing";
import type { Cursor } from "@kolo/core/application/queries";
import type { Permission } from "@kolo/core/identity/permissions";
import type { ProductView, PurchaseRequest, Result, ShopService, SupplierDetails, SupplierView } from "../../shared/service.ts";
import { ErrorText, Field, Pager, ReadState, Select, call, useAction, useRead, useText } from "./ui.tsx";
import { Balance, Statement } from "./Customers.tsx";
import { ReturnForm } from "./ReturnForm.tsx";

type Props = { readonly service: ShopService; readonly sessionId: string; readonly revision: number; readonly permissions: readonly Permission[] };

/** Deliveries at cost with door payments or supplier payables, and supplier management. */
export function Purchases({ service, sessionId, revision, permissions }: Props): React.JSX.Element {
  const { t } = useText();
  const canPurchases=permissions.includes("purchases.view"),canSuppliers=permissions.includes("suppliers.view");
  const [tab,setTab]=useState<"purchases"|"suppliers">(canPurchases?"purchases":"suppliers"),[recording,setRecording]=useState(false);
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("purchases")}</p><h1>{t("purchasesHelp")}</h1></div>
      {tab==="purchases"&&permissions.includes("purchases.create")&&<button className="primary" onClick={()=>setRecording(true)}>+ {t("newPurchase")}</button>}</div>
    <div className="tabs" role="tablist">{([["purchases",canPurchases,"purchaseList"],["suppliers",canSuppliers,"suppliers"]] as const).filter(([,allowed])=>allowed).map(([id,,label])=>
      <button key={id} role="tab" aria-selected={tab===id} className={tab===id?"selected":""} onClick={()=>setTab(id)}>{t(label)}</button>)}</div>
    <div hidden={tab!=="purchases"}>
      {recording&&<RecordPurchase service={service} sessionId={sessionId} revision={revision} permissions={permissions} onClose={()=>setRecording(false)}/>}
      {canPurchases&&<PurchaseHistory service={service} sessionId={sessionId} revision={revision} canReturn={permissions.includes("purchases.create")&&permissions.includes("purchases.pay")}/>}
    </div>
    {canSuppliers&&<div hidden={tab!=="suppliers"}><Suppliers service={service} sessionId={sessionId} revision={revision} permissions={permissions}/></div>}
  </section>;
}
function PurchaseHistory({service,sessionId,revision,canReturn}:{service:ShopService;sessionId:string;revision:number;canReturn:boolean}):React.JSX.Element{
  const {t,language}=useText();
  const [cursor,setCursor]=useState<{ after: Cursor; revision: number }>(),[selected,setSelected]=useState<string>(),[returning,setReturning]=useState<string>();
  const list=useRead(()=>service.listPurchases({sessionId,...(cursor?.revision===revision?{after:cursor.after}:{})}),[service,sessionId,cursor,revision]);
  const detail=useRead(()=>selected===undefined?Promise.resolve({ok:true as const,value:null}):service.getPurchase({sessionId,purchaseId:selected}),[service,sessionId,selected,revision]);
  const date=(value:string):string=>new Date(value).toLocaleString(language==="fr"?"fr-FR":"en-GB");
  return <div className={`record-layout${selected===undefined?"":" with-detail"}`}><div className="panel"><h2>{t("purchaseList")}</h2>
    <ReadState loading={list.loading} error={list.error} empty={list.data?.items.length===0} emptyText={t("noPurchases")} retry={list.retry}>
      <div className="table-wrap"><table><thead><tr><th>{t("date")}</th><th>{t("supplier")}</th><th>{t("referenceLabel")}</th><th>{t("total")}</th></tr></thead><tbody>
        {list.data?.items.map(item=><tr key={item.id} className={selected===item.id?"selected-row":""}><td><button className="row-link" onClick={()=>setSelected(item.id)}>{date(item.occurredAt)}</button></td>
          <td>{item.supplierName||"—"}</td><td>{item.reference||"—"}</td><td className="money">{formatMoney(item.totalMinor,language)}</td></tr>)}
      </tbody></table></div>
    </ReadState>
    <Pager hasFirst={cursor!==undefined} hasNext={list.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(list.data?.next)setCursor({after:list.data.next,revision});}}/></div>
    {selected!==undefined&&<div className="panel receipt-paper purchase-detail"><ReadState loading={detail.loading} error={detail.error} empty={detail.data===null} emptyText={t("noResults")} retry={detail.retry}>
      {detail.data&&<><div className="receipt-header"><h2>{t("purchase")}</h2><p className="muted">{date(detail.data.occurredAt)}</p>
        <p className="receipt-customer">{detail.data.supplierName||t("noSupplier")}{detail.data.reference===""?"":` · ${detail.data.reference}`}</p></div>
        {detail.data.lines.map(line=><div className="receipt-line" key={line.id}><strong>{line.name}</strong><span>{formatQuantity(line.quantity,language)} × {formatMoney(line.unitCostMinor,language)}</span></div>)}
        <div className="receipt-total"><span>{t("total")}</span><strong>{formatMoney(detail.data.totalMinor,language)}</strong></div>
        {detail.data.paidMinor>0&&<div className="receipt-line"><span>{t("paid")}</span><strong>{formatMoney(detail.data.paidMinor,language)}</strong></div>}
        {detail.data.outstandingMinor>0&&<div className="receipt-line receipt-owing"><span>{t("owedToSupplier")}</span><strong>{formatMoney(detail.data.outstandingMinor,language)}</strong></div>}
        {canReturn&&returning!==detail.data.id&&<button className="secondary full-width" onClick={()=>setReturning(detail.data!.id)}>{t("returnGoods")}</button>}</>}
    </ReadState></div>}
    {returning!==undefined&&returning===selected&&<ReturnForm key={returning} service={service} sessionId={sessionId} revision={revision} kind="PURCHASE" originalId={returning} onDone={()=>setReturning(undefined)}/>}
  </div>;
}
type DraftLine={readonly product:ProductView;readonly quantityText:string;readonly costText:string};
/** One stable request per draft; an uncertain outcome freezes the draft so the identical request can be retried. */
function RecordPurchase({service,sessionId,revision,permissions,onClose}:Props&{onClose:()=>void}):React.JSX.Element{
  const {t,language}=useText(),action=useAction(),canPay=permissions.includes("purchases.pay");
  const [supplier,setSupplier]=useState<SupplierView>(),[reference,setReference]=useState(""),[lines,setLines]=useState<readonly DraftLine[]>([]),[term,setTerm]=useState("");
  const [paidText,setPaidText]=useState<string|null>(null),[accountId,setAccountId]=useState(""),[uncertain,setUncertain]=useState(false);
  const pending=useRef<PurchaseRequest|undefined>(undefined),frozen=action.busy||uncertain;
  const found=useRead(()=>term.trim()===""?Promise.resolve({ok:true as const,value:{items:[]}}):service.listProducts({sessionId,term,limit:6}),[service,sessionId,term,revision]);
  const accounts=useRead(()=>canPay?service.listPaymentAccounts({sessionId,limit:100}):Promise.resolve({ok:true as const,value:{items:[]}}),[service,sessionId,canPay]);
  const account=accountId||accounts.data?.items[0]?.id||"";
  const change=(next:readonly DraftLine[]):void=>{pending.current=undefined;setLines(next);action.setError(undefined);};
  let total=0,valid=true,paid=0;
  try{total=subtotalOf(lines.map(line=>({unitPriceMinor:moneyEntry(line.costText),quantity:quantityEntry(line.quantityText,line.product.divisible)})));}catch{valid=false;}
  try{paid=!canPay?0:paidText===null?total:paidText.trim()===""?0:moneyEntry(paidText);}catch{valid=false;}
  const owed=total-paid,blocker=lines.length===0?"noPurchaseLines":!valid?undefined:owed<0?"overpaid":owed>0&&supplier===undefined?"needsSupplier":undefined;
  const submit=async():Promise<void>=>{
    await action.run(async()=>{
      try{pending.current??={sessionId,requestId:crypto.randomUUID(),...(supplier===undefined?{}:{supplierId:supplier.id}),...(reference.trim()===""?{}:{reference:reference.trim()}),
        lines:lines.map(line=>({productId:line.product.id,quantity:quantityEntry(line.quantityText,line.product.divisible),unitCostMinor:moneyEntry(line.costText)})),
        ...(paid>0?{payment:{accountId:account,amountMinor:paid}}:{})};}
      catch{return {ok:false,error:{code:"invalid_input"}};}
      const result=await call(()=>service.recordPurchase(pending.current!));
      setUncertain(!result.ok&&result.error.code==="unavailable");
      if(result.ok){pending.current=undefined;onClose();}return result;
    });
  };
  return <div className="panel form-panel purchase-form"><h2>{t("newPurchase")}</h2><form onSubmit={event=>{event.preventDefault();void submit();}}>
    <fieldset disabled={frozen}>
      <div className="two-fields"><PartyChoice service={service} sessionId={sessionId} revision={revision} value={supplier} disabled={frozen} onChange={value=>{pending.current=undefined;setSupplier(value);}}/>
        <Field id="purchase-reference" label={t("reference")} value={reference} required={false} onChange={value=>{pending.current=undefined;setReference(value);}}/></div>
      <Field id="purchase-product" label={t("findProduct")} value={term} required={false} onChange={setTerm}/>
      {(found.data?.items.length??0)>0&&<ul className="customer-results">{found.data!.items.map(product=><li key={product.id}><button type="button" onClick={()=>{setTerm("");
        if(!lines.some(line=>line.product.id===product.id))change([...lines,{product,quantityText:"1",costText:String(product.purchasePriceMinor??"")}]);}}><strong>{product.name}</strong><small>{product.unit}</small></button></li>)}</ul>}
      {lines.length>0&&<div className="table-wrap"><table><thead><tr><th>{t("name")}</th><th>{t("quantity")}</th><th>{t("unitCostShort")}</th><th>{t("lineTotal")}</th><th/></tr></thead><tbody>
        {lines.map(line=>{let amount="—";try{amount=formatMoney(lineTotal({unitPriceMinor:moneyEntry(line.costText),quantity:quantityEntry(line.quantityText,line.product.divisible)}),language);}catch{/* Incomplete input stays editable. */}
          return <tr key={line.product.id}><td><strong>{line.product.name}</strong><small>{line.product.unit}</small></td>
            <td><input className="cell-input" aria-label={`${t("quantity")} · ${line.product.name}`} inputMode="decimal" value={line.quantityText} onChange={event=>change(lines.map(item=>item.product.id===line.product.id?{...item,quantityText:event.target.value}:item))}/></td>
            <td><input className="cell-input" aria-label={`${t("unitCostShort")} · ${line.product.name}`} inputMode="decimal" value={line.costText} onChange={event=>change(lines.map(item=>item.product.id===line.product.id?{...item,costText:event.target.value}:item))}/></td>
            <td className="money">{amount}</td><td><button type="button" className="icon-button" aria-label={`${t("remove")}: ${line.product.name}`} onClick={()=>change(lines.filter(item=>item.product.id!==line.product.id))}>×</button></td></tr>;})}
      </tbody></table></div>}
      <div className="total-line"><span>{t("total")}</span><strong>{valid?formatMoney(total,language):"—"}</strong></div>
      {canPay?<div className="two-fields"><Field id="purchase-paid" label={t("paidNow")} value={paidText??(valid?String(total):"")} numeric required={false} onChange={value=>{pending.current=undefined;setPaidText(value);}}/>
        <ReadState loading={accounts.loading} error={accounts.error} empty={accounts.data?.items.length===0} emptyText={t("noAccounts")} retry={accounts.retry}>
          <Select id="purchase-account" label={t("account")} value={account} onChange={value=>{pending.current=undefined;setAccountId(value);}} options={(accounts.data?.items??[]).map(item=>({value:item.id,label:item.name}))}/></ReadState></div>
        :<p className="hint">{t("noPurchasePay")}</p>}
      {valid&&owed>0&&<div className="settlement-line"><span>{t("owedToSupplier")}</span><strong>{formatMoney(owed,language)}</strong></div>}
    </fieldset>
    {blocker!==undefined&&<p className="hint negative">{t(blocker)}</p>}<ErrorText message={action.error}/>
    <div className="actions"><button className="primary" type="submit" disabled={action.busy||!valid||!uncertain&&(blocker!==undefined||paid>0&&account==="")}>{action.busy?t("recording"):uncertain?t("retry"):t("recordPurchase")}</button>
      <button type="button" className="secondary" disabled={frozen} onClick={onClose}>{t("cancel")}</button></div>
  </form></div>;
}
/** Supplier search for a delivery; payables stay visible once chosen. */
function PartyChoice({service,sessionId,revision,value,disabled,onChange}:{service:ShopService;sessionId:string;revision:number;value:SupplierView|undefined;disabled:boolean;onChange:(value:SupplierView|undefined)=>void}):React.JSX.Element{
  const {t}=useText(),[term,setTerm]=useState("");
  const found=useRead(()=>term.trim()===""?Promise.resolve({ok:true as const,value:{items:[]}}):service.listSuppliers({sessionId,term,limit:5}),[service,sessionId,term,revision]);
  if(value!==undefined)return <div className="customer-choice"><div><span className="eyebrow">{t("supplier")}</span><strong>{value.name}</strong><small>{t("balance")}: <Balance value={value.outstandingMinor} owedLabel="toPay"/></small></div>
    <button type="button" className="icon-button" disabled={disabled} aria-label={t("clearSupplier")} onClick={()=>onChange(undefined)}>×</button></div>;
  return <div className="customer-search"><Field id="supplier-search" label={t("findSupplier")} value={term} required={false} disabled={disabled} onChange={setTerm}/>
    {(found.data?.items.length??0)>0&&<ul className="customer-results">{found.data!.items.map(item=><li key={item.id}><button type="button" disabled={disabled} onClick={()=>{onChange(item);setTerm("");}}><strong>{item.name}</strong><small>{item.contact??item.phone??""}</small></button></li>)}</ul>}</div>;
}
function Suppliers({service,sessionId,revision,permissions}:Props):React.JSX.Element{
  const {t}=useText();
  const [term,setTerm]=useState(""),[archived,setArchived]=useState(false),[cursor,setCursor]=useState<{ after: Cursor; revision: number }>(),[selectedId,setSelectedId]=useState<string>(),[creating,setCreating]=useState(false);
  const list=useRead(()=>service.listSuppliers({sessionId,term,includeInactive:archived,...(cursor?.revision===revision?{after:cursor.after}:{})}),[service,sessionId,term,archived,cursor,revision]);
  return <>{selectedId===undefined&&permissions.includes("suppliers.manage")&&!creating&&<div className="actions spaced"><button className="secondary" onClick={()=>setCreating(true)}>+ {t("newSupplier")}</button></div>}
    {creating&&<SupplierForm service={service} sessionId={sessionId} onDone={value=>{setCreating(false);if(value!==undefined)setSelectedId(value.id);}}/>}
    <div className="panel" hidden={selectedId!==undefined}><Field id="supplier-list-search" label={t("findSupplier")} value={term} required={false} onChange={value=>{setTerm(value);setCursor(undefined);}}/>
      <label className="check"><input type="checkbox" checked={archived} onChange={event=>{setArchived(event.target.checked);setCursor(undefined);}}/>{t("showArchived")}</label>
      <ReadState loading={list.loading} error={list.error} empty={list.data?.items.length===0} emptyText={t("noSuppliers")} retry={list.retry}>
        <div className="table-wrap"><table><thead><tr><th>{t("supplierName")}</th><th>{t("contactLabel")}</th><th>{t("balance")}</th></tr></thead><tbody>
          {list.data?.items.map(item=><tr key={item.id}><td><button className="row-link" onClick={()=>setSelectedId(item.id)}><strong>{item.name}</strong></button>{!item.active&&<span className="tag">{t("archived")}</span>}</td>
            <td>{item.contact??item.phone??"—"}</td><td><Balance value={item.outstandingMinor} owedLabel="toPay"/></td></tr>)}
        </tbody></table></div>
      </ReadState>
      <Pager hasFirst={cursor!==undefined} hasNext={list.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(list.data?.next)setCursor({after:list.data.next,revision});}}/></div>
    {selectedId!==undefined&&<SupplierDetail key={selectedId} service={service} sessionId={sessionId} revision={revision} permissions={permissions} supplierId={selectedId} onBack={()=>setSelectedId(undefined)}/>}
  </>;
}
function SupplierDetail({service,sessionId,revision,permissions,supplierId,onBack}:Props&{supplierId:string;onBack:()=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const read=useRead(()=>service.getSupplier({sessionId,supplierId}),[service,sessionId,supplierId,revision]);
  const [shown,setShown]=useState<SupplierView>(),[editing,setEditing]=useState<SupplierView>();
  useEffect(()=>{if(read.data!==undefined)setShown(read.data);},[read.data]);
  const canManage=permissions.includes("suppliers.manage");
  if(shown===undefined)return <div className="panel"><button className="secondary" onClick={onBack}>← {t("back")}</button><ReadState loading={read.loading} error={read.error} empty={false} emptyText="" retry={read.retry}>{null}</ReadState></div>;
  const details:SupplierDetails={name:shown.name,...(shown.phone===undefined?{}:{phone:shown.phone}),...(shown.address===undefined?{}:{address:shown.address}),...(shown.contact===undefined?{}:{contact:shown.contact}),...(shown.notes===undefined?{}:{notes:shown.notes})};
  return <div className="detail-layout">
    <div className="panel"><div className="detail-heading"><button className="secondary" onClick={onBack}>← {t("back")}</button>
      {canManage&&<div className="actions">{shown.active&&editing===undefined&&<button className="secondary" onClick={()=>setEditing(shown)}>{t("edit")}</button>}
        <button className="secondary" disabled={action.busy} onClick={()=>{void action.run(()=>service.updateSupplier({sessionId,supplierId,version:shown.version,active:!shown.active,...details})).then(value=>{if(value!==undefined){setShown(value);setEditing(undefined);}});}}>{t(shown.active?"archive":"restore")}</button></div>}</div>
      <h2>{shown.name}{!shown.active&&<span className="tag">{t("archived")}</span>}</h2>
      <ErrorText message={action.error} conflictMessage="staleVersion"/>{!shown.active&&<p className="notice">{t("archivedSupplier")}</p>}
      <dl className="facts"><dt>{t("balance")}</dt><dd><Balance value={shown.outstandingMinor} owedLabel="toPay"/></dd><dt>{t("contactLabel")}</dt><dd>{shown.contact??"—"}</dd>
        <dt>{t("phoneLabel")}</dt><dd>{shown.phone??"—"}</dd><dt>{t("addressLabel")}</dt><dd>{shown.address??"—"}</dd><dt>{t("notesLabel")}</dt><dd>{shown.notes??"—"}</dd></dl>
    </div>
    {editing!==undefined&&<SupplierForm key={editing.version} service={service} sessionId={sessionId} supplier={editing} onReload={()=>setEditing(shown)} onDone={value=>{if(value!==undefined)setShown(value);setEditing(undefined);}}/>}
    {shown.active&&permissions.includes("purchases.pay")&&<PaySupplier service={service} sessionId={sessionId} supplier={shown} onSaved={setShown}/>}
    <Statement service={service} sessionId={sessionId} revision={revision} kind="supplier" id={supplierId}/>
  </div>;
}
function SupplierForm({service,sessionId,supplier,onReload,onDone}:{service:ShopService;sessionId:string;supplier?:SupplierView;onReload?:()=>void;onDone:(value:SupplierView|undefined)=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [name,setName]=useState(supplier?.name??""),[contact,setContact]=useState(supplier?.contact??""),[phone,setPhone]=useState(supplier?.phone??""),[address,setAddress]=useState(supplier?.address??""),[notes,setNotes]=useState(supplier?.notes??"");
  const [requestId]=useState(()=>crypto.randomUUID()),[uncertain,setUncertain]=useState(false);
  const submit=async():Promise<void>=>{
    const value=await action.run(async():Promise<Result<SupplierView>>=>{
      const details:SupplierDetails={name,...(contact.trim()===""?{}:{contact:contact.trim()}),...(phone.trim()===""?{}:{phone:phone.trim()}),...(address.trim()===""?{}:{address:address.trim()}),...(notes.trim()===""?{}:{notes:notes.trim()})};
      const result=await (supplier===undefined?service.createSupplier({sessionId,requestId,...details}):service.updateSupplier({sessionId,supplierId:supplier.id,version:supplier.version,active:supplier.active,...details}))
        .catch(():Result<never>=>({ok:false,error:{code:"unavailable"}}));
      setUncertain(supplier===undefined&&!result.ok&&result.error.code==="unavailable");return result;
    });
    if(value!==undefined)onDone(value);
  };
  return <div className="panel form-panel"><h2>{t(supplier===undefined?"newSupplier":"editSupplier")}</h2><form onSubmit={event=>{event.preventDefault();void submit();}}>
    <fieldset disabled={action.busy||uncertain}><div className="two-fields"><Field id="supplier-name" label={t("supplierName")} value={name} onChange={setName}/><Field id="supplier-contact" label={t("contact")} value={contact} onChange={setContact} required={false}/></div>
      <div className="two-fields"><Field id="supplier-phone" label={t("phone")} value={phone} onChange={setPhone} required={false} maxLength={40}/><Field id="supplier-address" label={t("address")} value={address} onChange={setAddress} required={false} maxLength={200}/></div>
      <Field id="supplier-notes" label={t("notes")} value={notes} onChange={setNotes} required={false} maxLength={500}/></fieldset>
    <ErrorText message={action.error} {...(supplier===undefined?{}:{conflictMessage:"staleVersion" as const})}/><div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):uncertain?t("retry"):t("save")}</button>
      {action.error?.code==="request_conflict"&&onReload!==undefined&&<button type="button" className="secondary" onClick={onReload}>{t("reload")}</button>}
      <button type="button" className="secondary" disabled={action.busy||uncertain} onClick={()=>onDone(undefined)}>{t("cancel")}</button></div>
  </form></div>;
}
function PaySupplier({service,sessionId,supplier,onSaved}:{service:ShopService;sessionId:string;supplier:SupplierView;onSaved:(value:SupplierView)=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const accounts=useRead(()=>service.listPaymentAccounts({sessionId,limit:100}),[service,sessionId]);
  const [amount,setAmount]=useState(supplier.outstandingMinor>0?String(supplier.outstandingMinor):""),[accountId,setAccountId]=useState(""),[note,setNote]=useState(""),[requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const [uncertain,setUncertain]=useState(false),[saved,setSaved]=useState(false),account=accountId||accounts.data?.items[0]?.id||"";
  const submit=async():Promise<void>=>{
    setSaved(false);
    const value=await action.run(async():Promise<Result<SupplierView>>=>{
      let amountMinor:number;try{amountMinor=moneyEntry(amount);}catch{return {ok:false,error:{code:"invalid_input"}};}
      const result=await service.paySupplier({sessionId,requestId,supplierId:supplier.id,accountId:account,amountMinor,...(note.trim()===""?{}:{note:note.trim()})}).catch(():Result<never>=>({ok:false,error:{code:"unavailable"}}));
      setUncertain(!result.ok&&result.error.code==="unavailable");return result;
    });
    if(value!==undefined){onSaved(value);setAmount("");setNote("");setRequestId(crypto.randomUUID());setSaved(true);}
  };
  return <div className="panel form-panel"><h2>{t("paySupplier")}</h2><ReadState loading={accounts.loading} error={accounts.error} empty={accounts.data?.items.length===0} emptyText={t("noAccounts")} retry={accounts.retry}>
    <form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={action.busy||uncertain}>
      <div className="two-fields"><Field id="supplier-payment-amount" label={t("amount")} value={amount} onChange={setAmount} numeric/>
        <Select id="supplier-payment-account" label={t("account")} value={account} onChange={setAccountId} options={(accounts.data?.items??[]).map(item=>({value:item.id,label:item.name}))}/></div>
      <Field id="supplier-payment-note" label={t("note")} value={note} onChange={setNote} required={false} maxLength={200}/></fieldset>
    <ErrorText message={action.error}/>{saved&&<p role="status" className="notice success">{t("paymentSaved")}</p>}
    <div className="actions"><button className="primary" type="submit" disabled={action.busy||account===""}>{action.busy?t("recording"):uncertain?t("retry"):t("paySupplier")}</button></div></form>
  </ReadState></div>;
}
