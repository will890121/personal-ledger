import { z } from "zod";

const DEFAULT_DATABASE_PATH = "./data/personal-ledger.sqlite";
const DEFAULT_TIMEZONE = "Asia/Taipei";
const DEFAULT_CURRENCY = "TWD";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1, "TELEGRAM_BOT_TOKEN is required"),
  LEDGER_OWNER_ID: z.string().regex(/^\d+$/, "LEDGER_OWNER_ID must be numeric"),
  DATABASE_PATH: z.string().trim().min(1).default(DEFAULT_DATABASE_PATH),
  TZ: z.string().trim().min(1).default(DEFAULT_TIMEZONE),
  LEDGER_CURRENCY: z.literal(DEFAULT_CURRENCY).default(DEFAULT_CURRENCY),
});

export interface AppConfig {
  readonly telegramBotToken: string;
  readonly ownerId: string;
  readonly databasePath: string;
  readonly timezone: typeof DEFAULT_TIMEZONE;
  readonly currency: typeof DEFAULT_CURRENCY;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .filter((field) => field.length > 0);
    const uniqueFields = Array.from(new Set(fields));
    throw new Error(`Invalid configuration: ${uniqueFields.join(", ")}`);
  }

  return {
    telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
    ownerId: parsed.data.LEDGER_OWNER_ID,
    databasePath: parsed.data.DATABASE_PATH,
    timezone: DEFAULT_TIMEZONE,
    currency: DEFAULT_CURRENCY,
  };
}
