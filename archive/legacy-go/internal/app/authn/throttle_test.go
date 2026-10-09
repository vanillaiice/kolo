package authn_test

import (
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

// A PIN is one of ten thousand values, so throttling is what actually protects
// it (ADR-012). These tests treat that as the security property it is rather
// than as a nicety.

func TestLimiterAllowsUntilTheAllowanceIsSpent(t *testing.T) {
	limiter := authn.NewInMemoryLimiter(authn.LimiterOptions{Allowance: 3, Lockout: time.Minute})
	now := loginAt

	for attempt := 1; attempt <= 3; attempt++ {
		if _, allowed := limiter.Allow("key", now); !allowed {
			t.Fatalf("attempt %d was refused while still within the allowance", attempt)
		}
		limiter.RecordFailure("key", now)
	}

	// The allowance is spent; the next failure locks it.
	if _, allowed := limiter.Allow("key", now); !allowed {
		t.Error("the attempt immediately after the allowance was refused, want one more")
	}
	limiter.RecordFailure("key", now)

	retryAfter, allowed := limiter.Allow("key", now)
	if allowed {
		t.Fatal("attempts are still allowed past the allowance")
	}
	if retryAfter <= 0 {
		t.Errorf("retryAfter = %s, want a positive wait", retryAfter)
	}
}

func TestLockoutLiftsWhenItExpires(t *testing.T) {
	limiter := authn.NewInMemoryLimiter(authn.LimiterOptions{Allowance: 1, Lockout: time.Minute})
	now := loginAt

	limiter.RecordFailure("key", now)
	limiter.RecordFailure("key", now)

	retryAfter, allowed := limiter.Allow("key", now)
	if allowed {
		t.Fatal("the key was not locked")
	}

	if _, allowed := limiter.Allow("key", now.Add(retryAfter-time.Second)); allowed {
		t.Error("the lockout lifted early")
	}
	if _, allowed := limiter.Allow("key", now.Add(retryAfter)); !allowed {
		t.Error("the lockout did not lift when it expired")
	}
}

// TestLockoutsLengthen is what makes sustained guessing hopeless: ten wrong
// PINs already cost minutes.
func TestLockoutsLengthen(t *testing.T) {
	limiter := authn.NewInMemoryLimiter(authn.LimiterOptions{
		Allowance:  1,
		Lockout:    time.Second,
		MaxLockout: time.Hour,
	})
	now := loginAt

	limiter.RecordFailure("key", now)

	var previous time.Duration
	for range 5 {
		limiter.RecordFailure("key", now)

		retryAfter, allowed := limiter.Allow("key", now)
		if allowed {
			t.Fatal("the key is not locked")
		}
		if retryAfter <= previous {
			t.Errorf("the wait went from %s to %s, want it to grow", previous, retryAfter)
		}
		previous = retryAfter
	}
}

// TestTheLockoutIsCapped keeps a shop from being locked out for so long that it
// cannot trade once the owner has sorted the problem.
func TestTheLockoutIsCapped(t *testing.T) {
	const cap = 5 * time.Minute
	limiter := authn.NewInMemoryLimiter(authn.LimiterOptions{
		Allowance:  1,
		Lockout:    time.Second,
		MaxLockout: cap,
	})
	now := loginAt

	for range 200 {
		limiter.RecordFailure("key", now)
	}

	retryAfter, allowed := limiter.Allow("key", now)
	if allowed {
		t.Fatal("the key is not locked")
	}
	if retryAfter > cap {
		t.Errorf("retryAfter = %s, want no more than the cap of %s", retryAfter, cap)
	}
	// And it must not have overflowed into something short.
	if retryAfter <= 0 {
		t.Errorf("retryAfter = %s, which suggests the doubling wrapped", retryAfter)
	}
}

func TestSuccessClearsTheRecord(t *testing.T) {
	limiter := authn.NewInMemoryLimiter(authn.LimiterOptions{Allowance: 1, Lockout: time.Minute})
	now := loginAt

	limiter.RecordFailure("key", now)
	limiter.RecordFailure("key", now)
	if _, allowed := limiter.Allow("key", now); allowed {
		t.Fatal("the key is not locked")
	}

	limiter.RecordSuccess("key")

	if _, allowed := limiter.Allow("key", now); !allowed {
		t.Error("the key is still locked after a success")
	}
}

// TestOldFailuresAreForgotten keeps a mistyped PIN this morning from counting
// against someone this evening.
func TestOldFailuresAreForgotten(t *testing.T) {
	limiter := authn.NewInMemoryLimiter(authn.LimiterOptions{
		Allowance:     1,
		Lockout:       time.Second,
		AttemptWindow: time.Hour,
	})
	now := loginAt

	limiter.RecordFailure("key", now)

	// A single failure much later starts a fresh run rather than compounding.
	later := now.Add(2 * time.Hour)
	limiter.RecordFailure("key", later)
	if _, allowed := limiter.Allow("key", later); !allowed {
		t.Error("a failure after the window still counted against the earlier one")
	}
}

// TestWaitingOutALockoutDoesNotClearIt guards the obvious way round it: if a
// locked record were forgotten as stale, sitting still would reset the count.
func TestWaitingOutALockoutDoesNotClearIt(t *testing.T) {
	limiter := authn.NewInMemoryLimiter(authn.LimiterOptions{
		Allowance: 1,
		Lockout:   4 * time.Hour,
		// Raised past the default cap, or the lockout under test would be
		// shortened to fifteen minutes and would have expired by the time the
		// assertion runs.
		MaxLockout:    4 * time.Hour,
		AttemptWindow: time.Hour,
	})
	now := loginAt

	limiter.RecordFailure("key", now)
	limiter.RecordFailure("key", now)

	// Well past the attempt window, but still inside the lockout.
	stillLocked := now.Add(2 * time.Hour)
	if _, allowed := limiter.Allow("key", stillLocked); allowed {
		t.Error("the lockout was forgotten as stale while it was still in force")
	}
}

// TestKeysAreIndependent means guessing at one person's PIN cannot lock out
// their colleagues.
func TestKeysAreIndependent(t *testing.T) {
	limiter := authn.NewInMemoryLimiter(authn.LimiterOptions{Allowance: 1, Lockout: time.Minute})
	now := loginAt

	limiter.RecordFailure("victim", now)
	limiter.RecordFailure("victim", now)

	if _, allowed := limiter.Allow("victim", now); allowed {
		t.Fatal("the targeted key is not locked")
	}
	if _, allowed := limiter.Allow("colleague", now); !allowed {
		t.Error("an unrelated key was locked out")
	}
}

// TestLapsedRecordsAreForgotten keeps a long-running process from holding a
// record for every number ever tried against it.
func TestLapsedRecordsAreForgotten(t *testing.T) {
	limiter := authn.NewInMemoryLimiter(authn.LimiterOptions{
		Allowance:     10,
		AttemptWindow: time.Hour,
	})
	now := loginAt

	for i := range 100 {
		limiter.RecordFailure(string(rune('a'+i%26))+time.Duration(i).String(), now)
	}
	if got := limiter.Tracked(); got == 0 {
		t.Fatal("nothing was recorded, so nothing is being tested")
	}

	// One failure long afterwards should sweep the lapsed ones away.
	limiter.RecordFailure("fresh", now.Add(4*time.Hour))

	if got := limiter.Tracked(); got != 1 {
		t.Errorf("the limiter holds %d records, want only the fresh one", got)
	}
}

func TestLimiterIsSafeForConcurrentUse(t *testing.T) {
	limiter := authn.NewInMemoryLimiter(authn.LimiterOptions{Allowance: 2, Lockout: time.Minute})
	now := loginAt

	done := make(chan struct{})
	for worker := range 8 {
		go func() {
			defer func() { done <- struct{}{} }()
			key := string(rune('a' + worker))
			for range 50 {
				limiter.Allow(key, now)
				limiter.RecordFailure(key, now)
				limiter.Allow("shared", now)
				limiter.RecordFailure("shared", now)
			}
			limiter.RecordSuccess(key)
		}()
	}
	for range 8 {
		<-done
	}

	if _, allowed := limiter.Allow("shared", now); allowed {
		t.Error("the shared key was never locked despite hundreds of failures")
	}
}

// TestLoginIsThrottled is the property that matters, seen through the service:
// repeated wrong PINs stop being answered.
func TestLoginIsThrottled(t *testing.T) {
	f := newFixtureWithLimiter(t, authn.NewInMemoryLimiter(authn.LimiterOptions{
		Allowance: 2,
		Lockout:   time.Minute,
	}))

	wrong := f.request()
	wrong.PIN = wrongPIN

	for attempt := 1; attempt <= 3; attempt++ {
		if _, err := f.service.Login(f.ctx, wrong); !errors.Is(err, authn.ErrInvalidCredentials) {
			t.Fatalf("attempt %d: got %v, want ErrInvalidCredentials", attempt, err)
		}
	}

	_, err := f.service.Login(f.ctx, wrong)
	if !errors.Is(err, authn.ErrTooManyAttempts) {
		t.Fatalf("got %v, want ErrTooManyAttempts", err)
	}

	retryAfter, carried := authn.RetryAfter(err)
	if !carried {
		t.Fatal("the error does not say how long to wait")
	}
	if retryAfter <= 0 {
		t.Errorf("retryAfter = %s, want a positive wait", retryAfter)
	}
}

// TestThrottlingBlocksEvenTheCorrectPIN is the point of checking it first: a
// locked-out caller must not be able to keep the server hashing, and must not
// discover the PIN by finally guessing it during a lockout.
func TestThrottlingBlocksEvenTheCorrectPIN(t *testing.T) {
	f := newFixtureWithLimiter(t, authn.NewInMemoryLimiter(authn.LimiterOptions{
		Allowance: 1,
		Lockout:   time.Minute,
	}))

	wrong := f.request()
	wrong.PIN = wrongPIN
	for range 2 {
		if _, err := f.service.Login(f.ctx, wrong); !errors.Is(err, authn.ErrInvalidCredentials) {
			t.Fatalf("got %v, want ErrInvalidCredentials", err)
		}
	}

	if _, err := f.service.Login(f.ctx, f.request()); !errors.Is(err, authn.ErrTooManyAttempts) {
		t.Errorf("the correct PIN was accepted during a lockout: %v", err)
	}
}

// TestASuccessfulLoginClearsTheLockout means someone who eventually remembers
// their PIN is not still serving a penalty.
func TestASuccessfulLoginClearsTheLockout(t *testing.T) {
	f := newFixtureWithLimiter(t, authn.NewInMemoryLimiter(authn.LimiterOptions{
		Allowance: 3,
		Lockout:   time.Minute,
	}))

	wrong := f.request()
	wrong.PIN = wrongPIN
	for range 3 {
		if _, err := f.service.Login(f.ctx, wrong); !errors.Is(err, authn.ErrInvalidCredentials) {
			t.Fatalf("got %v, want ErrInvalidCredentials", err)
		}
	}

	if _, err := f.service.Login(f.ctx, f.request()); err != nil {
		t.Fatalf("the correct PIN was refused before any lockout: %v", err)
	}

	// The record is cleared, so the full allowance is available again.
	for attempt := range 3 {
		if _, err := f.service.Login(f.ctx, wrong); !errors.Is(err, authn.ErrInvalidCredentials) {
			t.Fatalf("attempt %d after a success: got %v, want ErrInvalidCredentials", attempt, err)
		}
	}
}

// TestThrottlingIsPerAccount keeps an attacker from locking a whole business
// out by guessing at one person.
func TestThrottlingIsPerAccount(t *testing.T) {
	f := newFixtureWithLimiter(t, authn.NewInMemoryLimiter(authn.LimiterOptions{
		Allowance: 1,
		Lockout:   time.Minute,
	}))

	// Lock out a number that is not registered, as an attacker probing would.
	probe := f.request()
	probe.Phone = phone.MustParse("699000111")
	for range 3 {
		f.service.Login(f.ctx, probe)
	}
	if _, err := f.service.Login(f.ctx, probe); !errors.Is(err, authn.ErrTooManyAttempts) {
		t.Fatalf("the probed number is not locked: %v", err)
	}

	// The real user is unaffected.
	if _, err := f.service.Login(f.ctx, f.request()); err != nil {
		t.Errorf("a real login was blocked by attempts against another number: %v", err)
	}
}

// TestThrottlingIsPerBusiness follows from keying by tenant: one business's
// failures must not lock the same number out of another business.
func TestThrottlingIsPerBusiness(t *testing.T) {
	f := newFixtureWithLimiter(t, authn.NewInMemoryLimiter(authn.LimiterOptions{
		Allowance: 1,
		Lockout:   time.Minute,
	}))

	elsewhere := f.request()
	elsewhere.BusinessID = business.NewID()
	elsewhere.PIN = wrongPIN
	for range 3 {
		f.service.Login(f.ctx, elsewhere)
	}
	if _, err := f.service.Login(f.ctx, elsewhere); !errors.Is(err, authn.ErrTooManyAttempts) {
		t.Fatalf("the other business is not locked: %v", err)
	}

	if _, err := f.service.Login(f.ctx, f.request()); err != nil {
		t.Errorf("a login was blocked by attempts against another business: %v", err)
	}
}

func TestRetryAfterIgnoresOtherErrors(t *testing.T) {
	if _, carried := authn.RetryAfter(authn.ErrInvalidCredentials); carried {
		t.Error("RetryAfter claimed a wait for an unrelated error")
	}
	if _, carried := authn.RetryAfter(nil); carried {
		t.Error("RetryAfter claimed a wait for no error")
	}
}
