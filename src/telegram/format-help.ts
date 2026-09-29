import { LEDGER_COMMANDS } from "./commands.js";

/**
 * `/help` 的版面：先示範怎麼打字，指令清單放在最後。
 *
 * 這個 bot 的主要介面是自由文字，不是指令——使用者三個月後會忘記的是
 * 「午餐 120」這種句子怎麼寫，而不是總共有哪八個指令。把輸入範例放在最前面，
 * 讓真正會被遺忘的東西先被看到。
 *
 * 指令段落由 LEDGER_COMMANDS 展開，不手動抄一份：這份清單同時也是
 * setMyCommands 的參數與 handler 註冊的依據，三者永遠一致。
 */
export function formatHelp(): string {
  const commandLines = LEDGER_COMMANDS.map(
    ({ command, description }) => `/${command} - ${description}`,
  ).join("\n");

  return [
    "直接打字就能記帳，不需要先學指令：",
    "",
    "午餐 120",
    "薪水 +85000",
    "台新轉國泰 5000 手續費 15",
    "午餐 1260，小明欠 630",
    "",
    "金額前面加「+」代表收入，不加符號預設是支出；用「，...欠...」記代墊或分帳，",
    "之後可以用 /advances 查還沒收回的部分。",
    "",
    "指令：",
    commandLines,
  ].join("\n");
}
