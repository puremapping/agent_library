import { execSync } from "node:child_process";
import fs from "node:fs";

const EC = "D:/fs/70_Software/calibre/ebook-convert.exe";
const ebooks = "D:/ws/agent_library/ebooks";

const mobi = fs.readdirSync(ebooks).find((f) => f.endsWith(".mobi"));
console.log("mobi 文件:", mobi);
const out = `${ebooks}/_tmp_mobi.txt`;
try {
  execSync(`"${EC}" "${ebooks}/${mobi}" "${out}"`, { stdio: "pipe", timeout: 300000 });
  const txt = fs.readFileSync(out, "utf8");
  fs.unlinkSync(out);
  console.log("mobi→txt 成功, 长度:", txt.length, "前200:", txt.slice(0, 200).replace(/\n/g, " "));
} catch (e) {
  console.log("失败:", e.stderr?.toString().slice(0, 300));
}
