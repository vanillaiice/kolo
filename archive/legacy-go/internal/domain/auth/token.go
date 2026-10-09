package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ErrInvalidToken means a token is malformed or of the wrong length.
var ErrInvalidToken = errors.New("auth: invalid token")

// tokenBytes is the size of the secret behind a session token.
//
// 32 bytes is far beyond guessing, which is what lets the stored form be a
// plain digest rather than a slow password hash: unlike a PIN, there is no
// small candidate set to grind through.
const tokenBytes = 32

// Token is the secret a device presents to prove it holds a session.
//
// It is returned exactly once, when the session is issued, and never
// recoverable afterwards — only its hash is kept. The zero Token is unset.
type Token struct {
	secret string
}

// NewToken generates a session token.
//
// It cannot fail. Since Go 1.24 crypto/rand.Read is guaranteed never to return
// an error: if the operating system's randomness is unavailable it terminates
// the program, which is the only sane response to a condition no caller could
// do anything about.
func NewToken() Token {
	raw := make([]byte, tokenBytes)
	rand.Read(raw)
	return Token{secret: base64.RawURLEncoding.EncodeToString(raw)}
}

// ParseToken reads a token presented by a client.
//
// It checks shape only. Whether the token corresponds to a live session is a
// separate question, answered by comparing against a stored hash.
func ParseToken(text string) (Token, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return Token{}, fmt.Errorf("%w: token is empty", ErrInvalidToken)
	}

	raw, err := base64.RawURLEncoding.DecodeString(trimmed)
	if err != nil {
		return Token{}, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}
	if len(raw) != tokenBytes {
		return Token{}, fmt.Errorf("%w: token carries %d bytes, want %d", ErrInvalidToken, len(raw), tokenBytes)
	}
	return Token{secret: trimmed}, nil
}

// IsZero reports whether the token is unset.
func (t Token) IsZero() bool { return t.secret == "" }

// Secret returns the token text, to be handed to the client that owns it.
//
// It is named Secret rather than String so that a token cannot be leaked into a
// log line by an incidental %v or %s — see String.
func (t Token) Secret() string { return t.secret }

// String implements fmt.Stringer with a redacted form.
//
// A session token is a bearer credential: anything holding it is the user.
// Formatting one into a log line or an error message would put it somewhere it
// outlives its usefulness, so the obvious accessor deliberately hides it.
func (t Token) String() string {
	if t.IsZero() {
		return "auth.Token{unset}"
	}
	return "auth.Token{redacted}"
}

// Hash returns the stored form of the token.
func (t Token) Hash() TokenHash {
	if t.IsZero() {
		return TokenHash{}
	}
	digest := sha256.Sum256([]byte(t.secret))
	return TokenHash{digest: hex.EncodeToString(digest[:])}
}

// TokenHash is the stored form of a session token.
//
// It is a plain SHA-256 digest rather than a slow password hash. That is
// correct here and would be wrong for a PIN: a token has 32 bytes of entropy,
// so there is nothing to guess, and the digest is checked on every request
// where a deliberately slow hash would be a denial of service against
// ourselves.
//
// The zero TokenHash is unset and matches nothing.
type TokenHash struct {
	digest string
}

// RestoreTokenHash rebuilds a stored hash read back from the database.
func RestoreTokenHash(encoded string) (TokenHash, error) {
	trimmed := strings.TrimSpace(encoded)
	if trimmed == "" {
		return TokenHash{}, fmt.Errorf("%w: stored hash is empty", ErrInvalidToken)
	}
	raw, err := hex.DecodeString(trimmed)
	if err != nil {
		return TokenHash{}, fmt.Errorf("%w: stored hash is not hexadecimal: %w", ErrInvalidToken, err)
	}
	if len(raw) != sha256.Size {
		return TokenHash{}, fmt.Errorf("%w: stored hash carries %d bytes, want %d",
			ErrInvalidToken, len(raw), sha256.Size)
	}
	return TokenHash{digest: strings.ToLower(trimmed)}, nil
}

// String returns the stored digest, for persistence. Unlike a token, a hash is
// not a credential and is safe to print.
func (h TokenHash) String() string { return h.digest }

// IsZero reports whether the hash is unset.
func (h TokenHash) IsZero() bool { return h.digest == "" }

// Matches reports whether a token hashes to this value.
//
// The comparison is constant-time. A timing difference here would let an
// attacker recover a valid token one byte at a time, which is the one attack a
// high-entropy secret is otherwise immune to.
func (h TokenHash) Matches(token Token) bool {
	if h.IsZero() || token.IsZero() {
		return false
	}
	candidate := token.Hash()
	return subtle.ConstantTimeCompare([]byte(h.digest), []byte(candidate.digest)) == 1
}
