package clock_test

import (
	"sync"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/kernel/clock"
)

// Clocks must satisfy the interface the domain depends on.
var (
	_ clock.Clock = clock.System{}
	_ clock.Clock = (*clock.Fixed)(nil)
)

func TestSystemReportsUTC(t *testing.T) {
	now := clock.System{}.Now()

	if got := now.Location(); got != time.UTC {
		t.Errorf("Now() location = %s, want UTC", got)
	}
	if time.Since(now) > time.Minute {
		t.Errorf("Now() = %s, which is not close to the current time", now)
	}
}

func TestFixedConvertsToUTC(t *testing.T) {
	// A device configured for Cameroon reports WAT, one hour ahead of UTC.
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	local := time.Date(2026, 8, 14, 10, 30, 0, 0, wat)

	fixed := clock.NewFixed(local)

	now := fixed.Now()
	if got := now.Location(); got != time.UTC {
		t.Errorf("Now() location = %s, want UTC", got)
	}
	if want := time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC); !now.Equal(want) {
		t.Errorf("Now() = %s, want %s", now, want)
	}
}

func TestFixedDoesNotMoveOnItsOwn(t *testing.T) {
	instant := time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	fixed := clock.NewFixed(instant)

	first := fixed.Now()
	second := fixed.Now()

	if !first.Equal(second) || !first.Equal(instant) {
		t.Errorf("Now() returned %s then %s, want %s both times", first, second, instant)
	}
}

func TestFixedAdvance(t *testing.T) {
	instant := time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	fixed := clock.NewFixed(instant)

	fixed.Advance(90 * time.Minute)
	if want := instant.Add(90 * time.Minute); !fixed.Now().Equal(want) {
		t.Errorf("after advancing: Now() = %s, want %s", fixed.Now(), want)
	}

	// A negative step models a clock correction on a device.
	fixed.Advance(-2 * time.Hour)
	if want := instant.Add(-30 * time.Minute); !fixed.Now().Equal(want) {
		t.Errorf("after stepping back: Now() = %s, want %s", fixed.Now(), want)
	}
}

func TestFixedSet(t *testing.T) {
	fixed := clock.NewFixed(time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC))

	target := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	fixed.Set(target)

	if !fixed.Now().Equal(target) {
		t.Errorf("Now() = %s, want %s", fixed.Now(), target)
	}
}

func TestFixedIsSafeForConcurrentUse(t *testing.T) {
	fixed := clock.NewFixed(time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC))

	var wait sync.WaitGroup
	for range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for range 200 {
				fixed.Advance(time.Millisecond)
				_ = fixed.Now()
			}
		}()
	}
	wait.Wait()

	if want := time.Date(2026, 8, 14, 9, 30, 1, 600_000_000, time.UTC); !fixed.Now().Equal(want) {
		t.Errorf("Now() = %s, want %s", fixed.Now(), want)
	}
}
