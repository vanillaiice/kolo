package sales_test

import (
	"errors"
	"math"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

// Every accessor returns what was put in. Written as one test because a wrong
// accessor is a silent mix-up — a sale reporting its device as its user — and
// the only way to catch it is to check each against a distinct value.
func TestASaleReportsWhatItWasGiven(t *testing.T) {
	input := snapshot(func(s *sales.Snapshot) {
		s.BranchID = business.NewBranchID()
		s.CustomerID = customers.NewID()
		s.Note = "livraison samedi"
		s.Discount = money.FromXAF(500)
		s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
			i.Quantity = quantity.MustParse("2.5")
			i.Discount = money.FromXAF(100)
			i.TaxRateBasisPoints = 1_925
			i.UnitCost = money.FromXAF(5_000)
		})}
	})
	sale := mustRecord(t, input)

	if sale.ID() != input.ID {
		t.Errorf("ID = %s, want %s", sale.ID(), input.ID)
	}
	if sale.BusinessID() != input.BusinessID {
		t.Errorf("BusinessID = %s, want %s", sale.BusinessID(), input.BusinessID)
	}
	if sale.BranchID() != input.BranchID {
		t.Errorf("BranchID = %s, want %s", sale.BranchID(), input.BranchID)
	}
	if customer, named := sale.Customer(); !named || customer != input.CustomerID {
		t.Errorf("Customer = %s/%v, want %s/true", customer, named, input.CustomerID)
	}
	if sale.Number() != input.Number {
		t.Errorf("Number = %q, want %q", sale.Number(), input.Number)
	}
	if sale.Discount() != input.Discount {
		t.Errorf("Discount = %s, want %s", sale.Discount(), input.Discount)
	}
	if sale.Note() != input.Note {
		t.Errorf("Note = %q, want %q", sale.Note(), input.Note)
	}
	if sale.UserID() != input.UserID {
		t.Errorf("UserID = %s, want %s", sale.UserID(), input.UserID)
	}
	if sale.DeviceID() != input.DeviceID {
		t.Errorf("DeviceID = %s, want %s", sale.DeviceID(), input.DeviceID)
	}
	if !sale.OccurredAt().Equal(input.OccurredAt) {
		t.Errorf("OccurredAt = %s, want %s", sale.OccurredAt(), input.OccurredAt)
	}
	if !sale.RecordedAt().Equal(input.RecordedAt) {
		t.Errorf("RecordedAt = %s, want %s", sale.RecordedAt(), input.RecordedAt)
	}
	if scope := sale.Scope(); scope.Business() != input.BusinessID {
		t.Errorf("Scope business = %s, want %s", scope.Business(), input.BusinessID)
	}

	item, want := sale.Items()[0], input.Items[0]
	if item.ID() != want.ID {
		t.Errorf("item ID = %s, want %s", item.ID(), want.ID)
	}
	if item.ProductID() != want.ProductID {
		t.Errorf("ProductID = %s, want %s", item.ProductID(), want.ProductID)
	}
	if item.Name() != want.Name {
		t.Errorf("Name = %q, want %q", item.Name(), want.Name)
	}
	if item.UnitPrice() != want.UnitPrice {
		t.Errorf("UnitPrice = %s, want %s", item.UnitPrice(), want.UnitPrice)
	}
	if item.Quantity() != want.Quantity {
		t.Errorf("Quantity = %s, want %s", item.Quantity(), want.Quantity)
	}
	if item.Discount() != want.Discount {
		t.Errorf("Discount = %s, want %s", item.Discount(), want.Discount)
	}
	if item.TaxRateBasisPoints() != want.TaxRateBasisPoints {
		t.Errorf("TaxRateBasisPoints = %d, want %d", item.TaxRateBasisPoints(), want.TaxRateBasisPoints)
	}
	if cost, known := item.UnitCost(); !known || cost != want.UnitCost {
		t.Errorf("UnitCost = %s/%v, want %s/true", cost, known, want.UnitCost)
	}
}

// A cash sale names no customer, and says so.
func TestACashSaleNamesNoCustomer(t *testing.T) {
	sale := mustRecord(t, snapshot())

	if customer, named := sale.Customer(); named {
		t.Errorf("Customer = %s, want none", customer)
	}
}

// A product with no recorded cost reports none, rather than zero — a zero cost
// would report the whole sale as profit (§6).
func TestALineWithNoCostReportsNone(t *testing.T) {
	sale := mustRecord(t, snapshot())

	if cost, known := sale.Items()[0].UnitCost(); known {
		t.Errorf("UnitCost = %s, want unknown", cost)
	}
	if cost, known, err := sale.Items()[0].Cost(); err != nil || known {
		t.Errorf("Cost = %s/%v/%v, want unknown", cost, known, err)
	}
}

func TestAPaymentReportsWhatItWasGiven(t *testing.T) {
	sale := saleOf(t, 5_000)
	branch := business.NewBranchID()
	account := finance.NewAccountID()

	payment := paidWith(t, sale, 5_000, func(p *sales.PaymentSnapshot) {
		p.BranchID = branch
		p.AccountID = account
		p.Reference = "MP260814.0930.A12345"
		p.Note = "payé par le fils"
	})

	if payment.SaleID() != sale.ID() {
		t.Errorf("SaleID = %s, want %s", payment.SaleID(), sale.ID())
	}
	if payment.BusinessID() != sale.BusinessID() {
		t.Errorf("BusinessID = %s, want %s", payment.BusinessID(), sale.BusinessID())
	}
	if payment.BranchID() != branch {
		t.Errorf("BranchID = %s, want %s", payment.BranchID(), branch)
	}
	if payment.AccountID() != account {
		t.Errorf("AccountID = %s, want %s", payment.AccountID(), account)
	}
	if payment.Amount().Amount() != 5_000 {
		t.Errorf("Amount = %s, want 5000 XAF", payment.Amount())
	}
	if payment.Note() != "payé par le fils" {
		t.Errorf("Note = %q", payment.Note())
	}
	if payment.UserID() != sale.UserID() {
		t.Errorf("UserID = %s, want %s", payment.UserID(), sale.UserID())
	}
	if payment.DeviceID() != sale.DeviceID() {
		t.Errorf("DeviceID = %s, want %s", payment.DeviceID(), sale.DeviceID())
	}
	if !payment.OccurredAt().Equal(soldAt) {
		t.Errorf("OccurredAt = %s, want %s", payment.OccurredAt(), soldAt)
	}
	if !payment.RecordedAt().Equal(recordedAt) {
		t.Errorf("RecordedAt = %s, want %s", payment.RecordedAt(), recordedAt)
	}
	if payment.ID().IsZero() {
		t.Error("ID is zero")
	}
}

// Identifiers round-trip through text and through a generator, which is what
// the sync boundary and the deterministic test generators need.
func TestIdentifiersRoundTrip(t *testing.T) {
	raw := id.New()

	if got := sales.IDFrom(raw); got.ID() != raw {
		t.Errorf("IDFrom lost the value: %s", got)
	}
	if got := sales.ItemIDFrom(raw); got.ID() != raw {
		t.Errorf("ItemIDFrom lost the value: %s", got)
	}
	if got := sales.PaymentIDFrom(raw); got.ID() != raw {
		t.Errorf("PaymentIDFrom lost the value: %s", got)
	}

	saleID := sales.NewID()
	parsed, err := sales.ParseID(saleID.String())
	if err != nil || parsed != saleID {
		t.Errorf("ParseID(%s) = %s, %v", saleID, parsed, err)
	}
	itemID := sales.NewItemID()
	parsedItem, err := sales.ParseItemID(itemID.String())
	if err != nil || parsedItem != itemID {
		t.Errorf("ParseItemID(%s) = %s, %v", itemID, parsedItem, err)
	}
	paymentID := sales.NewPaymentID()
	parsedPayment, err := sales.ParsePaymentID(paymentID.String())
	if err != nil || parsedPayment != paymentID {
		t.Errorf("ParsePaymentID(%s) = %s, %v", paymentID, parsedPayment, err)
	}

	for _, text := range []string{"", "not-an-identifier", "12345"} {
		if _, err := sales.ParseID(text); err == nil {
			t.Errorf("ParseID(%q) was accepted", text)
		}
		if _, err := sales.ParseItemID(text); err == nil {
			t.Errorf("ParseItemID(%q) was accepted", text)
		}
		if _, err := sales.ParsePaymentID(text); err == nil {
			t.Errorf("ParsePaymentID(%q) was accepted", text)
		}
	}
}

// Arithmetic that cannot fit in the money type is reported rather than wrapped
// around. A wrapped total would be a bill for a negative amount.
func TestOverflowIsRefusedRatherThanWrapped(t *testing.T) {
	huge := money.FromXAF(math.MaxInt64)

	t.Run("a line that overflows", func(t *testing.T) {
		_, err := sales.Record(snapshot(func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				i.UnitPrice = huge
				i.Quantity = quantity.MustFromUnits(1_000)
			})}
		}))
		if err == nil {
			t.Error("a line that cannot be totalled was accepted")
		}
	})

	t.Run("a sale whose lines overflow together", func(t *testing.T) {
		_, err := sales.Record(snapshot(func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{
				line(func(i *sales.ItemSnapshot) { i.UnitPrice = huge }),
				line(func(i *sales.ItemSnapshot) { i.UnitPrice = huge }),
			}
		}))
		if err == nil {
			t.Error("a sale whose lines cannot be added was accepted")
		}
	})

	t.Run("a cost that overflows", func(t *testing.T) {
		sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				i.UnitPrice = money.FromXAF(1)
				i.Quantity = quantity.MustFromUnits(1_000)
				i.UnitCost = huge
			})}
		}))

		if _, _, err := sale.Items()[0].Cost(); err == nil {
			t.Error("a cost that cannot be worked out was reported as a number")
		}
		if _, _, err := sale.Items()[0].Profit(); err == nil {
			t.Error("a profit that cannot be worked out was reported as a number")
		}
	})

	t.Run("payments that overflow together", func(t *testing.T) {
		sale := saleOf(t, 5_000)
		_, err := sales.Settle(sale, []*sales.Payment{
			paidWith(t, sale, math.MaxInt64),
			paidWith(t, sale, math.MaxInt64),
		})
		if err == nil {
			t.Error("payments that cannot be added were accepted")
		}
	})
}

// A sale needs a number a person can read off a receipt.
func TestASaleNeedsAReadableNumber(t *testing.T) {
	for _, number := range []string{"", "   ", "\t\n"} {
		if _, err := sales.Record(snapshot(func(s *sales.Snapshot) { s.Number = number })); err == nil {
			t.Errorf("a sale numbered %q was accepted", number)
		}
	}
}

// A profit whose total cannot be worked out is reported as an error, not as a
// zero profit.
func TestProfitPropagatesAFailureToTotal(t *testing.T) {
	var empty sales.Item
	if _, known, err := empty.Profit(); known || err != nil {
		t.Errorf("the zero item reported profit = %v, err = %v; want unknown", known, err)
	}
}

// Restoring a stored sale applies the same rules as recording a new one, so a
// row written by an older build or synced from another device is not trusted.
func TestRestoreRefusesWhatRecordWould(t *testing.T) {
	stored := snapshot(func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{{
			ID:        sales.NewItemID(),
			ProductID: products.NewID(),
			Name:      "Riz",
			UnitPrice: money.FromXAF(100),
			Quantity:  quantity.FromThousandths(-1),
		}}
	})

	_, err := sales.Restore(stored)
	if !errors.Is(err, sales.ErrInvalidQuantity) {
		t.Errorf("err = %v, want ErrInvalidQuantity", err)
	}
}

// The zero Sale totals to an error rather than to zero francs. A sale with no
// currency is not a free sale, and reporting one as zero would put it in the
// day's takings.
func TestTheZeroSaleDoesNotTotalToZero(t *testing.T) {
	var empty sales.Sale

	if total, err := empty.Subtotal(); err == nil && total.Valid() {
		t.Errorf("Subtotal = %s, want a refusal", total)
	}
	if total, err := empty.Total(); err == nil {
		t.Errorf("Total = %s, want a refusal", total)
	}
	if _, named := empty.Customer(); named {
		t.Error("the zero sale named a customer")
	}
	if items := empty.Items(); len(items) != 0 {
		t.Errorf("the zero sale has %d items", len(items))
	}
	// A scope with no business permits nothing, which is the fail-closed rule
	// every total form here follows (ADR-008).
	if empty.Scope().Valid() {
		t.Error("the zero sale produced a usable scope")
	}
}

// Settling a sale that cannot be totalled reports that, rather than reporting a
// settlement worked out from a broken number.
func TestSettlingAnUntotallableSaleFails(t *testing.T) {
	var empty sales.Sale

	if _, err := sales.Settle(&empty, nil); err == nil {
		t.Error("a sale that cannot be totalled was settled")
	}
}
