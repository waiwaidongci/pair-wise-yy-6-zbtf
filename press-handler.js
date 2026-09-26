// 压模放行台 · 请求处理
// HTTP 接口层：登记压模、补料、厚度复验、列表筛选；判定交给 press-rules，存取交给 press-archive。

import { STATUS, evaluateRegistration, evaluateInspection, releaseParamsChanged, toNumber } from "./press-rules.js";
import { loadArchive, saveArchive, newRecordId, findOpenByInk, findById, listRecords, findReleasedByInk } from "./press-archive.js";

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function truthy(value) {
  return value === true || value === "true" || value === "on" || value === "1" || value === "是";
}

export function createPressHandler({ readBody, send, findInkStick }) {
  // 改模具、压力或加料量时，把同一块墨锭的旧放行置为已失效（旧单留在档案里可查）
  function invalidateStaleReleases(db, inkCode, params, at) {
    for (const release of findReleasedByInk(db, inkCode)) {
      const changed = releaseParamsChanged(release, params);
      if (changed.length) {
        release.status = STATUS.INVALIDATED;
        release.invalidatedAt = at;
        release.invalidReason = "变更" + changed.join("、") + "，旧放行失效";
        release.updatedAt = at;
      }
    }
  }

  // 归一化五项登记参数；补料时缺省的项沿用记录里的旧值
  function normalizeParams(source, base = {}) {
    const pick = key => (isBlank(source[key]) ? base[key] ?? null : source[key]);
    return {
      moldNo: String(pick("moldNo") ?? "").trim(),
      targetWeight: toNumber(pick("targetWeight")),
      weight: toNumber(pick("weight")),
      pressure: toNumber(pick("pressure")),
      holdMinutes: toNumber(pick("holdMinutes")),
      operator: String(pick("operator") ?? "").trim(),
    };
  }

  // POST /api/press 登记压模：一块墨锭只能挂一条没完成的记录
  async function register(req, res) {
    const input = await readBody(req);
    const inkCode = String(input.inkCode || "").trim();
    if (!inkCode) return send(res, 400, { error: "缺少墨锭编号" });
    if (findInkStick) {
      const stick = await findInkStick(inkCode);
      if (!stick) return send(res, 404, { error: "墨锭不存在：" + inkCode });
    }
    const db = await loadArchive();
    const open = findOpenByInk(db, inkCode);
    if (open) {
      return send(res, 409, { error: "该墨锭已有未完成的压模记录（" + open.id + "，" + open.status + "）" });
    }
    const params = normalizeParams(input);
    const { pass, issues } = evaluateRegistration(params);
    const now = new Date().toISOString();
    const record = {
      id: newRecordId(),
      inkCode,
      ...params,
      status: pass ? STATUS.PENDING_RECHECK : STATUS.PENDING_REFILL,
      issues,
      refills: [],
      inspections: [],
      createdAt: now,
      updatedAt: now,
    };
    invalidateStaleReleases(db, inkCode, params, now);
    db.records.unshift(record);
    await saveArchive(db);
    return send(res, 201, record);
  }

  // POST /api/press/:id/refill 补料：重新判定，合格才转待复验
  async function refill(req, res, id) {
    const input = await readBody(req);
    const db = await loadArchive();
    const record = findById(db, id);
    if (!record) return send(res, 404, { error: "压模记录不存在：" + id });
    if (record.status !== STATUS.PENDING_REFILL) {
      return send(res, 409, { error: "当前状态为「" + record.status + "」，不能补料" });
    }
    const params = normalizeParams(input, record);
    const { pass, issues } = evaluateRegistration(params);
    const now = new Date().toISOString();
    record.refills.push({ at: now, ...params, note: String(input.note || "").trim() });
    Object.assign(record, params);
    record.issues = issues;
    record.status = pass ? STATUS.PENDING_RECHECK : STATUS.PENDING_REFILL;
    record.updatedAt = now;
    invalidateStaleReleases(db, record.inkCode, params, now);
    await saveArchive(db);
    return send(res, 200, record);
  }

  // POST /api/press/:id/inspection 厚度复验：通过则放行，不通过退回待补料
  async function inspect(req, res, id) {
    const input = await readBody(req);
    const db = await loadArchive();
    const record = findById(db, id);
    if (!record) return send(res, 404, { error: "压模记录不存在：" + id });
    if (record.status !== STATUS.PENDING_RECHECK) {
      return send(res, 409, { error: "当前状态为「" + record.status + "」，不能复验" });
    }
    const inspection = {
      inspector: String(input.inspector || "").trim(),
      thickness1: toNumber(input.thickness1),
      thickness2: toNumber(input.thickness2),
      measuredAt1: String(input.measuredAt1 || ""),
      measuredAt2: String(input.measuredAt2 || ""),
      edgesComplete: truthy(input.edgesComplete),
    };
    const { pass, issues } = evaluateInspection(record, inspection);
    const now = new Date().toISOString();
    record.inspections.push({ at: now, ...inspection, pass, issues });
    record.issues = issues;
    if (pass) {
      record.status = STATUS.RELEASED;
      record.releasedAt = now;
      record.releasedBy = inspection.inspector;
    } else {
      record.status = STATUS.PENDING_REFILL;
    }
    record.updatedAt = now;
    await saveArchive(db);
    return send(res, 200, record);
  }

  // GET /api/press?status=待补料&inkCode=IS-001 列表筛选
  async function list(res, url) {
    const db = await loadArchive();
    const records = listRecords(db, {
      status: url.searchParams.get("status") || "",
      inkCode: url.searchParams.get("inkCode") || "",
    });
    return send(res, 200, records);
  }

  // GET /api/press/:id 单条档案（旧单查询）
  async function getOne(res, id) {
    const db = await loadArchive();
    const record = findById(db, id);
    if (!record) return send(res, 404, { error: "压模记录不存在：" + id });
    return send(res, 200, record);
  }

  return async function handlePressRequest(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/press") return list(res, url);
    if (req.method === "POST" && url.pathname === "/api/press") return register(req, res);
    const match = url.pathname.match(/^\/api\/press\/([^/]+)(\/refill|\/inspection)?$/);
    if (match && req.method === "GET" && !match[2]) return getOne(res, decodeURIComponent(match[1]));
    if (match && req.method === "POST" && match[2] === "/refill") return refill(req, res, decodeURIComponent(match[1]));
    if (match && req.method === "POST" && match[2] === "/inspection") return inspect(req, res, decodeURIComponent(match[1]));
    return send(res, 404, { error: "not_found" });
  };
}
