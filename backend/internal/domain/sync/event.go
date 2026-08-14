// Package sync models what devices send each other through the server.
//
// A device pushes events describing what happened, not the state that resulted
// (§26, ADR-006). The difference matters most when devices have been offline:
// two devices each pushing "stock is 47" must lose one of them, while two
// devices each pushing "three were sold" lose nothing.
//
// Every event carries a globally unique identifier and the server is idempotent
// against it (§27), so any push is safe to retry — which it has to be, because
// a device on a bad link often cannot tell whether its last push arrived.
package sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// Errors reported when an event is unusable.
var (
	// ErrInvalidID means an identifier is unset.
	ErrInvalidID = errors.New("sync: identifier is unset")
	// ErrInvalidType means an event has no type, or one this server does not know.
	ErrInvalidType = errors.New("sync: invalid event type")
	// ErrInvalidPayload means an event's payload is missing or not an object.
	ErrInvalidPayload = errors.New("sync: invalid payload")
	// ErrInvalidSequence means a device's ordering number is unusable.
	ErrInvalidSequence = errors.New("sync: invalid device sequence")

	// ErrInvalidTime means a timestamp is unset.
	ErrInvalidTime = validate.ErrInvalidTime
)

// MaxPayloadBytes bounds one event's payload.
//
// Connectivity is assumed slow and expensive (§45), so an event that large is
// far more likely to be a mistake than a real business record.
const MaxPayloadBytes = 256 << 10 // 256 KiB

type eventTag struct{}

// EventID identifies an event. It is generated on the device, offline, and is
// what the server deduplicates on.
type EventID = id.Typed[eventTag]

// NewEventID returns a new event identifier.
func NewEventID() EventID { return id.NewTyped[eventTag]() }

// EventIDFrom tags an identifier drawn from a generator.
func EventIDFrom(value id.ID) EventID { return id.TypedFrom[eventTag](value) }

// ParseEventID reads an event identifier from its text form.
func ParseEventID(text string) (EventID, error) { return id.ParseTyped[eventTag](text) }

// Type names what happened.
type Type string

// The event types this server understands.
//
// The list is explicit: an event type this build does not know is rejected
// rather than stored and forgotten, so a device running ahead of the server
// finds out rather than believing its data arrived.
const (
	// StockMoved carries one or more inventory movements — a delivery, a stock
	// count, a write-off.
	StockMoved Type = "STOCK_MOVED"
	// SaleCompleted carries a sale and everything it produced.
	SaleCompleted Type = "SALE_COMPLETED"
)

var knownTypes = []Type{StockMoved, SaleCompleted}

// Types returns every event type this server understands, in a stable order.
func Types() []Type { return slices.Clone(knownTypes) }

// Defined reports whether t is a type this server understands.
func (t Type) Defined() bool { return slices.Contains(knownTypes, t) }

// String implements fmt.Stringer.
func (t Type) String() string { return string(t) }

// Event is one thing a device says happened.
//
// It is immutable. An event is a statement about the past, and the server's job
// is to record and relay it, not to revise it.
type Event struct {
	id         EventID
	businessID business.ID
	deviceID   devices.ID
	userID     users.ID

	eventType Type
	payload   json.RawMessage

	occurredAt time.Time
	// deviceSequence orders events within the device that sent them, and means
	// nothing between devices. Two devices' sequences are unrelated, which is
	// why ordering across devices is a conflict question rather than a sorting
	// one (ADR-006).
	deviceSequence int64
}

// Envelope is the flat form an event travels and is stored in.
type Envelope struct {
	ID             EventID
	BusinessID     business.ID
	DeviceID       devices.ID
	UserID         users.ID
	Type           Type
	Payload        json.RawMessage
	OccurredAt     time.Time
	DeviceSequence int64
}

// New validates an envelope into an event.
func New(envelope Envelope) (*Event, error) {
	if envelope.ID.IsZero() {
		return nil, fmt.Errorf("%w: event", ErrInvalidID)
	}
	if envelope.BusinessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	if envelope.DeviceID.IsZero() {
		return nil, fmt.Errorf("%w: device", ErrInvalidID)
	}
	if envelope.UserID.IsZero() {
		return nil, fmt.Errorf("%w: user", ErrInvalidID)
	}
	if strings.TrimSpace(string(envelope.Type)) == "" {
		return nil, fmt.Errorf("%w: an event needs a type", ErrInvalidType)
	}
	if !envelope.Type.Defined() {
		return nil, fmt.Errorf("%w: %q is not a type this server understands", ErrInvalidType, envelope.Type)
	}
	if err := validatePayload(envelope.Payload); err != nil {
		return nil, err
	}
	if envelope.DeviceSequence <= 0 {
		return nil, fmt.Errorf("%w: %d", ErrInvalidSequence, envelope.DeviceSequence)
	}
	if err := validate.Moment(envelope.OccurredAt, "occurrence time"); err != nil {
		return nil, err
	}

	return &Event{
		id:             envelope.ID,
		businessID:     envelope.BusinessID,
		deviceID:       envelope.DeviceID,
		userID:         envelope.UserID,
		eventType:      envelope.Type,
		payload:        envelope.Payload,
		occurredAt:     envelope.OccurredAt.UTC(),
		deviceSequence: envelope.DeviceSequence,
	}, nil
}

// Restore rebuilds an event from storage.
//
// A stored event may carry a type this build no longer understands, because it
// was accepted by an older one. Refusing to read it would make the whole pull
// fail for every device, so the type check is deliberately relaxed here — the
// event is relayed as it was received, which is all a pull has to do.
func Restore(envelope Envelope) (*Event, error) {
	if envelope.ID.IsZero() {
		return nil, fmt.Errorf("%w: event", ErrInvalidID)
	}
	if envelope.BusinessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	if strings.TrimSpace(string(envelope.Type)) == "" {
		return nil, fmt.Errorf("%w: a stored event has no type", ErrInvalidType)
	}
	if err := validatePayload(envelope.Payload); err != nil {
		return nil, err
	}
	if err := validate.Moment(envelope.OccurredAt, "occurrence time"); err != nil {
		return nil, err
	}

	return &Event{
		id:             envelope.ID,
		businessID:     envelope.BusinessID,
		deviceID:       envelope.DeviceID,
		userID:         envelope.UserID,
		eventType:      envelope.Type,
		payload:        envelope.Payload,
		occurredAt:     envelope.OccurredAt.UTC(),
		deviceSequence: envelope.DeviceSequence,
	}, nil
}

func validatePayload(payload json.RawMessage) error {
	if len(payload) == 0 {
		return fmt.Errorf("%w: an event needs a payload", ErrInvalidPayload)
	}
	if len(payload) > MaxPayloadBytes {
		return fmt.Errorf("%w: %d bytes, the limit is %d", ErrInvalidPayload, len(payload), MaxPayloadBytes)
	}

	// An object, not an array or a bare value: a payload has named fields, and
	// anything else means the sender and this server disagree about the shape
	// before any field is even read.
	var object map[string]json.RawMessage
	if err := json.Unmarshal(payload, &object); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidPayload, err)
	}
	return nil
}

// Envelope returns the flat form, for storage and for the wire.
func (e *Event) Envelope() Envelope {
	return Envelope{
		ID:             e.id,
		BusinessID:     e.businessID,
		DeviceID:       e.deviceID,
		UserID:         e.userID,
		Type:           e.eventType,
		Payload:        e.payload,
		OccurredAt:     e.occurredAt,
		DeviceSequence: e.deviceSequence,
	}
}

// ID returns the immutable identifier the server deduplicates on.
func (e *Event) ID() EventID { return e.id }

// BusinessID returns the tenant the event belongs to.
func (e *Event) BusinessID() business.ID { return e.businessID }

// DeviceID returns the installation that sent it.
func (e *Event) DeviceID() devices.ID { return e.deviceID }

// UserID returns who was logged in when it happened.
func (e *Event) UserID() users.ID { return e.userID }

// Type returns what happened.
func (e *Event) Type() Type { return e.eventType }

// Payload returns the event's body.
func (e *Event) Payload() json.RawMessage { return e.payload }

// OccurredAt returns when the business event happened, in UTC.
func (e *Event) OccurredAt() time.Time { return e.occurredAt }

// DeviceSequence returns the sending device's ordering number.
func (e *Event) DeviceSequence() int64 { return e.deviceSequence }

// Scope returns the tenant scope the event belongs to.
func (e *Event) Scope() business.Scope {
	return business.ScopeOf(e.businessID, business.BranchID{})
}

// DecodePayload reads the payload into a typed value.
func (e *Event) DecodePayload(into any) error {
	if err := json.Unmarshal(e.payload, into); err != nil {
		return fmt.Errorf("%w: decoding a %s payload: %w", ErrInvalidPayload, e.eventType, err)
	}
	return nil
}
