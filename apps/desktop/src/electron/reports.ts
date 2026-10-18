import { analyticsView, reportView, REPORT_KINDS } from "@kolo/core/application/report-views";
import { auditTrail, AUDIT_GROUPS, type AuditGroup, type AuditPage } from "@kolo/core/application/audit";
import { WorkspaceError } from "@kolo/core/identity/types";
import type { AnalyticsBucket, AnalyticsResult, ReportKind, ReportResult } from "../shared/service.js";
import { object, optional, text, uuid, whole } from "./validation.ts";
import type { Host } from "./host.ts";

const buckets: readonly AnalyticsBucket[] = ["hour", "day", "week", "month"];
function instant(value: unknown): string {
  const raw = text(value, 32, false);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new WorkspaceError("invalid_input");
  return new Date(raw).toISOString();
}

/** One report under its core permission; the period is at most about ten years and must not be empty. */
export function report(host: Host, input: unknown): ReportResult {
  const data = object(input, ["sessionId", "kind", "from", "until"]), context = host.actor(data);
  if (!REPORT_KINDS.includes(data["kind"] as ReportKind)) throw new WorkspaceError("invalid_input");
  return reportView(context, data["kind"] as ReportKind, instant(data["from"]), instant(data["until"]));
}

/**
 * Light analytics for one period under reports.sales, with profit and customer sections only for
 * actors holding reports.financial and reports.customers. Figures come from core
 * `application/report-views`, shared with the mobile client.
 */
export function analytics(host: Host, input: unknown): AnalyticsResult {
  const data = object(input, ["sessionId", "from", "until", "offsetMinutes", "bucket"]), context = host.actor(data);
  const offset = data["offsetMinutes"];
  if (typeof offset !== "number") throw new WorkspaceError("invalid_input");
  const bucket = optional(data["bucket"], value => { if (!buckets.includes(value as AnalyticsBucket)) throw new WorkspaceError("invalid_input"); return value as AnalyticsBucket; });
  return analyticsView(context, { from: instant(data["from"]), until: instant(data["until"]), offsetMinutes: offset, bucket });
}

/** One page of the operation journal under audit.view; summaries come from core `application/audit`, shared with mobile. */
export function journal(host: Host, input: unknown): AuditPage {
  const data = object(input, ["sessionId", "from", "until", "actorId", "deviceId", "group", "subjectId", "after", "limit"]), context = host.actor(data);
  const group = optional(data["group"], value => { if (!AUDIT_GROUPS.includes(value as AuditGroup)) throw new WorkspaceError("invalid_input"); return value as AuditGroup; });
  const after = optional(data["after"], value => { const cursor = object(value, ["name", "id"]); return { name: instant(cursor["name"]), id: uuid(cursor["id"]) }; });
  const limit = optional(data["limit"], value => { const result = whole(value, 1); if (result > 200) throw new WorkspaceError("invalid_input"); return result; });
  return auditTrail(context, { from: optional(data["from"], instant), until: optional(data["until"], instant), actorId: optional(data["actorId"], uuid),
    deviceId: optional(data["deviceId"], uuid), group, subjectId: optional(data["subjectId"], uuid), after, limit });
}
