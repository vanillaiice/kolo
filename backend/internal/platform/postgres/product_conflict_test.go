package postgres_test

import (
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// edit builds one device's version of the same product.
//
// Same identifier, different price, different moment: two people editing the
// same rice on two tills, which is what a conflict actually looks like.
func (f *applyFixture) edit(
	t *testing.T, productID products.ID, price int64, at time.Time, device devices.ID,
) *products.Product {
	t.Helper()

	product, err := products.Restore(products.Snapshot{
		ID:              productID,
		BusinessID:      f.tenant,
		Name:            "Riz parfumé 5kg",
		Unit:            "sac",
		SellingPrice:    money.FromXAF(price),
		Active:          true,
		UpdatedByDevice: device,
		CreatedAt:       registered,
		UpdatedAt:       at,
	})
	if err != nil {
		t.Fatalf("products.Restore: %v", err)
	}
	return product
}

// apply pushes one product edit through the event path.
func (f *applyFixture) apply(t *testing.T, sequence int64, product *products.Product) {
	t.Helper()

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, sequence),
		postgres.Effects{Products: []*products.Product{product}}); err != nil {
		t.Fatalf("RecordAndApply: %v", err)
	}
}

// price reads back what the product now costs, in whole francs.
func (f *applyFixture) price(t *testing.T, productID products.ID) int64 {
	t.Helper()

	stored, err := postgres.NewProductRepository(f.pool).Get(f.ctx, f.scope, productID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	return stored.SellingPrice().Amount()
}

var (
	// registered is before both edits: a product exists before it is edited.
	registered = time.Date(2026, 8, 1, 8, 0, 0, 0, time.UTC)
	earlier    = time.Date(2026, 8, 14, 9, 0, 0, 0, time.UTC)
	later      = time.Date(2026, 8, 14, 17, 0, 0, 0, time.UTC)
)

// The ordinary case: a newer edit replaces an older one.
func TestTheNewerProductEditWins(t *testing.T) {
	f := newApplyFixture(t)
	id := products.NewID()

	f.apply(t, 1, f.edit(t, id, 6_500, earlier, f.till))
	f.apply(t, 2, f.edit(t, id, 7_000, later, f.phone))

	if got := f.price(t, id); got != 7_000 {
		t.Errorf("price = %d, want the newer 7000", got)
	}
}

// The case the ordering exists for: the same two edits arriving the other way
// round must give the same answer. A device that syncs weekly sees events in a
// different order from one that syncs hourly, and they must still agree.
func TestAnOlderEditArrivingLastDoesNotWin(t *testing.T) {
	f := newApplyFixture(t)
	id := products.NewID()

	f.apply(t, 1, f.edit(t, id, 7_000, later, f.phone))
	f.apply(t, 2, f.edit(t, id, 6_500, earlier, f.till))

	if got := f.price(t, id); got != 7_000 {
		t.Errorf("price = %d, want the newer 7000 to survive a late arrival", got)
	}
}

// Two edits stamped the same instant. Without a tie-break the answer would
// depend on arrival order, and two devices holding the same two edits would
// settle on different prices — permanently, and with nothing to detect it.
func TestASimultaneousEditIsBrokenTheSameWayWhicheverArrivesFirst(t *testing.T) {
	first, second := newApplyFixture(t), newApplyFixture(t)

	// The two fixtures have different devices, so the comparison is made
	// against whichever identifier each drew. Both orders must agree with each
	// other, which is the property, rather than with a fixed expectation.
	id := products.NewID()
	high, low := first.till, first.phone
	if high.String() < low.String() {
		high, low = low, high
	}

	first.apply(t, 1, first.edit(t, id, 6_500, earlier, low))
	first.apply(t, 2, first.edit(t, id, 7_000, earlier, high))

	otherID := products.NewID()
	second.apply(t, 1, second.edit(t, otherID, 7_000, earlier, high))
	second.apply(t, 2, second.edit(t, otherID, 6_500, earlier, low))

	forwards, backwards := first.price(t, id), second.price(t, otherID)
	if forwards != backwards {
		t.Errorf("the same two edits gave %d one way and %d the other, so devices diverge",
			forwards, backwards)
	}
	// And the winner is the higher device, which is arbitrary but fixed.
	if forwards != 7_000 {
		t.Errorf("price = %d, want the higher device's 7000", forwards)
	}
}

// A losing edit is discarded rather than reported. It lost; there is nothing
// the caller can do about it, and an error would make an ordinary sync failure.
func TestALosingEditIsNotAnError(t *testing.T) {
	f := newApplyFixture(t)
	id := products.NewID()

	f.apply(t, 1, f.edit(t, id, 7_000, later, f.till))

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 2),
		postgres.Effects{Products: []*products.Product{f.edit(t, id, 6_500, earlier, f.phone)}}); err != nil {
		t.Fatalf("a losing edit was reported as a failure: %v", err)
	}
	if got := f.price(t, id); got != 7_000 {
		t.Errorf("price = %d, want 7000", got)
	}
}

// The event is still recorded and relayed even when its edit lost. Other
// devices need to see that the edit happened, and each decides for itself.
func TestAnEventWhoseEditLostIsStillRelayed(t *testing.T) {
	f := newApplyFixture(t)
	id := products.NewID()

	f.apply(t, 1, f.edit(t, id, 7_000, later, f.till))
	f.apply(t, 2, f.edit(t, id, 6_500, earlier, f.phone))

	stored, err := f.events.Since(f.ctx, f.scope, 0, devices.ID{}, 10)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(stored) != 2 {
		t.Errorf("the log holds %d events, want both", len(stored))
	}
}

// Applying the same edit twice is the same as applying it once, so a replayed
// event cannot disturb a product a newer edit has since won.
func TestReapplyingTheSameEditChangesNothing(t *testing.T) {
	f := newApplyFixture(t)
	id := products.NewID()

	same := f.edit(t, id, 6_500, earlier, f.till)
	f.apply(t, 1, same)
	f.apply(t, 2, same)
	f.apply(t, 3, f.edit(t, id, 7_000, later, f.phone))
	f.apply(t, 4, same)

	if got := f.price(t, id); got != 7_000 {
		t.Errorf("price = %d, want 7000: a replay undid a newer edit", got)
	}
}

// A product arriving for the first time is created, not merely compared
// against nothing.
func TestAProductArrivingForTheFirstTimeIsCreated(t *testing.T) {
	f := newApplyFixture(t)
	id := products.NewID()

	f.apply(t, 1, f.edit(t, id, 6_500, earlier, f.till))

	if got := f.price(t, id); got != 6_500 {
		t.Errorf("price = %d, want 6500", got)
	}
}

// A product edit cannot be used to move a product into another tenant. The
// business is not in the SET list, and the scope refuses it before that anyway.
func TestAProductEditCannotChangeItsBusiness(t *testing.T) {
	f := newApplyFixture(t)

	stranger := newApplyFixture(t)
	id := products.NewID()
	f.apply(t, 1, f.edit(t, id, 6_500, earlier, f.till))

	// The other tenant tries to claim it, with a newer timestamp so it would
	// otherwise win.
	if _, err := f.events.RecordAndApply(stranger.ctx, stranger.scope, stranger.event(t, 1),
		postgres.Effects{Products: []*products.Product{f.edit(t, id, 99_000, later, f.till)}}); err == nil {
		t.Fatal("a product edit for another business was accepted")
	}
	if got := f.price(t, id); got != 6_500 {
		t.Errorf("price = %d, want the original 6500", got)
	}
}
