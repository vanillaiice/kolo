import { useEffect, useRef, useState } from "react";
import type { Cursor } from "@kolo/core/application/queries";
import { quantityEntry, quantityInput } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import { lineTotal, subtotalOf } from "@kolo/core/rules/pricing";
import type { CheckoutRequest, ProductView, ShopService } from "../../shared/service.ts";
import { call, ErrorText, Field, Pager, ReadState, useAction, useRead, useText } from "./ui.tsx";

type DraftLine={readonly product:ProductView;readonly quantityText:string};
/** Keyboard cash till. Transient drafts survive navigation, while exact prices and authority are checked again by the host. */
export function Till({service,sessionId,revision,onReceipt}:{readonly service:ShopService;readonly sessionId:string;readonly revision:number;readonly onReceipt:(id:string)=>void}):React.JSX.Element{
  const {t,language}=useText(),action=useAction();
  const [term,setTerm]=useState(""),[barcode,setBarcode]=useState(""),[cursor,setCursor]=useState<{after:Cursor;revision:number}>(),[accountCursor,setAccountCursor]=useState<{after:Cursor;revision:number}>();
  const [cart,setCart]=useState<readonly DraftLine[]>([]),[accountId,setAccountId]=useState(""),[uncertain,setUncertain]=useState(false);
  const pending=useRef<CheckoutRequest | undefined>(undefined), scanner=useRef<HTMLInputElement>(null), focusScanner=useRef(true);
  const products=useRead(()=>service.listProducts({sessionId,term,...(cursor?.revision===revision?{after:cursor.after}: {})}),[service,sessionId,term,cursor,revision]);
  const accounts=useRead(()=>service.listCashAccounts({sessionId,...(accountCursor?.revision===revision?{after:accountCursor.after}: {})}),[service,sessionId,accountCursor,revision]);
  const selected=pending.current?.accountId??(accountId||accounts.data?.items[0]?.id||""), frozen=action.busy||uncertain;
  useEffect(()=>{if(focusScanner.current&&!frozen){scanner.current?.focus();focusScanner.current=false;}},[frozen,cart]);
  let total=0,valid=true;
  try{if(cart.length)total=subtotalOf(cart.map(line=>({unitPriceMinor:line.product.sellingPriceMinor,quantity:quantityEntry(line.quantityText,line.product.divisible)})));}
  catch{valid=false;}
  const edit=(next:readonly DraftLine[]):void=>{pending.current=undefined;setCart(next);action.setError(undefined);};
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
      try{pending.current??={sessionId,requestId:crypto.randomUUID(),accountId:selected,lines:cart.map(line=>({productId:line.product.id,quantity:quantityEntry(line.quantityText,line.product.divisible),unitPriceMinor:line.product.sellingPriceMinor}))};}
      catch{return {ok:false,error:{code:"invalid_input"}};}
      const result=await call(()=>service.checkout(pending.current!));
      setUncertain(!result.ok&&result.error.code==="unavailable");
      if(result.ok){pending.current=undefined;setCart([]);setBarcode("");onReceipt(result.value.saleId);}return result;
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
      <div className="cart-settlement"><div className="total-line"><span>{t("total")}</span><strong>{valid?formatMoney(total,language):"—"}</strong></div>
        <ReadState loading={accounts.loading} error={accounts.error} empty={accounts.data?.items.length===0} emptyText={t("noAccounts")} retry={accounts.retry}>
          <label className="field" htmlFor="cash-account"><span>{t("cashAccount")}</span><select id="cash-account" disabled={frozen} value={selected} onChange={event=>{pending.current=undefined;setAccountId(event.target.value);}}>{accounts.data?.items.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        </ReadState>
        {!frozen&&<Pager hasFirst={accountCursor!==undefined} hasNext={accounts.data?.next!==undefined} onFirst={()=>{setAccountCursor(undefined);setAccountId("");}} onNext={()=>{if(accounts.data?.next){setAccountCursor({after:accounts.data.next,revision});setAccountId("");}}}/>}
        <p className="hint">{t("cashHelp")}</p><ErrorText message={action.error}/>
        <button className="primary full checkout" disabled={action.busy||!valid||cart.length===0||!uncertain&&(selected===""||accounts.loading||accounts.error!==undefined)} onClick={()=>{void checkout();}}>{action.busy?t("recording"):uncertain?t("retry"):t("completeSale")}<span aria-hidden="true">→</span></button>
      </div>
    </aside></div>
  </section>;
}
