import { useState } from "react";
import { localDayPeriod } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity, formatRate } from "@kolo/core/domain/money";
import type { Permission } from "@kolo/core/identity/permissions";
import type { ReportKind, ReportLine, ReportResult, ShopService } from "../../shared/service.ts";
import type { TextKey } from "../text.ts";
import { ReadState, useRead, useText } from "./ui.tsx";

type Props = { readonly service: ShopService; readonly sessionId: string; readonly revision: number; readonly permissions: readonly Permission[] };
const authority: readonly (readonly [ReportKind, Permission, boolean])[] = [
  ["dashboard", "reports.financial", true], ["sales", "reports.sales", true], ["salesByProduct", "reports.sales", true], ["salesByCategory", "reports.sales", true],
  ["salesByAccount", "reports.sales", true], ["salesByUser", "reports.sales", true], ["cashFlow", "reports.financial", true], ["tax", "reports.financial", true], ["purchases", "reports.suppliers", true],
  ["fastMoving", "reports.inventory", true], ["valuation", "reports.financial", false], ["stockAlerts", "reports.inventory", false],
  ["customerDebt", "reports.customers", false], ["supplierDebt", "reports.suppliers", false],
];
/** Local calendar day as YYYY-MM-DD, the input the shared period rule expects. */
function day(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }

/** Period reports over local calendar days, and snapshots, each under its own report permission. */
export function Reports({ service, sessionId, revision, permissions }: Props): React.JSX.Element {
  const { t } = useText();
  const allowed=authority.filter(([,permission])=>permissions.includes(permission));
  const today=day(new Date());
  const [kind,setKind]=useState<ReportKind>(allowed[0]?.[0]??"sales"),[from,setFrom]=useState(today),[to,setTo]=useState(today);
  let period:{from:string;until:string}|undefined;
  try{period=localDayPeriod(from,to);}catch{period=undefined;}
  const dated=allowed.find(([id])=>id===kind)?.[2]??true;
  const preset=(start:Date):void=>{setFrom(day(start));setTo(today);};
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("reports")}</p><h1>{t("reportsHelp")}</h1></div></div>
    <div className="report-controls panel">
      <label className="field" htmlFor="report-kind"><span>{t("report")}</span><select id="report-kind" value={kind} onChange={event=>setKind(event.target.value as ReportKind)}>
        {allowed.map(([id])=><option key={id} value={id}>{t(`rep_${id}` as TextKey)}</option>)}</select></label>
      {dated&&<><label className="field" htmlFor="report-from"><span>{t("from")}</span><input id="report-from" type="date" value={from} max={to} onChange={event=>setFrom(event.target.value)}/></label>
        <label className="field" htmlFor="report-to"><span>{t("to")}</span><input id="report-to" type="date" value={to} min={from} onChange={event=>setTo(event.target.value)}/></label>
        <div className="actions presets"><button className="secondary" onClick={()=>preset(new Date())}>{t("today")}</button>
          <button className="secondary" onClick={()=>{const start=new Date();start.setDate(start.getDate()-6);preset(start);}}>{t("last7")}</button>
          <button className="secondary" onClick={()=>{const start=new Date();start.setDate(1);preset(start);}}>{t("thisMonth")}</button></div></>}
    </div>
    {period===undefined?<p className="notice error" role="alert">{t("invalidPeriod")}</p>:allowed.length===0?<p className="notice error">{t("noAccess")}</p>:
      <ReportView key={`${kind}:${period.from}:${period.until}`} service={service} sessionId={sessionId} revision={revision} kind={kind} period={period}/>}
  </section>;
}
function ReportView({service,sessionId,revision,kind,period}:{service:ShopService;sessionId:string;revision:number;kind:ReportKind;period:{from:string;until:string}}):React.JSX.Element{
  const read=useRead(()=>service.report({sessionId,kind,from:period.from,until:period.until}),[service,sessionId,kind,period.from,period.until,revision]);
  return <ReadState loading={read.loading} error={read.error} empty={false} emptyText="" retry={read.retry}>{read.data!==undefined&&<Result value={read.data}/>}</ReadState>;
}
function Tile({label,value,tone}:{label:string;value:string;tone?:"negative"}):React.JSX.Element{
  return <div className="stat-tile"><span>{label}</span><strong className={tone}>{value}</strong></div>;
}
function Lines({lines,truncated,countLabel}:{lines:readonly ReportLine[];truncated:boolean;countLabel:TextKey}):React.JSX.Element{
  const {t,language}=useText();
  if(lines.length===0)return <div className="panel empty"><p>{t("noReportData")}</p></div>;
  return <div className="panel"><div className="table-wrap"><table><thead><tr><th>{t("name")}</th><th>{t(countLabel)}</th><th className="numeric">{t("total")}</th></tr></thead><tbody>
    {lines.map(line=><tr key={line.key}><td>{line.label}</td><td>{line.count}</td><td className={`money numeric ${line.totalMinor<0?"negative":""}`}>{formatMoney(line.totalMinor,language)}</td></tr>)}
  </tbody></table></div>{truncated&&<p className="hint">{t("truncatedRows")}</p>}</div>;
}
function Result({value}:{value:ReportResult}):React.JSX.Element{
  const {t,language}=useText(),money=(minor:number):string=>formatMoney(minor,language),quantity=(thousandths:number):string=>formatQuantity(thousandths,language);
  switch(value.kind){
    case "dashboard": return <><div className="stat-grid"><Tile label={t("salesTotal")} value={money(value.salesMinor)}/><Tile label={t("transactions")} value={String(value.transactions)}/>
      <Tile label={t("grossProfit")} value={money(value.grossProfitMinor)} {...(value.grossProfitMinor<0?{tone:"negative" as const}:{})}/><Tile label={t("expenses")} value={money(value.expensesMinor)}/>
      <Tile label={t("netResult")} value={money(value.netResultMinor)} {...(value.netResultMinor<0?{tone:"negative" as const}:{})}/><Tile label={t("customersOwe")} value={money(value.customerDebtMinor)}/>
      <Tile label={t("owedToSuppliers")} value={money(value.supplierDebtMinor)}/><Tile label={t("lowStockCount")} value={String(value.lowStock)}/></div>
      {value.linesWithoutCost>0&&<p className="notice">{value.linesWithoutCost} {t("uncostedLines")}</p>}</>;
    case "sales": return <div className="stat-grid"><Tile label={t("salesTotal")} value={money(value.totalMinor)}/><Tile label={t("transactions")} value={String(value.transactions)}/><Tile label={t("itemsSold")} value={quantity(value.itemsSoldThousandths)}/></div>;
    case "salesByProduct": case "salesByCategory": case "salesByAccount": case "salesByUser": case "customerDebt": case "supplierDebt":
      return <Lines lines={value.lines} truncated={value.truncated} countLabel="countColumn"/>;
    case "purchases": return <><div className="stat-grid"><Tile label={t("rep_purchases")} value={money(value.totalMinor)}/><Tile label={t("deliveries")} value={String(value.deliveries)}/></div>
      <Lines lines={value.bySupplier} truncated={value.truncated} countLabel="deliveries"/></>;
    case "cashFlow": return value.accounts.length===0?<div className="panel empty"><p>{t("noReportData")}</p></div>:<div className="panel"><div className="table-wrap"><table><thead><tr><th>{t("account")}</th><th className="numeric">{t("moneyInShort")}</th><th className="numeric">{t("moneyOutShort")}</th><th className="numeric">{t("net")}</th><th className="numeric">{t("closing")}</th></tr></thead><tbody>
      {value.accounts.map(row=><tr key={row.accountId}><td>{row.name}</td><td className="money numeric">{money(row.inMinor)}</td><td className="money numeric">{money(row.outMinor)}</td><td className={`money numeric ${row.netMinor<0?"negative":""}`}>{money(row.netMinor)}</td><td className="money numeric">{money(row.closingMinor)}</td></tr>)}</tbody></table></div></div>;
    case "valuation": return <><div className="stat-grid"><Tile label={t("rep_valuation")} value={money(value.totalMinor)}/></div>{value.uncosted>0&&<p className="notice">{value.uncosted} {t("uncosted")}</p>}
      <div className="panel"><div className="table-wrap"><table><thead><tr><th>{t("name")}</th><th className="numeric">{t("stock")}</th><th className="numeric">{t("unitCostShort")}</th><th className="numeric">{t("value")}</th></tr></thead><tbody>
        {value.products.map(row=><tr key={row.productId}><td>{row.name}</td><td className={`numeric ${row.onHandThousandths<0?"negative":""}`}>{quantity(row.onHandThousandths)}</td><td className="money numeric">{row.unitCostMinor===undefined?"—":money(row.unitCostMinor)}</td><td className="money numeric">{row.valueMinor===undefined?"—":money(row.valueMinor)}</td></tr>)}
      </tbody></table></div>{value.truncated&&<p className="hint">{t("truncatedRows")}</p>}</div></>;
    case "fastMoving": return value.products.length===0?<div className="panel empty"><p>{t("noReportData")}</p></div>:<div className="panel"><div className="table-wrap"><table><thead><tr><th>{t("name")}</th><th className="numeric">{t("itemsSold")}</th><th className="numeric">{t("revenue")}</th><th className="numeric">{t("stock")}</th></tr></thead><tbody>
      {value.products.map(row=><tr key={row.productId}><td>{row.name}</td><td className="numeric">{quantity(row.soldThousandths)}</td><td className="money numeric">{money(row.revenueMinor)}</td><td className={`numeric ${row.onHandThousandths<0?"negative":""}`}>{quantity(row.onHandThousandths)}</td></tr>)}</tbody></table></div></div>;
    case "tax": return <><div className="stat-grid"><Tile label={t("grossIncl")} value={money(value.grossMinor)}/><Tile label={`${t("taxAmount")} · ${value.label}`} value={money(value.taxMinor)}/><Tile label={t("netExcl")} value={money(value.netMinor)}/></div>
      <p className="hint">{t("taxReportNote")}</p>
      {value.groups.length===0?<div className="panel empty"><p>{t("noReportData")}</p></div>:<div className="panel"><div className="table-wrap"><table><thead><tr><th>{t("taxRateColumn")}</th><th className="numeric">{t("grossIncl")}</th><th className="numeric">{t("taxAmount")}</th><th className="numeric">{t("netExcl")}</th></tr></thead><tbody>
        {value.groups.map(row=><tr key={row.rateBasisPoints}><td>{formatRate(row.rateBasisPoints,language)}</td><td className={`money numeric ${row.grossMinor<0?"negative":""}`}>{money(row.grossMinor)}</td><td className="money numeric">{money(row.taxMinor)}</td><td className="money numeric">{money(row.netMinor)}</td></tr>)}
      </tbody></table></div></div>}</>;
    case "stockAlerts": return value.products.length===0?<div className="panel empty"><p>{t("noReportData")}</p></div>:<div className="panel"><div className="table-wrap"><table><thead><tr><th>{t("name")}</th><th className="numeric">{t("stock")}</th></tr></thead><tbody>
      {value.products.map(row=><tr key={row.productId}><td>{row.name}{row.onHandThousandths<0&&<small className="negative">{t("negativeStock")}</small>}</td><td className={`numeric ${row.onHandThousandths<0?"negative":""}`}>{quantity(row.onHandThousandths)}</td></tr>)}</tbody></table></div>{value.truncated&&<p className="hint">{t("truncatedRows")}</p>}</div>;
  }
}
