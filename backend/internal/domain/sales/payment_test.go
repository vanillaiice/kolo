package sales_test

import (
	"errors"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// paidWith builds a payment against a sale.
func paidWith(t *testing.T, sale *sales.Sale, amount int64, mutate ...func(*sales.PaymentSnapshot)) *sales.Payment {
	t.Helper()

	snapshot := sales.PaymentSnapshot{
		ID:         sales.NewPaymentID(),
		SaleID:     sale.ID(),
		BusinessID: sale.BusinessID(),
		AccountID:  finance.NewAccountID(),
		Amount:     money.FromXAF(amount),
		UserID:     sale.UserID(),
		DeviceID:   sale.DeviceID(),
		OccurredAt: soldAt,
		RecordedAt: recordedAt,
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	payment, err := sales.RecordPayment(snapshot)
	if err != nil {
		t.Fatalf("RecordPayment: %v", err)
	}
	return payment
}

// saleOf builds a sale for exactly the given amount, on one line.
func saleOf(t *testing.T, amount int64, mutate ...func(*sales.Snapshot)) *sales.Sale {
	t.Helper()
	return mustRecord(t, snapshot(append([]func(*sales.Snapshot){func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
			i.UnitPrice = money.FromXAF(amount)
		})}
	}}, mutate...)...))
}

// The worked example from §11: one bill settled by two methods.
func TestASaleIsSettledByASplitPayment(t *testing.T) {
	sale := saleOf(t, 18_500)

	settlement, err := sales.Settle(sale, []*sales.Payment{
		paidWith(t, sale, 10_000),
		paidWith(t, sale, 8_500),
	})
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}

	if got := settlement.Paid.Amount(); got != 18_500 {
		t.Errorf("paid = %d, want 18500", got)
	}
	if !settlement.Outstanding.IsZero() {
		t.Errorf("outstanding = %s, want zero", settlement.Outstanding)
	}
	if !settlement.Settled() {
		t.Error("a fully paid sale was not settled")
	}
	if settlement.OnCredit() {
		t.Error("a fully paid sale was reported as credit")
	}
}

// Cash and Mobile Money go to different accounts, and neither is a type on the
// sale. This is what makes MTN and Orange configurable (§10).
func TestPaymentsNameAnAccountRatherThanAMethod(t *testing.T) {
	sale := saleOf(t, 18_500)
	till, wallet := finance.NewAccountID(), finance.NewAccountID()

	payments := []*sales.Payment{
		paidWith(t, sale, 10_000, func(p *sales.PaymentSnapshot) { p.AccountID = till }),
		paidWith(t, sale, 8_500, func(p *sales.PaymentSnapshot) {
			p.AccountID = wallet
			p.Reference = "MP260814.0930.A12345"
		}),
	}

	if payments[0].AccountID() != till || payments[1].AccountID() != wallet {
		t.Error("payments did not keep the accounts they were paid into")
	}
	// The provider's reference is what finds a Mobile Money payment a week later.
	if payments[1].Reference() != "MP260814.0930.A12345" {
		t.Errorf("Reference = %q, want the provider's number", payments[1].Reference())
	}
}

// A sale can take any number of payments, including over several days, which is
// how credit is actually settled.
func TestASaleCanTakeManyPayments(t *testing.T) {
	sale := saleOf(t, 10_000, func(s *sales.Snapshot) { s.CustomerID = customers.NewID() })

	payments := make([]*sales.Payment, 0, 10)
	for range 9 {
		payments = append(payments, paidWith(t, sale, 1_000))
	}

	settlement, err := sales.Settle(sale, payments)
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}
	if got := settlement.Outstanding.Amount(); got != 1_000 {
		t.Errorf("outstanding = %d, want 1000", got)
	}
	if !settlement.OnCredit() {
		t.Error("a part-paid sale was not reported as credit")
	}
}

// An unpaid sale is credit, and credit is owed by someone.
func TestAnUnpaidSaleIsCreditAgainstItsCustomer(t *testing.T) {
	sale := saleOf(t, 5_000, func(s *sales.Snapshot) { s.CustomerID = customers.NewID() })

	settlement, err := sales.Settle(sale, nil)
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}
	if got := settlement.Outstanding.Amount(); got != 5_000 {
		t.Errorf("outstanding = %d, want the whole 5000", got)
	}
	if settlement.Settled() {
		t.Error("an unpaid sale was reported as settled")
	}
}

// A debt with no debtor could never be collected or reported against anyone,
// so it is refused rather than recorded and lost.
func TestABalanceWithNoCustomerIsRefused(t *testing.T) {
	sale := saleOf(t, 5_000)

	_, err := sales.Settle(sale, []*sales.Payment{paidWith(t, sale, 4_999)})
	if !errors.Is(err, sales.ErrCreditNeedsCustomer) {
		t.Errorf("err = %v, want ErrCreditNeedsCustomer", err)
	}
}

// A cash sale needs no customer, which is the common case at a till (§12).
func TestAFullyPaidSaleNeedsNoCustomer(t *testing.T) {
	sale := saleOf(t, 5_000)

	if _, err := sales.Settle(sale, []*sales.Payment{paidWith(t, sale, 5_000)}); err != nil {
		t.Errorf("a paid cash sale was refused: %v", err)
	}
}

// Paying more than the bill means someone recorded the wrong figure. Change
// given from cash tendered is a different number, and accepting this would put
// money in the accounts the business never took.
func TestPayingMoreThanTheSaleIsRefused(t *testing.T) {
	sale := saleOf(t, 5_000)

	_, err := sales.Settle(sale, []*sales.Payment{
		paidWith(t, sale, 3_000),
		paidWith(t, sale, 3_000),
	})
	if !errors.Is(err, sales.ErrOverpaid) {
		t.Errorf("err = %v, want ErrOverpaid", err)
	}
}

// Counting the same payment twice would make a debt look settled when it is
// not, which is the sort of error nobody notices until the customer disputes it.
func TestTheSamePaymentCannotBeCountedTwice(t *testing.T) {
	sale := saleOf(t, 10_000, func(s *sales.Snapshot) { s.CustomerID = customers.NewID() })
	payment := paidWith(t, sale, 5_000)

	_, err := sales.Settle(sale, []*sales.Payment{payment, payment})
	if !errors.Is(err, sales.ErrDuplicatePayment) {
		t.Errorf("err = %v, want ErrDuplicatePayment", err)
	}
}

// A payment for another sale must not settle this one.
func TestAPaymentForAnotherSaleIsRefused(t *testing.T) {
	sale, other := saleOf(t, 5_000), saleOf(t, 5_000)

	_, err := sales.Settle(sale, []*sales.Payment{paidWith(t, other, 5_000)})
	if !errors.Is(err, sales.ErrInvalidID) {
		t.Errorf("err = %v, want a refusal naming the wrong sale, got %v", err, err)
	}
}

func TestAPaymentIsRefusedWithoutWhatItNeeds(t *testing.T) {
	sale := saleOf(t, 5_000)
	base := func() sales.PaymentSnapshot { return paidWith(t, sale, 1_000).Snapshot() }

	for _, testCase := range []struct {
		name   string
		mutate func(*sales.PaymentSnapshot)
		want   error
	}{
		{"no identifier", func(p *sales.PaymentSnapshot) { p.ID = sales.PaymentID{} }, sales.ErrInvalidID},
		{"no sale", func(p *sales.PaymentSnapshot) { p.SaleID = sales.ID{} }, sales.ErrInvalidID},
		{"no business", func(p *sales.PaymentSnapshot) { p.BusinessID = business.ID{} }, sales.ErrInvalidID},
		{"no account", func(p *sales.PaymentSnapshot) { p.AccountID = finance.AccountID{} }, sales.ErrInvalidID},
		{"no user", func(p *sales.PaymentSnapshot) { p.UserID = users.ID{} }, sales.ErrInvalidID},
		{"no device", func(p *sales.PaymentSnapshot) { p.DeviceID = devices.ID{} }, sales.ErrInvalidID},
		{"no currency", func(p *sales.PaymentSnapshot) { p.Amount = money.Money{} }, sales.ErrInvalidAmount},
		{"nothing at all", func(p *sales.PaymentSnapshot) { p.Amount = money.FromXAF(0) }, sales.ErrInvalidAmount},
		{"a negative amount", func(p *sales.PaymentSnapshot) { p.Amount = money.FromXAF(-1) }, sales.ErrInvalidAmount},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot := base()
			testCase.mutate(&snapshot)

			_, err := sales.RecordPayment(snapshot)
			if !errors.Is(err, testCase.want) {
				t.Errorf("err = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestAPaymentRecordedBeforeItHappenedIsRefused(t *testing.T) {
	sale := saleOf(t, 5_000)
	snapshot := paidWith(t, sale, 1_000).Snapshot()
	snapshot.RecordedAt = snapshot.OccurredAt.Add(-1)

	if _, err := sales.RecordPayment(snapshot); err == nil {
		t.Error("a payment recorded before it happened was accepted")
	}
}

func TestAPaymentRestoresToWhatItWas(t *testing.T) {
	sale := saleOf(t, 5_000)
	original := paidWith(t, sale, 5_000, func(p *sales.PaymentSnapshot) {
		p.BranchID = business.NewBranchID()
		p.Reference = "MP260814.0930.A12345"
		p.Note = "payé par le fils"
	})

	restored, err := sales.RestorePayment(original.Snapshot())
	if err != nil {
		t.Fatalf("RestorePayment: %v", err)
	}
	if restored.Snapshot() != original.Snapshot() {
		t.Errorf("the payment changed:\n before %+v\n after  %+v", original.Snapshot(), restored.Snapshot())
	}
}

// A payment against a sale that was entirely discounted is refused, since there
// is nothing to pay.
func TestPayingAGivenAwaySaleIsRefused(t *testing.T) {
	sale := mustRecord(t, snapshot(func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{line(func(i *sales.ItemSnapshot) {
			i.UnitPrice = money.FromXAF(1_000)
		})}
		s.Discount = money.FromXAF(1_000)
	}))

	if _, err := sales.Settle(sale, []*sales.Payment{paidWith(t, sale, 1)}); !errors.Is(err, sales.ErrOverpaid) {
		t.Errorf("err = %v, want ErrOverpaid", err)
	}
	// And with no payments it is settled, not credit.
	settlement, err := sales.Settle(sale, nil)
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}
	if !settlement.Settled() {
		t.Error("a sale given away entirely was not settled")
	}
}

// A missing payment in the list is a caller bug, refused rather than skipped.
func TestANilPaymentIsRefused(t *testing.T) {
	sale := saleOf(t, 5_000)

	if _, err := sales.Settle(sale, []*sales.Payment{nil}); !errors.Is(err, sales.ErrInvalidID) {
		t.Errorf("err = %v, want a refusal", err)
	}
}

// The order payments are counted in cannot change the answer.
func TestSettlementDoesNotDependOnPaymentOrder(t *testing.T) {
	sale := saleOf(t, 18_500)
	first, second, third := paidWith(t, sale, 10_000), paidWith(t, sale, 6_000), paidWith(t, sale, 2_500)

	forwards, err := sales.Settle(sale, []*sales.Payment{first, second, third})
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}
	backwards, err := sales.Settle(sale, []*sales.Payment{third, second, first})
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}

	if forwards != backwards {
		t.Errorf("order changed the answer: %+v vs %+v", forwards, backwards)
	}
}
