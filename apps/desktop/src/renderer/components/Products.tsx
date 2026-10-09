import { useState } from "react";
import { moneyEntry, quantityEntry } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import type { Cursor } from "@kolo/core/application/queries";
import type { ShopService } from "../../shared/service.ts";
import { ErrorText, Field, Pager, ReadState, useAction, useRead, useText } from "./ui.tsx";

/** Catalogue, creation and optional atomic opening stock, backed by bounded host queries. */
export function Products({ service, sessionId, revision, canCreate, canAdjust }: {
  readonly service: ShopService; readonly sessionId: string; readonly revision: number; readonly canCreate: boolean; readonly canAdjust: boolean;
}): React.JSX.Element {
  const { t, language } = useText();
  const [term,setTerm]=useState(""),[cursor,setCursor]=useState<{ after: Cursor; revision: number }>(),[creating,setCreating]=useState(false);
  const list=useRead(()=>service.listProducts({sessionId,term,...(cursor?.revision===revision?{after:cursor.after}: {})}),[service,sessionId,term,cursor,revision]);
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("products")}</p><h1>{t("productHelp")}</h1></div>{canCreate && <button className="primary" onClick={()=>setCreating(true)}>+ {t("newProduct")}</button>}</div>
    {creating && <CreateProduct service={service} sessionId={sessionId} canAdjust={canAdjust} onClose={()=>setCreating(false)} />}
    <div className="panel"><Field id="catalogue-search" label={t("search")} value={term} required={false} onChange={value=>{setTerm(value);setCursor(undefined);}} />
      <ReadState loading={list.loading} error={list.error} empty={list.data?.items.length===0} emptyText={t("noResults")} retry={list.retry}>
        <div className="table-wrap"><table><thead><tr><th>{t("name")}</th><th>{t("price")}</th><th>{t("stock")}</th></tr></thead><tbody>
          {list.data?.items.map(product=><tr key={product.id}><td><strong>{product.name}</strong><small>{product.barcode ?? product.unit}</small></td><td className="money">{formatMoney(product.sellingPriceMinor,language)}</td>
            <td>{product.onHandThousandths===undefined?"—":<><span className={product.onHandThousandths<0?"negative":""}>{formatQuantity(product.onHandThousandths,language)} {product.unit}</span>{product.onHandThousandths<0&&<small className="negative">{t("negativeStock")}</small>}</>}</td></tr>)}
        </tbody></table></div>
      </ReadState>
      <Pager hasFirst={cursor!==undefined} hasNext={list.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(list.data?.next)setCursor({after:list.data.next,revision});}} />
    </div>
  </section>;
}
function CreateProduct({service,sessionId,canAdjust,onClose}:{service:ShopService;sessionId:string;canAdjust:boolean;onClose:()=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [name,setName]=useState(""),[unit,setUnit]=useState(()=>t("defaultUnit")),[barcode,setBarcode]=useState(""),[price,setPrice]=useState(""),[cost,setCost]=useState(""),[opening,setOpening]=useState("0"),[divisible,setDivisible]=useState(false),[requestId]=useState(()=>crypto.randomUUID());
  const [uncertain,setUncertain]=useState(false);
  const submit=async():Promise<void>=>{
    await action.run(async()=>{
      let input;
      try{input={sessionId,requestId,name,unit,divisible,sellingPriceMinor:moneyEntry(price),openingThousandths:canAdjust?quantityEntry(opening,divisible):0,
        ...(barcode.trim()===""?{}:{barcode:barcode.trim()}),...(cost.trim()===""?{}:{purchasePriceMinor:moneyEntry(cost)})};}
      catch{return {ok:false,error:{code:"invalid_input"}};}
      const result=await service.createProduct(input).catch(()=>({ok:false as const,error:{code:"unavailable" as const}}));
      setUncertain(!result.ok&&result.error.code==="unavailable");
      if(result.ok)onClose();return result;
    });
  };
  return <div className="panel form-panel"><h2>{t("newProduct")}</h2><form onSubmit={event=>{event.preventDefault();void submit();}}>
    <fieldset disabled={action.busy||uncertain}><div className="two-fields"><Field id="product-name" label={t("name")} value={name} onChange={setName}/><Field id="product-unit" label={t("unit")} value={unit} onChange={setUnit}/></div>
      <Field id="product-barcode" label={t("barcode")} value={barcode} onChange={setBarcode} required={false} maxLength={256}/>
      <div className="two-fields"><Field id="product-price" label={t("price")} value={price} onChange={setPrice} numeric/><Field id="product-cost" label={t("cost")} value={cost} onChange={setCost} numeric required={false}/></div>
      <label className="check"><input type="checkbox" checked={divisible} onChange={event=>setDivisible(event.target.checked)}/>{t("divisible")}</label>
      {canAdjust&&<Field id="opening-stock" label={t("openingStock")} value={opening} onChange={setOpening} numeric/>}
    </fieldset>
    <ErrorText message={action.error}/><div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):uncertain?t("retry"):t("saveProduct")}</button><button type="button" className="secondary" disabled={action.busy||uncertain} onClick={onClose}>{t("cancel")}</button></div>
  </form></div>;
}
