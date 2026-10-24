import type { Migration } from "./migrations.ts";
/**
 * Forward-only: the till limit a connected server last reported for this shop (ADR-039), beside its hosted service
 * status, so the till can say "your plan allows N tills" and explain a waiting till. `plan_tills` null means the server
 * has not said (or predates the plan endpoint); `plan_max_tills` null with a count means unlimited. Display only.
 */
export const TILL_PLAN_MIGRATION: Migration = {
  version: 33, name: "till plan of connected servers", statements: [
    `ALTER TABLE server_endpoints ADD COLUMN plan_max_tills INTEGER CHECK (plan_max_tills IS NULL OR plan_max_tills BETWEEN 1 AND 1000)`,
    `ALTER TABLE server_endpoints ADD COLUMN plan_tills INTEGER CHECK (plan_tills IS NULL OR plan_tills >= 0)`,
  ],
};
