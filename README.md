# Personal Ledger

Ledger Bot is a Telegram-first personal finance service. M0 establishes the engineering baseline: TypeScript strict ESM, Vitest, ESLint, Docker, and configuration validation.

## Requirements

- Node.js 24 LTS
- pnpm 10.x preferred via `packageManager`; pnpm 11 is also accepted for local tooling compatibility
- Docker 28 or newer for container builds

## Setup

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

Fill in `.env` locally. Do not commit real Telegram tokens or owner IDs.

## Quality Checks

```bash
pnpm check
```

From a fresh checkout, the M0 acceptance suite installs dependencies, runs all quality checks, and builds the Docker image with one command:

```bash
pnpm install --frozen-lockfile && pnpm verify:m0
```

## Development

```bash
pnpm dev
```

M0 only validates configuration and startup wiring. The Telegram and SQLite transaction flow begins in M1.
