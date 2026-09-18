# M1 Acceptance Evidence

Acceptance date: 2026-09-18

## Automated Verification

Status: passed

- Node.js: v24.19.0
- pnpm: 11.19.0
- Docker: 28.3.2
- Docker Compose: v2.38.2-desktop.1
- Vitest: 11 files passed, 29 tests passed
- TypeScript typecheck: passed
- ESLint: passed
- Prettier check: passed
- Production build: passed, including packaged SQLite migration
- Compose configuration: passed with non-secret test values
- Docker image build: passed
- Docker image ID: `sha256:dff8127dc450a3675cf44134ba3e3dcaeba499228c874ed0ce4586fb4e6d043e`
- Container startup check: passed as the non-root runtime user without Telegram polling

## Manual Telegram Acceptance

Status: passed

- [x] An unauthorized user receives no financial data.
- [x] A group message receives no financial data.
- [x] A valid expense message produces the expected TWD preview.
- [x] Cancelling a draft does not create a confirmed transaction.
- [x] Confirming a draft creates exactly one transaction.
- [x] Confirming the same draft again returns the existing transaction.
- [x] After a container restart, `/recent` returns the confirmed transaction.
- [x] The confirmed transaction links to its immutable input event.

Do not record the bot token, Telegram user or chat IDs, private financial text, or local absolute paths in this document.
