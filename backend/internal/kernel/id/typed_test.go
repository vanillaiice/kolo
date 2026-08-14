package id_test

import (
	"encoding/json"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id/idtest"
)

// Two tags standing in for two entity kinds, as a domain package would declare.
type (
	productTag struct{}
	saleTag    struct{}
)

type (
	productID = id.Typed[productTag]
	saleID    = id.Typed[saleTag]
)

func TestNewTypedProducesDistinctIdentifiers(t *testing.T) {
	const count = 1_000
	seen := make(map[productID]struct{}, count)
	for range count {
		generated := id.NewTyped[productTag]()
		if generated.IsZero() {
			t.Fatal("NewTyped returned the zero identifier")
		}
		if _, duplicate := seen[generated]; duplicate {
			t.Fatalf("identifier %s generated twice", generated)
		}
		seen[generated] = struct{}{}
	}
}

// TestTypedIdentifiersAreUsableAsMapKeys is worth pinning: repositories index
// entities by identifier, and a type that lost comparability would break that
// without any obvious signal.
func TestTypedIdentifiersAreUsableAsMapKeys(t *testing.T) {
	first := id.NewTyped[productTag]()
	second := id.NewTyped[productTag]()

	index := map[productID]string{first: "first", second: "second"}

	if got := index[first]; got != "first" {
		t.Errorf("index[first] = %q, want %q", got, "first")
	}
	if len(index) != 2 {
		t.Errorf("index holds %d entries, want 2", len(index))
	}
	if first == second {
		t.Error("two generated identifiers compared equal")
	}
}

// TestTypedFromCarriesTheUnderlyingIdentifier covers the path a service takes:
// draw from an injected Generator, then tag the result.
func TestTypedFromCarriesTheUnderlyingIdentifier(t *testing.T) {
	generator := idtest.NewSequence()

	generated, err := generator.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	tagged := id.TypedFrom[productTag](generated)

	if got := tagged.ID(); got != generated {
		t.Errorf("ID() = %s, want %s", got, generated)
	}
	if got, want := tagged.String(), generated.String(); got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
}

func TestTypedFromTheNilIdentifierIsZero(t *testing.T) {
	tagged := id.TypedFrom[productTag](id.Nil)

	if !tagged.IsZero() {
		t.Error("tagging the nil identifier did not produce a zero value")
	}

	var unset productID
	if tagged != unset {
		t.Error("tagging the nil identifier differs from the zero value")
	}
}

func TestZeroTypedIdentifier(t *testing.T) {
	var unset productID

	if !unset.IsZero() {
		t.Error("the zero value did not report itself as unset")
	}
	if got := unset.ID(); got != id.Nil {
		t.Errorf("ID() = %s, want the nil identifier", got)
	}
	if got := unset.String(); got != "00000000-0000-0000-0000-000000000000" {
		t.Errorf("String() = %q", got)
	}
}

func TestParseTyped(t *testing.T) {
	canonical := "0198c2d4-1e00-7000-abab-ababababab00"

	parsed, err := id.ParseTyped[productTag](canonical)
	if err != nil {
		t.Fatalf("ParseTyped: %v", err)
	}
	if got := parsed.String(); got != canonical {
		t.Errorf("String() = %q, want %q", got, canonical)
	}

	// Parsing normalises, exactly as the untagged parser does.
	braced, err := id.ParseTyped[productTag]("{" + canonical + "}")
	if err != nil {
		t.Fatalf("ParseTyped: %v", err)
	}
	if braced != parsed {
		t.Errorf("a braced spelling parsed to %s, want %s", braced, parsed)
	}
}

func TestParseTypedRejectsMalformedInput(t *testing.T) {
	for _, input := range []string{"", "nonsense", "0198c2d4", "0198c2d4-1e00-7000-abab-abababababzz"} {
		t.Run(input, func(t *testing.T) {
			parsed, err := id.ParseTyped[productTag](input)
			if err == nil {
				t.Fatalf("ParseTyped(%q) succeeded, giving %s", input, parsed)
			}
			if !parsed.IsZero() {
				t.Errorf("returned %s alongside an error", parsed)
			}
		})
	}
}

func TestMustParseTyped(t *testing.T) {
	canonical := "0198c2d4-1e00-7000-abab-ababababab00"
	if got := id.MustParseTyped[productTag](canonical).String(); got != canonical {
		t.Errorf("MustParseTyped = %q, want %q", got, canonical)
	}

	defer func() {
		if recover() == nil {
			t.Error("MustParseTyped did not panic on invalid input")
		}
	}()
	id.MustParseTyped[productTag]("nope")
}

// TestTypedIdentifiersEncodeLikePlainOnes is what keeps storage and the sync
// wire format unaffected by the tagging.
func TestTypedIdentifiersEncodeLikePlainOnes(t *testing.T) {
	underlying := id.New()
	tagged := id.TypedFrom[productTag](underlying)

	taggedJSON, err := json.Marshal(tagged)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	plainJSON, err := json.Marshal(underlying)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(taggedJSON) != string(plainJSON) {
		t.Errorf("tagged encoded as %s, plain as %s", taggedJSON, plainJSON)
	}
}

func TestTypedJSONRoundTrip(t *testing.T) {
	type envelope struct {
		Product productID `json:"product_id"`
		Sale    saleID    `json:"sale_id"`
	}
	original := envelope{
		Product: id.NewTyped[productTag](),
		Sale:    id.NewTyped[saleTag](),
	}

	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded envelope
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded != original {
		t.Errorf("round trip gave %+v, want %+v", decoded, original)
	}
}

func TestTypedUnmarshalRejectsMalformedInput(t *testing.T) {
	for _, input := range []string{`"nonsense"`, `""`, `"0198c2d4"`} {
		var decoded productID
		if err := json.Unmarshal([]byte(input), &decoded); err == nil {
			t.Errorf("Unmarshal(%s) succeeded, giving %s", input, decoded)
		}
	}
}

// TestFailedUnmarshalLeavesTheTargetUntouched keeps a half-decoded identifier
// from being mistaken for a real one.
func TestFailedUnmarshalLeavesTheTargetUntouched(t *testing.T) {
	existing := id.NewTyped[productTag]()
	decoded := existing

	if err := json.Unmarshal([]byte(`"nonsense"`), &decoded); err == nil {
		t.Fatal("Unmarshal succeeded, want an error")
	}
	if decoded != existing {
		t.Errorf("a failed decode changed the identifier to %s, want %s", decoded, existing)
	}
}

func TestTypedCompare(t *testing.T) {
	lower := id.MustParseTyped[productTag]("0198c2d4-1e00-7000-abab-ababababab00")
	higher := id.MustParseTyped[productTag]("0198c2d4-1e00-7000-abab-ababababab01")

	if got := lower.Compare(higher); got != -1 {
		t.Errorf("Compare(lower, higher) = %d, want -1", got)
	}
	if got := higher.Compare(lower); got != 1 {
		t.Errorf("Compare(higher, lower) = %d, want 1", got)
	}
	if got := lower.Compare(lower); got != 0 {
		t.Errorf("Compare(x, x) = %d, want 0", got)
	}
}

// TestTypedComparePreservesCreationOrder matters because identifiers are the
// primary keys of large local tables and sync uses their order as a hint.
func TestTypedComparePreservesCreationOrder(t *testing.T) {
	previous := id.NewTyped[productTag]()
	for i := 1; i < 1_000; i++ {
		current := id.NewTyped[productTag]()
		if previous.Compare(current) >= 0 {
			t.Fatalf("identifier %d (%s) does not sort after %s", i, current, previous)
		}
		previous = current
	}
}

// TestTagsDoNotInterchange is the reason the type exists. The assignments below
// are commented out because they must not compile; the runtime check confirms
// the two tags stay distinct types rather than collapsing to one.
func TestTagsDoNotInterchange(t *testing.T) {
	product := id.NewTyped[productTag]()
	sale := id.NewTyped[saleTag]()

	// var wrong productID = sale        // must not compile
	// product.Compare(sale)             // must not compile

	if any(product) == any(sale) {
		t.Error("identifiers with different tags compared equal as interface values")
	}

	// Two tagged identifiers over the same underlying value stay distinct types
	// while agreeing on the value they carry.
	underlying := id.New()
	asProduct := id.TypedFrom[productTag](underlying)
	asSale := id.TypedFrom[saleTag](underlying)

	if asProduct.ID() != asSale.ID() {
		t.Error("the same underlying identifier differed between tags")
	}
	if any(asProduct) == any(asSale) {
		t.Error("differently tagged identifiers are the same type")
	}
}
