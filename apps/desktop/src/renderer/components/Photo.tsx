import { useEffect, useRef, useState } from "react";
import type { ProductView, ShopService } from "../../shared/service.ts";
import { ErrorText, useAction, useText } from "./ui.tsx";

/** Side of the stored square thumbnail; the host accepts up to 512 px and 64 KiB. */
const SIDE = 320, MAX_BYTES = 64 * 1024;
/** Photos are immutable by digest, so one fetched data URL serves every screen until the app closes. */
const cache = new Map<string, string>();
const CACHE_LIMIT = 500;

/**
 * Turns a picked image into a stored thumbnail: EXIF orientation applied, centre-cropped square,
 * re-encoded as WebP (which also drops camera metadata such as location), stepping quality down
 * until it fits. Returns undefined for anything the browser cannot decode.
 */
async function thumbnail(file: File): Promise<Uint8Array | undefined> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { return undefined; }
  try {
    const side = Math.min(bitmap.width, bitmap.height), canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIDE;
    const context = canvas.getContext("2d");
    if (context === null || side < 1) return undefined;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIDE, SIDE);
    for (const quality of [0.82, 0.7, 0.55, 0.4]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", quality));
      if (blob !== null && blob.type === "image/webp" && blob.size <= MAX_BYTES) return new Uint8Array(await blob.arrayBuffer());
    }
    return undefined;
  } finally { bitmap.close(); }
}

/** The product's photo as a data URL, fetched once per digest; undefined while loading or when it has none. */
export function usePhoto(service: ShopService, sessionId: string, product: Pick<ProductView, "id" | "photo">): string | undefined {
  const digest = product.photo, [url, setUrl] = useState(() => digest === undefined ? undefined : cache.get(digest));
  useEffect(() => {
    if (digest === undefined) { setUrl(undefined); return; }
    const known = cache.get(digest);
    if (known !== undefined) { setUrl(known); return; }
    let live = true;
    void service.productPhoto({ sessionId, productId: product.id }).then(result => {
      if (!live || !result.ok || result.value === null) return;
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      cache.set(result.value.digest, result.value.dataUrl); setUrl(result.value.dataUrl);
    }, () => undefined);
    return () => { live = false; };
  }, [service, sessionId, product.id, digest]);
  return url;
}

/** A product's photo, or its initial when it has none (or this computer never received it). */
export function ProductThumb({ service, sessionId, product, className = "product-initial" }: { service: ShopService; sessionId: string; product: ProductView; className?: string }): React.JSX.Element {
  const url = usePhoto(service, sessionId, product);
  return url === undefined
    ? <span className={className} aria-hidden="true">{product.name.slice(0, 1).toLocaleUpperCase()}</span>
    : <img className={`${className} has-photo`} src={url} alt="" draggable={false}/>;
}

/** Add, replace or remove a product's photo under products.edit. */
export function PhotoEditor({ service, sessionId, product, onSaved }: { service: ShopService; sessionId: string; product: ProductView; onSaved: (value: ProductView) => void }): React.JSX.Element {
  const { t } = useText(), action = useAction(), input = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const pick = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setWorking(true);
    try {
      const bytes = await thumbnail(file);
      if (bytes === undefined) { action.setError({ code: "invalid_photo" }); return; }
      const saved = await action.run(() => service.setProductPhoto({ sessionId, productId: product.id, bytes }));
      if (saved !== undefined) onSaved(saved);
    } finally { setWorking(false); if (input.current !== null) input.current.value = ""; }
  };
  const busy = working || action.busy;
  return <div className="photo-editor">
    <ProductThumb service={service} sessionId={sessionId} product={product} className="photo-preview"/>
    <div className="photo-actions">
      <input ref={input} id={`photo-${product.id}`} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { void pick(event.target.files?.[0]); }}/>
      <button type="button" className="secondary" disabled={busy} onClick={() => input.current?.click()}>{busy ? t("processingPhoto") : t(product.photo === undefined ? "addPhoto" : "changePhoto")}</button>
      {product.photo !== undefined && <button type="button" className="text-button" disabled={busy} onClick={() => { void action.run(() => service.removeProductPhoto({ sessionId, productId: product.id })).then(value => { if (value !== undefined) onSaved(value); }); }}>{t("removePhoto")}</button>}
      <p className="hint">{t("photoHelp")}</p>
      <ErrorText message={action.error}/>
    </div>
  </div>;
}
