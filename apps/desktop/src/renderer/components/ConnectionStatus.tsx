import { useEffect, useState } from "react";
import type { ShopService } from "../../shared/service.ts";
import { connectedServer } from "../connection.ts";
import { call, useText } from "./ui.tsx";

/** How often the footer re-reads sync state, since automatic passes do not change shop data when nothing is new. */
const REFRESH_MS = 30_000;

/**
 * "Connected to <server>" while the till syncs with a server, and nothing otherwise: working offline is the normal
 * state and needs no label. A failed read keeps the last known state rather than flickering.
 */
export function ConnectionStatus({ service, sessionId, revision }: { readonly service: ShopService; readonly sessionId: string; readonly revision: number }): React.JSX.Element | null {
  const { t } = useText(), [host, setHost] = useState<string>();
  useEffect(() => {
    let disposed = false;
    const read = (): void => { void call(() => service.serverState({ sessionId })).then(result => { if (!disposed && result.ok) setHost(connectedServer(result.value.servers)); }); };
    read(); const timer = setInterval(read, REFRESH_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [service, sessionId, revision]);
  return host === undefined ? null : <div className="sidebar-footer" role="status"><span className="status-dot"/>{t("connectedTo").replace("{server}", host)}</div>;
}
