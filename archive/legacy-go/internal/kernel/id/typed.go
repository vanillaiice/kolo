package id

// Typed is an identifier tagged with the kind of entity it names.
//
// ID alone is structurally identical everywhere, so nothing stops a sale
// identifier from being passed where a product identifier is meant — a mistake
// the compiler cannot see and that surfaces as a record silently not being
// found. Typed makes the entity part of the type:
//
//	type productTag struct{}
//
//	type ID = id.Typed[productTag]
//
//	func NewID() ID { return id.NewTyped[productTag]() }
//
// Identifiers with different tags are different types and will not
// interchange. They remain comparable, usable as map keys, and encode as the
// same canonical text as a plain ID, so storage and the sync wire format are
// unaffected.
//
// The zero Typed wraps Nil and is never a valid identifier.
type Typed[Tag any] struct {
	value ID
}

// NewTyped returns a new tagged identifier from the package-level generator.
// It panics if the entropy source fails, as New does.
func NewTyped[Tag any]() Typed[Tag] {
	return Typed[Tag]{value: New()}
}

// TypedFrom tags an existing identifier.
//
// This is how a service turns an identifier from its injected Generator into a
// domain identifier, so that tests can supply a deterministic sequence.
func TypedFrom[Tag any](value ID) Typed[Tag] {
	return Typed[Tag]{value: value}
}

// ParseTyped reads a tagged identifier from its text form.
func ParseTyped[Tag any](text string) (Typed[Tag], error) {
	parsed, err := Parse(text)
	if err != nil {
		return Typed[Tag]{}, err
	}
	return Typed[Tag]{value: parsed}, nil
}

// MustParseTyped is ParseTyped for identifiers known at compile time, such as
// fixtures. It panics on invalid input.
func MustParseTyped[Tag any](text string) Typed[Tag] {
	parsed, err := ParseTyped[Tag](text)
	if err != nil {
		panic(err)
	}
	return parsed
}

// ID returns the untagged identifier, for storage and other boundaries that
// deal in plain identifiers.
func (t Typed[Tag]) ID() ID { return t.value }

// IsZero reports whether the identifier is unset.
func (t Typed[Tag]) IsZero() bool { return t.value == Nil }

// String returns the canonical 8-4-4-4-12 lower-case hexadecimal form.
func (t Typed[Tag]) String() string { return t.value.String() }

// Compare orders identifiers by their bytes, which for generated identifiers is
// creation order. It returns -1, 0, or 1.
func (t Typed[Tag]) Compare(other Typed[Tag]) int {
	for index := range t.value {
		switch {
		case t.value[index] < other.value[index]:
			return -1
		case t.value[index] > other.value[index]:
			return 1
		}
	}
	return 0
}

// MarshalText implements encoding.TextMarshaler, which also gives Typed its
// JSON representation as a canonical string.
func (t Typed[Tag]) MarshalText() ([]byte, error) {
	return t.value.MarshalText()
}

// UnmarshalText implements encoding.TextUnmarshaler.
func (t *Typed[Tag]) UnmarshalText(text []byte) error {
	var parsed ID
	if err := parsed.UnmarshalText(text); err != nil {
		return err
	}
	t.value = parsed
	return nil
}
