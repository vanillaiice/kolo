package auth_test

import (
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

const testPIN = "1357"

func newTestCredential(t *testing.T) *auth.Credential {
	t.Helper()
	credential, err := auth.NewCredential(
		users.NewID(), business.NewID(), phone.MustParse("677123456"), testPIN, issuedAt,
	)
	if err != nil {
		t.Fatalf("NewCredential: %v", err)
	}
	return credential
}

func TestNewCredential(t *testing.T) {
	userID, tenant := users.NewID(), business.NewID()
	number := phone.MustParse("677 123 456")

	credential, err := auth.NewCredential(userID, tenant, number, testPIN, issuedAt)
	if err != nil {
		t.Fatalf("NewCredential: %v", err)
	}

	if got := credential.UserID(); got != userID {
		t.Errorf("UserID() = %s, want %s", got, userID)
	}
	if got := credential.BusinessID(); got != tenant {
		t.Errorf("BusinessID() = %s, want %s", got, tenant)
	}
	if got := credential.Phone(); !got.Equal(number) {
		t.Errorf("Phone() = %s, want %s", got, number)
	}
	if !credential.CreatedAt().Equal(issuedAt) || !credential.UpdatedAt().Equal(issuedAt) {
		t.Errorf("timestamps are %s and %s, want both %s",
			credential.CreatedAt(), credential.UpdatedAt(), issuedAt)
	}
	if !credential.Verify(testPIN) {
		t.Error("the credential does not verify the PIN it was created with")
	}
}

// TestTheCredentialNeverRetainsThePIN is the point of the type.
func TestTheCredentialNeverRetainsThePIN(t *testing.T) {
	credential := newTestCredential(t)

	stored := credential.PINHash().String()
	if stored == testPIN {
		t.Fatal("the credential stored the PIN itself")
	}
	if credential.Verify("2468") {
		t.Error("a wrong PIN verified")
	}
	if credential.Verify("") {
		t.Error("an empty PIN verified")
	}
}

func TestNewCredentialRejectsInvalidInput(t *testing.T) {
	userID, tenant := users.NewID(), business.NewID()
	number := phone.MustParse("677123456")

	tests := []struct {
		name   string
		userID users.ID
		tenant business.ID
		number phone.Number
		pin    string
		now    time.Time
		want   error
	}{
		{"zero user", users.ID{}, tenant, number, testPIN, issuedAt, auth.ErrInvalidID},
		{"zero business", userID, business.ID{}, number, testPIN, issuedAt, auth.ErrInvalidID},
		{"no phone", userID, tenant, phone.Number{}, testPIN, issuedAt, auth.ErrNoPhone},
		{"short PIN", userID, tenant, number, "123", issuedAt, auth.ErrInvalidPIN},
		{"non-numeric PIN", userID, tenant, number, "abcd", issuedAt, auth.ErrInvalidPIN},
		{"guessable PIN", userID, tenant, number, "1234", issuedAt, auth.ErrWeakPIN},
		{"zero timestamp", userID, tenant, number, testPIN, time.Time{}, auth.ErrInvalidTime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			credential, err := auth.NewCredential(tc.userID, tc.tenant, tc.number, tc.pin, tc.now)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if credential != nil {
				t.Error("returned a credential alongside an error")
			}
		})
	}
}

// TestVerifyIgnoresAccountStatus records a deliberate split: the credential
// answers only "is this the right PIN", and whether the account may then be
// used comes from the user record, which knows why not.
func TestVerifyIgnoresAccountStatus(t *testing.T) {
	credential := newTestCredential(t)

	if !credential.Verify(testPIN) {
		t.Error("the PIN did not verify")
	}
	// There is deliberately no way to ask a credential whether the account is
	// active; that question belongs elsewhere.
}

func TestChangePIN(t *testing.T) {
	credential := newTestCredential(t)
	changedAt := issuedAt.Add(time.Hour)

	if err := credential.ChangePIN("9042", changedAt); err != nil {
		t.Fatalf("ChangePIN: %v", err)
	}

	if credential.Verify(testPIN) {
		t.Error("the old PIN still verifies")
	}
	if !credential.Verify("9042") {
		t.Error("the new PIN does not verify")
	}
	if !credential.UpdatedAt().Equal(changedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", credential.UpdatedAt(), changedAt)
	}
}

func TestChangePINRejectsInvalidInput(t *testing.T) {
	credential := newTestCredential(t)

	tests := []struct {
		name string
		pin  string
		at   time.Time
		want error
	}{
		{"too short", "123", issuedAt, auth.ErrInvalidPIN},
		{"not digits", "abcd", issuedAt, auth.ErrInvalidPIN},
		{"guessable", "0000", issuedAt, auth.ErrWeakPIN},
		{"zero timestamp", "9042", time.Time{}, auth.ErrInvalidTime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := credential.ChangePIN(tc.pin, tc.at); !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			// A rejected change must leave the old PIN working.
			if !credential.Verify(testPIN) {
				t.Error("a failed change disturbed the stored PIN")
			}
		})
	}
}

func TestRehashKeepsTheSamePIN(t *testing.T) {
	credential := newTestCredential(t)
	before := credential.PINHash().String()

	if err := credential.Rehash(testPIN, issuedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Rehash: %v", err)
	}

	if !credential.Verify(testPIN) {
		t.Error("the PIN stopped verifying after a rehash")
	}
	// The stored value changes even though the PIN did not, because the salt
	// is fresh.
	if credential.PINHash().String() == before {
		t.Error("the stored hash is unchanged after a rehash")
	}
}

// TestRehashRefusesAWrongPIN keeps a failed login attempt from quietly
// overwriting the credential.
func TestRehashRefusesAWrongPIN(t *testing.T) {
	credential := newTestCredential(t)
	before := credential.PINHash().String()

	if err := credential.Rehash("9042", issuedAt.Add(time.Hour)); !errors.Is(err, auth.ErrInvalidPIN) {
		t.Errorf("got %v, want ErrInvalidPIN", err)
	}
	if credential.PINHash().String() != before {
		t.Error("a rejected rehash changed the stored hash")
	}
	if !credential.Verify(testPIN) {
		t.Error("the original PIN stopped verifying")
	}

	if err := credential.Rehash(testPIN, time.Time{}); !errors.Is(err, auth.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

func TestChangePhone(t *testing.T) {
	credential := newTestCredential(t)
	changedAt := issuedAt.Add(time.Hour)
	replacement := phone.MustParse("699887766")

	if err := credential.ChangePhone(replacement, changedAt); err != nil {
		t.Fatalf("ChangePhone: %v", err)
	}
	if got := credential.Phone(); !got.Equal(replacement) {
		t.Errorf("Phone() = %s, want %s", got, replacement)
	}
	if !credential.UpdatedAt().Equal(changedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", credential.UpdatedAt(), changedAt)
	}

	// Setting the same number, however spelled, is not a change.
	if err := credential.ChangePhone(phone.MustParse("+237699887766"), changedAt.Add(time.Hour)); err != nil {
		t.Fatalf("ChangePhone: %v", err)
	}
	if !credential.UpdatedAt().Equal(changedAt) {
		t.Errorf("a redundant change moved UpdatedAt to %s", credential.UpdatedAt())
	}
}

func TestChangePhoneRejectsInvalidInput(t *testing.T) {
	credential := newTestCredential(t)
	original := credential.Phone()

	if err := credential.ChangePhone(phone.Number{}, issuedAt); !errors.Is(err, auth.ErrNoPhone) {
		t.Errorf("got %v, want ErrNoPhone", err)
	}
	if err := credential.ChangePhone(phone.MustParse("699887766"), time.Time{}); !errors.Is(err, auth.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if got := credential.Phone(); !got.Equal(original) {
		t.Errorf("a rejected change moved the number to %s", got)
	}
}

func TestCredentialSnapshotRoundTrip(t *testing.T) {
	credential := newTestCredential(t)
	if err := credential.ChangePhone(phone.MustParse("699887766"), issuedAt.Add(time.Hour)); err != nil {
		t.Fatalf("ChangePhone: %v", err)
	}

	restored, err := auth.RestoreCredential(credential.Snapshot())
	if err != nil {
		t.Fatalf("RestoreCredential: %v", err)
	}
	if restored.Snapshot() != credential.Snapshot() {
		t.Errorf("round trip gave %+v, want %+v", restored.Snapshot(), credential.Snapshot())
	}
	if !restored.Verify(testPIN) {
		t.Error("a restored credential does not verify its PIN")
	}
}

func TestRestoreCredentialValidatesStoredData(t *testing.T) {
	valid := newTestCredential(t).Snapshot()

	if _, err := auth.RestoreCredential(valid); err != nil {
		t.Fatalf("RestoreCredential rejected a valid snapshot: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*auth.CredentialSnapshot)
		want   error
	}{
		{"zero user", func(s *auth.CredentialSnapshot) { s.UserID = users.ID{} }, auth.ErrInvalidID},
		{"zero business", func(s *auth.CredentialSnapshot) { s.BusinessID = business.ID{} }, auth.ErrInvalidID},
		{"no phone", func(s *auth.CredentialSnapshot) { s.Phone = phone.Number{} }, auth.ErrNoPhone},
		{"no PIN hash", func(s *auth.CredentialSnapshot) { s.PIN = auth.PINHash{} }, auth.ErrInvalidPIN},
		{"zero creation", func(s *auth.CredentialSnapshot) { s.CreatedAt = time.Time{} }, auth.ErrInvalidTime},
		{"zero update", func(s *auth.CredentialSnapshot) { s.UpdatedAt = time.Time{} }, auth.ErrInvalidTime},
		{
			"updated before created",
			func(s *auth.CredentialSnapshot) { s.UpdatedAt = s.CreatedAt.Add(-time.Hour) },
			auth.ErrInvalidTime,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := valid
			tc.mutate(&snapshot)

			restored, err := auth.RestoreCredential(snapshot)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if restored != nil {
				t.Error("returned a credential alongside an error")
			}
		})
	}
}

func TestNewCredentialNormalisesTheTimestampToUTC(t *testing.T) {
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	local := time.Date(2026, 8, 14, 10, 30, 0, 0, wat)

	credential, err := auth.NewCredential(
		users.NewID(), business.NewID(), phone.MustParse("677123456"), testPIN, local,
	)
	if err != nil {
		t.Fatalf("NewCredential: %v", err)
	}
	if got := credential.CreatedAt().Location(); got != time.UTC {
		t.Errorf("CreatedAt() location = %s, want UTC", got)
	}
	if !credential.CreatedAt().Equal(local) {
		t.Errorf("CreatedAt() = %s, want the same instant as %s", credential.CreatedAt(), local)
	}
}

// TestCredentialNeedsRehash surfaces the stored hash's work factor, so a
// successful login can upgrade a credential written under a weaker one.
func TestCredentialNeedsRehash(t *testing.T) {
	current := newTestCredential(t)
	if current.NeedsRehash() {
		t.Error("a freshly created credential reports needing a rehash")
	}

	// A credential restored from a hash made at a lower work factor must be
	// flagged, and stop being flagged once rehashed.
	weak, err := bcryptAtCost(t, testPIN, 4)
	if err != nil {
		t.Fatalf("hashing at a low cost: %v", err)
	}
	stale, err := auth.RestoreCredential(auth.CredentialSnapshot{
		UserID:     users.NewID(),
		BusinessID: business.NewID(),
		Phone:      phone.MustParse("677123456"),
		PIN:        weak,
		CreatedAt:  issuedAt,
		UpdatedAt:  issuedAt,
	})
	if err != nil {
		t.Fatalf("RestoreCredential: %v", err)
	}

	if !stale.NeedsRehash() {
		t.Fatal("a credential hashed at a lower work factor does not report needing a rehash")
	}
	if err := stale.Rehash(testPIN, issuedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Rehash: %v", err)
	}
	if stale.NeedsRehash() {
		t.Error("the credential still reports needing a rehash after being upgraded")
	}
}
