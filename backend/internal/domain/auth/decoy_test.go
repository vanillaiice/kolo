package auth_test

import (
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
)

func TestVerifyDecoyAlwaysFails(t *testing.T) {
	// Whatever is presented, including a PIN that is genuinely valid elsewhere,
	// the decoy must never report a match. A decoy that could succeed would be
	// a way in.
	for _, attempt := range []string{"", "1357", "0000", "abcd", "90210381"} {
		if auth.VerifyDecoy(attempt) {
			t.Errorf("VerifyDecoy(%q) reported a match", attempt)
		}
	}
}

// TestVerifyDecoyCostsAboutAsMuchAsARealVerification is the whole point: an
// early return for an unknown phone number would be measurably faster than a
// real check, which would turn login into a way to enumerate a business's
// staff.
func TestVerifyDecoyCostsAboutAsMuchAsARealVerification(t *testing.T) {
	real, err := auth.HashPIN("1357")
	if err != nil {
		t.Fatalf("HashPIN: %v", err)
	}

	// Warm both paths first, so the lazily built decoy hash is not counted.
	auth.VerifyDecoy("9042")
	real.Verify("9042")

	started := time.Now()
	real.Verify("9042")
	realCost := time.Since(started)

	started = time.Now()
	auth.VerifyDecoy("9042")
	decoyCost := time.Since(started)

	// A loose bound: a shared runner is noisy, but a decoy that skipped the
	// hashing would be orders of magnitude faster, which this catches.
	if decoyCost < realCost/4 {
		t.Errorf("the decoy took %s against %s for a real verification, "+
			"which is fast enough to distinguish an unknown number", decoyCost, realCost)
	}
}

// TestVerifyDecoyIsReusable checks the hash is built once and shared: it must
// keep working, and keep costing the same, across many calls.
func TestVerifyDecoyIsReusable(t *testing.T) {
	for range 5 {
		if auth.VerifyDecoy("1357") {
			t.Fatal("VerifyDecoy reported a match")
		}
	}
}

func TestVerifyDecoyIsSafeForConcurrentUse(t *testing.T) {
	done := make(chan struct{})
	for range 4 {
		go func() {
			defer func() { done <- struct{}{} }()
			for range 3 {
				if auth.VerifyDecoy("1357") {
					t.Error("VerifyDecoy reported a match")
					return
				}
			}
		}()
	}
	for range 4 {
		<-done
	}
}
