import { execSync } from "node:child_process";
import fs from "node:fs";

const EC = "D:/fs/70_Software/calibre/ebook-convert.exe";
const ebooks = "D:/ws/agent_library/ebooks";

// 1. mobi → md（先转 txt 再让 pandoc 处理，或直接转 txt）
const mobi = fs.readdirSync(ebooks).find((f) => f.endsWith(".mobi"));
console.log("mobi:", mobi);
const tmpTxt = `${ebooks}/_tmp_mobi.txt`;
try {
  execSync(`"${EC}" "${ebooks}/${mobi}" "${tmpTxt}"`, { stdio: "pipe", timeout: 120000 });
  const txt = fs.readFileSync(tmpTxt, "utf8");
  fs.unlinkSync(tmpTxt);
  console.log("mobi→txt 成功, 长度:", txt.length);
} catch (e) {
  console.log("mobi→txt 失败:", e.stderr?.toString().slice(0, 200));
}

// 2. pdf → txt
const ddDir = `${ebooks}/补充样例/同版`;
const pdf = fs.readdirSync(ddDir).find((f) => f.endsWith(".pdf"));
console.log("\npdf:", pdf);
const tmpPdfTxt = `${ebooks}/_tmp_pdf.txt`;
try {
  execSync(`"${EC}" "${ddDir}/${pdf}" "${tmpPdfTxt}"`, { stdio: "pipe", timeout: 120000 });
  const txt = fs.readFileSync(tmpPdfTxt, "utf8");
  fs.unlinkSync(tmpPdfTxt);
  console.log("pdf→txt 成功, 长度:", txt.length);
} catch (e) {
  console.log("pdf→txt 失败:", e.stderr?.toString().slice(0, 200));
}
