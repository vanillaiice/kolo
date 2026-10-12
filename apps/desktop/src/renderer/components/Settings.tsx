import type { ShopService } from "../../shared/service.ts";
import type { Language } from "../text.ts";
import { useState } from "react";
import { ErrorText, Field, useAction, useRead, useText } from "./ui.tsx";
import { LegalLinks } from "./Legal.tsx";
import { SystemNotificationsPanel, TaxPanel, TermsPanel } from "./ShopSettings.tsx";
import { moveNav, NAV_IDS, type NavId } from "../nav-order.ts";
import type { LegalKind } from "../legal.ts";

/** Window appearance choice; "system" follows the operating system's light/dark setting. */
export type Appearance = "system" | "light" | "dark";
const appearanceKey = "kolo.appearance";
/** Reads the saved appearance for this computer, defaulting to the system setting. */
export function storedAppearance(): Appearance {
  try { const value = localStorage.getItem(appearanceKey); return value === "light" || value === "dark" ? value : "system"; } catch { return "system"; }
}
/** Applies an appearance to the document and remembers it for the next launch. */
export function applyAppearance(value: Appearance): void {
  if (value === "system") delete document.documentElement.dataset["theme"]; else document.documentElement.dataset["theme"] = value;
  try { localStorage.setItem(appearanceKey, value); } catch { /* The choice remains active for the current session. */ }
}

/** Per-computer display and session preferences, available to every signed-in user. */
export function Settings({ service, sessionId, canChangeFiles, canShopSettings, canViewProducts, appearance, onAppearance, language, onLanguage, onLegal, navOrder, onNavOrder }: {
  readonly service: ShopService; readonly sessionId: string; readonly canChangeFiles: boolean; readonly canViewProducts: boolean;
  /** business.settings: shop-wide tax and payment terms, which sync to every till. */
  readonly canShopSettings: boolean;
  readonly appearance: Appearance; readonly onAppearance: (value: Appearance) => void;
  readonly language: Language; readonly onLanguage: (value: Language) => void; readonly onLegal: (kind: LegalKind) => void;
  /** This computer's sidebar order; also changed by dragging menu items. */
  readonly navOrder: readonly NavId[]; readonly onNavOrder: (order: NavId[]) => void;
}): React.JSX.Element {
  const { t } = useText(), action = useAction();
  const preferences = useRead(() => service.sessionPreferences({ sessionId }), [service, sessionId]);
  const remember = (enabled: boolean): void => { void action.run(() => service.setRememberSession({ sessionId, enabled })).then(value => { if (value !== undefined) preferences.retry(); }); };
  const large = useAction(), usage = useRead(() => canViewProducts ? service.photoUsage({ sessionId }) : Promise.resolve({ ok: true as const, value: undefined }), [service, sessionId, canViewProducts, preferences.data?.largeFiles]);
  const setLarge = (enabled: boolean): void => { void large.run(() => service.setLargeFiles({ sessionId, enabled })).then(value => { if (value !== undefined) preferences.retry(); }); };
  // Kilobytes below a megabyte so a handful of thumbnails does not read as zero; French writes ko/Mo.
  const size = (bytes: number): string => { const megabyte = bytes >= 1024 * 1024, value = bytes / (megabyte ? 1024 * 1024 : 1024);
    return `${new Intl.NumberFormat(language === "fr" ? "fr-FR" : "en-GB", { maximumFractionDigits: 1 }).format(value)} ${language === "fr" ? megabyte ? "Mo" : "ko" : megabyte ? "MB" : "KB"}`; };
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("settings")}</p><h1>{t("settingsHelp")}</h1></div></div>
    <div className="detail-layout">
      <div className="panel"><h2 id="appearance-title">{t("appearance")}</h2><p className="hint">{t("appearanceHelp")}</p>
        <div className="segmented" role="radiogroup" aria-labelledby="appearance-title">{(["system", "light", "dark"] as const).map(item =>
          <label key={item} className={appearance === item ? "selected" : ""}><input type="radio" name="appearance" value={item} checked={appearance === item} onChange={() => onAppearance(item)}/>{t(`appearance.${item}`)}</label>)}</div>
      </div>
      {canShopSettings && <TaxPanel service={service} sessionId={sessionId}/>}
      {canShopSettings && <TermsPanel service={service} sessionId={sessionId}/>}
      <SystemNotificationsPanel/>
      <div className="panel"><h2>{t("signIn")}</h2>
        <label className="check" htmlFor="remember-session"><input id="remember-session" type="checkbox" checked={preferences.data?.rememberSession ?? false}
          disabled={action.busy || preferences.data === undefined} onChange={event => remember(event.target.checked)}/>{t("rememberSession")}</label>
        <p className="hint">{t("rememberSessionHelp")}</p><ErrorText message={action.error ?? preferences.error}/>
      </div>
      <div className="panel"><h2>{t("largeFiles")}</h2>
        <label className="check" htmlFor="large-files"><input id="large-files" type="checkbox" checked={preferences.data?.largeFiles ?? false}
          disabled={!canChangeFiles || large.busy || preferences.data === undefined} onChange={event => setLarge(event.target.checked)}/>{t("largeFilesLabel")}</label>
        <p className="hint">{t("largeFilesHelp")}</p>{!canChangeFiles && <p className="hint">{t("ownerOnlySetting")}</p>}
        {usage.data !== undefined && <p className="hint photo-usage">{usage.data.photos} {t(usage.data.photos === 1 ? "photoStored" : "photosStored")} · {size(usage.data.bytes)} / {size(usage.data.limitBytes)}</p>}
        <ErrorText message={large.error}/>
      </div>
      <div className="panel"><h2 id="language-title">{t("language")}</h2><p className="hint">{t("languageHelp")}</p>
        <div className="segmented" role="radiogroup" aria-labelledby="language-title">{(["fr", "en"] as const).map(item =>
          <label key={item} className={language === item ? "selected" : ""}><input type="radio" name="language" value={item} checked={language === item} onChange={() => onLanguage(item)}/>{item === "fr" ? "Français" : "English"}</label>)}</div>
      </div>
      <div className="panel"><h2 id="menu-order-title">{t("menuOrder")}</h2><p className="hint">{t("menuOrderHelp")}</p>
        <ol className="menu-order" aria-labelledby="menu-order-title">{navOrder.map((id, index) => <li key={id}><span>{t(id)}</span>
          <button className="text-button" aria-label={`${t("moveUp")} : ${t(id)}`} disabled={index === 0} onClick={() => onNavOrder(moveNav(navOrder, id, -1))}>↑</button>
          <button className="text-button" aria-label={`${t("moveDown")} : ${t(id)}`} disabled={index === navOrder.length - 1} onClick={() => onNavOrder(moveNav(navOrder, id, 1))}>↓</button></li>)}</ol>
        <button className="secondary" disabled={navOrder.every((id, index) => NAV_IDS[index] === id)} onClick={() => onNavOrder([...NAV_IDS])}>{t("resetMenuOrder")}</button>
      </div>
      {canChangeFiles && <ResetPanel service={service} sessionId={sessionId}/>}
      <div className="panel about-panel"><h2>{t("about")}</h2><p className="hint">{t("aboutHelp")}</p>
        <dl className="facts"><dt>{t("version")}</dt><dd>KOLO {__KOLO_VERSION__}</dd></dl>
        <p className="eyebrow about-legal-title">{t("legal")}</p><LegalLinks onOpen={onLegal}/></div>
    </div>
  </section>;
}

/**
 * Owner-only computer reset: the typed shop name and the owner's code, then an explicit second
 * confirmation. Every shop, credential and remembered session on this computer is erased.
 */
function ResetPanel({ service, sessionId }: { readonly service: ShopService; readonly sessionId: string }): React.JSX.Element {
  const { t } = useText(), action = useAction(), workspace = useRead(() => service.getWorkspace(), [service]);
  const [name, setName] = useState(""), [secret, setSecret] = useState(""), [confirming, setConfirming] = useState(false);
  const shop = workspace.data?.shopName ?? "";
  const ready = shop !== "" && name.trim() === shop && secret !== "";
  return <div className="panel"><h2>{t("resetComputer")}</h2>
    <p className="notice error">{t("resetComputerWarning").replace("{shop}", shop)}</p><p className="hint">{t("resetComputerBackupFirst")}</p>
    <form onSubmit={event => { event.preventDefault(); if (ready) setConfirming(true); }}><fieldset disabled={action.busy}>
      <Field id="reset-name" label={t("resetTypeName").replace("{shop}", shop)} value={name} onChange={setName}/>
      <Field id="reset-secret" label={t("resetOwnerCode")} value={secret} onChange={setSecret} secret/>
    </fieldset>
    {!confirming ? <div className="actions"><button className="secondary" type="submit" disabled={!ready || action.busy}>{t("resetComputer")}</button></div>
      : <div className="actions"><button className="primary danger-action" type="button" disabled={action.busy}
          onClick={() => { void action.run(() => service.resetComputer({ sessionId, confirmedName: name.trim(), secret })).then(() => { setSecret(""); setConfirming(false); }); }}>{t("resetComputerConfirm")}</button>
        <button className="secondary" type="button" disabled={action.busy} onClick={() => setConfirming(false)}>{t("cancel")}</button></div>}
    </form><ErrorText message={action.error}/></div>;
}
