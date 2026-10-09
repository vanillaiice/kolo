package purchases_test

import (
	"errors"
	"math"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/purchases"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

var (
	arrivedAt  = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	recordedAt = time.Date(2026, 8, 14, 10, 30, 0, 0, time.UTC)
)

type delivery struct {
	businessID business.ID
	supplierID suppliers.ID
	productA   products.ID
	productB   products.ID
	userID     users.ID
	deviceID   devices.ID
}

func newDelivery() *delivery {
	return &delivery{
		businessID: business.NewID(),
		supplierID: suppliers.NewID(),
		productA:   products.NewID(),
		productB:   products.NewID(),
		userID:     users.NewID(),
		deviceID:   devices.NewID(),
	}
}

// §15's worked example: 20 × A at 400 and 10 × B at 250 comes to 10,500.
func (d *delivery) snapshot() purchases.Snapshot {
	return purchases.Snapshot{
		ID:         purchases.NewID(),
		BusinessID: d.businessID,
		SupplierID: d.supplierID,
		Items: []purchases.ItemSnapshot{
			{
				ID:        purchases.NewItemID(),
				ProductID: d.productA,
				UnitCost:  money.FromXAF(400),
				Quantity:  quantity.MustFromUnits(20),
			},
			{
				ID:        purchases.NewItemID(),
				ProductID: d.productB,
				UnitCost:  money.FromXAF(250),
				Quantity:  quantity.MustFromUnits(10),
			},
		},
		UserID:     d.userID,
		DeviceID:   d.deviceID,
		OccurredAt: arrivedAt,
		RecordedAt: recordedAt,
	}
}

func (d *delivery) purchase(t *testing.T, mutate ...func(*purchases.Snapshot)) *purchases.Purchase {
	t.Helper()

	snapshot := d.snapshot()
	for _, change := range mutate {
		change(&snapshot)
	}

	purchase, err := purchases.Record(snapshot)
	if err != nil {
		t.Fatalf("purchases.Record: %v", err)
	}
	return purchase
}

func TestTheWorkedExampleFromTheSpecification(t *testing.T) {
	d := newDelivery()
	purchase := d.purchase(t)

	total, err := purchase.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if got := total.Amount(); got != 10_500 {
		t.Errorf("total = %d, want 10500", got)
	}
	if len(purchase.Items()) != 2 {
		t.Errorf("the delivery has %d lines, want 2", len(purchase.Items()))
	}

	first := purchase.Items()[0]
	if first.ID().IsZero() || first.ProductID() != d.productA {
		t.Errorf("line 0 is %s of %s", first.ID(), first.ProductID())
	}
	if first.UnitCost().Amount() != 400 || first.Quantity().Thousandths() != 20_000 {
		t.Errorf("line 0 is %s × %s", first.UnitCost(), first.Quantity())
	}
	if first.Snapshot() != purchase.Snapshot().Items[0] {
		t.Error("a line and its snapshot disagree")
	}
}

// The arithmetic has an edge, and a delivery at it cannot be totalled rather
// than wrapping round into a bargain.
func TestADeliveryTooLargeToTotalIsRefused(t *testing.T) {
	d := newDelivery()

	// One line whose own multiplication overflows.
	huge := d.snapshot()
	huge.Items = []purchases.ItemSnapshot{{
		ID:        purchases.NewItemID(),
		ProductID: d.productA,
		UnitCost:  money.FromXAF(math.MaxInt64),
		Quantity:  quantity.MustFromUnits(2),
	}}
	purchase, err := purchases.Record(huge)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if _, err := purchase.Total(); err == nil {
		t.Error("a line of more money than there is was totalled")
	}
	// And Settle says so rather than reporting a nonsense balance.
	if _, err := purchases.Settle(purchase, money.FromXAF(1)); err == nil {
		t.Error("a purchase that cannot be totalled was settled")
	}

	// Two lines that each survive their own multiplication, whose sum does not.
	// A whole number of units multiplies by 1000/1000, so a line total is not
	// bounded below half the range and the summing overflows in its turn.
	summed := d.snapshot()
	summed.Items = []purchases.ItemSnapshot{
		{
			ID:        purchases.NewItemID(),
			ProductID: d.productA,
			UnitCost:  money.FromXAF(math.MaxInt64),
			Quantity:  quantity.MustFromUnits(1),
		},
		{
			ID:        purchases.NewItemID(),
			ProductID: d.productB,
			UnitCost:  money.FromXAF(math.MaxInt64),
			Quantity:  quantity.MustFromUnits(1),
		},
	}
	purchase, err = purchases.Record(summed)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if _, err := purchase.Total(); !errors.Is(err, money.ErrOverflow) {
		t.Errorf("totalling two lines of the largest amount there is: got %v, want ErrOverflow", err)
	}
	if _, err := purchases.Settle(purchase, money.FromXAF(1)); err == nil {
		t.Error("a purchase whose lines cannot be summed was settled")
	}
}

// §15's two cases, which are the whole reason a purchase is not an inventory
// operation: paid at the door leaves the supplier's balance untouched, and left
// owing raises it by exactly what is outstanding.
func TestAPurchasePaidAtTheDoorOwesNothing(t *testing.T) {
	d := newDelivery()
	purchase := d.purchase(t)

	settlement, err := purchases.Settle(purchase, money.FromXAF(10_500))
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}
	if !settlement.Settled() || settlement.OnCredit() {
		t.Errorf("outstanding = %s, want nothing owed", settlement.Outstanding)
	}
	if settlement.Paid.Amount() != 10_500 || settlement.Total.Amount() != 10_500 {
		t.Errorf("paid %s of %s", settlement.Paid, settlement.Total)
	}
}

func TestAPurchaseOnCreditOwesTheWholeBill(t *testing.T) {
	d := newDelivery()
	purchase := d.purchase(t)

	settlement, err := purchases.Settle(purchase, money.Money{})
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}
	if !settlement.OnCredit() || settlement.Outstanding.Amount() != 10_500 {
		t.Errorf("outstanding = %s, want the whole 10500", settlement.Outstanding)
	}
	// Nothing paid is nothing in the purchase's own currency, not an amount
	// with no currency.
	if !settlement.Paid.Valid() || !settlement.Paid.IsZero() {
		t.Errorf("paid = %s, want zero francs", settlement.Paid)
	}
}

func TestAPartlyPaidPurchaseOwesTheRest(t *testing.T) {
	d := newDelivery()
	purchase := d.purchase(t)

	settlement, err := purchases.Settle(purchase, money.FromXAF(4_000))
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}
	if settlement.Outstanding.Amount() != 6_500 {
		t.Errorf("outstanding = %s, want 6500", settlement.Outstanding)
	}
}

// What is left owing has to be owed to someone, or it could never be paid or
// reported (§16).
func TestCreditNeedsASupplier(t *testing.T) {
	d := newDelivery()

	market := d.purchase(t, func(s *purchases.Snapshot) { s.SupplierID = suppliers.ID{} })
	if _, err := purchases.Settle(market, money.Money{}); !errors.Is(err, purchases.ErrCreditNeedsSupplier) {
		t.Errorf("got %v, want ErrCreditNeedsSupplier", err)
	}

	// But a crate bought at the market and paid for on the spot names nobody,
	// and must still be recordable: refusing it would stop the stock being
	// recorded at all.
	if _, err := purchases.Settle(market, money.FromXAF(10_500)); err != nil {
		t.Errorf("a cash purchase with no supplier was refused: %v", err)
	}
}

// Paying more than the delivery came to is someone recording the wrong figure,
// and storing it would take money out of an account the business never handed
// over.
func TestAnOverpaidPurchaseIsRefused(t *testing.T) {
	d := newDelivery()
	purchase := d.purchase(t)

	if _, err := purchases.Settle(purchase, money.FromXAF(10_501)); !errors.Is(err, purchases.ErrOverpaid) {
		t.Errorf("got %v, want ErrOverpaid", err)
	}
	if _, err := purchases.Settle(purchase, money.FromXAF(-1)); !errors.Is(err, purchases.ErrInvalidCost) {
		t.Errorf("a negative payment was accepted: %v", err)
	}
	if _, err := purchases.Settle(nil, money.FromXAF(1)); !errors.Is(err, purchases.ErrInvalidID) {
		t.Errorf("got %v, want ErrInvalidID", err)
	}

	euros, err := money.New(10_500, money.EUR)
	if err != nil {
		t.Fatalf("money.New: %v", err)
	}
	if _, err := purchases.Settle(purchase, euros); !errors.Is(err, purchases.ErrCurrencyMismatch) {
		t.Errorf("a franc purchase was paid in euros: %v", err)
	}
}

// A cost is required on a purchase line, unlike a sale line: this is where a
// cost is learned, and a purchase with no cost would tell the shop nothing
// about what its stock is worth (§8).
func TestAPurchaseLineNeedsACost(t *testing.T) {
	d := newDelivery()

	for _, testCase := range []struct {
		name   string
		change func(*purchases.ItemSnapshot)
		want   error
	}{
		{"no cost", func(i *purchases.ItemSnapshot) { i.UnitCost = money.Money{} }, purchases.ErrInvalidCost},
		{"a cost below zero", func(i *purchases.ItemSnapshot) { i.UnitCost = money.FromXAF(-1) }, purchases.ErrInvalidCost},
		{"no product", func(i *purchases.ItemSnapshot) { i.ProductID = products.ID{} }, purchases.ErrInvalidID},
		{"no identifier", func(i *purchases.ItemSnapshot) { i.ID = purchases.ItemID{} }, purchases.ErrInvalidID},
		{"nothing bought", func(i *purchases.ItemSnapshot) { i.Quantity = quantity.Quantity{} }, purchases.ErrInvalidQuantity},
		{"less than nothing", func(i *purchases.ItemSnapshot) { i.Quantity = quantity.FromThousandths(-1_000) }, purchases.ErrInvalidQuantity},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot := d.snapshot()
			testCase.change(&snapshot.Items[0])
			if _, err := purchases.Record(snapshot); !errors.Is(err, testCase.want) {
				t.Errorf("got %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestAPurchaseThatCannotExistIsRefused(t *testing.T) {
	d := newDelivery()

	for _, testCase := range []struct {
		name   string
		change func(*purchases.Snapshot)
		want   error
	}{
		{"no identifier", func(s *purchases.Snapshot) { s.ID = purchases.ID{} }, purchases.ErrInvalidID},
		{"no business", func(s *purchases.Snapshot) { s.BusinessID = business.ID{} }, purchases.ErrInvalidID},
		{"no user", func(s *purchases.Snapshot) { s.UserID = users.ID{} }, purchases.ErrInvalidID},
		{"no device", func(s *purchases.Snapshot) { s.DeviceID = devices.ID{} }, purchases.ErrInvalidID},
		{"nothing bought", func(s *purchases.Snapshot) { s.Items = nil }, purchases.ErrNoItems},
		{"recorded before it arrived", func(s *purchases.Snapshot) {
			s.RecordedAt = s.OccurredAt.Add(-time.Second)
		}, validate.ErrInvalidTime},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot := d.snapshot()
			testCase.change(&snapshot)
			if _, err := purchases.Record(snapshot); !errors.Is(err, testCase.want) {
				t.Errorf("got %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestTheSameLineCannotAppearTwice(t *testing.T) {
	d := newDelivery()

	snapshot := d.snapshot()
	snapshot.Items[1].ID = snapshot.Items[0].ID
	if _, err := purchases.Record(snapshot); !errors.Is(err, purchases.ErrDuplicateItem) {
		t.Errorf("got %v, want ErrDuplicateItem", err)
	}

	// But the same product twice is ordinary: two crates at different prices in
	// one delivery.
	sameProduct := d.snapshot()
	sameProduct.Items[1].ProductID = sameProduct.Items[0].ProductID
	if _, err := purchases.Record(sameProduct); err != nil {
		t.Errorf("one product on two lines was refused: %v", err)
	}
}

func TestAPurchaseCannotMixCurrencies(t *testing.T) {
	d := newDelivery()

	euros, err := money.New(250, money.EUR)
	if err != nil {
		t.Fatalf("money.New: %v", err)
	}
	snapshot := d.snapshot()
	snapshot.Items[1].UnitCost = euros
	if _, err := purchases.Record(snapshot); !errors.Is(err, purchases.ErrCurrencyMismatch) {
		t.Errorf("got %v, want ErrCurrencyMismatch", err)
	}
}

func TestADeliveryLargerThanOneCanBeIsRefused(t *testing.T) {
	d := newDelivery()

	snapshot := d.snapshot()
	snapshot.Items = make([]purchases.ItemSnapshot, purchases.MaxItems+1)
	for i := range snapshot.Items {
		snapshot.Items[i] = purchases.ItemSnapshot{
			ID:        purchases.NewItemID(),
			ProductID: d.productA,
			UnitCost:  money.FromXAF(100),
			Quantity:  quantity.MustFromUnits(1),
		}
	}
	if _, err := purchases.Record(snapshot); !errors.Is(err, purchases.ErrTooManyItems) {
		t.Errorf("got %v, want ErrTooManyItems", err)
	}
}

func TestEverythingAPurchaseCarriesRoundTrips(t *testing.T) {
	d := newDelivery()
	branch := business.NewBranchID()

	purchase := d.purchase(t, func(s *purchases.Snapshot) {
		s.BranchID = branch
		s.Reference = "BL-4471"
		s.Note = "deux sacs abîmés"
	})

	restored, err := purchases.Restore(purchase.Snapshot())
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	before, after := purchase.Snapshot(), restored.Snapshot()
	if len(after.Items) != len(before.Items) {
		t.Fatalf("restored %d lines, want %d", len(after.Items), len(before.Items))
	}
	for i := range before.Items {
		if before.Items[i] != after.Items[i] {
			t.Errorf("line %d: %+v, want %+v", i, after.Items[i], before.Items[i])
		}
	}
	if restored.Reference() != "BL-4471" || restored.Note() != "deux sacs abîmés" {
		t.Errorf("kept %q and %q", restored.Reference(), restored.Note())
	}
	if restored.BranchID() != branch {
		t.Errorf("BranchID = %s", restored.BranchID())
	}
	if supplier, named := restored.Supplier(); !named || supplier != d.supplierID {
		t.Errorf("Supplier = %s (named: %t)", supplier, named)
	}
	if restored.ID() != purchase.ID() || restored.BusinessID() != d.businessID {
		t.Error("the purchase lost its identity")
	}
	if restored.UserID() != d.userID || restored.DeviceID() != d.deviceID {
		t.Error("the purchase lost who recorded it")
	}
	if !restored.OccurredAt().Equal(arrivedAt) || !restored.RecordedAt().Equal(recordedAt) {
		t.Error("the purchase lost when the stock arrived")
	}
	if restored.Scope() != purchase.Scope() {
		t.Errorf("Scope = %v", restored.Scope())
	}
}

// The lines are handed out as a copy: a purchase is immutable, and handing out
// the slice would let a caller edit one.
func TestTheLinesCannotBeEditedFromOutside(t *testing.T) {
	d := newDelivery()
	purchase := d.purchase(t)

	lines := purchase.Items()
	lines[0] = purchases.Item{}
	if purchase.Items()[0].ProductID() != d.productA {
		t.Error("editing the returned slice changed the purchase")
	}
}

// A line is priced by the same arithmetic a sale line is, because the two are
// compared whenever anyone asks what a shop made.
func TestALineIsPricedByTheSameArithmeticAsASale(t *testing.T) {
	d := newDelivery()

	for _, testCase := range []struct {
		cost     int64
		quantity int64
		want     int64
	}{
		{400, 20_000, 8_000},
		{1_000, 500, 500}, // half a unit
		{100, 5, 1},       // 0.5 rounds away from zero
		{100, 4, 0},       // 0.4 rounds down
		{3, 333, 1},       // 0.999
	} {
		snapshot := d.snapshot()
		snapshot.Items = []purchases.ItemSnapshot{{
			ID:        purchases.NewItemID(),
			ProductID: d.productA,
			UnitCost:  money.FromXAF(testCase.cost),
			Quantity:  quantity.FromThousandths(testCase.quantity),
		}}
		purchase, err := purchases.Record(snapshot)
		if err != nil {
			t.Fatalf("Record: %v", err)
		}
		total, err := purchase.Total()
		if err != nil {
			t.Fatalf("Total: %v", err)
		}
		if total.Amount() != testCase.want {
			t.Errorf("%d × %d/1000 = %d, want %d",
				testCase.cost, testCase.quantity, total.Amount(), testCase.want)
		}
	}
}

func TestPurchaseIdentifiers(t *testing.T) {
	raw := purchases.NewID()
	if parsed, err := purchases.ParseID(raw.String()); err != nil || parsed != raw {
		t.Errorf("ParseID round trip: %s, %v", parsed, err)
	}
	if purchases.IDFrom(raw.ID()) != raw {
		t.Error("IDFrom did not return the same identifier")
	}
	if _, err := purchases.ParseID("not-an-identifier"); err == nil {
		t.Error("a malformed purchase identifier parsed")
	}

	rawItem := purchases.NewItemID()
	if parsed, err := purchases.ParseItemID(rawItem.String()); err != nil || parsed != rawItem {
		t.Errorf("ParseItemID round trip: %s, %v", parsed, err)
	}
	if purchases.ItemIDFrom(rawItem.ID()) != rawItem {
		t.Error("ItemIDFrom did not return the same identifier")
	}
	if _, err := purchases.ParseItemID("not-an-identifier"); err == nil {
		t.Error("a malformed item identifier parsed")
	}
}
