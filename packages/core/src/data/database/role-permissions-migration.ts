import type { Migration } from "./migrations.ts";
/**
 * The shop's role matrix (ADR-037): each staff role's permissions as the owner set them through signed
 * `ROLE_PERMISSIONS_SET` facts. No row, or a NULL list, means the role's built-in defaults, so existing shops keep
 * exactly the access they had. Business data, so snapshots carry it.
 */
export const ROLE_PERMISSIONS_MIGRATION:Migration={version:31,name:"shop role permissions",statements:[
  `CREATE TABLE role_permissions (
     business_id TEXT NOT NULL,
     role        TEXT NOT NULL CHECK (role IN ('MANAGER','CASHIER','INVENTORY','ACCOUNTANT')),
     permissions TEXT CHECK (permissions IS NULL OR (json_valid(permissions) AND json_type(permissions) = 'array')),
     revision    INTEGER NOT NULL CHECK (revision > 0),
     PRIMARY KEY (business_id, role),
     FOREIGN KEY (business_id) REFERENCES businesses (id)
   ) STRICT`,
]};
