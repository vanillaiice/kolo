package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
)

// Principal is who is making a request, once their token has been resolved.
//
// It carries the tenant scope every downstream call must be bounded by, so a
// handler never has to work out which business a request belongs to — and
// cannot get it from anywhere a client controls.
type Principal struct {
	User    *users.User
	Device  *devices.Device
	Session *auth.Session
}

// Scope returns the tenant the request is confined to.
func (p Principal) Scope() business.Scope { return p.User.Scope() }

// Can reports whether the principal holds a permission.
func (p Principal) Can(permission authz.Permission) bool { return p.User.Can(permission) }

// principalKey is the context key under which a principal is carried. It is an
// unexported type so nothing outside this package can set or overwrite it.
type principalKey struct{}

// PrincipalFrom returns the authenticated principal on a request.
//
// The second result is false on an unauthenticated request. A handler mounted
// behind RequireAuthentication can rely on it being true; one mounted outside
// must check.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalKey{}).(Principal)
	return principal, ok
}

// Authenticator resolves a token to who holds it.
type Authenticator interface {
	Authenticate(ctx context.Context, token auth.Token) (authn.LoginResult, error)
}

// RequireAuthentication rejects a request that does not carry a live session,
// and attaches the principal to those that do.
func RequireAuthentication(authenticator Authenticator, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, err := bearerToken(r)
			if err != nil {
				writeError(w, r, logger, err)
				return
			}

			result, err := authenticator.Authenticate(r.Context(), token)
			if err != nil {
				writeError(w, r, logger, err)
				return
			}

			principal := Principal{User: result.User, Device: result.Device, Session: result.Session}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, principal)))
		})
	}
}

// RequirePermission rejects a request whose principal does not hold a
// permission. It must be mounted behind RequireAuthentication.
func RequirePermission(permission authz.Permission, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			principal, authenticated := PrincipalFrom(r.Context())
			if !authenticated {
				// Reaching here means the middleware was mounted without
				// authentication in front of it. Refusing is the safe reading:
				// the alternative would let a misconfigured route through.
				logger.ErrorContext(r.Context(),
					"a permission check ran on an unauthenticated request, which means the route is misconfigured",
					"method", r.Method, "path", r.URL.Path, "permission", string(permission))
				writeError(w, r, logger, authn.ErrUnauthenticated)
				return
			}

			if !principal.Can(permission) {
				writeJSON(w, r, logger, http.StatusForbidden, errorBody{Error: errorDetail{
					Code:    CodeForbidden,
					Message: "You do not have permission to do that.",
				}})
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// bearerToken reads the token from the Authorization header.
//
// Only the Authorization header is accepted. A token in a query string ends up
// in server logs, browser history, and referrer headers, so it is not offered
// as an alternative however convenient it would be.
func bearerToken(r *http.Request) (auth.Token, error) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return auth.Token{}, authn.ErrUnauthenticated
	}

	scheme, credentials, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return auth.Token{}, authn.ErrUnauthenticated
	}

	token, err := auth.ParseToken(credentials)
	if err != nil {
		// A malformed token is answered as simply unauthenticated. Explaining
		// what was wrong with it would help someone probing the format.
		return auth.Token{}, errors.Join(authn.ErrUnauthenticated, err)
	}
	return token, nil
}

// chain applies middleware to a handler, outermost first, so that
// chain(h, a, b) runs a, then b, then h.
func chain(handler http.Handler, middleware ...func(http.Handler) http.Handler) http.Handler {
	for i := len(middleware) - 1; i >= 0; i-- {
		handler = middleware[i](handler)
	}
	return handler
}
