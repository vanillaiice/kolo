package authn_test

import (
	"context"
	"errors"
	"sync"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

// These are in-memory stands-in for the repositories.
//
// Using them here is a different judgement from the repository tests, which run
// against a real PostgreSQL because a mock cannot prove a query is
// tenant-scoped. What this service adds is orchestration — the order things
// happen in, what a failure reveals, what is retried — and that is exactly what
// a fake lets a test drive: an unreachable store, a suspended user, a
// credential hashed under an old work factor. The isolation those stores
// enforce is proven where it lives.
//
// They still honour the scope, so a test cannot accidentally rely on the
// service reaching across tenants.

var errStoreUnavailable = errors.New("store is unavailable")

type fakeBusinessStore struct {
	mu         sync.Mutex
	byID       map[business.ID]*business.Business
	branches   map[business.BranchID]*business.Branch
	failGet    bool
	failBranch bool
}

func newFakeBusinessStore() *fakeBusinessStore {
	return &fakeBusinessStore{
		byID:     make(map[business.ID]*business.Business),
		branches: make(map[business.BranchID]*business.Branch),
	}
}

func (f *fakeBusinessStore) putBranch(branch *business.Branch) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.branches[branch.ID()] = branch
}

func (f *fakeBusinessStore) GetBranch(
	_ context.Context, scope business.Scope, branchID business.BranchID,
) (*business.Branch, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failBranch {
		return nil, errStoreUnavailable
	}
	branch, found := f.branches[branchID]
	if !found || !scope.Permits(branch.BusinessID(), business.BranchID{}) {
		return nil, errNotFound
	}
	return branch, nil
}

func (f *fakeBusinessStore) put(record *business.Business) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byID[record.ID()] = record
}

func (f *fakeBusinessStore) Get(_ context.Context, businessID business.ID) (*business.Business, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failGet {
		return nil, errStoreUnavailable
	}
	record, found := f.byID[businessID]
	if !found {
		return nil, errNotFound
	}
	return record, nil
}

type fakeCredentialStore struct {
	mu          sync.Mutex
	byPhone     map[string]*auth.Credential
	updates     int
	failFind    bool
	failUpdate  bool
	findCalls   int
	updateCalls int
}

func newFakeCredentialStore() *fakeCredentialStore {
	return &fakeCredentialStore{byPhone: make(map[string]*auth.Credential)}
}

func (f *fakeCredentialStore) put(credential *auth.Credential) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byPhone[key(credential.BusinessID(), credential.Phone().String())] = credential
}

func (f *fakeCredentialStore) FindByPhone(
	_ context.Context, scope business.Scope, number phone.Number,
) (*auth.Credential, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.findCalls++

	if f.failFind {
		return nil, errStoreUnavailable
	}
	if !scope.Valid() {
		return nil, business.ErrNoTenant
	}
	credential, found := f.byPhone[key(scope.Business(), number.String())]
	if !found {
		return nil, errNotFound
	}
	return credential, nil
}

func (f *fakeCredentialStore) Update(_ context.Context, scope business.Scope, credential *auth.Credential) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updateCalls++

	if f.failUpdate {
		return errStoreUnavailable
	}
	if err := scope.Guard(credential.BusinessID(), business.BranchID{}); err != nil {
		return err
	}
	f.byPhone[key(credential.BusinessID(), credential.Phone().String())] = credential
	f.updates++
	return nil
}

type fakeUserStore struct {
	mu      sync.Mutex
	byID    map[users.ID]*users.User
	failGet bool
}

func newFakeUserStore() *fakeUserStore {
	return &fakeUserStore{byID: make(map[users.ID]*users.User)}
}

func (f *fakeUserStore) put(user *users.User) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byID[user.ID()] = user
}

func (f *fakeUserStore) Get(_ context.Context, scope business.Scope, userID users.ID) (*users.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failGet {
		return nil, errStoreUnavailable
	}
	user, found := f.byID[userID]
	if !found || !scope.Permits(user.BusinessID(), business.BranchID{}) {
		return nil, errNotFound
	}
	return user, nil
}

type fakeDeviceStore struct {
	mu         sync.Mutex
	byID       map[devices.ID]*devices.Device
	registered int
	seen       int
	failCreate bool
	failUpdate bool
}

func newFakeDeviceStore() *fakeDeviceStore {
	return &fakeDeviceStore{byID: make(map[devices.ID]*devices.Device)}
}

func (f *fakeDeviceStore) put(device *devices.Device) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byID[device.ID()] = device
}

func (f *fakeDeviceStore) Get(_ context.Context, scope business.Scope, deviceID devices.ID) (*devices.Device, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	device, found := f.byID[deviceID]
	if !found || !scope.Permits(device.BusinessID(), business.BranchID{}) {
		return nil, errNotFound
	}
	return device, nil
}

func (f *fakeDeviceStore) Create(_ context.Context, scope business.Scope, device *devices.Device) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failCreate {
		return errStoreUnavailable
	}
	if err := scope.Guard(device.BusinessID(), business.BranchID{}); err != nil {
		return err
	}
	f.byID[device.ID()] = device
	f.registered++
	return nil
}

func (f *fakeDeviceStore) Update(_ context.Context, scope business.Scope, device *devices.Device) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failUpdate {
		return errStoreUnavailable
	}
	if err := scope.Guard(device.BusinessID(), business.BranchID{}); err != nil {
		return err
	}
	f.byID[device.ID()] = device
	f.seen++
	return nil
}

type fakeSessionStore struct {
	mu         sync.Mutex
	byToken    map[string]*auth.Session
	failCreate bool
	failUpdate bool
	failFind   bool
}

func newFakeSessionStore() *fakeSessionStore {
	return &fakeSessionStore{byToken: make(map[string]*auth.Session)}
}

func (f *fakeSessionStore) Create(_ context.Context, scope business.Scope, session *auth.Session) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failCreate {
		return errStoreUnavailable
	}
	if err := scope.Guard(session.BusinessID(), business.BranchID{}); err != nil {
		return err
	}
	f.byToken[session.Snapshot().TokenHash.String()] = session
	return nil
}

func (f *fakeSessionStore) FindByToken(_ context.Context, token auth.Token) (*auth.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failFind {
		return nil, errStoreUnavailable
	}
	session, found := f.byToken[token.Hash().String()]
	if !found {
		return nil, errNotFound
	}
	return session, nil
}

func (f *fakeSessionStore) Update(_ context.Context, scope business.Scope, session *auth.Session) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failUpdate {
		return errStoreUnavailable
	}
	if err := scope.Guard(session.BusinessID(), business.BranchID{}); err != nil {
		return err
	}
	f.byToken[session.Snapshot().TokenHash.String()] = session
	return nil
}

var errNotFound = errors.New("not found")

func key(tenant business.ID, value string) string {
	return tenant.String() + "/" + value
}
