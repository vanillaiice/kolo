import type { Migration } from "./migrations.ts";
/**
 * Shop-defined roles: a named copy of a built-in staff role with its own permissions, set through signed
 * `CUSTOM_ROLE_SET` facts. A deleted role stays as a tombstone so a late fact cannot bring it back and a member who
 * still holds it keeps the same access. A membership's `custom_role_id` points at the role it holds; its `role`
 * column is then that role's base, so every check of the built-in role keeps working. Business data, so snapshots
 * carry it.
 */
export const CUSTOM_ROLES_MIGRATION:Migration={version:32,name:"custom roles",statements:[
  `CREATE TABLE custom_roles (
     business_id TEXT NOT NULL,
     id          TEXT NOT NULL CHECK (length(id) = 36),
     name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
     base_role   TEXT NOT NULL CHECK (base_role IN ('MANAGER','CASHIER','INVENTORY','ACCOUNTANT')),
     permissions TEXT NOT NULL CHECK (json_valid(permissions) AND json_type(permissions) = 'array'),
     deleted     INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
     revision    INTEGER NOT NULL CHECK (revision > 0),
     PRIMARY KEY (business_id, id),
     FOREIGN KEY (business_id) REFERENCES businesses (id)
   ) STRICT`,
  `ALTER TABLE local_memberships ADD COLUMN custom_role_id TEXT CHECK (custom_role_id IS NULL OR length(custom_role_id) = 36)`,
]};
