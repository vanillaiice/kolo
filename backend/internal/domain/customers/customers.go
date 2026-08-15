// Package customers is who a business sells to (§12).
//
// Only the identifier exists so far. Sales needs to name a customer, and a
// credit sale needs someone to owe the balance, but the customer entity and its
// credit history are §12 and §13 and arrive with them.
//
// The identifier lives here rather than in sales because it belongs to this
// domain. Putting it in the package that happens to need it first is how a
// catch-all module starts.
package customers

import "github.com/vanillaiice/kolo/backend/internal/kernel/id"

type customerTag struct{}

// ID identifies a customer.
type ID = id.Typed[customerTag]

// NewID draws a new customer identifier.
func NewID() ID { return id.NewTyped[customerTag]() }

// IDFrom tags an identifier drawn from a generator.
func IDFrom(value id.ID) ID { return id.TypedFrom[customerTag](value) }

// ParseID reads a customer identifier from its text form.
func ParseID(text string) (ID, error) { return id.ParseTyped[customerTag](text) }
