package authn_test

import (
	"testing"

	"golang.org/x/crypto/bcrypt"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
)

// lowCostHash builds a stored PIN hash at bcrypt's weakest work factor, using
// only public API, so the rehash-on-login path can be exercised without waiting
// on the production factor.
func lowCostHash(t *testing.T, pin string) auth.PINHash {
	t.Helper()

	encoded, err := bcrypt.GenerateFromPassword([]byte(pin), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hashing at the minimum cost: %v", err)
	}
	hashed, err := auth.RestorePINHash(string(encoded))
	if err != nil {
		t.Fatalf("auth.RestorePINHash: %v", err)
	}
	return hashed
}
