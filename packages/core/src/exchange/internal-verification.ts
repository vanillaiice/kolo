import type { SignedJournalEvent } from "@kolo/contracts/events";
import type { OperationContext } from "../identity/types.ts";
import type { VerifiedEvent } from "./types.ts";

/** @internal Verification tokens bind exact signed content, issuing context and pinned key. */
export interface VerifiedMaterial { readonly context: OperationContext; readonly event: SignedJournalEvent; readonly key: string; readonly keyRevision: number; }
/** @internal Package-private capability registry; callers cannot manufacture verification. */
export const verifiedEvents = new WeakMap<VerifiedEvent, VerifiedMaterial>();
