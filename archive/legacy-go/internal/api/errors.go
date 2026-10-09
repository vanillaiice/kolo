// Package api is the HTTP edge of the backend.
//
// It translates requests into calls on application services and their results
// back into responses (ADR-005). Nothing below this package knows about HTTP,
// and nothing here makes a business decision — where a handler looks like it is
// deciding something, it is translating a decision made below.
//
// The API is versioned under /api/v1 (SPECIFICATION.md §35).
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// ErrorCode is a stable, machine-readable name for a failure.
//
// Clients switch on these rather than on the message, which is prose and may be
// reworded or translated. §44 expects French and English, and a client that
// matched on English text would break the moment it was translated.
type ErrorCode string

// The error codes this API returns.
const (
	CodeInvalidRequest     ErrorCode = "invalid_request"
	CodeInvalidCredentials ErrorCode = "invalid_credentials"
	CodeUnauthenticated    ErrorCode = "unauthenticated"
	CodeForbidden          ErrorCode = "forbidden"
	CodeAccountSuspended   ErrorCode = "account_suspended"
	CodeDeviceSuspended    ErrorCode = "device_suspended"
	CodeBusinessSuspended  ErrorCode = "business_suspended"
	CodeTooManyAttempts    ErrorCode = "too_many_attempts"
	CodeBatchTooLarge      ErrorCode = "batch_too_large"
	CodeNotFound           ErrorCode = "not_found"
	CodeConflict           ErrorCode = "conflict"
	CodeInternal           ErrorCode = "internal_error"
)

// errorBody is the JSON shape of every failure.
//
// One shape for all of them means a client needs one way to read an error,
// rather than guessing at the response of each endpoint.
type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

// failure describes how one error is answered.
type failure struct {
	status  int
	code    ErrorCode
	message string
	// retryAfter, when set, is sent as a Retry-After header so a client waits
	// rather than hammering.
	retryAfter time.Duration
}

// classify decides how an error is answered.
//
// It is the one place that mapping happens, so the rules about what a client is
// told are visible together rather than scattered across handlers.
func classify(err error) failure {
	switch {
	case errors.Is(err, authn.ErrTooManyAttempts):
		wait, _ := authn.RetryAfter(err)
		return failure{
			status:     http.StatusTooManyRequests,
			code:       CodeTooManyAttempts,
			message:    "Too many failed attempts. Please wait before trying again.",
			retryAfter: wait,
		}

	case errors.Is(err, authn.ErrInvalidCredentials):
		// 401, and the message says no more than the service does: naming which
		// half was wrong would make this endpoint a way to discover who works
		// for a business.
		return failure{
			status:  http.StatusUnauthorized,
			code:    CodeInvalidCredentials,
			message: "The phone number or PIN is incorrect.",
		}

	case errors.Is(err, authn.ErrUnauthenticated):
		return failure{
			status:  http.StatusUnauthorized,
			code:    CodeUnauthenticated,
			message: "Sign in to continue.",
		}

	case errors.Is(err, authn.ErrAccountSuspended):
		return failure{
			status:  http.StatusForbidden,
			code:    CodeAccountSuspended,
			message: "This account is suspended. Ask the business owner to restore it.",
		}

	case errors.Is(err, authn.ErrDeviceSuspended):
		return failure{
			status:  http.StatusForbidden,
			code:    CodeDeviceSuspended,
			message: "This device is not in service. Ask the business owner to restore it.",
		}

	case errors.Is(err, authn.ErrBusinessSuspended):
		return failure{
			status:  http.StatusForbidden,
			code:    CodeBusinessSuspended,
			message: "This business is not in service. Please get in touch with support.",
		}

	case errors.Is(err, authn.ErrInvalidRequest), errors.Is(err, syncing.ErrInvalidRequest):
		return failure{
			status:  http.StatusBadRequest,
			code:    CodeInvalidRequest,
			message: "The request is missing something or is not valid.",
		}

	case errors.Is(err, syncing.ErrBatchTooLarge):
		// 413 rather than 400: the request was well formed, there was simply too
		// much of it, and a client should split the batch and try again rather
		// than treat the events as bad.
		return failure{
			status:  http.StatusRequestEntityTooLarge,
			code:    CodeBatchTooLarge,
			message: "Too many events in one request. Send them in smaller batches.",
		}

	case errors.Is(err, business.ErrCrossTenant), errors.Is(err, business.ErrNoTenant):
		// A cross-tenant attempt is answered as not found rather than
		// forbidden, for the same reason the repositories do: "you may not see
		// this" confirms the record exists (ADR-008).
		return failure{
			status:  http.StatusNotFound,
			code:    CodeNotFound,
			message: "Not found.",
		}

	case errors.Is(err, postgres.ErrNotFound):
		return failure{
			status:  http.StatusNotFound,
			code:    CodeNotFound,
			message: "Not found.",
		}

	case errors.Is(err, postgres.ErrConflict):
		return failure{
			status:  http.StatusConflict,
			code:    CodeConflict,
			message: "That conflicts with something that already exists.",
		}

	default:
		// Anything unrecognised is a fault on this side. The client is told
		// nothing about it: an internal error message can carry a table name, a
		// query, or a constraint, none of which is a stranger's business.
		return failure{
			status:  http.StatusInternalServerError,
			code:    CodeInternal,
			message: "Something went wrong. Please try again.",
		}
	}
}

// writeError answers a request with a failure, logging the underlying cause.
//
// The cause is logged rather than sent, so an operator can diagnose what a
// client is deliberately not told.
func writeError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	result := classify(err)

	if result.status >= http.StatusInternalServerError {
		logger.ErrorContext(r.Context(), "request failed",
			"method", r.Method, "path", r.URL.Path, "error", err)
	} else {
		logger.DebugContext(r.Context(), "request refused",
			"method", r.Method, "path", r.URL.Path, "code", string(result.code), "error", err)
	}

	if result.retryAfter > 0 {
		seconds := int(result.retryAfter.Round(time.Second) / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
	}

	writeJSON(w, r, logger, result.status, errorBody{
		Error: errorDetail{Code: result.code, Message: result.message},
	})
}

// writeJSON sends a response body.
//
// A failure to encode is logged rather than returned: the status line has
// already gone, so there is nothing left to tell the client.
func writeJSON(w http.ResponseWriter, r *http.Request, logger *slog.Logger, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)

	if body == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(body); err != nil {
		logger.ErrorContext(r.Context(), "could not write the response body",
			"method", r.Method, "path", r.URL.Path, "error", err)
	}
}
