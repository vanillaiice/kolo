import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { preferenceStorageOnDevice } from "../database/open-on-device.ts";

/**
 * Android system notifications for alerts (ADR-033): local only, nothing is pushed through a server. This is the only
 * module that imports expo-notifications. Alerts carry no business data beyond the localized text KOLO shows.
 */
const CHANNEL = "alerts";
let configured = false;

/** Shows banners while KOLO is open and creates the Android channel once. */
function configure(): void {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });
  if (Platform.OS === "android") void Notifications.setNotificationChannelAsync(CHANNEL, { name: "Alerts", importance: Notifications.AndroidImportance.DEFAULT }).catch(() => undefined);
}

/** Whether this phone raises system notifications; on unless switched off here. */
export function systemNotificationsEnabled(): boolean {
  try { return preferenceStorageOnDevice.read("systemNotifications") !== "off"; } catch { return true; }
}
/** Remembers the choice for this phone (a device preference, outside backups). */
export function setSystemNotificationsEnabled(value: boolean): void {
  try { preferenceStorageOnDevice.write("systemNotifications", value ? "on" : "off"); } catch { /* The switch applies for this session. */ }
}

/** Whether Android currently allows KOLO's notifications, asking once when it has not been decided (Android 13+). */
export async function notificationPermission(ask: boolean): Promise<"granted" | "denied" | "undetermined"> {
  configure();
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || !ask || !current.canAskAgain) return current.granted ? "granted" : current.canAskAgain ? "undetermined" : "denied";
  return (await Notifications.requestPermissionsAsync()).granted ? "granted" : "denied";
}

/** Raises one notification now; `key` replaces an earlier one about the same subject. Failures are ignored. */
export async function showNotification(key: string, title: string, body: string): Promise<void> {
  configure();
  await Notifications.scheduleNotificationAsync({ identifier: key, content: { title, body, data: { kolo: "alerts" } },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL } : null }).catch(() => undefined);
}

/** Calls `open` when the person taps one of KOLO's notifications; returns the unsubscribe. */
export function onNotificationOpened(open: () => void): () => void {
  configure();
  const subscription = Notifications.addNotificationResponseReceivedListener(response => {
    if (response.notification.request.content.data?.["kolo"] === "alerts") open();
  });
  return () => subscription.remove();
}
