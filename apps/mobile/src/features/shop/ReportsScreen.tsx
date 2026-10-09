import { useState } from "react";
import { Text, View } from "react-native";
import { dashboard, salesBetween } from "@kolo/core/application/reports";
import { debtPage, stockAlertPage } from "@kolo/core/application/queries";
import { localDayPeriod } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import { useText } from "../../app/i18n.tsx";
import { Browse } from "./browse.tsx";
import { Button, Choices, Field, styles, useRevision } from "./ui.tsx";
import type { ShopProps } from "./types.ts";

/** Local net reports and paginated debt/stock alerts; calendar periods use device timezone. */
export function ReportsScreen({ database, context, permissions }: ShopProps): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database, ["sales", "inventory", "customers", "suppliers", "purchases", "accounts", "expenses", "authority"]);
  const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const [from, setFrom] = useState(today), [to, setTo] = useState(today), [period, setPeriod] = useState({ from: today, to: today }), [invalid, setInvalid] = useState(false),[chosen,setChosen]=useState("inventory");
  let content: React.JSX.Element | undefined;
  try {
    const range = localDayPeriod(period.from, period.to);
    if (permissions.includes("reports.financial")) {
      const report = dashboard(context, range.from, range.until);
      content = <>{([ ["revenue", report.sales.totalMinor], ["profit", report.profit.grossProfitMinor], ["expenses", report.expensesMinor], ["net", report.netResultMinor], ["customerDebt", report.customerDebtMinor], ["supplierDebt", report.supplierDebtMinor] ] as const).map(([key, value]) => <Text key={key} style={styles.text}>{t(key)}: {formatMoney(value)}</Text>)}<Text style={styles.text}>{t("lowStock")}: {report.lowStock} · {t("unknownCost")}: {report.profit.linesWithoutCost}</Text></>;
    } else if(permissions.includes("reports.sales"))content=<Text style={styles.text}>{t("revenue")}: {formatMoney(salesBetween(context, range.from, range.until).totalMinor)}</Text>;
  } catch { content = <Text accessibilityRole="alert" style={styles.error}>{t("error")}</Text>; }
  const choices=[...(permissions.includes("reports.inventory")?[{id:"inventory",name:t("stock")}]:[]),...(permissions.includes("reports.customers")?[{id:"customer",name:t("customerDebt")}]:[]),...(permissions.includes("reports.suppliers")?[{id:"supplier",name:t("supplierDebt")}]:[])];
  const selected=choices.some(choice=>choice.id===chosen)?chosen:choices[0]?.id;
  const header=<View style={{gap:12}}><Field label={t("from")} value={from} onChange={setFrom} /><Field label={t("to")} value={to} onChange={setTo} />
    <Button label={t("refresh")} onPress={() => { try { localDayPeriod(from, to); setPeriod({ from, to }); setInvalid(false); } catch { setInvalid(true); } }} />
    {invalid && <Text style={styles.error}>{t("error")}</Text>}{content!==undefined&&<View style={styles.card}>{content}</View>}
    <Choices label={t("reports")} value={selected??""} items={choices} onChange={setChosen} />
  </View>;
  return <Browse<{id:string;name:string;amount:number}> key={selected??"summary"} revision={revision} identify={item=>item.id} header={header} load={query=>{
    if(selected===undefined)return {items:[]};
    if(selected==="inventory"){const page=stockAlertPage(context,query);return {...page,items:page.items.map(item=>({id:item.id,name:item.name,amount:item.quantity}))};}
    const page=debtPage(context,selected as "customer"|"supplier",query);return {...page,items:page.items.map(item=>({id:item.id,name:item.name,amount:item.amountMinor}))};
  }} render={item=><Text style={item.amount<0?styles.error:styles.text}>{item.name} · {selected==="inventory"?formatQuantity(item.amount):formatMoney(item.amount)}</Text>} />;
}
