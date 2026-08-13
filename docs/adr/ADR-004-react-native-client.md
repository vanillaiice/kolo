# ADR-004: React Native + TypeScript client

**Status:** Accepted
**Source:** SPECIFICATION.md §32, §33, §47, §48, §63

## Context

The primary operational interface is a mobile application, Android-first because
of the target market's hardware. Web and desktop clients follow later.

## Decision

The client is React Native with TypeScript, mobile-first, Android-first.

Structure follows §33: `app/`, `features/`, `domain/`, `data/`, `services/`,
`components/`, `utils/`. Domain boundaries stay clear even as the exact structure
evolves.

Hardware is abstracted behind services:

* **Printing** (thermal, PDF, digital receipts) sits behind a service interface;
  printer specifics never reach sales logic.
* **Barcode input** (camera, Bluetooth, USB) behaves as an input device. The POS
  must work with a hardware scanner and no camera.

## Consequences

* Android-specific assumptions are avoided where they are not required, so web and
  desktop remain reachable.
* Domain logic in `domain/` must stay free of React and of platform APIs so it is
  testable in isolation and reusable by other clients.
* Performance targets (§46) — fast product search, fast POS, efficient large-list
  rendering, minimal startup delay — constrain UI implementation choices.
