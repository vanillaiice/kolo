# ADR-037: Shop role permission matrix

**Status:** Accepted, 2026-10-19.

## Context

The specification (section 38) asks for explicit permissions and says "the exact permission matrix should be
configurable". Until now each role's permissions were fixed in `@kolo/contracts/permissions`; the owner could only
adjust one member at a time through grants and revocations. A shop with several cashiers had to repeat the same
exceptions for each of them, and nothing showed what a role meant in that shop.

The owner asked for a matrix like the one in rebar (roles across, permissions down), keeping the existing defaults.
They chose to edit the built-in staff roles rather than invent shop-defined roles, to keep per-member exceptions, and
to let the owner move a member to another role.

## Decision

- **Matrix.** Each staff role (`MANAGER`, `CASHIER`, `INVENTORY`, `ACCOUNTANT`) has a per-shop permission set in
  `role_permissions` (SQLite migration 31). No row, or a NULL set, means the built-in defaults, so every existing shop
  keeps exactly the access it had; setting a role to its defaults stores NULL, so later catalog additions to a
  default still reach it. `OWNER` has no row and always holds every permission.
- **Resolution.** Effective permissions = role set (shop's or built-in) + member grants − member revocations,
  re-read on every command (`memberPermissions(tx, member)`). A corrupt role row fails closed for that role's holders.
- **Exceptions.** A member's grants and revocations stay as exceptions on top of the role. The new
  `PERMISSION_OVERRIDE_CLEARED` fact drops one, so the permission follows the role again; screens record it when the
  owner switches a permission back to what the role gives, rather than a matching grant that would outlive a later
  role change.
- **Role moves.** `MEMBER_ROLE_CHANGED` moves a staff member to another staff role, keeping their exceptions. It
  advances the member's authority revision like other member facts. The owner's role never changes and nobody
  becomes owner.
- **Signed facts.** `ROLE_PERMISSIONS_SET { role, permissions | null, revision }` is an owner authority fact
  (`users.manage`, authority-approved device), sealed like other business facts. Per role, the higher revision wins
  and an equal revision must carry the same set, otherwise it is a conflict. Quarantined role facts cannot be
  accepted through owner review, like every other authority fact.
- **Not bumped.** Changing a role does not bump each holder's revision: those revisions form per-member chains that
  other tills check. A fact a member made under the old role that arrives after the change is judged against the
  new role and may wait for owner review, as with any revocation.

## Consequences

- The desktop Staff section gains a Roles tab (the matrix, with "Reset" per customized role) and a role picker and
  exception marks on each member; mobile gains More → Staff → Roles, one role at a time, and the same member controls.
- Tills running a build without these facts keep them unapplied as unsupported until upgraded. No shop has been
  deployed to customers yet, so no mixed fleet is expected.
- Shop-defined roles (new names, deletion) remain out of scope; they would need a role ID on memberships and new
  member facts. Superseded on this point by [ADR-038](ADR-038-custom-roles.md).
