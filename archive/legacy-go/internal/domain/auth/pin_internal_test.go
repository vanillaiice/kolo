package auth

import (
	"errors"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

// These reach inside the package for two paths the public API cannot produce:
// a stored hash that is not a bcrypt hash, and a hashing failure. Both are
// defensive, and both have behaviour worth stating rather than assuming.

// TestNeedsRehashOnACorruptStoredValue covers a hash that bypassed
// RestorePINHash — written by a bad migration, say. Reporting that it needs
// rehashing is the safe answer: it gets replaced at the next successful login.
func TestNeedsRehashOnACorruptStoredValue(t *testing.T) {
	tests := []struct {
		name    string
		encoded string
	}{
		{"plaintext PIN", "1357"},
		{"not a hash", "nonsense"},
		{"truncated bcrypt", "$2a$10$"},
		{"sha256 hex", "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			corrupt := PINHash{encoded: tc.encoded}

			if corrupt.IsZero() {
				t.Fatal("the corrupt value reported itself unset, so nothing is being tested")
			}
			if !corrupt.NeedsRehash() {
				t.Error("a value that is not a bcrypt hash does not report needing a rehash")
			}
			// It must also never verify anything, so a corrupt row cannot be
			// used to log in.
			for _, attempt := range []string{"", "1357", tc.encoded} {
				if corrupt.Verify(attempt) {
					t.Errorf("a corrupt stored value verified %q", attempt)
				}
			}
		})
	}
}

// TestHashPINAtCostReportsAnUnusableWorkFactor covers the hashing error that
// HashPIN itself cannot trigger, since it passes a constant valid cost.
func TestHashPINAtCostReportsAnUnusableWorkFactor(t *testing.T) {
	hash, err := hashPINAtCost("1357", bcrypt.MaxCost+1)
	if err == nil {
		t.Fatalf("hashing at an impossible cost succeeded, giving %q", hash)
	}
	if !hash.IsZero() {
		t.Error("returned a hash alongside an error")
	}

	var invalidCost bcrypt.InvalidCostError
	if !errors.As(err, &invalidCost) {
		t.Errorf("got %v, want it to wrap bcrypt.InvalidCostError", err)
	}
}

// TestHashPINAtCostStillValidatesThePIN confirms the shared path is the one
// HashPIN uses, rather than a parallel route that skips the rules.
func TestHashPINAtCostStillValidatesThePIN(t *testing.T) {
	for _, pin := range []string{"", "123", "abcd", "0000", "1234"} {
		if _, err := hashPINAtCost(pin, bcrypt.MinCost); err == nil {
			t.Errorf("hashPINAtCost accepted the unusable PIN %q", pin)
		}
	}
}

// TestProductionCostIsNotBelowTheLibraryDefault guards against the work factor
// being lowered to speed up tests and then left that way.
func TestProductionCostIsNotBelowTheLibraryDefault(t *testing.T) {
	if hashCost < bcrypt.DefaultCost {
		t.Errorf("hashCost = %d, below the library default of %d", hashCost, bcrypt.DefaultCost)
	}
}
