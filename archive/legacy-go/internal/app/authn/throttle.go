package authn

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrTooManyAttempts means an account has been locked after repeated failures.
//
// It carries how long to wait, so a client can say something useful rather than
// inviting the person to keep trying.
var ErrTooManyAttempts = errors.New("authn: too many failed attempts")

// Throttling defaults.
//
// A PIN is one of ten thousand values, so the hash alone is not what protects
// it (ADR-012). Throttling is. These numbers are chosen to make guessing
// hopeless while barely inconveniencing someone who mistyped: five tries free,
// then a wait that doubles, so ten wrong PINs already costs minutes and a
// hundred costs longer than anyone will sit through.
const (
	// DefaultAttemptAllowance is how many failures are tolerated before the
	// first lockout.
	DefaultAttemptAllowance = 5
	// DefaultLockout is how long the first lockout lasts.
	DefaultLockout = 30 * time.Second
	// DefaultMaxLockout caps the doubling, so an account is never locked for so
	// long that a shop cannot trade after the owner sorts it out.
	DefaultMaxLockout = 15 * time.Minute
	// DefaultAttemptWindow is how long a run of failures is remembered. A
	// mistyped PIN this morning should not count against someone this evening.
	DefaultAttemptWindow = time.Hour
)

// AttemptLimiter decides whether a login may be attempted.
//
// It is keyed by whatever the caller considers one target. The service keys by
// business and phone number, so guessing one person's PIN cannot lock out their
// colleagues, and so attempts against the same person from different devices
// still add up.
type AttemptLimiter interface {
	// Allow reports whether an attempt may proceed, and if not, how long to
	// wait.
	Allow(key string, now time.Time) (retryAfter time.Duration, allowed bool)
	// RecordFailure notes an attempt that did not succeed.
	RecordFailure(key string, now time.Time)
	// RecordSuccess clears the record for a key.
	RecordSuccess(key string)
}

// LimiterOptions configures an InMemoryLimiter. Every field has a default.
type LimiterOptions struct {
	Allowance     int
	Lockout       time.Duration
	MaxLockout    time.Duration
	AttemptWindow time.Duration
}

// InMemoryLimiter throttles attempts in the process's own memory.
//
// It is deliberately not shared between backend instances. A shared limiter
// would need a round trip to a store on every login, on the path that must stay
// fast, and would fail closed or fail open at exactly the wrong moment when
// that store was unreachable. Per-instance throttling still makes guessing
// hopeless: an attacker would have to spread attempts across instances and
// would be slowed by every one of them.
//
// A deployment behind many instances that wants a single shared count can
// supply its own AttemptLimiter.
type InMemoryLimiter struct {
	mu       sync.Mutex
	attempts map[string]*attemptRecord

	allowance  int
	lockout    time.Duration
	maxLockout time.Duration
	window     time.Duration
}

type attemptRecord struct {
	failures  int
	lastAt    time.Time
	lockUntil time.Time
}

// NewInMemoryLimiter returns a limiter using the given options.
func NewInMemoryLimiter(options LimiterOptions) *InMemoryLimiter {
	limiter := &InMemoryLimiter{
		attempts:   make(map[string]*attemptRecord),
		allowance:  options.Allowance,
		lockout:    options.Lockout,
		maxLockout: options.MaxLockout,
		window:     options.AttemptWindow,
	}
	if limiter.allowance <= 0 {
		limiter.allowance = DefaultAttemptAllowance
	}
	if limiter.lockout <= 0 {
		limiter.lockout = DefaultLockout
	}
	if limiter.maxLockout <= 0 {
		limiter.maxLockout = DefaultMaxLockout
	}
	if limiter.window <= 0 {
		limiter.window = DefaultAttemptWindow
	}
	return limiter
}

// Allow reports whether an attempt may proceed.
func (l *InMemoryLimiter) Allow(key string, now time.Time) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	record, found := l.attempts[key]
	if !found {
		return 0, true
	}
	if l.hasLapsed(record, now) {
		delete(l.attempts, key)
		return 0, true
	}
	if now.Before(record.lockUntil) {
		return record.lockUntil.Sub(now), false
	}
	return 0, true
}

// RecordFailure notes a failed attempt, locking the key once the allowance is
// spent.
func (l *InMemoryLimiter) RecordFailure(key string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()

	// Opportunistic cleanup, so a long-running process does not accumulate a
	// record for every number ever tried against it.
	l.forgetLapsed(now)

	record, found := l.attempts[key]
	if !found || l.hasLapsed(record, now) {
		record = &attemptRecord{}
		l.attempts[key] = record
	}

	record.failures++
	record.lastAt = now

	if record.failures > l.allowance {
		record.lockUntil = now.Add(l.backoff(record.failures))
	}
}

// RecordSuccess clears a key, so someone who eventually remembers their PIN is
// not still serving a lockout.
func (l *InMemoryLimiter) RecordSuccess(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, key)
}

// backoff returns the lockout for a given number of failures, doubling with
// each one past the allowance and capped.
func (l *InMemoryLimiter) backoff(failures int) time.Duration {
	excess := failures - l.allowance - 1
	if excess < 0 {
		excess = 0
	}
	// Cap the shift before computing it: doubling an unbounded number of times
	// would overflow the duration and wrap to something short.
	const maxShift = 32
	if excess > maxShift {
		return l.maxLockout
	}

	wait := l.lockout << uint(excess)
	if wait <= 0 || wait > l.maxLockout {
		return l.maxLockout
	}
	return wait
}

// hasLapsed reports whether a record is old enough to forget. A record that is
// still locked is never forgotten, or waiting out a lockout would be a way to
// clear it early.
func (l *InMemoryLimiter) hasLapsed(record *attemptRecord, now time.Time) bool {
	if now.Before(record.lockUntil) {
		return false
	}
	return now.Sub(record.lastAt) > l.window
}

func (l *InMemoryLimiter) forgetLapsed(now time.Time) {
	for key, record := range l.attempts {
		if l.hasLapsed(record, now) {
			delete(l.attempts, key)
		}
	}
}

// Tracked reports how many keys the limiter is currently holding.
//
// It is exported so a deployment can watch it: a number that only grows means
// the sweep is not keeping up, which is worth knowing before it becomes a
// memory problem.
func (l *InMemoryLimiter) Tracked() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.attempts)
}

// attemptKey names the target of a login attempt.
//
// Keying by business and phone number means guessing at one person's PIN cannot
// lock out their colleagues, and that attempts from several devices against the
// same person still add up — which is the case worth stopping.
func attemptKey(request LoginRequest) string {
	return request.BusinessID.String() + "/" + request.Phone.String()
}

// retryAfterError carries how long a locked-out caller should wait.
type retryAfterError struct {
	after time.Duration
}

func (e retryAfterError) Error() string {
	return fmt.Sprintf("%s: try again in %s", ErrTooManyAttempts, e.after.Round(time.Second))
}

func (e retryAfterError) Is(target error) bool { return target == ErrTooManyAttempts }

// RetryAfter returns how long to wait before retrying, and whether the error
// says to wait at all.
func RetryAfter(err error) (time.Duration, bool) {
	var locked retryAfterError
	if errors.As(err, &locked) {
		return locked.after, true
	}
	return 0, false
}
