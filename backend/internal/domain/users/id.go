// Package users models the people who operate a business: who they are, which
// tenant and branch they belong to, and what they are allowed to do.
//
// It deliberately holds no credentials. SPECIFICATION.md §5 separates
// "Authentication" from "Users & Roles", and this is the second of the two: a
// User is an identity within a business, not a way of proving that identity.
// Passwords, PINs, tokens, and login handles belong to the authentication
// domain, keyed by user identifier.
//
// A user brings together the two boundaries established elsewhere: the tenant
// they are confined to (business.Scope, ADR-008) and the permissions they hold
// (authz, §38).
package users

import "github.com/vanillaiice/kolo/backend/internal/kernel/id"

type userTag struct{}

// ID identifies a user. It is immutable once assigned.
type ID = id.Typed[userTag]

// NewID returns a new user identifier.
func NewID() ID { return id.NewTyped[userTag]() }

// IDFrom tags an identifier drawn from a generator as a user identifier.
func IDFrom(value id.ID) ID { return id.TypedFrom[userTag](value) }

// ParseID reads a user identifier from its text form.
func ParseID(text string) (ID, error) { return id.ParseTyped[userTag](text) }
