// 压模放行台 · 请求处理（HTTP 路由 + 页面）
// 判定细节走 rules.js，落盘走 archive.js。

import {
  STATUS,
  FILTER_STATUSES,
  RELEASE_KEY_FIELDS,
  evaluatePress,
  reviewReading,
  detectKeyChanges,
  cleanText,
} from "./rules.js";
import {
  loadArchive,
  persist,
  listRecords,
  getRecord,
  insertRecord,
  replaceRecord,
  findActiveByCode,
  newId,
  addEvent,
  cachePush,
  ArchiveError,
} from "./archive.js";

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
  return true;
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
  return true;
}
function fail(res, error) {
  if (error instanceof ArchiveError) {
    return send(res, error.status, { error: error.code, message: error.message });
  }
  return send(res, 500, { error: "server_error", message: error.message });
}

// ---- 业务动作 ----

async function registerRecord(input) {
  const code = cleanText(input.code);
  if (!code) throw new ArchiveError(400, "MISSING_CODE", "请填写墨锭编号");
  const active = findActiveByCode(code);
  if (active) {
    throw new ArchiveError(
      409,
      "ACTIVE_RECORD_EXISTS",
      `墨锭 ${code} 已挂着未完成的压模单 ${active.id}（${active.status}），一块墨锭只能有一条`,
      { existingId: active.id }
    );
  }
  const result = evaluatePress(input);
  const now = new Date();
  const record = {
    id: newId(now),
    code,
    ...result.values,
    status: result.status,
    registeredAt: now.toISOString(),
    events: [],
  };
  if (result.reasons.length) record.rejectReasons = result.reasons;
  addEvent(
    record,
    "register",
    result.reasons.length
      ? `登记压模：${result.reasons.map((r) => r.message).join("；")}，转待补料，不进入试磨`
      : "登记压模，合格转待复验",
    { operator: record.operator }
  );
  return insertRecord(record);
}

async function refillRecord(id, input) {
  const record = getRecord(id);
  if (!record) throw new ArchiveError(404, "record_not_found", "压模记录不存在");
  if (record.status !== STATUS.REFILL) {
    throw new ArchiveError(409, "NOT_REFILL", "只有待补料的压模单能登记补料");
  }
  const result = evaluatePress({ ...record, ...input, code: record.code });
  for (const [key, value] of Object.entries(result.values)) record[key] = value;

  if (result.reasons.length) {
    record.rejectReasons = result.reasons;
    addEvent(record, "refill", `补料登记后仍不合格：${result.reasons.map((r) => r.message).join("；")}，继续待补料`);
    await replaceRecord(record);
    return record;
  }

  delete record.rejectReasons;
  delete record.readings; // 补料重修，厚度复验从头来
  record.status = STATUS.RECHECK;
  addEvent(record, "refill", "补料完成，克重与压力复核合格，转待复验等检查员量厚", { by: record.operator });
  await replaceRecord(record);
  return record;
}

async function addReading(id, input, now = new Date()) {
  const record = getRecord(id);
  if (!record) throw new ArchiveError(404, "record_not_found", "压模记录不存在");
  const verdict = reviewReading(record, input, now);
  if (verdict.error) {
    throw new ArchiveError(verdict.error.status, verdict.error.code, verdict.error.message, verdict.error);
  }

  if (verdict.phase === "first") {
    record.readings = { first: verdict.reading };
    addEvent(
      record,
      "first_reading",
      `首量厚度 ${verdict.reading.thicknessMm}mm，检查员${verdict.reading.inspector}，二十分钟后复量`,
      { inspector: verdict.reading.inspector }
    );
    await replaceRecord(record);
    return record;
  }

  record.readings.second = verdict.reading;
  record.readings.diffMm = verdict.diffMm;
  if (verdict.passed) {
    record.status = STATUS.RELEASED;
    record.releasedAt = now.toISOString();
    delete record.rejectReasons;
    addEvent(
      record,
      "release",
      `两次厚度差 ${verdict.diffMm}mm，边角完整，放行进入试磨`,
      { inspector: verdict.reading.inspector }
    );
  } else {
    record.readingAttempts ||= [];
    record.readingAttempts.push({
      first: record.readings.first,
      second: verdict.reading,
      diffMm: verdict.diffMm,
      failReasons: verdict.failReasons,
      at: now.toISOString(),
    });
    record.status = verdict.nextStatus;
    record.rejectReasons = verdict.failReasons;
    addEvent(
      record,
      "recheck_failed",
      `复验不合格：${verdict.failReasons.map((r) => r.message).join("；")}，${
        verdict.nextStatus === STATUS.REFILL ? "退回待补料" : "留待复验，请重新量两次"
      }`,
      { inspector: verdict.reading.inspector }
    );
    delete record.readings;
  }
  await replaceRecord(record);
  return record;
}

// 改模具、压力或加料量：旧放行失效留档，另开新单重走复验
async function reviseRecord(id, input, now = new Date()) {
  const old = getRecord(id);
  if (!old) throw new ArchiveError(404, "record_not_found", "压模记录不存在");
  if (old.status !== STATUS.RELEASED) {
    throw new ArchiveError(409, "NOT_RELEASED", "只有已放行单在改模具/压力/加料量时需要重新放行");
  }
  const values = {};
  for (const key of RELEASE_KEY_FIELDS) {
    if (input[key] !== undefined && cleanText(input[key]) !== "") values[key] = isNaN(Number(input[key])) ? cleanText(input[key]) : Number(input[key]);
  }
  const operator = cleanText(input.operator);
  if (!operator) throw new ArchiveError(400, "MISSING_OPERATOR", "请填写本次改模/改参数的操作人");

  const changes = detectKeyChanges(old, values);
  if (!changes.length) {
    throw new ArchiveError(400, "NO_KEY_CHANGE", "模具号、压力、加料克重都没变化，无需重开放行单");
  }

  const nowIso = now.toISOString();
  const result = evaluatePress({ ...old, ...values, code: old.code });
  const record = {
    id: newId(now),
    code: old.code,
    ...result.values,
    status: result.status,
    registeredAt: nowIso,
    sourceRecordId: old.id,
    events: [],
  };
  if (result.reasons.length) record.rejectReasons = result.reasons;

  const changeText = changes.map((c) => `${c.label} ${c.from}→${c.to}`).join("、");
  addEvent(
    record,
    "register",
    `由 ${old.id} 改参重建（${changeText}），${result.reasons.length ? "参数不合格，转待补料" : "转待复验重新量厚"}`,
    { operator }
  );

  old.status = STATUS.VOID;
  old.supersededBy = record.id;
  addEvent(old, "supersede", `改${changes.map((c) => c.label).join("/")}（${changeText}），旧放行失效，旧单留档可查`, { by: operator });

  cachePush(record);
  await persist();
  return record;
}

function computeStats(records) {
  const stats = Object.fromEntries(FILTER_STATUSES.map((s) => [s, 0]));
  for (const r of records) if (stats[r.status] !== undefined) stats[r.status] += 1;
  return stats;
}

export async function serve(req, res, url) {
  if (url.pathname !== "/press" && !url.pathname.startsWith("/api/press")) return false;
  try {
    if (req.method === "GET" && url.pathname === "/press") return await html(res, page());
    await loadArchive();

    if (req.method === "GET" && url.pathname === "/api/press/records") {
      let records = listRecords();
      const status = url.searchParams.get("status");
      const q = (url.searchParams.get("q") || "").trim();
      if (status) records = records.filter((r) => r.status === status);
      if (q) records = records.filter((r) => JSON.stringify(r).includes(q));
      return await send(res, 200, records);
    }
    if (req.method === "GET" && url.pathname === "/api/press/stats") {
      return await send(res, 200, computeStats(listRecords()));
    }
    if (req.method === "POST" && url.pathname === "/api/press/records") {
      return await send(res, 201, await registerRecord(await readBody(req)));
    }
    const sub = url.pathname.match(/^\/api\/press\/records\/([^/]+)(\/(refill|readings|revise))?$/);
    if (sub) {
      const [, id, , action] = sub;
      const input = ["POST"].includes(req.method) ? await readBody(req) : {};
      if (req.method === "GET" && !action) {
        const record = getRecord(id);
        return record ? send(res, 200, record) : send(res, 404, { error: "record_not_found", message: "压模记录不存在" });
      }
      if (req.method === "POST" && action === "refill") return await send(res, 200, await refillRecord(id, input));
      if (req.method === "POST" && action === "readings") return await send(res, 200, await addReading(id, input));
      if (req.method === "POST" && action === "revise") return await send(res, 201, await reviseRecord(id, input));
    }
    return await send(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    return fail(res, error);
  }
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>压模放行台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#8a6d2f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; } main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; margin-top:12px; } button.secondary { background:#69736a; } button.mini { padding:6px 10px; margin:8px 0 0; font-size:13px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:170px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; } .card { display:grid; gap:7px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.待补料 { background:#f7e8e4; border-color:#d8a798; color:var(--warn); }
    .pill.待复验 { background:#f6efdd; border-color:#d8c48f; color:var(--hold); }
    .pill.已放行 { background:#e6efe0; border-color:#9db890; color:var(--accent); }
    .pill.已失效 { background:#ececea; border-color:#c7c9c2; color:var(--muted); }
    .warn { color:var(--warn); font-size:13px; } .ok { color:var(--accent); font-weight:700; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:104px; overflow:auto; }
    .inlineform { border-top:1px dashed var(--line); margin-top:10px; padding-top:6px; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .checkline { display:flex; align-items:center; gap:8px; margin-top:10px; color:var(--muted); font-size:13px; } .checkline input { width:auto; }
    #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#3a3f38; color:#fff; padding:11px 18px; border-radius:8px; max-width:80vw; display:none; }
    .nav a { color:var(--accent); font-weight:700; text-decoration:none; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>压模放行台</h1><div class="meta">登记即判：缺项 / 加料偏目标超 3g / 压力低于 18MPa 一律转待补料，挡住不进入试磨</div></div>
    <div class="nav"><a href="/">← 回墨锭试磨室</a></div>
  </header>
  <main>
    <section>
      <form id="regForm">
        <h2>登记压模</h2>
        <label>墨锭编号</label><input name="code" required placeholder="如 IS-007">
        <div id="regFields"></div>
        <div class="meta" style="margin-top:10px">一块墨锭只能挂一条没完成的压模单；合格单转待复验，由另一位检查员隔二十分钟量两次厚度。</div>
        <button>登记并判定</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="statusFilter">
          <option value="">全部</option>
          <option>待补料</option>
          <option>待复验</option>
          <option>已放行</option>
          <option>已失效</option>
        </select>
        <input id="search" placeholder="搜墨锭号 / 模具号 / 操作人 / 单号">
        <button type="button" class="secondary" id="reload">刷新</button>
      </div>
      <div class="panel"><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <div id="toast"></div>
  <script>
    const regFields = [["moldNo","模具号"],["targetGrams","目标克重(g)"],["feedGrams","加料克重(g)"],["pressureMPa","压力(MPa)"],["holdSeconds","保压时长(秒)"],["operator","操作人"]];
    const stages = ["待补料","待复验","已放行","已失效"];
    const cardsEl = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    let records = [];

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{'Content-Type':'application/json'} } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '请求失败');
      return data;
    }
    function toast(msg) { const t = document.querySelector('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._timer); t._timer = setTimeout(() => { t.style.display = 'none'; }, 4000); }
    function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    function fmtTime(at) { return at ? new Date(at).toLocaleString('zh-CN', { hour12:false }) : ''; }
    function inputHtml(name, label, value) { return '<label>'+label+'</label><input name="'+name+'" value="'+esc(value === undefined ? '' : value)+'">'; }

    function renderRegFields() {
      document.querySelector('#regFields').innerHTML = regFields.map(f => inputHtml(f[0], f[1], '')).join('');
    }

    function refillFormHtml(r) {
      const fields = [["moldNo","模具号"],["targetGrams","目标克重(g)"],["feedGrams","加料克重(g)"],["pressureMPa","压力(MPa)"],["holdSeconds","保压时长(秒)"]].map(f => inputHtml(f[0], f[1], r[f[0]])).join('');
      return '<button type="button" class="mini secondary" data-open="refill-'+r.id+'">登记补料</button>'
        + '<div class="inlineform" id="refill-'+r.id+'" hidden><form data-action="refill" data-id="'+r.id+'">'
        + '<div class="row">'+fields + inputHtml('operator','补料操作人', r.operator) + '</div>'
        + '<button class="mini">提交补料并重新判定</button></form></div>';
    }
    function readingFormHtml(r) {
      const first = r.readings && r.readings.first;
      const hint = first
        ? '<div class="meta">首量 '+first.thicknessMm+'mm（'+esc(first.inspector)+'，'+fmtTime(first.at)+'）；须同一检查员、间隔满二十分钟。</div>'
        : '<div class="meta">检查员不能是压模操作人（'+esc(r.operator)+'）；录首量后隔二十分钟再录第二次。</div>';
      const inspector = inputHtml('inspector','检查员', first ? first.inspector : '');
      const edge = first ? '<label class="checkline"><input type="checkbox" name="edgeIntact" checked>边角完整无缺料</label>' : '';
      return '<button type="button" class="mini secondary" data-open="reading-'+r.id+'">'+(first ? '录第二次厚度' : '检查员量厚')+'</button>'
        + '<div class="inlineform" id="reading-'+r.id+'" hidden><form data-action="readings" data-id="'+r.id+'">'
        + hint + '<div class="row">'+inspector + inputHtml('thicknessMm','厚度(mm)','') + '</div>' + edge
        + '<button class="mini">提交厚度</button></form></div>';
    }
    function reviseFormHtml(r) {
      return '<button type="button" class="mini secondary" data-open="revise-'+r.id+'">改模具/压力/加料量</button>'
        + '<div class="inlineform" id="revise-'+r.id+'" hidden><form data-action="revise" data-id="'+r.id+'">'
        + '<div class="meta">模具号、压力或加料克重一变动，旧放行立即失效并留档，新单重新复验。</div>'
        + '<div class="row">' + inputHtml('moldNo','模具号', r.moldNo) + inputHtml('feedGrams','加料克重(g)', r.feedGrams)
        + inputHtml('pressureMPa','压力(MPa)', r.pressureMPa) + inputHtml('operator','操作人','') + '</div>'
        + '<button class="mini">提交改动，旧单失效</button></form></div>';
    }
    function actionBlock(r) {
      if (r.status === '待补料') return refillFormHtml(r);
      if (r.status === '待复验') return readingFormHtml(r);
      if (r.status === '已放行') return reviseFormHtml(r);
      return '<div class="meta">旧放行已失效，由 '+esc(r.supersededBy || '后续单')+' 顶替，仅留档查询。</div>';
    }
    function reasonsHtml(r) {
      return (r.rejectReasons || []).map(x => '<div class="warn">✗ '+esc(x.message)+'</div>').join('');
    }
    function readingsHtml(r) {
      if (!r.readings) return '';
      const f = r.readings.first;
      let html = '<div class="meta">首量 '+f.thicknessMm+'mm · '+esc(f.inspector)+' · '+fmtTime(f.at)+'</div>';
      if (r.readings.second) {
        html += '<div class="meta">复量 '+r.readings.second.thicknessMm+'mm · '+fmtTime(r.readings.second.at)+' · 差值 '+r.readings.diffMm+'mm</div>';
      }
      return html;
    }
    function cardHtml(r) {
      const delta = (r.feedGrams !== undefined && r.targetGrams !== undefined) ? Math.abs(r.feedGrams - r.targetGrams) : null;
      const events = (r.events || []).slice(-4).map(e => '<div>· '+esc(e.note)+'</div>').join('');
      const released = r.status === '已放行' ? '<div class="ok">放行时间 '+fmtTime(r.releasedAt)+'</div>' : '';
      return '<article class="card">'
        + '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3>'+esc(r.code)+'</h3><span class="pill '+r.status+'">'+r.status+'</span></div>'
        + '<div class="meta">'+esc(r.id)+' · 登记于 '+fmtTime(r.registeredAt)+'</div>'
        + '<div><b>模具</b> '+esc(r.moldNo)+'　<b>加料</b> '+esc(r.feedGrams)+'g / 目标 '+esc(r.targetGrams)+'g'+(delta !== null ? '（偏 '+Math.round(delta*100)/100+'g）' : '')+'</div>'
        + '<div><b>压力</b> '+esc(r.pressureMPa)+'MPa　<b>保压</b> '+esc(r.holdSeconds)+'秒　<b>操作人</b> '+esc(r.operator)+'</div>'
        + reasonsHtml(r) + readingsHtml(r) + released
        + actionBlock(r)
        + '<div class="logs meta">'+(events || '暂无记录')+'</div>'
        + '</article>';
    }
    function render() {
      const stats = Object.fromEntries(stages.map(s => [s, records.filter(r => r.status === s).length]));
      statsEl.innerHTML = stages.map(s => '<div class="stat"><span>'+s+'</span><strong>'+stats[s]+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = records.filter(r => (!status || r.status === status) && (!q || JSON.stringify(r).includes(q)));
      cardsEl.innerHTML = visible.map(cardHtml).join('') || '<div class="meta">没有匹配的压模单</div>';
    }
    async function load() { records = await api('/api/press/records'); render(); }

    document.querySelector('#regForm').onsubmit = async e => {
      e.preventDefault();
      const form = e.target;
      try {
        await api('/api/press/records', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); renderRegFields(); await load(); toast('已登记并完成判定');
      } catch (err) { toast(err.message); }
    };
    cardsEl.addEventListener('click', e => {
      const b = e.target.closest('[data-open]');
      if (b) { const box = document.getElementById(b.dataset.open); box.hidden = !box.hidden; }
    });
    cardsEl.addEventListener('submit', async e => {
      const form = e.target.closest('form[data-action]');
      if (!form) return;
      e.preventDefault();
      const payload = Object.fromEntries(new FormData(form).entries());
      if (form.elements.edgeIntact) payload.edgeIntact = form.elements.edgeIntact.checked;
      try {
        const data = await api('/api/press/records/'+form.dataset.id+'/'+form.dataset.action, { method:'POST', body: JSON.stringify(payload) });
        await load();
        toast(data.status === '已放行' ? '复验通过，已放行进入试磨' : '已提交，当前状态：' + data.status);
      } catch (err) { toast(err.message); }
    });
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    renderRegFields(); load();
  </script>
</body>
</html>`;
}
