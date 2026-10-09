import { useEffect, useRef, useState } from "react";
import { LEGAL_EFFECTIVE_DATE, OPEN_SOURCE, legalDocument, type LegalKind } from "../legal.ts";
import { useText } from "./ui.tsx";
import interLicense from "@fontsource-variable/inter/LICENSE?raw";
import koloLicense from "../../../LICENSE?raw";

const kinds: readonly LegalKind[] = ["terms", "privacy", "licenses"];

/** Modal reader for the terms, privacy notice and open-source notices; Escape or Close dismisses it. */
export function LegalDialog({ initial, onClose }: { readonly initial: LegalKind; readonly onClose: () => void }): React.JSX.Element {
  const { t, language } = useText(), dialog = useRef<HTMLDialogElement>(null), [kind, setKind] = useState(initial);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const document = legalDocument(kind, language);
  return <dialog ref={dialog} className="legal-dialog" aria-labelledby="legal-title" onCancel={onClose}>
    <div className="legal-header"><div><p className="legal-credit">kolo · hblabs</p><h2 id="legal-title">{document.title}</h2>
      {kind !== "licenses" && <p className="hint">{t("legalEffective")} {new Date(`${LEGAL_EFFECTIVE_DATE}T12:00:00Z`).toLocaleDateString(language === "fr" ? "fr-FR" : "en-GB", { dateStyle: "long" })}</p>}</div>
      <button className="secondary" autoFocus onClick={onClose}>{t("close")}</button></div>
    <div className="tabs" role="group" aria-label={t("legal")}>{kinds.map(item =>
      <button key={item} type="button" className={kind === item ? "selected" : ""} aria-pressed={kind === item} onClick={() => setKind(item)}>{t(`legal.${item}`)}</button>)}</div>
    <div className="legal-body" tabIndex={0} aria-label={document.title}>
      {document.sections.map(section => <section key={section.heading}><h3>{section.heading}</h3>{section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</section>)}
      {kind === "licenses" && <table><thead><tr><th>{t("component")}</th><th>{t("license")}</th></tr></thead>
        <tbody>{OPEN_SOURCE.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.license}</td></tr>)}</tbody></table>}
      {kind === "licenses" && <details className="license-text"><summary>KOLO — GNU General Public License v3.0</summary><pre>{koloLicense}</pre></details>}
      {kind === "licenses" && <details className="license-text"><summary>Inter — SIL Open Font License 1.1</summary><pre>{interLicense}</pre></details>}
    </div>
  </dialog>;
}

/** Inline links that open a legal document. */
export function LegalLinks({ onOpen }: { readonly onOpen: (kind: LegalKind) => void }): React.JSX.Element {
  const { t } = useText();
  return <span className="legal-links">{kinds.map(item => <button key={item} type="button" className="link-button" onClick={() => onOpen(item)}>{t(`legal.${item}`)}</button>)}</span>;
}
