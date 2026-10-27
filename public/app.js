/* ============================================================================
 * ClipFlow AI 创作平台前端
 *   ① 选择/拖入多个视频（≤ 上限），逐个 MD5 → 秒传预检 → 上传
 *   ② 上传齐了自动建批次（服务端按内容去重，内容相同的行共享同一个任务）
 *   ③ 轮询 GET /api/batches/:id（一次拿整批），渲染列表与汇总
 *   ④ 行内：预览（展开源/目标对比，同时只开一条）+ 三态共享按钮（开始/停止/下载）
 *   ⑤ 批次级：勾选任务后用「批量开始 / 批量取消」（两个独立按钮，不随单任务状态改名）
 * ========================================================================== */

const $ = (sel) => document.querySelector(sel);

const el = {
  authGate: $('#authGate'), authForm: $('#authForm'), phoneInput: $('#phoneInput'), passwordInput: $('#passwordInput'), registerBtn: $('#registerBtn'), switchMode: $('#switchMode'), confirmField: $('#confirmField'), confirmInput: $('#confirmInput'), captchaField: $('#captchaField'), captchaQuestion: $('#captchaQuestion'), captchaInput: $('#captchaInput'),
  loginBtn: $('#loginBtn'), authError: $('#authError'), authSessionEnd: $('#authSessionEnd'),
  appShell: $('#appShell'), sessionLeft: $('#sessionLeft'), logoutBtn: $('#logoutBtn'), settingsBtn: $('#settingsBtn'), settingsMenu: $('#settingsMenu'), creditsBadge: $('#creditsBadge'), buildTag: $('#buildTag'),
  adminBtn: $('#adminBtn'), adminMask: $('#adminMask'), adminClose: $('#adminClose'),
  adminCount: $('#adminCount'), adminCredits: $('#adminCredits'), adminGen: $('#adminGen'),
  adminCodes: $('#adminCodes'), adminCopy: $('#adminCopy'), adminCopyRow: $('#adminCopyRow'), adminHint: $('#adminHint'),
  uploadCard: $('#uploadCard'), dropzone: $('#dropzone'), fileInput: $('#fileInput'),
  dropHint: $('#dropHint'), quota: $('#quota'),
  erasePreset: $('#erasePreset'), eraseHint: $('#eraseHint'), modeRow: $('#modeRow'), resRow: $('#resRow'), resSelect: $('#resSelect'), verSelect: $('#verSelect'), batchZip: $('#batchZip'),
  tcRow: $('#tcRow'), tcProfile: $('#tcProfile'),
  tabbar: $('#tabbar'), navMain: $('#navMain'), assetFilters: $('#assetFilters'), assetGrid: $('#assetGrid'),
  assetEmpty: $('#assetEmpty'), assetTotal: $('#assetTotal'), assetSearch: $('#assetSearch'), assetBulk: $('#assetBulk'),
  assetSelAll: $('#assetSelAll'), assetSelNote: $('#assetSelNote'), assetBulkDelete: $('#assetBulkDelete'),
  studioSend: $('#studioSend'), studioNotice: $('#studioNotice'), plansRedeem: $('#plansRedeem'),
  taskFilters: $('#taskFilters'), taskList: $('#taskList'), taskEmpty: $('#taskEmpty'), taskTotal: $('#taskTotal'), uploadCard: $('#uploadCard'), linkCard: $('#linkCard'), linkInputs: $('#linkInputs'), linkAdd: $('#linkAdd'),
  linkNotice: $('#linkNotice'), pageTitle: $('#pageTitle'), pageDesc: $('#pageDesc'),
  batchCard: $('#batchCard'), batchSub: $('#batchSub'), batchPill: $('#batchPill'), notice: $('#notice'),
  diskWarn: $('#diskWarn'),
  bigDone: $('#bigDone'), cDone: $('#cDone'), cRun: $('#cRun'), cUp: $('#cUp'),
  cQueued: $('#cQueued'), cIdle: $('#cIdle'), cBad: $('#cBad'), eta: $('#eta'), bar: $('#bar'),
  list: $('#list'), diskInfo: $('#diskInfo'),
  batchStart: $('#batchStart'), batchCancel: $('#batchCancel'), batchDelete: $('#batchDelete'),
  checkAll: $('#checkAll'), selNote: $('#selNote'),
  toast: $('#toast'),
};

const state = {
  config: null,
  session: { authenticated: false },
  items: [],          // 本地上传队列（批次建立前）
  batchId: null,
  batch: null,
  rows: [],           // 服务端返回的行（批次建立后）
  openKey: null,      // 当前展开预览的行 key
  downloading: new Set(),   // 正在下载的任务（防止重复点下载）
  selected: new Set(),// 勾选的任务（批量开始/批量取消只针对它们）
  pollTimer: null,
  tickTimer: null,
  tab: 'link',                       // link | erase | enhance | transcode
  tabBatch: { link: null, erase: null, enhance: null, transcode: null },
  linkTasks: [],                      // 链接去水印创建的任务
};

const STORE_KEY = 'clipflow.batchId';

/* ---------------------------------------------------------------- 小工具 */
const fmtBytes = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
};
const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
};
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('is-on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('is-on'), 2200);
}
function setNotice(msg) {
  el.notice.hidden = !msg;
  el.notice.textContent = msg || '';
}

/** 磁盘是否低于保护线（低于则暂停接收新任务：上传/建批次/开始任务都会被服务端拒绝） */
function diskState() {
  const free = state.batch?.disk?.free ?? state.config?.disk?.free ?? null;
  const minFree = state.config?.disk?.minFree ?? 5 * 1024 ** 3;
  return { free, minFree, low: free !== null && free < minFree };
}
const operationNeedsCloud = (operation) => operation !== 'region-blur';
const operationReady = (operation) => !operationNeedsCloud(operation) || state.config?.eraseReady !== false;
function renderDiskWarn() {
  const d = diskState();
  if (!el.diskWarn) return;
  el.diskWarn.hidden = !d.low;
  if (d.low) {
    el.diskWarn.textContent = `服务器磁盘空间不足（剩余 ${fmtBytes(d.free)}，低于 ${fmtBytes(d.minFree)} 保护线），已暂停接收新任务，请联系管理员清理`;
  }
}
/**
 * 按钮防连点：
 *   · markBusy  —— 一进入处理就禁用并改文案，第二次点击根本进不来
 *   · clearBusy —— 结束后恢复（随后的 render 会用最新状态重建按钮）
 * 再加一层全局捕获拦截：任何处于 busy 的按钮/链接，点击一律吞掉。
 */
function markBusy(btn, text) {
  if (!btn) return false;
  if (btn.dataset.busy === '1') return false;
  btn.dataset.busy = '1';
  btn.dataset.prevText = btn.textContent;
  btn.disabled = true;
  if (text) btn.textContent = text;
  return true;
}
function clearBusy(btn) {
  if (!btn) return;
  delete btn.dataset.busy;
  btn.disabled = false;
  if (btn.dataset.prevText) { btn.textContent = btn.dataset.prevText; delete btn.dataset.prevText; }
}
document.addEventListener('click', (e) => {
  const hit = e.target.closest?.('[data-busy="1"]');
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------------------------------------------- 鉴权 */
let sessionEndsAt = null;
let loginPending = false;

async function api(path, opts = {}) {
  // 每个请求都带超时：服务器/网络不响应时界面也能自己恢复，不会一直挂着
  const { timeoutMs = 20000, ...rest } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...rest,
      signal: ctrl.signal,
      headers: { ...(rest.body ? { 'content-type': 'application/json' } : {}), ...(rest.headers || {}) },
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw Object.assign(new Error('请求超时（服务器无响应）'), { code: 'TIMEOUT' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    showLogin('会话已过期，请重新登录');
    throw Object.assign(new Error('未登录或会话已过期'), { code: 'UNAUTHORIZED' });
  }
  return res;
}
async function jsonApi(path, opts) {
  const res = await api(path, opts);
  const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin('登录已过期，请重新登录'); }
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function showLogin(message) {
  stopPolling();
  el.appShell.hidden = true;
  // 兜底：登录按钮若残留 busy 状态会点不动，这里强制复位
  if (el.loginBtn) {
    el.loginBtn.disabled = false;
    delete el.loginBtn.dataset.busy;
    el.loginBtn.textContent = "登录";
  }
  el.authGate.hidden = false;
  if (message) {
    el.authError.textContent = message;
    el.authError.hidden = false;
  }
}
function showApp() {
  el.authGate.hidden = true;
  el.appShell.hidden = false;
  el.authError.hidden = true;
}
function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function startTicker() {
  clearInterval(state.tickTimer);
  state.tickTimer = setInterval(() => {
    if (!sessionEndsAt) return;
    const left = sessionEndsAt - Date.now();
    if (el.sessionLeft) el.sessionLeft.textContent = fmtCountdown(left);
    if (left <= 0) showLogin('会话已过期，请重新登录');
  }, 1000);
}

async function login(phone, password) {
  loginPending = true;
  el.loginBtn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password }),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    sessionEndsAt = Date.parse(data.expiresAt);
    if (el.sessionLeft) el.sessionLeft.textContent = fmtCountdown(sessionEndsAt - Date.now());
    return true;
  } finally {
    el.loginBtn.disabled = false;
    loginPending = false;
  }
}

async function bootstrap() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const data = await res.json();
    if (loginPending || state.session.authenticated) return;
    if (data.authenticated) {
      state.session = data;
      sessionEndsAt = Date.parse(data.expiresAt);
      showApp();
      await init();
      refreshHeader();
    } else {
      if (data.endAt) {
        el.authSessionEnd.textContent = new Date(data.endAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      }
      showLogin();
    }
  } catch {
    showLogin();
  }
}

/* ---------------------------------------------------------------- 初始化 */
async function init() {
  state.config = await jsonApi('/api/config');
  el.buildTag.textContent = state.config.build || '';
  const exts = (state.config.allowedExtensions || []).map((e) => e.slice(1).toUpperCase()).join(' / ');
  el.dropHint.textContent = `支持 ${exts}，单个最大 ${fmtBytes(state.config.maxUploadBytes)}，一批最多 ${state.config.maxBatchSize || 10} 个`;
  if (state.config.probeReady === false) {
    setNotice('服务器缺少 ffprobe，无法核实视频时长，任务无法开始。请联系管理员安装（详见部署文档）。');
  }
  if (state.config.eraseReady === false) {
    setNotice(`云端处理服务尚未就绪（缺少${(state.config.eraseMissing || []).join('、')}）；「区域遮挡 / 消物」仍可使用，其它云端工具请联系管理员开通。`);
  }
  startTicker();
  render();
  switchPage('home');
  await restore();
  await restoreHomeGeneration().catch(() => {});
}

/* ============================================================================
 * 上传阶段：时长 → MD5 → 秒传预检 → 上传
 * ========================================================================== */
function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let settled = false;
    const done = (val) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(val); };
    v.addEventListener('loadedmetadata', () => {
      const d = Number(v.duration);
      done(Number.isFinite(d) && d > 0 ? Math.round(d) : null);
    }, { once: true });
    v.addEventListener('error', () => done(null), { once: true });
    setTimeout(() => done(null), 15000);
    v.src = url;
  });
}

let workerSeq = 0;
const pendingHash = new Map();
const HASH_PARALLEL = 3;          // 多个文件同时算 MD5（最多 3 个 worker）
let hashWorkers = null;
let hashTurn = 0;
function hashFile(file, onProgress) {
  if (hashWorkers === null) {
    hashWorkers = [];
    for (let i = 0; i < HASH_PARALLEL; i += 1) {
      try {
        const w = new Worker('/md5-worker.js', { type: 'module' });
        w.onmessage = (e) => {
          const { id, type, loaded, total, md5, message } = e.data || {};
          const job = pendingHash.get(id);
          if (!job) return;
          if (type === 'progress') job.onProgress(loaded, total);
          else if (type === 'done') { pendingHash.delete(id); job.resolve(md5); }
          else { pendingHash.delete(id); job.reject(new Error(message || 'MD5 计算失败')); }
        };
        hashWorkers.push(w);
      } catch { /* 不支持 Worker 就退化为主线程 */ }
    }
  }
  if (hashWorkers.length) {
    const id = ++workerSeq;
    const w = hashWorkers[hashTurn++ % hashWorkers.length];
    return new Promise((resolve, reject) => {
      pendingHash.set(id, { resolve, reject, onProgress });
      w.postMessage({ id, blob: file });
    });
  }
  return md5BlobLazy(file, onProgress);   // 无 Worker 环境的兜底
}
async function md5BlobLazy(file, onProgress) {
  const { md5Blob } = await import('/md5.js');
  return md5Blob(file, { onProgress });
}

async function acceptFiles(fileList) {
  // 上传前积分预检（本地读时长，不发请求）：1 秒 = 1 积分
  {
    const probeFiles = [...(fileList || [])].filter(Boolean);
    const me = state.session?.user;
      // 拿不到用户信息（会话未加载完）时不限制；真实额度由服务端建批次时校验
      const privileged = !me || me.role === 'admin' || me.whitelisted;
    if (probeFiles.length && !privileged) {
      const probe = (file) => new Promise((resolve) => {
        try {
          const url = URL.createObjectURL(file);
          const v = document.createElement('video');
          v.preload = 'metadata';
          v.onloadedmetadata = () => { const d = Number(v.duration) || 0; URL.revokeObjectURL(url); resolve(d); };
          v.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
          v.src = url;
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} resolve(0); }, 4000);
        } catch { resolve(0); }
      });
      const durations = await Promise.all(probeFiles.map(probe));
      const need = durations.reduce((sum, d) => sum + Math.max(1, Math.ceil(d || 0)), 0);
      const credits = me?.credits ?? 0;
        if (need > 0 && credits < need) {
        el.diskWarn.hidden = false;
        el.diskWarn.textContent = `积分预估不足：这些文件最多约需 ${need} 积分，当前 ${credits} 积分。重复内容和已完成结果可能复用，最终以开始任务时服务端核算为准。`;
        toast(`积分预估不足：最终费用将在开始任务时核算`);
      }
    }
  }

  const files = [...(fileList || [])];
  if (!files.length) return;
  const max = state.config?.maxBatchSize || 30;
  const allowed = new Set(state.config?.allowedExtensions || []);
  const maxBytes = state.config?.maxUploadBytes || 100 * 1024 ** 2;
  const used = viewRows().length;      // 含已并入批次的行 + 还在上传的行
  const free = max - used;
  if (free <= 0) return toast(`一批最多 ${max} 个文件`);
  const accepted = [];
  for (const f of files) {
    if (accepted.length >= free) break;
    const ext = `.${String(f.name).split('.').pop().toLowerCase()}`;
    if (!allowed.has(ext)) { toast(`不支持的文件类型：${f.name}`); continue; }
    if (f.size > maxBytes) { toast(`${f.name} 超过单文件上限 ${fmtBytes(maxBytes)}`); continue; }
    accepted.push(f);
  }
  if (files.length > free) toast(`一批最多 ${max} 个，已忽略 ${files.length - free} 个`);
  if (!accepted.length) return;
  accepted.forEach((f, i) => {
    state.items.push({
      key: `it_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      file: f, name: f.name, size: f.size, durationSec: null,
      phase: 'queued', uploadPct: 0, hashPct: 0, stageText: '等待上传', fileId: null, error: null,
    });
  });
  if (operationReady(tabPayload().operation)) setNotice('');
  render();
  processQueue();
}

let uploadRunning = 0;
async function processQueue() {
  // 多个文件同时上传（并发度由服务端下发，默认 4）；上传完只是"待开始"，不会自动调接口
  const MAX_PARALLEL = Math.max(1, Number(state.config?.uploadConcurrency) || 4);
  while (uploadRunning < MAX_PARALLEL) {
    const next = state.items.find((it) => it.phase === 'queued');
    if (!next) break;
    next.phase = 'hashing';
    next.stageText = '计算 MD5（本地）';
    render();
    uploadRunning += 1;
    runUpload(next)
      .catch((err) => {
        if (next.canceled || err.name === 'AbortError') return;
        next.phase = 'failed';
        next.error = err.message || String(err);
        next.stageText = '上传失败';
      })
      .finally(() => {
        uploadRunning -= 1;
        render();
        processQueue();
        ensureBatch();
      });
  }
}

async function runUpload(item) {
  item.durationSec = await probeDuration(item.file);
  if (item.canceled) return;
  const md5 = await hashFile(item.file, (loaded, total) => {
    item.hashPct = total ? Math.round((loaded / total) * 100) : 0;
    item.stageText = `计算 MD5（本地） ${item.hashPct}%`;
    render();
  });
  if (item.canceled) return;
  item.md5 = md5;

  const pre = await jsonApi('/api/uploads/precheck', {
    method: 'POST',
    body: JSON.stringify({ md5, name: item.name }),
  });
  if (item.canceled) return;
  if (pre.exists && pre.file) {
    item.fileId = pre.file.id;
    if (item.canceled) return;
    item.phase = 'uploaded';
    item.deduped = true;
    item.stageText = `秒传命中，省下 ${fmtBytes(pre.savedBytes ?? item.size)}`;
    render();
    return;
  }

  item.phase = 'uploading';
  item.stageText = '上传中';
  render();
  const res = await uploadFile(item, md5);
  if (item.canceled) return;
  item.fileId = res.file.id;
  item.phase = 'uploaded';
  item.stageText = res.deduped ? '上传完成（服务端已有相同文件）' : '上传完成';
  render();
}

function uploadFile(item, md5) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;                       // 移除该行时可中断上传
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.name));
    xhr.setRequestHeader('X-File-MD5', md5);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      item.uploadPct = Math.round((e.loaded / e.total) * 100);
      item.stageText = `上传中 ${item.uploadPct}%`;
      render();
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* 忽略 */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.file) resolve(data);
      else reject(new Error(data.error || `上传失败 HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传失败'));
    xhr.onabort = () => reject(Object.assign(new Error('上传已取消'), { name: 'AbortError' }));
    xhr.ontimeout = () => reject(new Error('上传超时，请重试'));
    xhr.timeout = 10 * 60 * 1000;
    if (item.canceled) return xhr.onabort();
    xhr.send(item.file);
  });
}

/** 上传都落定后建批次；服务端按内容去重，内容相同的行共享同一任务 */
async function ensureBatch() {
  if (state.syncing) return;
  if (state.items.some((it) => ['queued', 'hashing', 'uploading'].includes(it.phase))) return;
  const ready = state.items.filter((it) => it.fileId && !it.added && !it.canceled);
  if (!ready.length) return;
  const durations = {};
  ready.forEach((it) => { if (it.durationSec) durations[it.fileId] = it.durationSec; });
  const fileIds = ready.map((it) => it.fileId);   // 保留每一行（相同内容服务端标记为复用）
  state.syncing = true;
  try {
    const data = state.batchId
      // 已有批次 → 追加（分批添加）
      ? await jsonApi(`/api/batches/${state.batchId}/items`, { method: 'POST', timeoutMs: 600000, body: JSON.stringify({ fileIds, durations, ...tabPayload() }) })
      : await jsonApi('/api/batches', { method: 'POST', timeoutMs: 600000, body: JSON.stringify({ fileIds, durations, ...tabPayload() }) });
    if (!state.batchId) {
      state.batchId = data.batch.id;
      try { localStorage.setItem(STORE_KEY, state.batchId); } catch { /* 忽略 */ }
    }
    ready.forEach((it) => { it.added = true; });   // 已并入批次 → 之后由服务端行渲染
    applyBatch(data);
    render();
    startPolling();
  } catch (err) {
    setNotice(`无法加入任务批次：${err.message}`);
  } finally {
    state.syncing = false;
  }
}

/* ============================================================================
 * 批次轮询（一次请求拿整批）
 * ========================================================================== */
function applyBatch(data) {
  state.batch = data.batch;
  state.rows = data.items || [];
  // 用最新的可用磁盘刷新本地快照，磁盘提示才能实时更新
  if (data.batch?.disk?.free != null && state.config?.disk) state.config.disk.free = data.batch.disk.free;
  el.batchCard.hidden = false;
}
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(poll, 1500);
  poll();
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}
async function poll() {
  if (!state.batchId) return;
  try {
    const data = await jsonApi(`/api/batches/${state.batchId}`, { timeoutMs: 8000 });
    applyBatch(data);
    render();
    if (!(state.rows || []).some((r) => r.status === 'queued' || r.status === 'running')) stopPolling();
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') return;
    if (err.status === 404) {
      stopPolling();
      clearSaved();
      state.batchId = null;
      state.batch = null;
      state.rows = [];
      setNotice('这批任务记录已过期并被清理，请重新选择文件。');
      render();
    }
    // 其它错误（网络抖动）保持轮询
  }
}

/* ============================================================================
 * 渲染
 * ========================================================================== */
let localSeq = 0;
function localRow(it, i) {
  if (!it.key) it.key = `local_${++localSeq}`;
  return {
    key: it.key,
    index: i + 1,
    fileName: it.name,
    sizeText: fmtBytes(it.size),
    durationSec: it.durationSec,
    phase: it.phase,
    status: it.phase === 'hashing' ? 'hashing'
      : ['queued', 'uploading'].includes(it.phase) ? 'uploading'
      : it.phase === 'uploaded' ? 'idle' : 'upload-failed',
    progress: it.phase === 'uploading' ? it.uploadPct : it.phase === 'hashing' ? it.hashPct : 0,
    stage: it.stageText || '',
    error: it.error || null,
    fileId: it.fileId,
    taskId: null,
    shared: false,
    result: null,
    operation: tabPayload().operation,
    operationLabel: state.config?.operations?.find((op) => op.id === tabPayload().operation)?.label || '视频处理',
    downloadUrl: null,
    previewUrl: null,
    sourceExpiresAt: null,
    local: true,
  };
}

/**
 * 列表行 = 服务端批次里的行 + 还没并入批次的本地上传行。
 * 「分批添加」时新选的文件在**上传阶段就立刻可见**（上传完自动并入批次）。
 */
function viewRows() {
  const serverRows = state.rows.map((r, i) => ({ ...r, key: `${r.fileId}:${i}`, index: i + 1 }));
  const pending = state.items.filter((it) => !it.added);
  if (!serverRows.length) return pending.map((it, i) => localRow(it, i));
  return [...serverRows, ...pending.map((it, i) => localRow(it, serverRows.length + i))];
}

const STATUS_LABEL = {
  idle: { text: '待开始', cls: '' },
  hashing: { text: '校验内容（MD5）', cls: 'pill-wait' },
  uploading: { text: '上传中', cls: 'pill-wait' },
  'upload-failed': { text: '上传失败', cls: 'pill-bad' },
  queued: { text: '排队中', cls: 'pill-wait' },
  running: { text: '处理中', cls: 'pill-run' },
  done: { text: '已完成', cls: 'pill-ok' },
  succeeded: { text: '已完成', cls: 'pill-ok' },
  failed: { text: '失败', cls: 'pill-bad' },
  canceled: { text: '已取消', cls: 'pill-skip' },
  expired: { text: '已过期', cls: 'pill-skip' },
};

/** 丢掉已经不存在的勾选（比如某行被移除、或本地上传行并入了批次） */
function pruneSelection(rows) {
  const keys = new Set(rows.map((r) => r.key));
  for (const k of [...state.selected]) if (!keys.has(k)) state.selected.delete(k);
}

let renderQueued = false;
/** 合并高频 render：同一帧内多次调用只真正渲染一次（30 行 + 频繁进度时很关键） */
function render() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => { renderQueued = false; renderNow(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/**
 * 结构签名：行集合 / 每行状态 / 展开的行。
 * 只有"结构变了"才整块重建；否则只原地改百分比与文字 —— 因为重建会让
 * 转圈动画每秒从 0 重播（看着像闪烁）、也会让预览里的 video 重新加载。
 */
function structureSig(rows) {
  return rows.map((r) => `${r.key}|${r.status}|${r.shared ? 1 : 0}${r.reused ? 1 : 0}${r.attached ? 1 : 0}`).join('~')
    + '##' + (state.openKey || '');
}
let lastSig = '';

/** 原地更新（结构未变时）：只改文字/百分比/进度条宽度 */
function patchRows(rows) {
  const nodes = [...el.list.querySelectorAll('.row')];
  rows.forEach((r, i) => {
    const node = nodes[i];
    if (!node || node.dataset.key !== r.key) return;
    const label = STATUS_LABEL[r.status] || { text: r.status, cls: '' };
    const showPct = r.status === 'running' || r.status === 'uploading' || r.status === 'hashing';
    const pill = node.querySelector('.pill');
    if (pill) pill.textContent = `${label.text}${showPct ? ` ${r.progress}%` : ''}`;
    const bar = node.querySelector('.row-sub .bar > span');
    if (bar) bar.style.width = `${r.progress}%`;
    const stage = node.querySelector('.row-sub .stage');
    if (stage && r.stage) stage.textContent = r.stage;
    // 勾选状态也原地同步（点「全选」时每行的勾选框要跟着变）
    const checked = state.selected.has(r.key);
    const box = node.querySelector('.check input');
    if (box && box.checked !== checked) box.checked = checked;
    node.classList.toggle('is-checked', checked);
  });

  // 展开的预览面板：只更新目标侧的百分比/进度条/阶段与已用时间，不重建节点
  const r = rows.find((x) => x.key === state.openKey);
  const panel = el.list.querySelector('.panel');
  if (r && panel) {
    const t = panel.querySelector('.preview-item:last-child .t');
    if (t && (r.status === 'running' || r.status === 'queued')) {
      t.textContent = r.status === 'queued' ? '已提交，等待调度' : `${r.operationLabel || '正在处理'} ${r.progress}%`;
    }
    const tbar = panel.querySelector('.preview-item:last-child .tbar > span');
    if (tbar && r.status === 'running') tbar.style.width = `${r.progress}%`;
    const hs = panel.querySelectorAll('.preview-item:last-child .h');
    if (hs[0] && r.stage) hs[0].textContent = r.stage;
    if (hs[1]) {
      const lines = [];
      if (r.elapsedSeconds) lines.push(`已用 ${fmtClock(r.elapsedSeconds)}`);
      if (r.etaSeconds) lines.push(`预计还需约 ${fmtClock(r.etaSeconds)}`);
      hs[1].textContent = lines.join(' · ');
    }
  }
}

function renderNow() {
  const rows = viewRows();
  const sig = structureSig(rows);
  if (sig === lastSig) {
    pruneSelection(rows);
    patchRows(rows);
    renderSummary(rows);
    renderDiskWarn();
    renderBatchButtons(rows);
    el.quota.textContent = `${rows.length} / ${state.config?.maxBatchSize || 30}`;
    return;
  }
  lastSig = sig;
  el.list.innerHTML = '';
  rows.forEach((r) => {
    el.list.appendChild(rowNode(r));
    if (state.openKey === r.key) el.list.appendChild(panelNode(r));
  });
  pruneSelection(rows);
  /* 超清已独立为标签页，不再有「处理模式 + 超清」组合 */
  renderSummary(rows);
  renderDiskWarn();
  renderBatchButtons(rows);
  el.quota.textContent = `${rows.length} / ${state.config?.maxBatchSize || 30}`;
  // 关键：只要有行就显示这张卡片。
  // 上传阶段（还没建批次）也要让用户立刻看到每一行的「计算 MD5 / 上传中 x%」，
  // 否则选完文件后界面会有几十秒到几分钟毫无反应。
  el.batchCard.hidden = rows.length === 0;
  try { syncToolsAside(); } catch { /* 忽略 */ }
}

function rowNode(r) {
  const label = STATUS_LABEL[r.status] || { text: r.status, cls: '' };
  // 处理中的进度不放在行内（去目标视频面板里显示），行内进度条只用于上传/校验
  const showRowBar = r.status === 'uploading' || r.status === 'hashing';
  const showPct = showRowBar || r.status === 'running';
  const done = r.status === 'done' || r.status === 'succeeded';
  const checked = state.selected.has(r.key);
  const node = document.createElement('div');
  node.className = 'row' + (state.openKey === r.key ? ' is-open' : '') + (checked ? ' is-checked' : '');
  node.dataset.key = r.key;
  node.innerHTML = `
    <label class="check"><input type="checkbox"${checked ? ' checked' : ''} /></label>
    <div class="idx">${String(r.index).padStart(2, '0')}</div>
    <div class="thumb ${done ? 'done' : r.shared ? 'skip' : ''}">${r.shared ? '秒传' : r.durationSec ? `${r.durationSec} 秒` : '—'}</div>
    <div class="row-main">
      <div class="row-title">
        <span class="name">${escapeHtml(r.fileName)}</span>
        <span class="meta">${r.sizeText}${r.durationSec ? ` · ${r.durationSec} 秒` : ''}</span>
      </div>
      <div class="row-sub">
        <span class="pill ${label.cls}">${label.text}${showPct ? ` ${r.progress}%` : ''}</span>
        ${showRowBar ? `<div class="bar"><span style="width:${r.progress}%"></span></div>` : ''}
        ${r.stage ? `<span class="stage">${escapeHtml(r.stage)}</span>` : ''}
        ${r.error ? `<span class="stage">${escapeHtml(r.error)}</span>` : ''}
        ${r.reused ? '<span class="stage">复用服务器上已去字幕的产物（未重复提交接口）</span>' : ''}
        ${r.attached ? '<span class="stage">与正在处理中的同名内容合并（未重复提交）</span>' : ''}
        ${r.shared && !r.reused && !r.attached ? '<span class="stage">与同一批里的相同内容共用结果（秒传）</span>' : ''}
      </div>
    </div>
    <div class="row-actions"></div>`;

  const actions = node.querySelector('.row-actions');
  const mk = (text, cls, enabled, fn) => {
    const b = document.createElement('button');
    b.className = `btn ${cls} btn-sm`;
    b.textContent = text;
    b.disabled = !enabled;
    b.onclick = fn;
    actions.appendChild(b);
  };
  const box = node.querySelector('.check input');
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(r.key); else state.selected.delete(r.key);
    render();
  });
  node.addEventListener('click', (e) => {          // 点行空白处也能勾选
    if (e.target.closest('.btn') || e.target.closest('.check') || e.target.closest('video') || e.target.closest('a')) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
  });
  mk(state.openKey === r.key ? '预览 ▾' : '预览 ▸', 'btn-ghost btn-preview', true, () => togglePreview(r.key));
  const act = rowAction(r);
  mk(act.text, act.cls, act.enabled, act.fn);
  // 上传阶段的本地行：允许取消
  if (r.local && ['hashing', 'uploading', 'queued'].includes(r.phase)) {
    mk('取消上传', 'btn-ghost btn-stop', true, () => cancelUploadByKey(r.key));
  }

  // 移除任务：处理中不能移除；未开始 / 已完成 / 失败 都可以
  const canRemove = !['queued', 'running'].includes(r.status);
  mk('移除任务', 'btn-ghost btn-stop', canRemove, () => removeRow(r));
  return node;
}

/** 行内共享按钮三态：开始任务 / 停止任务 / 下载视频 */
function rowAction(r) {
  if (r.status === 'uploading' || r.status === 'upload-failed' || r.status === 'expired') {
    return { text: '开始任务', cls: 'btn-ghost', enabled: false, fn: () => {} };
  }
  if (r.status === 'queued' || r.status === 'running') {
    return { text: '停止任务', cls: 'btn-ghost btn-stop', enabled: true, fn: () => stopTask(r) };
  }
  if (r.status === 'done' || r.status === 'succeeded') {
    const busy = state.downloading.has(r.taskId);
    const label = r.result?.srt ? '下载字幕' : '下载视频';
    return { text: busy ? '下载中…' : label, cls: 'btn-ghost', enabled: !busy, fn: () => downloadRow(r) };
  }
  const ready = operationReady(r.operation || state.batch?.operation || tabPayload().operation) && !diskState().low;
  return { text: '开始任务', cls: 'btn-ghost', enabled: ready && Boolean(r.taskId), fn: () => startTask(r) };
}

/** 展开的对比预览：源视频（未上传完显示"正在上传……"）+ 目标视频（随状态变化） */
function panelNode(r) {
  const wrap = document.createElement('div');
  wrap.className = 'panel';
  const done = r.status === 'done' || r.status === 'succeeded';
  const uploading = r.status === 'uploading' || r.status === 'upload-failed';
  // 统一走服务器副本（不再用云端直连地址）
  const targetSrc = r.previewUrl || '';

  const srcBody = uploading
    ? `<div class="state"><div class="glyph ${r.status === 'upload-failed' ? 'bad' : 'spin'}"></div>
         <div class="t">${r.status === 'upload-failed' ? '上传失败' : '正在上传……'}</div>
         <div class="h">${escapeHtml(r.fileName)} · ${r.sizeText}${r.status === 'uploading' ? ` · 已上传 ${r.progress}%` : ''}</div></div>`
    : r.fileId
      ? (UNPLAYABLE_EXT.has(extOf(r.fileName))
          ? previewFallback('src', r)
          : `<video class="panel-video" controls preload="metadata" playsinline src="/f/${r.fileId}"></video>`)
      : r.sourceUrl
        ? `<video class="panel-video" controls preload="metadata" playsinline src="${escapeHtml(r.sourceUrl)}"></video>`
        : '<div class="state"><div class="t">等待上传</div></div>';

  const tgtBody = done
    ? (r.result?.srt
        ? `<div class="state"><div class="t">字幕文件已生成</div><div class="h">SRT 文本不能作为视频预览，可直接下载后导入剪辑软件。</div><a class="btn btn-ghost btn-sm" href="${r.downloadUrl}">下载 SRT</a></div>`
        : `<video class="panel-video" controls preload="metadata" playsinline src="${targetSrc}"></video>`)
    : r.status === 'failed'
      ? `<div class="state"><div class="glyph bad"></div><div class="t">处理失败</div><div class="h">${escapeHtml(r.error || '接口返回失败')}</div></div>`
      : (r.status === 'queued' || r.status === 'running')
        ? (() => {
             // 处理中的进度统一显示在**目标视频**这一侧：百分比 + 进度条 + 阶段 + 已用/剩余
             const lines = [];
             if (r.elapsedSeconds) lines.push(`已用 ${fmtClock(r.elapsedSeconds)}`);
             if (r.etaSeconds) lines.push(`预计还需约 ${fmtClock(r.etaSeconds)}`);
             return `<div class="state">
               <div class="glyph spin"></div>
               <div class="t">${r.status === 'queued' ? '已提交，等待调度' : `${escapeHtml(r.operationLabel || '正在处理')} ${r.progress}%`}</div>
               <div class="tbar"><span style="width:${r.status === 'queued' ? 0 : r.progress}%"></span></div>
               <div class="h">${escapeHtml(r.stage || '云端正在逐帧擦除字幕')}</div>
               ${lines.length ? `<div class="h">${lines.join(' · ')}</div>` : ''}
             </div>`;
           })()
        : uploading
          ? '<div class="state"><div class="t">等待上传完成</div><div class="h">源视频上传完成后即可开始去字幕</div></div>'
          : r.status === 'canceled'
            ? `<div class="state"><div class="t">已取消</div>
                 <div class="h">${r.remoteCancel?.ok
                   ? '云端已接受终止请求'
                   : '去字幕接口未提供取消能力，已停止本地跟踪（不再轮询、不再下载产物）'}</div>
                 <div class="h">点这一行的「开始任务」可重新处理</div></div>`
            : '<div class="state"><div class="t">等待处理</div><div class="h">点这一行的「开始任务」，或勾选后用「批量开始」</div></div>';

  const srcExpiry = r.sourceExpiresAt
    ? new Date(r.sourceExpiresAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
  wrap.innerHTML = `
    <div class="panel-head">
      <span class="panel-title">对比预览 · <b>${escapeHtml(r.fileName)}</b></span>
      <button class="btn btn-ghost btn-sm" type="button">收起预览</button>
    </div>
    <div class="preview-pair">
      <div class="preview-item">
        <div class="panel-cap">源视频</div>
        <figure class="preview">${srcBody}</figure>
        <div class="expiry-row"><span class="expiry-chip">源文件有效期至 ${srcExpiry}</span></div>
      </div>
      <div class="preview-item">
        <div class="panel-cap">目标视频</div>
        <figure class="preview">${tgtBody}</figure>
        <div class="expiry-row">${done ? `<span class="expiry-chip">产物与源文件一同在 ${state.config?.uploadTtlHours ?? 12} 小时后清理</span>` : ''}</div>
      </div>
    </div>`;
  wrap.querySelector('.panel-head .btn').onclick = () => togglePreview(r.key);
  // 播放失败（编码不支持、链接过期、文件被清）→ 换成说明 + 下载入口，不留死播放器
  wrap.querySelectorAll('video').forEach((v) => {
    const swap = () => {
      const fig = v.closest('.preview');
      const isSrc = Boolean(v.closest('.preview-item:first-child'));
      if (fig) fig.innerHTML = previewFallback(isSrc ? 'src' : 'tgt', r);
    };
    v.addEventListener('error', swap, { once: true });
    if (v.error) swap();
  });
  return wrap;
}

function renderSummary(rows) {
  const n = (s) => rows.filter((r) => r.status === s).length;
  const done = n('done') + n('succeeded');
  const running = n('running');
  const uploading = n('uploading');
  const queued = n('queued');
  const failed = n('failed') + n('upload-failed');
  const idle = n('idle') + n('canceled');
  const total = rows.length;
  const sc = state.batch?.counts;

  el.bigDone.textContent = `已完成 ${sc ? sc.done : done} / ${total}`;
  el.cDone.textContent = sc ? sc.done : done;
  el.cRun.textContent = sc ? sc.running : running;
  el.cUp.textContent = uploading;
  el.cQueued.textContent = sc ? sc.queued : queued;
  el.cIdle.textContent = sc ? sc.idle + sc.canceled : idle;
  el.cBad.textContent = sc ? sc.failed : failed;

  const pct = sc?.progressPct ?? (total ? Math.round(((done + running * 0.5) / total) * 100) : 0);
  el.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;

  const active = sc ? sc.running + sc.queued : running + queued;
  const etaSec = state.batch?.etaSeconds || 0;
  el.eta.textContent = active
    ? (etaSec ? `预计剩余约 ${fmtClock(etaSec)}` : '正在估算剩余时间…')
    : failed ? `${failed} 项失败，可单独重试`
    : uploading ? `${uploading} 个文件上传中…`
    : total && (sc ? sc.done === total : done === total) ? '全部完成'
    : `${idle} 项待开始`;

  el.batchPill.textContent = (running || queued) ? `处理中 ${running + queued}`
    : uploading ? `上传中 ${uploading}`
    : total && done === total ? '全部完成'
    : failed ? '有失败项' : '待开始';
  el.batchPill.className = `pill ${(running || queued) ? 'pill-run' : uploading ? 'pill-wait' : failed ? 'pill-bad' : (total && done === total) ? 'pill-ok' : ''}`;

  const files = sc?.total ?? total;
  const estBytes = rows.reduce((a, r) => a + (Number(r.size) || 0), 0) * (state.config?.disk?.outputFactor || 1.5);
  const free = state.batch?.disk?.free ?? state.config?.disk?.free;
  el.batchSub.textContent = !state.batchId && uploading
    ? `${uploading} 个文件正在上传…（上传完成后自动建批次）`
    : `共 ${files} 个文件${estBytes ? ` · 预计产物占用 ${fmtBytes(estBytes)}` : ''}`;
  el.diskInfo.innerHTML = `预计占用 <b>${fmtBytes(estBytes)}</b> / 可用 <b>${free ? fmtBytes(free) : '—'}</b>`;
}

/** 取消某个本地文件的上传/计算 */
function cancelUploadByKey(key) {
  const it = state.items.find((x) => x.key === key);
  if (!it) return;
  it.canceled = true;
  try { it.xhr?.abort?.(); } catch { /* 忽略 */ }
  state.items = state.items.filter((x) => x.key !== key);
  render();
  toast('已取消上传');
}

/** 批量操作条：批量开始 / 批量取消（只作用于勾选的行） */
/** 勾选的行（按当前列表顺序） */
function selectedRows(rows) {
  return rows.filter((r) => state.selected.has(r.key));
}
const CAN_BATCH_START = ['idle', 'failed', 'canceled'];
const CAN_BATCH_CANCEL = ['queued', 'running'];

/**
 * 批量操作条：两个独立按钮，只作用于**勾选过的任务**。
 * 不随单个任务的状态变化而改名 —— 单个任务用行内那个按钮控制。
 */
function renderBatchButtons(rows) {
  const picked = selectedRows(rows);
  const startable = picked.filter((r) => CAN_BATCH_START.includes(r.status) && r.taskId);
  const cancellable = picked.filter((r) => CAN_BATCH_CANCEL.includes(r.status) && r.taskId);
  const ready = operationReady(state.batch?.operation || tabPayload().operation);

  const deletable = picked.filter((r) => !['queued', 'running'].includes(r.status) && (r.fileId || r.taskId));
  const blocked = picked.filter((r) => ['queued', 'running'].includes(r.status)).length;
  el.batchDelete.disabled = deletable.length === 0 || blocked > 0;
  el.batchDelete.textContent = deletable.length && !blocked ? `批量删除（${deletable.length}）` : '批量删除';
  el.batchDelete.title = blocked
    ? `勾选里有 ${blocked} 个正在处理，请先「批量取消」再删除`
    : '删除勾选的任务，并清理服务器上的源文件、产物与 MD5 索引';

  el.batchStart.disabled = !ready || startable.length === 0 || diskState().low;
  el.batchStart.title = diskState().low ? '磁盘空间不足，已暂停接收新任务' : '';
  el.batchCancel.disabled = cancellable.length === 0;
  el.batchStart.textContent = startable.length ? `批量开始（${startable.length}）` : '批量开始';
  el.batchCancel.textContent = cancellable.length ? `批量取消（${cancellable.length}）` : '批量取消';

  // 全选框与计数
  const checkable = rows.filter((r) => r.fileId || r.taskId);
  el.checkAll.checked = checkable.length > 0 && picked.length === checkable.length;
  el.checkAll.indeterminate = picked.length > 0 && picked.length < checkable.length;
  el.selNote.textContent = picked.length
    ? `已勾选 ${picked.length} 项：可开始 ${startable.length} · 可取消 ${cancellable.length}`
    : '未勾选任务（勾选后用「批量开始 / 批量取消」）';
}

/** 批量开始 / 批量取消：只提交勾选的行号（服务端也按行号处理） */
async function batchAction(kind) {
  const rows = viewRows();
  const picked = selectedRows(rows).filter((r) => r.taskId && !r.local);
  // 三种操作的行状态条件不同：开始=待开始/失败/已取消；取消=排队/处理中；删除=所有不在处理中的行
  const want = kind === 'start' ? CAN_BATCH_START : kind === 'cancel' ? CAN_BATCH_CANCEL : null;
  const indexes = picked
    .filter((r) => (want ? want.includes(r.status) : !['queued', 'running'].includes(r.status)))
    .map((r) => r.index - 1);
  if (!indexes.length) return;
  const btn = kind === 'start' ? el.batchStart : el.batchCancel;
  if (!markBusy(btn, kind === 'start' ? '正在开始…' : '正在取消…')) return;   // 防连点/防并发
  try {
    if (kind === 'start') {
      const res = await jsonApi(`/api/batches/${state.batchId}/start`, {
        method: 'POST', body: JSON.stringify({ indexes }),
      });
      toast(`已提交 ${res.started ?? indexes.length} 个任务`);
      setNotice([res.error, ...(res.errors || []).map((e) => e.error)].filter(Boolean).join('；'));
    } else if (kind === 'delete') {
      const res = await jsonApi(`/api/batches/${state.batchId}/items`, { method: 'DELETE', body: JSON.stringify({ indexes }) });
      const parts = [];
      if (res.removedFiles) parts.push(`源文件 ${res.removedFiles} 个`);
      if (res.removedTasks) parts.push(`产物 ${res.removedTasks} 个`);
      if (res.removedMd5) parts.push(`MD5 索引 ${res.removedMd5} 条`);
      toast(`已批量删除 ${res.removed} 项${parts.length ? `：${parts.join(' + ')}` : ''}`
        + `${res.freedBytes ? `（释放 ${fmtBytes(res.freedBytes)}）` : ''}`
        + `${res.kept?.length ? `；${res.kept.length} 项仍被引用，已保留` : ''}`);
      setNotice('');                     // 删除成功后清掉上次开始失败的提示
      applyBatch(res);
      if (!state.rows.length) {
        clearSaved();
        state.batchId = null;
        state.batch = null;
        state.items = [];
        el.batchCard.hidden = true;
      }
      render();
      return;
    } else {
      const res = await jsonApi(`/api/batches/${state.batchId}`, { method: 'DELETE', body: JSON.stringify({ indexes }) });
      setNotice('');
      toast(cancelToast(res.cancel, indexes.length));
    }
    startPolling();
  } catch (err) {
    toast(`${kind === 'start' ? '批量开始' : '批量取消'}失败：${err.message}`);
  } finally {
    clearBusy(btn);
    render();
  }
}

/* ============================================================================
 * 交互
 * ========================================================================== */
function togglePreview(key) {
  state.openKey = state.openKey === key ? null : key;   // 手风琴：同时只展开一条
  render();
}
async function startTask(r) {
  if (!r.taskId) return toast('该行还没有任务');
  const btn = rowActionButton(r, /开始任务|提交中/);
  if (!markBusy(btn, '提交中…')) return;          // 已经在提交 → 直接忽略
  try {
    try {
      await jsonApi(`/api/tasks/${r.taskId}/start`, { method: 'POST', body: JSON.stringify({}) });
    } catch (err) {
      toast(err.message || '开始失败');
      throw err;
    }
    toast(`已开始：${r.fileName}`);
    startPolling();
  } catch (err) {
    toast(`开始失败：${err.message}`);
    clearBusy(btn);
    render();
  }
}
/**
 * 取消后的提示要说实话：
 * 云端接受了取消请求 → 说"云端已终止"；官方没有取消接口 → 说"已停止本地跟踪"。
 */
function cancelToast(cancel, count) {
  const n = `已取消 ${count} 个任务`;
  if (cancel?.remoteOk) return `${n}：云端已接受终止请求`;
  if (cancel?.remoteFailed) return `${n}：去字幕接口未提供取消能力，已停止本地跟踪（不再轮询、不再下载产物）`;
  if (cancel?.background) return `${n}（本地已立即生效，云端终止请求已发出）`;
  return n;
}
async function stopTask(r) {
  if (!r.taskId) return;
  // 立刻给反馈：按钮变"取消中…"并禁用，避免重复点、也避免以为没生效
  const btn = rowActionButton(r, /停止任务|取消中/);
  if (!markBusy(btn, '取消中…')) return;          // 已经在取消 → 忽略重复点击
  try {
    const res = await jsonApi(`/api/tasks/${r.taskId}`, { method: 'DELETE' });
    toast(cancelToast(res.cancel, 1));
    startPolling();
    setTimeout(poll, 3000);   // 云端终止结果稍后才回来，再拉一次把说明补上
  } catch (err) {
    toast(err.code === 'TIMEOUT'
      ? '取消请求超时：服务器响应慢，页面仍可正常操作，请稍后重试'
      : `取消失败：${err.message}`);
    clearBusy(btn);
    render();
  }
}
el.batchStart.addEventListener('click', () => { if (!el.batchStart.disabled) batchAction('start'); });
el.batchCancel.addEventListener("click", () => { if (!el.batchCancel.disabled) batchAction("cancel"); });
el.batchDelete.addEventListener("click", () => { if (!el.batchDelete.disabled) batchAction("delete"); });
el.checkAll.addEventListener('change', () => {
  const rows = viewRows().filter((r) => r.fileId || r.taskId);
  if (el.checkAll.checked) rows.forEach((r) => state.selected.add(r.key));
  else rows.forEach((r) => state.selected.delete(r.key));
  render();
});

/* ---------------------------------------------------------------- 移除任务 */

/** 把服务端返回的清理结果说清楚：删了什么、释放多少、哪些因为被别人用着而保留 */
function purgeToast(res, fallbackName) {
  const parts = [];
  if (res.removedFile) parts.push('源文件');
  if (res.removedTask) parts.push('产物');
  if (res.removedMd5) parts.push('MD5 索引');
  const size = res.freedBytes ? `（释放 ${fmtBytes(res.freedBytes)}）` : '';
  if (parts.length) return `已移除并清理：${parts.join(' + ')}${size}`;
  const kept = [res.keptFile, res.keptTask].filter(Boolean).join('；');
  return kept ? `已移除该行（${kept}，暂未删除）` : `已移除：${fallbackName}`;
}
async function removeRow(r) {
  if (state.syncing) { toast('正在提交，请稍候再移除'); return; }
  // 批次还没建立（还在上传阶段）→ 纯本地移除，并中断进行中的上传
  if (r.local || !state.batchId) {
    const it = state.items.find((x) => x.key === r.key);
    if (it) it.canceled = true;          // 让 runUpload 后续环节直接退出，不再上传
    // 已经上传到服务器的源文件也要一起清掉（源文件 + MD5 索引 + 内容索引）
    let purged = null;
    if (it?.fileId) {
      try { purged = await jsonApi(`/api/files/${it.fileId}`, { method: 'DELETE' }); }
      catch { /* 已被其它行引用或已清理：忽略，不影响本地移除 */ }
    }
    if (it?.xhr) { try { it.xhr.abort(); } catch { /* 忽略 */ } }
    state.items = state.items.filter((x) => x.key !== r.key);
    if (state.openKey === r.key) state.openKey = null;
    render();
    toast(purged ? purgeToast(purged, r.fileName) : `已移除：${r.fileName}`);
    return;
  }
  const btn = rowActionButton(r, /移除任务|移除中/);
  // 关键：移除是按"行号"删的，连点第二次会删到下一行 → 必须挡住重复点击
  if (!markBusy(btn, '移除中…')) return;
  try {
    const res = await jsonApi(`/api/batches/${state.batchId}/items/${r.index - 1}`, { method: 'DELETE' });
    applyBatch(res);
    if (state.openKey === r.key) state.openKey = null;
    if (!state.rows.length) {            // 整批都被移除了 → 回到纯上传状态
      clearSaved();
      state.batchId = null;
      state.batch = null;
      state.items = [];
      el.batchCard.hidden = true;
    }
    render();
    toast(purgeToast(res, r.fileName));
  } catch (err) {
    toast(`移除失败：${err.message}`);
    clearBusy(btn);
    render();
  }
}

/* ---------------------------------------------------------------- 逐任务下载 */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function downloadRow(r) {
  const name = r.result?.name || `${String(r.fileName).replace(/\.[^.]+$/, '')}-处理结果.${r.result?.srt ? 'srt' : 'mp4'}`;
  if (!r.taskId) return toast('这一行还没有可下载的产物');

  // 同源地址：服务端带头流式返回（浏览器下载管理器接管：立即开始、有原生进度、不占内存）
  const localUrl = `/api/download/${r.taskId}`;
  const btn = rowDownloadButton(r);
  // 同一行在 90 秒内只允许下一次，避免连点触发多个重复下载
  if (state.downloading.has(r.taskId)) return toast('这一行已经在下载了');
  state.downloading.add(r.taskId);
  setTimeout(() => { state.downloading.delete(r.taskId); render(); }, 90000);
  const setBusy = (busy) => { if (btn) { btn.disabled = busy; btn.textContent = busy ? '下载中…' : (r.result?.srt ? '下载字幕' : '下载视频'); } };

  // 产物不在服务器（KEEP_ARTIFACT=false）：/api/download 会 302 到云端，
  // 这里用 fetch 跟随后流式写入内存再保存 —— 数据由浏览器直连云端，不占服务器带宽。
  setBusy(true);
  try {
    const res = await fetch(localUrl, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body?.getReader?.();
    let got = 0;
    const chunks = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (btn && total) btn.textContent = `下载中 ${Math.min(99, Math.round((got / total) * 100))}%`;
      }
    } else {
      chunks.push(new Uint8Array(await res.arrayBuffer()));
    }
    const blob = new Blob(chunks, { type: r.result?.srt ? 'application/x-subrip;charset=utf-8' : 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`已保存 ${name}（${fmtBytes(blob.size)}）`);
  } catch (err) {
    toast(`下载失败：${err.message}${r.result?.srt ? '' : '；可在预览里右键「存储视频为…」直接保存'}`);
  } finally {
    setBusy(false);
  }
}

/** 找到某一行上的「下载视频」按钮（用于显示下载中状态） */
/** 浏览器无法内联播放的容器：直接给兜底提示，而不是塞一个放不出来的播放器 */
const UNPLAYABLE_EXT = new Set(['.mkv', '.avi', '.flv', '.wmv', '.ts', '.mpeg', '.mpg', '.vob', '.rmvb', '.3gp', '.m2ts']);
const extOf = (name) => `.${String(name || '').split('.').pop().toLowerCase()}`;

/** 源/目标视频放不出来时的兜底面板（含下载入口） */
function previewFallback(kind, r) {
  if (kind === 'src') {
    const ext = extOf(r.fileName);
    const why = UNPLAYABLE_EXT.has(ext)
      ? `浏览器不支持 ${escapeHtml(ext)} 格式的内联播放`
      : '该视频的编码浏览器无法解码（或文件已过期）';
    return `<div class="state">
      <div class="t">浏览器无法直接预览这个视频</div>
      <div class="h">${why}；不影响去字幕处理，处理后可以下载产物</div>
      ${r.fileId ? `<a class="btn btn-ghost btn-sm" href="/f/${r.fileId}?dl=1" download>下载源文件</a>` : ''}
    </div>`;
  }
  return `<div class="state">
    <div class="t">产物暂时无法播放</div>
    <div class="h">${r.productRemote && r.productExpiresAt
      ? `产物在云端保存，有效期至 ${new Date(r.productExpiresAt).toLocaleString('zh-CN', { hour12: false })}`
      : '服务器上的产物可能已被清理（12 小时），或浏览器不支持该编码'}</div>
    ${r.downloadUrl ? `<a class="btn btn-ghost btn-sm" href="${r.downloadUrl}">下载视频</a>` : ''}
  </div>`;
}

/** 行内按钮：按文字找（用于"取消中…"这类即时反馈） */
function rowActionButton(r, re) {
  const node = el.list.querySelectorAll('.row')[r.index - 1];
  if (!node) return null;
  return [...node.querySelectorAll('.row-actions .btn')].find((b) => re.test(b.textContent)) || null;
}

function rowDownloadButton(r) {
  const nodes = [...el.list.querySelectorAll('.row')];
  const node = nodes[r.index - 1];
  if (!node) return null;
  return [...node.querySelectorAll('.row-actions .btn')].find((b) => /下载视频|下载字幕|下载中/.test(b.textContent)) || null;
}

/* ---------------------------------------------------------------- 刷新恢复 */
function clearSaved() { try { localStorage.removeItem(STORE_KEY); } catch { /* 忽略 */ } }
function tabForBatch(data) {
  const operation = data?.batch?.operation;
  if (operation === 'enhance' || operation === 'asr-subtitles' || operation === 'transcode') {
    return ({ enhance: 'enhance', 'asr-subtitles': 'asr', transcode: 'transcode' })[operation];
  }
  if (['ocr-extract', 'face-blur', 'portrait-matte', 'region-blur'].includes(operation)) return 'erase';
  if (operation === 'erase-subtitle' && (data.items || []).length && (data.items || []).every((item) => !item.fileId)) return 'link';
  return 'erase';
}
async function restore() {
  let batchId = null;
  try { batchId = localStorage.getItem(STORE_KEY); } catch { /* 忽略 */ }
  if (!batchId) return;
  try {
    const data = await jsonApi(`/api/batches/${batchId}`);
    const tab = tabForBatch(data);
    state.tabBatch[tab] = batchId;
    if (tab !== state.tab) await setTab(tab);
    else {
      state.batchId = batchId;
      applyBatch(data);
      render();
      if ((data.items || []).some((r) => r.status === 'queued' || r.status === 'running')) startPolling();
    }
    toast('已恢复上次的任务批次');
  } catch {
    clearSaved();
  }
}

/* ---------------------------------------------------------------- 事件 */
  // 登录 / 注册 两个模式（默认登录）
  let authMode = 'login';
  let captchaCtx = null;
  function setAuthMode(mode) {
    authMode = mode;
    const reg = mode === 'register';
    if (el.confirmField) el.confirmField.hidden = !reg;
    el.loginBtn.textContent = reg ? '注册' : '登录';
    if (el.switchMode) el.switchMode.textContent = reg ? '已有账号？去登录' : '没有账号？去注册';
    el.authError.hidden = true;
  }

  async function submitAuth() {
    const phone = el.phoneInput.value.trim();
    const password = el.passwordInput.value;
    if (!phone || !password) {
      el.authError.textContent = '请填写手机号和密码';
      el.authError.hidden = false;
      return;
    }
    if (authMode === 'register' && el.confirmInput.value !== password) {
      el.authError.textContent = '两次输入的密码不一致';
      el.authError.hidden = false;
      return;
    }
    if (loginPending) return;
    markBusy(el.loginBtn, authMode === 'register' ? '正在注册…' : '正在登录…');
    try {
      const body = { phone, password };
      if (captchaCtx) { body.captchaId = captchaCtx.id; body.captchaAnswer = el.captchaInput.value.trim(); }
      const res = await fetch(`/api/auth/${authMode}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 428 && data.captcha) {
        captchaCtx = data.captcha;
        el.captchaField.hidden = false;
        el.captchaQuestion.textContent = `验证码：${data.captcha.question}`;
        el.captchaInput.value = '';
        el.authError.textContent = '需要验证码，请输入计算结果';
        el.authError.hidden = false;
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      captchaCtx = null;
      el.captchaField.hidden = true;
      el.passwordInput.value = '';
      if (el.confirmInput) el.confirmInput.value = '';
      sessionEndsAt = Date.parse(data.expiresAt);
      state.session = data;
      showApp();
      await init();
      refreshHeader();
      toast(authMode === 'register' ? '注册成功，已自动登录' : '登录成功');
    } catch (err) {
      el.authError.textContent = err.message || '操作失败';
      el.authError.hidden = false;
    } finally {
      clearBusy(el.loginBtn);
    }
  }
  el.authForm.addEventListener('submit', (e) => { e.preventDefault(); submitAuth(); });
  if (el.switchMode) el.switchMode.addEventListener('click', (e) => { e.preventDefault(); setAuthMode(authMode === 'login' ? 'register' : 'login'); });

  /** 页头积分徽标（点击输入卡密充值） */
  


function renderCredits() {
    const u = state.session?.user;
    const badge = el.creditsBadge || document.getElementById('creditsBadge');
    if (!u || !badge) return;
    badge.textContent = `积分 ${u.credits}`;
    if (badge.dataset.bound !== '1') {
      badge.dataset.bound = '1';
      badge.addEventListener('click', redeemPrompt);
    }
  if (el.adminBtn) el.adminBtn.hidden = u.role !== 'admin';
    badge.title = '点击输入卡密充值';
  }

function setSettingsOpen(open) {
  if (!el.settingsBtn || !el.settingsMenu) return;
  el.settingsMenu.hidden = !open;
  el.settingsBtn.setAttribute('aria-expanded', String(open));
  el.settingsBtn.classList.toggle('is-open', open);
}

if (el.settingsBtn && el.settingsMenu) {
  el.settingsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setSettingsOpen(el.settingsMenu.hidden);
  });
  el.settingsMenu.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => setSettingsOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { setSettingsOpen(false); el.settingsBtn.focus(); }
  });
}


// 后台：生成卡密
if (el.adminBtn) {
  // —— 页签切换 ——
  let adminTab = 'codes';
  function showAdminTab(tab) {
    adminTab = tab;
    el.adminMask.querySelectorAll('.admin-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    el.adminMask.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    if (tab === 'codes') loadCodes();
  }
  el.adminMask.querySelectorAll('.admin-tab').forEach((b) => {
    b.addEventListener('click', () => showAdminTab(b.dataset.tab));
  });

  // —— 卡密记录 ——
  async function loadCodes() {
    const box = el.adminMask.querySelector('#codesList');
    const sum = el.adminMask.querySelector('#codesSummary');
    const filter = el.adminMask.querySelector('#codeFilter').value;
    sum.textContent = '加载中…';
    try {
      const d = await jsonApi(`/api/admin/codes?status=${filter}`);
      sum.textContent = `共 ${d.total} 张（已兑换 ${d.used} / 未兑换 ${d.unused}）· 累计发放 ${d.creditsIssued} 积分 · 已兑换 ${d.creditsRedeemed} 积分`;
      if (!d.codes.length) { box.innerHTML = '<span class="admin-hint">没有符合条件的卡密</span>'; return; }
      box.innerHTML = d.codes.map((c) => {
        const state = c.usedAt
          ? `<span class="abuse-tag warn">已兑换</span> ${c.usedBy || ''} · ${String(c.usedAt).slice(5, 16).replace('T', ' ')}`
          : '<span class="abuse-tag ok">未兑换</span>';
        return `<div class="abuse-item admin-code-row"><span class="mono">${c.code}</span>`
          + `<span class="abuse-tag">${c.credits} 积分</span>`
          + `<span class="admin-hint" style="flex:1">${state}</span>`
          + `<span class="admin-hint">${String(c.createdAt || '').slice(5, 10)}</span>`
          + `<button class="btn-text" data-copy="${c.code}" type="button">复制</button>`
          + (c.usedAt
              ? `<span class="admin-hint" title="已兑换的卡密不可删除">—</span>`
              : `<button class="btn-text" data-del="${c.code}" type="button">删除</button>`)
          + `</div>`;
      }).join('');
      box.querySelectorAll('button[data-copy]').forEach((b) => {
        b.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(b.dataset.copy); toast('已复制卡密'); }
          catch { toast(`复制失败，卡密：${b.dataset.copy}`); }
        });
      });
      box.querySelectorAll('button[data-del]').forEach((b) => {
        b.addEventListener('click', async () => {
          const code = b.dataset.del;
          if (!window.confirm(`确定删除卡密 ${code} 吗？`)) return;
          try {
            await jsonApi(`/api/admin/codes/${encodeURIComponent(code)}`, { method: 'DELETE' });
            toast('已删除');
            loadCodes();
          } catch (err) { toast(`删除失败：${err.message}`); }
        });
      });
    } catch (err) {
      sum.textContent = `加载失败：${err.message}`;
    }
  }
  el.adminMask.querySelector('#codeFilter').addEventListener('change', loadCodes);

  el.adminBtn.addEventListener('click', () => { setSettingsOpen(false); el.adminMask.hidden = false; showAdminTab('codes'); });
  el.adminClose.addEventListener('click', () => { el.adminMask.hidden = true; });
  el.adminMask.addEventListener('click', (e) => { if (e.target === el.adminMask) el.adminMask.hidden = true; });
  el.adminGen.addEventListener('click', async () => {
    const count = Math.max(1, Math.min(200, Number(el.adminCount.value) || 1));
    const credits = Math.max(1, Number(el.adminCredits.value) || 0);
    if (!markBusy(el.adminGen, '生成中…')) return;
    try {
      const res = await jsonApi('/api/admin/codes', { method: 'POST', body: JSON.stringify({ count, credits }) });
      el.adminCodes.value = res.codes.join('\n');
      el.adminCodes.hidden = false;
      el.adminCopyRow.hidden = false;
      el.adminHint.textContent = `已生成 ${res.codes.length} 张，每张 ${credits} 积分`;
      loadCodes();
    } catch (err) {
      toast(`生成失败：${err.message}`);
    } finally {
      clearBusy(el.adminGen);
    }
  });
  const pwSave = el.adminMask.querySelector('#pwSave');
  const pwReset = el.adminMask.querySelector('#pwReset');
  pwSave.addEventListener('click', async () => {
    const oldPassword = el.adminMask.querySelector('#pwOld').value;
    const newPassword = el.adminMask.querySelector('#pwNew').value;
    if (!oldPassword || !newPassword) return toast('请填写当前密码和新密码');
    try {
      await jsonApi('/api/me/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
      el.adminMask.querySelector('#pwOld').value = '';
      el.adminMask.querySelector('#pwNew').value = '';
      toast('密码已修改，下次用新密码登录');
    } catch (err) { toast(`修改失败：${err.message}`); }
  });
  pwReset.addEventListener('click', async () => {
    const phone = el.adminMask.querySelector('#pwPhone').value.trim();
    const newPassword = el.adminMask.querySelector('#pwTarget').value;
    if (!phone || !newPassword) return toast('请填写手机号和新密码');
    if (!window.confirm(`确定把 ${phone} 的密码重置为新的吗？`)) return;
    try {
      await jsonApi('/api/admin/reset-password', { method: 'POST', body: JSON.stringify({ phone, newPassword }) });
      el.adminMask.querySelector('#pwPhone').value = '';
      el.adminMask.querySelector('#pwTarget').value = '';
      toast(`已重置 ${phone} 的密码`);
    } catch (err) { toast(`重置失败：${err.message}`); }
  });

  // 反作弊：用户状态与处置
  async function loadAbuse() {
    const box = el.adminMask.querySelector('#abuseBox');
    box.innerHTML = '<span class="admin-hint">加载中…</span>';
    try {
      const d = await jsonApi('/api/admin/abuse');
      const rows = d.users.map((u) => {
        const state = u.suspended ? '<span class="abuse-tag warn">已暂停</span>' : '<span class="abuse-tag ok">正常</span>';
        const wl = u.whitelisted ? '<span class="abuse-tag ok">白名单</span>' : '';
        const hits = u.rateHits ? ` <span class="abuse-tag warn">限流${u.rateHits}</span>` : '';
        const meta = [u.createdAt ? `注册 ${String(u.createdAt).slice(5, 10)}` : '', u.lastLoginAt ? `上次登录 ${String(u.lastLoginAt).slice(5, 16).replace('T', ' ')}` : '从未登录', u.charged ? `累计消费 ${u.charged}` : ''].filter(Boolean).join(' · ');
        return `<div class="abuse-item"><b>${u.phone || u.id}</b> 积分 ${u.credits} ${state}${wl}${hits}<span class="h">${meta}</span>
          <button class="btn-text" data-act="${u.whitelisted ? 'unwhitelist' : 'whitelist'}" data-id="${u.id}">${u.whitelisted ? '取消白名单' : '加白名单'}</button>
          <button class="btn-text" data-act="resume" data-id="${u.id}">解除</button>
          <button class="btn-text" data-act="suspend" data-id="${u.id}">暂停</button></div>`;
      }).join('');
      const evs = (d.events || []).slice(0, 12).map((e) => `<div class="abuse-item"><b>${e.type}</b> ${e.path || e.key || ''} · ${(e.at || '').slice(5, 16).replace('T', ' ')}</div>`).join('');
      box.innerHTML = `<div class="admin-label" style="margin:6px 0 2px">用户</div>${rows || '<span class="admin-hint">暂无用户</span>'}`
        + `<div class="admin-label" style="margin:10px 0 2px">最近事件</div>${evs || '<span class="admin-hint">暂无事件</span>'}`;
      box.querySelectorAll('button[data-act]').forEach((b) => {
        b.addEventListener('click', async () => {
          const action = b.dataset.act;
          const reason = action === 'suspend' ? (window.prompt('暂停原因？') || '管理员手动暂停') : '';
          try {
            await jsonApi('/api/admin/abuse/action', { method: 'POST', body: JSON.stringify({ userId: b.dataset.id, action, reason }) });
            toast(action === 'suspend' ? '已暂停' : action === 'resume' ? '已解除限制' : '白名单已更新');
            loadAbuse();
          } catch (err) { toast(`操作失败：${err.message}`); }
        });
      });
    } catch (err) {
      box.innerHTML = `<span class="admin-hint">加载失败：${err.message}</span>`;
    }
  }
  const abuseReloadBtn = el.adminMask.querySelector('#abuseReload');
  if (abuseReloadBtn) abuseReloadBtn.addEventListener('click', loadAbuse);

  el.adminCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el.adminCodes.value); toast('卡密已复制'); }
    catch { el.adminCodes.select(); toast('已选中，按 Ctrl/⌘+C 复制'); }
  });
}


el.logoutBtn.addEventListener('click', async () => {
  if (!markBusy(el.logoutBtn, '正在退出…')) return;
  setSettingsOpen(false);
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* 忽略 */ }
  sessionEndsAt = null;
  state.session = { authenticated: false };
  showLogin();
    clearBusy(el.logoutBtn);   // 复位按钮，否则下次登录后仍显示「正在退出…」
});

let pickGuard = 0;
// 切换处理模式（标准 / 全屏）：只更新还没开始的任务，进行中的不受影响
el.erasePreset?.addEventListener('change', async () => {
  if (!state.batchId) return;
  const preset = el.erasePreset.value;
  const label = el.erasePreset.selectedOptions[0].textContent;
  try {
    const res = await jsonApi(`/api/batches/${state.batchId}`, {
      method: 'PATCH', body: JSON.stringify({ erasePreset: preset }),
    });
    toast(`处理模式已改为「${label}」：更新 ${res.updated} 个待开始任务${res.running ? `，${res.running} 个进行中不变` : ''}`);
    applyBatch(res);
    render();
  } catch (err) { toast(`修改失败：${err.message}`); }
});

// 点击由覆盖在拖拽区上的透明 file input 原生触发（兼容 Safari），这里不再手动 click()
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
/* ============================================================================
 * 工具标签：去水印 / 去字幕 / 画质超清 / 视频压缩
 * 四个工具共用「输入卡片 + 批次结果」的纵向页面骨架。
 * ========================================================================== */
function tabPayload() {
  if (state.tab === 'enhance') return { operation: 'enhance', resolution: el.resSelect?.value || '1080p', toolVersion: el.verSelect?.value || 'standard' };
  if (state.tab === 'transcode') return { operation: 'transcode', options: { profile: el.tcProfile?.value || '1080p' } };
  return { operation: 'erase-subtitle', erasePreset: el.erasePreset?.value || 'standard' };
}

const TAB_META = {
  link: { title: '视频去水印', desc: '粘贴公网视频直链，直接调用云端处理，无需先上传到服务器；支持一次添加多条链接。' },
  erase: { title: '视频去字幕', desc: '上传视频，智能识别并擦除画面字幕；支持批量处理与原片、结果对比预览。' },
  enhance: { title: '画质超清', desc: '对视频进行去噪、清晰度增强与超分辨率处理，最高可输出 4K。' },
  transcode: { title: '视频压缩', desc: '将视频压缩为适合上传和分发的 MP4，可选择 1080P、720P 或 H.265。' },
};

async function setTab(tab) {
  if (!TAB_META[tab] || tab === state.tab) return;
  state.tabBatch[state.tab] = state.batchId;
  state.tab = tab;
  [...el.tabbar.querySelectorAll('.tab')].forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  const meta = TAB_META[tab];
  if (el.pageTitle) el.pageTitle.textContent = meta.title;
  if (el.pageDesc) el.pageDesc.textContent = meta.desc;
  const isLink = tab === 'link';
  if (el.uploadCard) el.uploadCard.hidden = isLink;
  if (el.linkCard) el.linkCard.hidden = !isLink;
  if (el.modeRow) el.modeRow.hidden = tab !== 'erase';
  if (el.resRow) el.resRow.hidden = tab !== 'enhance';
  if (el.tcRow) el.tcRow.hidden = tab !== 'transcode';
  stopPolling();
  state.items = [];
  state.selected.clear();
  state.openKey = null;
  state.batchId = state.tabBatch[tab] || null;
  state.batch = null;
  state.rows = [];
  if (el.batchCard) el.batchCard.hidden = !state.batchId;
  if (state.batchId) {
    try { applyBatch(await jsonApi(`/api/batches/${state.batchId}`)); startPolling(); }
    catch { state.batchId = null; clearSaved(); }
  }
  try {
    if (state.batchId) localStorage.setItem(STORE_KEY, state.batchId);
    else localStorage.removeItem(STORE_KEY);
  } catch { /* 忽略 */ }
  render();
}

/* ------------------------------- 链接去水印 -------------------------------
 * 与「去字幕 / 超清」共用批次列表：一次粘贴多条直链 → 建成一个链接批次 →
 * 用「批量开始 / 批量取消 / 批量删除」统一操作，也可以在行内单独控制。
 */
async function addLinkBatch() {
  const raw = String(el.linkInputs?.value || '');
  const urls = [...new Set(raw.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean))];
  if (el.linkNotice) el.linkNotice.hidden = true;
  if (!urls.length) {
    if (el.linkNotice) { el.linkNotice.textContent = '请先粘贴至少一个视频直链（每行一个）'; el.linkNotice.hidden = false; }
    return;
  }
  if (!markBusy(el.linkAdd, '正在解析…')) return;
  try {
    const res = await jsonApi('/api/batches/from-urls', { method: 'POST', timeoutMs: 900000, body: JSON.stringify({ urls }) });
    el.linkInputs.value = '';
    state.tabBatch.link = res.batch.id;
    state.batchId = res.batch.id;
    try { localStorage.setItem(STORE_KEY, state.batchId); } catch { /* 忽略 */ }
    applyBatch(res);
    // 新添加的链接默认全部勾选，方便直接点「批量开始」
    const fresh = viewRows().filter((r) => r.status === 'idle');
    fresh.forEach((r) => state.selected.add(r.key));
    render();
    startPolling();
    if (el.batchCard) el.batchCard.hidden = false;
    const skipped = res.skipped || [];
    if (skipped.length) {
      setNotice(`已添加 ${res.items.length} 个链接，${skipped.length} 个被跳过：${skipped.slice(0, 3).map((s) => s.reason).join('；')}${skipped.length > 3 ? ' …' : ''}`);
    } else {
      setNotice('');
    }
    toast(`已添加 ${res.items.length} 个链接，可点「批量开始」`);
  } catch (err) {
    if (el.linkNotice) { el.linkNotice.textContent = `添加失败：${err.message}`; el.linkNotice.hidden = false; }
  } finally {
    clearBusy(el.linkAdd);
  }
}

if (el.tabbar) el.tabbar.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
if (el.linkAdd) el.linkAdd.addEventListener('click', addLinkBatch);
if (el.batchZip) el.batchZip.addEventListener('click', () => {
  const done = viewRows().filter((r) => r.status === 'succeeded' || r.status === 'done');
  if (!done.length) { toast('还没有已完成的产物可打包'); return; }
  toast(`正在打包 ${done.length} 个产物…`);
  window.location.href = `/api/batches/${state.batchId}/zip`;
});
if (el.linkInputs) el.linkInputs.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addLinkBatch(); } });

el.fileInput.addEventListener('change', () => { acceptFiles(el.fileInput.files); el.fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add('is-drag'); }));
['dragleave', 'drop'].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove('is-drag'); }));
el.dropzone.addEventListener('drop', (e) => acceptFiles(e.dataTransfer?.files));
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) acceptFiles(files);
});

bootstrap();

/* ---------------------------------------------------------------- 页头同步
 * 独立于登录流程：登录后 / 刷新后 / 每 10 秒，从服务端取一次会话里的用户，
 * 保证「积分徽标」和「后台」入口始终正确显示（管理员才看得到后台）。
 */
async function redeemPrompt() {
  const code = window.prompt('输入卡密（形如 WM-XXXX-XXXX-XXXX-XXXX）');
  if (!code) return;
  try {
    const r = await jsonApi('/api/credits/redeem', { method: 'POST', body: JSON.stringify({ code }) });
    toast(`充值成功 +${r.credits} 积分，余额 ${r.balance}`);
    refreshHeader();
  } catch (err) { toast(`充值失败：${err.message}`); }
}

async function refreshHeader() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    if (res.ok === false) return;        // 仅明确失败（5xx/网关）才跳过：保持现状，不要当成已登出
    const d = await res.json();
    if (!d.authenticated) {
      if (el.adminBtn) el.adminBtn.hidden = true;
      if (state.session.authenticated) showLogin('会话已过期，请重新登录');
      state.session = { authenticated: false };
      sessionEndsAt = null;
      return;
    }
    state.session = d;
    sessionEndsAt = Date.parse(d.expiresAt);
    const u = d.user;
    if (!u) return;
    renderCredits();
    if (el.sessionLeft) el.sessionLeft.textContent = fmtCountdown(sessionEndsAt - Date.now());
    /* 超清已独立为标签页 */
  } catch { /* 忽略 */ }
}

refreshHeader();
setTimeout(refreshHeader, 1200);
setInterval(refreshHeader, 10000);

/* ============================================================================
 * 顶层页面：工具 / 创作 / 资产 / 积分
 * ========================================================================== */
const PAGE_IDS = { home: 'pageHome', tools: 'pageTools', studio: 'pageStudio', assets: 'pageAssets', tasks: 'pageTasks', plans: 'pagePlans' };
let currentPage = 'tools';
let assetKind = 'all';
let assetList = [];

function switchPage(page) {
  if (!PAGE_IDS[page]) return;
  currentPage = page;
  for (const [k, id] of Object.entries(PAGE_IDS)) {
    const node = document.getElementById(id);
    if (node) node.hidden = k !== page;
  }
  document.querySelectorAll('#navMain .nav-pill').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.page === page);
  });
  if (page === 'assets') loadAssets();
  if (page === 'tools') { loadAssets().then(syncToolsAside).catch(() => syncToolsAside()); }
  if (page === 'home') { loadAssets().then(renderHome).catch(() => renderHome()); }
  if (page === 'tasks') loadTasks();
  if (page === 'studio' && el.studioNotice) {
    // 生成服务未接入时给出明确提示（不阻塞其它功能）
    el.studioNotice.hidden = false;
  }
}

let assetSearch = '';
let assetSel = new Set();

async function loadAssets() {
  if (!el.assetGrid) return;
  try {
    const data = await jsonApi('/api/assets');
    assetList = data.assets || [];
  } catch (err) {
    assetList = [];
    toast(`资产加载失败：${err.message}`);
  }
  renderAssetFilters();
  renderAssets();
}

function assetKindLabel(kind) {
  return ({ video: '视频', text: '文案', image: '图片', audio: '音频' })[kind] || kind;
}
function assetMatches(a) {
  if (assetKind !== 'all' && a.kind !== assetKind) return false;
  if (assetSearch && !String(a.name || '').toLowerCase().includes(assetSearch.toLowerCase())) return false;
  return true;
}

function renderAssetFilters() {
  if (!el.assetFilters) return;
  const kinds = ['all', 'video', 'image', 'audio', 'text'];
  el.assetFilters.innerHTML = kinds.map((k) => {
    const n = k === 'all' ? assetList.length : assetList.filter((a) => a.kind === k).length;
    if (k !== 'all' && n === 0) return '';
    return `<button class="cchip ${assetKind === k ? 'on' : ''}" type="button" data-kind="${k}">${k === 'all' ? '全部' : assetKindLabel(k)} <span class="cnt">${n}</span></button>`;
  }).join('');
}

const ASSET_ICON = { video: '▶', text: 'T', audio: '♫', image: '▣' };

function renderAssets() {
  if (!el.assetGrid) return;
  const list = assetList.filter(assetMatches);
  const totalBytes = list.reduce((s2, a) => s2 + (Number(a.size) || 0), 0);
  if (el.assetTotal) el.assetTotal.textContent = `共 ${list.length} 项 · ${fmtBytes(totalBytes)}`;
  el.assetEmpty.hidden = list.length > 0;
  el.assetGrid.innerHTML = '';
  for (const a of list) {
    const card = document.createElement('div');
    card.className = 'asset' + (assetSel.has(a.id) ? ' sel' : '');
    const thumb = a.thumbUrl
      ? `<img src="${a.thumbUrl}" alt="" loading="lazy" onerror="this.style.display='none'" />`
      : ASSET_ICON[a.kind] || '▶';
    card.innerHTML = `
      <div class="a-thumb">${thumb}<span class="a-badge">${a.source === 'upload' ? '上传' : '处理'}</span>
        <span class="a-kind">${assetKindLabel(a.kind)}</span>
        <span class="a-check ${assetSel.has(a.id) ? 'on' : ''}"></span></div>
      <div class="a-name" title="${escapeHtml(a.name || '')}">${escapeHtml(a.name || '')}</div>
      <div class="a-meta">${a.kind === 'text' ? '字幕/文稿' : (a.remote ? '云端保存' : '本地保存')}${a.sizeText ? ' · ' + a.sizeText : ''}</div>
      <div class="a-date">${a.createdAt ? new Date(a.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''}</div>
      <div class="a-acts"></div>`;
    card.querySelector('.a-thumb').addEventListener('click', () => toggleAssetSel(a.id));
    const acts = card.querySelector('.a-acts');
    if (a.downloadUrl) {
      const link = document.createElement('a');
      link.href = a.downloadUrl; link.textContent = '下载'; link.download = '';
      acts.appendChild(link);
    } else if (a.url) {
      const link = document.createElement('a');
      link.href = a.url; link.textContent = '下载'; link.download = ''; link.target = '_blank';
      acts.appendChild(link);
    }
    if (a.source === 'upload' && a.fileId) {
      const del = document.createElement('button');
      del.type = 'button'; del.textContent = '删除';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteAssets([a]); });
      acts.appendChild(del);
    }
    el.assetGrid.appendChild(card);
  }
  if (el.assetBulk) el.assetBulk.hidden = list.length === 0;
  updateAssetSel();
}

function toggleAssetSel(id) {
  if (assetSel.has(id)) assetSel.delete(id); else assetSel.add(id);
  renderAssets();
}
function updateAssetSel() {
  if (!el.assetBulk) return;
  const list = assetList.filter(assetMatches);
  if (el.assetSelNote) el.assetSelNote.textContent = `已选 ${assetSel.size} 项`;
  if (el.assetSelAll) {
    el.assetSelAll.checked = list.length > 0 && list.every((a) => assetSel.has(a.id));
  }
  if (el.assetBulkDelete) el.assetBulkDelete.disabled = assetSel.size === 0;
}

async function deleteAssets(items) {
  const removable = items.filter((a) => a.source === 'upload' && a.fileId);
  const skipped = items.length - removable.length;
  if (!removable.length) { toast('选中的是处理产物，暂不支持删除'); return; }
  if (!confirm(`删除 ${removable.length} 个上传素材？仍被任务引用的会保留。${skipped ? `（${skipped} 个产物跳过）` : ''}`)) return;
  let ok = 0;
  for (const a of removable) {
    try { await jsonApi(`/api/files/${a.fileId}`, { method: 'DELETE' }); ok += 1; assetSel.delete(a.id); }
    catch { /* 被引用，保留 */ }
  }
  toast(`已删除 ${ok} 个${skipped ? `，跳过 ${skipped} 个` : ''}`);
  await loadAssets();
}

if (el.assetSearch) {
  el.assetSearch.addEventListener('input', () => { assetSearch = el.assetSearch.value.trim(); renderAssets(); });
}
if (el.assetSelAll) {
  el.assetSelAll.addEventListener('change', () => {
    const list = assetList.filter(assetMatches);
    if (el.assetSelAll.checked) list.forEach((a) => assetSel.add(a.id));
    else assetSel.clear();
    renderAssets();
  });
}
if (el.assetBulkDelete) {
  el.assetBulkDelete.addEventListener('click', () => {
    const items = assetList.filter((a) => assetSel.has(a.id));
    deleteAssets(items);
  });
}

if (el.navMain) {
  el.navMain.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-pill');
    if (btn) switchPage(btn.dataset.page);
  });
}
if (el.assetFilters) {
  el.assetFilters.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    assetKind = b.dataset.kind;
    el.assetFilters.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    loadAssets();
  });
}
if (el.studioSend) {
  el.studioSend.addEventListener('click', () => toast('生成服务尚未开通：需要接入火山方舟 Seedream / Seedance'));
}
if (el.plansRedeem) {
  el.plansRedeem.addEventListener('click', () => redeemPrompt());
}

/* ============================================================================
 * 首页（工作台）：指令栏 + Bento 工具矩阵 + 最近资产
 * ========================================================================== */
function renderHome(){
  const box = document.getElementById('homeAssets');
  if (!box) return;
  box.innerHTML = '';
  const list = (assetList || []).slice(0, 4);
  if (!list.length) {
    box.innerHTML = `
      <div class="home-empty">
        <span class="home-empty-icon" aria-hidden="true">＋</span>
        <strong>还没有生成记录</strong>
        <p>完成第一个视频后，作品会自动出现在这里。</p>
        <button class="btn btn-primary" type="button" data-focus-prompt>开始创作</button>
      </div>`;
    return;
  }
  const ICON = { video: '▶', text: 'T', audio: '♫', image: '▣' };
  for (const a of list) {
    const card = document.createElement('div');
    card.className = 'asset';
    card.innerHTML = `
      <div class="a-thumb">${ICON[a.kind] || '▶'}<span class="a-badge">${a.source === 'upload' ? '上传' : '处理'}</span></div>
      <div class="a-name" title="${escapeHtml(a.name || '')}">${escapeHtml(a.name || '')}</div>
      <div class="a-meta">${a.kind === 'text' ? '字幕/文稿' : (a.remote ? '云端保存' : '本地保存')}${a.sizeText ? ' · ' + a.sizeText : ''}</div>
      <div class="a-date">${a.createdAt ? new Date(a.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''}</div>
      <div class="a-acts"><button type="button" class="home-open">去处理</button></div>`;
    card.querySelector('.home-open').addEventListener('click', () => goTool('erase'));
    box.appendChild(card);
  }
}

/** 切到工具页并激活对应工具标签 */
function goTool(tab){
  switchPage('tools');
  const btn = document.querySelector(`#tabbar .tab[data-tab="${tab}"]`);
  if (btn) btn.click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('click', (e) => {
  const prompt = e.target.closest('[data-prompt]');
  if (prompt) {
    const input = document.getElementById('homeCmd');
    if (input) {
      input.value = prompt.dataset.prompt || '';
      input.dispatchEvent(new Event('input'));
      input.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    return;
  }
  const t = e.target.closest('[data-tool-tab]');
  if (t) { goTool(t.dataset.toolTab); return; }
  const p = e.target.closest('[data-page-go]');
  if (p) { switchPage(p.dataset.pageGo); return; }
  if (e.target.closest('[data-focus-prompt]')) {
    document.getElementById('homeCmd')?.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
const homeGo = document.getElementById('homeCmdGo');
const homeCmd = document.getElementById('homeCmd');
const generationPreview = document.getElementById('generationPreview');
const generationPreviewStage = document.getElementById('generationPreviewStage');
const generationVideo = document.getElementById('generationVideo');
const generationPreviewEmpty = document.getElementById('generationPreviewEmpty');
const generationStageLabel = document.getElementById('generationStageLabel');
const generationStageDetail = document.getElementById('generationStageDetail');
const generationProgressTitle = document.getElementById('generationProgressTitle');
const generationProgressPercent = document.getElementById('generationProgressPercent');
const generationProgressTrack = document.getElementById('generationProgressTrack');
const generationProgressBar = document.getElementById('generationProgressBar');
const generationProgressSpec = document.getElementById('generationProgressSpec');
const generationElapsed = document.getElementById('generationElapsed');
const generationProgressNote = document.getElementById('generationProgressNote');
const referenceInput = document.getElementById('referenceImage');
const referenceTrigger = document.getElementById('referenceTrigger');
const generationModeSelect = document.getElementById('generationMode');
const referencePreviews = document.getElementById('referencePreviews');
const referencePreviewList = document.getElementById('referencePreviewList');
const referencePreviewCount = document.getElementById('referencePreviewCount');
const referenceFiles = [];
let referenceSequence = 0;

function nextReferenceId() {
  referenceSequence += 1;
  return `ref_${Date.now().toString(36)}_${referenceSequence.toString(36)}`;
}

function referenceKind(file) {
  const type = String((file && file.type) || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  const name = String((file && file.name) || '').toLowerCase();
  const extension = name.includes('.') ? name.split('.').pop() : '';
  if (['jpg', 'jpeg', 'png', 'webp'].includes(extension)) return 'image';
  return null;
}

function currentGenerationMode() {
  return generationModeSelect?.value || 'text';
}

function clearReferenceFiles() {
  for (const item of referenceFiles) URL.revokeObjectURL(item.url);
  referenceFiles.splice(0);
  renderReferencePreviews();
}

function syncGenerationMode({ clear = false } = {}) {
  if (clear) clearReferenceFiles();
  const mode = currentGenerationMode();
  const textOnly = mode === 'text';
  if (referenceInput) referenceInput.disabled = textOnly || generationBusy;
  referenceTrigger?.classList.toggle('is-disabled', textOnly);
  if (referenceTrigger) {
    referenceTrigger.title = textOnly
      ? '文生视频无需参考图片'
      : mode === 'keyframes' ? '添加首帧与尾帧图片' : '添加 1–9 张参考图片';
  }
  const status = document.getElementById('generationStatus');
  if (status && !generationBusy) {
    status.textContent = textOnly
      ? '文生视频无需参考文件，输入描述即可生成'
      : mode === 'keyframes'
        ? '请添加正好 2 张图片：第一张作为首帧，第二张作为尾帧'
        : '请添加 1–9 张 JPG、PNG 或 WebP 参考图片';
  }
  if (homeCmd) {
    homeCmd.placeholder = textOnly
      ? '描述主体、动作、场景、镜头与光影……'
      : mode === 'keyframes'
        ? '描述从首帧到尾帧的主体动作、镜头运动和场景过渡……'
        : '说明每张参考图的用途，并描述主体、动作、场景和镜头……';
  }
  renderReferencePreviews();
}

function renderReferencePreviews() {
  if (!referencePreviews || !referencePreviewList) return;
  referencePreviewList.replaceChildren();
  referencePreviews.hidden = referenceFiles.length === 0;
  const mode = currentGenerationMode();
  if (referencePreviewCount) referencePreviewCount.textContent = mode === 'keyframes'
    ? `${referenceFiles.length} / 2 帧`
    : `${referenceFiles.length} / 9 张`;
  for (const [index, item] of referenceFiles.entries()) {
    const card = document.createElement('div');
    card.className = `reference-preview-item is-${item.kind}`;
    card.title = item.file.name;
    const img = document.createElement('img');
    img.src = item.url; img.alt = '';
    card.appendChild(img);
    const label = document.createElement('span');
    label.className = 'reference-preview-label';
    label.textContent = mode === 'keyframes' ? (index === 0 ? '首帧' : '尾帧') : `参考图 ${index + 1}`;
    card.appendChild(label);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'reference-preview-remove'; remove.dataset.referenceId = item.id;
    remove.setAttribute('aria-label', `删除${label.textContent}`); remove.textContent = '×';
    card.appendChild(remove);
    referencePreviewList.appendChild(card);
  }
}

if (referenceInput) {
  referenceInput.addEventListener('change', () => {
    const incoming = Array.from(referenceInput.files || []);
    const max = currentGenerationMode() === 'keyframes' ? 2 : 9;
    let rejected = 0;
    let added = 0;
    for (const file of incoming) {
      const kind = referenceKind(file);
      const duplicate = referenceFiles.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified);
      if (!kind || duplicate || referenceFiles.length >= max) { rejected += 1; continue; }
      try {
        referenceFiles.push({ id: nextReferenceId(), kind, file, url: URL.createObjectURL(file) });
        added += 1;
      } catch {
        rejected += 1;
      }
    }
    referenceInput.value = '';
    renderReferencePreviews();
    if (added) toast(`已添加 ${added} 张参考图片`);
    if (rejected) toast(`已跳过 ${rejected} 张重复、格式不支持或超过数量限制的图片`);
  });
}
generationModeSelect?.addEventListener('change', () => {
  syncGenerationMode({ clear: true });
  toast(`已切换为${generationModeSelect.options[generationModeSelect.selectedIndex].text}`);
});
referencePreviewList?.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-reference-id]');
  if (!remove) return;
  const index = referenceFiles.findIndex((item) => item.id === remove.dataset.referenceId);
  if (index < 0) return;
  URL.revokeObjectURL(referenceFiles[index].url);
  referenceFiles.splice(index, 1);
  renderReferencePreviews();
});

function firstResultUrl(value) {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) { const found = firstResultUrl(item); if (found) return found; }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) { const found = firstResultUrl(item); if (found) return found; }
  }
  return null;
}

const ACTIVE_GENERATION_STATES = new Set(['SUBMITTING', 'QUEUED', 'RUNNING']);
let generationBusy = false;
let generationMonitorToken = 0;
syncGenerationMode();

function setGenerationLocked(locked) {
  generationBusy = locked;
  if (homeGo) homeGo.disabled = locked;
  if (homeCmd) homeCmd.disabled = locked;
  if (referenceInput) referenceInput.disabled = locked || currentGenerationMode() === 'text';
  referenceTrigger?.classList.toggle('is-disabled', locked || currentGenerationMode() === 'text');
  for (const id of ['videoWorkflow', 'generationMode', 'videoRatio', 'videoResolution', 'videoDuration']) {
    const control = document.getElementById(id);
    if (control) control.disabled = locked;
  }
  document.querySelector('.creation-composer')?.classList.toggle('is-locked', locked);
  generationPreview?.classList.toggle('is-busy', locked);
  for (const button of document.querySelectorAll('.reference-preview-remove')) button.disabled = locked;
  if (homeGo) homeGo.textContent = locked ? '…' : '↑';
}

function generationStatusText(status) {
  return ({
    SUBMITTING: '正在提交', QUEUED: '等待云端资源', RUNNING: '正在生成视频',
    SUCCESS: '视频生成完成', FAILED: '视频生成失败', ERROR: '视频生成失败',
    CANCELED: '任务已取消', CANCELLED: '任务已取消',
  })[status] || '正在处理';
}

function generationFailureMessage(generation) {
  const code = String(generation?.errorCode || '').toUpperCase();
  const raw = String(generation?.error || generation?.message || '').trim();
  if (code === 'PROVIDER_BALANCE_INSUFFICIENT' || /insufficient account balance/i.test(raw)) {
    return '云端视频生成服务余额不足，任务未创建。请联系管理员充值服务商账户后重试。';
  }
  if (code === 'PROVIDER_AUTH_FAILED' || /unauthori[sz]ed|invalid.*token|token.*invalid/i.test(raw)) {
    return '云端视频生成服务鉴权失败，任务未创建。请联系管理员检查接口 Token。';
  }
  if (code === 'PROVIDER_RATE_LIMITED' || /rate limit|too many requests/i.test(raw)) {
    return '云端视频生成服务当前请求过多，任务未创建。请稍后再试。';
  }
  if (raw) return raw;
  return generation?.failureStage === 'submission'
    ? '生成任务未能提交到云端，请稍后重试；若持续失败，请联系管理员。'
    : '云端任务已终止，但接口没有返回具体原因。请调整描述后重试。';
}

function renderGenerationPreview(generation) {
  if (!generationPreview || !generation) return;
  const status = String(generation.status || 'QUEUED').toUpperCase();
  const active = ACTIVE_GENERATION_STATES.has(status);
  const failed = ['FAILED', 'ERROR', 'CANCELED', 'CANCELLED'].includes(status);
  const canceled = ['CANCELED', 'CANCELLED'].includes(status);
  const rawProgress = generation.estimatedProgress;
  const hasProgress = rawProgress !== null && rawProgress !== undefined && Number.isFinite(Number(rawProgress));
  const progress = status === 'SUCCESS' ? 100 : hasProgress ? Math.max(0, Math.min(99, Number(rawProgress))) : 0;
  const progressLabel = failed ? (canceled ? '已取消' : '失败') : `${Math.round(progress)}%`;
  const resultUrl = status === 'SUCCESS' ? firstResultUrl(generation.results) : null;
  const createdAt = Date.parse(generation.createdAt || '') || Date.now();
  const elapsed = generation.duration ?? Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  const resolution = generation.parameters?.resolution || '—';
  const duration = generation.parameters?.duration ? `${generation.parameters.duration} 秒` : '';

  generationPreview.hidden = false;
  generationPreview.classList.toggle('is-complete', status === 'SUCCESS');
  generationPreview.classList.toggle('is-failed', failed);
  if (generationProgressBar) generationProgressBar.style.width = `${progress}%`;
  if (generationProgressPercent) generationProgressPercent.textContent = progressLabel;
  if (generationProgressTrack) {
    generationProgressTrack.setAttribute('aria-valuenow', String(Math.round(progress)));
    generationProgressTrack.setAttribute('aria-valuetext', progressLabel);
  }
  const stageTitle = failed && generation.failureStage === 'submission' ? '任务提交失败' : generationStatusText(status);
  if (generationProgressTitle) generationProgressTitle.textContent = stageTitle;
  if (generationProgressSpec) generationProgressSpec.textContent = [resolution, duration].filter(Boolean).join(' · ');
  if (generationElapsed) generationElapsed.textContent = `已耗时 ${Math.max(0, Math.round(Number(elapsed) || 0))} 秒`;
  if (generationStageLabel) generationStageLabel.textContent = stageTitle;
  if (generationStageDetail) {
    generationStageDetail.textContent = failed
      ? generationFailureMessage(generation)
      : status === 'SUCCESS'
        ? (resultUrl ? '生成结果已就绪，可以直接播放与全屏预览。' : '任务已完成，但接口没有返回可播放的视频地址。')
        : status === 'QUEUED' ? '任务已进入队列，请保持页面打开。' : 'AI 正在构建画面与运动效果，请耐心等待。';
  }
  if (generationProgressNote) {
    generationProgressNote.textContent = failed
      ? (generation.failureStage === 'submission'
          ? '失败发生在提交阶段，云端任务未创建，因此不显示虚假的 100% 进度。'
          : '云端任务已终止；失败状态不代表生成进度达到 100%。')
      : status === 'SUCCESS'
        ? '云端任务已完成，并已返回生成结果。'
        : '当前接口不返回精确百分比，进度为根据任务状态与已耗时计算的预计值。';
  }
  if (resultUrl && generationVideo) {
    if (generationVideo.src !== resultUrl) generationVideo.src = resultUrl;
    generationVideo.hidden = false;
    if (generationPreviewEmpty) generationPreviewEmpty.hidden = true;
  } else {
    if (generationVideo) {
      generationVideo.hidden = true;
      if (status !== 'SUCCESS') generationVideo.removeAttribute('src');
    }
    if (generationPreviewEmpty) generationPreviewEmpty.hidden = false;
  }
  if (generationPreviewStage) generationPreviewStage.dataset.status = status.toLowerCase();
  const statusLine = document.getElementById('generationStatus');
  if (statusLine) statusLine.textContent = active
    ? `${generationStatusText(status)} · 当前仅支持一个生成任务`
    : generationStatusText(status);
}

async function monitorGeneration(initial) {
  const token = ++generationMonitorToken;
  let generation = initial;
  setGenerationLocked(ACTIVE_GENERATION_STATES.has(String(generation.status || '').toUpperCase()));
  renderGenerationPreview(generation);
  while (token === generationMonitorToken && ACTIVE_GENERATION_STATES.has(String(generation.status || '').toUpperCase())) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (token !== generationMonitorToken) return;
    try {
      generation = await jsonApi(`/api/video-generations/${encodeURIComponent(generation.taskId)}`, { timeoutMs: 35_000 });
      renderGenerationPreview(generation);
    } catch (err) {
      if (generationStageDetail) generationStageDetail.textContent = `暂时无法更新进度，正在自动重试：${err.message}`;
      continue;
    }
  }
  if (token !== generationMonitorToken) return;
  setGenerationLocked(false);
  if (String(generation.status).toUpperCase() === 'SUCCESS') toast('视频生成完成');
  else toast(generationStatusText(String(generation.status).toUpperCase()));
}

async function restoreHomeGeneration() {
  const data = await jsonApi('/api/video-generations/current', { timeoutMs: 35_000 });
  if (!data.generation) return;
  if (ACTIVE_GENERATION_STATES.has(String(data.generation.status || '').toUpperCase())) {
    monitorGeneration(data.generation);
  } else {
    renderGenerationPreview(data.generation);
    setGenerationLocked(false);
  }
}

async function uploadVideoReference(item, index, total) {
  if (generationStageLabel) generationStageLabel.textContent = '正在上传参考素材';
  if (generationStageDetail) generationStageDetail.textContent = `正在上传第 ${index + 1} / ${total} 个文件：${item.file.name}`;
  if (generationProgressTitle) generationProgressTitle.textContent = '正在上传参考素材';
  const response = await fetch('/api/video-references', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': item.file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(item.file.name),
    },
    body: item.file,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) showLogin('会话已过期，请重新登录');
  if (!response.ok) throw Object.assign(new Error(data.error || `参考素材上传失败（HTTP ${response.status}）`), { status: response.status, data });
  return data.reference;
}

async function runHomeCommand() {
  if (generationBusy) {
    toast('当前视频仍在生成，完成后才能创建下一个任务');
    return;
  }
  const command = String(homeCmd?.value || '').trim();
  if (!command) {
    toast('先描述一下想生成的视频');
    homeCmd?.focus();
    return;
  }
  const mode = currentGenerationMode();
  if (mode === 'text' && referenceFiles.length) {
    toast('文生视频不需要参考图片，请移除图片后再提交');
    return;
  }
  if (mode === 'multi_image' && (referenceFiles.length < 1 || referenceFiles.length > 9)) {
    toast('多图生视频需要添加 1–9 张参考图片');
    return;
  }
  if (mode === 'keyframes' && referenceFiles.length !== 2) {
    toast('首尾帧生视频需要正好 2 张图片：第一张为首帧，第二张为尾帧');
    return;
  }
  const status = document.getElementById('generationStatus');
  const ratio = document.getElementById('videoRatio')?.value || '9:16';
  const resolution = document.getElementById('videoResolution')?.value || '768p';
  const duration = Number(document.getElementById('videoDuration')?.value || 5);
  const resolutionOption = ratio === '1:1'
    ? `${resolution.toLowerCase()}(1:1)`
    : `${resolution.toLowerCase()}${ratio === '9:16' ? '竖' : '横'}`;
  const workflow = state.config?.videoGeneration?.workflows?.[mode]
    || (mode === 'text'
      ? document.getElementById('videoWorkflow')?.value
      : mode === 'keyframes' ? state.config?.videoGeneration?.keyframeWorkflow : state.config?.videoGeneration?.imageWorkflow);
  if (!workflow) {
    toast('当前生成方式尚未配置工作流，请联系管理员');
    return;
  }
  const submitting = {
    status: 'SUBMITTING',
    createdAt: new Date().toISOString(),
    estimatedProgress: 4,
    parameters: { duration, resolution: resolutionOption },
    mode,
    results: [],
  };
  setGenerationLocked(true);
  renderGenerationPreview(submitting);
  if (status) status.textContent = '正在提交生成任务…';
  try {
    const uploadedReferences = [];
    for (let index = 0; index < referenceFiles.length; index += 1) {
      uploadedReferences.push(await uploadVideoReference(referenceFiles[index], index, referenceFiles.length));
      const uploadProgress = 4 + Math.round(((index + 1) / referenceFiles.length) * 8);
      if (generationProgressBar) generationProgressBar.style.width = `${uploadProgress}%`;
      if (generationProgressPercent) generationProgressPercent.textContent = `${uploadProgress}%`;
    }
    if (status) status.textContent = referenceFiles.length ? '参考素材上传完成，正在提交生成任务…' : '正在提交生成任务…';
    const created = await jsonApi('/api/video-generations', {
      method: 'POST',
      body: JSON.stringify({
        prompt: command,
        mode,
        workflow,
        parameters: { duration, resolution: resolutionOption },
        referenceIds: uploadedReferences.map((reference) => reference.id),
      }),
      timeoutMs: 35_000,
    });
    toast('视频任务已提交，正在云端生成');
    monitorGeneration(created);
  } catch (err) {
    if (err.status === 409 && err.data?.generation) {
      monitorGeneration(err.data.generation);
      toast('已有视频正在生成，已恢复当前任务');
      return;
    }
    if (status) status.textContent = `提交失败：${err.message}`;
    renderGenerationPreview({
      ...submitting,
      status: 'FAILED',
      estimatedProgress: null,
      failureStage: err.data?.stage || 'submission',
      errorCode: err.data?.errorCode || '',
      error: err.message,
    });
    toast(`视频生成失败：${err.message}`);
    setGenerationLocked(false);
  }
}
if (homeGo) homeGo.addEventListener('click', runHomeCommand);
if (homeCmd) {
  const promptCount = document.getElementById('promptCount');
  homeCmd.addEventListener('input', () => { if (promptCount) promptCount.textContent = String(homeCmd.value.length); });
  homeCmd.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runHomeCommand();
  });
}

const referenceUpload = document.getElementById('referenceUpload');
document.querySelectorAll('[data-gen-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-gen-mode]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    if (referenceUpload) referenceUpload.hidden = button.dataset.genMode !== 'image';
  });
});

function syncPreviewSpec() {
  const ratio = document.getElementById('videoRatio')?.value || '9:16';
  const duration = document.getElementById('videoDuration')?.value || '5';
  const resolution = document.getElementById('videoResolution')?.value || '768p';
  const spec = document.getElementById('previewSpec');
  if (spec) spec.textContent = `${ratio} · ${duration} 秒 · ${resolution.toUpperCase()}`;
}
['videoRatio', 'videoDuration', 'videoResolution'].forEach((id) => document.getElementById(id)?.addEventListener('change', syncPreviewSpec));

/* ============================================================================
 * 任务中心
 * ========================================================================== */
let taskFilter = 'all';
let taskListData = [];
let taskPollTimer = null;

const TASK_FILTERS = [
  ['all', '全部'], ['idle', '待开始'], ['active', '进行中'], ['done', '已完成'], ['failed', '失败'],
];
function taskBucket(t) {
  if (t.status === 'succeeded') return 'done';
  if (['failed', 'canceled', 'expired'].includes(t.status)) return 'failed';
  if (t.status === 'pending' && !t.started) return 'idle';
  return 'active';
}
function taskStatusText(t) {
  if (t.status === 'succeeded') return '已完成';
  if (t.status === 'failed') return '失败';
  if (t.status === 'canceled') return '已取消';
  if (t.status === 'expired') return '已过期';
  if (t.status === 'processing') return `处理中 ${t.progress || 0}%`;
  return t.started ? '排队中' : '待开始';
}

async function loadTasks() {
  if (!el.taskList) return;
  try {
    const data = await jsonApi('/api/tasks');
    taskListData = data.tasks || [];
  } catch (err) {
    taskListData = [];
    toast(`任务加载失败：${err.message}`);
  }
  renderTaskFilters();
  renderTasks();
  // 有进行中的任务时每 3 秒刷新
  clearInterval(taskPollTimer);
  if (taskListData.some((t) => taskBucket(t) === 'active')) {
    taskPollTimer = setInterval(async () => {
      if (currentPage !== 'tasks') { clearInterval(taskPollTimer); return; }
      try {
        const data = await jsonApi('/api/tasks');
        taskListData = data.tasks || [];
        renderTasks();
        if (!taskListData.some((t) => taskBucket(t) === 'active')) clearInterval(taskPollTimer);
      } catch { /* 忽略 */ }
    }, 3000);
  }
}

function renderTaskFilters() {
  if (!el.taskFilters) return;
  el.taskFilters.innerHTML = TASK_FILTERS.map(([k, label]) => {
    const n = k === 'all' ? taskListData.length : taskListData.filter((t) => taskBucket(t) === k).length;
    return `<button class="cchip ${taskFilter === k ? 'on' : ''}" type="button" data-tkind="${k}">${label} <span class="cnt">${n}</span></button>`;
  }).join('');
}

function renderTasks() {
  if (!el.taskList) return;
  const list = taskListData.filter((t) => taskFilter === 'all' || taskBucket(t) === taskFilter);
  if (el.taskTotal) el.taskTotal.textContent = `共 ${list.length} 项`;
  el.taskEmpty.hidden = list.length > 0;
  el.taskList.innerHTML = '';
  const ICON = { 'erase-subtitle': '字', enhance: '超', 'asr-subtitles': '文', transcode: '压', 'ocr-extract': '稿', 'face-blur': '码', 'portrait-matte': '抠', 'region-blur': '遮' };
  for (const t of list) {
    const row = document.createElement('div');
    row.className = 'row';
    const when = t.finishedAt || t.createdAt;
    const meta = [t.operationLabel, t.durationSec ? `${Math.round(t.durationSec)} 秒` : '', t.chargedCredits ? `已扣 ${t.chargedCredits} 积分` : '',
      when ? new Date(when).toLocaleString('zh-CN', { hour12: false }) : ''].filter(Boolean).join(' · ');
    row.innerHTML = `
      <div class="task-ico">${ICON[t.operation] || '▶'}</div>
      <div class="task-main">
        <div class="task-name">${escapeHtml(t.result?.name || t.fileName || t.id)}</div>
        <div class="task-meta">${escapeHtml(meta)}${t.error ? ` · ${escapeHtml(t.error.slice(0, 60))}` : ''}</div>
        ${taskBucket(t) === 'active' ? `<div class="task-prog"><i style="width:${t.progress || 0}%"></i></div>` : ''}
      </div>
      <span class="pill ${t.status === 'succeeded' ? 'ok' : ['failed', 'expired'].includes(t.status) ? 'bad' : taskBucket(t) === 'active' ? 'run' : ''}">${taskStatusText(t)}</span>
      <div class="task-act"></div>`;
    const acts = row.querySelector('.task-act');
    if (t.downloadUrl) {
      const a = document.createElement('a');
      a.className = 'btn btn-ghost'; a.href = t.downloadUrl; a.textContent = '下载'; a.download = '';
      acts.appendChild(a);
    }
    if (t.status === 'failed' || t.status === 'canceled' || taskBucket(t) === 'idle') {
      const retry = document.createElement('button');
      retry.className = 'btn btn-primary'; retry.type = 'button'; retry.textContent = taskBucket(t) === 'idle' ? '开始' : '重试';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try { await jsonApi(`/api/tasks/${t.id}/start`, { method: 'POST', body: '{}' }); toast('已重新排队'); loadTasks(); }
        catch (err) { toast(`重试失败：${err.message}`); retry.disabled = false; }
      });
      acts.appendChild(retry);
    }
    if (taskBucket(t) === 'active') {
      const cancel = document.createElement('button');
      cancel.className = 'btn btn-ghost btn-stop'; cancel.type = 'button'; cancel.textContent = '取消';
      cancel.addEventListener('click', async () => {
        try { await jsonApi(`/api/tasks/${t.id}`, { method: 'DELETE' }); toast('已取消并退款'); loadTasks(); }
        catch (err) { toast(`取消失败：${err.message}`); }
      });
      acts.appendChild(cancel);
    }
    el.taskList.appendChild(row);
  }
}

if (el.taskFilters) {
  el.taskFilters.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tkind]');
    if (!b) return;
    taskFilter = b.dataset.tkind;
    renderTaskFilters(); renderTasks();
  });
}

/* ============================================================================
 * 工具页右列：批次未建立时显示「使用指引 + 最近资产」（避免右侧大片空白）
 * ========================================================================== */
function syncToolsAside() {
  const aside = document.getElementById('toolsAside');
  if (!aside) return;
  const batchCard = document.getElementById('batchCard');
  const hasBatch = batchCard && !batchCard.hidden;
  aside.hidden = hasBatch || currentPage !== 'tools' || state.tab === 'link';
  if (aside.hidden) return;
  const box = document.getElementById('toolsRecent');
  if (!box) return;
  const list = (assetList || []).slice(0, 3);
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="muted" style="font-size:12px">还没有素材，上传后会出现在这里</div>';
    return;
  }
  const ICON = { video: '▶', text: 'T', audio: '♫', image: '▣' };
  for (const a of list) {
    const row = document.createElement('div');
    row.className = 'aside-row';
    row.innerHTML = `<div class="ico">${ICON[a.kind] || '▶'}</div>
      <div style="min-width:0">
        <div class="nm">${escapeHtml(a.name || '')}</div>
        <div class="mt">${a.source === 'upload' ? '上传' : '处理'}${a.sizeText ? ' · ' + a.sizeText : ''}</div>
      </div>`;
    row.addEventListener('click', () => switchPage('assets'));
    box.appendChild(row);
  }
}

