// Package clock provides an injectable source of the current time.
//
// Time is a domain input here, not an ambient fact. Transactions retain their
// original timestamps (SPECIFICATION.md §40), sync orders events by time, and
// reports slice by period — so every one of those behaviours needs to be
// testable at a chosen instant rather than at whatever time the suite happens
// to run.
//
// All clocks report UTC. Devices in the field sit in one timezone today, but
// events from several devices are merged on the server, and a timestamp is only
// comparable across devices if it carries no local offset. Presenting a time in
// the user's timezone is a concern of the presentation edge.
package clock

import (
	"sync"
	"time"
)

// Clock reports the current time.
type Clock interface {
	Now() time.Time
}

// System reads the operating system clock.
type System struct{}

// Now returns the current time in UTC.
func (System) Now() time.Time { return time.Now().UTC() }

// Fixed is a clock under the caller's control, for tests. It is safe for
// concurrent use.
type Fixed struct {
	mu      sync.Mutex
	current time.Time
}

// NewFixed returns a clock stopped at the given instant, converted to UTC.
func NewFixed(at time.Time) *Fixed {
	return &Fixed{current: at.UTC()}
}

// Now returns the clock's current instant without advancing it.
func (f *Fixed) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.current
}

// Advance moves the clock forward by d. A negative d moves it backwards, which
// is how a clock correction on a device is simulated.
func (f *Fixed) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = f.current.Add(d)
}

// Set moves the clock to the given instant, converted to UTC.
func (f *Fixed) Set(at time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current = at.UTC()
}
