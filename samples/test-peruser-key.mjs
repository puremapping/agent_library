const BASE = "http://localhost:3000";
let pass = 0;
const check = (label, cond, d = "") => { if (cond) { pass++; console.log(`✅ ${label} ${d}`); } else console.log(`❌ ${label} ${d}`); };

// 1. 新用户（无 key）列书单 → 403 提示配置
const newUser = await fetch(`${BASE}/api/weread/books?agent=新用户`);
const newData = await newUser.json();
check("新用户无key列书单 403", newUser.status === 403 && /配置/.test(newData.error || ""), `(status=${newUser.status} ${newData.error})`);

// 2. 新用户配 key（格式校验）
const badKey = await fetch(`${BASE}/api/weread/key?agent=新用户`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ apiKey: "not-a-wrkey" }),
});
check("新用户配错误格式key 400", badKey.status === 400, `(status=${badKey.status})`);

// 3. 新用户配正确 key → 200，然后能列书单
const okKey = await fetch(`${BASE}/api/weread/key?agent=新用户`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ apiKey: "wrk-a0e3LVxURGS6BDjYM0a8wAAA" }),
});
check("新用户配正确key 200", okKey.status === 200, `(status=${okKey.status})`);
const list = await fetch(`${BASE}/api/weread/books?agent=新用户`);
check("配key后列书单 200", list.status === 200, `(status=${list.status})`);

// 4. 测试azhe（有key）列书单 → 200
const azheList = await fetch(`${BASE}/api/weread/books?agent=测试azhe`);
check("有key用户列书单 200", azheList.status === 200, `(status=${azheList.status})`);

// 5. key 隐私：其他用户看不到别人的 key（agents 列表不应暴露 weread_api_key）
const agents = await (await fetch(`${BASE}/api/agents?agent=opencode`)).json();
const hasKeyLeak = agents.some((a) => a.weread_api_key !== undefined && a.weread_api_key !== null);
check("agents列表不暴露weread_api_key", !hasKeyLeak, `(leak=${hasKeyLeak})`);

// 6. 未登录（无身份）列书单 → 403（requireHumanOrAdmin）
const noAuth = await fetch(`${BASE}/api/weread/books`);
check("无身份列书单 403", noAuth.status === 403, `(status=${noAuth.status})`);

console.log(`\n== 通过 ${pass}/6 ==`);
