package auth_test

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
)

func sprint(format string, value any) string { return fmt.Sprintf(format, value) }

func TestNewTokenProducesDistinctSecrets(t *testing.T) {
	const count = 1_000

	seen := make(map[string]struct{}, count)
	for range count {
		token := auth.NewToken()
		if token.IsZero() {
			t.Fatal("NewToken produced an unset token")
		}
		if _, duplicate := seen[token.Secret()]; duplicate {
			t.Fatal("NewToken produced the same secret twice")
		}
		seen[token.Secret()] = struct{}{}
	}
}

func TestNewTokenCarriesFullEntropy(t *testing.T) {
	token := auth.NewToken()

	raw, err := base64.RawURLEncoding.DecodeString(token.Secret())
	if err != nil {
		t.Fatalf("the token is not raw URL base64: %v", err)
	}
	if len(raw) != 32 {
		t.Errorf("the token carries %d bytes, want 32", len(raw))
	}
}

// TestTokenIsRedactedWhenFormatted is the guard that matters most for a bearer
// credential: anything holding it is the user, so an incidental %v in a log
// line must not spill it.
func TestTokenIsRedactedWhenFormatted(t *testing.T) {
	token := auth.NewToken()

	for name, formatted := range map[string]string{
		"String": token.String(),
		"verb v": sprint("%v", token),
		"verb s": sprint("%s", token),
	} {
		if strings.Contains(formatted, token.Secret()) {
			t.Errorf("%s leaked the secret: %s", name, formatted)
		}
		if !strings.Contains(formatted, "redacted") {
			t.Errorf("%s = %q, want it to say the value is redacted", name, formatted)
		}
	}

	// The secret is still reachable deliberately, for handing to its owner.
	if token.Secret() == "" {
		t.Error("Secret() is empty")
	}

	var unset auth.Token
	if got := unset.String(); !strings.Contains(got, "unset") {
		t.Errorf("the zero Token formatted as %q", got)
	}
}

func TestParseToken(t *testing.T) {
	original := auth.NewToken()

	parsed, err := auth.ParseToken(original.Secret())
	if err != nil {
		t.Fatalf("ParseToken: %v", err)
	}
	if parsed.Secret() != original.Secret() {
		t.Error("round trip changed the secret")
	}
	if !parsed.Hash().Matches(original) {
		t.Error("a parsed token does not match the original")
	}

	// Surrounding whitespace from a header is tolerated.
	padded, err := auth.ParseToken("  " + original.Secret() + "  ")
	if err != nil {
		t.Fatalf("ParseToken: %v", err)
	}
	if padded.Secret() != original.Secret() {
		t.Error("padding was not trimmed")
	}
}

func TestParseTokenRejectsMalformedInput(t *testing.T) {
	short := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	long := base64.RawURLEncoding.EncodeToString(make([]byte, 64))

	tests := []struct {
		name  string
		input string
	}{
		{"empty", ""},
		{"whitespace", "   "},
		{"not base64", "not a token!"},
		{"standard base64 padding", strings.Repeat("A", 42) + "=="},
		{"too few bytes", short},
		{"too many bytes", long},
		{"truncated", "abc"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			parsed, err := auth.ParseToken(tc.input)
			if !errors.Is(err, auth.ErrInvalidToken) {
				t.Errorf("ParseToken(%q) = %v, %v; want ErrInvalidToken", tc.input, parsed, err)
			}
			if !parsed.IsZero() {
				t.Error("returned a token alongside an error")
			}
		})
	}
}

func TestTokenHashMatching(t *testing.T) {
	token := auth.NewToken()
	other := auth.NewToken()

	hash := token.Hash()
	if hash.IsZero() {
		t.Fatal("hashing a token produced an unset hash")
	}
	if !hash.Matches(token) {
		t.Error("a token does not match its own hash")
	}
	if hash.Matches(other) {
		t.Error("a different token matched the hash")
	}
	if hash.Matches(auth.Token{}) {
		t.Error("the zero Token matched a hash")
	}
}

// TestHashingIsDeterministic is what lets a stored hash be compared against a
// token presented later.
func TestHashingIsDeterministic(t *testing.T) {
	token := auth.NewToken()

	if token.Hash().String() != token.Hash().String() {
		t.Error("hashing the same token twice gave different values")
	}

	// And a token reconstructed from its text hashes the same way, which is the
	// path a request actually takes.
	parsed, err := auth.ParseToken(token.Secret())
	if err != nil {
		t.Fatalf("ParseToken: %v", err)
	}
	if parsed.Hash().String() != token.Hash().String() {
		t.Error("a parsed token hashed differently from the original")
	}
}

// TestTheStoredHashNeverContainsTheToken keeps a disclosure of the session
// table from yielding credentials.
func TestTheStoredHashNeverContainsTheToken(t *testing.T) {
	token := auth.NewToken()

	stored := token.Hash().String()
	if strings.Contains(stored, token.Secret()) {
		t.Error("the stored hash contains the token")
	}
	if len(stored) != 64 {
		t.Errorf("the stored hash is %d characters, want 64 hexadecimal", len(stored))
	}
}

func TestZeroTokenAndHash(t *testing.T) {
	var token auth.Token
	var hash auth.TokenHash

	if !token.IsZero() || !hash.IsZero() {
		t.Error("the zero values did not report themselves unset")
	}
	if got := token.Secret(); got != "" {
		t.Errorf("Secret() = %q, want empty", got)
	}
	if got := hash.String(); got != "" {
		t.Errorf("String() = %q, want empty", got)
	}
	if !token.Hash().IsZero() {
		t.Error("hashing the zero Token produced a hash")
	}
	// An unset hash must never authenticate anything.
	real := auth.NewToken()
	if hash.Matches(real) || hash.Matches(token) {
		t.Error("the zero TokenHash matched a token")
	}
}

func TestRestoreTokenHash(t *testing.T) {
	token := auth.NewToken()
	original := token.Hash()

	restored, err := auth.RestoreTokenHash(original.String())
	if err != nil {
		t.Fatalf("RestoreTokenHash: %v", err)
	}
	if restored.String() != original.String() {
		t.Errorf("round trip gave %q, want %q", restored, original)
	}
	if !restored.Matches(token) {
		t.Error("a restored hash does not match its token")
	}

	// Case from the database is normalised, so a column written in upper case
	// still matches.
	upper, err := auth.RestoreTokenHash(strings.ToUpper(original.String()))
	if err != nil {
		t.Fatalf("RestoreTokenHash: %v", err)
	}
	if !upper.Matches(token) {
		t.Error("an upper-case stored hash did not match its token")
	}
}

func TestRestoreTokenHashRejectsMalformedInput(t *testing.T) {
	tests := []struct {
		name    string
		encoded string
	}{
		{"empty", ""},
		{"whitespace", "   "},
		{"not hexadecimal", strings.Repeat("z", 64)},
		{"too short", strings.Repeat("a", 32)},
		{"too long", strings.Repeat("a", 128)},
		{"odd length", strings.Repeat("a", 63)},
		{"a raw token", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF_-"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			restored, err := auth.RestoreTokenHash(tc.encoded)
			if !errors.Is(err, auth.ErrInvalidToken) {
				t.Errorf("RestoreTokenHash(%q) = %v, want ErrInvalidToken", tc.encoded, err)
			}
			if !restored.IsZero() {
				t.Error("returned a hash alongside an error")
			}
		})
	}
}

// FuzzParseToken checks that parsing never panics and that anything accepted
// round-trips and hashes consistently.
func FuzzParseToken(f *testing.F) {
	valid := auth.NewToken()
	f.Add(valid.Secret())
	f.Add("")
	f.Add("not a token")
	f.Add(strings.Repeat("A", 43))

	f.Fuzz(func(t *testing.T, input string) {
		parsed, err := auth.ParseToken(input)
		if err != nil {
			if !parsed.IsZero() {
				t.Fatalf("ParseToken(%q) returned a token alongside an error", input)
			}
			return
		}

		if parsed.IsZero() {
			t.Fatalf("ParseToken(%q) accepted the input but produced the zero Token", input)
		}
		if !parsed.Hash().Matches(parsed) {
			t.Fatalf("ParseToken(%q) produced a token that does not match its own hash", input)
		}

		again, err := auth.ParseToken(parsed.Secret())
		if err != nil {
			t.Fatalf("ParseToken rejected its own output: %v", err)
		}
		if again.Secret() != parsed.Secret() {
			t.Fatalf("ParseToken is not idempotent: %q became %q", parsed.Secret(), again.Secret())
		}
	})
}
