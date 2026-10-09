import { useEffect, useState } from "react";
import { moneyEntry, quantityEntry, quantityInput } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import type { Cursor } from "@kolo/core/application/queries";
import type { Permission } from "@kolo/core/identity/permissions";
import type { CategoryView, ProductView, Result, ShopService } from "../../shared/service.ts";
import type { TextKey } from "../text.ts";
import { ErrorText, Field, Pager, ReadState, Select, useAction, useRead, useText } from "./ui.tsx";

type Props = { readonly service: ShopService; readonly sessionId: string; readonly revision: number; readonly permissions: readonly Permission[] };

/** Catalogue, product details, stock movements and categories, backed by bounded host queries. */
export function Products({ service, sessionId, revision, permissions }: Props): React.JSX.Element {
  const { t } = useText();
  const [tab,setTab]=useState<"products"|"categories">("products"),[selectedId,setSelectedId]=useState<string>(),[creating,setCreating]=useState(false);
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("products")}</p><h1>{t(tab==="products"?"productHelp":"categoryHelp")}</h1></div>
      {tab==="products"&&selectedId===undefined&&permissions.includes("products.create")&&<button className="primary" onClick={()=>setCreating(true)}>+ {t("newProduct")}</button>}</div>
    <div className="tabs" role="tablist">{(["products","categories"] as const).map(id=><button key={id} role="tab" aria-selected={tab===id} className={tab===id?"selected":""} onClick={()=>setTab(id)}>{t(id==="products"?"catalogue":"categories")}</button>)}</div>
    <div hidden={tab!=="products"}>
      {creating&&<CreateProduct service={service} sessionId={sessionId} canAdjust={permissions.includes("inventory.adjust")} onClose={()=>setCreating(false)}/>}
      <div hidden={selectedId!==undefined}><ProductList service={service} sessionId={sessionId} revision={revision} onOpen={setSelectedId}/></div>
      {selectedId!==undefined&&<ProductDetail key={selectedId} service={service} sessionId={sessionId} revision={revision} permissions={permissions} productId={selectedId} onBack={()=>setSelectedId(undefined)}/>}
    </div>
    <div hidden={tab!=="categories"}><Categories service={service} sessionId={sessionId} revision={revision} permissions={permissions}/></div>
  </section>;
}
function ProductList({service,sessionId,revision,onOpen}:{service:ShopService;sessionId:string;revision:number;onOpen:(id:string)=>void}):React.JSX.Element{
  const {t,language}=useText();
  const [term,setTerm]=useState(""),[archived,setArchived]=useState(false),[cursor,setCursor]=useState<{ after: Cursor; revision: number }>();
  const list=useRead(()=>service.listProducts({sessionId,term,includeInactive:archived,...(cursor?.revision===revision?{after:cursor.after}: {})}),[service,sessionId,term,archived,cursor,revision]);
  return <div className="panel"><Field id="catalogue-search" label={t("search")} value={term} required={false} onChange={value=>{setTerm(value);setCursor(undefined);}} />
    <label className="check"><input type="checkbox" checked={archived} onChange={event=>{setArchived(event.target.checked);setCursor(undefined);}}/>{t("showArchived")}</label>
    <ReadState loading={list.loading} error={list.error} empty={list.data?.items.length===0} emptyText={t("noResults")} retry={list.retry}>
      <div className="table-wrap"><table><thead><tr><th>{t("name")}</th><th>{t("price")}</th><th>{t("stock")}</th></tr></thead><tbody>
        {list.data?.items.map(product=><tr key={product.id}><td><button className="row-link" onClick={()=>onOpen(product.id)}><strong>{product.name}</strong></button>{!product.active&&<span className="tag">{t("archived")}</span>}<small>{product.barcode ?? product.unit}</small></td><td className="money">{formatMoney(product.sellingPriceMinor,language)}</td>
          <td><Stock product={product}/></td></tr>)}
      </tbody></table></div>
    </ReadState>
    <Pager hasFirst={cursor!==undefined} hasNext={list.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(list.data?.next)setCursor({after:list.data.next,revision});}} />
  </div>;
}
function Stock({product}:{product:ProductView}):React.JSX.Element{
  const {t,language}=useText();
  return product.onHandThousandths===undefined?<>—</>:<><span className={product.onHandThousandths<0?"negative":""}>{formatQuantity(product.onHandThousandths,language)} {product.unit}</span>{product.onHandThousandths<0&&<small className="negative">{t("negativeStock")}</small>}</>;
}
/** One product: details stay visible while a revision rereads them, and drafts survive rereads. */
function ProductDetail({service,sessionId,revision,permissions,productId,onBack}:Props&{productId:string;onBack:()=>void}):React.JSX.Element{
  const {t,language}=useText(),action=useAction();
  const read=useRead(()=>service.getProduct({sessionId,productId}),[service,sessionId,productId,revision]);
  const [shown,setShown]=useState<ProductView>(),[editing,setEditing]=useState<ProductView>();
  useEffect(()=>{if(read.data!==undefined)setShown(read.data);},[read.data]);
  const canEdit=permissions.includes("products.edit"),canArchive=canEdit&&permissions.includes("products.archive");
  const canMove=permissions.includes("inventory.adjust")||permissions.includes("inventory.count");
  if(shown===undefined)return <div className="panel"><button className="secondary" onClick={onBack}>← {t("back")}</button><ReadState loading={read.loading} error={read.error} empty={false} emptyText="" retry={read.retry}>{null}</ReadState></div>;
  return <div className="detail-layout">
    <div className="panel"><div className="detail-heading"><button className="secondary" onClick={onBack}>← {t("back")}</button>
      <div className="actions">{shown.active&&canEdit&&editing===undefined&&<button className="secondary" onClick={()=>setEditing(shown)}>{t("edit")}</button>}
        {canArchive&&<button className="secondary" disabled={action.busy} onClick={()=>{void action.run(()=>service.setProductActive({sessionId,productId,version:shown.version,active:!shown.active})).then(value=>{if(value!==undefined){setShown(value);setEditing(undefined);}});}}>{t(shown.active?"archive":"restore")}</button>}</div></div>
      <h2>{shown.name}{!shown.active&&<span className="tag">{t("archived")}</span>}</h2>
      <ErrorText message={action.error} conflictMessage="staleVersion"/>
      {!shown.active&&<p className="notice">{t("archivedNotice")}</p>}
      <dl className="facts"><dt>{t("stock")}</dt><dd><Stock product={shown}/></dd><dt>{t("sellingPrice")}</dt><dd className="money">{formatMoney(shown.sellingPriceMinor,language)}</dd>
        <dt>{t("unitCost")}</dt><dd className="money">{shown.purchasePriceMinor===undefined?"—":formatMoney(shown.purchasePriceMinor,language)}</dd>
        <dt>{t("unit")}</dt><dd>{shown.unit} · {t(shown.divisible?"fractional":"wholeUnits")}</dd><dt>{t("barcodeLabel")}</dt><dd>{shown.barcode??"—"}</dd>
        <dt>{t("minimumStock")}</dt><dd>{formatQuantity(shown.minimumStockThousandths,language)} {shown.unit}</dd></dl>
    </div>
    {editing!==undefined&&<EditProduct key={editing.version} service={service} sessionId={sessionId} product={editing} onReload={()=>setEditing(shown)} onSaved={value=>{setShown(value);setEditing(undefined);}} onClose={()=>setEditing(undefined)}/>}
    {shown.active&&canMove&&<StockMovement service={service} sessionId={sessionId} product={shown} permissions={permissions} onSaved={setShown}/>}
    {permissions.includes("inventory.view")&&<StockHistory service={service} sessionId={sessionId} revision={revision} product={shown}/>}
  </div>;
}
function EditProduct({service,sessionId,product,onReload,onSaved,onClose}:{service:ShopService;sessionId:string;product:ProductView;onReload:()=>void;onSaved:(value:ProductView)=>void;onClose:()=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [name,setName]=useState(product.name),[unit,setUnit]=useState(product.unit),[barcode,setBarcode]=useState(product.barcode??""),[price,setPrice]=useState(String(product.sellingPriceMinor));
  const [cost,setCost]=useState(product.purchasePriceMinor===undefined?"":String(product.purchasePriceMinor)),[minimum,setMinimum]=useState(quantityInput(product.minimumStockThousandths)),[categoryId,setCategoryId]=useState(product.categoryId??"");
  const options=useRead(()=>service.listCategories({sessionId,includeInactive:true,limit:100}),[service,sessionId]);
  const submit=async():Promise<void>=>{
    const value=await action.run(async()=>{
      let input;
      try{input={sessionId,productId:product.id,version:product.version,name,unit,sellingPriceMinor:moneyEntry(price),minimumStockThousandths:quantityEntry(minimum,product.divisible),
        ...(barcode.trim()===""?{}:{barcode:barcode.trim()}),...(cost.trim()===""?{}:{purchasePriceMinor:moneyEntry(cost)}),...(categoryId===""?{}:{categoryId})};}
      catch{return {ok:false,error:{code:"invalid_input"}};}
      return service.updateProduct(input);
    });
    if(value!==undefined)onSaved(value);
  };
  const choices=[{value:"",label:t("noCategory")},...(options.data?.items??[]).filter(item=>item.active||item.id===product.categoryId).map(item=>({value:item.id,label:item.active?item.name:`${item.name} · ${t("archived")}`}))];
  return <div className="panel form-panel"><h2>{t("editProduct")}</h2><form onSubmit={event=>{event.preventDefault();void submit();}}>
    <fieldset disabled={action.busy}><div className="two-fields"><Field id="edit-name" label={t("name")} value={name} onChange={setName}/><Field id="edit-unit" label={t("unit")} value={unit} onChange={setUnit}/></div>
      <div className="two-fields"><Field id="edit-barcode" label={t("barcode")} value={barcode} onChange={setBarcode} required={false} maxLength={256}/><Select id="edit-category" label={t("category")} value={categoryId} onChange={setCategoryId} options={choices}/></div>
      <div className="two-fields"><Field id="edit-price" label={t("price")} value={price} onChange={setPrice} numeric/><Field id="edit-cost" label={t("cost")} value={cost} onChange={setCost} numeric required={false}/></div>
      <Field id="edit-minimum" label={t("minimumStock")} value={minimum} onChange={setMinimum} numeric/>
    </fieldset>
    <ErrorText message={action.error} conflictMessage="staleVersion"/><div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):t("save")}</button>
      {action.error?.code==="request_conflict"&&<button type="button" className="secondary" onClick={onReload}>{t("reload")}</button>}
      <button type="button" className="secondary" disabled={action.busy} onClick={onClose}>{t("cancel")}</button></div>
  </form></div>;
}
/** One stable request ID per movement draft; an uncertain outcome freezes the draft for an identical retry. */
function StockMovement({service,sessionId,product,permissions,onSaved}:{service:ShopService;sessionId:string;product:ProductView;permissions:readonly Permission[];onSaved:(value:ProductView)=>void}):React.JSX.Element{
  const {t,language}=useText(),action=useAction();
  const kinds=([["add","inventory.adjust"],["damage","inventory.adjust"],["count","inventory.count"]] as const).filter(([,permission])=>permissions.includes(permission)).map(([kind])=>kind);
  const [kind,setKind]=useState<"add"|"damage"|"count">(kinds[0]!),[quantity,setQuantity]=useState(""),[reason,setReason]=useState(""),[requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const [uncertain,setUncertain]=useState(false),[saved,setSaved]=useState<string>();
  const submit=async():Promise<void>=>{
    setSaved(undefined);
    const value=await action.run(async():Promise<Result<{deltaThousandths?:number;product:ProductView}>>=>{
      let amount:number;
      try{amount=quantityEntry(quantity,product.divisible);}catch{return {ok:false,error:{code:"invalid_input"}};}
      const result=await (kind==="count"?service.countStock({sessionId,requestId,productId:product.id,countedThousandths:amount,reason})
        :service.moveStock({sessionId,requestId,productId:product.id,kind,quantityThousandths:amount,reason}).then((result):Result<{product:ProductView}>=>result.ok?{ok:true,value:{product:result.value}}:result))
        .catch(():Result<never>=>({ok:false,error:{code:"unavailable"}}));
      setUncertain(!result.ok&&result.error.code==="unavailable");
      return result;
    });
    if(value===undefined)return;
    onSaved(value.product);setQuantity("");setReason("");setRequestId(crypto.randomUUID());
    setSaved(value.deltaThousandths===undefined?t("movementSaved"):`${t("countDifference")} ${value.deltaThousandths>0?"+":""}${formatQuantity(value.deltaThousandths,language)} ${product.unit}`);
  };
  return <div className="panel form-panel"><h2>{t("stockMovement")}</h2><p className="hint">{t("movementHelp")}</p><form onSubmit={event=>{event.preventDefault();void submit();}}>
    <fieldset disabled={action.busy||uncertain}><div className="segmented" role="radiogroup" aria-label={t("stockMovement")}>{kinds.map(item=><label key={item} className={kind===item?"selected":""}><input type="radio" name="movement-kind" value={item} checked={kind===item} onChange={()=>setKind(item)}/>{t(item==="add"?"addStock":item)}</label>)}</div>
      <div className="two-fields"><Field id="movement-quantity" label={t(kind==="count"?"countedQuantity":"quantity")} value={quantity} onChange={setQuantity} numeric/><Field id="movement-reason" label={t("reason")} value={reason} onChange={setReason}/></div>
    </fieldset>
    <ErrorText message={action.error}/>{saved!==undefined&&<p role="status" className="notice success">{saved}</p>}
    <div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):uncertain?t("retry"):t("recordMovement")}</button></div>
  </form></div>;
}
function StockHistory({service,sessionId,revision,product}:{service:ShopService;sessionId:string;revision:number;product:ProductView}):React.JSX.Element{
  const {t,language}=useText();
  const [cursor,setCursor]=useState<{ after: Cursor; revision: number }>();
  const list=useRead(()=>service.stockHistory({sessionId,productId:product.id,...(cursor?.revision===revision?{after:cursor.after}:{})}),[service,sessionId,product.id,cursor,revision]);
  const label=(type:string):string=>["OPENING_BALANCE","ADJUSTMENT","DAMAGE","STOCK_COUNT","SALE","SALE_RETURN","PURCHASE","PURCHASE_RETURN","TRANSFER_IN","TRANSFER_OUT"].includes(type)?t(type as TextKey):type;
  return <div className="panel"><h2>{t("stockHistory")}</h2>
    <ReadState loading={list.loading} error={list.error} empty={list.data?.items.length===0} emptyText={t("noMovements")} retry={list.retry}>
      <div className="table-wrap"><table><thead><tr><th>{t("date")}</th><th>{t("movementType")}</th><th>{t("quantity")}</th><th>{t("reason")}</th></tr></thead><tbody>
        {list.data?.items.map(item=><tr key={item.id}><td>{new Date(item.occurredAt).toLocaleString(language==="fr"?"fr-FR":"en-GB")}</td><td>{label(item.type)}</td>
          <td className={item.quantityThousandths<0?"negative money":"money"}>{item.quantityThousandths>0?"+":""}{formatQuantity(item.quantityThousandths,language)}</td><td>{item.reason??"—"}</td></tr>)}
      </tbody></table></div>
    </ReadState>
    <Pager hasFirst={cursor!==undefined} hasNext={list.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(list.data?.next)setCursor({after:list.data.next,revision});}} />
  </div>;
}
function Categories({service,sessionId,revision,permissions}:Props):React.JSX.Element{
  const {t}=useText();
  const [archived,setArchived]=useState(false),[cursor,setCursor]=useState<{ after: Cursor; revision: number }>(),[editing,setEditing]=useState<CategoryView>();
  const list=useRead(()=>service.listCategories({sessionId,includeInactive:archived,...(cursor?.revision===revision?{after:cursor.after}:{})}),[service,sessionId,archived,cursor,revision]);
  const canEdit=permissions.includes("products.edit"),canArchive=canEdit&&permissions.includes("products.archive");
  return <>{permissions.includes("products.create")&&<CreateCategory service={service} sessionId={sessionId}/>}
    {editing!==undefined&&<CategoryForm key={editing.version} service={service} sessionId={sessionId} category={editing} onDone={()=>setEditing(undefined)}/>}
    <div className="panel"><label className="check"><input type="checkbox" checked={archived} onChange={event=>{setArchived(event.target.checked);setCursor(undefined);}}/>{t("showArchived")}</label>
      <ReadState loading={list.loading} error={list.error} empty={list.data?.items.length===0} emptyText={t("noCategories")} retry={list.retry}>
        <div className="table-wrap"><table><thead><tr><th>{t("categoryName")}</th><th></th></tr></thead><tbody>
          {list.data?.items.map(item=><tr key={item.id}><td><strong>{item.name}</strong>{!item.active&&<span className="tag">{t("archived")}</span>}</td>
            <td className="row-actions">{canEdit&&item.active&&<button className="text-button" onClick={()=>setEditing(item)}>{t("rename")}</button>}
              {canArchive&&<ArchiveCategory service={service} sessionId={sessionId} category={item}/>}</td></tr>)}
        </tbody></table></div>
      </ReadState>
      <Pager hasFirst={cursor!==undefined} hasNext={list.data?.next!==undefined} onFirst={()=>setCursor(undefined)} onNext={()=>{if(list.data?.next)setCursor({after:list.data.next,revision});}} />
    </div></>;
}
function CreateCategory({service,sessionId}:{service:ShopService;sessionId:string}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [name,setName]=useState(""),[requestId,setRequestId]=useState(()=>crypto.randomUUID()),[uncertain,setUncertain]=useState(false);
  const submit=async():Promise<void>=>{
    const value=await action.run(async()=>{
      const result=await service.createCategory({sessionId,requestId,name}).catch(()=>({ok:false as const,error:{code:"unavailable" as const}}));
      setUncertain(!result.ok&&result.error.code==="unavailable"); return result;
    });
    if(value!==undefined){setName("");setRequestId(crypto.randomUUID());}
  };
  return <div className="panel form-panel"><form className="inline-form" onSubmit={event=>{event.preventDefault();void submit();}}>
    <fieldset disabled={action.busy||uncertain}><Field id="category-name" label={t("newCategory")} value={name} onChange={setName}/></fieldset>
    <button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):uncertain?t("retry"):t("save")}</button>
  </form><ErrorText message={action.error}/></div>;
}
function CategoryForm({service,sessionId,category,onDone}:{service:ShopService;sessionId:string;category:CategoryView;onDone:()=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction(),[name,setName]=useState(category.name);
  return <div className="panel form-panel"><form className="inline-form" onSubmit={event=>{event.preventDefault();void action.run(()=>service.updateCategory({sessionId,categoryId:category.id,version:category.version,name,active:category.active})).then(value=>{if(value!==undefined)onDone();});}}>
    <fieldset disabled={action.busy}><Field id="category-rename" label={t("rename")} value={name} onChange={setName}/></fieldset>
    <button className="primary" type="submit" disabled={action.busy}>{t("save")}</button><button type="button" className="secondary" onClick={onDone}>{t("cancel")}</button>
  </form><ErrorText message={action.error} conflictMessage="staleVersion"/></div>;
}
function ArchiveCategory({service,sessionId,category}:{service:ShopService;sessionId:string;category:CategoryView}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  return <><button className="text-button" disabled={action.busy} onClick={()=>{void action.run(()=>service.updateCategory({sessionId,categoryId:category.id,version:category.version,name:category.name,active:!category.active}));}}>{t(category.active?"archive":"restore")}</button>
    <ErrorText message={action.error} conflictMessage="staleVersion"/></>;
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
