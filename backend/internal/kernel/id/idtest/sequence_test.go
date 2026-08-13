package idtest_test

import (
	"bytes"
	"sync"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id/idtest"
)

// Sequence must be usable wherever a service expects a generator.
var _ id.Generator = (*idtest.Sequence)(nil)

func TestSequenceIsPredictable(t *testing.T) {
	sequence := idtest.NewSequence()

	want := []string{
		"00000000-0000-7000-8000-000000000001",
		"00000000-0000-7000-8000-000000000002",
		"00000000-0000-7000-8000-000000000003",
	}
	for i, expected := range want {
		generated, err := sequence.New()
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if got := generated.String(); got != expected {
			t.Errorf("identifier %d = %s, want %s", i, got, expected)
		}
	}
}

func TestSequenceRestartsPerInstance(t *testing.T) {
	first, err := idtest.NewSequence().New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	second, err := idtest.NewSequence().New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if first != second {
		t.Errorf("two fresh sequences produced %s and %s, want the same first value", first, second)
	}
}

// TestSequenceLooksLikeAProductionIdentifier matters because code under test
// may inspect the version and variant tags.
func TestSequenceLooksLikeAProductionIdentifier(t *testing.T) {
	generated, err := idtest.NewSequence().New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if got := generated.Version().String(); got != "VERSION_7" {
		t.Errorf("Version() = %s, want VERSION_7", got)
	}
	if got := generated.Variant().String(); got != "RFC4122" {
		t.Errorf("Variant() = %s, want RFC4122", got)
	}
	if generated == id.Nil {
		t.Error("generated the nil identifier")
	}
}

func TestSequenceSortsInGenerationOrder(t *testing.T) {
	sequence := idtest.NewSequence()

	previous, err := sequence.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for i := 1; i < 1_000; i++ {
		current, err := sequence.New()
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if bytes.Compare(previous[:], current[:]) >= 0 {
			t.Fatalf("identifier %d (%s) does not sort after %s", i, current, previous)
		}
		previous = current
	}
}

func TestSequenceCount(t *testing.T) {
	sequence := idtest.NewSequence()

	if got := sequence.Count(); got != 0 {
		t.Errorf("Count() on a fresh sequence = %d, want 0", got)
	}
	for range 5 {
		if _, err := sequence.New(); err != nil {
			t.Fatalf("New: %v", err)
		}
	}
	if got := sequence.Count(); got != 5 {
		t.Errorf("Count() = %d, want 5", got)
	}
}

func TestSequenceIsSafeForConcurrentUse(t *testing.T) {
	sequence := idtest.NewSequence()

	const workers, perWorker = 8, 500
	var wait sync.WaitGroup
	var mu sync.Mutex
	seen := make(map[id.ID]struct{}, workers*perWorker)

	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for range perWorker {
				generated, err := sequence.New()
				if err != nil {
					t.Errorf("New: %v", err)
					return
				}
				mu.Lock()
				seen[generated] = struct{}{}
				mu.Unlock()
			}
		}()
	}
	wait.Wait()

	if len(seen) != workers*perWorker {
		t.Errorf("got %d distinct identifiers, want %d", len(seen), workers*perWorker)
	}
	if got := sequence.Count(); got != workers*perWorker {
		t.Errorf("Count() = %d, want %d", got, workers*perWorker)
	}
}
