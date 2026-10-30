import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { api, type Issued, type Method, type ShopDetail } from "../api.ts";
import { bytes, CopyButton, DAY, dateOnly, dateTime, Failure, LimitInput, money, number, OneTime, Pill, useAction, useLoad, useShell, When } from "../lib.tsx";
import { AuditDetail } from "./audit.tsx";

/** One shop: identity, tills, limit, subscription, history and the operator's actions on it. */
export function ShopPage({ id }: { id: string }): ComponentChildren {
  const { t, language, canChange } = useShell();
  const shop = useLoad(() => api.shop(id), [id]);
  const data: ShopDetail | undefined = shop.data;
  return <section>
    <a class="back" href="/admin/shops">← {t("back")}</a>
    <Failure code={shop.error} retry={() => shop.reload()} />
    {data === undefined ? (shop.error === undefined && <p class="muted">{t("loading")}</p>) : <>
      <header class="page-head">
        <h1>{data.name} <Pill tone={data.status}>{t(data.status)}</Pill></h1>
      </header>
      <dl class="facts">
        <dt>ID</dt><dd><code>{data.shopId}</code> <CopyButton value={data.shopId} /></dd>
        <dt>{t("owner")}</dt><dd><code>{data.ownerId}</code></dd>
        <dt>{t("enrolled")}</dt><dd>{dateTime(language, data.enrolledAt)}</dd>
        <dt>{t("viaCode")}</dt><dd>{data.connectionCode ?? "—"}</dd>
        <dt>{t("keyEpoch")}</dt><dd>{data.keyEpoch ?? "—"}</dd>
        <dt>{t("conflicts")}</dt><dd>{data.conflicts > 0 ? <Pill tone="warning">{number(language, data.conflicts)}</Pill> : 0}</dd>
        <dt>{t("facts")}</dt><dd>{number(language, data.facts)} ({bytes(data.bytes)})</dd>
        {data.removeAfter !== null && <><dt>{t("removeAfter")}</dt><dd>{dateTime(language, data.removeAfter)}</dd></>}
      </dl>

      <h2>{t("devices")}</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>{t("device")}</th><th>{t("platform")}</th><th>{t("status")}</th><th>{t("lastSeen")}</th><th class="numeric">{t("backlog")}</th></tr></thead>
        <tbody>{data.deviceList.map(device => {
          const stale = device.active && (device.lastSeenAt === null || Date.now() - new Date(device.lastSeenAt).getTime() > 14 * DAY);
          return <tr key={device.deviceId}>
            <td>{device.label}{device.authority && <span class="tag">{t("authority")}</span>}<small><code>{device.deviceId}</code></small></td>
            <td>{device.platform}</td>
            <td>{device.held ? <Pill tone="warning">{t("heldTill")}</Pill> : <Pill tone={device.active ? "active" : "removed"}>{t(device.active ? "trusted" : "revoked")}</Pill>}</td>
            <td><When value={device.lastSeenAt} />{stale && <small class="warn-text">{t("staleTill")}</small>}</td>
            <td class="numeric">{number(language, device.backlog)}</td>
          </tr>;
        })}</tbody>
      </table></div>

      <TillLimit key={String(data.maxTills)} shop={data} onSaved={() => shop.reload()} />
      {data.edition === "hosted" && <Subscription shop={data} onPaid={() => shop.reload()} />}

      <h2>{t("activity")}</h2>
      {data.activity.length === 0 ? <p class="empty">{t("noActivity")}</p> : <ol class="timeline">{data.activity.map(entry => <li key={entry.id}>
        <time dateTime={entry.at}>{dateTime(language, entry.at)}</time>
        <span><code>{entry.action}</code> {t("by")} {entry.username}</span>
        {entry.detail !== null && <AuditDetail detail={entry.detail} />}
      </li>)}</ol>}

      {canChange && data.status === "active" && <Recovery shopId={data.shopId} />}
      {canChange && <Actions shop={data} onChanged={() => shop.reload()} />}
    </>}
  </section>;
}

/** Suspend, resume, restore and (after typing the name and a step-up) remove. */
function Actions({ shop, onChanged }: { shop: ShopDetail; onChanged: () => void }): ComponentChildren {
  const { t, notify } = useShell();
  const action = useAction(), [confirm, setConfirm] = useState("");
  const act = (name: "suspend" | "resume" | "remove" | "restore", done: string): void => action.run(() => api.shopAction(shop.shopId, name), () => { setConfirm(""); notify(t(done)); onChanged(); });
  return <section class="actions-panel" aria-label={t("action")}>
    {action.error !== undefined && <p role="alert" class="notice error">{t(action.error)}</p>}
    {shop.status === "active" && <div><button type="button" class="secondary" disabled={action.busy} onClick={() => act("suspend", "suspended_done")}>{t("suspend")}</button><p class="hint">{t("suspendHelp")}</p></div>}
    {shop.status === "suspended" && <div><button type="button" class="primary" disabled={action.busy} onClick={() => act("resume", "resumed_done")}>{t("resume")}</button></div>}
    {shop.status === "removed" && <div><button type="button" class="primary" disabled={action.busy} onClick={() => act("restore", "restored_done")}>{t("restore")}</button></div>}
    {shop.status !== "removed" && <form class="danger-zone" onSubmit={event => { event.preventDefault(); if (confirm.trim() === shop.name) act("remove", "removed_done"); }}>
      <h2>{t("remove")}</h2><p class="hint">{t("removeHelp")}</p>
      <label class="field">{t("confirmName")}<input value={confirm} onInput={event => setConfirm(event.currentTarget.value)} autoComplete="off" /></label>
      <button class="danger" type="submit" disabled={action.busy || confirm.trim() !== shop.name}>{t("remove")}</button>
    </form>}
  </section>;
}

/** An owner-recovery code for this shop, shown once with its QR code (ADR-036); it needs a step-up. */
function Recovery({ shopId }: { shopId: string }): ComponentChildren {
  const { t, language } = useShell();
  const action = useAction(), [issued, setIssued] = useState<Issued>();
  return <section class="panel">
    {issued !== undefined ? <OneTime title={t("recoveryTitle")} help={`${t("issuedHelp")} ${dateTime(language, issued.expiresAt)}.`} qr={issued.qr} value={issued.code} filename="kolo-recovery-code.svg" onDone={() => setIssued(undefined)} /> : <>
      <h2>{t("recoveryTitle")}</h2><p class="hint">{t("recoveryHelp")}</p>
      <button type="button" class="secondary" disabled={action.busy} onClick={() => action.run(() => api.issueRecovery(shopId), setIssued)}>{t(action.busy ? "issuing" : "issueRecovery")}</button>
    </>}
    {action.error !== undefined && <p role="alert" class="notice error">{t(action.error)}</p>}
  </section>;
}

/** A random UUID; `crypto.randomUUID` needs a secure context, which a dashboard reached over plain HTTP on a LAN is not. */
function newRequest(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Paid-until, grace, payment history and (for admins) the payment form; one request ID per form fill (ADR-045). */
function Subscription({ shop, onPaid }: { shop: ShopDetail; onPaid: () => void }): ComponentChildren {
  const { t, language, canChange, notify } = useShell();
  const [months, setMonths] = useState(1), [amount, setAmount] = useState(""), [method, setMethod] = useState<Method>("mtn_momo"), [reference, setReference] = useState("");
  const [requestId, setRequestId] = useState(newRequest);
  const action = useAction();
  const pay = (event: Event): void => {
    event.preventDefault();
    const trimmed = reference.trim();
    action.run(() => api.pay(shop.shopId, { months, amountMinor: Number(amount), method, requestId, ...(trimmed === "" ? {} : { reference: trimmed }) }), result => {
      setAmount(""); setReference(""); setRequestId(newRequest());
      notify(result.duplicate ? t("paymentDuplicate") : `${t("paymentRecorded")} ${dateOnly(language, result.paidUntilAfter)}.`); onPaid();
    });
  };
  const methods: Method[] = ["mtn_momo", "orange_money", "cash", "bank", "card", "other"];
  return <section>
    <h2>{t("subscription")} <Pill tone={`service-${shop.service}`}>{t(shop.service)}</Pill></h2>
    <dl class="facts"><dt>{t("paidUntil")}</dt><dd>{shop.paidUntil === null ? t("notPaid") : dateTime(language, shop.paidUntil)}</dd>
      {shop.graceUntil !== null && <><dt>{t("graceUntil")}</dt><dd>{dateTime(language, shop.graceUntil)}</dd></>}</dl>
    {canChange && <form class="panel" onSubmit={pay}>
      <h3>{t("recordPayment")}</h3><p class="hint">{t("recordPaymentHelp")}</p>
      <div class="row">
        <label class="field">{t("months")}<select value={months} onChange={event => setMonths(Number(event.currentTarget.value))}>{[1, 2, 3, 6, 12].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label class="field">{t("amount")}<input inputMode="numeric" value={amount} onInput={event => setAmount(event.currentTarget.value.replace(/\D/g, ""))} required maxLength={12} /></label>
        <label class="field">{t("method")}<select value={method} onChange={event => setMethod(event.currentTarget.value as Method)}>{methods.map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        <label class="field grow">{t("reference")}<input value={reference} onInput={event => setReference(event.currentTarget.value)} maxLength={120} /></label>
        <button class="primary" type="submit" disabled={action.busy || amount === ""}>{t(action.busy ? "recording" : "recordPayment")}</button>
      </div>
      {action.error !== undefined && <p role="alert" class="notice error">{t(action.error)}</p>}
    </form>}
    <h3>{t("payments")}</h3>
    {shop.payments.length === 0 ? <p class="empty">{t("noPayments")}</p> : <div class="table-wrap"><table>
      <thead><tr><th>{t("when")}</th><th class="numeric">{t("months")}</th><th class="numeric">{t("amount")}</th><th>{t("method")}</th><th>{t("paidUntil")}</th><th>{t("who")}</th></tr></thead>
      <tbody>{shop.payments.map(payment => <tr key={payment.paymentId}>
        <td>{dateTime(language, payment.recordedAt)}</td><td class="numeric">{payment.months}{payment.days > 0 ? ` + ${payment.days} ${t("daysShort")}` : ""}</td>
        <td class="numeric">{money(language, payment.amountMinor)}</td><td>{t(payment.method)}{payment.reference !== null && <small>{payment.reference}</small>}</td>
        <td>{dateOnly(language, payment.paidUntilAfter)}</td><td>{payment.recordedBy}<small>{t(payment.source === "code" ? "viaCodeSource" : payment.source)}</small></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

/** The shop's till limit and use; admins change it from the value they saw, so a parallel edit is not overwritten (ADR-039, ADR-045). */
function TillLimit({ shop, onSaved }: { shop: ShopDetail; onSaved: () => void }): ComponentChildren {
  const { t, canChange, notify } = useShell();
  const [limit, setLimit] = useState(shop.maxTills === null ? "" : String(shop.maxTills)), [unlimited, setUnlimited] = useState(shop.maxTills === null);
  const action = useAction();
  const value = unlimited ? null : Number(limit), ready = unlimited || Number.isInteger(value) && value! >= 1;
  const save = (event: Event): void => {
    event.preventDefault(); if (!ready) { action.setError("tillLimitChoose"); return; }
    action.run(() => api.setTillLimit(shop.shopId, value, shop.maxTills), result => { notify(`${t("limitSaved")}${result.released > 0 ? ` ${result.released} ${t("released")}` : ""}`); onSaved(); });
  };
  // A refusal because someone else changed it reloads the shop, so the form shows what is there now.
  const stale = action.error === "stale";
  return <section>
    <h2>{t("tillLimit")}</h2>
    <p>{shop.maxTills === null ? `${shop.devices} (${t("unlimitedTills").toLowerCase()})` : `${shop.devices} ${t("tillsOf")} ${shop.maxTills}`}{shop.heldTills > 0 ? `, ${shop.heldTills} ${t("waiting")}` : ""}</p>
    {canChange && <form class="panel" onSubmit={save}>
      <LimitInput limit={limit} unlimited={unlimited} onLimit={setLimit} onUnlimited={setUnlimited} idPrefix="shop" />
      <button class="secondary" type="submit" disabled={action.busy || !ready}>{t(action.busy ? "saving" : "saveLimit")}</button>
      {action.error !== undefined && <p role="alert" class="notice error">{t(action.error)} {stale && <button type="button" class="link" onClick={() => { action.setError(undefined); onSaved(); }}>{t("refresh")}</button>}</p>}
    </form>}
  </section>;
}
