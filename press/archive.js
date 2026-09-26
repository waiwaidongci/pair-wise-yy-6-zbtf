// 压模放行台 · 档案存储
// 所有压模记录只追加、不删除；旧放行失效后留在档案里可查。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS, ACTIVE_STATUSES } from "./rules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const pressDbPath = join(__dirname, "..", "data", "press-records.json");

const seed = {
  records: [
    {
      id: "PR-20260611-001",
      code: "IS-001",
      moldNo: "M-12",
      targetGrams: 60,
      feedGrams: 60.5,
      pressureMPa: 22,
      holdSeconds: 45,
      operator: "王墨生",
      status: STATUS.RELEASED,
      registeredAt: "2026-06-11T02:10:00.000Z",
      readings: {
        first: { inspector: "陈平", thicknessMm: 18.20, edgeIntact: true, at: "2026-06-11T02:30:00.000Z" },
        second: { inspector: "陈平", thicknessMm: 18.25, edgeIntact: true, at: "2026-06-11T02:55:00.000Z" },
        diffMm: 0.05,
      },
      releasedAt: "2026-06-11T02:55:00.000Z",
      events: [
        { at: "2026-06-11T02:10:00.000Z", type: "register", note: "登记压模，合格转待复验", operator: "王墨生" },
        { at: "2026-06-11T02:30:00.000Z", type: "first_reading", note: "首量厚度 18.20mm，检查员陈平，二十分钟后复量", inspector: "陈平" },
        { at: "2026-06-11T02:55:00.000Z", type: "release", note: "厚度差 0.05mm，边角完整，放行进入试磨", inspector: "陈平" },
      ],
    },
    {
      id: "PR-20260621-001",
      code: "IS-002",
      moldNo: "M-07",
      targetGrams: 58,
      feedGrams: 59.0,
      pressureMPa: 20,
      holdSeconds: 40,
      operator: "王墨生",
      status: STATUS.RELEASED,
      registeredAt: "2026-06-21T03:20:00.000Z",
      readings: {
        first: { inspector: "林雪", thicknessMm: 17.80, edgeIntact: true, at: "2026-06-21T03:40:00.000Z" },
        second: { inspector: "林雪", thicknessMm: 17.90, edgeIntact: true, at: "2026-06-21T04:02:00.000Z" },
        diffMm: 0.1,
      },
      releasedAt: "2026-06-21T04:02:00.000Z",
      events: [
        { at: "2026-06-21T03:20:00.000Z", type: "register", note: "登记压模，合格转待复验", operator: "王墨生" },
        { at: "2026-06-21T03:40:00.000Z", type: "first_reading", note: "首量厚度 17.80mm，检查员林雪，二十分钟后复量", inspector: "林雪" },
        { at: "2026-06-21T04:02:00.000Z", type: "release", note: "厚度差 0.1mm，边角完整，放行进入试磨", inspector: "林雪" },
      ],
    },
    {
      id: "PR-20260925-002",
      code: "IS-002",
      moldNo: "M-08",
      targetGrams: 58,
      feedGrams: 59.0,
      pressureMPa: 20,
      holdSeconds: 40,
      operator: "周砚",
      status: STATUS.VOID,
      registeredAt: "2026-09-20T06:00:00.000Z",
      releasedAt: "2026-09-20T06:40:00.000Z",
      readings: {
        first: { inspector: "陈平", thicknessMm: 17.80, edgeIntact: true, at: "2026-09-20T06:15:00.000Z" },
        second: { inspector: "陈平", thicknessMm: 17.90, edgeIntact: true, at: "2026-09-20T06:40:00.000Z" },
        diffMm: 0.1,
      },
      supersededBy: "PR-20260925-003",
      events: [
        { at: "2026-09-20T06:00:00.000Z", type: "register", note: "登记压模，合格转待复验", operator: "周砚" },
        { at: "2026-09-20T06:40:00.000Z", type: "release", note: "厚度差 0.1mm，边角完整，放行", inspector: "陈平" },
        { at: "2026-09-25T02:00:00.000Z", type: "supersede", note: "改用模具 M-07，旧放行失效，旧单留档可查", by: "周砚" },
      ],
    },
    {
      id: "PR-20260925-004",
      code: "IS-005",
      moldNo: "M-15",
      targetGrams: 62,
      feedGrams: 58.0,
      pressureMPa: 21,
      holdSeconds: 50,
      operator: "李压",
      status: STATUS.REFILL,
      registeredAt: "2026-09-25T07:10:00.000Z",
      rejectReasons: [{ code: "FEED_DEVIATION", message: "加料58g 偏离目标62g 达 4g，超过 3g" }],
      events: [
        { at: "2026-09-25T07:10:00.000Z", type: "register", note: "登记压模：加料58g 偏离目标62g 达 4g，超过 3g，转待补料", operator: "李压" },
      ],
    },
    {
      id: "PR-20260925-005",
      code: "IS-006",
      moldNo: "M-03",
      targetGrams: 60,
      feedGrams: 60.5,
      pressureMPa: 19,
      holdSeconds: 45,
      operator: "王墨生",
      status: STATUS.RECHECK,
      registeredAt: "2026-09-25T08:00:00.000Z",
      readings: {
        first: { inspector: "陈平", thicknessMm: 18.10, edgeIntact: true, at: "2026-09-25T08:20:00.000Z" },
      },
      events: [
        { at: "2026-09-25T08:00:00.000Z", type: "register", note: "登记压模，合格转待复验", operator: "王墨生" },
        { at: "2026-09-25T08:20:00.000Z", type: "first_reading", note: "首量厚度 18.10mm，检查员陈平，二十分钟后复量", inspector: "陈平" },
      ],
    },
  ],
};

let cache = null;

export class ArchiveError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export async function loadArchive() {
  if (cache) return cache;
  if (!existsSync(pressDbPath)) {
    await mkdir(dirname(pressDbPath), { recursive: true });
    await writeFile(pressDbPath, JSON.stringify(seed, null, 2));
  }
  cache = JSON.parse(await readFile(pressDbPath, "utf8"));
  cache.records ||= [];
  return cache;
}

export async function persist() {
  await writeFile(pressDbPath, JSON.stringify(cache, null, 2));
}

export function listRecords() {
  return [...cache.records].sort((a, b) =>
    String(b.registeredAt || "").localeCompare(String(a.registeredAt || ""))
  );
}

export function getRecord(id) {
  return cache.records.find((r) => r.id === id) || null;
}

function addEvent(record, type, note, extra = {}) {
  record.events ||= [];
  record.events.push({ at: new Date().toISOString(), type, note, ...extra });
}

export function newId(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const seq = cache.records.filter((r) => r.id.startsWith(`PR-${y}${m}${d}`)).length + 1;
  return `PR-${y}${m}${d}-${String(seq).padStart(3, "0")}`;
}

// 一块墨锭只能挂着一条没完成的压模记录
export function findActiveByCode(code) {
  return cache.records.find((r) => r.code === code && ACTIVE_STATUSES.includes(r.status)) || null;
}

export async function insertRecord(record) {
  cachePush(record);
  await persist();
  return record;
}

// 旧单失效 + 新单建档要一起落盘时，先只入缓存，由调用方统一 persist
export function cachePush(record) {
  cache.records.push(record);
}

export async function replaceRecord(record) {
  const idx = cache.records.findIndex((r) => r.id === record.id);
  if (idx === -1) throw new ArchiveError(404, "record_not_found", "压模记录不存在");
  cache.records[idx] = record;
  await persist();
  return record;
}

export { addEvent };

// 试磨入口校验：该墨锭当前必须有一条有效放行单（已放行且未被顶替）
export function latestReleasedByCode(code) {
  return cache.records
    .filter((r) => r.code === code && r.status === STATUS.RELEASED && !r.supersededBy)
    .sort((a, b) => String(b.releasedAt || "").localeCompare(String(a.releasedAt || "")))[0] || null;
}
