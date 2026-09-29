import Database from "better-sqlite3";

export function openDatabase(path: string): Database.Database {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  // 規格 §15.2 要求 WAL。記憶體資料庫不支援，pragma 會回 "memory"，不視為錯誤。
  database.pragma("journal_mode = WAL");
  // synchronous=FULL：NORMAL 在主機斷電時可能丟掉最近幾筆已提交交易。這是帳本，
  // 而寫入量是一天幾筆，fsync 成本無關緊要。
  database.pragma("synchronous = FULL");
  return database;
}
