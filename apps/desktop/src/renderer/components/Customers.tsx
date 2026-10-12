import { useEffect, useState } from "react";
import { moneyEntry } from "@kolo/core/domain/entry";
import { formatMoney } from "@kolo/core/domain/money";
import { shortReceiptNumber } from "@kolo/core/domain/receipt-number";
import { customerSettlement } from "@kolo/core/rules/customer-settlement";
import { sumAmounts } from "@kolo/core/rules/amounts";
import type { Cursor } from "@kolo/core/application/queries";
import type { Permission } from "@kolo/core/identity/permissions";
import type { CustomerDetails, CustomerView, Result, ShopService } from "../../shared/service.ts";
import type { TextKey } from "../text.ts";
import { ErrorText, Field, Pager, ReadState, Select, useAction, useRead, useText } from "./ui.tsx";
import { CreditTermsPanel } from "./Credit.tsx";

type Props = { readonly service: ShopService; readonly sessionId: string; readonly revision: number; readonly permissions: readonly Permission[] };

/** Customers, balances, payments and statements, backed by bounded host queries. */
export function Customers({ service, sessionId, revision, permissions }: Props): React.JSX.Element {
  const { t } = useText();
  const [selectedId,setSelectedId]=useState<string>(),[creating,setCreating]=useState(false);
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("customers")}</p><h1>{t("customersHelp")}</h1></div>
      {selectedId===undefined&&permissions.includes("customers.manage")&&<button className="primary" onClick={()=>setCreating(true)}>+ {t("newCustomer")}</button>}</div>
    {creating&&<CustomerForm service={service} sessionId={sessionId} onDone={value=>{setCreating(false);if(value!==undefined)setSelectedId(value.id);}}/>}
    <div hidden={selectedId!==undefined}><CustomerList service={service} sessionId={sessionId} revision={revision} onOpen={setSelectedId}/></div>
    {selectedId!==undefined&&<CustomerDetail key={selectedId} service={service} sessionId={sessionId} revision={revision} permissions={permissions} customerId={selectedId} onBack={()=>setSelectedId(undefined)}/>}
  </section>;
}
/** Signed ledger balance: positive is owed (by a customer, or to a supplier), negative is paid in advance. */
export function Balance({value,owedLabel="owes"}:{value:number;owedLabel?:TextKey}):React.JSX.Element{
  const {t,language}=useText();
  return value===0?<span className="money">{formatMoney(0,language)}</span>:<span className={`money ${value>0?"negative":""}`}>{formatMoney(Math.abs(value),language)} <small>{t(value>0?owedLabel:"inAdvance")}</small></span>;
}
function CustomerList({service,sessionId,revision,onOpen}:{service:ShopService;sessionId:string;revision:number;onOpen:(id:string)=>void}):React.JSX.Element{
  const {t}=useText();
  const [term,setTerm]=useState(""),[archived,setArchived]=useState(false),[cursor,setCursor]=useState<{ after: Cursor; revision: number }>();
  const list=useRead(()=>service.listCustomers({sessionId,term,includeInactive:archived,...(cursor?.revision===revision?{after:cursor.after}:{})}),[service,sessionId,term,archived,cursor,revision]);
  return <div className="panel"><Field id="customer-list-search" label={t("findCustomer")} value={term} required={false} onChange={value=>{setTerm(value);setCursor(undefined);}}/>
    <label className="check"><input type="checkbox" checked={archived} onChange={event=>{setArchived(event.target.checked);setCursor(undefined);}}/>{t("showArchived")}</label>
    <ReadState loading={list.loading} error={list.error} empty={list.data?.items.length===0} emptyText={t("noCustomers")} retry={list.retry}>
      <div className="table-wrap"><table><thead><tr><th>{t("customerName")}</th><th>{t("phoneLabel")}</th><th>{t("balance")}</th></tr></thead><tbody>
        {list.data?.items.map(item=><tr key={item.id}><td><button className="row-link" onClick={()=>onOpen(item.id)}><strong>{item.name}</strong></button>{!item.active&&<span className="tag">{t("archived")}</span>}</td>
          <td>{item.phone??"—"}</td><td><Balance value={item.outstandingMinor}/></td></tr>)}
      </tbody></table></div>
    </ReadState>
    <Pager hasFirst={cursor!==undefined} hasNext={list.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(list.data?.next)setCursor({after:list.data.next,revision});}}/>
  </div>;
}
/** One customer: details stay visible while a revision rereads them, and drafts survive rereads. */
function CustomerDetail({service,sessionId,revision,permissions,customerId,onBack}:Props&{customerId:string;onBack:()=>void}):React.JSX.Element{
  const {t,language}=useText(),action=useAction();
  const read=useRead(()=>service.getCustomer({sessionId,customerId}),[service,sessionId,customerId,revision]);
  const [shown,setShown]=useState<CustomerView>(),[editing,setEditing]=useState<CustomerView>();
  useEffect(()=>{if(read.data!==undefined)setShown(read.data);},[read.data]);
  const canManage=permissions.includes("customers.manage");
  if(shown===undefined)return <div className="panel"><button className="secondary" onClick={onBack}>← {t("back")}</button><ReadState loading={read.loading} error={read.error} empty={false} emptyText="" retry={read.retry}>{null}</ReadState></div>;
  const details:CustomerDetails={name:shown.name,...(shown.phone===undefined?{}:{phone:shown.phone}),...(shown.address===undefined?{}:{address:shown.address}),...(shown.notes===undefined?{}:{notes:shown.notes}),...(shown.creditLimitMinor===undefined?{}:{creditLimitMinor:shown.creditLimitMinor})};
  return <div className="detail-layout">
    <div className="panel"><div className="detail-heading"><button className="secondary" onClick={onBack}>← {t("back")}</button>
      {canManage&&<div className="actions">{shown.active&&editing===undefined&&<button className="secondary" onClick={()=>setEditing(shown)}>{t("edit")}</button>}
        <button className="secondary" disabled={action.busy} onClick={()=>{void action.run(()=>service.updateCustomer({sessionId,customerId,version:shown.version,active:!shown.active,...details})).then(value=>{if(value!==undefined){setShown(value);setEditing(undefined);}});}}>{t(shown.active?"archive":"restore")}</button></div>}</div>
      <h2>{shown.name}{!shown.active&&<span className="tag">{t("archived")}</span>}</h2>
      <ErrorText message={action.error} conflictMessage="staleVersion"/>
      {!shown.active&&<p className="notice">{t("archivedCustomer")}</p>}
      <dl className="facts"><dt>{t("balance")}</dt><dd><Balance value={shown.outstandingMinor}/></dd>
        <dt>{t("creditLimitLabel")}</dt><dd>{shown.creditLimitMinor===undefined?t("noLimit"):formatMoney(shown.creditLimitMinor,language)}</dd>
        <dt>{t("phoneLabel")}</dt><dd>{shown.phone??"—"}</dd><dt>{t("addressLabel")}</dt><dd>{shown.address??"—"}</dd><dt>{t("notesLabel")}</dt><dd>{shown.notes??"—"}</dd></dl>
    </div>
    {editing!==undefined&&<CustomerForm key={editing.version} service={service} sessionId={sessionId} customer={editing} onReload={()=>setEditing(shown)} onDone={value=>{if(value!==undefined)setShown(value);setEditing(undefined);}}/>}
    {shown.active&&permissions.includes("customers.pay")&&<TakePayment service={service} sessionId={sessionId} customer={shown} onSaved={setShown}/>}
    <CreditTermsPanel service={service} sessionId={sessionId} revision={revision} party="CUSTOMER" partyId={customerId} canManage={canManage&&shown.active}/>
    <Statement service={service} sessionId={sessionId} revision={revision} kind="customer" id={customerId}/>
  </div>;
}
/** Creation keeps one request ID per draft; editing names the displayed version. */
function CustomerForm({service,sessionId,customer,onReload,onDone}:{service:ShopService;sessionId:string;customer?:CustomerView;onReload?:()=>void;onDone:(value:CustomerView|undefined)=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [name,setName]=useState(customer?.name??""),[phone,setPhone]=useState(customer?.phone??""),[address,setAddress]=useState(customer?.address??""),[notes,setNotes]=useState(customer?.notes??"");
  const [limit,setLimit]=useState(customer?.creditLimitMinor===undefined?"":String(customer.creditLimitMinor)),[requestId]=useState(()=>crypto.randomUUID()),[uncertain,setUncertain]=useState(false);
  const submit=async():Promise<void>=>{
    const value=await action.run(async():Promise<Result<CustomerView>>=>{
      let details:CustomerDetails;
      try{details={name,...(phone.trim()===""?{}:{phone:phone.trim()}),...(address.trim()===""?{}:{address:address.trim()}),...(notes.trim()===""?{}:{notes:notes.trim()}),...(limit.trim()===""?{}:{creditLimitMinor:moneyEntry(limit)})};}
      catch{return {ok:false,error:{code:"invalid_input"}};}
      const result=await (customer===undefined?service.createCustomer({sessionId,requestId,...details}):service.updateCustomer({sessionId,customerId:customer.id,version:customer.version,active:customer.active,...details}))
        .catch(():Result<never>=>({ok:false,error:{code:"unavailable"}}));
      setUncertain(customer===undefined&&!result.ok&&result.error.code==="unavailable");return result;
    });
    if(value!==undefined)onDone(value);
  };
  return <div className="panel form-panel"><h2>{t(customer===undefined?"newCustomer":"editCustomer")}</h2><form onSubmit={event=>{event.preventDefault();void submit();}}>
    <fieldset disabled={action.busy||uncertain}><div className="two-fields"><Field id="customer-name" label={t("customerName")} value={name} onChange={setName}/><Field id="customer-phone" label={t("phone")} value={phone} onChange={setPhone} required={false} maxLength={40}/></div>
      <Field id="customer-address" label={t("address")} value={address} onChange={setAddress} required={false} maxLength={200}/>
      <Field id="customer-notes" label={t("notes")} value={notes} onChange={setNotes} required={false} maxLength={500}/>
      <Field id="customer-limit" label={t("creditLimit")} value={limit} onChange={setLimit} numeric required={false}/><p className="hint">{t("creditLimitHelp")}</p>
    </fieldset>
    <ErrorText message={action.error} {...(customer===undefined?{}:{conflictMessage:"staleVersion" as const})}/><div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):uncertain?t("retry"):t("save")}</button>
      {action.error?.code==="request_conflict"&&onReload!==undefined&&<button type="button" className="secondary" onClick={onReload}>{t("reload")}</button>}
      <button type="button" className="secondary" disabled={action.busy||uncertain} onClick={()=>onDone(undefined)}>{t("cancel")}</button></div>
  </form></div>;
}
/** One stable request ID per payment draft; an uncertain outcome freezes the draft for an identical retry. */
function TakePayment({service,sessionId,customer,onSaved}:{service:ShopService;sessionId:string;customer:CustomerView;onSaved:(value:CustomerView)=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const accounts=useRead(()=>service.listPaymentAccounts({sessionId,limit:100}),[service,sessionId]);
  const [amount,setAmount]=useState(""),[accountId,setAccountId]=useState(""),[note,setNote]=useState(""),[requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const [uncertain,setUncertain]=useState(false),[saved,setSaved]=useState(false);
  const account=accountId||accounts.data?.items[0]?.id||"";
  const submit=async():Promise<void>=>{
    setSaved(false);
    const value=await action.run(async():Promise<Result<CustomerView>>=>{
      let amountMinor:number;try{amountMinor=moneyEntry(amount);}catch{return {ok:false,error:{code:"invalid_input"}};}
      const result=await service.receiveCustomerPayment({sessionId,requestId,customerId:customer.id,accountId:account,amountMinor,...(note.trim()===""?{}:{note:note.trim()})})
        .catch(():Result<never>=>({ok:false,error:{code:"unavailable"}}));
      setUncertain(!result.ok&&result.error.code==="unavailable");return result;
    });
    if(value!==undefined){onSaved(value);setAmount("");setNote("");setRequestId(crypto.randomUUID());setSaved(true);}
  };
  return <div className="panel form-panel"><h2>{t("takePayment")}</h2><ReadState loading={accounts.loading} error={accounts.error} empty={accounts.data?.items.length===0} emptyText={t("noAccounts")} retry={accounts.retry}>
    <form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={action.busy||uncertain}>
      <div className="two-fields"><Field id="payment-amount" label={t("amount")} value={amount} onChange={setAmount} numeric/>
        <Select id="payment-account" label={t("account")} value={account} onChange={setAccountId} options={(accounts.data?.items??[]).map(item=>({value:item.id,label:item.name}))}/></div>
      <Field id="payment-note" label={t("note")} value={note} onChange={setNote} required={false} maxLength={200}/>
    </fieldset>
    <ErrorText message={action.error}/>{saved&&<p role="status" className="notice success">{t("paymentSaved")}</p>}
    <div className="actions"><button className="primary" type="submit" disabled={action.busy||account===""}>{action.busy?t("recording"):uncertain?t("retry"):t("takePayment")}</button></div></form>
  </ReadState></div>;
}
/** Newest-first signed customer or supplier ledger. */
export function Statement({service,sessionId,revision,kind,id}:{service:ShopService;sessionId:string;revision:number;kind:"customer"|"supplier";id:string}):React.JSX.Element{
  const {t,language}=useText();
  const [cursor,setCursor]=useState<{ after: Cursor; revision: number }>();
  const after=cursor?.revision===revision?{after:cursor.after}:{};
  const list=useRead(()=>kind==="customer"?service.customerStatement({sessionId,customerId:id,...after}):service.supplierStatement({sessionId,supplierId:id,...after}),[service,sessionId,kind,id,cursor,revision]);
  const label=(type:string):string=>["CREDIT_SALE","PURCHASE","PAYMENT","RETURN","ADJUSTMENT","OPENING_BALANCE","WRITE_OFF"].includes(type)?t(`ledger${type}` as TextKey):type;
  return <div className="panel"><h2>{t("statement")}</h2>{kind==="customer"&&<p className="hint">{t("statementHelp")}</p>}
    <ReadState loading={list.loading} error={list.error} empty={list.data?.items.length===0} emptyText={t("noStatement")} retry={list.retry}>
      <div className="table-wrap"><table><thead><tr><th>{t("date")}</th><th>{t("movementType")}</th><th>{t("amount")}</th><th>{t("balanceAfter")}</th><th>{t("notesLabel")}</th></tr></thead><tbody>
        {list.data?.items.map(entry=>{const impact=kind==="customer"&&entry.type==="CREDIT_SALE"?customerSettlement(sumAmounts([entry.balanceMinor,-entry.amountMinor]),entry.amountMinor):undefined;return <tr key={entry.id}><td>{new Date(entry.occurredAt).toLocaleString(language==="fr"?"fr-FR":"en-GB")}</td><td>{impact===undefined?label(entry.type):t("accountPurchase")}
          {entry.saleId!==undefined&&<small>{shortReceiptNumber(`V-${entry.saleId}`)}</small>}
          {entry.saleTotalMinor!==undefined&&<small>{t("total")}: {formatMoney(entry.saleTotalMinor,language)} · {t("paidAtSale")}: {formatMoney(entry.salePaidMinor??0,language)}</small>}
          {impact!==undefined&&impact.creditAppliedMinor>0&&<small>{t("creditApplied")}: {formatMoney(impact.creditAppliedMinor,language)}</small>}
          {impact!==undefined&&impact.debtAddedMinor>0&&<small>{t("newDebt")}: {formatMoney(impact.debtAddedMinor,language)}</small>}</td>
          <td className={entry.amountMinor>0&&(impact===undefined||impact.debtAddedMinor>0)?"money negative":"money"}>{entry.amountMinor>0?"+":"−"}{formatMoney(Math.abs(entry.amountMinor),language)}</td>
          <td><Balance value={entry.balanceMinor} owedLabel={kind==="customer"?"owes":"owedToSupplier"}/></td><td>{entry.note??"—"}</td></tr>;})}
      </tbody></table></div>
    </ReadState>
    <Pager hasFirst={cursor!==undefined} hasNext={list.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(list.data?.next)setCursor({after:list.data.next,revision});}}/>
  </div>;
}
