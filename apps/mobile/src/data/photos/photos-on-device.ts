import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import { PHOTO_LIMITS, PhotoError } from "@kolo/core/data/products/photos";

/** The thumbnail side the desktop produces; the core accepts up to 512 px. */
export const THUMBNAIL_SIDE = 320;
/** WebP quality steps tried until the encoded file fits the 64 KiB photo limit. */
const QUALITIES = [0.8, 0.6, 0.45, 0.3] as const;

function remove(uri: string | undefined): void {
  if (uri === undefined) return;
  try { const file = new File(uri); if (file.exists) file.delete(); } catch { /* A cache file the system already removed. */ }
}

/**
 * Picks an image from the camera or gallery and turns it into a product thumbnail: Android's square
 * crop, then native decode with orientation applied, centre crop, resize to 320 px and WebP
 * re-encoding (which drops metadata). Only the final file, checked against the 64 KiB limit before
 * it is read, enters JavaScript. Returns undefined when the user cancels. Temporary files are removed.
 */
export async function pickProductPhoto(source: "camera" | "library"): Promise<Uint8Array | undefined> {
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new PhotoError("invalid_photo");
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1, exif: false, base64: false };
  const picked = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (picked.canceled) return undefined;
  const asset = picked.assets[0];
  if (asset === undefined) return undefined;
  const outputs: string[] = [];
  try {
    const context = ImageManipulator.manipulate(asset.uri);
    const side = Math.min(asset.width, asset.height);
    if (side > 0 && asset.width !== asset.height) context.crop({ originX: Math.floor((asset.width - side) / 2), originY: Math.floor((asset.height - side) / 2), width: side, height: side });
    context.resize({ width: Math.min(THUMBNAIL_SIDE, side > 0 ? side : THUMBNAIL_SIDE), height: Math.min(THUMBNAIL_SIDE, side > 0 ? side : THUMBNAIL_SIDE) });
    const image = await context.renderAsync();
    for (const compress of QUALITIES) {
      const saved = await image.saveAsync({ format: SaveFormat.WEBP, compress, base64: false });
      outputs.push(saved.uri);
      const file = new File(saved.uri);
      if (saved.width > PHOTO_LIMITS.maxSide || saved.height > PHOTO_LIMITS.maxSide) throw new PhotoError("invalid_photo");
      if (file.size > 0 && file.size <= PHOTO_LIMITS.maxBytes) return file.bytesSync();
    }
    throw new PhotoError("invalid_photo");
  } finally {
    for (const uri of outputs) remove(uri);
    if (asset.uri.startsWith("file://") && asset.uri.includes("/cache/")) remove(asset.uri);
  }
}
