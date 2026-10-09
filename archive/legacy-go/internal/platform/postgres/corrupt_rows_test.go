package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// ADR-013 says stored data is not trusted: a row is re-validated on the way in,
// so a record written by an older version, a bad migration, or a manual fix
// fails at the boundary rather than deep in a calculation.
//
// These tests write rows the schema permits but the domain does not, which is
// exactly the gap that re-validation exists to cover. They use raw SQL, since
// the repository is the thing being tested and could not produce them.

func TestReadingABusinessWithAnUnknownCurrencyFails(t *testing.T) {
	pool := pgtest.Pool(t)
	repo := postgres.NewBusinessRepository(pool)
	ctx := context.Background()

	// The schema only requires an upper-case three-letter code, so a currency
	// the system does not know passes the constraint.
	tenant := business.NewID()
	_, err := pool.Exec(ctx, `
		INSERT INTO businesses (id, name, currency, active, created_at, updated_at)
		VALUES ($1, 'Boutique', 'ZZZ', true, now(), now())`, tenant.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	loaded, err := repo.Get(ctx, tenant)
	if err == nil {
		t.Fatalf("reading a business in an unknown currency succeeded, giving %+v", loaded.Snapshot())
	}
	if !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

func TestReadingABusinessThatFailsDomainValidationFails(t *testing.T) {
	pool := pgtest.Pool(t)
	repo := postgres.NewBusinessRepository(pool)
	ctx := context.Background()

	// The schema checks the name is neither blank nor overlong, but not that it
	// is free of invisible characters — a rule only the domain applies.
	tenant := business.NewID()
	_, err := pool.Exec(ctx, `
		INSERT INTO businesses (id, name, currency, active, created_at, updated_at)
		VALUES ($1, $2, 'XAF', true, now(), now())`,
		tenant.ID(), "Bou​tique")
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := repo.Get(ctx, tenant); !errors.Is(err, business.ErrInvalidName) {
		t.Errorf("got %v, want ErrInvalidName", err)
	}
}

func TestReadingABranchThatFailsDomainValidationFails(t *testing.T) {
	pool := pgtest.Pool(t)
	repo := postgres.NewBusinessRepository(pool)
	ctx := context.Background()

	tenant, scope := newTenant(t, repo, ctx)

	branchID := business.NewBranchID()
	_, err := pool.Exec(ctx, `
		INSERT INTO branches (id, business_id, name, active, created_at, updated_at)
		VALUES ($1, $2, $3, true, now(), now())`,
		branchID.ID(), tenant.ID().ID(), "Marché‮Central")
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := repo.GetBranch(ctx, scope, branchID); !errors.Is(err, business.ErrInvalidName) {
		t.Errorf("got %v, want ErrInvalidName", err)
	}

	// A listing containing the bad row fails too, rather than quietly skipping
	// it: a report that silently omits a record is worse than one that stops.
	if _, err := repo.ListBranches(ctx, scope); !errors.Is(err, business.ErrInvalidName) {
		t.Errorf("listing: got %v, want ErrInvalidName", err)
	}
}

// TestReadingABusinessWithInconsistentTimestampsFails covers a row whose
// timestamps the schema would reject, reached through a direct write that
// bypasses the constraint by disabling it — the shape a bad migration takes.
func TestReadingABusinessWithInconsistentTimestampsFails(t *testing.T) {
	pool := pgtest.FreshPool(t)
	repo := postgres.NewBusinessRepository(pool)
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		ALTER TABLE businesses DROP CONSTRAINT businesses_updated_after_created`); err != nil {
		t.Fatalf("dropping the constraint: %v", err)
	}

	tenant := business.NewID()
	_, err := pool.Exec(ctx, `
		INSERT INTO businesses (id, name, currency, active, created_at, updated_at)
		VALUES ($1, 'Boutique', 'XAF', true, now(), now() - interval '1 day')`, tenant.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := repo.Get(ctx, tenant); !errors.Is(err, business.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

// TestReadingACredentialWithANonBcryptHashFails covers a pin_hash column that
// bypassed the schema's check — the shape a bad migration or a manual fix
// leaves behind. Refusing to load matters here more than anywhere: comparing a
// PIN against a plaintext column would let anyone in.
func TestReadingACredentialWithANonBcryptHashFails(t *testing.T) {
	pool := pgtest.FreshPool(t)
	businesses := postgres.NewBusinessRepository(pool)
	userRepo := postgres.NewUserRepository(pool)
	credentials := postgres.NewCredentialRepository(pool)
	ctx := context.Background()

	tenant, scope := newTenant(t, businesses, ctx)
	user := newUser(t, tenant.ID(), "Jean Mbarga", authz.RoleCashier)
	if err := userRepo.Create(ctx, scope, user); err != nil {
		t.Fatalf("creating the user: %v", err)
	}

	credential, err := auth.NewCredential(
		user.ID(), tenant.ID(), phone.MustParse("677123456"), "1357", createdAt,
	)
	if err != nil {
		t.Fatalf("auth.NewCredential: %v", err)
	}
	if err := credentials.Create(ctx, scope, credential); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		ALTER TABLE user_credentials DROP CONSTRAINT user_credentials_pin_hash_is_bcrypt`); err != nil {
		t.Fatalf("dropping the constraint: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE user_credentials SET pin_hash = '1357' WHERE user_id = $1`, user.ID().ID()); err != nil {
		t.Fatalf("planting the plaintext PIN: %v", err)
	}

	loaded, err := credentials.Get(ctx, scope, user.ID())
	if err == nil {
		t.Fatalf("reading a credential with a plaintext PIN succeeded, giving %+v", loaded.Snapshot())
	}
	if !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}

	// And the login path must refuse it too, not just the direct read.
	if _, err := credentials.FindByPhone(ctx, scope, phone.MustParse("677123456")); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("the login lookup: got %v, want ErrQuery", err)
	}
}
