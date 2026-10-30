import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, query, type Shop } from "../api.ts";
import { bytes, dateOnly, Failure, number, Pager, Pill, SortHeader, useLoad, useQuery, useShell, When } from "../lib.tsx";

const LIMIT = 50;

/** Every shop on the server, filtered, sorted and paged through the address bar. */
export function Shops(): ComponentChildren {
  const { t, language, hosted } = useShell();
  const [params, setParams] = useQuery();
  const [search, setSearch] = useState(params["search"] ?? "");
  // Typing updates the address after a short pause, so each keystroke is not a request.
  useEffect(() => { const timer = setTimeout(() => { if ((params["search"] ?? "") !== search.trim()) setParams({ search: search.trim(), offset: undefined }); }, 250); return () => clearTimeout(timer); }, [search]);
  const offset = Number(params["offset"] ?? 0) || 0, sort = params["sort"] ?? "lastSeen", dir = params["dir"] ?? "desc";
  const filters = { search: params["search"], status: params["status"], service: params["service"], sort: params["sort"], dir: params["dir"] };
  const address = query({ ...filters, offset, limit: LIMIT });
  const list = useLoad(() => api.shops(address), [address]);
  const onSort = (key: string, direction: string): void => setParams({ sort: key, dir: direction, offset: undefined });
  const data = list.data;
  return <section>
    <header class="page-head">
      <h1>{t("shops")}{data !== undefined && <span class="count">{number(language, data.total)}</span>}</h1>
      <a class="secondary button" href={`/admin/api/shops.csv${query(filters)}`} download>{t("export")}</a>
    </header>
    <div class="filters">
      <input class="search" type="search" placeholder={t("search")} aria-label={t("search")} value={search} onInput={event => setSearch(event.currentTarget.value)} />
      <select aria-label={t("status")} value={params["status"] ?? ""} onChange={event => setParams({ status: event.currentTarget.value, offset: undefined })}>
        <option value="">{t("allStatuses")}</option>{(["active", "suspended", "removed"] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}
      </select>
      {hosted && <select aria-label={t("subscription")} value={params["service"] ?? ""} onChange={event => setParams({ service: event.currentTarget.value, offset: undefined })}>
        <option value="">{t("allServices")}</option>{(["active", "grace", "inactive"] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}
      </select>}
    </div>
    <Failure code={list.error} retry={() => list.reload()} />
    {data === undefined ? <p class="muted">{t("loading")}</p> : data.shops.length === 0 ? <p class="empty">{t("noShops")}</p> : <>
      <div class="table-wrap"><table>
        <thead><tr>
          <SortHeader label={t("name")} sortKey="name" sort={sort} dir={dir} onSort={onSort} />
          <th>{t("status")}</th><th class="numeric">{t("devices")}</th>
          <SortHeader label={t("lastSeen")} sortKey="lastSeen" sort={sort} dir={dir} onSort={onSort} />
          {hosted && <SortHeader label={t("subscription")} sortKey="paidUntil" sort={sort} dir={dir} onSort={onSort} />}
          <SortHeader label={t("facts")} sortKey="facts" sort={sort} dir={dir} onSort={onSort} numeric />
          <SortHeader label={t("storage")} sortKey="bytes" sort={sort} dir={dir} onSort={onSort} numeric />
          <SortHeader label={t("enrolledOn")} sortKey="enrolled" sort={sort} dir={dir} onSort={onSort} />
        </tr></thead>
        <tbody>{data.shops.map((shop: Shop) => <tr key={shop.shopId}>
          <td><a class="row-link" href={`/admin/shops/${shop.shopId}`}>{shop.name}</a><small class="id-line"><code>{shop.shopId}</code></small></td>
          <td><Pill tone={shop.status}>{t(shop.status)}</Pill></td>
          <td class="numeric">{tills(t, shop)}</td>
          <td><When value={shop.lastSeenAt} /></td>
          {hosted && <td><Pill tone={`service-${shop.service}`}>{t(shop.service)}</Pill><small>{shop.paidUntil === null ? t("notPaid") : dateOnly(language, shop.paidUntil)}</small></td>}
          <td class="numeric">{number(language, shop.facts)}</td><td class="numeric">{bytes(shop.bytes)}</td>
          <td>{dateOnly(language, shop.enrolledAt)}</td>
        </tr>)}</tbody>
      </table></div>
      <Pager offset={offset} limit={LIMIT} shown={data.shops.length} total={data.total} onOffset={value => setParams({ offset: value === 0 ? undefined : value })} />
    </>}
  </section>;
}

/** Tills holding a place, against the limit, with any waiting: "2 / 3, 1 waiting". */
export function tills(t: (key: string) => string, shop: Shop): string {
  return `${shop.devices}${shop.maxTills === null ? "" : ` / ${shop.maxTills}`}${shop.heldTills > 0 ? `, ${shop.heldTills} ${t("waiting")}` : ""}`;
}
