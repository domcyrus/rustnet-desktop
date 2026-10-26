# Changelog

## [Unreleased]

### Changed
- Update frontend dependencies and support TypeScript 7 CSS imports while keeping the Tauri API aligned with Rust. Require Node.js 22.22.2+ or 24.15.0+ LTS. (#8)
- Update Vite to 7.3.7 and Vitest to 4.1.12 to resolve frontend dependency audit failures. (#7)
- Rebase the bundled engine patch onto RustNet main at `0144a88`, preserving process lifecycle checks and observed HTTP status details. (#7)
- Make extended engine metadata and capture accounting opt-in, enable both for the desktop, and publish accounting per worker batch. (#7)
- Simplify desktop capture state, traffic histories, and shared UI components; remove obsolete styles and unreachable UI. (#5)

### Added
- Add macOS debug-only sudo capture via `pnpm run desktop:sudo`, with terminal authentication, an unprivileged UI, and strict engine sandboxing.
- Add an opt-in macOS 13+ SMAppService capture helper for PKTAP, authenticated XPC, descriptor-only file access, and approval/removal controls. Activation requires a signed, notarized build.
- Initial standalone Tauri 2 desktop app with applications, connections, traffic charts, capture coverage, and recording.
- Pinned RustNet engine build with a temporary integration patch, debug overrides, and independent CI.
- Configure GitHub Dependabot for pnpm, Cargo, and Actions using RustNet’s daily grouped update policy.
- Upgrade the pinned pnpm package manager to 12.15.0 and document explicit install-script permission.
