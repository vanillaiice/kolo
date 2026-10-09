import { useState } from "react";
import type { ShopService, WorkspaceView } from "../../shared/service.ts";
import { ErrorText, Field, useAction, useText } from "./ui.tsx";

/** Offline create/pending/unlock/recovery forms depend only on the replaceable UI service. */
export function Workspace({ service, view, refresh, onRecoveryKey }: {
  readonly service: ShopService; readonly view: WorkspaceView; readonly refresh: () => void; readonly onRecoveryKey: (key: string, sessionId: string) => void;
}): React.JSX.Element {
  const { t } = useText(), action = useAction();
  const [shop, setShop] = useState(""), [owner, setOwner] = useState(""), [device, setDevice] = useState(() => t("defaultTill")), [cash, setCash] = useState(() => t("defaultCash"));
  const [secret, setSecret] = useState(""), [confirmation, setConfirmation] = useState(""), [userId, setUserId] = useState(view.members[0]?.id ?? ""), [recovering, setRecovering] = useState(false), [key, setKey] = useState("");
  const setup = view.state === "empty", pending = view.state === "pending", confirm = setup || recovering;
  const selectedUser = view.members.some(member => member.id === userId) ? userId : view.members[0]?.id ?? "";
  if (view.state === "legacy") return <section className="auth-card"><h1>{t("legacyTitle")}</h1><p className="muted">{t("legacyHelp")}</p></section>;
  const submit = async (): Promise<void> => {
    if (confirm && secret !== confirmation) { action.setError({ code: "codesMismatch" }); return; }
    await action.run(async () => {
      if (recovering) {
        const result = await service.recoverAccess({ recoveryCode: key, newSecret: secret });
        if (result.ok) { setSecret(""); setConfirmation(""); setKey(""); setRecovering(false); refresh(); }
        return result;
      }
      if (setup || pending) {
        const result = setup ? await service.createShop({ businessName: shop, ownerName: owner, deviceLabel: device, cashAccountName: cash, secret }) : await service.finishSetup({ secret });
        if (!result.ok) return result;
        const ownerId = result.value.members[0]?.id;
        if (ownerId === undefined) return { ok: false, error: { code: "actor_inactive" } };
        const unlocked = await service.unlock({ userId: ownerId, secret });
        if (!unlocked.ok) { refresh(); return unlocked; }
        if (unlocked.value.sessionId !== null) {
          const recovery = await service.recoveryKey({ sessionId: unlocked.value.sessionId, secret });
          if (recovery.ok && recovery.value !== null) onRecoveryKey(recovery.value, unlocked.value.sessionId);
        }
        setSecret(""); setConfirmation(""); refresh(); return unlocked;
      }
      const result = await service.unlock({ userId: selectedUser, secret });
      if (result.ok) { setSecret(""); refresh(); }
      return result;
    });
  };
  return <section className="auth-card">
    <p className="eyebrow">{view.shopName ?? "KOLO"}</p>
    <h1>{recovering ? t("recoverTitle") : setup ? t("welcome") : pending ? t("pendingTitle") : t("unlockTitle")}</h1>
    <p className="muted">{setup ? t("welcomeHelp") : pending ? t("pendingHelp") : t("unlockHelp")}</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={action.busy}>
        {setup && <><Field id="shop-name" label={t("shopName")} value={shop} onChange={setShop} /><Field id="owner-name" label={t("ownerName")} value={owner} onChange={setOwner} />
          <div className="two-fields"><Field id="device-name" label={t("deviceName")} value={device} onChange={setDevice} /><Field id="cash-name" label={t("cashName")} value={cash} onChange={setCash} /></div></>}
        {!setup && !pending && !recovering && <label className="field" htmlFor="user-id"><span>{t("member")}</span><select id="user-id" value={selectedUser} onChange={event=>setUserId(event.target.value)} required>
          {view.members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
        {recovering && <Field id="recovery-key" label={t("recoveryKey")} value={key} onChange={setKey} secret maxLength={256} />}
        <Field id="local-secret" label={recovering ? t("newSecret") : t("secret")} value={secret} onChange={setSecret} secret maxLength={256} />
        {(setup || pending || recovering) && <p className="hint">{t("secretHelp")}</p>}
        {confirm && <Field id="confirm-secret" label={t("confirmSecret")} value={confirmation} onChange={setConfirmation} secret maxLength={256} />}
        <ErrorText message={action.error} inputMessage="identityInput" />
        <button type="submit" className="primary full" disabled={action.busy}>{action.busy ? t("recording") : recovering ? t("recoverSubmit") : setup ? t("createShop") : pending ? t("continue") : t("unlock")} <span aria-hidden="true">→</span></button>
      </fieldset>
    </form>
    {!setup && !pending && <button disabled={action.busy} className="text-button" onClick={()=>{setRecovering(value=>!value);setSecret("");setConfirmation("");action.setError(undefined);}}>{recovering ? t("back") : t("recover")}</button>}
    <p className="local-line"><span className="status-dot" />{t("local")}</p>
  </section>;
}
