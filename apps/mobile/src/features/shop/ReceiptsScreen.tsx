import { useState } from "react";
import { ScrollView, Share, Text, View } from "react-native";
import { receipt, receipts, type Receipt } from "@kolo/core/application/queries";
import { lineTotal } from "@kolo/core/rules/pricing";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import { useText } from "../../app/i18n.tsx";
import { ReturnForm } from "./ReturnForm.tsx";
import { Browse } from "./browse.tsx";
import { Button, styles, useRevision } from "./ui.tsx";
import type { ShopProps } from "./types.ts";

/** Saved receipt details survive restart and use historical line values; OS sharing is optional. */
export function ReceiptsScreen({ database, context, permissions, branchId, initialId, businessName }: ShopProps & { readonly initialId?: string | undefined; readonly businessName: string }): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database, ["sales", "customers", "accounts", "authority"]), [saleId, setSaleId] = useState(initialId), [shareError, setShareError] = useState(false), [retry, setRetry] = useState(0), [returning, setReturning] = useState(false);
  void retry;
  if (saleId !== undefined) {
    let saved: Receipt | undefined; try { saved = receipt(context, saleId); } catch { /* Visible error below. */ }
    const content = saved === undefined ? "" : [businessName, `${t("receipt")} ${saved.number}`, saved.occurredAt, saved.customerName ?? "",
      ...saved.lines.map(line => `${line.name} · ${formatQuantity(line.quantity)} × ${formatMoney(line.unitPriceMinor)} = ${formatMoney(lineTotal(line))}`),
      `${t("discount")}: ${formatMoney(saved.discountMinor)}`, `${t("total")}: ${formatMoney(saved.totalMinor)}`,
      ...saved.payments.map(payment => `${payment.name}: ${formatMoney(payment.amountMinor)}`), `${t("paid")}: ${formatMoney(saved.paidMinor)}`, `${t("due")}: ${formatMoney(saved.outstandingMinor)}`, `${t("returned")}: ${formatMoney(saved.returnedMinor)}`].join("\n");
    return <ScrollView style={styles.screen} contentContainerStyle={styles.content}><Button label={t("back")} onPress={() => setSaleId(undefined)} />
      {saved === undefined ? <><Text accessibilityRole="alert" style={styles.error}>{t("error")}</Text><Button label={t("retry")} onPress={() => setRetry(value => value + 1)} /></> : <>
        <Text selectable style={styles.text}>{content}</Text><Button label={t("share")} onPress={() => { setShareError(false); void Share.share({ message: content }).catch(() => setShareError(true)); }} />
        {shareError && <Text style={styles.error}>{t("error")}</Text>}
        {permissions.includes("sales.refund") && <Button label={t("returnGoods")} onPress={() => setReturning(!returning)} />}
        {returning && <ReturnForm database={database} context={context} permissions={permissions} branchId={branchId} kind="SALE" originalId={saleId} onClose={() => setReturning(false)} />}
      </>}
    </ScrollView>;
  }
  return <Browse<ReturnType<typeof receipts>["items"][number]> revision={revision} searchable={false} identify={item => item.id} load={query => receipts(context, query)}
    render={item => <View style={{ gap: 8 }}><Text style={styles.text}>{item.number} · {item.occurredAt}</Text><Button label={t("receipt")} onPress={() => setSaleId(item.id)} /></View>} />;
}
