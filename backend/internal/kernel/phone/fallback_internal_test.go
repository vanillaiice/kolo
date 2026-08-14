package phone

import "testing"

// A Number that carries something other than a valid E.164 string cannot be
// produced through the package's own API — Parse is the only way in, and it
// stores what the library gave back. These tests reach inside to build one
// anyway, so the defensive branches in the display accessors are exercised and
// their fallback behaviour is stated rather than assumed.
//
// The behaviour that matters: a corrupt value must degrade to something
// readable on a display path, never panic and never silently become a
// different number.

func TestDisplayAccessorsDegradeOnACorruptValue(t *testing.T) {
	corrupt := Number{e164: "not-a-number"}

	if corrupt.IsZero() {
		t.Fatal("the corrupt value reported itself unset, so nothing is being tested")
	}

	if got := corrupt.Region(); got != "" {
		t.Errorf("Region() = %q, want empty for an unreadable number", got)
	}
	if got := corrupt.National(); got != "not-a-number" {
		t.Errorf("National() = %q, want the stored value as a fallback", got)
	}
	if got := corrupt.International(); got != "not-a-number" {
		t.Errorf("International() = %q, want the stored value as a fallback", got)
	}
	if got := corrupt.String(); got != "not-a-number" {
		t.Errorf("String() = %q, want the stored value", got)
	}
}

func TestRereadReportsFailureForBothUnsetAndCorruptValues(t *testing.T) {
	tests := []struct {
		name   string
		number Number
	}{
		{"unset", Number{}},
		{"corrupt", Number{e164: "not-a-number"}},
		{"digits without a country code", Number{e164: "677123456"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := tc.number.reread(); ok {
				t.Error("reread reported success")
			}
		})
	}

	valid := MustParse("677123456")
	if _, ok := valid.reread(); !ok {
		t.Error("reread failed for a number this package produced")
	}
}

// TestACorruptValueStillRoundTripsAsText keeps a bad record from being lost on
// its way back out to storage, so it can be found and fixed.
func TestACorruptValueStillRoundTripsAsText(t *testing.T) {
	corrupt := Number{e164: "not-a-number"}

	text, err := corrupt.MarshalText()
	if err != nil {
		t.Fatalf("MarshalText: %v", err)
	}
	if string(text) != "not-a-number" {
		t.Errorf("MarshalText = %q, want the stored value", text)
	}

	// Reading it back is where it must be rejected, so the bad value cannot
	// re-enter the system through the front door.
	var decoded Number
	if err := decoded.UnmarshalText(text); err == nil {
		t.Error("UnmarshalText accepted a corrupt value")
	}
}
