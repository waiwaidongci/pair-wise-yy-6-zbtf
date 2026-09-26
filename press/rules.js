// 压模放行台 · 判定规则
// 纯函数模块，不碰 HTTP 和文件，方便单测和复用。

export const TARGET_TOLERANCE_GRAMS = 3; // 加料克重偏离目标超过 3g 转待补料
export const MIN_PRESSURE_MPA = 18; // 压力低于 18MPa 转待补料
export const MAX_THICKNESS_DIFF_MM = 0.2; // 两次厚度差值不超过 0.2mm 才放行
export const REREAD_INTERVAL_MS = 20 * 60 * 1000; // 两次量厚间隔二十分钟

export const STATUS = Object.freeze({
  REFILL: "待补料",
  RECHECK: "待复验",
  RELEASED: "已放行",
  VOID: "已失效", // 旧放行被关键参数变更顶替后的留档状态
});

export const FILTER_STATUSES = [STATUS.REFILL, STATUS.RECHECK, STATUS.RELEASED, STATUS.VOID];
export const ACTIVE_STATUSES = [STATUS.REFILL, STATUS.RECHECK]; // 没完成的压模单

// 改这三项会让旧放行失效
export const RELEASE_KEY_FIELDS = ["moldNo", "feedGrams", "pressureMPa"];

const TEXT_FIELDS = [
  ["code", "墨锭编号"],
  ["moldNo", "模具号"],
  ["operator", "操作人"],
];
const NUMERIC_FIELDS = [
  ["targetGrams", "目标克重"],
  ["feedGrams", "加料克重"],
  ["pressureMPa", "压力"],
  ["holdSeconds", "保压时长"],
];
export const REGISTRATION_FIELDS = [...TEXT_FIELDS, ...NUMERIC_FIELDS];

export function cleanText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

// 空串 -> null（缺项）；无法解析 -> NaN（格式错误）；否则返回数字
export function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const s = cleanText(value);
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function round(n, digits = 3) {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

// 登记 / 补料后的统一判定：缺项、加料偏离>3g、压力<18MPa -> 待补料，否则待复验
export function evaluatePress(input) {
  const values = {};
  const reasons = [];

  for (const [key] of TEXT_FIELDS) {
    const s = cleanText(input[key]);
    if (s === "") reasons.push({ code: "MISSING", field: key, message: `缺少${fieldLabel(key)}` });
    else values[key] = s;
  }
  for (const [key] of NUMERIC_FIELDS) {
    const n = toNumber(input[key]);
    if (n === null) reasons.push({ code: "MISSING", field: key, message: `缺少${fieldLabel(key)}` });
    else if (Number.isNaN(n)) reasons.push({ code: "BAD_NUMBER", field: key, message: `${fieldLabel(key)}需为数字` });
    else values[key] = n;
  }

  if (Number.isFinite(values.feedGrams) && Number.isFinite(values.targetGrams)) {
    const diff = round(Math.abs(values.feedGrams - values.targetGrams), 2);
    if (diff > TARGET_TOLERANCE_GRAMS) {
      reasons.push({
        code: "FEED_DEVIATION",
        message: `加料${values.feedGrams}g 偏离目标${values.targetGrams}g 达 ${diff}g，超过 ${TARGET_TOLERANCE_GRAMS}g`,
      });
    }
  }
  if (Number.isFinite(values.pressureMPa) && values.pressureMPa < MIN_PRESSURE_MPA) {
    reasons.push({
      code: "LOW_PRESSURE",
      message: `压力 ${values.pressureMPa}MPa 低于 ${MIN_PRESSURE_MPA}MPa`,
    });
  }

  return {
    values,
    reasons,
    status: reasons.length === 0 ? STATUS.RECHECK : STATUS.REFILL,
  };
}

export function fieldLabel(key) {
  const hit = REGISTRATION_FIELDS.find(([k]) => k === key);
  return hit ? hit[1] : key;
}

export function toEdgeIntact(value) {
  return value === true || value === "true" || value === "on" || value === 1 || value === "1";
}

// 检查员复验量厚。返回 { error } 或 { phase: "first" } / { phase: "second", passed, ... }
export function reviewReading(record, input, now = new Date()) {
  if (record.status !== STATUS.RECHECK) {
    return { error: { status: 409, code: "NOT_RECHECK", message: "只有待复验的压模单能量厚度" } };
  }
  const inspector = cleanText(input.inspector);
  if (!inspector) {
    return { error: { status: 400, code: "MISSING_INSPECTOR", message: "请填写检查员" } };
  }
  if (inspector === record.operator) {
    return { error: { status: 409, code: "SAME_OPERATOR", message: "复验必须由另一位检查员执行，不能是压模操作人本人" } };
  }
  const thickness = toNumber(input.thicknessMm);
  if (thickness === null || Number.isNaN(thickness) || thickness < 0) {
    return { error: { status: 400, code: "BAD_THICKNESS", message: "厚度需为不小于 0 的数字（毫米）" } };
  }

  const first = record.readings && record.readings.first;
  if (!first) {
    return { phase: "first", reading: { inspector, thicknessMm: round(thickness), at: now.toISOString() } };
  }

  if (inspector !== first.inspector) {
    return { error: { status: 409, code: "INSPECTOR_CHANGED", message: `两次厚度须由同一位检查员量（首量检查员：${first.inspector}）` } };
  }
  const elapsed = now.getTime() - new Date(first.at).getTime();
  if (elapsed < REREAD_INTERVAL_MS) {
    const waitMinutes = Math.ceil((REREAD_INTERVAL_MS - elapsed) / 60000);
    return { error: { status: 409, code: "TOO_EARLY", message: `距首量不足二十分钟，请 ${waitMinutes} 分钟后再录第二次厚度`, waitMinutes } };
  }

  const edgeIntact = toEdgeIntact(input.edgeIntact);
  const diffMm = round(Math.abs(thickness - first.thicknessMm));
  const failReasons = [];
  if (diffMm > MAX_THICKNESS_DIFF_MM) {
    failReasons.push({ code: "THICKNESS_DIFF", message: `两次厚度差 ${diffMm}mm，超过 ${MAX_THICKNESS_DIFF_MM}mm` });
  }
  if (!edgeIntact) {
    failReasons.push({ code: "EDGE_DAMAGED", message: "边角不完整，需补料重修" });
  }

  return {
    phase: "second",
    reading: { inspector, thicknessMm: round(thickness), edgeIntact, at: now.toISOString() },
    diffMm,
    passed: failReasons.length === 0,
    failReasons,
    // 厚度差超标：留在待复验再量；边角缺损：退回待补料
    nextStatus: failReasons.some((r) => r.code === "EDGE_DAMAGED") ? STATUS.REFILL : STATUS.RECHECK,
  };
}

// 已放行单改模具/压力/加料量 -> 判定哪些关键项变了
export function detectKeyChanges(oldRecord, values) {
  const changed = [];
  for (const key of RELEASE_KEY_FIELDS) {
    if (values[key] !== undefined && values[key] !== oldRecord[key]) {
      changed.push({ key, label: fieldLabel(key), from: oldRecord[key], to: values[key] });
    }
  }
  return changed;
}
