import { useEffect, useState } from "react";
import { moneyEntry } from "@kolo/core/domain/entry";
import { formatMoney } from "@kolo/core/domain/money";
import type { Cursor } from "@kolo/core/application/queries";
import type { Permission } from "@kolo/core/identity/permissions";
import type { AccountKind, AccountView, CashCountView, ExpenseCategory, Result, ShopService } from "../../shared/service.ts";
import { ErrorText, Field, Pager, ReadState, Select, useAction, useRead, useText } from "./ui.tsx";

type Props = { readonly service: ShopService; readonly sessionId: string; readonly revision: number; readonly permissions: readonly Permission[] };
const kinds: readonly AccountKind[] = ["CASH", "MOBILE_MONEY", "BANK", "CARD", "OTHER"];
const categories: readonly ExpenseCategory[] = ["RENT", "ELECTRICITY", "WATER", "TRANSPORT", "SALARY", "PACKAGING", "MAINTENANCE", "INTERNET", "MARKETING", "OTHER"];

/** Accounts with balances, money movements, counts/corrections and compensating expenses. */
export function Finance({ service, sessionId, revision, permissions }: Props): React.JSX.Element {
  const { t } = useText();
  const canAccounts=permissions.includes("finance.accounts.view")&&permissions.includes("cash.view"),canExpenses=permissions.includes("expenses.view");
  const [tab,setTab]=useState<"accounts"|"expenses">(canAccounts?"accounts":"expenses");
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("finance")}</p><h1>{t("financeHelp")}</h1></div></div>
    <div className="tabs" role="tablist">{([["accounts",canAccounts],["expenses",canExpenses]] as const).filter(([,allowed])=>allowed).map(([id])=>
      <button key={id} role="tab" aria-selected={tab===id} className={tab===id?"selected":""} onClick={()=>setTab(id)}>{t(id)}</button>)}</div>
    {canAccounts&&<div hidden={tab!=="accounts"}><Accounts service={service} sessionId={sessionId} revision={revision} permissions={permissions}/></div>}
    {canExpenses&&<div hidden={tab!=="expenses"}><Expenses service={service} sessionId={sessionId} revision={revision} permissions={permissions}/></div>}
  </section>;
}
function Accounts({service,sessionId,revision,permissions}:Props):React.JSX.Element{
  const {t,language}=useText(),canManage=permissions.includes("finance.accounts.manage");
  const [archived,setArchived]=useState(false),[cursor,setCursor]=useState<{ after: Cursor; revision: number }>(),[selectedId,setSelectedId]=useState<string>(),[creating,setCreating]=useState(false);
  const list=useRead(()=>service.listAccounts({sessionId,includeInactive:archived,...(cursor?.revision===revision?{after:cursor.after}:{})}),[service,sessionId,archived,cursor,revision]);
  return <>{selectedId===undefined&&canManage&&!creating&&<div className="actions spaced"><button className="secondary" onClick={()=>setCreating(true)}>+ {t("newAccount")}</button></div>}
    {creating&&<AccountForm service={service} sessionId={sessionId} onDone={()=>setCreating(false)}/>}
    <div className="panel" hidden={selectedId!==undefined}><label className="check"><input type="checkbox" checked={archived} onChange={event=>{setArchived(event.target.checked);setCursor(undefined);}}/>{t("showArchived")}</label>
      <ReadState loading={list.loading} error={list.error} empty={list.data?.items.length===0} emptyText={t("noAccountList")} retry={list.retry}>
        <div className="table-wrap"><table><thead><tr><th>{t("accountName")}</th><th>{t("kind")}</th><th>{t("balance")}</th></tr></thead><tbody>
          {list.data?.items.map(item=><tr key={item.id}><td><button className="row-link" onClick={()=>setSelectedId(item.id)}><strong>{item.name}</strong></button>{!item.active&&<span className="tag">{t("archived")}</span>}</td>
            <td>{t(item.kind)}</td><td className={`money ${(item.onHandMinor??0)<0?"negative":""}`}>{item.onHandMinor===undefined?"—":formatMoney(item.onHandMinor,language)}</td></tr>)}
        </tbody></table></div>
      </ReadState>
      <Pager hasFirst={cursor!==undefined} hasNext={list.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(list.data?.next)setCursor({after:list.data.next,revision});}}/></div>
    {selectedId!==undefined&&<AccountDetail key={selectedId} service={service} sessionId={sessionId} revision={revision} permissions={permissions} accountId={selectedId} onBack={()=>setSelectedId(undefined)}/>}
  </>;
}
function AccountForm({service,sessionId,account,onReload,onDone}:{service:ShopService;sessionId:string;account?:AccountView;onReload?:()=>void;onDone:(value?:AccountView)=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [name,setName]=useState(account?.name??""),[kind,setKind]=useState<AccountKind>(account?.kind??"CASH"),[requestId]=useState(()=>crypto.randomUUID()),[uncertain,setUncertain]=useState(false);
  const submit=async():Promise<void>=>{
    const value=await action.run(async():Promise<Result<AccountView>>=>{
      const result=await (account===undefined?service.createAccount({sessionId,requestId,name,kind}):service.updateAccount({sessionId,accountId:account.id,version:account.version,name,kind,active:account.active}))
        .catch(():Result<never>=>({ok:false,error:{code:"unavailable"}}));
      setUncertain(account===undefined&&!result.ok&&result.error.code==="unavailable");return result;
    });
    if(value!==undefined)onDone(value);
  };
  return <div className="panel form-panel"><h2>{t(account===undefined?"newAccount":"editAccount")}</h2><form onSubmit={event=>{event.preventDefault();void submit();}}>
    <fieldset disabled={action.busy||uncertain}><div className="two-fields"><Field id="account-name" label={t("accountName")} hint={t("hint.accountName")} value={name} onChange={setName}/>
      <Select id="account-kind" label={t("kind")} hint={t("hint.accountKind")} value={kind} onChange={value=>setKind(value as AccountKind)} options={kinds.map(item=>({value:item,label:t(item)}))}/></div></fieldset>
    <ErrorText message={action.error} {...(account===undefined?{}:{conflictMessage:"staleVersion" as const})}/><div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):uncertain?t("retry"):t("save")}</button>
      {action.error?.code==="request_conflict"&&onReload!==undefined&&<button type="button" className="secondary" onClick={onReload}>{t("reload")}</button>}
      <button type="button" className="secondary" disabled={action.busy||uncertain} onClick={()=>onDone()}>{t("cancel")}</button></div>
  </form></div>;
}
function AccountDetail({service,sessionId,revision,permissions,accountId,onBack}:Props&{accountId:string;onBack:()=>void}):React.JSX.Element{
  const {t,language}=useText(),action=useAction(),canManage=permissions.includes("finance.accounts.manage");
  const list=useRead(()=>service.listAccounts({sessionId,includeInactive:true,limit:100}),[service,sessionId,revision]);
  const [shown,setShown]=useState<AccountView>(),[editing,setEditing]=useState<AccountView>();
  useEffect(()=>{const found=list.data?.items.find(item=>item.id===accountId);if(found!==undefined)setShown(found);},[list.data,accountId]);
  if(shown===undefined)return <div className="panel"><button className="secondary" onClick={onBack}>← {t("back")}</button><ReadState loading={list.loading} error={list.error} empty={false} emptyText="" retry={list.retry}>{null}</ReadState></div>;
  const others=(list.data?.items??[]).filter(item=>item.active&&item.id!==shown.id);
  return <div className="detail-layout">
    <div className="panel"><div className="detail-heading"><button className="secondary" onClick={onBack}>← {t("back")}</button>
      {canManage&&<div className="actions">{shown.active&&editing===undefined&&<button className="secondary" onClick={()=>setEditing(shown)}>{t("edit")}</button>}
        <button className="secondary" disabled={action.busy} onClick={()=>{void action.run(()=>service.updateAccount({sessionId,accountId,version:shown.version,name:shown.name,kind:shown.kind,active:!shown.active})).then(value=>{if(value!==undefined){setShown(value);setEditing(undefined);}});}}>{t(shown.active?"archive":"restore")}</button></div>}</div>
      <h2>{shown.name}{!shown.active&&<span className="tag">{t("archived")}</span>}</h2><ErrorText message={action.error} conflictMessage="staleVersion"/>
      <dl className="facts"><dt>{t("balance")}</dt><dd className={`money ${(shown.onHandMinor??0)<0?"negative":""}`}>{shown.onHandMinor===undefined?t("hiddenBalance"):formatMoney(shown.onHandMinor,language)}</dd><dt>{t("kind")}</dt><dd>{t(shown.kind)}</dd></dl>
    </div>
    {editing!==undefined&&<AccountForm key={editing.version} service={service} sessionId={sessionId} account={editing} onReload={()=>setEditing(shown)} onDone={value=>{if(value!==undefined)setShown(value);setEditing(undefined);}}/>}
    {shown.active&&permissions.includes("cash.move")&&<MoveMoney service={service} sessionId={sessionId} account={shown} others={others} onSaved={setShown}/>}
    {shown.active&&permissions.includes("cash.count")&&<CountCash service={service} sessionId={sessionId} revision={revision} account={shown} canCorrect={permissions.includes("cash.reconcile")&&permissions.includes("cash.move")}/>}
  </div>;
}
/** One stable request per movement draft; an uncertain outcome freezes the draft for an identical retry. */
function MoveMoney({service,sessionId,account,others,onSaved}:{service:ShopService;sessionId:string;account:AccountView;others:readonly AccountView[];onSaved:(value:AccountView)=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [direction,setDirection]=useState<"in"|"out"|"transfer">("in"),[amount,setAmount]=useState(""),[reason,setReason]=useState(""),[toId,setToId]=useState("");
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID()),[uncertain,setUncertain]=useState(false),[saved,setSaved]=useState(false),destination=toId||others[0]?.id||"";
  const submit=async():Promise<void>=>{
    setSaved(false);
    const value=await action.run(async():Promise<Result<AccountView>>=>{
      let amountMinor:number;try{amountMinor=moneyEntry(amount);}catch{return {ok:false,error:{code:"invalid_input"}};}
      const result=await (direction==="transfer"?service.transferMoney({sessionId,requestId,fromAccountId:account.id,toAccountId:destination,amountMinor,reason})
        :service.moveMoney({sessionId,requestId,accountId:account.id,direction,amountMinor,reason})).catch(():Result<never>=>({ok:false,error:{code:"unavailable"}}));
      setUncertain(!result.ok&&result.error.code==="unavailable");return result;
    });
    if(value!==undefined){onSaved(value);setAmount("");setReason("");setRequestId(crypto.randomUUID());setSaved(true);}
  };
  return <div className="panel form-panel"><h2>{t("moveMoney")}</h2><form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={action.busy||uncertain}>
    <div className="segmented" role="radiogroup" aria-label={t("moveMoney")}>{(["in","out","transfer"] as const).filter(item=>item!=="transfer"||others.length>0).map(item=><label key={item} className={direction===item?"selected":""}>
      <input type="radio" name="money-direction" value={item} checked={direction===item} onChange={()=>{setDirection(item);setRequestId(crypto.randomUUID());}}/>{t(item==="in"?"moneyIn":item==="out"?"moneyOut":"transfer")}</label>)}</div>
    <div className="two-fields"><Field id="money-amount" label={t("amount")} hint={t("hint.movementAmount")} value={amount} onChange={setAmount} numeric/>
      {direction==="transfer"?<Select id="money-destination" label={t("destination")} hint={t("hint.transferDestination")} value={destination} onChange={setToId} options={others.map(item=>({value:item.id,label:item.name}))}/>:<Field id="money-reason" label={t("reason")} hint={t("hint.movementReason")} value={reason} onChange={setReason} maxLength={200}/>}</div>
    {direction==="transfer"&&<Field id="money-reason" label={t("reason")} hint={t("hint.movementReason")} value={reason} onChange={setReason} maxLength={200}/>}</fieldset>
    <ErrorText message={action.error}/>{saved&&<p role="status" className="notice success">{t("movementRecorded")}</p>}
    <div className="actions"><button className="primary" type="submit" disabled={action.busy||direction==="transfer"&&destination===""}>{action.busy?t("recording"):uncertain?t("retry"):t("recordMovement")}</button></div>
  </form></div>;
}
/** Comparing records audit only; correcting moves money to match the count, retried by request ID. */
function CountCash({service,sessionId,revision,account,canCorrect}:{service:ShopService;sessionId:string;revision:number;account:AccountView;canCorrect:boolean}):React.JSX.Element{
  const {t,language}=useText(),action=useAction();
  const [counted,setCounted]=useState(""),[reason,setReason]=useState(""),[comparison,setComparison]=useState<{value:CashCountView;revision:number}>();
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID()),[uncertain,setUncertain]=useState(false),[saved,setSaved]=useState(false);
  const current=comparison?.revision===revision?comparison.value:undefined;
  const compare=async():Promise<void>=>{
    setSaved(false);
    const value=await action.run(async():Promise<Result<CashCountView>>=>{let countedMinor:number;try{countedMinor=moneyEntry(counted);}catch{return {ok:false,error:{code:"invalid_input"}};}return service.countCash({sessionId,accountId:account.id,countedMinor});});
    if(value!==undefined){setComparison({value,revision});setRequestId(crypto.randomUUID());}
  };
  const correct=async():Promise<void>=>{
    const value=await action.run(async():Promise<Result<CashCountView>>=>{
      const result=await service.correctCash({sessionId,requestId,accountId:account.id,countedMinor:current!.countedMinor,reason}).catch(():Result<never>=>({ok:false,error:{code:"unavailable"}}));
      setUncertain(!result.ok&&result.error.code==="unavailable");return result;
    });
    if(value!==undefined){setComparison(undefined);setCounted("");setReason("");setSaved(true);}
  };
  return <div className="panel form-panel"><h2>{t("countCashTitle")}</h2>
    <form className="inline-form" onSubmit={event=>{event.preventDefault();void compare();}}><fieldset disabled={action.busy||uncertain}><Field id="cash-counted" label={t("counted")} hint={t("hint.countedCash")} value={counted} onChange={value=>{setCounted(value);setComparison(undefined);}} numeric/></fieldset>
      <button className="secondary" type="submit" disabled={action.busy||uncertain}>{t("compare")}</button></form>
    {current!==undefined&&<><dl className="facts compare"><dt>{t("expected")}</dt><dd className="money">{formatMoney(current.expectedMinor,language)}</dd><dt>{t("counted")}</dt><dd className="money">{formatMoney(current.countedMinor,language)}</dd>
      <dt>{t("difference")}</dt><dd className={`money ${current.differenceMinor<0?"negative":""}`}>{current.differenceMinor>0?"+":""}{formatMoney(current.differenceMinor,language)}</dd></dl>
      {current.differenceMinor===0?<p className="notice success">{t("countMatches")}</p>:canCorrect&&<form onSubmit={event=>{event.preventDefault();void correct();}}><fieldset disabled={action.busy||uncertain}><Field id="cash-correction-reason" label={t("reason")} hint={t("hint.correctionReason")} value={reason} onChange={setReason} maxLength={200}/></fieldset>
        <div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):uncertain?t("retry"):t("correctBooks")}</button></div></form>}</>}
    <ErrorText message={action.error}/>{saved&&<p role="status" className="notice success">{t("correctionSaved")}</p>}
  </div>;
}
function Expenses({service,sessionId,revision,permissions}:Props):React.JSX.Element{
  const {t,language}=useText(),canWrite=permissions.includes("expenses.create");
  const [cursor,setCursor]=useState<{ after: Cursor; revision: number }>();
  const list=useRead(()=>service.listExpenses({sessionId,...(cursor?.revision===revision?{after:cursor.after}:{})}),[service,sessionId,cursor,revision]);
  return <>{canWrite&&<RecordExpense service={service} sessionId={sessionId}/>}
    <div className="panel"><h2>{t("expenses")}</h2><p className="hint">{t("reverseHelp")}</p>
      <ReadState loading={list.loading} error={list.error} empty={list.data?.items.length===0} emptyText={t("noExpenses")} retry={list.retry}>
        <div className="table-wrap"><table><thead><tr><th>{t("date")}</th><th>{t("expenseCategory")}</th><th>{t("account")}</th><th>{t("amount")}</th><th>{t("descriptionLabel")}</th><th/></tr></thead><tbody>
          {list.data?.items.map(item=><tr key={item.id}><td>{new Date(item.occurredAt).toLocaleString(language==="fr"?"fr-FR":"en-GB")}</td><td>{t(item.category)}{item.reversesId!==undefined&&<span className="tag">{t("reversal")}</span>}</td>
            <td>{item.accountName}</td><td className={`money ${item.amountMinor<0?"negative":""}`}>{formatMoney(item.amountMinor,language)}</td><td>{item.description??"—"}{item.reference!==undefined&&<small>{item.reference}</small>}</td>
            <td className="row-actions">{item.reversed?<span className="tag">{t("reversed")}</span>:canWrite&&item.amountMinor>0&&<ReverseExpense service={service} sessionId={sessionId} expenseId={item.id}/>}</td></tr>)}
        </tbody></table></div>
      </ReadState>
      <Pager hasFirst={cursor!==undefined} hasNext={list.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(list.data?.next)setCursor({after:list.data.next,revision});}}/></div></>;
}
function RecordExpense({service,sessionId}:{service:ShopService;sessionId:string}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const accounts=useRead(()=>service.listPaymentAccounts({sessionId,limit:100}),[service,sessionId]);
  const [category,setCategory]=useState<ExpenseCategory>("OTHER"),[accountId,setAccountId]=useState(""),[amount,setAmount]=useState(""),[description,setDescription]=useState(""),[reference,setReference]=useState("");
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID()),[uncertain,setUncertain]=useState(false),[saved,setSaved]=useState(false),account=accountId||accounts.data?.items[0]?.id||"";
  const submit=async():Promise<void>=>{
    setSaved(false);
    const value=await action.run(async()=>{
      let amountMinor:number;try{amountMinor=moneyEntry(amount);}catch{return {ok:false as const,error:{code:"invalid_input" as const}};}
      const result=await service.recordExpense({sessionId,requestId,accountId:account,category,amountMinor,...(description.trim()===""?{}:{description:description.trim()}),...(reference.trim()===""?{}:{reference:reference.trim()})})
        .catch(()=>({ok:false as const,error:{code:"unavailable" as const}}));
      setUncertain(!result.ok&&result.error.code==="unavailable");return result;
    });
    if(value!==undefined){setAmount("");setDescription("");setReference("");setRequestId(crypto.randomUUID());setSaved(true);}
  };
  return <div className="panel form-panel"><h2>{t("newExpense")}</h2><ReadState loading={accounts.loading} error={accounts.error} empty={accounts.data?.items.length===0} emptyText={t("noAccounts")} retry={accounts.retry}>
    <form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={action.busy||uncertain}>
      <div className="two-fields"><Select id="expense-category" label={t("expenseCategory")} hint={t("hint.expenseCategory")} value={category} onChange={value=>setCategory(value as ExpenseCategory)} options={categories.map(item=>({value:item,label:t(item)}))}/>
        <Select id="expense-account" label={t("account")} hint={t("hint.paidFromAccount")} value={account} onChange={setAccountId} options={(accounts.data?.items??[]).map(item=>({value:item.id,label:item.name}))}/></div>
      <div className="two-fields"><Field id="expense-amount" label={t("amount")} hint={t("hint.amountPaid")} value={amount} onChange={setAmount} numeric/><Field id="expense-reference" label={t("expenseReference")} hint={t("hint.documentReference")} value={reference} onChange={setReference} required={false}/></div>
      <Field id="expense-description" label={t(category==="OTHER"?"descriptionRequired":"description")} hint={t(category==="OTHER"?"hint.expenseDescriptionRequired":"hint.expenseDescription")} value={description} onChange={setDescription} required={category==="OTHER"} maxLength={200}/></fieldset>
    <ErrorText message={action.error}/>{saved&&<p role="status" className="notice success">{t("movementRecorded")}</p>}
    <div className="actions"><button className="primary" type="submit" disabled={action.busy||account===""}>{action.busy?t("recording"):uncertain?t("retry"):t("newExpense")}</button></div></form>
  </ReadState></div>;
}
function ReverseExpense({service,sessionId,expenseId}:{service:ShopService;sessionId:string;expenseId:string}):React.JSX.Element{
  const {t}=useText(),action=useAction(),[requestId]=useState(()=>crypto.randomUUID());
  return <><button className="text-button" disabled={action.busy} onClick={()=>{if(window.confirm(t("reverseHelp")))void action.run(()=>service.reverseExpense({sessionId,requestId,expenseId}));}}>{t("reverse")}</button><ErrorText message={action.error}/></>;
}
