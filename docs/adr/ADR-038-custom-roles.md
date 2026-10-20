# ADR-038: Shop-defined roles

**Status:** Accepted, 2026-10-20.

## Context

ADR-037 let the owner edit the four built-in staff roles and left shop-defined roles out of scope. The owner then
asked for their own roles (for example "Night cashier" next to "Cashier"), so two kinds of cashier no longer need the
same exceptions repeated on every member. They chose a role that starts as a named copy of a built-in role, and that
a role can be deleted only once nobody holds it.

## Decision

- **Shape.** A custom role has an ID, a name (1–60 characters, unique in the shop ignoring case among live roles), a
  base role (`MANAGER`, `CASHIER`, `INVENTORY` or `ACCOUNTANT`, fixed for the role's life) and its own permission
  set. It starts with the shop's current permissions for the base role; later edits to the base role do not reach it.
  Stored in `custom_roles` (SQLite migration 32).
- **Membership.** `local_memberships.custom_role_id` names the custom role a member holds. Their `role` (and
  `users.role`) is then the custom role's base, so every check of the built-in role, `OWNER` checks included, is
  unchanged. Effective permissions = custom role set (or the role matrix when none) + member grants − revocations,
  re-read on every command. A custom role this till does not know, or a corrupt one, fails closed for its holders.
- **Deletion.** The owner can delete a role only when no member, active or suspended, holds it (`role_in_use`). The
  row stays as a tombstone so a late fact cannot revive it. If another till moved a member onto it concurrently, that
  member keeps the deleted role's last permissions; screens mark it deleted and it can no longer be assigned.
- **Signed facts.** `CUSTOM_ROLE_SET { role_id, name, base_role, permissions, deleted, revision }` is an owner
  authority fact, sealed like the role matrix; per role the higher revision wins, an equal revision must say the same
  thing, and a different base role is a conflict. `MEMBER_ROLE_CHANGED` gains an optional `custom_role_id`; it waits as
  a missing dependency until the role fact arrives, and its `role` must equal that role's base.

## Consequences

- Desktop: the Roles tab shows custom roles as extra matrix columns with Rename and Delete, and a "New role" form;
  member and new-member role pickers list them. Mobile: More → Staff → Roles lists them with the built-in roles and
  can create, rename and delete; member screens list them too.
- Tills on an earlier build refuse these facts as malformed or unsupported until upgraded, as in ADR-037.
- Creating a member straight into a custom role is two owner facts (member created, then moved); if the second fails
  the member holds the base role and can be moved from their page.
