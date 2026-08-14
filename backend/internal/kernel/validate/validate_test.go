package validate_test

import (
	"errors"
	"strings"
	"testing"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

func TestName(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string // empty means the input must be rejected
	}{
		{"plain", "Boutique Chez Jean", "Boutique Chez Jean"},
		{"trimmed", "  Boutique Chez Jean  ", "Boutique Chez Jean"},
		{"newline trimmed from the edges", "\nBoutique\t", "Boutique"},
		{"accented", "Épicerie Générale", "Épicerie Générale"},
		{"inner spaces kept", "Chez  Jean", "Chez  Jean"},
		{"punctuation", "Jean & Fils (Douala)", "Jean & Fils (Douala)"},
		{"apostrophe", "L'Épicerie d'Akwa", "L'Épicerie d'Akwa"},
		{"digits", "Boutique 24/7", "Boutique 24/7"},
		{"single character", "J", "J"},
		{"emoji", "Boutique 🍌", "Boutique 🍌"},
		{"non-latin script", "متجر", "متجر"},
		{"at the length limit", strings.Repeat("é", validate.MaxNameLength), strings.Repeat("é", validate.MaxNameLength)},

		{"empty", "", ""},
		{"only whitespace", " \t\r\n ", ""},
		{"past the length limit", strings.Repeat("a", validate.MaxNameLength+1), ""},
		{"embedded newline", "Boutique\nChez Jean", ""},
		{"embedded tab", "Boutique\tChez Jean", ""},
		{"embedded carriage return", "Boutique\rChez Jean", ""},
		{"nul byte", "Boutique\x00", ""},
		{"bell character", "Boutique\a", ""},
		{"escape character", "Boutique\x1b[31m", ""},
		{"delete character", "Boutique\x7f", ""},
		{"invalid utf-8", "Boutique\xff", ""},
		{"lone surrogate encoding", "Boutique\xed\xa0\x80", ""},

		// Invisible characters make two names render identically while
		// comparing differently, and a bidi override can make a receipt show a
		// name other than the one stored.
		{"left-to-right mark", "Boutique\u200e", ""},
		{"zero-width space", "Bou\u200btique", ""},
		{"zero-width non-joiner", "Bou\u200ctique", ""},
		{"zero-width joiner", "Bou\u200dtique", ""},
		{"right-to-left override", "Boutique\u202e", ""},
		{"word joiner", "Bou\u2060tique", ""},
		{"soft hyphen", "Bou\u00adtique", ""},
		{"private use character", "Boutique\ue000", ""},
		{"byte order mark", "\ufeffBoutique", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := validate.Name(tc.input)

			if tc.want == "" {
				if !errors.Is(err, validate.ErrInvalidName) {
					t.Errorf("validate.Name(%q) = %q, %v; want ErrInvalidName", tc.input, got, err)
				}
				if got != "" {
					t.Errorf("returned %q alongside an error", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("validate.Name(%q): %v", tc.input, err)
			}
			if got != tc.want {
				t.Errorf("validate.Name(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

// TestNameLengthIsCountedInRunesNotBytes matters for the target market: French
// accents must not cost a business half its allowance.
func TestNameLengthIsCountedInRunesNotBytes(t *testing.T) {
	atLimit := strings.Repeat("é", validate.MaxNameLength)
	if len(atLimit) <= validate.MaxNameLength {
		t.Fatalf("the test name is %d bytes, expected it to exceed the rune limit", len(atLimit))
	}
	if _, err := validate.Name(atLimit); err != nil {
		t.Errorf("a name at the rune limit was rejected: %v", err)
	}

	pastLimit := strings.Repeat("é", validate.MaxNameLength+1)
	if _, err := validate.Name(pastLimit); !errors.Is(err, validate.ErrInvalidName) {
		t.Errorf("a name past the rune limit was accepted: %v", err)
	}
}

// TestNameIsMeasuredAfterTrimming keeps padding from pushing an otherwise legal
// name over the limit.
func TestNameIsMeasuredAfterTrimming(t *testing.T) {
	padded := "   " + strings.Repeat("a", validate.MaxNameLength) + "   "

	got, err := validate.Name(padded)
	if err != nil {
		t.Fatalf("validate.Name: %v", err)
	}
	if len(got) != validate.MaxNameLength {
		t.Errorf("got a name of %d characters, want %d", len(got), validate.MaxNameLength)
	}
}

func TestNameIsIdempotent(t *testing.T) {
	once, err := validate.Name("  Boutique Chez Jean  ")
	if err != nil {
		t.Fatalf("validate.Name: %v", err)
	}
	twice, err := validate.Name(once)
	if err != nil {
		t.Fatalf("validate.Name: %v", err)
	}
	if twice != once {
		t.Errorf("validating a cleaned name changed it from %q to %q", once, twice)
	}
}

func TestMoment(t *testing.T) {
	if err := validate.Moment(time.Now(), "creation time"); err != nil {
		t.Errorf("a set timestamp was rejected: %v", err)
	}

	err := validate.Moment(time.Time{}, "creation time")
	if !errors.Is(err, validate.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if !strings.Contains(err.Error(), "creation time") {
		t.Errorf("error %q does not name the offending field", err)
	}
}

func TestTimestamps(t *testing.T) {
	created := time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

	tests := []struct {
		name      string
		createdAt time.Time
		updatedAt time.Time
		wantErr   bool
	}{
		{"created then updated", created, created.Add(time.Hour), false},
		{"created and updated together", created, created, false},
		{"updated a nanosecond later", created, created.Add(time.Nanosecond), false},
		{"zero creation", time.Time{}, created, true},
		{"zero update", created, time.Time{}, true},
		{"both zero", time.Time{}, time.Time{}, true},
		{"updated before created", created, created.Add(-time.Nanosecond), true},
		{"updated long before created", created, created.Add(-24 * time.Hour), true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validate.Timestamps(tc.createdAt, tc.updatedAt)

			if tc.wantErr {
				if !errors.Is(err, validate.ErrInvalidTime) {
					t.Errorf("got %v, want ErrInvalidTime", err)
				}
				return
			}
			if err != nil {
				t.Errorf("got %v, want nil", err)
			}
		})
	}
}

// TestTimestampsComparesInstantsNotWallClocks checks that the same instant in
// two zones is not mistaken for an inconsistency, which would reject records
// from a device reporting local time.
func TestTimestampsComparesInstantsNotWallClocks(t *testing.T) {
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	created := time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	sameMomentInWAT := created.In(wat)

	if err := validate.Timestamps(created, sameMomentInWAT); err != nil {
		t.Errorf("the same instant in another zone was rejected: %v", err)
	}
	if err := validate.Timestamps(sameMomentInWAT, created); err != nil {
		t.Errorf("the same instant in another zone was rejected: %v", err)
	}
}

// FuzzName checks that validation never panics and that whatever it accepts is
// stable, trimmed, and free of invisible characters.
func FuzzName(f *testing.F) {
	f.Add("Boutique Chez Jean")
	f.Add("  Épicerie  ")
	f.Add("")
	f.Add("Bou​tique")
	f.Add("Boutique\xff")
	f.Add(strings.Repeat("a", 200))

	f.Fuzz(func(t *testing.T, input string) {
		cleaned, err := validate.Name(input)
		if err != nil {
			if cleaned != "" {
				t.Fatalf("validate.Name(%q) returned %q alongside an error", input, cleaned)
			}
			return
		}

		if cleaned == "" {
			t.Fatalf("validate.Name(%q) accepted an empty result", input)
		}
		if strings.TrimSpace(cleaned) != cleaned {
			t.Fatalf("validate.Name(%q) = %q, which is not trimmed", input, cleaned)
		}
		if !utf8.ValidString(cleaned) {
			t.Fatalf("validate.Name(%q) = %q, which is not valid UTF-8", input, cleaned)
		}
		for _, character := range cleaned {
			if unicode.In(character, unicode.C) {
				t.Fatalf("validate.Name(%q) = %q, which contains %U", input, cleaned, character)
			}
		}
		if length := len([]rune(cleaned)); length > validate.MaxNameLength {
			t.Fatalf("validate.Name(%q) = a name of %d characters, past the limit", input, length)
		}

		// Re-validating an accepted name must be a no-op.
		again, err := validate.Name(cleaned)
		if err != nil {
			t.Fatalf("validate.Name rejected its own output %q: %v", cleaned, err)
		}
		if again != cleaned {
			t.Fatalf("validate.Name is not idempotent: %q became %q", cleaned, again)
		}
	})
}
