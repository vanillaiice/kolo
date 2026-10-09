import { useEffect, useRef, useState } from "react";
import type { Cursor } from "@kolo/core/application/queries";
import { quantityEntry, quantityInput } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import { lineTotal, subtotalOf } from "@kolo/core/rules/pricing";
import { moneyEntry } from "@kolo/core/domain/entry";
import type { Permission } from "@kolo/core/identity/permissions";
import type { CheckoutRequest, CustomerView, ProductView, ShopService } from "../../shared/service.ts";
import { call, ErrorText, Field, Pager, ReadState, useAction, useRead, useText } from "./ui.tsx";

type DraftLine={readonly product:ProductView;readonly quantityText:string};
/** A payment row; the first row without typed text takes whatever is left to pay. */
type DraftPayment={readonly key:string;readonly accountId:string;readonly amountText:string|null};
/** Keyboard till with split payments and customer credit. Drafts survive navigation; prices, limits and authority are checked again by the host. */
export function Till({service,sessionId,revision,permissions,onReceipt}:{readonly service:ShopService;readonly sessionId:string;readonly revision:number;readonly permissions:readonly Permission[];readonly onReceipt:(id:string)=>void}):React.JSX.Element{
  const {t,language}=useText(),action=useAction();
  const [term,setTerm]=useState(""),[barcode,setBarcode]=useState(""),[cursor,setCursor]=useState<{after:Cursor;revision:number}>();
  const [cart,setCart]=useState<readonly DraftLine[]>([]),[rows,setRows]=useState<readonly DraftPayment[]>([{key:"first",accountId:"",amountText:null}]),[customer,setCustomer]=useState<CustomerView>(),[received,setReceived]=useState(""),[discount,setDiscount]=useState(""),[uncertain,setUncertain]=useState(false);
  const pending=useRef<CheckoutRequest | undefined>(undefined), scanner=useRef<HTMLInputElement>(null), focusScanner=useRef(true);
  const products=useRead(()=>service.listProducts({sessionId,term,...(cursor?.revision===revision?{after:cursor.after}: {})}),[service,sessionId,term,cursor,revision]);
  const accounts=useRead(()=>service.listPaymentAccounts({sessionId,limit:100}),[service,sessionId,revision]);
  const frozen=action.busy||uncertain,canCredit=permissions.includes("customers.credit"),canCustomers=permissions.includes("customers.view"),canDiscount=permissions.includes("sales.discount");
  useEffect(()=>{if(focusScanner.current&&!frozen){scanner.current?.focus();focusScanner.current=false;}},[frozen,cart]);
  let total=0,subtotal=0,discountMinor=0,valid=true;
  try{if(cart.length)subtotal=subtotalOf(cart.map(line=>({unitPriceMinor:line.product.sellingPriceMinor,quantity:quantityEntry(line.quantityText,line.product.divisible)})));}
  catch{valid=false;}
  try{discountMinor=discount.trim()===""?0:moneyEntry(discount);}catch{valid=false;}
  if(discountMinor>subtotal)valid=false;
  total=subtotal-discountMinor;
  // Settlement uses the shared exact arithmetic for the total; the host recomputes everything.
  const accountOf=(id:string)=>accounts.data?.items.find(account=>account.id===id)??(id===""?accounts.data?.items[0]:undefined);
  let amounts:number[]=[];
  try{const manual=rows.map(row=>row.amountText===null?0:moneyEntry(row.amountText)),typed=manual.reduce((sum,value)=>sum+value,0);amounts=rows.map((row,index)=>row.amountText===null?Math.max(0,total-typed):manual[index]!);}
  catch{valid=false;}
  const paid=amounts.reduce((sum,value)=>sum+value,0),remaining=total-paid,cashPaid=rows.reduce((sum,row,index)=>accountOf(row.accountId)?.kind==="CASH"?sum+(amounts[index]??0):sum,0);
  let tendered:number|undefined;try{tendered=received.trim()===""?undefined:moneyEntry(received);}catch{valid=false;}
  const blocker=!valid?undefined:remaining<0?"overpaid":remaining>0&&!canCredit?"noCredit":remaining>0&&customer===undefined?"needsCustomer":tendered!==undefined&&tendered<cashPaid?"receivedShort":undefined;
  const edit=(next:readonly DraftLine[]):void=>{pending.current=undefined;setCart(next);action.setError(undefined);};
  const editRows=(next:readonly DraftPayment[]):void=>{pending.current=undefined;setRows(next);action.setError(undefined);};
  const add=(product:ProductView):void=>{
    if(frozen)return;
    const existing=cart.find(line=>line.product.id===product.id);
    try{
      if(existing!==undefined&&existing.product.sellingPriceMinor!==product.sellingPriceMinor){action.setError({code:"price_changed"});return;}
      edit(existing===undefined?[...cart,{product,quantityText:"1"}]:cart.map(line=>line.product.id===product.id?{...line,quantityText:quantityInput(quantityEntry(line.quantityText,line.product.divisible)+1000)}:line));
      setBarcode("");focusScanner.current=true;
    }catch{action.setError({code:"invalid_input"});}
  };
  const scan=async():Promise<void>=>{
    focusScanner.current=true;
    const product=await action.run(()=>service.scanProduct({sessionId,barcode}));
    if(product===null)action.setError({code:"unknownBarcode"});
    // action.busy clears on the following render, so this scanned result is applied directly.
    else if(product!==undefined){
      const existing=cart.find(line=>line.product.id===product.id);
      try{if(existing!==undefined&&existing.product.sellingPriceMinor!==product.sellingPriceMinor){action.setError({code:"price_changed"});return;}
        edit(existing===undefined?[...cart,{product,quantityText:"1"}]:cart.map(line=>line.product.id===product.id?{...line,quantityText:quantityInput(quantityEntry(line.quantityText,line.product.divisible)+1000)}:line));setBarcode("");focusScanner.current=true;}
      catch{action.setError({code:"invalid_input"});}
    }
  };
  const checkout=async():Promise<void>=>{
    await action.run(async()=>{
      try{pending.current??={sessionId,requestId:crypto.randomUUID(),...(customer===undefined?{}:{customerId:customer.id}),
        ...(discountMinor>0?{discountMinor}:{}),payments:rows.map((row,index)=>({accountId:accountOf(row.accountId)!.id,amountMinor:amounts[index]!})).filter(payment=>payment.amountMinor>0),
        lines:cart.map(line=>({productId:line.product.id,quantity:quantityEntry(line.quantityText,line.product.divisible),unitPriceMinor:line.product.sellingPriceMinor}))};}
      catch{return {ok:false,error:{code:"invalid_input"}};}
      const result=await call(()=>service.checkout(pending.current!));
      setUncertain(!result.ok&&result.error.code==="unavailable");
      if(result.ok){pending.current=undefined;setCart([]);setBarcode("");setRows([{key:"first",accountId:"",amountText:null}]);setCustomer(undefined);setReceived("");setDiscount("");onReceipt(result.value.saleId);}return result;
    });
  };
  return <section className="workspace-content till-content">
    <div className="section-heading"><div><p className="eyebrow">{t("till")}</p><h1>{t("tillHelp")}</h1></div><span className="pill"><span className="status-dot"/>{t("offline")}</span></div>
    <div className="till-layout"><div className="catalogue-column">
      <form className="scanner-form" onSubmit={event=>{event.preventDefault();if(!frozen)void scan();}}><label className="sr-only" htmlFor="barcode-scan">{t("scanner")}</label><input id="barcode-scan" ref={scanner} value={barcode} placeholder={t("scanner")} autoComplete="off" disabled={frozen} maxLength={256} onChange={event=>setBarcode(event.target.value)}/><button className="secondary" disabled={frozen||barcode.trim()===""} type="submit" aria-label={t("scan")}><span aria-hidden="true">↵</span></button></form>
      <Field id="till-search" label={t("search")} value={term} required={false} disabled={frozen} onChange={value=>{setTerm(value);setCursor(undefined);}}/>
      <ReadState loading={products.loading} error={products.error} empty={products.data?.items.length===0} emptyText={t(term===""?"noProducts":"noResults")} retry={products.retry}>
        <div className="product-grid">{products.data?.items.map(product=><button key={product.id} className="product-tile" disabled={frozen} onClick={()=>add(product)}>
          <span className="product-initial" aria-hidden="true">{product.name.slice(0,1).toLocaleUpperCase()}</span><strong>{product.name}</strong><span className="money">{formatMoney(product.sellingPriceMinor,language)}</span>
          <small className={product.onHandThousandths!==undefined&&product.onHandThousandths<0?"negative":"muted"}>{product.onHandThousandths===undefined?product.unit:`${t("stock")}: ${formatQuantity(product.onHandThousandths,language)} ${product.unit}`}</small>
        </button>)}</div>
      </ReadState>
      <Pager hasFirst={cursor!==undefined} hasNext={products.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(products.data?.next)setCursor({after:products.data.next,revision});}}/>
    </div><aside className="cart-panel panel"><div className="cart-title"><h2>{t("cart")}</h2><span className="item-count">{cart.length}</span></div>
      {cart.length===0?<div className="empty cart-empty"><span aria-hidden="true">+</span><h3>{t("emptyCart")}</h3><p>{t("emptyCartHelp")}</p></div>:<div className="cart-lines">{cart.map(line=>{
        let amount:string="—";try{amount=formatMoney(lineTotal({quantity:quantityEntry(line.quantityText,line.product.divisible),unitPriceMinor:line.product.sellingPriceMinor}),language);}catch{/* The editable field keeps incomplete input until corrected. */}
        return <div className="cart-line" key={line.product.id}><div className="line-heading"><strong>{line.product.name}</strong><button className="icon-button" disabled={frozen} aria-label={`${t("remove")}: ${line.product.name}`} onClick={()=>edit(cart.filter(item=>item.product.id!==line.product.id))}>×</button></div>
          <div className="line-details"><Field id={`quantity-${line.product.id}`} label={t("quantity")} value={line.quantityText} numeric disabled={frozen} onChange={value=>edit(cart.map(item=>item.product.id===line.product.id?{...item,quantityText:value}:item))}/><strong className="money">{amount}</strong></div>
        </div>;
      })}</div>}
      <div className="cart-settlement">{canDiscount&&cart.length>0&&<><div className="settlement-line"><span>{t("subtotal")}</span><strong>{formatMoney(subtotal,language)}</strong></div>
        <Field id="sale-discount" label={t("discount")} value={discount} numeric required={false} disabled={frozen} onChange={value=>{pending.current=undefined;setDiscount(value);action.setError(undefined);}}/></>}<div className="total-line"><span>{t("total")}</span><strong>{valid?formatMoney(total,language):"—"}</strong></div>
        {canCustomers&&<CustomerChoice service={service} sessionId={sessionId} revision={revision} value={customer} disabled={frozen} onChange={value=>{pending.current=undefined;setCustomer(value);action.setError(undefined);}}/>}
        <ReadState loading={accounts.loading} error={accounts.error} empty={accounts.data?.items.length===0} emptyText={t("noAccounts")} retry={accounts.retry}>
          <fieldset className="payment-rows" disabled={frozen}><legend>{t("payments")}</legend>{rows.map((row,index)=><div className="payment-row" key={row.key}>
            <label className="field"><span className="sr-only">{t("account")}</span><select aria-label={t("account")} value={accountOf(row.accountId)?.id??""} onChange={event=>editRows(rows.map(item=>item.key===row.key?{...item,accountId:event.target.value}:item))}>
              {accounts.data?.items.map(account=><option key={account.id} value={account.id} disabled={rows.some(item=>item.key!==row.key&&accountOf(item.accountId)?.id===account.id)}>{account.name}</option>)}</select></label>
            <label className="field"><span className="sr-only">{t("amount")}</span><input aria-label={`${t("amount")} · ${accountOf(row.accountId)?.name??""}`} inputMode="decimal" autoComplete="off" value={row.amountText??(valid?String(amounts[index]??0):"")} onChange={event=>editRows(rows.map(item=>item.key===row.key?{...item,amountText:event.target.value}:item))}/></label>
            {index>0&&<button type="button" className="icon-button" aria-label={t("remove")} onClick={()=>editRows(rows.filter(item=>item.key!==row.key))}>×</button>}
          </div>)}
            {rows.length<(accounts.data?.items.length??0)&&<button type="button" className="text-button" onClick={()=>editRows([...rows,{key:crypto.randomUUID(),accountId:accounts.data!.items.find(account=>!rows.some(row=>accountOf(row.accountId)?.id===account.id))!.id,amountText:"0"}])}>+ {t("addPayment")}</button>}
          </fieldset>
        </ReadState>
        {valid&&remaining!==0&&<div className={`settlement-line ${remaining<0?"negative":""}`}><span>{t(remaining>0&&customer!==undefined&&canCredit?"onAccount":"remaining")}</span><strong>{formatMoney(remaining,language)}</strong></div>}
        {cashPaid>0&&<Field id="cash-received" label={t("received")} value={received} numeric required={false} disabled={frozen} onChange={setReceived}/>}
        {valid&&tendered!==undefined&&tendered>=cashPaid&&<div className="settlement-line change-line"><span>{t("change")}</span><strong>{formatMoney(tendered-cashPaid,language)}</strong></div>}
        {blocker!==undefined&&cart.length>0&&<p className="hint negative">{t(blocker)}</p>}<ErrorText message={action.error}/>
        <button className="primary full checkout" disabled={action.busy||!valid||cart.length===0||!uncertain&&(blocker!==undefined||accounts.loading||accounts.error!==undefined||accounts.data?.items.length===0)} onClick={()=>{void checkout();}}>{action.busy?t("recording"):uncertain?t("retry"):t("completeSale")}<span aria-hidden="true">→</span></button>
      </div>
    </aside></div>
  </section>;
}

/** Finds a customer by name or phone prefix; the chosen customer's balance and limit stay visible. */
function CustomerChoice({service,sessionId,revision,value,disabled,onChange}:{service:ShopService;sessionId:string;revision:number;value:CustomerView|undefined;disabled:boolean;onChange:(value:CustomerView|undefined)=>void}):React.JSX.Element{
  const {t,language}=useText(),[term,setTerm]=useState("");
  const found=useRead(()=>term.trim()===""?Promise.resolve({ok:true as const,value:{items:[]}}):service.listCustomers({sessionId,term,limit:5}),[service,sessionId,term,revision]);
  if(value!==undefined)return <div className="customer-choice"><div><span className="eyebrow">{t("customer")}</span><strong>{value.name}</strong>
    <small>{t("balance")}: {formatMoney(value.outstandingMinor,language)} · {t("creditLimitLabel")}: {value.creditLimitMinor===undefined?t("noLimit"):formatMoney(value.creditLimitMinor,language)}</small></div>
    <button className="icon-button" disabled={disabled} aria-label={t("clearCustomer")} onClick={()=>onChange(undefined)}>×</button></div>;
  return <div className="customer-search"><Field id="customer-search" label={t("findCustomer")} value={term} required={false} disabled={disabled} onChange={setTerm}/>
    {(found.data?.items.length??0)>0&&<ul className="customer-results">{found.data!.items.map(item=><li key={item.id}><button type="button" disabled={disabled} onClick={()=>{onChange(item);setTerm("");}}><strong>{item.name}</strong><small>{item.phone??""} {formatMoney(item.outstandingMinor,language)}</small></button></li>)}</ul>}</div>;
}
