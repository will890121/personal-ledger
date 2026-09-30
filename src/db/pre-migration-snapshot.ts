import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { pendingMigrationVersions } from "./migrate.js";

// 快照檔名固定長這樣：「<ISO 時間戳,冒號跟點換成連字號>-<目標版本>.sqlite」。
// pruneSnapshots 用這個樣式篩選要刪除的檔案,才不會誤刪 pre-migration/ 目錄底下
// 其他人手動放進來的東西。
const SNAPSHOT_FILENAME_PATTERN = /^\d+-.*\.sqlite$/;

/**
 * migration 之前拍一份快照。用 VACUUM INTO 而不是複製檔案:它由 SQLite 自己讀一致快照,
 * 在 WAL 模式下也正確(直接複製 .sqlite 檔案會漏掉還留在 WAL 裡的已提交資料)。
 *
 * 快照跟正本在同一個 volume,volume 整個損毀兩者都沒了。它的用途是 migration 失敗後
 * 的回滾,不是災難復原——災難復原是 scripts/backup.sh 加上之後里程碑的異地副本。
 *
 * 回傳快照路徑;沒有待套用的 migration 時回傳 null,不留下任何檔案——不然每一次
 * 正常重啟都會多一份用不到的快照。
 */
export function takePreMigrationSnapshot(
  database: Database.Database,
  dataDirectory: string,
  targetVersion: number,
  now: Date,
): string | null {
  // 全新資料庫(沒有 schema_migrations 表)或已經是最新版,都沒有東西需要保護。
  if (pendingMigrationVersions(database).length === 0) return null;

  const folder = join(dataDirectory, "pre-migration");
  mkdirSync(folder, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  // 時間戳放前面、版本放後面：ISO 時間戳是固定寬度,字典序天然等於時間序。
  // 反過來（版本在前）的話,版本一進到兩位數,「10-…」會排到「9-…」前面,而修剪是拿
  // 排序後最前面那個當「最舊」刪掉——結果會刪掉最新、最有價值的那一份,留下三份陳舊
  // 的。這不是排序函式該修的事,而是不要讓寬度可變的前綴擋在寬度固定的時間戳前面。
  const destination = join(folder, `${stamp}-${String(targetVersion)}.sqlite`);
  // VACUUM INTO 的目標路徑是 SQL 字串常值。資料目錄路徑在這個專案裡不是外部輸入,
  // 但路徑裡帶單引號不跳脫的話,得到的會是一段語法錯誤而不是清楚的失敗訊息,還是跳脫掉。
  database.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  pruneSnapshots(folder, 3);
  return destination;
}

// 同一個 volume 放不下無限份快照,而且舊的快照沒有回滾價值,只留最近三份。
// 只刪符合命名樣式的檔案,不管目錄裡還有什麼別的東西。
function pruneSnapshots(folder: string, keep: number): void {
  const snapshots = readdirSync(folder)
    .filter((file) => SNAPSHOT_FILENAME_PATTERN.test(file))
    .sort();
  const overflow = snapshots.length - keep;
  for (let index = 0; index < overflow; index += 1) {
    const file = snapshots[index];
    if (file) unlinkSync(join(folder, file));
  }
}
