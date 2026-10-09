package customers_test

import (
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
)

func TestCustomerIdentifiersRoundTrip(t *testing.T) {
	raw := id.New()
	if got := customers.IDFrom(raw); got.ID() != raw {
		t.Errorf("IDFrom lost the value: %s", got)
	}

	customerID := customers.NewID()
	parsed, err := customers.ParseID(customerID.String())
	if err != nil || parsed != customerID {
		t.Errorf("ParseID(%s) = %s, %v", customerID, parsed, err)
	}

	for _, text := range []string{"", "not-an-identifier", "42"} {
		if _, err := customers.ParseID(text); err == nil {
			t.Errorf("ParseID(%q) was accepted", text)
		}
	}
}

// The zero identifier is how a cash sale says it names nobody, so it has to
// report itself as zero rather than as a customer who does not exist.
func TestTheZeroCustomerIsZero(t *testing.T) {
	if !(customers.ID{}).IsZero() {
		t.Error("the zero customer identifier does not report itself as zero")
	}
	if customers.NewID().IsZero() {
		t.Error("a fresh customer identifier is zero")
	}
}

// Two draws never collide, which is what lets a device create a customer
// offline without asking the server for an identifier (ADR-011).
func TestCustomerIdentifiersAreDistinct(t *testing.T) {
	seen := make(map[customers.ID]struct{}, 1_000)
	for range 1_000 {
		drawn := customers.NewID()
		if _, repeated := seen[drawn]; repeated {
			t.Fatalf("%s was drawn twice", drawn)
		}
		seen[drawn] = struct{}{}
	}
}
