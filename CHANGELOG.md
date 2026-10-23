# Changelog

## [Unreleased]

### Changed
- Update Vite to 7.3.7 and Vitest to 4.1.12 to resolve frontend dependency audit failures. (#7)
- Rebase the bundled engine patch onto RustNet main at `0144a88`, preserving process lifecycle checks and observed HTTP status details. (#7)
- Make extended engine metadata and capture accounting opt-in, enable both for the desktop, and publish accounting per worker batch. (#7)
- Simplify desktop capture state, traffic histories, and shared UI components; remove obsolete styles and unreachable UI. (#5)

### Added
- Initial standalone Tauri 2 desktop app with applications, connections, traffic charts, capture coverage, and recording.
- Pinned RustNet engine build with a temporary integration patch, debug overrides, and independent CI.
- Configure GitHub Dependabot for pnpm, Cargo, and Actions using RustNet’s daily grouped update policy.
- Upgrade the pinned pnpm package manager to 12.12.0.
