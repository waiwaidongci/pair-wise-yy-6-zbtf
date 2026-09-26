// 压模放行台 · 档案存储
// 负责压模档案的读写和查询；所有记录（含已失效的旧单）都留在档案里可查。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPEN_STATUSES, STATUS } from "./press-rules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const archivePath = join(__dirname, "data", "press-molding.json");

export async function loadArchive() {
  if (!existsSync(archivePath)) {
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, JSON.stringify({ records: [] }, null, 2));
  }
  return JSON.parse(await readFile(archivePath, "utf8"));
}

export async function saveArchive(db) {
  await writeFile(archivePath, JSON.stringify(db, null, 2));
}

export function newRecordId() {
  return "PM-" + Date.now();
}

// 一块墨锭没完成的压模记录（待补料/待复验），最多一条
export function findOpenByInk(db, inkCode) {
  if (!inkCode) return null;
  return db.records.find(r => r.inkCode === inkCode && OPEN_STATUSES.includes(r.status)) || null;
}

export function findById(db, id) {
  return db.records.find(r => r.id === id) || null;
}

// 列表筛选：按状态（待补料/待复验/已放行/已失效）和墨锭编号过滤
export function listRecords(db, { status, inkCode } = {}) {
  return db.records.filter(r =>
    (!status || r.status === status) && (!inkCode || r.inkCode === inkCode)
  );
}

// 某块墨锭当前仍有效的放行单（改模具/压力/加料量时用来判定旧放行失效）
export function findReleasedByInk(db, inkCode) {
  return db.records.filter(r => r.inkCode === inkCode && r.status === STATUS.RELEASED);
}
