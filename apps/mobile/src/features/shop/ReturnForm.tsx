import { useState } from "react";
import { Text, View } from "react-native";
import { returnableItems, previewReturn, returnSale, returnPurchase } from "@kolo/core/application/returns";
import { paymentAccounts } from "@kolo/core/application/queries";
import type { ReturnKind, ReturnSource } from "@kolo/core/data/returns/returns";
import type { Account } from "@kolo/core/data/finance/accounts";
import { moneyEntry, quantityEntry, quantityInput } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { Picker } from "./browse.tsx";
import { Button, Field, styles, useCommand, useRevision } from "./ui.tsx";
import type { ShopProps } from "./types.ts";

/** Partial/full return preview, explicit refund allocation and compensating commit against the current predecessor. */
export function ReturnForm({ database, context, kind, originalId, onClose }: ShopProps & { readonly kind: ReturnKind; readonly originalId: string; readonly onClose: () => void }): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database,["sales","purchases","inventory","customers","suppliers","accounts","authority"]), command=useCommand();
  const [quantities,setQuantities]=useState<Record<string,string>>({}),[refund,setRefund]=useState(""),[reason,setReason]=useState(""),[account,setAccount]=useState<Account>();
  let source:ReturnSource|undefined,preview:ReturnType<typeof previewReturn>|undefined,invalid=false,refundMinor=0;
  try {
    source=returnableItems(context,kind,originalId);
    const selection=source.items.map(item=>({originalItemId:item.id,quantity:quantityEntry(quantities[item.id]??"0")})).filter(item=>item.quantity>0);
    if(selection.length>0)preview=previewReturn(context,kind,originalId,selection);
    if(preview!==undefined){refundMinor=refund.trim()==="" ? source.counterpartyId===undefined ? preview.totalMinor : 0 : moneyEntry(refund);if(refundMinor>preview.totalMinor)invalid=true;}
  }catch{invalid=true;}
  return <View style={styles.card}><Text style={styles.title}>{t("returnGoods")}</Text><Button label={t("cancel")} onPress={onClose} />
    {source!==undefined&&<><Button label={t("fullReturn")} onPress={()=>setQuantities(Object.fromEntries(source!.items.map(item=>[item.id,quantityInput(item.originalQuantity-item.returnedQuantity)])))} />
      {source.items.map(item=><View key={item.id} style={{gap:8}}><Text style={styles.text}>{item.name} · {t("remaining")}: {formatQuantity(item.originalQuantity-item.returnedQuantity)}</Text><Field label={t("quantity")} value={quantities[item.id]??"0"} numeric onChange={value=>setQuantities(current=>({...current,[item.id]:value}))} /></View>)}
      {preview!==undefined&&<><Text style={styles.text}>{t("total")}: {formatMoney(preview.totalMinor)}</Text><Field label={t("refundAmount")} value={refund} onChange={setRefund} numeric />
        <Text style={styles.text}>{t("refund")}: {formatMoney(refundMinor)} · {t("returnCredit")}: {formatMoney(preview.totalMinor-refundMinor)}</Text><Text style={styles.text}>{t("returnHint")}</Text>
        {refundMinor>0&&<Picker label={t("account")} value={account} onChange={setAccount} revision={revision} load={query=>paymentAccounts(context,query)} />}
      </>}
      <Field label={t("reason")} value={reason} onChange={setReason} />
      <Button label={t("recordReturn")} disabled={invalid||preview===undefined||refundMinor>0&&account===undefined||reason.trim()===""} onPress={()=>command.run(()=>{
        const input={id:newIdOnDevice(),eventId:newIdOnDevice(),originalId,priorId:preview!.source.priorId,reason:reason.trim(),
          items:preview!.lines.map(line=>({id:newIdOnDevice(),movementId:newIdOnDevice(),originalItemId:line.originalItemId,quantity:line.quantity})),
          refunds:refundMinor>0?[{id:newIdOnDevice(),accountId:account!.id,amountMinor:refundMinor}]:[],debtTransactionId:preview!.totalMinor>refundMinor?newIdOnDevice():undefined};
        if(kind==="SALE")returnSale(context,input);else returnPurchase(context,input);
      },onClose)} />
    </>}{invalid&&<Text accessibilityRole="alert" style={styles.error}>{t("error")}</Text>}{command.message}
  </View>;
}
