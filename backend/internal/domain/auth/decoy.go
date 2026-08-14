package auth

import "sync"

// decoyHash is a real bcrypt hash that nothing a caller presents will match.
//
// It is built lazily and once, so the cost is paid on first use rather than at
// startup, and shared thereafter.
var decoyHash = sync.OnceValue(func() PINHash {
	// Hashed through the internal helper so the PIN rules do not apply: this
	// value exists to be compared against, never to be a real credential.
	hashed, err := hashPINAtCost("1357", hashCost)
	if err != nil {
		// hashPINAtCost only fails on an unusable work factor, and hashCost is
		// a valid constant. An empty hash still verifies nothing, so a failure
		// here degrades to a fast rejection rather than a broken login.
		return PINHash{}
	}
	return hashed
})

// VerifyDecoy performs a PIN comparison that always fails, taking about as long
// as a real one. It returns false.
//
// Login must not reveal whether a phone number is registered. Without this, a
// request for an unknown number would return immediately while a known one
// spent time hashing, and that difference is easily measured — turning the
// login endpoint into a way to enumerate a business's staff.
//
// A caller that found no credential runs this in place of a real verification,
// then reports the same error it would have for a wrong PIN.
func VerifyDecoy(pin string) bool {
	// The result is discarded rather than returned: a decoy that could somehow
	// succeed would be a way in.
	_ = decoyHash().Verify(pin)
	return false
}
