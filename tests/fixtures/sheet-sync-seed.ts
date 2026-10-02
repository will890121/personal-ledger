import type Database from "better-sqlite3";

/**
 * 種一筆「看得見的」交易：input_events → drafts → transactions 三層都補齊，
 * 因為 transactions 的外鍵要求前兩層存在。
 *
 * 注意：欄位名稱與 NOT NULL / CHECK 限制都對照 migrations 0001/0002/0003 之後的
 * 實際 schema，不是憑印象推測。鏡像的游標測試與收斂測試共用它——兩邊若各抄一份，
 * schema 一改就只有其中一邊會被修。
 */
export function seedTransaction(
  database: Database.Database,
  ownerId: string,
  input: {
    id: string;
    updatedAt: string;
    occurredDate?: string;
    status?: string;
    amount?: string;
  },
): void {
  const occurredDate = input.occurredDate ?? "2026-10-01";
  const amount = input.amount ?? "100";
  const status = input.status ?? "confirmed";

  database
    .prepare(
      `INSERT INTO input_events (
         event_id, owner_id, telegram_update_id, source_type, source_ref, raw_text, received_at
       ) VALUES (?, ?, ?, 'telegram', '1', 'seed', ?)`,
    )
    .run(`evt-${input.id}`, ownerId, `evt-${input.id}`, input.updatedAt);

  database
    .prepare(
      `INSERT INTO drafts (
         draft_id, owner_id, request_id, source_event_id, occurred_date, status,
         draft_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'archived', '{}', ?, ?)`,
    )
    .run(
      `draft-${input.id}`,
      ownerId,
      `req-${input.id}`,
      `evt-${input.id}`,
      occurredDate,
      input.updatedAt,
      input.updatedAt,
    );

  database
    .prepare(
      `INSERT INTO transactions (
         transaction_id, draft_id, owner_id, request_id, source_event_id, source_type, source_ref,
         occurred_date, amount, currency, status, confirmed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'telegram', '1', ?, ?, 'TWD', ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      `draft-${input.id}`,
      ownerId,
      `req-${input.id}`,
      `evt-${input.id}`,
      occurredDate,
      amount,
      status,
      input.updatedAt,
      input.updatedAt,
      input.updatedAt,
    );
}
