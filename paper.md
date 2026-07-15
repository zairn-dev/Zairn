---
title: 'Zairn: A reproducible research and evaluation stack for privacy-preserving location sharing and location-bound encrypted content'
tags:
  - TypeScript
  - privacy
  - location-based services
  - zero-knowledge proofs
  - geofencing
  - mobile computing
authors:
  - name: TODO — real name required before submission
    orcid: TODO
    affiliation: 1
affiliations:
  - name: TODO — affiliation required before submission
    index: 1
date: TODO
bibliography: paper.bib
---

# Summary

Zairn is an open-source platform and research stack for privacy-preserving
location sharing and location-bound encrypted content. It combines two
complementary systems built on a shared Supabase/PostgreSQL backend with
Row Level Security (RLS) on every table:

- **`@zairn/sdk`** — real-time friend location sharing (Zenly-style):
  presence updates, friend requests, ghost mode, groups, chat, emoji
  reactions, proximity ("bump") detection, and trail/exploration history,
  all gated by RLS share rules rather than trusting the client.
- **`@zairn/geo-drop`** — location-bound encrypted content ("drops"):
  content is encrypted client-side with a key derived from the drop's
  geohash, so the server never has access to plaintext. Unlocking is
  verified through a pluggable engine supporting GPS radius, shared
  secrets, AR/visual matching, and zero-knowledge proximity proofs
  (Groth16, via `circom`/`snarkjs`) that prove "within radius R of a
  point" without revealing the requester's exact coordinates.

Beyond the deployable application (a Vite/React web client plus Supabase
Edge Functions for server-side verification), the repository includes a
substantial evaluation harness under `eval/`: sensing-gate energy/GNSS
acquisition-ratio analysis replayed across five independent public
mobility datasets (GeoLife, T-Drive, CenceMe, StudentLife, plus an
on-device Android trace), GPS-spoofing trust-score sensitivity analysis
(ROC curves, threshold sensitivity, signal ablation, defense-in-depth
composition), and a corpus-based construct-validity analysis of how
consumer location-sharing apps' UI language represents inherently
uncertain location claims. All evaluation scripts operate on public or
locally-collected data and are runnable end-to-end from the repository.

# Statement of need

Location-sharing and location-bound content systems are widely deployed
commercially (Zenly, Life360, Find My, Snapchat Map), but production
implementations are closed-source, making it difficult for researchers to
inspect, extend, or benchmark against their access-control model,
GPS-spoofing defenses, or proof-of-proximity mechanisms. Conversely,
published research on privacy-preserving location proofs — zero-knowledge
proximity proofs, GPS-spoofing detection, location-based access control —
typically ships as isolated scripts or circuit definitions rather than an
integrated, deployable system with a real database schema, row-level
security policies, an SDK, a web client, and a reproducible evaluation
harness against public mobility datasets.

Zairn is aimed at researchers and practitioners working on
privacy-preserving location systems who need:

1. A **complete, deployable reference implementation** (schema + RLS
   policies + SDK + Edge Functions + web client) to study or build on,
   rather than a proof-of-concept script.
2. A **pluggable verification architecture** (`ProofVerifier` interface)
   for comparing location-proof methods — GPS radius, shared secret, AR
   matching, Groth16 zero-knowledge proximity proofs — under a common
   drop/unlock protocol.
3. A **reproducible evaluation harness** for GPS-spoofing trust scoring
   and sensing-gate energy tradeoffs, replayable across five public
   mobility datasets without requiring access to private data collection
   infrastructure.

<!-- TODO before submission: this section should cite the specific
research papers that use Zairn as their reference implementation once
their review status at other venues allows public linkage under the
author's real identity (see conversation — do not add without explicit
confirmation). -->

# Acknowledgements

TODO

# References
