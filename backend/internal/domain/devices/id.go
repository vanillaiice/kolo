// Package devices identifies an installation of the application.
//
// Each installation has its own identity, used for synchronization, audit
// logs, conflict resolution, security, and troubleshooting
// (SPECIFICATION.md §28).
//
// Only the identifier lives here for now. The Device entity — its label, its
// branch, when it last synchronized — belongs to the synchronization phase
// (§51), which is where the rest of its fields acquire meaning. The identifier
// is needed earlier because a session is bound to the device that holds it
// (ADR-012), and it needs one home rather than a copy in each domain that
// refers to a device.
package devices

import "github.com/vanillaiice/kolo/backend/internal/kernel/id"

type deviceTag struct{}

// ID identifies an installation. It is immutable once assigned.
type ID = id.Typed[deviceTag]

// NewID returns a new device identifier.
func NewID() ID { return id.NewTyped[deviceTag]() }

// IDFrom tags an identifier drawn from a generator as a device identifier.
func IDFrom(value id.ID) ID { return id.TypedFrom[deviceTag](value) }

// ParseID reads a device identifier from its text form.
func ParseID(text string) (ID, error) { return id.ParseTyped[deviceTag](text) }
