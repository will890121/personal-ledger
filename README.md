# Personal Ledger

Ledger Bot is a Telegram-first personal finance service. M1 accepts a deterministic expense such as `午餐 120`, previews it for confirmation, persists confirmed transactions in SQLite, and lists them with `/recent`.

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

From a fresh checkout, install dependencies and run the M1 verification suite:

```bash
pnpm install --frozen-lockfile && pnpm verify:m1
```

## Development

```bash
pnpm dev
```

The bot uses long polling. Only the private Telegram user identified by `LEDGER_OWNER_ID` is allowed through the adapter; group and other-user updates are ignored. Stop the process with `SIGINT` or `SIGTERM` so the bot and SQLite connection close cleanly.

## Docker

```bash
docker compose up --build
```

The named `ledger-data` volume stores `/app/data/personal-ledger.sqlite`. Telegram credentials stay in the local `.env` file and are injected by Compose; they are never copied into the image.
