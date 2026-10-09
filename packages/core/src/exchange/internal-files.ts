import type { SignedJournalBatch } from "@kolo/contracts/delivery";
import type { OperationContext } from "../identity/types.ts";
import type { BundlePreview } from "../application/file-exchange.ts";
/** @internal Authenticated content is inaccessible through copied public preview fields. */
export const bundlePreviews=new WeakMap<BundlePreview,{context:OperationContext;signed:SignedJournalBatch}>();
