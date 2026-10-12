import { useState } from "react";
import type { ShopService, WorkspaceView } from "../../shared/service.ts";
import { AuthPage, EntryChoice, LocalGuide } from "./AuthPage.tsx";
import { ImportFile, JoinLocalComputer } from "./Transfer.tsx";
import { ErrorText, Field, useAction, useText } from "./ui.tsx";
import type { LegalKind } from "../legal.ts";

/**
 * Entry screens, one shop per computer. A new computer creates a shop or imports a file (a backup,
 * or an invite that joins another till's shop). A computer with a shop opens it with a code; a
 * forgotten owner code is recovered with the recovery key; importing a backup replaces the shop.
 */
export function Workspace({ service, view, refresh, onRecoveryKey, onLegal }: {
  readonly service: ShopService; readonly view: WorkspaceView; readonly refresh: () => void;
  readonly onRecoveryKey: (key: string, sessionId: string) => void;
  readonly onLegal?: (kind: LegalKind) => void;
}): React.JSX.Element {
  const { t } = useText(), action = useAction();
  const [mode, setMode] = useState<"home" | "create" | "recover" | "import" | "fresh" | "join">("home");
  const [step, setStep] = useState<1 | 2>(1);
  const [shop, setShop] = useState(""), [owner, setOwner] = useState(""), [device, setDevice] = useState(() => t("defaultTill")), [cash, setCash] = useState(() => t("defaultCash"));
  const [secret, setSecret] = useState(""), [confirmation, setConfirmation] = useState(""), [key, setKey] = useState(""), [confirmedName, setConfirmedName] = useState("");
  const [userId, setUserId] = useState(view.members[0]?.id ?? ""), [recovered, setRecovered] = useState(false);
  const empty = view.state === "empty", pending = view.state === "pending";
  const selectedUser = view.members.some(member => member.id === userId) ? userId : view.members[0]?.id ?? "";
  const context = view.shopName ?? t("onThisComputer");
  const go = (next: typeof mode): void => { setMode(next); setSecret(""); setConfirmation(""); setKey(""); setConfirmedName(""); setRecovered(false); action.setError(undefined); };
  const importChoice = <EntryChoice title={t(empty ? "importFile" : "importBackup")} description={t(empty ? "importChoiceHelp" : "importReplaceChoiceHelp")} action="import" disabled={action.busy} onClick={() => go("import")}/>;

  if (mode === "import") return <ImportFile service={service} {...(empty ? {} : { replacing: view.shopName ?? "KOLO" })} onBack={() => go("home")} onDone={() => { go("home"); refresh(); }}/>;
  if(mode==="join")return <JoinLocalComputer service={service} onBack={()=>go("home")} onDone={()=>{go("home");refresh();}}/>;
  if (empty && mode !== "create") return <AuthPage title={t("entryWelcome")} description={t("entryWelcomeHelp")} context={t("welcome")} aside={<LocalGuide/>}>
    <h2>{t("startHere")}</h2><div className="entry-choices">
      <EntryChoice title={t("startNewShop")} description={t("createChoiceHelp")} featured action="create" disabled={action.busy} onClick={() => { go("create"); setStep(1); }}/>
      <EntryChoice title={t("joinLocalShop")} description={t("joinLocalEntryHelp")} action="join" disabled={action.busy} onClick={()=>go("join")}/>
      {importChoice}
    </div><ErrorText message={action.error}/>
  </AuthPage>;
  // An unconverted legacy till cannot be opened here: import a backup or start over (its data stays on disk).
  if (view.state === "legacy" && mode === "fresh") return <AuthPage title={t("startNewShop")} description={t("startNewShopHelp")} context={context} onBack={() => go("home")} busy={action.busy} aside={<LocalGuide/>}>
    <h2>{t("confirmNewShop")}</h2><p>{t("startNewShopConfirm")} <strong>{view.shopName ?? "KOLO"}</strong></p>
    <form onSubmit={event => { event.preventDefault(); void action.run(() => service.startNewShop({ confirmedName })).then(result => {
      if (result?.activated) { go("create"); setStep(1); setShop(""); setOwner(""); refresh(); }
    }); }}><fieldset disabled={action.busy}><Field id="fresh-shop-confirmation" label={t("startNewShopName")} value={confirmedName} onChange={setConfirmedName}/>
      <ErrorText message={action.error}/><button type="submit" className="primary" disabled={confirmedName.trim() !== (view.shopName ?? "KOLO")}>{action.busy ? t("recording") : t("continueSetup")}<span aria-hidden="true">→</span></button>
    </fieldset></form>
  </AuthPage>;
  if (view.state === "legacy") return <AuthPage title={t("legacyTitle")} description={t("legacyHelp")} context={context}
    aside={<><p className="eyebrow">{t("otherOptions")}</p><div className="entry-choices">{importChoice}
      <EntryChoice title={t("startNewShop")} description={t("newChoiceHelp")} action="fresh" disabled={action.busy} onClick={() => go("fresh")}/></div></>}><LocalGuide/></AuthPage>;

  const recovering = mode === "recover", creating = empty && mode === "create";
  const submit = async (): Promise<void> => {
    if (creating && step === 1) { if (![shop,owner,device,cash].every(value => value.trim().length > 0)) { action.setError({code:"setupNamesInput"}); return; } setStep(2); action.setError(undefined); return; }
    if ((creating || recovering) && secret !== confirmation) { action.setError({ code: "codesMismatch" }); return; }
    await action.run(async () => {
      if (recovering) {
        const result = await service.recoverAccess({ recoveryCode: key, newSecret: secret });
        if (result.ok) { go("home"); setRecovered(true); setUserId(result.value.members[0]?.id ?? ""); refresh(); }
        return result;
      }
      if (creating || pending) {
        const result = creating ? await service.createShop({ businessName: shop, ownerName: owner, deviceLabel: device, cashAccountName: cash, secret }) : await service.finishSetup({ secret });
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
  const title = recovering ? t("recoverTitle") : creating ? t(step === 1 ? "setupDetails" : "setupAccess") : pending ? t("pendingTitle") : t("loginTitle");
  const description = recovering ? t("recoverHelp") : creating ? t(step === 1 ? "setupDetailsHelp" : "setupAccessHelp") : pending ? t("pendingHelp") : t("loginHelp");
  const elsewhere = <><p className="eyebrow">{t("otherOptions")}</p><div className="entry-choices">{importChoice}</div><p className="entry-footnote">{t("importKeepsCopy")}</p></>;
  const guide = creating ? <><p className="eyebrow">{t("yourNewShop")}</p><h2>{shop || t("setupGuideTitle")}</h2><p>{t("setupGuideHelp")}</p>
    {step === 2 && <dl className="entry-summary"><dt>{t("ownerName")}</dt><dd>{owner}</dd><dt>{t("deviceName")}</dt><dd>{device}</dd><dt>{t("cashName")}</dt><dd>{cash}</dd></dl>}<div className="entry-note"><span className="status-dot"/><span>{t("offlineGuide")}</span></div></>
    : recovering ? <><p className="eyebrow">{t("recoveryGuideLabel")}</p><h2>{t("recoveryGuideTitle")}</h2><p>{t("recoveryGuideHelp")}</p><p>{t("recoveryNoKey")}</p>{importChoice}</> : elsewhere;
  return <AuthPage title={title} description={description} context={creating ? t("startNewShop") : context} busy={action.busy} aside={guide}
    {...(creating || recovering ? {onBack: () => {if(creating && step === 2){setStep(1);action.setError(undefined);}else go("home");}} : {})}>
    {creating && <ol className="setup-progress" aria-label={t("setupProgress")}><li aria-current={step === 1 ? "step" : undefined} className={step === 1 ? "current" : "done"}><span>1</span>{t("setupDetails")}</li><li aria-current={step === 2 ? "step" : undefined} className={step === 2 ? "current" : ""}><span>2</span>{t("setupAccess")}</li></ol>}
    {!creating && !recovering && <div className="entry-shop"><span className="shop-monogram" aria-hidden="true">{view.shopName?.slice(0,1).toUpperCase() ?? "K"}</span><div><strong>{view.shopName}</strong><span>{t("selectedShop")}</span></div></div>}
    {recovered && <p role="status" className="notice success">{t("recoveredNotice")}</p>}
    <form onSubmit={event => { event.preventDefault(); void submit(); }}><fieldset disabled={action.busy}>
      {creating && step === 1 ? <><div className="two-fields"><Field id="shop-name" label={t("shopName")} value={shop} onChange={setShop}/><Field id="owner-name" label={t("ownerName")} value={owner} onChange={setOwner}/></div>
        <details className="setup-options"><summary>{t("setupOptions")}</summary><p className="hint">{t("setupOptionsHelp")}</p><div className="two-fields"><Field id="device-name" label={t("deviceName")} value={device} onChange={setDevice}/><Field id="cash-name" label={t("cashName")} value={cash} onChange={setCash}/></div></details></>
        : <>{!creating && !pending && !recovering && <label className="field" htmlFor="user-id"><span>{t("member")}</span><select id="user-id" value={selectedUser} onChange={event => {setUserId(event.target.value);setSecret("");}} required>{view.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
          {recovering && <Field id="recovery-key" label={t("recoveryKey")} value={key} onChange={setKey} secret maxLength={256}/>}
          <div className={creating || recovering ? "two-fields" : ""}><Field id="local-secret" label={t(recovering ? "newSecret" : "secret")} value={secret} onChange={setSecret} secret maxLength={256}/>
            {(creating || recovering) && <Field id="confirm-secret" label={t("confirmSecret")} value={confirmation} onChange={setConfirmation} secret maxLength={256}/>}</div>
          {(creating || pending || recovering) && <p className="hint">{t("secretHelp")}</p>}
          {creating && <p className="hint setup-accept">{t("setupAccept")}{onLegal && <> <button type="button" className="link-button" onClick={() => onLegal("terms")}>{t("legal.terms")}</button> · <button type="button" className="link-button" onClick={() => onLegal("privacy")}>{t("legal.privacy")}</button></>}</p>}</>}
      <ErrorText message={action.error} inputMessage="identityInput"/>
      <div className="entry-submit"><button type="submit" className="primary">{action.busy ? t("recording") : recovering ? t("recoverSubmit") : creating ? t(step === 1 ? "continue" : "createAndOpen") : pending ? t("continue") : t("unlock")}<span aria-hidden="true">→</span></button>
        {!creating && !pending && !recovering && <button type="button" className="text-button" data-auth-action="recover" onClick={() => go("recover")}>{t("recover")}</button>}</div>
    </fieldset></form>
  </AuthPage>;
}
