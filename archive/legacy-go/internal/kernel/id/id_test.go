package id_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
)

// V7 must satisfy the interface services depend on.
var _ id.Generator = id.V7{}

func TestNewProducesAVersion7Identifier(t *testing.T) {
	generated := id.New()

	if generated == id.Nil {
		t.Fatal("New returned the nil identifier")
	}
	if got := generated.Version().String(); got != "VERSION_7" {
		t.Errorf("Version() = %s, want VERSION_7", got)
	}
	if got := generated.Variant().String(); got != "RFC4122" {
		t.Errorf("Variant() = %s, want RFC4122", got)
	}
}

func TestV7GeneratorProducesDistinctIdentifiers(t *testing.T) {
	var generator id.V7

	const count = 10_000
	seen := make(map[id.ID]struct{}, count)
	for i := range count {
		generated, err := generator.New()
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if _, duplicate := seen[generated]; duplicate {
			t.Fatalf("identifier %s repeated at position %d", generated, i)
		}
		seen[generated] = struct{}{}
	}
}

// TestV7IdentifiersSortInCreationOrder is the property sync relies on for
// ordering hints, and that both databases rely on for index locality. It must
// hold across a burst large enough to exhaust the intra-millisecond counter.
func TestV7IdentifiersSortInCreationOrder(t *testing.T) {
	var generator id.V7

	const count = 20_000
	previous, err := generator.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for i := 1; i < count; i++ {
		current, err := generator.New()
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if bytes.Compare(previous[:], current[:]) >= 0 {
			t.Fatalf("identifier %d (%s) does not sort after %d (%s)", i, current, i-1, previous)
		}
		previous = current
	}
}

func TestV7IsSafeForConcurrentUse(t *testing.T) {
	var generator id.V7

	const workers, perWorker = 8, 1_000
	var (
		mu        sync.Mutex
		wait      sync.WaitGroup
		collected = make([]id.ID, 0, workers*perWorker)
	)
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			local := make([]id.ID, 0, perWorker)
			for range perWorker {
				generated, err := generator.New()
				if err != nil {
					t.Errorf("New: %v", err)
					return
				}
				local = append(local, generated)
			}
			mu.Lock()
			collected = append(collected, local...)
			mu.Unlock()
		}()
	}
	wait.Wait()

	seen := make(map[id.ID]struct{}, len(collected))
	for _, generated := range collected {
		if _, duplicate := seen[generated]; duplicate {
			t.Fatalf("identifier %s generated twice", generated)
		}
		seen[generated] = struct{}{}
	}
	if len(seen) != workers*perWorker {
		t.Errorf("got %d distinct identifiers, want %d", len(seen), workers*perWorker)
	}
}

func TestStringIsCanonical(t *testing.T) {
	text := id.New().String()

	if len(text) != 36 {
		t.Fatalf("String() = %q, want 36 characters", text)
	}
	if text[8] != '-' || text[13] != '-' || text[18] != '-' || text[23] != '-' {
		t.Errorf("String() = %q, want 8-4-4-4-12 grouping", text)
	}
	if text != strings.ToLower(text) {
		t.Errorf("String() = %q, want lower case", text)
	}
}

// TestParseNormalisesEverySpelling is the property that keeps sync idempotent:
// an event resent in a different spelling must resolve to the identifier
// already applied, not to a second one (ADR-006).
func TestParseNormalisesEverySpelling(t *testing.T) {
	canonical := "0198c2d4-1e00-7000-abab-ababababab00"
	want := id.MustParse(canonical)

	spellings := map[string]string{
		"canonical":    canonical,
		"upper case":   strings.ToUpper(canonical),
		"mixed case":   "0198C2D4-1e00-7000-ABAB-ababababab00",
		"braced":       "{" + canonical + "}",
		"urn":          "urn:uuid:" + canonical,
		"unhyphenated": strings.ReplaceAll(canonical, "-", ""),
	}
	for name, spelling := range spellings {
		t.Run(name, func(t *testing.T) {
			parsed, err := id.Parse(spelling)
			if err != nil {
				t.Fatalf("Parse(%q): %v", spelling, err)
			}
			if parsed != want {
				t.Errorf("Parse(%q) = %s, want %s", spelling, parsed, want)
			}
			if got := parsed.String(); got != canonical {
				t.Errorf("Parse(%q).String() = %q, want the canonical %q", spelling, got, canonical)
			}
		})
	}
}

func TestParseRejectsMalformedInput(t *testing.T) {
	valid := "0198c2d4-1e00-7000-abab-ababababab00"

	tests := []struct {
		name  string
		input string
	}{
		{"empty", ""},
		{"whitespace", "   "},
		{"too short", "0198c2d4-1e00-7000-abab-ababababab0"},
		{"too long", valid + "0"},
		{"non-hexadecimal", "0198c2d4-1e00-7000-abab-abababababzz"},
		{"misplaced separators", "0198c2d41-e00-7000-abab-ababababab00"},
		{"leading space", " " + valid},
		{"trailing space", valid + " "},
		{"embedded newline", "0198c2d4-1e00-7000-abab-ababababab0\n"},
		{"prose", "not-an-identifier"},
		{"wrong urn scheme", "urn:oid:" + valid},
		{"half braced", "{" + valid},
		{"nul byte", valid[:35] + "\x00"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := id.Parse(tc.input); err == nil {
				t.Errorf("Parse(%q) succeeded, want an error", tc.input)
			}
		})
	}
}

func TestParseRoundTrip(t *testing.T) {
	for range 100 {
		original := id.New()

		parsed, err := id.Parse(original.String())
		if err != nil {
			t.Fatalf("Parse: %v", err)
		}
		if parsed != original {
			t.Errorf("round trip gave %s, want %s", parsed, original)
		}
	}
}

func TestMustParse(t *testing.T) {
	valid := "0198c2d4-1e00-7000-abab-ababababab00"
	if got := id.MustParse(valid).String(); got != valid {
		t.Errorf("MustParse(%q).String() = %q", valid, got)
	}

	defer func() {
		if recover() == nil {
			t.Error("MustParse did not panic on invalid input")
		}
	}()
	id.MustParse("nope")
}

func TestJSONRoundTrip(t *testing.T) {
	type envelope struct {
		EventID id.ID `json:"event_id"`
	}
	original := envelope{EventID: id.New()}

	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if want := `{"event_id":"` + original.EventID.String() + `"}`; string(encoded) != want {
		t.Errorf("encoded as %s, want %s", encoded, want)
	}

	var decoded envelope
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.EventID != original.EventID {
		t.Errorf("round trip gave %s, want %s", decoded.EventID, original.EventID)
	}
}

func TestUnmarshalJSONRejectsMalformedIdentifier(t *testing.T) {
	for _, input := range []string{`"not-an-identifier"`, `""`, `"0198c2d4"`} {
		var decoded id.ID
		if err := json.Unmarshal([]byte(input), &decoded); err == nil {
			t.Errorf("Unmarshal(%s) succeeded, want an error", input)
		}
	}
}

func TestNilIdentifier(t *testing.T) {
	if got := id.Nil.String(); got != "00000000-0000-0000-0000-000000000000" {
		t.Errorf("Nil.String() = %q", got)
	}
	if id.New() == id.Nil {
		t.Error("New returned the nil identifier")
	}

	// The nil identifier must survive a round trip, so a genuinely unset field
	// stays unset rather than becoming a parse error.
	parsed, err := id.Parse(id.Nil.String())
	if err != nil {
		t.Fatalf("Parse(nil identifier): %v", err)
	}
	if parsed != id.Nil {
		t.Errorf("round trip gave %s, want the nil identifier", parsed)
	}
}

// FuzzParse checks that parsing never panics on arbitrary input and that any
// value it accepts round-trips through its canonical form.
func FuzzParse(f *testing.F) {
	f.Add("0198c2d4-1e00-7000-abab-ababababab00")
	f.Add("{0198c2d4-1e00-7000-abab-ababababab00}")
	f.Add("urn:uuid:0198c2d4-1e00-7000-abab-ababababab00")
	f.Add("0198c2d41e007000ababababababab00")
	f.Add("00000000-0000-0000-0000-000000000000")
	f.Add("")
	f.Add("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz")

	f.Fuzz(func(t *testing.T, input string) {
		parsed, err := id.Parse(input)
		if err != nil {
			return
		}

		canonical := parsed.String()
		reparsed, err := id.Parse(canonical)
		if err != nil {
			t.Fatalf("Parse rejected the canonical form %q of an accepted input %q: %v", canonical, input, err)
		}
		if reparsed != parsed {
			t.Fatalf("Parse(%q) = %s but re-parsing its canonical form gave %s", input, parsed, reparsed)
		}
	})
}
