// Package migrations holds the PostgreSQL schema history.
//
// The files are embedded so a deployed binary carries the migrations it
// expects and cannot drift from whatever happens to be on disk elsewhere
// (ADR-013).
package migrations

import "embed"

// FS holds every migration, in the order their filenames sort.
//
//go:embed *.sql
var FS embed.FS
