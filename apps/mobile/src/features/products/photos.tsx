import { useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { photoUsage, productPhoto, productPhotoDigest, removeProductPhoto, setProductPhoto } from "@kolo/core/application/photos";
import { transferCryptoOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { pickProductPhoto } from "../../data/photos/photos-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { useDraft, usePermissions, useRevision, useSession } from "../../app/session.tsx";
import { useAction } from "../../components/command.tsx";
import { radius, spacing, useTheme } from "../../components/theme.ts";
import { Button, Confirm, Section, useStyles } from "../../components/ui.tsx";

/** Most decoded thumbnails kept per session; least recently used ones are dropped. */
const CACHE_ENTRIES = 80;
/** Session-bound, digest-keyed thumbnail cache; discarded with the session on lock or replacement. */
class PhotoCache {
  private readonly entries = new Map<string, string>();
  get(digest: string): string | undefined {
    const value = this.entries.get(digest);
    if (value !== undefined) { this.entries.delete(digest); this.entries.set(digest, value); }
    return value;
  }
  set(digest: string, uri: string): void {
    this.entries.set(digest, uri);
    while (this.entries.size > CACHE_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }
}
function usePhotoCache(): PhotoCache { return useDraft("photo-cache", () => new PhotoCache())[0]; }

/** A product's local photo for a visible row, or its initial when this device holds none. */
export function Thumbnail({ productId, name, size = 40, digest }: { readonly productId: string; readonly name: string; readonly size?: number; readonly digest?: string | null }): React.JSX.Element {
  const { colors } = useTheme(), { context } = useSession(), cache = usePhotoCache(), revision = useRevision(["products"]);
  const uri = useMemo(() => {
    try {
      const key = digest === undefined ? productPhotoDigest(context, productId) : digest ?? undefined;
      if (key === undefined) return undefined;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const photo = productPhoto(context, productId);
      if (photo === undefined) return undefined;
      const value = `data:${photo.mediaType};base64,${transferCryptoOnDevice.encodeBase64(photo.bytes)}`;
      cache.set(photo.digest, value);
      return value;
    } catch { return undefined; }
  }, [context, productId, digest, cache, revision]);
  if (uri !== undefined) return <Image source={{ uri }} accessibilityIgnoresInvertColors style={{ width: size, height: size, borderRadius: radius.control, backgroundColor: colors.surfaceSoft }} />;
  return <View importantForAccessibility="no" style={{ width: size, height: size, borderRadius: radius.control, backgroundColor: colors.yellowSoft, alignItems: "center", justifyContent: "center" }}>
    <Text style={{ color: colors.yellowInk, fontWeight: "700", fontSize: size * 0.42 }}>{name.trim().charAt(0).toUpperCase() || "?"}</Text></View>;
}

/** Add, replace or remove a product photo; cancelling or a failure keeps the previous photo. */
export function PhotoSection({ productId, name }: { readonly productId: string; readonly name: string }): React.JSX.Element {
  const { t } = useText(), s = useStyles(), session = useSession(), { context } = session, permissions = usePermissions(), action = useAction();
  const revision = useRevision(["products"]), [confirming, setConfirming] = useState(false);
  let digest: string | undefined;
  try { digest = productPhotoDigest(context, productId); } catch { digest = undefined; }
  const choose = (source: "camera" | "library"): void => { void action.runAsync(async () => {
    const generation = session.generation;
    const bytes = await session.systemUi(() => pickProductPhoto(source));
    if (bytes === undefined || !session.isCurrent(generation)) return false;
    await setProductPhoto(context, { productId, bytes }, transferCryptoOnDevice);
    return true;
  }, saved => { if (saved) action.show({ tone: "success", key: "photoSaved" }); }); };
  void revision;
  return <Section title={t("photo")}>
    <View style={[s.row, { gap: spacing.lg }]}><Thumbnail productId={productId} name={name} size={96} digest={digest ?? null} />
      <Text style={[s.muted, { flex: 1 }]}>{digest === undefined ? t("noPhoto") : t("photoLocalHelp")}</Text></View>
    {permissions.includes("products.edit") && <>
      <Button label={digest === undefined ? t("takePhoto") : t("replaceWithCamera")} variant="secondary" busy={action.busy} onPress={() => choose("camera")} />
      <Button label={digest === undefined ? t("choosePhoto") : t("replaceFromGallery")} variant="secondary" busy={action.busy} onPress={() => choose("library")} />
      {digest !== undefined && <Button label={t("removePhoto")} variant="danger" disabled={action.busy} onPress={() => setConfirming(true)} />}
    </>}
    {action.notice}
    <Confirm visible={confirming} destructive title={t("removePhoto")} text={t("removePhotoText", { name })} confirmLabel={t("removePhoto")} onCancel={() => setConfirming(false)}
      onConfirm={() => { setConfirming(false); action.run(() => removeProductPhoto(context, productId), undefined, "photoRemoved"); }} />
  </Section>;
}

/** Photo storage used by this shop on this phone against the standard 16 MiB limit. */
export function PhotoUsage(): React.JSX.Element | null {
  const { t, language } = useText(), s = useStyles(), { context } = useSession(), revision = useRevision(["products"]);
  const usage = useMemo(() => { try { return photoUsage(context); } catch { return undefined; } }, [context, revision]);
  if (usage === undefined) return null;
  const size = (bytes: number): string => { const megabyte = bytes >= 1024 * 1024, value = bytes / (megabyte ? 1024 * 1024 : 1024);
    return `${new Intl.NumberFormat(language === "fr" ? "fr-FR" : "en-GB", { maximumFractionDigits: 1 }).format(value)} ${language === "fr" ? megabyte ? "Mo" : "ko" : megabyte ? "MB" : "KB"}`; };
  return <Text style={s.body}>{t("photoUsage", { count: usage.photos, used: size(usage.bytes), limit: size(usage.limitBytes) })}</Text>;
}
