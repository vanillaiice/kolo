package authz

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// Set is an immutable collection of permissions.
//
// Operations return new sets rather than mutating the receiver. A user's
// effective permissions are derived by combining their role's defaults with
// per-user grants and revocations, and sharing a mutable set between those
// steps would let one user's override leak into another's.
type Set struct {
	members map[Permission]struct{}
}

// NewSet returns a set containing the given permissions. Duplicates collapse
// and undefined permissions are rejected.
func NewSet(permissions ...Permission) (Set, error) {
	members := make(map[Permission]struct{}, len(permissions))
	for _, permission := range permissions {
		if !permission.Defined() {
			return Set{}, fmt.Errorf("%w: %q", ErrUnknownPermission, permission)
		}
		members[permission] = struct{}{}
	}
	return Set{members: members}, nil
}

// MustNewSet is NewSet for permissions known at compile time. It panics on an
// undefined permission, so it is only appropriate with package constants.
func MustNewSet(permissions ...Permission) Set {
	set, err := NewSet(permissions...)
	if err != nil {
		panic(err)
	}
	return set
}

// Has reports whether the set contains p.
//
// This is the only question the authorization layer asks. It is answered
// against a set, never against a role, so that a business which has customised
// its matrix behaves the way it was configured.
func (s Set) Has(p Permission) bool {
	_, ok := s.members[p]
	return ok
}

// HasAll reports whether the set contains every one of the given permissions.
// It is true for an empty list.
func (s Set) HasAll(permissions ...Permission) bool {
	for _, permission := range permissions {
		if !s.Has(permission) {
			return false
		}
	}
	return true
}

// HasAny reports whether the set contains at least one of the given
// permissions. It is false for an empty list.
func (s Set) HasAny(permissions ...Permission) bool {
	return slices.ContainsFunc(permissions, s.Has)
}

// Len returns how many permissions the set holds.
func (s Set) Len() int { return len(s.members) }

// IsEmpty reports whether the set grants nothing.
func (s Set) IsEmpty() bool { return len(s.members) == 0 }

// All returns the permissions in the set, in the canonical order used by the
// package-level All. The order is stable so that stored and transmitted
// representations do not churn.
func (s Set) All() []Permission {
	permissions := make([]Permission, 0, len(s.members))
	for _, permission := range all {
		if s.Has(permission) {
			permissions = append(permissions, permission)
		}
	}
	return permissions
}

// With returns a copy of the set extended with the given permissions.
func (s Set) With(permissions ...Permission) (Set, error) {
	members := make(map[Permission]struct{}, len(s.members)+len(permissions))
	maps.Copy(members, s.members)
	for _, permission := range permissions {
		if !permission.Defined() {
			return Set{}, fmt.Errorf("%w: %q", ErrUnknownPermission, permission)
		}
		members[permission] = struct{}{}
	}
	return Set{members: members}, nil
}

// Without returns a copy of the set with the given permissions removed.
//
// Removing a permission the set does not hold is not an error: revocations are
// stored per user and may name a permission the user's role never granted.
func (s Set) Without(permissions ...Permission) Set {
	members := make(map[Permission]struct{}, len(s.members))
	maps.Copy(members, s.members)
	for _, permission := range permissions {
		delete(members, permission)
	}
	return Set{members: members}
}

// Union returns the permissions held by either set.
func (s Set) Union(other Set) Set {
	members := make(map[Permission]struct{}, len(s.members)+len(other.members))
	maps.Copy(members, s.members)
	maps.Copy(members, other.members)
	return Set{members: members}
}

// Intersect returns the permissions held by both sets.
func (s Set) Intersect(other Set) Set {
	members := make(map[Permission]struct{})
	for permission := range s.members {
		if other.Has(permission) {
			members[permission] = struct{}{}
		}
	}
	return Set{members: members}
}

// Equal reports whether both sets hold exactly the same permissions.
func (s Set) Equal(other Set) bool {
	if len(s.members) != len(other.members) {
		return false
	}
	for permission := range s.members {
		if !other.Has(permission) {
			return false
		}
	}
	return true
}

// String implements fmt.Stringer, for logs and error messages.
func (s Set) String() string {
	if s.IsEmpty() {
		return "authz.Set{}"
	}
	names := make([]string, 0, len(s.members))
	for _, permission := range s.All() {
		names = append(names, string(permission))
	}
	return "authz.Set{" + strings.Join(names, ", ") + "}"
}

// MarshalJSON implements json.Marshaler, writing a stably ordered array so that
// a stored or synced set does not appear to change when it has not.
// An empty set marshals as [] rather than null, because null would decode into
// an unchanged destination and silently keep whatever permissions were already
// there. All always returns a non-nil slice, so this holds without a guard.
func (s Set) MarshalJSON() ([]byte, error) {
	return json.Marshal(s.All())
}

// UnmarshalJSON implements json.Unmarshaler, rejecting undefined permissions.
func (s *Set) UnmarshalJSON(data []byte) error {
	var names []string
	if err := json.Unmarshal(data, &names); err != nil {
		return fmt.Errorf("authz: decoding permission set: %w", err)
	}

	permissions := make([]Permission, 0, len(names))
	for _, name := range names {
		permission, err := ParsePermission(name)
		if err != nil {
			return err
		}
		permissions = append(permissions, permission)
	}

	// Every name came back from ParsePermission, so all are defined and the
	// set cannot be rejected.
	*s = MustNewSet(permissions...)
	return nil
}

// Sensitive returns the permissions in the set whose use requires an audit
// record (SPECIFICATION.md §39).
func (s Set) Sensitive() []Permission {
	return slices.DeleteFunc(s.All(), func(p Permission) bool {
		return !p.IsSensitive()
	})
}
