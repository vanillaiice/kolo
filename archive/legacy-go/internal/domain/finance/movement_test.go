package finance_test

import (
	"errors"
	"math"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

var (
	movedAt    = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	recordedAt = time.Date(2026, 8, 14, 10, 30, 0, 0, time.UTC)
)

// till is the account a movement is against, with a second for transfers.
type drawer struct {
	account    finance.AccountID
	otherwhere finance.AccountID
	businessID business.ID
	userID     users.ID
	deviceID   devices.ID
}

func newDrawer() *drawer {
	return &drawer{
		account:    finance.NewAccountID(),
		otherwhere: finance.NewAccountID(),
		businessID: business.NewID(),
		userID:     users.NewID(),
		deviceID:   devices.NewID(),
	}
}

func (d *drawer) snapshot(kind finance.MovementType, amount int64) finance.MovementSnapshot {
	snapshot := finance.MovementSnapshot{
		ID:         finance.NewMovementID(),
		AccountID:  d.account,
		BusinessID: d.businessID,
		Type:       kind,
		Amount:     money.FromXAF(amount),
		UserID:     d.userID,
		DeviceID:   d.deviceID,
		OccurredAt: movedAt,
		RecordedAt: recordedAt,
	}
	if kind.RequiresReason() {
		snapshot.Reason = "porté à la banque"
	}
	if kind.IsTransfer() {
		snapshot.CounterpartID = d.otherwhere
	}
	return snapshot
}

func (d *drawer) movement(
	t *testing.T, kind finance.MovementType, amount int64,
	mutate ...func(*finance.MovementSnapshot),
) *finance.Movement {
	t.Helper()

	snapshot := d.snapshot(kind, amount)
	for _, change := range mutate {
		change(&snapshot)
	}

	movement, err := finance.RecordMovement(snapshot)
	if err != nil {
		t.Fatalf("RecordMovement(%s): %v", kind, err)
	}
	return movement
}

func TestAMovementRoundTrips(t *testing.T) {
	d := newDrawer()

	movement := d.movement(t, finance.OpeningBalance, 50_000)
	restored, err := finance.RestoreMovement(movement.Snapshot())
	if err != nil {
		t.Fatalf("RestoreMovement: %v", err)
	}
	if restored.Snapshot() != movement.Snapshot() {
		t.Errorf("restored %+v, want %+v", restored.Snapshot(), movement.Snapshot())
	}
	if _, transferred := movement.Counterpart(); transferred {
		t.Error("an opening balance names a counterpart account")
	}
}

// The sign has to agree with the type. Cash taken out that read as money in
// would make a drawer look full that is empty, and only a count would find it.
func TestASignThatContradictsItsTypeIsRefused(t *testing.T) {
	d := newDrawer()

	for _, kind := range finance.MovementTypes() {
		if kind == finance.Adjustment {
			// A correction goes either way: a count can find more or less.
			continue
		}
		amount := int64(5_000)
		if kind.Decreases() {
			amount = -amount
		}

		snapshot := d.snapshot(kind, -amount)
		if _, err := finance.RecordMovement(snapshot); !errors.Is(err, finance.ErrInvalidAmount) {
			t.Errorf("%s with the wrong sign was accepted: %v", kind, err)
		}
	}

	// And an adjustment may be either way, because a count can find either.
	for _, amount := range []int64{5_000, -5_000} {
		if _, err := finance.RecordMovement(d.snapshot(finance.Adjustment, amount)); err != nil {
			t.Errorf("an adjustment of %d was refused: %v", amount, err)
		}
	}
}

func TestAMovementOfNothingIsRefused(t *testing.T) {
	d := newDrawer()

	if _, err := finance.RecordMovement(d.snapshot(finance.CashIn, 0)); !errors.Is(err, finance.ErrInvalidAmount) {
		t.Errorf("got %v, want ErrInvalidAmount", err)
	}

	snapshot := d.snapshot(finance.CashIn, 5_000)
	snapshot.Amount = money.Money{}
	if _, err := finance.RecordMovement(snapshot); !errors.Is(err, finance.ErrInvalidAmount) {
		t.Errorf("an amount with no currency was accepted: %v", err)
	}
}

// Money appearing or vanishing with no business event behind it is exactly when
// the owner reading the day's cash needs to be told why (§39).
func TestAdjustmentsAndWithdrawalsNeedAReason(t *testing.T) {
	d := newDrawer()

	for _, kind := range []finance.MovementType{finance.Adjustment, finance.CashOut} {
		amount := int64(5_000)
		if kind.Decreases() {
			amount = -amount
		}
		snapshot := d.snapshot(kind, amount)
		snapshot.Reason = "   "
		if _, err := finance.RecordMovement(snapshot); !errors.Is(err, finance.ErrMissingReason) {
			t.Errorf("a %s with no reason was accepted: %v", kind, err)
		}
		if !kind.IsSensitive() {
			t.Errorf("%s moves money with nothing behind it but is not audited", kind)
		}
	}

	// Money put in needs none: the float at opening explains itself.
	if _, err := finance.RecordMovement(d.snapshot(finance.CashIn, 5_000)); err != nil {
		t.Errorf("money put in was refused for want of a reason: %v", err)
	}
}

// Half a transfer is money vanishing from one account with nothing to show
// where it went.
func TestATransferNamesBothEnds(t *testing.T) {
	d := newDrawer()

	snapshot := d.snapshot(finance.TransferOut, -5_000)
	snapshot.CounterpartID = finance.AccountID{}
	if _, err := finance.RecordMovement(snapshot); !errors.Is(err, finance.ErrMissingCounterpart) {
		t.Errorf("a transfer to nowhere was accepted: %v", err)
	}

	// And a movement that is not a transfer must not name one.
	stray := d.snapshot(finance.CashIn, 5_000)
	stray.CounterpartID = d.otherwhere
	if _, err := finance.RecordMovement(stray); !errors.Is(err, finance.ErrMissingCounterpart) {
		t.Errorf("money put in named another account: %v", err)
	}

	// Nor may an account transfer to itself, which moves nothing while looking
	// like something.
	itself := d.snapshot(finance.TransferOut, -5_000)
	itself.CounterpartID = d.account
	if _, err := finance.RecordMovement(itself); !errors.Is(err, finance.ErrSameAccount) {
		t.Errorf("an account transferred to itself: %v", err)
	}
}

// A transfer is two movements, because a balance is the sum of the movements
// naming an account: one row could only ever be counted by one of the two.
func TestATransferIsTwoMovements(t *testing.T) {
	d := newDrawer()

	from := d.snapshot(finance.CashOut, -20_000)
	from.Reason = ""
	to := finance.MovementSnapshot{
		ID:         finance.NewMovementID(),
		AccountID:  d.otherwhere,
		BusinessID: d.businessID,
		UserID:     d.userID,
		DeviceID:   d.deviceID,
		OccurredAt: movedAt,
		RecordedAt: recordedAt,
	}

	out, in, err := finance.Transfer(from, to)
	if err != nil {
		t.Fatalf("Transfer: %v", err)
	}

	if out.Type() != finance.TransferOut || in.Type() != finance.TransferIn {
		t.Errorf("types %s and %s, want a transfer out and in", out.Type(), in.Type())
	}
	if got := out.Amount().Amount(); got != -20_000 {
		t.Errorf("the money leaving = %d, want -20000", got)
	}
	if got := in.Amount().Amount(); got != 20_000 {
		t.Errorf("the money arriving = %d, want 20000", got)
	}

	// Each names the other, so neither half reads as money appearing from
	// nowhere.
	if counterpart, _ := out.Counterpart(); counterpart != d.otherwhere {
		t.Errorf("the money leaving names %s, want %s", counterpart, d.otherwhere)
	}
	if counterpart, _ := in.Counterpart(); counterpart != d.account {
		t.Errorf("the money arriving names %s, want %s", counterpart, d.account)
	}
	// The two together move nothing overall, which is what a transfer means.
	total, err := out.Amount().Add(in.Amount())
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if !total.IsZero() {
		t.Errorf("a transfer changed the business's money by %s", total)
	}
}

func TestATransferThatCannotBeMadeIsRefused(t *testing.T) {
	d := newDrawer()

	to := finance.MovementSnapshot{
		ID:         finance.NewMovementID(),
		AccountID:  d.otherwhere,
		BusinessID: d.businessID,
		UserID:     d.userID,
		DeviceID:   d.deviceID,
		OccurredAt: movedAt,
		RecordedAt: recordedAt,
	}

	sameAccount := d.snapshot(finance.CashOut, -20_000)
	sameAccount.AccountID = d.otherwhere
	if _, _, err := finance.Transfer(sameAccount, to); !errors.Is(err, finance.ErrSameAccount) {
		t.Errorf("an account transferred to itself: %v", err)
	}

	noCurrency := d.snapshot(finance.CashOut, -20_000)
	noCurrency.Amount = money.Money{}
	if _, _, err := finance.Transfer(noCurrency, to); !errors.Is(err, finance.ErrInvalidAmount) {
		t.Errorf("a transfer of nothing was accepted: %v", err)
	}

	incomplete := d.snapshot(finance.CashOut, -20_000)
	broken := to
	broken.UserID = users.ID{}
	if _, _, err := finance.Transfer(incomplete, broken); err == nil {
		t.Error("a transfer whose arriving half is incomplete was accepted")
	}

	alsoIncomplete := d.snapshot(finance.CashOut, -20_000)
	alsoIncomplete.UserID = users.ID{}
	if _, _, err := finance.Transfer(alsoIncomplete, to); err == nil {
		t.Error("a transfer whose leaving half is incomplete was accepted")
	}
}

// The amount is given as what leaves, signed as it will be stored. Flipping a
// positive one silently would be the only place in this domain where a sign
// that contradicts its meaning is corrected rather than refused.
func TestATransferTakesTheAmountAsWhatLeaves(t *testing.T) {
	d := newDrawer()

	to := finance.MovementSnapshot{
		ID:         finance.NewMovementID(),
		AccountID:  d.otherwhere,
		BusinessID: d.businessID,
		UserID:     d.userID,
		DeviceID:   d.deviceID,
		OccurredAt: movedAt,
		RecordedAt: recordedAt,
	}

	out, in, err := finance.Transfer(d.snapshot(finance.CashOut, -20_000), to)
	if err != nil {
		t.Fatalf("Transfer: %v", err)
	}
	if out.Amount().Amount() != -20_000 || in.Amount().Amount() != 20_000 {
		t.Errorf("got %s out and %s in", out.Amount(), in.Amount())
	}

	for _, refused := range []int64{20_000, 0} {
		if _, _, err := finance.Transfer(d.snapshot(finance.CashOut, refused), to); !errors.Is(err, finance.ErrInvalidAmount) {
			t.Errorf("a transfer of %d was accepted: %v", refused, err)
		}
	}
}

// The boundary money arithmetic actually has: the most negative amount has no
// positive counterpart, so a transfer of it cannot be made rather than
// wrapping round into a deposit.
func TestATransferAtTheEdgeOfTheArithmeticIsRefused(t *testing.T) {
	d := newDrawer()

	to := finance.MovementSnapshot{
		ID:         finance.NewMovementID(),
		AccountID:  d.otherwhere,
		BusinessID: d.businessID,
		UserID:     d.userID,
		DeviceID:   d.deviceID,
		OccurredAt: movedAt,
		RecordedAt: recordedAt,
	}

	from := d.snapshot(finance.CashOut, math.MinInt64)
	if _, _, err := finance.Transfer(from, to); !errors.Is(err, finance.ErrInvalidAmount) {
		t.Errorf("a transfer of the most negative amount was accepted: %v", err)
	}

	// One franc inside the edge is fine, which is what makes the refusal above
	// the boundary rather than a blanket rule.
	inside := d.snapshot(finance.CashOut, math.MinInt64+1)
	if _, _, err := finance.Transfer(inside, to); err != nil {
		t.Errorf("a transfer just inside the edge was refused: %v", err)
	}
}

func TestAMovementThatCannotExistIsRefused(t *testing.T) {
	d := newDrawer()

	for _, testCase := range []struct {
		name   string
		break_ func(*finance.MovementSnapshot)
	}{
		{"no identifier", func(s *finance.MovementSnapshot) { s.ID = finance.MovementID{} }},
		{"no account", func(s *finance.MovementSnapshot) { s.AccountID = finance.AccountID{} }},
		{"no business", func(s *finance.MovementSnapshot) { s.BusinessID = business.ID{} }},
		{"no user", func(s *finance.MovementSnapshot) { s.UserID = users.ID{} }},
		{"no device", func(s *finance.MovementSnapshot) { s.DeviceID = devices.ID{} }},
		{"no type", func(s *finance.MovementSnapshot) { s.Type = "" }},
		{"a type this build does not know", func(s *finance.MovementSnapshot) { s.Type = "LOAN" }},
		{"recorded before it happened", func(s *finance.MovementSnapshot) {
			s.RecordedAt = s.OccurredAt.Add(-time.Second)
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot := d.snapshot(finance.CashIn, 5_000)
			testCase.break_(&snapshot)
			if _, err := finance.RecordMovement(snapshot); err == nil {
				t.Error("it was accepted")
			}
		})
	}
}

func TestParsingAMovementType(t *testing.T) {
	for _, kind := range finance.MovementTypes() {
		parsed, err := finance.ParseMovementType(kind.String())
		if err != nil || parsed != kind {
			t.Errorf("ParseMovementType(%s) = %s, %v", kind, parsed, err)
		}
	}
	if _, err := finance.ParseMovementType("LOAN"); !errors.Is(err, finance.ErrInvalidMovementType) {
		t.Errorf("got %v, want ErrInvalidMovementType", err)
	}
}

func TestMovementIdentifiersAreDistinctFromAccountIdentifiers(t *testing.T) {
	raw := finance.NewMovementID()
	parsed, err := finance.ParseMovementID(raw.String())
	if err != nil || parsed != raw {
		t.Errorf("ParseMovementID round trip: %s, %v", parsed, err)
	}
	if finance.MovementIDFrom(raw.ID()) != raw {
		t.Error("MovementIDFrom did not return the same identifier")
	}
	if _, err := finance.ParseMovementID("not-an-identifier"); err == nil {
		t.Error("a malformed movement identifier parsed")
	}
}

// Accessors carry what a report and an audit record need.
func TestAMovementSaysWhereAndWhenAndWho(t *testing.T) {
	d := newDrawer()
	branch := business.NewBranchID()

	movement := d.movement(t, finance.CashOut, -5_000, func(s *finance.MovementSnapshot) {
		s.BranchID = branch
	})

	if movement.AccountID() != d.account || movement.BusinessID() != d.businessID {
		t.Errorf("movement is against %s of %s", movement.AccountID(), movement.BusinessID())
	}
	if movement.BranchID() != branch {
		t.Errorf("BranchID = %s, want %s", movement.BranchID(), branch)
	}
	if movement.UserID() != d.userID || movement.DeviceID() != d.deviceID {
		t.Errorf("recorded by %s on %s", movement.UserID(), movement.DeviceID())
	}
	if !movement.OccurredAt().Equal(movedAt) || !movement.RecordedAt().Equal(recordedAt) {
		t.Errorf("moved at %s, recorded at %s", movement.OccurredAt(), movement.RecordedAt())
	}
	if movement.Reason() == "" {
		t.Error("a withdrawal came back with no reason")
	}
	if movement.ID().IsZero() {
		t.Error("a movement has no identifier")
	}
}
