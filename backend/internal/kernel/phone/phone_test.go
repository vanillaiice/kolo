package phone_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

// TestParseNormalisesEverySpelling is the property the whole type exists for:
// one number written many ways must resolve to one value, or a user fails to
// log in and a customer is recorded twice.
func TestParseNormalisesEverySpelling(t *testing.T) {
	const want = "+237677123456"

	spellings := map[string]string{
		"e164":                    "+237677123456",
		"national":                "677123456",
		"national with spaces":    "677 123 456",
		"national with dashes":    "677-123-456",
		"national with dots":      "677.123.456",
		"international spaced":    "+237 677 123 456",
		"international grouped":   "+237 (677) 123-456",
		"double zero prefix":      "00237677123456",
		"double zero with spaces": "00237 677 123 456",
		"surrounding whitespace":  "  +237677123456  ",
		"trailing newline":        "677123456\n",
		"slash separated":         "677/123/456",
	}
	for name, spelling := range spellings {
		t.Run(name, func(t *testing.T) {
			parsed, err := phone.Parse(spelling)
			if err != nil {
				t.Fatalf("Parse(%q): %v", spelling, err)
			}
			if got := parsed.String(); got != want {
				t.Errorf("Parse(%q) = %q, want %q", spelling, got, want)
			}
		})
	}
}

func TestParseAcceptsRealCameroonNumbers(t *testing.T) {
	// Cameroon mobile numbers are nine digits beginning with 6.
	valid := []string{
		"677123456", // MTN
		"699887766",
		"655443322", // Orange
		"694000111",
		"233421234", // Douala landline
	}
	for _, input := range valid {
		t.Run(input, func(t *testing.T) {
			parsed, err := phone.Parse(input)
			if err != nil {
				t.Fatalf("Parse(%q): %v", input, err)
			}
			if !strings.HasPrefix(parsed.String(), "+237") {
				t.Errorf("Parse(%q) = %q, want a +237 number", input, parsed)
			}
			if got := parsed.Region(); got != "CM" {
				t.Errorf("Region() = %q, want CM", got)
			}
		})
	}
}

func TestParseRejectsInvalidInput(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"empty", ""},
		{"whitespace", "   "},
		{"letters", "not a number"},
		{"too short", "677"},
		{"too long", "6771234567890123"},
		{"all zeroes", "000000000"},
		{"invalid cameroon prefix", "177123456"},
		{"punctuation only", "+++"},
		{"just a plus", "+"},
		{"unknown country code", "+999677123456"},

		// libphonenumber would extract a number from each of these. A field
		// someone typed on purpose should not accept them, because a slip would
		// silently become a valid but different number.
		{"nul byte", "677123456\x00"},
		{"embedded newline", "677\n123456"},
		{"embedded tab", "677\t123\t456"},
		{"emoji", "📞677123456"},
		{"letters around the digits", "call me on 677123456"},
		{"trailing extension", "677123456 ext. 12"},
		{"leading name", "Jean 677123456"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			parsed, err := phone.Parse(tc.input)
			if !errors.Is(err, phone.ErrInvalidNumber) {
				t.Errorf("Parse(%q) = %q, %v; want ErrInvalidNumber", tc.input, parsed, err)
			}
			if !parsed.IsZero() {
				t.Errorf("returned %q alongside an error", parsed)
			}
		})
	}
}

// TestParseRejectsPlausibleButUndialableNumbers guards a real trap: the parser
// accepts strings that merely look like numbers, so validity has to be checked
// separately or nonsense reaches storage.
func TestParseRejectsPlausibleButUndialableNumbers(t *testing.T) {
	// Syntactically a Cameroon number, but 1 is not an allocated mobile prefix.
	if parsed, err := phone.Parse("+237111111111"); !errors.Is(err, phone.ErrInvalidNumber) {
		t.Errorf("Parse of an unallocated prefix = %q, %v; want ErrInvalidNumber", parsed, err)
	}
}

func TestParseRegion(t *testing.T) {
	// A French number written locally resolves only under its own region.
	parsed, err := phone.ParseRegion("06 12 34 56 78", "FR")
	if err != nil {
		t.Fatalf("ParseRegion: %v", err)
	}
	if got, want := parsed.String(), "+33612345678"; got != want {
		t.Errorf("ParseRegion = %q, want %q", got, want)
	}
	if got := parsed.Region(); got != "FR" {
		t.Errorf("Region() = %q, want FR", got)
	}

	// The region is case- and whitespace-insensitive.
	lower, err := phone.ParseRegion("06 12 34 56 78", "  fr ")
	if err != nil {
		t.Fatalf("ParseRegion: %v", err)
	}
	if !lower.Equal(parsed) {
		t.Errorf("a lower-case region gave %q, want %q", lower, parsed)
	}
}

// TestParseRegionIsIgnoredForInternationalNumbers matters because stored
// numbers are always E.164 and must not be reinterpreted against whatever
// region the caller happens to pass.
func TestParseRegionIsIgnoredForInternationalNumbers(t *testing.T) {
	const cameroonian = "+237677123456"

	for _, region := range []string{"CM", "FR", "US", "GB"} {
		parsed, err := phone.ParseRegion(cameroonian, region)
		if err != nil {
			t.Fatalf("ParseRegion(%q, %q): %v", cameroonian, region, err)
		}
		if got := parsed.String(); got != cameroonian {
			t.Errorf("under region %q the number became %q", region, got)
		}
	}
}

func TestParseRegionRejectsUnknownRegions(t *testing.T) {
	for _, region := range []string{"", "ZZ", "XX", "CAM", "1"} {
		t.Run(region, func(t *testing.T) {
			parsed, err := phone.ParseRegion("677123456", region)
			if !errors.Is(err, phone.ErrUnknownRegion) {
				t.Errorf("got %q, %v; want ErrUnknownRegion", parsed, err)
			}
		})
	}
}

func TestMustParse(t *testing.T) {
	if got := phone.MustParse("677123456").String(); got != "+237677123456" {
		t.Errorf("MustParse = %q", got)
	}

	defer func() {
		if recover() == nil {
			t.Error("MustParse did not panic on invalid input")
		}
	}()
	phone.MustParse("nope")
}

func TestZeroNumber(t *testing.T) {
	var unset phone.Number

	if !unset.IsZero() {
		t.Error("the zero Number did not report itself unset")
	}
	if got := unset.String(); got != "" {
		t.Errorf("String() = %q, want empty", got)
	}
	if got := unset.National(); got != "" {
		t.Errorf("National() = %q, want empty", got)
	}
	if got := unset.International(); got != "" {
		t.Errorf("International() = %q, want empty", got)
	}
	if got := unset.Region(); got != "" {
		t.Errorf("Region() = %q, want empty", got)
	}
	if !unset.Equal(phone.Number{}) {
		t.Error("two zero Numbers compared unequal")
	}
	if unset.Equal(phone.MustParse("677123456")) {
		t.Error("the zero Number compared equal to a real one")
	}
}

func TestDisplayFormats(t *testing.T) {
	parsed := phone.MustParse("677123456")

	if got, want := parsed.National(), "6 77 12 34 56"; got != want {
		t.Errorf("National() = %q, want %q", got, want)
	}
	if got, want := parsed.International(), "+237 6 77 12 34 56"; got != want {
		t.Errorf("International() = %q, want %q", got, want)
	}
	// Storage form stays E.164 regardless.
	if got, want := parsed.String(), "+237677123456"; got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
}

func TestEqualIgnoresOriginalSpelling(t *testing.T) {
	local := phone.MustParse("677 123 456")
	international := phone.MustParse("+237677123456")
	doubleZero := phone.MustParse("00237677123456")

	if !local.Equal(international) || !international.Equal(doubleZero) {
		t.Error("the same number written differently compared unequal")
	}
	if local.Equal(phone.MustParse("699887766")) {
		t.Error("different numbers compared equal")
	}
}

// TestNumberIsUsableAsAMapKey covers how a repository will index users by
// login identity.
func TestNumberIsUsableAsAMapKey(t *testing.T) {
	index := map[phone.Number]string{
		phone.MustParse("677123456"): "Jean",
		phone.MustParse("699887766"): "Marie",
	}

	// A differently spelled version of the same number must find the entry.
	if got := index[phone.MustParse("+237 677 123 456")]; got != "Jean" {
		t.Errorf("lookup by another spelling gave %q, want %q", got, "Jean")
	}
	if len(index) != 2 {
		t.Errorf("index holds %d entries, want 2", len(index))
	}
}

func TestJSONRoundTrip(t *testing.T) {
	type contact struct {
		Phone phone.Number `json:"phone"`
	}
	original := contact{Phone: phone.MustParse("677 123 456")}

	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if want := `{"phone":"+237677123456"}`; string(encoded) != want {
		t.Errorf("Marshal = %s, want %s", encoded, want)
	}

	var decoded contact
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !decoded.Phone.Equal(original.Phone) {
		t.Errorf("round trip gave %q, want %q", decoded.Phone, original.Phone)
	}
}

// TestUnsetNumberEncodesAsNull keeps an absent contact detail distinguishable
// from a blank one, which matters for an optional customer phone (§12).
func TestUnsetNumberEncodesAsNull(t *testing.T) {
	type contact struct {
		Phone phone.Number `json:"phone"`
	}

	const asNull = `{"phone":null}`

	encoded, err := json.Marshal(contact{})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(encoded) != asNull {
		t.Errorf("Marshal = %s, want %s", encoded, asNull)
	}

	var decoded contact
	if err := json.Unmarshal([]byte(asNull), &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !decoded.Phone.IsZero() {
		t.Errorf("a null decoded to %q, want the zero Number", decoded.Phone)
	}
}

func TestUnmarshalJSONRejectsMalformedInput(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"not a number", `"nonsense"`},
		{"too short", `"677"`},
		{"unallocated prefix", `"+237111111111"`},
		{"numeric", `677123456`},
		{"object", `{"e164":"+237677123456"}`},
		{"array", `["+237677123456"]`},
		{"truncated", `"+237677123456`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var decoded phone.Number
			if err := json.Unmarshal([]byte(tc.input), &decoded); err == nil {
				t.Errorf("Unmarshal(%s) succeeded, giving %q", tc.input, decoded)
			}
		})
	}
}

// TestBlankAndAbsentBothDecodeToUnset pins the two ways a missing number
// arrives: an explicit blank clears the value, and a null leaves it alone, as
// encoding/json expects.
func TestBlankAndAbsentBothDecodeToUnset(t *testing.T) {
	var blank phone.Number
	if err := json.Unmarshal([]byte(`""`), &blank); err != nil {
		t.Fatalf(`Unmarshal(""): %v`, err)
	}
	if !blank.IsZero() {
		t.Errorf(`an empty string decoded to %q, want the zero Number`, blank)
	}

	existing := phone.MustParse("677123456")
	untouched := existing
	if err := json.Unmarshal([]byte(`null`), &untouched); err != nil {
		t.Fatalf("Unmarshal(null): %v", err)
	}
	if !untouched.Equal(existing) {
		t.Errorf("a null changed the number to %q, want %q", untouched, existing)
	}
}

// TestFailedUnmarshalLeavesTheTargetUntouched keeps a half-decoded value from
// being mistaken for a real number.
func TestFailedUnmarshalLeavesTheTargetUntouched(t *testing.T) {
	existing := phone.MustParse("677123456")
	decoded := existing

	if err := json.Unmarshal([]byte(`"nonsense"`), &decoded); err == nil {
		t.Fatal("Unmarshal succeeded, want an error")
	}
	if !decoded.Equal(existing) {
		t.Errorf("a failed decode changed the number to %q", decoded)
	}
}

func TestTextRoundTrip(t *testing.T) {
	original := phone.MustParse("699 887 766")

	text, err := original.MarshalText()
	if err != nil {
		t.Fatalf("MarshalText: %v", err)
	}

	var decoded phone.Number
	if err := decoded.UnmarshalText(text); err != nil {
		t.Fatalf("UnmarshalText: %v", err)
	}
	if !decoded.Equal(original) {
		t.Errorf("round trip gave %q, want %q", decoded, original)
	}

	// Empty text clears the value rather than failing, matching how an absent
	// column reads back.
	var cleared phone.Number
	if err := cleared.UnmarshalText(nil); err != nil {
		t.Fatalf("UnmarshalText(nil): %v", err)
	}
	if !cleared.IsZero() {
		t.Errorf("empty text decoded to %q, want the zero Number", cleared)
	}
}

// FuzzParse checks that parsing never panics and that anything accepted is
// already normalised: re-parsing its own output must be a no-op.
func FuzzParse(f *testing.F) {
	f.Add("677123456")
	f.Add("+237677123456")
	f.Add("00237 677 123 456")
	f.Add("")
	f.Add("+")
	f.Add("nonsense")
	f.Add("+999999999999999999999")

	f.Fuzz(func(t *testing.T, input string) {
		parsed, err := phone.Parse(input)
		if err != nil {
			if !parsed.IsZero() {
				t.Fatalf("Parse(%q) returned %q alongside an error", input, parsed)
			}
			return
		}

		if parsed.IsZero() {
			t.Fatalf("Parse(%q) accepted the input but produced the zero Number", input)
		}
		if !strings.HasPrefix(parsed.String(), "+") {
			t.Fatalf("Parse(%q) = %q, which is not in E.164 form", input, parsed)
		}

		again, err := phone.Parse(parsed.String())
		if err != nil {
			t.Fatalf("Parse rejected its own output %q: %v", parsed, err)
		}
		if !again.Equal(parsed) {
			t.Fatalf("Parse is not idempotent: %q became %q", parsed, again)
		}
	})
}
