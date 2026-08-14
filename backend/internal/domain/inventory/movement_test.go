package inventory_test

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

func validSnapshot() inventory.Snapshot {
	return inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: tenant,
		ProductID:  product,
		Type:       inventory.Purchase,
		Quantity:   quantity.MustParse("10"),
		UnitCost:   money.FromXAF(400),
		Reference:  inventory.Reference{Kind: "PURCHASE", ID: "purchase-1"},
		UserID:     operator,
		DeviceID:   till,
		OccurredAt: occurredAt,
		RecordedAt: occurredAt,
	}
}

func TestRecordKeepsWhatItWasGiven(t *testing.T) {
	snapshot := validSnapshot()

	movement, err := inventory.Record(snapshot)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}

	if movement.Snapshot() != snapshot {
		t.Errorf("Snapshot() = %+v, want %+v", movement.Snapshot(), snapshot)
	}
	if cost, recorded := movement.UnitCost(); !recorded || cost.Amount() != 400 {
		t.Errorf("UnitCost() = %s, %v", cost, recorded)
	}
	if reference, present := movement.Reference(); !present || reference.Kind != "PURCHASE" {
		t.Errorf("Reference() = %v, %v", reference, present)
	}
	if movement.IsSensitive() {
		t.Error("a purchase was marked as needing an audit record")
	}
}

// TestOccurrenceAndRecordTimeAreBothKept matters for a device offline for days:
// reports are about when business happened, sync about when we learned of it.
func TestOccurrenceAndRecordTimeAreBothKept(t *testing.T) {
	snapshot := validSnapshot()
	snapshot.OccurredAt = occurredAt
	snapshot.RecordedAt = occurredAt.Add(72 * time.Hour)

	movement, err := inventory.Record(snapshot)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if !movement.OccurredAt().Equal(occurredAt) {
		t.Errorf("OccurredAt() = %s, want %s", movement.OccurredAt(), occurredAt)
	}
	if !movement.RecordedAt().Equal(snapshot.RecordedAt) {
		t.Errorf("RecordedAt() = %s, want %s", movement.RecordedAt(), snapshot.RecordedAt)
	}
}

func TestRecordNormalisesTimestampsToUTC(t *testing.T) {
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	snapshot := validSnapshot()
	snapshot.OccurredAt = occurredAt.In(wat)
	snapshot.RecordedAt = occurredAt.In(wat)

	movement, err := inventory.Record(snapshot)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if got := movement.OccurredAt().Location(); got != time.UTC {
		t.Errorf("OccurredAt() location = %s, want UTC", got)
	}
}

func TestRecordRejectsInvalidMovements(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*inventory.Snapshot)
		want   error
	}{
		{"no movement id", func(s *inventory.Snapshot) { s.ID = inventory.MovementID{} }, inventory.ErrInvalidID},
		{"no business", func(s *inventory.Snapshot) { s.BusinessID = business.ID{} }, inventory.ErrInvalidID},
		{"no product", func(s *inventory.Snapshot) { s.ProductID = products.ID{} }, inventory.ErrInvalidID},
		{"no user", func(s *inventory.Snapshot) { s.UserID = users.ID{} }, inventory.ErrInvalidID},
		{"no device", func(s *inventory.Snapshot) { s.DeviceID = devices.ID{} }, inventory.ErrInvalidID},
		{"unknown type", func(s *inventory.Snapshot) { s.Type = "TELEPORT" }, inventory.ErrInvalidMovementType},
		{"empty type", func(s *inventory.Snapshot) { s.Type = "" }, inventory.ErrInvalidMovementType},
		{"a movement of nothing", func(s *inventory.Snapshot) { s.Quantity = quantity.Zero }, inventory.ErrInvalidQuantity},
		{"a negative cost", func(s *inventory.Snapshot) { s.UnitCost = money.FromXAF(-1) }, inventory.ErrInvalidCost},
		{"no occurrence time", func(s *inventory.Snapshot) { s.OccurredAt = time.Time{} }, inventory.ErrInvalidTime},
		{"no record time", func(s *inventory.Snapshot) { s.RecordedAt = time.Time{} }, inventory.ErrInvalidTime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := validSnapshot()
			tc.mutate(&snapshot)

			movement, err := inventory.Record(snapshot)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if movement != nil {
				t.Error("returned a movement alongside an error")
			}
		})
	}
}

// TestASignErrorIsCaughtWhereItIsMade is the reason directions are enforced: a
// purchase that removes stock would otherwise surface as an inexplicable level
// weeks later.
func TestASignErrorIsCaughtWhereItIsMade(t *testing.T) {
	wrong := []struct {
		movement inventory.MovementType
		quantity string
	}{
		{inventory.Purchase, "-10"},
		{inventory.SaleReturn, "-1"},
		{inventory.TransferIn, "-5"},
		{inventory.OpeningBalance, "-1"},
		{inventory.Sale, "3"},
		{inventory.PurchaseReturn, "2"},
		{inventory.Damage, "2"},
		{inventory.TransferOut, "10"},
	}
	for _, tc := range wrong {
		t.Run(string(tc.movement)+" "+tc.quantity, func(t *testing.T) {
			snapshot := validSnapshot()
			snapshot.Type = tc.movement
			snapshot.Quantity = quantity.MustParse(tc.quantity)
			snapshot.Reason = "a reason, in case this type needs one"
			snapshot.Reference = inventory.Reference{Kind: "X", ID: "y"}

			if _, err := inventory.Record(snapshot); !errors.Is(err, inventory.ErrWrongDirection) {
				t.Errorf("got %v, want ErrWrongDirection", err)
			}
		})
	}
}

// TestCorrectionsGoEitherWay: a count can find either more or less than the
// ledger says.
func TestCorrectionsGoEitherWay(t *testing.T) {
	for _, movement := range []inventory.MovementType{inventory.Adjustment, inventory.StockCount} {
		for _, amount := range []string{"5", "-5"} {
			snapshot := validSnapshot()
			snapshot.Type = movement
			snapshot.Quantity = quantity.MustParse(amount)
			snapshot.Reason = "counted the shelf"
			snapshot.Reference = inventory.Reference{}

			if _, err := inventory.Record(snapshot); err != nil {
				t.Errorf("%s of %s was refused: %v", movement, amount, err)
			}
		}
	}
}

// TestCorrectionsAndWriteOffsMustSayWhy is where stock changes without a sale
// or a delivery to explain it (§7, §39).
func TestCorrectionsAndWriteOffsMustSayWhy(t *testing.T) {
	needReason := []inventory.MovementType{inventory.Adjustment, inventory.StockCount, inventory.Damage}
	for _, movement := range needReason {
		t.Run(string(movement), func(t *testing.T) {
			if !movement.RequiresReason() {
				t.Fatalf("%s does not require a reason", movement)
			}
			if !movement.IsSensitive() {
				t.Errorf("%s does not require an audit record", movement)
			}

			snapshot := validSnapshot()
			snapshot.Type = movement
			snapshot.Reference = inventory.Reference{}
			if movement.Direction() == inventory.Outward {
				snapshot.Quantity = quantity.MustParse("-1")
			}

			for _, blank := range []string{"", "   "} {
				snapshot.Reason = blank
				if _, err := inventory.Record(snapshot); !errors.Is(err, inventory.ErrMissingReason) {
					t.Errorf("reason %q: got %v, want ErrMissingReason", blank, err)
				}
			}
		})
	}
}

// TestMovementsFromBusinessEventsMustNameTheirCause: §40 requires movements to
// be traceable.
func TestMovementsFromBusinessEventsMustNameTheirCause(t *testing.T) {
	needReference := []inventory.MovementType{
		inventory.Purchase, inventory.Sale, inventory.SaleReturn,
		inventory.PurchaseReturn, inventory.TransferIn, inventory.TransferOut,
	}
	for _, movement := range needReference {
		t.Run(string(movement), func(t *testing.T) {
			if !movement.RequiresReference() {
				t.Fatalf("%s does not require a reference", movement)
			}

			snapshot := validSnapshot()
			snapshot.Type = movement
			snapshot.Reference = inventory.Reference{}
			if movement.Direction() == inventory.Outward {
				snapshot.Quantity = quantity.MustParse("-1")
			}

			if _, err := inventory.Record(snapshot); !errors.Is(err, inventory.ErrMissingReference) {
				t.Errorf("got %v, want ErrMissingReference", err)
			}
		})
	}
}

func TestAnUnsetCostIsAllowed(t *testing.T) {
	// A sale removes stock at whatever it was bought for, not at a new cost.
	snapshot := validSnapshot()
	snapshot.Type = inventory.Sale
	snapshot.Quantity = quantity.MustParse("-1")
	snapshot.UnitCost = money.Money{}
	snapshot.Reference = inventory.Reference{Kind: "SALE", ID: "s1"}

	movement, err := inventory.Record(snapshot)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if _, recorded := movement.UnitCost(); recorded {
		t.Error("an unset cost was reported as recorded")
	}
}

func TestMovementTypes(t *testing.T) {
	all := inventory.MovementTypes()
	if len(all) != 10 {
		t.Errorf("got %d movement types, want 10", len(all))
	}
	for _, movement := range all {
		if !movement.Defined() {
			t.Errorf("%s is listed but not defined", movement)
		}
		parsed, err := inventory.ParseMovementType(string(movement))
		if err != nil || parsed != movement {
			t.Errorf("round trip of %s gave %s, %v", movement, parsed, err)
		}
		if movement.String() != string(movement) {
			t.Errorf("String() = %q", movement.String())
		}
	}

	for _, input := range []string{"", "sale", "TELEPORT", " SALE"} {
		if _, err := inventory.ParseMovementType(input); !errors.Is(err, inventory.ErrInvalidMovementType) {
			t.Errorf("ParseMovementType(%q): got %v, want ErrInvalidMovementType", input, err)
		}
	}

	mutated := inventory.MovementTypes()
	slices.Reverse(mutated)
	mutated[0] = "tampered"
	if !slices.Equal(inventory.MovementTypes(), all) {
		t.Error("mutating the result changed the registry")
	}
}

func TestReference(t *testing.T) {
	var unset inventory.Reference
	if !unset.IsZero() || unset.String() != "" {
		t.Errorf("the zero Reference is %q", unset.String())
	}

	reference := inventory.Reference{Kind: "SALE", ID: "abc"}
	if reference.IsZero() {
		t.Error("a set Reference reported itself unset")
	}
	if got := reference.String(); got != "SALE:abc" {
		t.Errorf("String() = %q, want SALE:abc", got)
	}
}

func TestMovementScopeAndBranch(t *testing.T) {
	branch := business.NewBranchID()

	snapshot := validSnapshot()
	movement, err := inventory.Record(snapshot)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if _, recorded := movement.BranchID(); recorded {
		t.Error("a movement with no branch reported one")
	}
	if movement.Scope().IsBranchScoped() {
		t.Error("a movement with no branch produced a branch-scoped scope")
	}
	if movement.Scope().Business() != tenant {
		t.Errorf("Scope() business = %s, want %s", movement.Scope().Business(), tenant)
	}

	snapshot.BranchID = branch
	atBranch, err := inventory.Record(snapshot)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if got, recorded := atBranch.BranchID(); !recorded || got != branch {
		t.Errorf("BranchID() = %s, %v", got, recorded)
	}
	if !atBranch.Scope().IsBranchScoped() {
		t.Error("a movement at a branch produced a business-wide scope")
	}
}

func TestRestoreAppliesTheSameRules(t *testing.T) {
	// A movement is never edited, so there is no state a stored one could be in
	// that a new one could not.
	snapshot := validSnapshot()
	if _, err := inventory.Restore(snapshot); err != nil {
		t.Fatalf("Restore rejected a valid snapshot: %v", err)
	}

	snapshot.Type = "TELEPORT"
	if _, err := inventory.Restore(snapshot); !errors.Is(err, inventory.ErrInvalidMovementType) {
		t.Errorf("got %v, want ErrInvalidMovementType", err)
	}
}

func TestMovementIDHelpers(t *testing.T) {
	movementID := inventory.NewMovementID()
	if movementID.IsZero() {
		t.Fatal("NewMovementID produced a zero identifier")
	}
	parsed, err := inventory.ParseMovementID(movementID.String())
	if err != nil || parsed != movementID {
		t.Errorf("round trip gave %s, %v", parsed, err)
	}
	if _, err := inventory.ParseMovementID("nonsense"); err == nil {
		t.Error("ParseMovementID accepted malformed input")
	}
	if inventory.MovementIDFrom(movementID.ID()) != movementID {
		t.Error("MovementIDFrom did not round trip")
	}
	if !strings.Contains(movementID.String(), "-") {
		t.Error("the identifier is not in canonical form")
	}
}

// TestAccessorsReturnWhatWasRecorded covers the plain readers together, since
// each one on its own says little.
func TestAccessorsReturnWhatWasRecorded(t *testing.T) {
	snapshot := validSnapshot()
	snapshot.Type = inventory.Damage
	snapshot.Quantity = quantity.MustParse("-2")
	snapshot.Reason = "water damage"
	snapshot.Reference = inventory.Reference{}

	movement, err := inventory.Record(snapshot)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}

	if got := movement.ID(); got != snapshot.ID {
		t.Errorf("ID() = %s, want %s", got, snapshot.ID)
	}
	if got := movement.BusinessID(); got != tenant {
		t.Errorf("BusinessID() = %s, want %s", got, tenant)
	}
	if got := movement.ProductID(); got != product {
		t.Errorf("ProductID() = %s, want %s", got, product)
	}
	if got := movement.Type(); got != inventory.Damage {
		t.Errorf("Type() = %s, want DAMAGE", got)
	}
	if got := movement.Quantity(); !got.Equal(quantity.MustParse("-2")) {
		t.Errorf("Quantity() = %s, want -2", got)
	}
	if got := movement.Reason(); got != "water damage" {
		t.Errorf("Reason() = %q", got)
	}
	if got := movement.UserID(); got != operator {
		t.Errorf("UserID() = %s, want %s", got, operator)
	}
	if got := movement.DeviceID(); got != till {
		t.Errorf("DeviceID() = %s, want %s", got, till)
	}
	if !movement.IsSensitive() {
		t.Error("a write-off does not require an audit record")
	}
	if _, present := movement.Reference(); present {
		t.Error("an unset reference was reported as present")
	}
}

// TestAnUnknownTypeHasNoFixedDirection covers the fallback: a type that somehow
// reached this code unrecognised is treated as a correction rather than being
// forced one way, since guessing a direction could invert a real movement.
func TestAnUnknownTypeHasNoFixedDirection(t *testing.T) {
	if got := inventory.MovementType("TELEPORT").Direction(); got != inventory.EitherWay {
		t.Errorf("Direction() = %v, want EitherWay", got)
	}
	if inventory.MovementType("TELEPORT").RequiresReason() {
		t.Error("an unknown type claims to require a reason")
	}
	if inventory.MovementType("TELEPORT").RequiresReference() {
		t.Error("an unknown type claims to require a reference")
	}
	if inventory.MovementType("TELEPORT").IsSensitive() {
		t.Error("an unknown type claims to be sensitive")
	}
}
