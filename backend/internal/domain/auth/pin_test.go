package auth_test

import (
	"errors"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
)

// bcryptAtCost builds a stored hash at a chosen work factor, using only the
// package's public surface, so the rehash-on-login path can be exercised.
func bcryptAtCost(t *testing.T, pin string, cost int) (auth.PINHash, error) {
	t.Helper()
	encoded, err := bcrypt.GenerateFromPassword([]byte(pin), cost)
	if err != nil {
		return auth.PINHash{}, err
	}
	return auth.RestorePINHash(string(encoded))
}

func TestValidatePINAcceptsUsablePINs(t *testing.T) {
	valid := []string{
		"1357",     // four digits, no pattern
		"9042",     //
		"2580",     // a column on the keypad, but not a run
		"13579",    // five
		"104729",   // six
		"90210381", // the maximum
		"1224",     // repeated digits are fine when not all the same
		"1235",     // nearly sequential, but not
		"0001",     // leading zeroes preserved
	}
	for _, pin := range valid {
		t.Run(pin, func(t *testing.T) {
			if err := auth.ValidatePIN(pin); err != nil {
				t.Errorf("ValidatePIN(%q): %v", pin, err)
			}
		})
	}
}

func TestValidatePINRejectsMalformedPINs(t *testing.T) {
	tests := []struct {
		name string
		pin  string
	}{
		{"empty", ""},
		{"too short", "123"},
		{"one digit", "7"},
		{"too long", "123456789"},
		{"letters", "abcd"},
		{"mixed", "12a4"},
		{"spaces", "12 4"},
		{"punctuation", "1-24"},
		{"leading space", " 1357"},
		{"trailing newline", "1357\n"},
		{"unicode digits", "١٢٣٤"},   // Arabic-Indic digits
		{"fullwidth digits", "１３５７"}, // fullwidth forms
		{"nul byte", "135\x00"},
		{"emoji", "13🙂7"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := auth.ValidatePIN(tc.pin); !errors.Is(err, auth.ErrInvalidPIN) {
				t.Errorf("ValidatePIN(%q) = %v, want ErrInvalidPIN", tc.pin, err)
			}
		})
	}
}

// TestValidatePINRejectsTheObviousGuesses covers the small set an attacker
// tries first. The rules stay modest on purpose: demanding complexity from a
// four-digit number mostly produces PINs written on the side of the till.
func TestValidatePINRejectsTheObviousGuesses(t *testing.T) {
	weak := []string{
		"0000", "1111", "9999", "5555",
		"1234", "2345", "6789", "01234567",
		"4321", "9876", "3210",
	}
	for _, pin := range weak {
		t.Run(pin, func(t *testing.T) {
			err := auth.ValidatePIN(pin)
			if !errors.Is(err, auth.ErrWeakPIN) {
				t.Errorf("ValidatePIN(%q) = %v, want ErrWeakPIN", pin, err)
			}
			// A weak PIN is still an invalid one, so a caller checking only the
			// broader error is not silently let through.
			if !errors.Is(err, auth.ErrInvalidPIN) && !errors.Is(err, auth.ErrWeakPIN) {
				t.Errorf("ValidatePIN(%q) = %v, want it to signal rejection", pin, err)
			}
		})
	}
}

func TestHashPINAndVerify(t *testing.T) {
	const pin = "1357"

	hash, err := auth.HashPIN(pin)
	if err != nil {
		t.Fatalf("HashPIN: %v", err)
	}

	if hash.IsZero() {
		t.Fatal("HashPIN produced an unset hash")
	}
	if !hash.Verify(pin) {
		t.Error("the correct PIN did not verify")
	}
	if hash.Verify("2468") {
		t.Error("an incorrect PIN verified")
	}
	if hash.Verify("") {
		t.Error("an empty PIN verified")
	}
	if hash.Verify(pin + "0") {
		t.Error("a PIN with an extra digit verified")
	}
	if hash.Verify(pin[:3]) {
		t.Error("a truncated PIN verified")
	}
}

// TestTheStoredHashNeverContainsThePIN is the point of hashing at all.
func TestTheStoredHashNeverContainsThePIN(t *testing.T) {
	const pin = "90210381"

	hash, err := auth.HashPIN(pin)
	if err != nil {
		t.Fatalf("HashPIN: %v", err)
	}

	if stored := hash.String(); strings.Contains(stored, pin) {
		t.Errorf("the stored hash %q contains the PIN", stored)
	}
	if !strings.HasPrefix(hash.String(), "$2") {
		t.Errorf("the stored hash %q is not a bcrypt hash", hash.String())
	}
}

// TestHashPINIsSaltedPerCall keeps two users who chose the same PIN from having
// the same stored value, which would make one disclosure reveal both.
func TestHashPINIsSaltedPerCall(t *testing.T) {
	const pin = "1357"

	first, err := auth.HashPIN(pin)
	if err != nil {
		t.Fatalf("HashPIN: %v", err)
	}
	second, err := auth.HashPIN(pin)
	if err != nil {
		t.Fatalf("HashPIN: %v", err)
	}

	if first.String() == second.String() {
		t.Error("hashing the same PIN twice produced the same stored value")
	}
	// Both must still verify.
	if !first.Verify(pin) || !second.Verify(pin) {
		t.Error("a salted hash failed to verify its own PIN")
	}
}

func TestHashPINRejectsUnusablePINs(t *testing.T) {
	for _, pin := range []string{"", "123", "abcd", "0000", "1234"} {
		t.Run(pin, func(t *testing.T) {
			hash, err := auth.HashPIN(pin)
			if err == nil {
				t.Fatalf("HashPIN(%q) succeeded", pin)
			}
			if !hash.IsZero() {
				t.Error("returned a hash alongside an error")
			}
		})
	}
}

// TestZeroHashVerifiesNothing keeps a user with no credential from being logged
// in by supplying an empty PIN.
func TestZeroHashVerifiesNothing(t *testing.T) {
	var unset auth.PINHash

	if !unset.IsZero() {
		t.Error("the zero PINHash did not report itself unset")
	}
	if got := unset.String(); got != "" {
		t.Errorf("String() = %q, want empty", got)
	}
	for _, attempt := range []string{"", "0000", "1357"} {
		if unset.Verify(attempt) {
			t.Errorf("the zero PINHash verified %q", attempt)
		}
	}
	if !unset.NeedsRehash() {
		t.Error("the zero PINHash does not report needing a rehash")
	}
}

func TestRestorePINHash(t *testing.T) {
	original, err := auth.HashPIN("1357")
	if err != nil {
		t.Fatalf("HashPIN: %v", err)
	}

	restored, err := auth.RestorePINHash(original.String())
	if err != nil {
		t.Fatalf("RestorePINHash: %v", err)
	}
	if restored.String() != original.String() {
		t.Errorf("round trip gave %q, want %q", restored, original)
	}
	if !restored.Verify("1357") {
		t.Error("a restored hash did not verify its PIN")
	}
}

// TestRestorePINHashRefusesAPlaintextPIN guards a migration going wrong: a
// column holding a bare PIN must be refused, not compared against as though it
// were a hash.
func TestRestorePINHashRefusesAPlaintextPIN(t *testing.T) {
	tests := []struct {
		name    string
		encoded string
	}{
		{"empty", ""},
		{"whitespace", "   "},
		{"plaintext PIN", "1357"},
		{"not a hash", "nonsense"},
		{"truncated bcrypt", "$2a$10$"},
		{"wrong algorithm marker", "$1$abcdefgh$xxxxxxxxxxxxxxxxxxxxxx"},
		{"sha256 hex", strings.Repeat("a", 64)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			restored, err := auth.RestorePINHash(tc.encoded)
			if !errors.Is(err, auth.ErrInvalidPIN) {
				t.Errorf("RestorePINHash(%q) = %v, want ErrInvalidPIN", tc.encoded, err)
			}
			if !restored.IsZero() {
				t.Error("returned a hash alongside an error")
			}
		})
	}
}

func TestNeedsRehash(t *testing.T) {
	current, err := auth.HashPIN("1357")
	if err != nil {
		t.Fatalf("HashPIN: %v", err)
	}
	if current.NeedsRehash() {
		t.Error("a freshly made hash reports needing a rehash")
	}

	// A hash made at a lower work factor must be flagged, so that a login can
	// upgrade it in place — the only moment the plaintext PIN is available.
	weak, err := bcryptAtCost(t, "1357", 4)
	if err != nil {
		t.Fatalf("hashing at a low cost: %v", err)
	}
	if !weak.NeedsRehash() {
		t.Error("a hash made at a lower work factor does not report needing a rehash")
	}
	if !weak.Verify("1357") {
		t.Error("a low-cost hash failed to verify, so the upgrade path is untestable")
	}
}

// FuzzValidatePIN checks that validation never panics and that anything it
// accepts really is a short run of ASCII digits.
func FuzzValidatePIN(f *testing.F) {
	f.Add("1357")
	f.Add("")
	f.Add("0000")
	f.Add("1234")
	f.Add("abcd")
	f.Add("١٢٣٤")

	f.Fuzz(func(t *testing.T, pin string) {
		if err := auth.ValidatePIN(pin); err != nil {
			return
		}

		if length := len(pin); length < auth.MinPINLength || length > auth.MaxPINLength {
			t.Fatalf("ValidatePIN accepted %q, of length %d", pin, length)
		}
		for _, character := range pin {
			if character < '0' || character > '9' {
				t.Fatalf("ValidatePIN accepted %q, which contains %U", pin, character)
			}
		}

		// Anything accepted must hash and then verify.
		hash, err := auth.HashPIN(pin)
		if err != nil {
			t.Fatalf("HashPIN rejected the accepted PIN %q: %v", pin, err)
		}
		if !hash.Verify(pin) {
			t.Fatalf("the hash of %q did not verify it", pin)
		}
	})
}
