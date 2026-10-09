package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

const storedPIN = "1357"

type credentialFixture struct {
	credentials *postgres.CredentialRepository
	users       *postgres.UserRepository
	businesses  *postgres.BusinessRepository
	ctx         context.Context
}

func newCredentialFixture(t *testing.T) credentialFixture {
	t.Helper()
	pool := pgtest.Pool(t)
	return credentialFixture{
		credentials: postgres.NewCredentialRepository(pool),
		users:       postgres.NewUserRepository(pool),
		businesses:  postgres.NewBusinessRepository(pool),
		ctx:         context.Background(),
	}
}

// storedUser creates a user and stores them, since a credential cannot exist
// without one.
func (f credentialFixture) storedUser(t *testing.T, tenant business.ID, scope business.Scope) *users.User {
	t.Helper()
	record := newUser(t, tenant, "Jean Mbarga", authz.RoleCashier)
	if err := f.users.Create(f.ctx, scope, record); err != nil {
		t.Fatalf("creating the user: %v", err)
	}
	return record
}

func (f credentialFixture) storedCredential(
	t *testing.T, scope business.Scope, user *users.User, number string,
) *auth.Credential {
	t.Helper()
	credential, err := auth.NewCredential(
		user.ID(), user.BusinessID(), phone.MustParse(number), storedPIN, createdAt,
	)
	if err != nil {
		t.Fatalf("auth.NewCredential: %v", err)
	}
	if err := f.credentials.Create(f.ctx, scope, credential); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return credential
}

func TestCreateAndGetCredential(t *testing.T) {
	f := newCredentialFixture(t)
	tenant, scope := newTenant(t, f.businesses, f.ctx)
	user := f.storedUser(t, tenant.ID(), scope)

	created := f.storedCredential(t, scope, user, "677123456")

	loaded, err := f.credentials.Get(f.ctx, scope, user.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != created.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), created.Snapshot())
	}
	if !loaded.Verify(storedPIN) {
		t.Error("a credential read back from storage does not verify its PIN")
	}
}

// TestFindByPhoneMatchesHoweverTheNumberWasTyped is the login path, and the
// reason the phone type normalises: whatever the person enters must find the
// same row.
func TestFindByPhoneMatchesHoweverTheNumberWasTyped(t *testing.T) {
	f := newCredentialFixture(t)
	tenant, scope := newTenant(t, f.businesses, f.ctx)
	user := f.storedUser(t, tenant.ID(), scope)

	created := f.storedCredential(t, scope, user, "677123456")

	spellings := []string{
		"677123456",
		"677 123 456",
		"+237677123456",
		"+237 677 123 456",
		"00237677123456",
		"  677-123-456  ",
	}
	for _, spelling := range spellings {
		t.Run(spelling, func(t *testing.T) {
			number, err := phone.Parse(spelling)
			if err != nil {
				t.Fatalf("phone.Parse(%q): %v", spelling, err)
			}

			found, err := f.credentials.FindByPhone(f.ctx, scope, number)
			if err != nil {
				t.Fatalf("FindByPhone: %v", err)
			}
			if found.UserID() != created.UserID() {
				t.Errorf("found user %s, want %s", found.UserID(), created.UserID())
			}
		})
	}
}

// TestOneTenantCannotFindAnothersLogin is the property that makes a phone
// number identify a person within a business rather than globally. Without the
// tenant predicate, a login attempt from one business would reach another's
// staff.
func TestOneTenantCannotFindAnothersLogin(t *testing.T) {
	f := newCredentialFixture(t)

	tenantA, scopeA := newTenant(t, f.businesses, f.ctx)
	tenantB, scopeB := newTenant(t, f.businesses, f.ctx)

	userOfA := f.storedUser(t, tenantA.ID(), scopeA)
	credentialOfA := f.storedCredential(t, scopeA, userOfA, "677123456")

	number := phone.MustParse("677123456")

	if _, err := f.credentials.FindByPhone(f.ctx, scopeB, number); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("looking up another tenant's login: got %v, want ErrNotFound", err)
	}
	if _, err := f.credentials.Get(f.ctx, scopeB, userOfA.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("reading another tenant's credential: got %v, want ErrNotFound", err)
	}

	// The same number registered under B belongs to a different person, and
	// each business finds only its own.
	userOfB := f.storedUser(t, tenantB.ID(), scopeB)
	credentialOfB := f.storedCredential(t, scopeB, userOfB, "677123456")

	foundInA, err := f.credentials.FindByPhone(f.ctx, scopeA, number)
	if err != nil {
		t.Fatalf("FindByPhone: %v", err)
	}
	foundInB, err := f.credentials.FindByPhone(f.ctx, scopeB, number)
	if err != nil {
		t.Fatalf("FindByPhone: %v", err)
	}
	if foundInA.UserID() != credentialOfA.UserID() {
		t.Error("business A found the wrong person")
	}
	if foundInB.UserID() != credentialOfB.UserID() {
		t.Error("business B found the wrong person")
	}
	if foundInA.UserID() == foundInB.UserID() {
		t.Error("the same number resolved to one person across two businesses")
	}
}

// TestAPINFromOneBusinessDoesNotUnlockAnother is the consequence worth stating
// outright: even with the same number and the same PIN, the credentials are
// separate records.
func TestAPINFromOneBusinessDoesNotUnlockAnother(t *testing.T) {
	f := newCredentialFixture(t)

	tenantA, scopeA := newTenant(t, f.businesses, f.ctx)
	tenantB, scopeB := newTenant(t, f.businesses, f.ctx)

	userA := f.storedUser(t, tenantA.ID(), scopeA)
	f.storedCredential(t, scopeA, userA, "677123456")

	userB := f.storedUser(t, tenantB.ID(), scopeB)
	credentialB, err := auth.NewCredential(
		userB.ID(), tenantB.ID(), phone.MustParse("677123456"), "9042", createdAt,
	)
	if err != nil {
		t.Fatalf("auth.NewCredential: %v", err)
	}
	if err := f.credentials.Create(f.ctx, scopeB, credentialB); err != nil {
		t.Fatalf("Create: %v", err)
	}

	number := phone.MustParse("677123456")

	inA, err := f.credentials.FindByPhone(f.ctx, scopeA, number)
	if err != nil {
		t.Fatalf("FindByPhone: %v", err)
	}
	inB, err := f.credentials.FindByPhone(f.ctx, scopeB, number)
	if err != nil {
		t.Fatalf("FindByPhone: %v", err)
	}

	if !inA.Verify(storedPIN) || inA.Verify("9042") {
		t.Error("business A's credential does not hold its own PIN alone")
	}
	if !inB.Verify("9042") || inB.Verify(storedPIN) {
		t.Error("business B's credential does not hold its own PIN alone")
	}
}

func TestRegisteringANumberTwiceInOneBusinessConflicts(t *testing.T) {
	f := newCredentialFixture(t)
	tenant, scope := newTenant(t, f.businesses, f.ctx)

	first := f.storedUser(t, tenant.ID(), scope)
	f.storedCredential(t, scope, first, "677123456")

	second := newUser(t, tenant.ID(), "Marie Ngo", authz.RoleCashier)
	if err := f.users.Create(f.ctx, scope, second); err != nil {
		t.Fatalf("creating the second user: %v", err)
	}

	clash, err := auth.NewCredential(
		second.ID(), tenant.ID(), phone.MustParse("677123456"), "9042", createdAt,
	)
	if err != nil {
		t.Fatalf("auth.NewCredential: %v", err)
	}
	if err := f.credentials.Create(f.ctx, scope, clash); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

func TestUpdateCredential(t *testing.T) {
	f := newCredentialFixture(t)
	tenant, scope := newTenant(t, f.businesses, f.ctx)
	user := f.storedUser(t, tenant.ID(), scope)

	credential := f.storedCredential(t, scope, user, "677123456")

	if err := credential.ChangePIN("9042", createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("ChangePIN: %v", err)
	}
	if err := credential.ChangePhone(phone.MustParse("699887766"), createdAt.Add(2*time.Hour)); err != nil {
		t.Fatalf("ChangePhone: %v", err)
	}
	if err := f.credentials.Update(f.ctx, scope, credential); err != nil {
		t.Fatalf("Update: %v", err)
	}

	loaded, err := f.credentials.Get(f.ctx, scope, user.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Verify(storedPIN) {
		t.Error("the old PIN still verifies after a change")
	}
	if !loaded.Verify("9042") {
		t.Error("the new PIN does not verify")
	}

	// And the login now works under the new number, not the old one.
	if _, err := f.credentials.FindByPhone(f.ctx, scope, phone.MustParse("699887766")); err != nil {
		t.Errorf("looking up the new number: %v", err)
	}
	if _, err := f.credentials.FindByPhone(f.ctx, scope, phone.MustParse("677123456")); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the old number still resolves: got %v, want ErrNotFound", err)
	}
}

func TestEveryCredentialOperationRefusesAnUnsetScope(t *testing.T) {
	f := newCredentialFixture(t)
	tenant, scope := newTenant(t, f.businesses, f.ctx)
	user := f.storedUser(t, tenant.ID(), scope)
	credential := f.storedCredential(t, scope, user, "677123456")

	var unset business.Scope

	operations := map[string]func() error{
		"Create": func() error { return f.credentials.Create(f.ctx, unset, credential) },
		"Get":    func() error { _, err := f.credentials.Get(f.ctx, unset, user.ID()); return err },
		"FindByPhone": func() error {
			_, err := f.credentials.FindByPhone(f.ctx, unset, phone.MustParse("677123456"))
			return err
		},
		"Update": func() error { return f.credentials.Update(f.ctx, unset, credential) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestCredentialOperationsAcrossTenantsAreRefused(t *testing.T) {
	f := newCredentialFixture(t)

	tenantA, scopeA := newTenant(t, f.businesses, f.ctx)
	_, scopeB := newTenant(t, f.businesses, f.ctx)

	userOfA := f.storedUser(t, tenantA.ID(), scopeA)
	credentialOfA := f.storedCredential(t, scopeA, userOfA, "677123456")

	if err := f.credentials.Create(f.ctx, scopeB, credentialOfA); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("creating: got %v, want ErrCrossTenant", err)
	}
	if err := f.credentials.Update(f.ctx, scopeB, credentialOfA); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("updating: got %v, want ErrCrossTenant", err)
	}
}

func TestGetMissingCredential(t *testing.T) {
	f := newCredentialFixture(t)
	_, scope := newTenant(t, f.businesses, f.ctx)

	if _, err := f.credentials.Get(f.ctx, scope, users.NewID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := f.credentials.Get(f.ctx, scope, users.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero identifier: got %v, want ErrNotFound", err)
	}
	if _, err := f.credentials.FindByPhone(f.ctx, scope, phone.MustParse("699000111")); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("an unregistered number: got %v, want ErrNotFound", err)
	}
	if _, err := f.credentials.FindByPhone(f.ctx, scope, phone.Number{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero number: got %v, want ErrNotFound", err)
	}
}

func TestUpdateMissingCredential(t *testing.T) {
	f := newCredentialFixture(t)
	tenant, scope := newTenant(t, f.businesses, f.ctx)
	user := f.storedUser(t, tenant.ID(), scope)

	absent, err := auth.NewCredential(
		user.ID(), tenant.ID(), phone.MustParse("677123456"), storedPIN, createdAt,
	)
	if err != nil {
		t.Fatalf("auth.NewCredential: %v", err)
	}
	if err := f.credentials.Update(f.ctx, scope, absent); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

func TestACredentialRequiresItsUserToExist(t *testing.T) {
	f := newCredentialFixture(t)
	tenant, scope := newTenant(t, f.businesses, f.ctx)

	orphan, err := auth.NewCredential(
		users.NewID(), tenant.ID(), phone.MustParse("677123456"), storedPIN, createdAt,
	)
	if err != nil {
		t.Fatalf("auth.NewCredential: %v", err)
	}
	if err := f.credentials.Create(f.ctx, scope, orphan); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

// TestReadingACredentialWithACorruptPhoneFails covers a row the schema's E.164
// pattern would allow but the phone library rejects as undialable.
func TestReadingACredentialWithACorruptPhoneFails(t *testing.T) {
	pool := pgtest.Pool(t)
	f := credentialFixture{
		credentials: postgres.NewCredentialRepository(pool),
		users:       postgres.NewUserRepository(pool),
		businesses:  postgres.NewBusinessRepository(pool),
		ctx:         context.Background(),
	}
	tenant, scope := newTenant(t, f.businesses, f.ctx)
	user := f.storedUser(t, tenant.ID(), scope)
	f.storedCredential(t, scope, user, "677123456")

	// +99999999999 satisfies the schema's pattern but is not a real number.
	if _, err := pool.Exec(f.ctx,
		`UPDATE user_credentials SET phone = '+99999999999' WHERE user_id = $1`,
		user.ID().ID()); err != nil {
		t.Fatalf("planting the bad number: %v", err)
	}

	if _, err := f.credentials.Get(f.ctx, scope, user.ID()); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}
