package id_test

import (
	"io"
	"testing"

	"github.com/google/uuid"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
)

type failingEntropy struct{}

func (failingEntropy) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

// withFailingEntropy breaks the library's randomness source for the duration of
// a test. It mutates process-wide state, so callers must not run in parallel.
func withFailingEntropy(t *testing.T) {
	t.Helper()
	uuid.SetRand(failingEntropy{})
	t.Cleanup(func() { uuid.SetRand(nil) })
}

func TestV7ReportsEntropyFailure(t *testing.T) {
	withFailingEntropy(t)

	generated, err := id.V7{}.New()
	if err == nil {
		t.Fatalf("New succeeded with a broken entropy source, returning %s", generated)
	}
	if generated != id.Nil {
		t.Errorf("New returned %s alongside an error, want the nil identifier", generated)
	}
}

// TestNewPanicsOnEntropyFailure pins the documented behaviour of the
// package-level helper: there is no sensible way to continue without
// randomness, so it fails loudly rather than returning a usable-looking value.
func TestNewPanicsOnEntropyFailure(t *testing.T) {
	withFailingEntropy(t)

	defer func() {
		if recover() == nil {
			t.Error("New did not panic with a broken entropy source")
		}
	}()
	id.New()
}

// TestEntropyIsRestored guards the cleanup above: a leaked broken source would
// make every later test fail for the wrong reason.
func TestEntropyIsRestored(t *testing.T) {
	if generated := id.New(); generated == id.Nil {
		t.Error("New returned the nil identifier, suggesting a leaked entropy override")
	}
}
