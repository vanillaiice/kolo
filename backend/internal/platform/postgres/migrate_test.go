package postgres_test

import (
	"context"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// The harness migrates the database it hands back, so reaching any of these
// tests already means the migrations applied cleanly. What follows checks the
// schema they produced actually holds the invariants it claims.

func TestMigrationsApplyAndAreIdempotent(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()

	version, err := postgres.SchemaVersion(ctx, pool)
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if version < 2 {
		t.Errorf("schema is at version %d, want at least 2", version)
	}

	// Running again must apply nothing rather than fail, so a redeployment of
	// an unchanged binary is harmless.
	applied, err := postgres.Migrate(ctx, pool)
	if err != nil {
		t.Fatalf("re-running Migrate: %v", err)
	}
	if len(applied) != 0 {
		t.Errorf("re-running Migrate applied %d migrations, want none", len(applied))
	}

	after, err := postgres.SchemaVersion(ctx, pool)
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if after != version {
		t.Errorf("the version moved from %d to %d without applying anything", version, after)
	}
}

func TestExpectedTablesExist(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()

	for _, table := range []string{"businesses", "branches", "users", "user_credentials"} {
		t.Run(table, func(t *testing.T) {
			var exists bool
			err := pool.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1 FROM information_schema.tables
					WHERE table_schema = 'public' AND table_name = $1
				)`, table).Scan(&exists)
			if err != nil {
				t.Fatalf("querying for the table: %v", err)
			}
			if !exists {
				t.Errorf("table %q was not created", table)
			}
		})
	}
}

// TestSchemaRefusesToDestroyATenant covers the constraint behind §40: history
// is not deleted, so removing a business that owns records must be an error
// rather than a cascade that takes its sales with it.
func TestSchemaRefusesToDestroyATenant(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()

	tenant := insertBusiness(t, pool)
	insertBranch(t, pool, tenant)

	_, err := pool.Exec(ctx, `DELETE FROM businesses WHERE id = $1`, tenant)
	if err == nil {
		t.Fatal("deleting a business that owns a branch succeeded")
	}
	if !isForeignKeyViolation(err) {
		t.Errorf("got %v, want a foreign key violation", err)
	}
}

func TestSchemaRejectsInvalidRows(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()

	tenant := insertBusiness(t, pool)

	tests := []struct {
		name string
		sql  string
		args []any
	}{
		{
			name: "a business with a blank name",
			sql: `INSERT INTO businesses (id, name, currency, active, created_at, updated_at)
			      VALUES ($1, '   ', 'XAF', true, now(), now())`,
			args: []any{newUUID(t)},
		},
		{
			name: "a business with a lower-case currency",
			sql: `INSERT INTO businesses (id, name, currency, active, created_at, updated_at)
			      VALUES ($1, 'Boutique', 'xaf', true, now(), now())`,
			args: []any{newUUID(t)},
		},
		{
			name: "a business updated before it was created",
			sql: `INSERT INTO businesses (id, name, currency, active, created_at, updated_at)
			      VALUES ($1, 'Boutique', 'XAF', true, now(), now() - interval '1 hour')`,
			args: []any{newUUID(t)},
		},
		{
			name: "a user with an unknown role",
			sql: `INSERT INTO users (id, business_id, name, role, active, created_at, updated_at)
			      VALUES ($1, $2, 'Jean', 'SUPERUSER', true, now(), now())`,
			args: []any{newUUID(t), tenant},
		},
		{
			name: "a credential whose phone is not E.164",
			sql: `INSERT INTO user_credentials (user_id, business_id, phone, pin_hash, created_at, updated_at)
			      VALUES ($1, $2, '677123456', '$2a$10$abcdefghijklmnopqrstuv', now(), now())`,
			args: []any{insertUser(t, pool, tenant), tenant},
		},
		{
			name: "a credential storing a plaintext PIN",
			sql: `INSERT INTO user_credentials (user_id, business_id, phone, pin_hash, created_at, updated_at)
			      VALUES ($1, $2, '+237677123456', '1357', now(), now())`,
			args: []any{insertUser(t, pool, tenant), tenant},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := pool.Exec(ctx, tc.sql, tc.args...); err == nil {
				t.Error("the row was accepted, want a constraint violation")
			}
		})
	}
}

// TestAUserCannotBeAssignedToAnotherTenantsBranch is the schema's own guard on
// the boundary ADR-008 protects. Simple foreign keys would allow it, because
// each identifier is individually valid; only the composite key catches it.
func TestAUserCannotBeAssignedToAnotherTenantsBranch(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()

	tenantA := insertBusiness(t, pool)
	tenantB := insertBusiness(t, pool)
	branchOfB := insertBranch(t, pool, tenantB)

	_, err := pool.Exec(ctx, `
		INSERT INTO users (id, business_id, branch_id, name, role, active, created_at, updated_at)
		VALUES ($1, $2, $3, 'Jean', 'CASHIER', true, now(), now())`,
		newUUID(t), tenantA, branchOfB)

	if err == nil {
		t.Fatal("a user of business A was assigned to a branch of business B")
	}
	if !isForeignKeyViolation(err) {
		t.Errorf("got %v, want a foreign key violation", err)
	}
}

// TestACredentialCannotBeAttachedAcrossTenants is the same guard for the login
// table: a credential row naming one business must belong to a user of that
// business.
func TestACredentialCannotBeAttachedAcrossTenants(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()

	tenantA := insertBusiness(t, pool)
	tenantB := insertBusiness(t, pool)
	userOfA := insertUser(t, pool, tenantA)

	_, err := pool.Exec(ctx, `
		INSERT INTO user_credentials (user_id, business_id, phone, pin_hash, created_at, updated_at)
		VALUES ($1, $2, '+237677123456', '$2a$10$abcdefghijklmnopqrstuv', now(), now())`,
		userOfA, tenantB)

	if err == nil {
		t.Fatal("a credential for business B was attached to a user of business A")
	}
	if !isForeignKeyViolation(err) {
		t.Errorf("got %v, want a foreign key violation", err)
	}
}

// TestAPhoneIsUniquePerBusinessNotGlobally pins ADR-012: one person may work
// for two businesses on the same number, and a global constraint would let one
// tenant discover another's staff by registration collision.
func TestAPhoneIsUniquePerBusinessNotGlobally(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()

	const phone = "+237699887766"
	const hash = "$2a$10$abcdefghijklmnopqrstuv"

	tenantA := insertBusiness(t, pool)
	tenantB := insertBusiness(t, pool)

	insert := func(tenant, user any) error {
		_, err := pool.Exec(ctx, `
			INSERT INTO user_credentials (user_id, business_id, phone, pin_hash, created_at, updated_at)
			VALUES ($1, $2, $3, $4, now(), now())`, user, tenant, phone, hash)
		return err
	}

	if err := insert(tenantA, insertUser(t, pool, tenantA)); err != nil {
		t.Fatalf("registering the number under business A: %v", err)
	}
	// The same number under a different business is legitimate.
	if err := insert(tenantB, insertUser(t, pool, tenantB)); err != nil {
		t.Errorf("the same number was refused under another business: %v", err)
	}
	// Twice under the same business is not.
	if err := insert(tenantA, insertUser(t, pool, tenantA)); err == nil {
		t.Error("the same number was registered twice within one business")
	}
}
