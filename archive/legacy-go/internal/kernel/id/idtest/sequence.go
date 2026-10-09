// Package idtest provides deterministic identifier generation for tests.
//
// Real identifiers embed a timestamp and random bits, so a test that asserts on
// them cannot have stable expectations. A Sequence produces predictable,
// ordered identifiers instead, which keeps golden files and error messages
// readable.
package idtest

import (
	"encoding/binary"
	"sync"

	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
)

// Sequence generates counted identifiers of the form
// 00000000-0000-7000-8000-0000000000NN, starting at 1.
//
// The values carry a valid version 7 and RFC 4122 variant tag, so code that
// inspects those tags behaves as it would in production. They sort in
// generation order. Sequence is safe for concurrent use, though the order in
// which concurrent callers receive values is naturally undefined.
type Sequence struct {
	mu      sync.Mutex
	counter uint64
}

// NewSequence returns a Sequence positioned before its first identifier.
func NewSequence() *Sequence {
	return &Sequence{}
}

// New returns the next identifier in the sequence. It never fails; the error
// exists to satisfy id.Generator.
func (s *Sequence) New() (id.ID, error) {
	s.mu.Lock()
	s.counter++
	next := s.counter
	s.mu.Unlock()

	var generated id.ID
	// Bytes 6-7 carry the version tag, byte 8 the variant tag, and the counter
	// occupies the trailing bytes so that the text form reads as a plain number.
	generated[6] = 0x70
	generated[8] = 0x80
	binary.BigEndian.PutUint64(generated[8:16], next)
	generated[8] = (generated[8] & 0x3F) | 0x80

	return generated, nil
}

// Count returns how many identifiers have been generated.
func (s *Sequence) Count() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.counter
}
