package suppliers_test

import (
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

var (
	happenedAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	writtenAt  = time.Date(2026, 8, 14, 10, 30, 0, 0, time.UTC)
)

// book is a business with a supplier to owe.
type book struct {
	supplierID suppliers.ID
	businessID business.ID
	accountID  finance.AccountID
	userID     users.ID
	deviceID   devices.ID
}

func newBook() *book {
	return &book{
		supplierID: suppliers.NewID(),
		businessID: business.NewID(),
		accountID:  finance.NewAccountID(),
		userID:     users.NewID(),
		deviceID:   devices.NewID(),
	}
}

func (b *book) supplier(t *testing.T, mutate ...func(*suppliers.Snapshot)) *suppliers.Supplier {
	t.Helper()

	snapshot := suppliers.Snapshot{
		ID:         b.supplierID,
		BusinessID: b.businessID,
		Name:       "Grossiste Nkoabang",
		CreatedAt:  happenedAt,
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	supplier, err := suppliers.New(snapshot)
	if err != nil {
		t.Fatalf("suppliers.New: %v", err)
	}
	return supplier
}

func (b *book) snapshot(kind suppliers.TransactionType, minor int64) suppliers.TransactionSnapshot {
	snapshot := suppliers.TransactionSnapshot{
		ID:         suppliers.NewTransactionID(),
		SupplierID: b.supplierID,
		BusinessID: b.businessID,
		Type:       kind,
		Amount:     money.FromXAF(minor),
		UserID:     b.userID,
		DeviceID:   b.deviceID,
		OccurredAt: happenedAt,
		RecordedAt: writtenAt,
	}
	if kind.RequiresReference() {
		snapshot.Reference = suppliers.Reference{Kind: "PURCHASE", ID: suppliers.NewTransactionID().String()}
	}
	if kind.RequiresReason() {
		snapshot.Reason = "convenu avec le patron"
	}
	if kind.MovesMoney() {
		snapshot.AccountID = b.accountID
	}
	return snapshot
}

func (b *book) entry(
	t *testing.T, kind suppliers.TransactionType, minor int64,
	mutate ...func(*suppliers.TransactionSnapshot),
) *suppliers.Transaction {
	t.Helper()

	snapshot := b.snapshot(kind, minor)
	for _, change := range mutate {
		change(&snapshot)
	}

	transaction, err := suppliers.RecordTransaction(snapshot)
	if err != nil {
		t.Fatalf("RecordTransaction(%s): %v", kind, err)
	}
	return transaction
}

// A shopkeeper writing down a delivery at the door should not have to fill in a
// form first (§14).
func TestASupplierNeedsOnlyAName(t *testing.T) {
	b := newBook()
	supplier := b.supplier(t)

	if supplier.Name() != "Grossiste Nkoabang" {
		t.Errorf("Name = %q", supplier.Name())
	}
	if number, given := supplier.Phone(); given {
		t.Errorf("Phone = %s, want none", number)
	}
	if supplier.Contact() != "" || supplier.Address() != "" || supplier.Notes() != "" {
		t.Error("a supplier with only a name carries more than one")
	}
	if !supplier.Active() {
		t.Error("a new supplier is not active")
	}
	if supplier.ID() != b.supplierID || supplier.BusinessID() != b.businessID {
		t.Errorf("supplier %s of %s", supplier.ID(), supplier.BusinessID())
	}
	if !supplier.CreatedAt().Equal(happenedAt) || !supplier.UpdatedAt().Equal(happenedAt) {
		t.Error("a new supplier has the wrong timestamps")
	}
}

func TestEverythingASupplierCarriesRoundTrips(t *testing.T) {
	b := newBook()
	supplier := b.supplier(t, func(s *suppliers.Snapshot) {
		s.Phone = phone.MustParse("+237699123456")
		s.Address = "Marché Mokolo"
		// The person to ask for, which for a wholesaler is not the business's
		// name and is what a shopkeeper actually remembers.
		s.Contact = "Madame Ngo"
		s.Notes = "livre le mardi"
		s.UpdatedByDevice = devices.NewID()
	})

	restored, err := suppliers.Restore(supplier.Snapshot())
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Snapshot() != supplier.Snapshot() {
		t.Errorf("restored %+v, want %+v", restored.Snapshot(), supplier.Snapshot())
	}
	if restored.Contact() != "Madame Ngo" {
		t.Errorf("Contact = %q", restored.Contact())
	}
	if restored.UpdatedByDevice() != supplier.UpdatedByDevice() {
		t.Error("the editing device did not survive")
	}
	if restored.Scope() != supplier.Scope() {
		t.Errorf("Scope = %v", restored.Scope())
	}
}

func TestASupplierThatCannotExistIsRefused(t *testing.T) {
	b := newBook()

	for _, testCase := range []struct {
		name   string
		change func(*suppliers.Snapshot)
		want   error
	}{
		{"no identifier", func(s *suppliers.Snapshot) { s.ID = suppliers.ID{} }, suppliers.ErrInvalidID},
		{"no business", func(s *suppliers.Snapshot) { s.BusinessID = business.ID{} }, suppliers.ErrInvalidID},
		{"no name", func(s *suppliers.Snapshot) { s.Name = "  " }, validate.ErrInvalidName},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot := suppliers.Snapshot{
				ID: b.supplierID, BusinessID: b.businessID,
				Name: "Grossiste", CreatedAt: happenedAt,
			}
			testCase.change(&snapshot)
			if _, err := suppliers.New(snapshot); !errors.Is(err, testCase.want) {
				t.Errorf("New: got %v, want %v", err, testCase.want)
			}
			if _, err := suppliers.Restore(snapshot); !errors.Is(err, testCase.want) {
				t.Errorf("Restore: got %v, want %v", err, testCase.want)
			}
		})
	}

	if _, err := suppliers.New(suppliers.Snapshot{
		ID: b.supplierID, BusinessID: b.businessID, Name: "Grossiste",
	}); err == nil {
		t.Error("a supplier created at no moment was accepted")
	}
	if _, err := suppliers.Restore(suppliers.Snapshot{
		ID: b.supplierID, BusinessID: b.businessID, Name: "Grossiste",
		CreatedAt: writtenAt, UpdatedAt: happenedAt,
	}); err == nil {
		t.Error("a supplier updated before it was created was restored")
	}
}

func TestAnArchivedSupplierStaysArchived(t *testing.T) {
	b := newBook()
	snapshot := b.supplier(t).Snapshot()
	snapshot.Active = false
	snapshot.UpdatedAt = writtenAt

	restored, err := suppliers.Restore(snapshot)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Active() {
		t.Error("a supplier no longer used came back active")
	}
}

// §16's worked shape: a purchase on credit raises what is owed, a payment
// reduces it, and the balance is their sum.
func TestWhatIsOwedIsTheSumOfTheLedger(t *testing.T) {
	b := newBook()

	balance, err := suppliers.DeriveBalance(b.supplierID, []*suppliers.Transaction{
		b.entry(t, suppliers.Purchase, 50_000),
		b.entry(t, suppliers.Payment, -50_000),
		b.entry(t, suppliers.Purchase, 30_000),
	})
	if err != nil {
		t.Fatalf("DeriveBalance: %v", err)
	}

	if got := balance.Outstanding.Amount(); got != 30_000 {
		t.Errorf("outstanding = %d, want 30000", got)
	}
	if !balance.Owes() || balance.InCredit() {
		t.Error("a business owing 30,000 does not read as owing")
	}
	if balance.Entries != 3 || !balance.HasHistory() {
		t.Errorf("entries = %d, want 3", balance.Entries)
	}
	if !balance.LastMovedAt.Equal(happenedAt) {
		t.Errorf("last moved = %s", balance.LastMovedAt)
	}
}

// A device syncing a week late inserts entries among ones already recorded, so
// the order they are summed in cannot change the answer.
func TestASupplierBalanceDoesNotDependOnOrder(t *testing.T) {
	b := newBook()

	purchase := b.entry(t, suppliers.Purchase, 50_000)
	payment := b.entry(t, suppliers.Payment, -20_000)
	returned := b.entry(t, suppliers.Return, -5_000)

	forwards, err := suppliers.DeriveBalance(b.supplierID,
		[]*suppliers.Transaction{purchase, payment, returned})
	if err != nil {
		t.Fatalf("DeriveBalance: %v", err)
	}
	backwards, err := suppliers.DeriveBalance(b.supplierID,
		[]*suppliers.Transaction{returned, payment, purchase})
	if err != nil {
		t.Fatalf("DeriveBalance: %v", err)
	}
	if forwards.Outstanding != backwards.Outstanding {
		t.Errorf("%s one way and %s the other", forwards.Outstanding, backwards.Outstanding)
	}
}

func TestABusinessCanPayASupplierAhead(t *testing.T) {
	b := newBook()

	balance, err := suppliers.DeriveBalance(b.supplierID, []*suppliers.Transaction{
		b.entry(t, suppliers.Purchase, 10_000),
		b.entry(t, suppliers.Payment, -15_000),
	})
	if err != nil {
		t.Fatalf("DeriveBalance: %v", err)
	}
	if !balance.InCredit() || balance.Outstanding.Amount() != -5_000 {
		t.Errorf("outstanding = %s, want the business 5000 ahead", balance.Outstanding)
	}
}

func TestASupplierWithNoLedgerOwesNothingAtAll(t *testing.T) {
	b := newBook()

	balance, err := suppliers.DeriveBalance(b.supplierID, nil)
	if err != nil {
		t.Fatalf("DeriveBalance: %v", err)
	}
	if balance.HasHistory() || balance.Outstanding.Valid() {
		t.Errorf("a supplier nothing was bought from reads as %s", balance.Outstanding)
	}
	if !balance.LastMovedAt.IsZero() {
		t.Error("a ledger with no entries has a last movement")
	}
}

func TestABalanceRefusesEntriesThatAreNotItsOwn(t *testing.T) {
	b := newBook()

	if _, err := suppliers.DeriveBalance(suppliers.ID{}, nil); !errors.Is(err, suppliers.ErrInvalidID) {
		t.Errorf("got %v, want ErrInvalidID", err)
	}
	if _, err := suppliers.DeriveBalance(b.supplierID, []*suppliers.Transaction{nil}); !errors.Is(err, suppliers.ErrInvalidID) {
		t.Errorf("got %v, want ErrInvalidID", err)
	}

	stray := b.entry(t, suppliers.Purchase, 5_000, func(s *suppliers.TransactionSnapshot) {
		s.SupplierID = suppliers.NewID()
	})
	if _, err := suppliers.DeriveBalance(b.supplierID, []*suppliers.Transaction{stray}); !errors.Is(err, suppliers.ErrInvalidID) {
		t.Errorf("another supplier's entry was summed: %v", err)
	}

	euros := b.snapshot(suppliers.Purchase, 0)
	amount, err := money.New(5_000, money.EUR)
	if err != nil {
		t.Fatalf("money.New: %v", err)
	}
	euros.Amount = amount
	foreign, err := suppliers.RecordTransaction(euros)
	if err != nil {
		t.Fatalf("RecordTransaction: %v", err)
	}
	if _, err := suppliers.DeriveBalance(b.supplierID, []*suppliers.Transaction{
		b.entry(t, suppliers.Purchase, 5_000), foreign,
	}); !errors.Is(err, suppliers.ErrCurrencyMismatch) {
		t.Errorf("got %v, want ErrCurrencyMismatch", err)
	}
}

// A payment that increased a bill is invisible in a total and unarguable in a
// statement, so the sign is caught when it is recorded.
func TestASignThatContradictsItsTypeIsRefused(t *testing.T) {
	b := newBook()

	for _, kind := range suppliers.TransactionTypes() {
		if kind == suppliers.Adjustment {
			continue // A correction goes either way.
		}
		amount := int64(5_000)
		if kind.Decreases() {
			amount = -amount
		}
		snapshot := b.snapshot(kind, -amount)
		if _, err := suppliers.RecordTransaction(snapshot); !errors.Is(err, suppliers.ErrInvalidAmount) {
			t.Errorf("%s with the wrong sign was accepted: %v", kind, err)
		}
	}

	for _, amount := range []int64{5_000, -5_000} {
		if _, err := suppliers.RecordTransaction(b.snapshot(suppliers.Adjustment, amount)); err != nil {
			t.Errorf("an adjustment of %d was refused: %v", amount, err)
		}
	}
}

// Only a payment names an account: goods going back reduce the bill without a
// franc leaving the till (§16, §17).
func TestOnlyASupplierPaymentNamesAnAccount(t *testing.T) {
	b := newBook()

	blind := b.snapshot(suppliers.Payment, -5_000)
	blind.AccountID = finance.AccountID{}
	if _, err := suppliers.RecordTransaction(blind); !errors.Is(err, suppliers.ErrInvalidAccount) {
		t.Errorf("a payment from nowhere was accepted: %v", err)
	}

	for _, kind := range suppliers.TransactionTypes() {
		if kind.MovesMoney() {
			continue
		}
		amount := int64(5_000)
		if kind.Decreases() {
			amount = -amount
		}
		snapshot := b.snapshot(kind, amount)
		snapshot.AccountID = b.accountID
		if _, err := suppliers.RecordTransaction(snapshot); !errors.Is(err, suppliers.ErrInvalidAccount) {
			t.Errorf("a %s naming an account was accepted: %v", kind, err)
		}
	}

	payment := b.entry(t, suppliers.Payment, -5_000)
	if account, named := payment.Account(); !named || account != b.accountID {
		t.Errorf("Account = %s (named: %t)", account, named)
	}
}

func TestAnEntryThatCannotExistIsRefused(t *testing.T) {
	b := newBook()

	for _, testCase := range []struct {
		name   string
		change func(*suppliers.TransactionSnapshot)
		want   error
	}{
		{"no identifier", func(s *suppliers.TransactionSnapshot) { s.ID = suppliers.TransactionID{} }, suppliers.ErrInvalidID},
		{"no supplier", func(s *suppliers.TransactionSnapshot) { s.SupplierID = suppliers.ID{} }, suppliers.ErrInvalidID},
		{"no business", func(s *suppliers.TransactionSnapshot) { s.BusinessID = business.ID{} }, suppliers.ErrInvalidID},
		{"no user", func(s *suppliers.TransactionSnapshot) { s.UserID = users.ID{} }, suppliers.ErrInvalidID},
		{"no device", func(s *suppliers.TransactionSnapshot) { s.DeviceID = devices.ID{} }, suppliers.ErrInvalidID},
		{"no type", func(s *suppliers.TransactionSnapshot) { s.Type = "" }, suppliers.ErrInvalidTransactionType},
		{"a type this build does not know", func(s *suppliers.TransactionSnapshot) { s.Type = "LOAN" }, suppliers.ErrInvalidTransactionType},
		{"no amount", func(s *suppliers.TransactionSnapshot) { s.Amount = money.Money{} }, suppliers.ErrInvalidAmount},
		{"an entry of nothing", func(s *suppliers.TransactionSnapshot) { s.Amount = money.FromXAF(0) }, suppliers.ErrInvalidAmount},
		{"recorded before it happened", func(s *suppliers.TransactionSnapshot) {
			s.RecordedAt = s.OccurredAt.Add(-time.Second)
		}, validate.ErrInvalidTime},
		{"a purchase naming nothing", func(s *suppliers.TransactionSnapshot) {
			s.Reference = suppliers.Reference{}
		}, suppliers.ErrMissingReference},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot := b.snapshot(suppliers.Purchase, 5_000)
			testCase.change(&snapshot)
			if _, err := suppliers.RecordTransaction(snapshot); !errors.Is(err, testCase.want) {
				t.Errorf("got %v, want %v", err, testCase.want)
			}
		})
	}

	// A correction moves a bill with nothing behind it, so it has to say why.
	blank := b.snapshot(suppliers.Adjustment, 5_000)
	blank.Reason = "   "
	if _, err := suppliers.RecordTransaction(blank); !errors.Is(err, suppliers.ErrMissingReason) {
		t.Errorf("got %v, want ErrMissingReason", err)
	}
}

func TestASupplierEntryCarriesWhatAStatementNeeds(t *testing.T) {
	b := newBook()
	branch := business.NewBranchID()

	entry := b.entry(t, suppliers.Purchase, 50_000, func(s *suppliers.TransactionSnapshot) {
		s.BranchID = branch
	})

	if entry.SupplierID() != b.supplierID || entry.BusinessID() != b.businessID {
		t.Error("the entry lost whose ledger it is on")
	}
	if entry.BranchID() != branch {
		t.Errorf("BranchID = %s", entry.BranchID())
	}
	if entry.Type() != suppliers.Purchase || entry.Amount().Amount() != 50_000 {
		t.Errorf("entry is %s of %s", entry.Type(), entry.Amount())
	}
	if reference, named := entry.Reference(); !named || reference.Kind != "PURCHASE" {
		t.Errorf("Reference = %v", reference)
	}
	if entry.UserID() != b.userID || entry.DeviceID() != b.deviceID {
		t.Error("the entry lost who recorded it")
	}
	if !entry.OccurredAt().Equal(happenedAt) || !entry.RecordedAt().Equal(writtenAt) {
		t.Error("the entry lost when it happened")
	}
	if entry.ID().IsZero() || entry.Reason() != "" {
		t.Error("a purchase carries a reason it was not given")
	}

	restored, err := suppliers.RestoreTransaction(entry.Snapshot())
	if err != nil {
		t.Fatalf("RestoreTransaction: %v", err)
	}
	if restored.Snapshot() != entry.Snapshot() {
		t.Error("an entry did not survive a round trip")
	}
}

func TestParsingSupplierTypesAndIdentifiers(t *testing.T) {
	for _, kind := range suppliers.TransactionTypes() {
		parsed, err := suppliers.ParseTransactionType(kind.String())
		if err != nil || parsed != kind {
			t.Errorf("ParseTransactionType(%s) = %s, %v", kind, parsed, err)
		}
		if kind.IsSensitive() != (kind == suppliers.Adjustment) {
			t.Errorf("%s is audited: %t", kind, kind.IsSensitive())
		}
	}
	if _, err := suppliers.ParseTransactionType("LOAN"); !errors.Is(err, suppliers.ErrInvalidTransactionType) {
		t.Errorf("got %v, want ErrInvalidTransactionType", err)
	}

	raw := suppliers.NewID()
	if parsed, err := suppliers.ParseID(raw.String()); err != nil || parsed != raw {
		t.Errorf("ParseID round trip: %s, %v", parsed, err)
	}
	if suppliers.IDFrom(raw.ID()) != raw {
		t.Error("IDFrom did not return the same identifier")
	}
	if _, err := suppliers.ParseID("not-an-identifier"); err == nil {
		t.Error("a malformed supplier identifier parsed")
	}

	rawEntry := suppliers.NewTransactionID()
	if parsed, err := suppliers.ParseTransactionID(rawEntry.String()); err != nil || parsed != rawEntry {
		t.Errorf("ParseTransactionID round trip: %s, %v", parsed, err)
	}
	if suppliers.TransactionIDFrom(rawEntry.ID()) != rawEntry {
		t.Error("TransactionIDFrom did not return the same identifier")
	}
	if _, err := suppliers.ParseTransactionID("not-an-identifier"); err == nil {
		t.Error("a malformed transaction identifier parsed")
	}
}

func TestAReferenceReadsAsWhatCausedIt(t *testing.T) {
	empty := suppliers.Reference{}
	if !empty.IsZero() || empty.String() != "" {
		t.Errorf("the zero reference reads as %q", empty.String())
	}
	named := suppliers.Reference{Kind: "PURCHASE", ID: "A-12"}
	if named.IsZero() || named.String() != "PURCHASE:A-12" {
		t.Errorf("Reference = %q", named.String())
	}
}
