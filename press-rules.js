// 压模放行台 · 判定规则
// 纯函数模块：只负责状态常量和判定逻辑，不碰请求、不碰存储。

export const STATUS = {
  PENDING_REFILL: "待补料",
  PENDING_RECHECK: "待复验",
  RELEASED: "已放行",
  INVALIDATED: "已失效",
};

// 没完成的压模记录 = 待补料 / 待复验（一块墨锭同时只能挂一条）
export const OPEN_STATUSES = [STATUS.PENDING_REFILL, STATUS.PENDING_RECHECK];

export const LIMITS = {
  minPressureMpa: 18, // 压力下限（兆帕）
  maxWeightDeviationG: 3, // 加料克重允许偏离目标（克）
  maxThicknessDiffMm: 0.2, // 两次厚度允许差值（毫米）
  minMeasureGapMinutes: 20, // 两次量测最小间隔（分钟）
};

// 登记时必须具备的项目
export const REQUIRED_FIELDS = [
  ["moldNo", "模具号"],
  ["targetWeight", "目标克重"],
  ["weight", "加料克重"],
  ["pressure", "压力"],
  ["holdMinutes", "保压时长"],
  ["operator", "操作人"],
];

const NUMERIC_FIELDS = [
  ["targetWeight", "目标克重"],
  ["weight", "加料克重"],
  ["pressure", "压力"],
  ["holdMinutes", "保压时长"],
];

const EPSILON = 1e-9;

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

export function toNumber(value) {
  if (isBlank(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 登记/补料判定：缺项、克重偏离目标超过3克、压力低于18兆帕 → 转待补料
export function evaluateRegistration(input) {
  const issues = [];
  for (const [key, label] of REQUIRED_FIELDS) {
    if (isBlank(input[key])) issues.push("缺项：" + label);
  }
  for (const [key, label] of NUMERIC_FIELDS) {
    if (!isBlank(input[key]) && toNumber(input[key]) === null) {
      issues.push("数值无效：" + label);
    }
  }
  const weight = toNumber(input.weight);
  const target = toNumber(input.targetWeight);
  const pressure = toNumber(input.pressure);
  if (weight !== null && target !== null) {
    const deviation = Math.abs(weight - target);
    if (deviation > LIMITS.maxWeightDeviationG + EPSILON) {
      issues.push("克重偏离目标" + deviation.toFixed(1) + "克，超过" + LIMITS.maxWeightDeviationG + "克");
    }
  }
  if (pressure !== null && pressure < LIMITS.minPressureMpa) {
    issues.push("压力" + pressure + "兆帕，低于" + LIMITS.minPressureMpa + "兆帕");
  }
  return { pass: issues.length === 0, issues };
}

// 复验判定：另一位检查员、两次量测间隔不少于20分钟、
// 厚度差值不超过0.2毫米且边角完整 → 才放行
export function evaluateInspection(record, inspection) {
  const issues = [];
  const inspector = String(inspection.inspector || "").trim();
  if (!inspector) {
    issues.push("缺项：检查员");
  } else if (inspector === String(record.operator || "").trim()) {
    issues.push("复验检查员与操作人是同一人，须换另一位检查员");
  }
  const t1 = toNumber(inspection.thickness1);
  const t2 = toNumber(inspection.thickness2);
  if (t1 === null) issues.push("缺项：第一次厚度");
  if (t2 === null) issues.push("缺项：第二次厚度");
  const at1 = Date.parse(inspection.measuredAt1);
  const at2 = Date.parse(inspection.measuredAt2);
  if (!Number.isFinite(at1) || !Number.isFinite(at2)) {
    issues.push("缺项：两次量测时间");
  } else {
    const gapMinutes = Math.abs(at2 - at1) / 60000;
    if (gapMinutes < LIMITS.minMeasureGapMinutes) {
      issues.push("两次量测间隔" + gapMinutes.toFixed(0) + "分钟，不足" + LIMITS.minMeasureGapMinutes + "分钟");
    }
  }
  if (t1 !== null && t2 !== null) {
    const diff = Math.abs(t1 - t2);
    if (diff > LIMITS.maxThicknessDiffMm + EPSILON) {
      issues.push("两次厚度差" + diff.toFixed(2) + "毫米，超过" + LIMITS.maxThicknessDiffMm + "毫米");
    }
  }
  if (!inspection.edgesComplete) issues.push("边角不完整");
  return { pass: issues.length === 0, issues };
}

// 改模具、压力或加料量会让旧放行失效；返回变更项名称列表，空数组表示未变更
export function releaseParamsChanged(record, params) {
  const changed = [];
  if (String(record.moldNo ?? "") !== String(params.moldNo ?? "")) changed.push("模具号");
  if (toNumber(record.pressure) !== toNumber(params.pressure)) changed.push("压力");
  if (toNumber(record.weight) !== toNumber(params.weight)) changed.push("加料克重");
  return changed;
}
