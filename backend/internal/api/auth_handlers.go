package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

// maxRequestBody bounds how much of a request body is read.
//
// None of these payloads is large, and an unbounded read is a way to exhaust
// the server's memory with a single request.
const maxRequestBody = 64 << 10 // 64 KiB

// authHandlers serves /api/v1/auth.
type authHandlers struct {
	service *authn.Service
	logger  *slog.Logger
}

// loginRequest is the wire shape of a login.
//
// The business is named explicitly because a phone number identifies a person
// within one business, not globally (ADR-012).
type loginRequest struct {
	BusinessID string        `json:"business_id"`
	Phone      string        `json:"phone"`
	PIN        string        `json:"pin"`
	Device     deviceRequest `json:"device"`
}

// deviceRequest names the installation. An identifier means an installation
// already registered; a label and platform register a new one.
type deviceRequest struct {
	ID       string `json:"id,omitempty"`
	Label    string `json:"label,omitempty"`
	Platform string `json:"platform,omitempty"`
}

// loginResponse is what a successful login returns.
//
// The token appears here and nowhere else, ever: only its hash is stored, so
// this response is the only chance the client has to keep it.
type loginResponse struct {
	Token     string          `json:"token"`
	ExpiresAt time.Time       `json:"expires_at"`
	User      userResponse    `json:"user"`
	Device    deviceResponse  `json:"device"`
	Session   sessionResponse `json:"session"`
}

type userResponse struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Role        string   `json:"role"`
	BusinessID  string   `json:"business_id"`
	BranchID    string   `json:"branch_id,omitempty"`
	Permissions []string `json:"permissions"`
}

type deviceResponse struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Platform string `json:"platform"`
	BranchID string `json:"branch_id,omitempty"`
}

type sessionResponse struct {
	ID        string    `json:"id"`
	IssuedAt  time.Time `json:"issued_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// login handles POST /api/v1/auth/login.
func (h *authHandlers) login(w http.ResponseWriter, r *http.Request) {
	var body loginRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, r, h.logger, err)
		return
	}

	request, err := body.toDomain()
	if err != nil {
		writeError(w, r, h.logger, err)
		return
	}

	result, err := h.service.Login(r.Context(), request)
	if err != nil {
		writeError(w, r, h.logger, err)
		return
	}

	writeJSON(w, r, h.logger, http.StatusOK, loginResponse{
		Token:     result.Token.Secret(),
		ExpiresAt: result.Session.ExpiresAt(),
		User:      describeUser(result),
		Device:    describeDevice(result),
		Session: sessionResponse{
			ID:        result.Session.ID().String(),
			IssuedAt:  result.Session.IssuedAt(),
			ExpiresAt: result.Session.ExpiresAt(),
		},
	})
}

// logout handles POST /api/v1/auth/logout.
func (h *authHandlers) logout(w http.ResponseWriter, r *http.Request) {
	token, err := bearerToken(r)
	if err != nil {
		writeError(w, r, h.logger, err)
		return
	}

	if err := h.service.Logout(r.Context(), token); err != nil {
		writeError(w, r, h.logger, err)
		return
	}
	// Nothing to say, and logging out twice is not an error, so a client
	// retrying a request it could not confirm is not told it failed.
	w.WriteHeader(http.StatusNoContent)
}

// currentUser handles GET /api/v1/auth/me.
//
// It is how a client checks a cached session is still good, and refreshes what
// it knows about the person: a role change or a revoked permission reaches the
// device here.
func (h *authHandlers) currentUser(w http.ResponseWriter, r *http.Request) {
	principal, authenticated := PrincipalFrom(r.Context())
	if !authenticated {
		writeError(w, r, h.logger, authn.ErrUnauthenticated)
		return
	}

	result := authn.LoginResult{
		User:    principal.User,
		Device:  principal.Device,
		Session: principal.Session,
	}
	writeJSON(w, r, h.logger, http.StatusOK, struct {
		User    userResponse    `json:"user"`
		Device  deviceResponse  `json:"device"`
		Session sessionResponse `json:"session"`
	}{
		User:   describeUser(result),
		Device: describeDevice(result),
		Session: sessionResponse{
			ID:        principal.Session.ID().String(),
			IssuedAt:  principal.Session.IssuedAt(),
			ExpiresAt: principal.Session.ExpiresAt(),
		},
	})
}

// toDomain converts a decoded body into a service request, reporting anything
// that could not be understood as an invalid request rather than a fault.
func (b loginRequest) toDomain() (authn.LoginRequest, error) {
	businessID, err := business.ParseID(b.BusinessID)
	if err != nil {
		return authn.LoginRequest{}, fmt.Errorf("%w: business_id: %w", authn.ErrInvalidRequest, err)
	}

	number, err := phone.Parse(b.Phone)
	if err != nil {
		return authn.LoginRequest{}, fmt.Errorf("%w: phone: %w", authn.ErrInvalidRequest, err)
	}

	device, err := b.Device.toDomain()
	if err != nil {
		return authn.LoginRequest{}, err
	}

	return authn.LoginRequest{
		BusinessID: businessID,
		Phone:      number,
		PIN:        b.PIN,
		Device:     device,
	}, nil
}

func (d deviceRequest) toDomain() (authn.DeviceRequest, error) {
	if d.ID == "" {
		// Registering a new installation. The platform is parsed here so an
		// unknown one is a bad request rather than reaching the service.
		if d.Platform == "" {
			return authn.DeviceRequest{Label: d.Label}, nil
		}
		platform, err := devices.ParsePlatform(d.Platform)
		if err != nil {
			return authn.DeviceRequest{}, fmt.Errorf("%w: device.platform: %w", authn.ErrInvalidRequest, err)
		}
		return authn.DeviceRequest{Label: d.Label, Platform: platform}, nil
	}

	deviceID, err := devices.ParseID(d.ID)
	if err != nil {
		return authn.DeviceRequest{}, fmt.Errorf("%w: device.id: %w", authn.ErrInvalidRequest, err)
	}
	return authn.DeviceRequest{ID: deviceID}, nil
}

func describeUser(result authn.LoginResult) userResponse {
	permissions := result.User.Permissions().All()
	names := make([]string, 0, len(permissions))
	for _, permission := range permissions {
		names = append(names, string(permission))
	}

	response := userResponse{
		ID:          result.User.ID().String(),
		Name:        result.User.Name(),
		Role:        string(result.User.Role()),
		BusinessID:  result.User.BusinessID().String(),
		Permissions: names,
	}
	// The client is told what the user may do, so it can hide what they cannot.
	// That is a courtesy, not the enforcement — every request is checked again
	// here (§37).
	if branchID, assigned := result.User.BranchID(); assigned {
		response.BranchID = branchID.String()
	}
	return response
}

func describeDevice(result authn.LoginResult) deviceResponse {
	response := deviceResponse{
		ID:       result.Device.ID().String(),
		Label:    result.Device.Label(),
		Platform: string(result.Device.Platform()),
	}
	if branchID, stationed := result.Device.BranchID(); stationed {
		response.BranchID = branchID.String()
	}
	return response
}

// decodeJSON reads a request body into a value.
//
// It is strict: an unknown field is refused rather than ignored, so a client
// sending "pin_code" instead of "pin" is told, rather than silently
// authenticating with an empty PIN. The body is size-limited and must contain
// exactly one JSON value.
func decodeJSON(w http.ResponseWriter, r *http.Request, into any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(into); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return fmt.Errorf("%w: the request body is too large", authn.ErrInvalidRequest)
		}
		return fmt.Errorf("%w: %w", authn.ErrInvalidRequest, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: the body must contain a single JSON object", authn.ErrInvalidRequest)
	}
	return nil
}
