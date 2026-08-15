package sales_test

import (
	"errors"
	"math/big"
	"reflect"
	"testing"
	"testing/quick"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

var (
	soldAt     = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	recordedAt = time.Date(2026, 8, 14, 10, 30, 0, 0, time.UTC)
)

// line builds one sale line, defaulting everything a test does not care about.
func line(mutate ...func(*sales.ItemSnapshot)) sales.ItemSnapshot {
	item := sales.ItemSnapshot{
		ID:        sales.NewItemID(),
		ProductID: products.NewID(),
		Name:      "Riz parfumé 5kg",
		UnitPrice: money.FromXAF(6_500),
		Quantity:  quantity.MustFromUnits(1),
	}
	for _, change := range mutate {
		change(&item)
	}
	return item
}

// snapshot builds a whole sale, defaulting to one line of one bag of rice.
func snapshot(mutate ...func(*sales.Snapshot)) sales.Snapshot {
	sale := sales.Snapshot{
		ID:         sales.NewID(),
		BusinessID: business.NewID(),
		Number:     "V-000123",
		Items:      []sales.ItemSnapshot{line()},
		UserID:     users.NewID(),
		DeviceID:   devices.NewID(),
		OccurredAt: soldAt,
		RecordedAt: recordedAt,
	}
	for _, change := range mutate {
		change(&sale)
	}
	return sale
}

func mustRecord(t *testing.T, snapshot sales.Snapshot) *sales.Sale {
	t.Helper()
	sale, err := sales.Record(snapshot)
	if err != nil {
		t.Fatalf("sales.Record: %v", err)
	}
	return sale
}

func TestASaleTotalsItsLines(t *testing.T) {
	sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{
			line(func(i *sales.ItemSnapshot) {
				i.UnitPrice = money.FromXAF(6_500)
				i.Quantity = quantity.MustFromUnits(2)
			}),
			line(func(i *sales.ItemSnapshot) {
				i.UnitPrice = money.FromXAF(900)
				i.Quantity = quantity.MustFromUnits(3)
			}),
		}
	}))

	total, err := sale.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if got := total.Amount(); got != 15_700 {
		t.Errorf("total = %d, want 13000 + 2700", got)
	}
}

// Half a kilo of rice at 1,000 a kilo is 500, not 1,000 and not zero. This is
// the reason quantity is thousandths and the multiplication is a ratio.
func TestAFractionalQuantityIsPricedProportionally(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		quantity quantity.Quantity
		want     int64
	}{
		{"half a kilo", quantity.MustParse("0.5"), 500},
		{"a quarter", quantity.MustParse("0.25"), 250},
		{"a tenth", quantity.MustParse("0.1"), 100},
		{"one and a half", quantity.MustParse("1.5"), 1_500},
		{"a thousandth", quantity.MustParse("0.001"), 1},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
				s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
					i.UnitPrice = money.FromXAF(1_000)
					i.Quantity = testCase.quantity
				})}
			}))

			total, err := sale.Total()
			if err != nil {
				t.Fatalf("Total: %v", err)
			}
			if got := total.Amount(); got != testCase.want {
				t.Errorf("total = %d, want %d", got, testCase.want)
			}
		})
	}
}

// XAF has no subunit, so a price that does not divide evenly has to land on a
// whole franc. It rounds half up, which is what a shopkeeper doing it by hand
// expects.
func TestAPriceThatDoesNotDivideEvenlyRoundsHalfUp(t *testing.T) {
	for _, testCase := range []struct {
		name          string
		price, amount int64
		want          int64
	}{
		{"just below a half", 100, 4, 0},    // 0.4 → 0
		{"exactly a half", 100, 5, 1},       // 0.5 → 1, away from zero
		{"just above a half", 100, 6, 1},    // 0.6 → 1
		{"a third of three", 3, 333, 1},     // 0.999 → 1
		{"seven at a third", 7, 333, 2},     // 2.331 → 2
		{"a large price", 999_999, 1, 1000}, // 999.999 → 1000
	} {
		t.Run(testCase.name, func(t *testing.T) {
			sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
				s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
					i.UnitPrice = money.FromXAF(testCase.price)
					i.Quantity = quantity.FromThousandths(testCase.amount)
				})}
			}))

			total, err := sale.Total()
			if err != nil {
				t.Fatalf("Total: %v", err)
			}
			if got := total.Amount(); got != testCase.want {
				t.Errorf("%d × %d/1000 = %d, want %d", testCase.price, testCase.amount, got, testCase.want)
			}
		})
	}
}

// An oracle built a different way: exact rational arithmetic, rounded half up
// at the end. If the integer implementation and this disagree, one of them is
// wrong about a shopkeeper's money.
func TestLineTotalsAgreeWithExactArithmetic(t *testing.T) {
	check := func(price uint32, thousandths uint32) bool {
		amount := int64(thousandths%1_000_000) + 1
		unitPrice := money.FromXAF(int64(price % 10_000_000))

		sale, err := sales.Record(snapshot(func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				i.UnitPrice = unitPrice
				i.Quantity = quantity.FromThousandths(amount)
			})}
		}))
		if err != nil {
			return false
		}
		total, err := sale.Total()
		if err != nil {
			return false
		}

		// price × quantity / 1000, exactly, then rounded half away from zero.
		exact := new(big.Rat).SetFrac(
			new(big.Int).Mul(big.NewInt(unitPrice.Amount()), big.NewInt(amount)),
			big.NewInt(1_000),
		)
		half := big.NewRat(1, 2)
		rounded := new(big.Rat).Add(exact, half)
		want := new(big.Int).Div(rounded.Num(), rounded.Denom())

		return want.Int64() == total.Amount()
	}

	if err := quick.Check(check, &quick.Config{MaxCount: 2_000}); err != nil {
		t.Error(err)
	}
}

func TestADiscountComesOffTheLine(t *testing.T) {
	sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
			i.UnitPrice = money.FromXAF(6_500)
			i.Quantity = quantity.MustFromUnits(2)
			i.Discount = money.FromXAF(1_000)
		})}
	}))

	total, err := sale.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if got := total.Amount(); got != 12_000 {
		t.Errorf("total = %d, want 13000 − 1000", got)
	}
}

// A discount on the bill and a discount on a line are different things a
// shopkeeper does, and both must survive.
func TestASaleDiscountComesOffAfterTheLines(t *testing.T) {
	sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
			i.UnitPrice = money.FromXAF(10_000)
			i.Discount = money.FromXAF(1_000)
		})}
		s.Discount = money.FromXAF(500)
	}))

	subtotal, err := sale.Subtotal()
	if err != nil {
		t.Fatalf("Subtotal: %v", err)
	}
	total, err := sale.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}

	if got := subtotal.Amount(); got != 9_000 {
		t.Errorf("subtotal = %d, want 10000 − 1000", got)
	}
	if got := total.Amount(); got != 8_500 {
		t.Errorf("total = %d, want 9000 − 500", got)
	}
}

// A discount larger than what it comes off would make the shop pay the
// customer. If that is meant, it is a refund, which is a different transaction.
func TestADiscountCannotExceedWhatItComesOff(t *testing.T) {
	t.Run("on a line", func(t *testing.T) {
		_, err := sales.Record(snapshot(func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				i.UnitPrice = money.FromXAF(1_000)
				i.Discount = money.FromXAF(1_001)
			})}
		}))
		if !errors.Is(err, sales.ErrInvalidDiscount) {
			t.Errorf("err = %v, want ErrInvalidDiscount", err)
		}
	})

	t.Run("on the sale", func(t *testing.T) {
		_, err := sales.Record(snapshot(func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				i.UnitPrice = money.FromXAF(1_000)
			})}
			s.Discount = money.FromXAF(1_001)
		}))
		if !errors.Is(err, sales.ErrInvalidDiscount) {
			t.Errorf("err = %v, want ErrInvalidDiscount", err)
		}
	})
}

// A discount of exactly the total is a giveaway, which a shop does do.
func TestADiscountMayBeTheWholeAmount(t *testing.T) {
	sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
			i.UnitPrice = money.FromXAF(1_000)
		})}
		s.Discount = money.FromXAF(1_000)
	}))

	total, err := sale.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if !total.IsZero() {
		t.Errorf("total = %s, want zero", total)
	}
}

func TestASaleIsRefusedWithoutWhatItNeeds(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		mutate func(*sales.Snapshot)
		want   error
	}{
		{"no identifier", func(s *sales.Snapshot) { s.ID = sales.ID{} }, sales.ErrInvalidID},
		{"no business", func(s *sales.Snapshot) { s.BusinessID = business.ID{} }, sales.ErrInvalidID},
		{"no user", func(s *sales.Snapshot) { s.UserID = users.ID{} }, sales.ErrInvalidID},
		{"no device", func(s *sales.Snapshot) { s.DeviceID = devices.ID{} }, sales.ErrInvalidID},
		{"no items", func(s *sales.Snapshot) { s.Items = nil }, sales.ErrNoItems},
		{"an empty item list", func(s *sales.Snapshot) { s.Items = []sales.ItemSnapshot{} }, sales.ErrNoItems},
		{"no item identifier", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) { i.ID = sales.ItemID{} })}
		}, sales.ErrInvalidID},
		{"no product", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) { i.ProductID = products.ID{} })}
		}, sales.ErrInvalidID},
		{"no item name", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) { i.Name = "" })}
		}, sales.ErrInvalidID},
		{"no price", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) { i.UnitPrice = money.Money{} })}
		}, sales.ErrInvalidPrice},
		{"a negative price", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				i.UnitPrice = money.FromXAF(-1)
			})}
		}, sales.ErrInvalidPrice},
		{"a quantity of nothing", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				i.Quantity = quantity.Quantity{}
			})}
		}, sales.ErrInvalidQuantity},
		{"a negative quantity", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				i.Quantity = quantity.FromThousandths(-1_000)
			})}
		}, sales.ErrInvalidQuantity},
		{"a negative line discount", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				i.Discount = money.FromXAF(-1)
			})}
		}, sales.ErrInvalidDiscount},
		{"a negative sale discount", func(s *sales.Snapshot) { s.Discount = money.FromXAF(-1) },
			sales.ErrInvalidDiscount},
		{"a tax rate below zero", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) { i.TaxRateBasisPoints = -1 })}
		}, sales.ErrInvalidPrice},
		{"a tax rate above everything", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) { i.TaxRateBasisPoints = 10_001 })}
		}, sales.ErrInvalidPrice},
		{"a negative cost", func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				i.UnitCost = money.FromXAF(-1)
			})}
		}, sales.ErrInvalidPrice},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := sales.Record(snapshot(testCase.mutate))
			if !errors.Is(err, testCase.want) {
				t.Errorf("err = %v, want %v", err, testCase.want)
			}
		})
	}
}

// The same line twice is a bug in whatever built the cart, and would double a
// customer's bill silently.
func TestTheSameLineCannotAppearTwice(t *testing.T) {
	repeated := line()
	_, err := sales.Record(snapshot(func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{repeated, repeated}
	}))
	if !errors.Is(err, sales.ErrDuplicateItem) {
		t.Errorf("err = %v, want ErrDuplicateItem", err)
	}
}

// The same product on two lines is ordinary: a crate at one price and a loose
// one at another.
func TestTheSameProductMayAppearOnTwoLines(t *testing.T) {
	productID := products.NewID()
	sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{
			line(func(i *sales.ItemSnapshot) {
				i.ProductID = productID
				i.UnitPrice = money.FromXAF(6_000)
			}),
			line(func(i *sales.ItemSnapshot) {
				i.ProductID = productID
				i.UnitPrice = money.FromXAF(6_500)
			}),
		}
	}))

	total, err := sale.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if got := total.Amount(); got != 12_500 {
		t.Errorf("total = %d, want both lines", got)
	}
}

func TestASaleCannotMixCurrencies(t *testing.T) {
	t.Run("across lines", func(t *testing.T) {
		_, err := sales.Record(snapshot(func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{
				line(func(i *sales.ItemSnapshot) { i.UnitPrice = money.FromXAF(1_000) }),
				line(func(i *sales.ItemSnapshot) {
					euros, _ := money.New(1_000, money.EUR)
					i.UnitPrice = euros
				}),
			}
		}))
		if !errors.Is(err, sales.ErrCurrencyMismatch) {
			t.Errorf("err = %v, want ErrCurrencyMismatch", err)
		}
	})

	t.Run("between a line and its cost", func(t *testing.T) {
		_, err := sales.Record(snapshot(func(s *sales.Snapshot) {
			s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
				euros, _ := money.New(500, money.EUR)
				i.UnitCost = euros
			})}
		}))
		if !errors.Is(err, sales.ErrCurrencyMismatch) {
			t.Errorf("err = %v, want ErrCurrencyMismatch", err)
		}
	})

	t.Run("in the sale discount", func(t *testing.T) {
		_, err := sales.Record(snapshot(func(s *sales.Snapshot) {
			euros, _ := money.New(1, money.EUR)
			s.Discount = euros
		}))
		if !errors.Is(err, sales.ErrCurrencyMismatch) {
			t.Errorf("err = %v, want ErrCurrencyMismatch", err)
		}
	})
}

func TestASaleIsBoundedInSize(t *testing.T) {
	items := make([]sales.ItemSnapshot, 0, sales.MaxItems+1)
	for range sales.MaxItems + 1 {
		items = append(items, line())
	}

	_, err := sales.Record(snapshot(func(s *sales.Snapshot) { s.Items = items }))
	if !errors.Is(err, sales.ErrTooManyItems) {
		t.Errorf("err = %v, want ErrTooManyItems", err)
	}
}

// A sale recorded before it happened is a clock problem or a bug, and the
// timestamps are what reports slice on.
func TestASaleCannotBeRecordedBeforeItHappened(t *testing.T) {
	_, err := sales.Record(snapshot(func(s *sales.Snapshot) {
		s.RecordedAt = s.OccurredAt.Add(-time.Second)
	}))
	if err == nil {
		t.Error("a sale recorded before it happened was accepted")
	}
}

// A sale offline for days is recorded now and happened then, which is the
// ordinary case §45 describes.
func TestASaleFromDaysAgoIsAccepted(t *testing.T) {
	sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
		s.OccurredAt = recordedAt.AddDate(0, 0, -9)
	}))

	if !sale.OccurredAt().Equal(recordedAt.AddDate(0, 0, -9)) {
		t.Errorf("OccurredAt = %s, want the day it happened", sale.OccurredAt())
	}
}

// A sale survives the trip through storage unchanged, including its lines.
func TestASaleRestoresToWhatItWas(t *testing.T) {
	original := mustRecord(t, snapshot(func(s *sales.Snapshot) {
		s.CustomerID = customers.NewID()
		s.BranchID = business.NewBranchID()
		s.Note = "livraison samedi"
		s.Discount = money.FromXAF(500)
		s.Items = []sales.ItemSnapshot{
			line(func(i *sales.ItemSnapshot) {
				i.Discount = money.FromXAF(100)
				i.TaxRateBasisPoints = 1_925
				i.UnitCost = money.FromXAF(5_000)
			}),
			line(func(i *sales.ItemSnapshot) { i.Quantity = quantity.MustParse("2.5") }),
		}
	}))

	restored, err := sales.Restore(original.Snapshot())
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	before, after := original.Snapshot(), restored.Snapshot()
	if len(after.Items) != len(before.Items) {
		t.Fatalf("restored %d items, want %d", len(after.Items), len(before.Items))
	}
	for i := range before.Items {
		if before.Items[i] != after.Items[i] {
			t.Errorf("item %d changed:\n before %+v\n after  %+v", i, before.Items[i], after.Items[i])
		}
	}
	before.Items, after.Items = nil, nil
	if !reflect.DeepEqual(before, after) {
		t.Errorf("the sale changed:\n before %+v\n after  %+v", before, after)
	}
}

// The items a caller gets back cannot be used to change the sale.
func TestItemsAreHandedOutAsACopy(t *testing.T) {
	sale := mustRecord(t, snapshot())

	items := sale.Items()
	items[0] = sales.Item{}

	if sale.Items()[0].ID().IsZero() {
		t.Error("editing the returned slice changed the sale")
	}
}

// A sale's profit is only reportable where the cost was recorded. A guess would
// be worse than an honest gap (§6).
func TestProfitIsOnlyKnownWhereTheCostIs(t *testing.T) {
	sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{
			line(func(i *sales.ItemSnapshot) {
				i.UnitPrice = money.FromXAF(6_500)
				i.Quantity = quantity.MustFromUnits(2)
				i.UnitCost = money.FromXAF(5_000)
			}),
			line(func(i *sales.ItemSnapshot) { i.UnitPrice = money.FromXAF(900) }),
		}
	}))

	items := sale.Items()

	profit, known, err := items[0].Profit()
	if err != nil {
		t.Fatalf("Profit: %v", err)
	}
	if !known {
		t.Fatal("the profit on a line with a known cost was reported as unknown")
	}
	if got := profit.Amount(); got != 3_000 {
		t.Errorf("profit = %d, want 13000 − 10000", got)
	}

	if _, known, err := items[1].Profit(); err != nil || known {
		t.Errorf("a line with no cost reported a profit (known = %v, err = %v)", known, err)
	}
}

// The zero value of every exported type is unusable rather than quietly wrong.
func TestZeroValuesAreRefused(t *testing.T) {
	if _, err := sales.Record(sales.Snapshot{}); err == nil {
		t.Error("the zero snapshot was accepted")
	}
	if _, err := sales.RecordPayment(sales.PaymentSnapshot{}); err == nil {
		t.Error("the zero payment snapshot was accepted")
	}
	var empty sales.Item
	if _, err := empty.Total(); err == nil {
		t.Error("the zero item totalled without complaint")
	}
}
