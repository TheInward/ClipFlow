#!/usr/bin/env node
/**
 * ClipFlow 服务端（零依赖，仅 Node.js 内置模块）
 * 一站式 AI 视频创作平台：视频生成、智能处理、资产预览与下载
 *
 * 职责：
 *   1. 手机号/密码登录（HttpOnly 会话 Cookie，持续操作续期，闲置 1 小时失效）
 *   2. 接收视频上传（流式落盘、大小限制、MD5/SHA-256 校验、MD5 秒传去重）
 *   3. 为每个文件生成唯一 ID（/f/<id>）与 MD5 寻址（/f/<md5>）
 *   4. 去字幕接口 POST /api/files/:id/process -> 返回 taskId；GET /api/tasks/:taskId 轮询
 *   5. 源文件与产物都可预览，产物可下载 GET /api/download/:taskId
 *   6. 源文件 12 小时后过期：删除文件 + 移除 MD5 索引 + 清理派生产物
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { enhanceVideo, runAsr, toSrt, runTranscode, runOcr, runToolVideo } from './pipeline.mjs';
import { ZipStream, streamRemote } from './zip.mjs';
import { probeVideoDuration, probeAvailable, probeVideoSize } from './media.mjs';
import { normalizePhone, findUserByPhone, createUser, checkPassword, publicUser, createUserSession, chargeSeconds, refundSeconds, createCodes, redeemCode, ensureAdmin, setPassword, touchSession, SESSION_TTL_MS } from './accounts.mjs';
import { take as takeToken, stats as rateStats } from './ratelimit.mjs';
import { fileURLToPath } from 'node:url';
import {
  OPERATIONS,
  DEFAULT_OPERATION,
  STAGES,
  runPipeline,
  cancelRemoteTask,
  eraseApiConfig,
  writePoster,
  formatBytes,
} from './pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 本地开发读取 Git 忽略的密钥文件；线上 systemd 仍通过 EnvironmentFile 注入。
// 已存在的进程环境变量优先，避免文件覆盖部署配置。
function loadLocalEnv() {
  const file = path.join(__dirname, 'clipflow.env');
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}
loadLocalEnv();

/**
 * 构建号：部署时由 install.sh 写入 BUILD 文件（精确到分钟），例如 build202610141950。
 * 优先环境变量 BUILD_ID，其次 BUILD 文件，本地开发没有该文件时退回本次启动时间。
 */
function resolveBuildId() {
  const stamp = (d) => `build${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  if (process.env.BUILD_ID) return String(process.env.BUILD_ID).trim();
  try {
    const fromFile = fs.readFileSync(path.join(__dirname, 'BUILD'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* 本地开发没有 BUILD 文件，属正常 */ }
  return stamp(new Date());
}
const BUILD_ID = resolveBuildId();
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
const REFERENCE_DIR = path.join(DATA_DIR, 'references');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 ** 2); // 单文件上限 100MB
const REFERENCE_MAX_UPLOAD_BYTES = Number(process.env.REFERENCE_MAX_UPLOAD_BYTES || 100 * 1024 ** 2);
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const AUTODL_API_BASE = String(process.env.AUTODL_API_BASE || 'https://autodl.art/api/v1/comfyui').replace(/\/+$/, '');
const AUTODL_API_TOKEN = String(process.env.AUTODL_API_TOKEN || '').trim();
const AUTODL_VIDEO_WORKFLOW = String(process.env.AUTODL_VIDEO_WORKFLOW || 'minimax_h3_lightx2v_no_pic').trim();
const AUTODL_IMAGE_VIDEO_WORKFLOW = String(process.env.AUTODL_IMAGE_VIDEO_WORKFLOW || 'minimax_h3_lightx2v_v5_15s').trim();
const AUTODL_KEYFRAME_VIDEO_WORKFLOW = String(process.env.AUTODL_KEYFRAME_VIDEO_WORKFLOW || 'minimax_h3_lightx2v').trim();
const AUTODL_READY = Boolean(AUTODL_API_TOKEN && AUTODL_VIDEO_WORKFLOW && AUTODL_IMAGE_VIDEO_WORKFLOW && AUTODL_KEYFRAME_VIDEO_WORKFLOW);
const AUTODL_VIDEO_RESOLUTIONS = new Set([
  '480p竖', '768p竖',
]);
const AUTODL_VIDEO_DURATIONS = new Set([5, 10, 15]);
const VIDEO_GENERATION_MODES = new Set(['text', 'multi_image', 'keyframes']);
const REFERENCE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.m4v', '.webm', '.mp3', '.wav', '.m4a', '.flac']);
const IMAGE_REFERENCE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
/**
 * 批量任务编排：把"跑一个任务"拆成两段，各用各的名额
 *   · 提交段（探测源文件 + 调接口提交）：很轻，可以同时提交很多 → SUBMIT_CONCURRENCY
 *   · 回传段（下载产物到本地）：很重（动辄上百 MB）→ FETCH_CONCURRENCY
 *   · 轮询段不占名额，只是一次很小的 GET
 * MAX_ACTIVE_TASKS 是"同时在场"的任务状态机数量（要有 10 个任务同时在跑就得 ≥10）。
 */
/**
 * 擦除区域（对应接口的 erase_ratio_location，相对比例 0~1 的对象数组）
 * 实测接口要求：数组元素必须是对象，字段为 top_left_x / top_left_y / bottom_right_x / bottom_right_y。
 * 「字幕在画面上半部」这类视频，默认区域往往会漏，选"全屏"或"上半部"就能覆盖到。
 */
const ERASE_REGIONS = {
  auto: null,     // 不传，交给接口自己判断（默认）
  full: [{ top_left_x: 0, top_left_y: 0, bottom_right_x: 1, bottom_right_y: 1 }],
  top: [{ top_left_x: 0, top_left_y: 0, bottom_right_x: 1, bottom_right_y: 0.5 }],
  middle: [{ top_left_x: 0, top_left_y: 0.25, bottom_right_x: 1, bottom_right_y: 0.75 }],
  bottom: [{ top_left_x: 0, top_left_y: 0.5, bottom_right_x: 1, bottom_right_y: 1 }],
};
/**
 * 两种处理模式（预设）——接口层直接支持 preset，也仍兼容细粒度参数
 *   standard   标准模式（默认）  ：只认常规字幕，快
 *   fullscreen 全屏模式（更彻底）：擦画面任何位置的文字与文字水印，耗时约 3 倍
 */
const ERASE_PRESETS = {
  standard: { mode: 'Subtitle', region: null, model: null },
  fullscreen: {
    mode: 'Text',
    region: [{ top_left_x: 0, top_left_y: 0, bottom_right_x: 1, bottom_right_y: 1 }],
    model: 'v5.6',
  },
};
const ERASE_PRESET_KEYS = Object.keys(ERASE_PRESETS);
function resolveErasePreset(input) {
  const k = String(input || '').trim();
  return ERASE_PRESET_KEYS.includes(k) ? k : 'standard';
}
/** 把「预设 + 可选覆盖项」解析成真正要下发的三个参数 */
function applyErasePreset({ preset, region, mode, model } = {}) {
  const p = ERASE_PRESETS[resolveErasePreset(preset)];
  return {
    preset: resolveErasePreset(preset),
    mode: mode === undefined || mode === null ? p.mode : resolveEraseMode(mode),
    region: region === undefined ? p.region : resolveEraseRegion(region),
    model: model === undefined ? p.model : resolveModelVersion(model),
  };
}

/** 模型版本：v4（默认，快）/ v5 / v5.6（最新，效果最好） */
const MODEL_VERSIONS = ['v4', 'v5', 'v5.6'];
function resolveModelVersion(input) {
  const v = String(input || '').trim();
  return MODEL_VERSIONS.includes(v) ? v : null;
}

/** 擦除模式：Subtitle=只认常规字幕（快）；Text=擦画面里所有文字含 logo 水印（慢但彻底） */
const ERASE_MODES = ['Subtitle', 'Text'];
function resolveEraseMode(input) {
  return ERASE_MODES.includes(String(input || '').trim()) ? String(input).trim() : 'Subtitle';
}

/** 把前端的区域选项（或自定义数组）解析成接口参数；auto/非法一律 null */
function resolveEraseRegion(input) {
  if (Array.isArray(input)) {
    const ok = input.every((r) => r && ['top_left_x', 'top_left_y', 'bottom_right_x', 'bottom_right_y']
      .every((k) => typeof r[k] === 'number' && r[k] >= 0 && r[k] <= 1));
    return ok && input.length ? input : null;
  }
  const key = String(input || 'auto').trim();
  return Object.prototype.hasOwnProperty.call(ERASE_REGIONS, key) ? ERASE_REGIONS[key] : null;
}

/** 客户端同时上传几个文件（前端上传队列的并发度） */
const UPLOAD_CONCURRENCY = Math.max(1, Number(process.env.UPLOAD_CONCURRENCY || 3));
/** 一批最多多少个文件 */
const MAX_BATCH_SIZE = Math.max(1, Number(process.env.MAX_BATCH_SIZE || 30));
/** 产物约占源文件的倍数（实测 1.3~1.5），用于开始前的磁盘预判 */
const DISK_OUTPUT_FACTOR = Number(process.env.DISK_OUTPUT_FACTOR || 1.5);
/** 磁盘保护线：剩余空间低于这个值就**暂停接收新任务**（上传/建批次/开始任务全部拒绝） */
const DISK_MIN_FREE_BYTES = Math.max(0, Number(process.env.DISK_MIN_FREE_BYTES || 5 * 1024 ** 3));
/** 预留磁盘余量：低于这个值就拒绝新批次 */
const DISK_RESERVE_BYTES = Number(process.env.DISK_RESERVE_BYTES || 1024 ** 3);
const MAX_ACTIVE_TASKS = Math.max(1, Number(process.env.MAX_ACTIVE_TASKS || process.env.PROCESS_CONCURRENCY || 30));
const SUBMIT_CONCURRENCY = Math.max(1, Number(process.env.SUBMIT_CONCURRENCY || 10));
const FETCH_CONCURRENCY = Math.max(1, Number(process.env.FETCH_CONCURRENCY || 2));

/** 极简并发池：限制同时执行的数量，其余排队（Promise 版信号量） */
function createPool(limit, name) {
  let active = 0;
  const waiters = [];
  const kick = () => {
    while (active < limit && waiters.length) {
      active += 1;
      const go = waiters.shift();
      go();
    }
  };
  return {
    name,
    get active() { return active; },
    get waiting() { return waiters.length; },
    run(fn) {
      return new Promise((resolve, reject) => {
        waiters.push(() => {
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => { active -= 1; kick(); });
        });
        kick();
      });
    },
  };
}
const submitPool = createPool(SUBMIT_CONCURRENCY, 'submit');
const fetchPool = createPool(FETCH_CONCURRENCY, 'fetch');
/** 云端"取消"尝试的并发池：官方没有取消接口、尝试必然失败，但仍要有上限，
 *  否则批量取消时堆一堆卡住的 socket（曾把浏览器 6 个连接占满 → 页面像卡死、连刷新都排队） */
const cancelPool = createPool(4, 'cancel');
/**
 * 去字幕接口不返回进度，用「原片时长 × RTF」预估总耗时来驱动进度条与剩余时间。
 * 官方给的 RTF（处理耗时/原片时长）区间很宽（5~30 倍），所以这里按历史任务自动学习：
 * 每完成一个任务就记录实测 RTF，之后取最近若干次的均值，越用越准。
 */
const DEFAULT_RTF = Math.max(1, Number(process.env.AMK_RTF_ESTIMATE || 15));
const RTF_WINDOW = 10;
/** 任务记录保留天数：过期任务只留审计用的一小段时间，避免 db.json 无限增长 */
const TASK_KEEP_DAYS = Math.max(1, Number(process.env.TASK_KEEP_DAYS || 7));
/** 只接受合理范围内的实测样本：过小（本地桩/秒回）会让预估失真，过大则明显异常 */
const RTF_MIN = 0.5;
const RTF_MAX = 60;
/** 预估总耗时下限（秒）：避免预估过短导致进度条早早冲到 93% 后长时间不动 */
const MIN_ESTIMATE_SEC = 60;
const rtfSamples = () => (Array.isArray(db.stats?.rtfSamples) ? db.stats.rtfSamples : []);
/**
 * 当前采用的 RTF：有历史样本时取**中位数**（而不是均值）。
 * 均值容易被个别异常样本带偏 —— 比如任务被重启打断、实际耗时被拉长，
 * 会把之后所有任务的预估都抬高；中位数对这种污染不敏感。
 */
function median(list) {
  const arr = [...list].sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}
/** 某个模式自己的 RTF 样本（标准模式与全屏模式速度差约 3 倍，必须分开学） */
function modeSamples(mode) {
  const list = db.stats?.byMode?.[mode];
  return Array.isArray(list) ? list : [];
}
/** 当前采用的 RTF：优先用同模式样本的中位数；没有就退回整体中位数 */
function currentRtf(mode) {
  const own = modeSamples(mode);
  if (own.length) return median(own);
  const list = [...rtfSamples()].sort((a, b) => a - b);
  if (!list.length) return DEFAULT_RTF;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}
/** 任务完成后记录实测 RTF，供后续任务预估使用 */
function recordRtf(task) {
  // 被重启打断过的任务，墙钟耗时里含重启空档（可能几十分钟），作为样本会把预估带偏
  if (task.wasResumed) {
    console.log('[erase] 该任务经历过服务重启，耗时含空档，不纳入 RTF 预估样本');
    return;
  }
  const real = (Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000;
  if (!(task.durationSec > 0) || !(real > 0)) return;
  const sample = real / task.durationSec;
  if (sample < RTF_MIN || sample > RTF_MAX) {
    console.log(`[erase] 实测 RTF=${sample.toFixed(2)} 超出合理范围（${RTF_MIN}~${RTF_MAX}），不纳入预估样本`);
    return;
  }
  db.stats = db.stats || {};
  db.stats.rtfSamples = [...rtfSamples(), +sample.toFixed(2)].slice(-RTF_WINDOW);
  db.stats.byMode ||= {};
  const key = task.mode === 'Text' ? 'Text' : 'Subtitle';
  db.stats.byMode[key] = [...modeSamples(key), +sample.toFixed(2)].slice(-RTF_WINDOW);
  db.stats.avgRtf = +currentRtf(key).toFixed(2);
  console.log(`[erase] 本次实测 RTF=${sample.toFixed(1)}（${key} 模式，原片 ${task.durationSec}s / 实际 ${Math.round(real)}s），后续该模式预估采用中位数 ${db.stats.avgRtf}`);
}

/** 源文件与产物的存活时间：默认 12 小时（支持小数，便于测试） */
const UPLOAD_TTL_MS = Math.max(0, Number(process.env.UPLOAD_TTL_HOURS ?? 12)) * 3600 * 1000;
/**
 * 是否在服务器保存处理产物。
 * 默认 false：产物只留云端（约 32 小时），预览/下载由浏览器直连云端 —— 不占服务器磁盘与带宽。
 * 想恢复"存本地副本"：环境变量 KEEP_ARTIFACT=true。
 */
const KEEP_ARTIFACT = process.env.KEEP_ARTIFACT === 'true';
/** 过期时长（小时）的中文表述，用于提示文案 */
const ttlHours = () => { const h = UPLOAD_TTL_MS / 3600000; return Number.isInteger(h) ? String(h) : h.toFixed(1); };
const SWEEP_INTERVAL_MS = Math.max(500, Number(process.env.SWEEP_INTERVAL_MS || 5 * 60 * 1000));
const SESSION_COOKIE = 'clp_sid';
const LOGIN_MAX_FAILS = Math.max(3, Number(process.env.LOGIN_MAX_FAILS || 10));
const LOGIN_WINDOW_MS = Math.max(1000, Number(process.env.LOGIN_WINDOW_MS || 10 * 60 * 1000));

// AI MediaKit 去字幕/超清官方支持：mp4 / flv / ts / avi / mov / wmv / mkv（其余格式一律拒收）
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.flv', '.ts', '.wmv']);
// 超清（enhance-video）支持的目标分辨率档位
const ENHANCE_RESOLUTIONS = ['720p', '1080p', '2k', '4k'];
// 超清版本：标准版（快）/ 专业版（更清晰、更慢、计费更高）
const ENHANCE_VERSIONS = ['standard', 'professional'];
// 语音转字幕：语种（空 = 自动探测）+ 是否烧录成视频
const ASR_LANGUAGES = ['auto', 'cmn-Hans-CN', 'eng-US'];
// 压缩转码预设
const TRANSCODE_PROFILES = ['1080p', '720p', 'hevc'];
// 更多工具：画面字幕 OCR / 人脸打码 / 人像抠图
const OCR_MODES = ['Subtitle', 'Detailed'];
const FACE_MASK_MODES = ['mosaic', 'blur'];
const FACE_STRENGTHS = ['low', 'medium', 'high'];
const MATTE_BACKGROUNDS = ['green', 'black', 'white'];
// 区域遮挡/消物：固定区域的三种处理方式
const REGION_MODES = ['delogo', 'box', 'blur'];
const operationNeedsCloud = (operation) => operation !== 'region-blur';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};

// ---------------------------------------------------------------- 存储层
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(REFERENCE_DIR, { recursive: true });
fs.mkdirSync(ASSET_DIR, { recursive: true });

// Cloud providers need short-lived anonymous access to source media. Keep the
// capability signing key in the private data directory across restarts.
const CAPABILITY_KEY_FILE = path.join(DATA_DIR, 'capability.key');
let CAPABILITY_KEY;
try { CAPABILITY_KEY = fs.readFileSync(CAPABILITY_KEY_FILE); }
catch {
  CAPABILITY_KEY = crypto.randomBytes(32);
  fs.writeFileSync(CAPABILITY_KEY_FILE, CAPABILITY_KEY, { mode: 0o600, flag: 'wx' });
}
try { fs.chmodSync(CAPABILITY_KEY_FILE, 0o600); } catch { /* Windows/local FS */ }

const db = { files: {}, tasks: {}, md5Index: {}, sessions: {} };
try {
  Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch {
  /* 首次启动 */
}
db.files ||= {};
db.tasks ||= {};
db.batches ||= {};
db.results ||= {};      // 用户 + 内容 + 处理参数 → 已完成产物
db.sessions ||= {};
db.users ||= {};
db.creditLedger ||= [];
db.redemptionCodes ||= {};
db.abuseEvents ||= [];
db.videoGenerations ||= {};
db.videoGenerationCurrent ||= {};
db.references ||= {};
db.assets ||= {};
db.assetTombstones ||= {};
// Asset references have independent lifetime; keep existing uploaded references available.
for (const reference of Object.values(db.references)) {
  reference.persistent = true;
  reference.expiresAt = null;
}
// MD5 → fileId 索引（去重的唯一依据，文件名即 MD5）；旧记录没有 md5 字段，顺手补建索引
// MD5 索引必须按账号隔离。物理 blob 仍可复用，但每个用户拥有独立的文件记录、
// 文件名、过期时间和删除权限，避免跨账号秒传泄漏元数据或互相删除源文件。
const fileIndexKey = (userId, md5) => `${userId || 'legacy'}:${md5}`;
db.md5Index = {};
for (const f of Object.values(db.files)) {
  if (f.md5) db.md5Index[fileIndexKey(f.userId, f.md5)] = f.id;
}

let saveTimer = null;
let saveWriting = false;   // 是否有写盘正在进行
let savePending = false;   // 写盘期间又发生了变更

/**
 * 落盘：**防抖 + 串行**。
 *  - 防抖：进度回调很密集，避免每次都整份重写
 *  - 串行：同一时刻只允许一个写在飞。之前并发写各自 rename，
 *    旧快照可能后落地把新数据覆盖掉（真的丢过数据），现在写完若期间有变更，
 *    再用**最新快照**补写一次。
 */
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDb, 80);
}

function flushDb() {
  if (saveWriting) { savePending = true; return; }
  saveWriting = true;
  const tmp = `${DB_FILE}.tmp`;
  let payload;
  try {
    payload = JSON.stringify(db, null, 2);
  } catch (err) {
    saveWriting = false;
    return console.error('[db] 序列化失败', err.message);
  }
  fs.writeFile(tmp, payload, (err) => {
    if (err) {
      saveWriting = false;
      console.error('[db] 写入失败', err.message);
      if (savePending) { savePending = false; flushDb(); }
      return;
    }
    fs.rename(tmp, DB_FILE, (e) => {
      saveWriting = false;
      if (e) console.error('[db] 落盘失败', e.message);
      if (savePending) { savePending = false; flushDb(); }
    });
  });
}
/** 同步落盘，退出前调用 */
function saveDbSync() {
  clearTimeout(saveTimer);
  savePending = false;
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('[db] 写入失败', err.message);
  }
}

// ---------------------------------------------------------------- 工具
const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

function lanIp() {
  const ifaces = os.networkInterfaces();
  const preferred = ['en0', 'en1', 'eth0', 'wlan0'];
  const flat = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) flat.push({ name, address: a.address });
    }
  }
  flat.sort((a, b) => preferred.indexOf(a.name) - preferred.indexOf(b.name));
  return flat[0]?.address || '127.0.0.1';
}

const LAN_IP = lanIp();
/** 内网（或公网）可达地址；设置 PUBLIC_BASE_URL 可接入域名 / 反向代理 */
const baseUrl = () => PUBLIC_BASE || `http://${LAN_IP}:${PORT}`;
const capabilityUrlFor = (pathname) => {
  const expires = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  const signature = crypto.createHmac('sha256', CAPABILITY_KEY).update(`${pathname}\n${expires}`).digest('base64url');
  return `${baseUrl()}${pathname}?expires=${expires}&signature=${signature}`;
};
function validCapabilityUrl(url) {
  const expires = Number(url.searchParams.get('expires'));
  const signature = url.searchParams.get('signature') || '';
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000) || expires > Math.floor(Date.now() / 1000) + 6 * 60 * 60 + 60) return false;
  const expected = crypto.createHmac('sha256', CAPABILITY_KEY).update(`${url.pathname}\n${expires}`).digest();
  let provided;
  try { provided = Buffer.from(signature, 'base64url'); } catch { return false; }
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}
const publicFileUrl = (fileId) => capabilityUrlFor(`/f/${fileId}`);
const publicReferenceUrl = (referenceId) => capabilityUrlFor(`/r/${referenceId}`);
const publicDownloadUrl = (taskId) => `${baseUrl()}/api/download/${taskId}`;
const publicPosterUrl = (taskId) => `${baseUrl()}/api/artifacts/${taskId}/poster.svg`;

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  if (res.isHead) return res.end(); // HEAD：只回头，不回 body
  res.end(buf);
}

const sendError = (res, status, message, extra = {}) => sendJson(res, status, { error: message, ...extra });

async function readJsonBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

function sanitizeName(raw) {
  const base = path.basename(String(raw || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').trim();
  return (base || 'video.mp4').slice(0, 160);
}

/* ================================================================ 登录鉴权 */

function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { /* Ignore malformed cookies; an invalid session is unauthenticated. */ }
  }
  return out;
}

const isSecureReq = (req) =>
  Boolean(req.socket?.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function setSessionCookie(req, res, sid, maxAgeSec) {
  const bits = [`${SESSION_COOKIE}=${encodeURIComponent(sid)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  bits.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  // 只有请求本身走 HTTPS 时才加 Secure：否则 http://IP:port 直连会因为浏览器丢弃 Cookie 而登录不上
  if (isSecureReq(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

function pruneSessions() {
  const now = Date.now();
  let n = 0;
  for (const [sid, s] of Object.entries(db.sessions)) {
    if (!s || s.expiresAt <= now) {
      delete db.sessions[sid];
      n += 1;
    }
  }
  if (n) saveDb();
  return n;
}

function currentSession(req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid) return null;
  const session = db.sessions[sid];
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    delete db.sessions[sid];
    saveDb();
    return null;
  }
  // 活跃即续期：接口被调用一次，有效期就推到「现在 + 1 小时」
  if (touchSession(db, sid)) saveDb();
  if (req.sessionResponse && !req.sessionResponse.headersSent) {
    setSessionCookie(req, req.sessionResponse, sid, (session.expiresAt - Date.now()) / 1000);
  }
  return { sid, ...session };
}

function refundTaskCredits(task, why = 'refund') {
  if (!task || !task.chargedCredits) return 0;
  const user = db.users[task.chargedUserId || task.userId];
  if (user) refundSeconds(db, user, task.chargedCredits, task.id, why);
  const amount = task.chargedCredits;
  task.chargedCredits = 0;
  console.log(`[credits] 退还 ${amount} 积分（${why}，task ${task.id}）`);
  return amount;
}

// 登录/注册验证码：内存保存，5 分钟过期；同一 IP 失败达 3 次后强制要求
const captchas = new Map();
function issueCaptcha() {
  const a = 2 + Math.floor(Math.random() * 8);
  const b = 2 + Math.floor(Math.random() * 8);
  const id = crypto.randomBytes(9).toString('base64url');
  captchas.set(id, { answer: a + b, exp: Date.now() + 5 * 60 * 1000 });
  if (captchas.size > 2000) for (const [k, v] of captchas) if (v.exp < Date.now()) captchas.delete(k);
  return { id, question: `${a} + ${b} = ?` };
}
function checkCaptcha(id, answer) {
  const c = captchas.get(String(id || ''));
  if (!c || c.exp < Date.now()) return false;
  captchas.delete(String(id));
  return Number(answer) === c.answer;
}

function currentUser(req) {
  const s = currentSession(req);
  return s?.userId ? db.users[s.userId] || null : null;
}

/** 登录失败限流：同一 IP 在窗口内失败过多直接 429，避免 Token 被暴力枚举 */
const loginFails = new Map();
function noteLoginFail(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip) || { count: 0, first: now };
  if (now - rec.first > LOGIN_WINDOW_MS) {
    rec.count = 0;
    rec.first = now;
  }
  rec.count += 1;
  loginFails.set(ip, rec);
  return rec;
}
function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginFails.delete(ip);
    return 0;
  }
  return rec.count >= LOGIN_MAX_FAILS ? Math.ceil((LOGIN_WINDOW_MS - (Date.now() - rec.first)) / 1000) : 0;
}

/* ================================================================ 过期清理
 * 上传的源文件到期后过期：删除磁盘文件、移除 MD5 索引，
 * 连带清理该文件派生的任务产物（避免留下无主数据）。
 * ================================================================= */
const fileExpiresAt = (f) => (f.expiresAt ? Date.parse(f.expiresAt) : Date.parse(f.createdAt) + UPLOAD_TTL_MS);
const isFileExpired = (f) => fileExpiresAt(f) <= Date.now();

let sweeping = false;
async function sweepExpired(trigger = 'timer') {
  if (sweeping) return { skipped: true };
  sweeping = true;
  const now = Date.now();
  const removed = [];
  const removedReferences = [];
  const cleanedTasks = [];
  try {
    for (const f of Object.values(db.files)) {
      if (!isFileExpired(f)) continue;
      delete db.files[f.id];
      const indexKey = fileIndexKey(f.userId, f.md5);
      if (db.md5Index[indexKey] === f.id) delete db.md5Index[indexKey];
      // 多个账号可能各自持有同一物理 blob；最后一个引用到期后才删磁盘文件。
      const blobStillUsed = Object.values(db.files).some((other) => other.storedPath === f.storedPath);
      if (!blobStillUsed) await fsp.rm(path.join(DATA_DIR, f.storedPath), { force: true });
      for (const t of Object.values(db.tasks)) {
        if (t.fileId !== f.id) continue;
        if (t.status === 'pending' || t.status === 'processing') cancelTask(t);
        if (t.status !== 'failed' && t.status !== 'canceled') t.status = 'expired';
        t.stage = '源文件已过期，内容已删除';
        t.stageKey = 'expired';
        t.expiredAt = new Date().toISOString();
        t.downloadUrl = null;
        delete t.result;
        await fsp.rm(path.join(OUTPUT_DIR, t.id), { recursive: true, force: true }); // 3) 删派生数据
        cleanedTasks.push(t.id);
      }
      removed.push({ id: f.id, md5: f.md5, name: f.name, size: f.size });
      console.log(`[ttl] 过期清理：${f.name} (${f.id}) 文件与 md5=${f.md5} 索引已删除`);
    }

    for (const reference of Object.values(db.references)) {
      if (reference.persistent) continue;
      if ((Date.parse(reference.expiresAt || 0) || 0) > now) continue;
      delete db.references[reference.id];
      await fsp.rm(path.join(DATA_DIR, reference.storedPath), { force: true });
      removedReferences.push(reference.id);
      console.log(`[ttl] 参考素材过期清理：${reference.name} (${reference.id})`);
    }

    // 孤儿临时文件（上传中断 / 进程被杀留下的 .incoming-*）
    let orphans = 0;
    try {
      for (const name of await fsp.readdir(UPLOAD_DIR)) {
        if (!name.startsWith('.incoming-')) continue;
        const abs = path.join(UPLOAD_DIR, name);
        const st = await fsp.stat(abs).catch(() => null);
        if (!st) continue;
        if (trigger === 'startup' || now - st.mtimeMs > 3600_000) {
          await fsp.rm(abs, { force: true });
          orphans += 1;
        }
      }
    } catch (err) {
      console.warn('[ttl] 清理临时文件失败:', err.message);
    }

    // 孤儿产物目录（对应任务已被删除）
    let orphanDirs = 0;
    try {
      for (const name of await fsp.readdir(OUTPUT_DIR)) {
        if (db.tasks[name]) continue;
        await fsp.rm(path.join(OUTPUT_DIR, name), { recursive: true, force: true });
        orphanDirs += 1;
      }
    } catch (err) {
      console.warn('[ttl] 清理产物目录失败:', err.message);
    }

    // 内容级产物索引：指向的任务已不存在 / 已不是成功状态 / 已过期 → 丢弃条目
      let prunedResults = 0;
      for (const md5 of Object.keys(db.results || {})) {
        const rec = db.results[md5];
        const t = db.tasks[rec.taskId];
        if (!t || t.status !== 'succeeded' || !t.result || Date.parse(rec.expiresAt || 0) <= now) {
          delete db.results[md5];
          prunedResults += 1;
        }
      }
      if (prunedResults) console.log(`[reuse] 清理 ${prunedResults} 条失效的产物索引`);

      // 历史任务记录：保留 TASK_KEEP_DAYS 天，避免 db.json 无限增长（每次进度更新都要整份重写）
    // 注意：这一步每轮都要跑，不能只在"删除了源文件"时才执行
    let prunedTasks = 0;
    const keepAfter = now - TASK_KEEP_DAYS * 86400_000;
    for (const [taskId, t] of Object.entries(db.tasks)) {
      if (t.status === 'processing' || t.status === 'pending') continue;
      const ended = Date.parse(t.finishedAt || t.createdAt || 0) || 0;
      if (ended && ended < keepAfter) {
        delete db.tasks[taskId];
        prunedTasks += 1;
      }
    }
    // 历史批次：任务都被清掉后，批次记录也没必要留着
    let prunedBatches = 0;
    for (const [bid, b] of Object.entries(db.batches || {})) {
      const created = Date.parse(b.createdAt || 0) || 0;
      const alive = (b.taskIds || []).some((tid) => db.tasks[tid]);
      if (!alive && created && created < keepAfter) { delete db.batches[bid]; prunedBatches += 1; }
    }

    if (removed.length || removedReferences.length || cleanedTasks.length || orphans || orphanDirs || prunedTasks) saveDb();
    const dg = diskGuard();
    if (!dg.ok) {
      console.warn(`[disk] 剩余 ${formatBytes(dg.free)}，低于保护线 ${formatBytes(dg.minFree)}：已暂停接收新任务（上传/建批次/开始任务）`);
    }
    if (removed.length || removedReferences.length || cleanedTasks.length || orphans || orphanDirs || prunedTasks) {
      console.log(
        `[ttl] 本轮清理 ${removed.length} 个源文件、${removedReferences.length} 个参考素材、${cleanedTasks.length} 个派生任务、` +
          `${orphans} 个临时文件、${orphanDirs} 个孤儿产物目录、${prunedTasks} 条历史任务记录、${prunedBatches} 个历史批次`,
      );
    }
    return { removed: removed.length, removedReferences: removedReferences.length, cleanedTasks: cleanedTasks.length, orphans, orphanDirs, prunedTasks, files: removed };
  } finally {
    sweeping = false;
  }
}

const serializeFile = (f) => ({
  id: f.id,
  md5: f.md5,
  name: f.name,
  names: f.names || [f.name],
  ext: f.ext,
  size: f.size,
  mime: f.mime,
  hits: f.hits || 1,
  createdAt: f.createdAt,
  storageName: `${f.md5}${f.ext}`,
  url: publicFileUrl(f.id),
  localUrl: `/f/${f.id}`,
  expiresAt: new Date(fileExpiresAt(f)).toISOString(),
  expiresInMs: Math.max(0, fileExpiresAt(f) - Date.now()),
  sizeText: formatBytes(f.size),
});
const serializeTask = (t) => ({
  ...t,
  // 云端产物地址只留在服务端内部使用，不下发给客户端
  remoteResultUrl: undefined,
  /** 产物预览/下载地址（仅成功任务；过期任务一律为 null，前端据此收起按钮） */
  downloadUrl: t.status === 'succeeded' ? `/api/download/${t.id}` : null,
  publicDownloadUrl: t.status === 'succeeded' ? publicDownloadUrl(t.id) : null,
  previewUrl: (t.status === 'succeeded' || (t.status === 'expired' && t.result?.remote)) && t.result?.hasVideo
    ? `/api/artifacts/${t.id}/video` : null,
  productRemote: !!t.result?.remote,
  productExpiresAt: t.remoteExpiresAt || null,
  /**
   * 去字幕接口产出的云端直连地址（带签名，24 小时有效）。
   * 前端优先用它：浏览器直连 CDN，速度取决于客户端带宽，且不占用本服务器出带宽。
   * 过期或不可用时前端自动回退到本站地址。
   */
  posterUrl: t.status === 'succeeded' && t.result?.poster ? `/api/artifacts/${t.id}/poster.svg` : null,
  publicPosterUrl: t.status === 'succeeded' && t.result?.poster ? publicPosterUrl(t.id) : null,
  sizeText: t.result ? formatBytes(t.result.size) : null,
});

// ---------------------------------------------------------------- 文件传输
/** 支持 Range 的静态/文件响应（视频可拖动进度条） */
/** 解析云端签名地址的到期时间（auth_key=<epoch>-…）；解析不到返回 null */
function urlExpiry(url) {
  const m = /auth_key=(\d{9,})/.exec(String(url || ''));
  return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
}
/** 云端产物是否还有效（不存副本模式下判断能否继续预览/下载） */
function remoteAlive(task) {
  if (!task?.remoteResultUrl) return false;
  if (!task.remoteExpiresAt) return true;
  return Date.parse(task.remoteExpiresAt) > Date.now();
}

function serveFile(req, res, absPath, { mime, downloadName, cache = 'no-store' } = {}) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return sendError(res, 404, '文件不存在');
  }
  const type = mime || MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': cache,
    'access-control-allow-origin': '*',
  };
  if (downloadName) {
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }
  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === '' ? Math.max(0, stat.size - Number(m[2])) : Number(m[1]);
    let end = m[1] === '' || m[2] === '' ? stat.size - 1 : Number(m[2]);
    start = Math.min(start, stat.size - 1);
    end = Math.min(end, stat.size - 1);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(absPath, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(absPath).pipe(res);
}

// ---------------------------------------------------------------- 上传
const MD5_RE = /^[0-9a-f]{32}$/;

/** 文件是否存在且是正常文件（索引可能指向被手工删除的 blob） */
async function blobExists(file) {
  if (!file) return false;
  try {
    const st = await fsp.stat(path.join(DATA_DIR, file.storedPath));
    return st.isFile() && st.size === file.size;
  } catch {
    return false;
  }
}

/** 按文件的唯一 ID（vf_xxx）取文件；已过期的按不存在处理 */
function findFileByKey(key) {
  if (!key) return null;
  const file = db.files[key];
  return file && !isFileExpired(file) ? file : null;
}

/** 秒传预检：客户端先算好 MD5，命中就不必再传一遍字节 */
async function handlePrecheck(req, res) {
  const body = await readJsonBody(req);
  const md5 = String(body.md5 || '').toLowerCase();
  if (!MD5_RE.test(md5)) return sendError(res, 400, 'md5 必须是 32 位十六进制字符串');
  const me = currentUser(req);
  const indexKey = fileIndexKey(me?.id, md5);
  const hit = db.files[db.md5Index[indexKey]];
  if (!hit || isFileExpired(hit) || !(await blobExists(hit))) {
    if (hit && isFileExpired(hit)) {
      // 过期文件的索引可能还没被扫描到：立刻清掉，避免秒传误命中已删除的内容
      delete db.md5Index[indexKey];
      saveDb();
      await sweepExpired('lazy');
      console.log(`[precheck] ${md5} 已过期，按未命中处理`);
    }
    if (!hit) return sendJson(res, 200, { exists: false, md5 });
    if (isFileExpired(hit)) return sendJson(res, 200, { exists: false, md5, expired: true });

    delete db.md5Index[indexKey]; // 索引失效，让客户端正常上传
    saveDb();
    return sendJson(res, 200, { exists: false, md5, stale: true });
  }
  // 秒传也要留下痕迹：记录新文件名作为别名，便于回溯「这份内容都叫过什么」
  const name = body.name ? sanitizeName(String(body.name)) : null;
  hit.names = [...new Set([...(hit.names || [hit.name]), ...(name ? [name] : [])])].slice(0, 20);
  hit.hits = (hit.hits || 1) + 1;
  hit.lastSeenAt = new Date().toISOString();
  // 本次上传是一次新的使用行为；给该账号自己的文件记录重新计算有效期。
  hit.expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
  saveDb();
  console.log(
    `[precheck] 命中 ${md5} -> ${hit.id}，跳过上传 ${formatBytes(hit.size)}` +
      `${name ? `（本次文件名 ${name}）` : ''}`,
  );
  sendJson(res, 200, { exists: true, md5, file: serializeFile(hit), savedBytes: hit.size });
}

async function handleUpload(req, res) {
  // 磁盘低于保护线：先别收文件，避免把已经紧张的磁盘写满
  const diskCheck = diskGuard();
  if (!diskCheck.ok) {
    return sendError(res, 507, diskLowMessage(diskCheck.free), { freeBytes: diskCheck.free, minFreeBytes: diskCheck.minFree });
  }
  // 文件名：浏览器会做 encodeURIComponent，这里解码；对没编码过的原始名字也要容错（不能因为解码失败就 500）
  const rawHeader = String(req.headers['x-file-name'] || 'video.mp4');
  let decodedName = rawHeader;
  try { decodedName = decodeURIComponent(rawHeader); } catch { decodedName = rawHeader; }
  const rawName = sanitizeName(decodedName);
  const ext = (path.extname(rawName) || '.mp4').toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    return sendError(res, 415, `不支持的文件类型 ${ext}`, { allowed: [...VIDEO_EXT] });
  }
  // 客户端可携带已验证的 MD5；不传则服务端自己算，仍然享受上传后的去重
  const declaredMd5 = String(req.headers['x-file-md5'] || '').toLowerCase();
  if (declaredMd5 && !MD5_RE.test(declaredMd5)) {
    return sendError(res, 400, 'X-File-MD5 必须是 32 位十六进制字符串');
  }

  // 先写临时文件，算出 MD5 后才能决定最终文件名（内容寻址）
  const tmpPath = path.join(UPLOAD_DIR, `.incoming-${crypto.randomBytes(8).toString('hex')}`);
  const md5 = crypto.createHash('md5');
  const sha256 = crypto.createHash('sha256');
  let received = 0;

  const guard = async function* (source) {
    for await (const chunk of source) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        throw Object.assign(new Error('文件超过大小限制'), { status: 413 });
      }
      md5.update(chunk);
      sha256.update(chunk);
      yield chunk;
    }
  };

  const t0 = Date.now();
  try {
    await pipeline(req, guard, fs.createWriteStream(tmpPath));
  } catch (err) {
    await fsp.rm(tmpPath, { force: true });
    if (err.status) return sendError(res, err.status, err.message, { maxBytes: MAX_UPLOAD_BYTES });
    return; // 客户端中断
  }
  if (received === 0) {
    await fsp.rm(tmpPath, { force: true });
    return sendError(res, 400, '上传内容为空');
  }

  const digest = md5.digest('hex');
  if (declaredMd5 && declaredMd5 !== digest) {
    await fsp.rm(tmpPath, { force: true });
    return sendError(res, 400, '文件 MD5 与客户端声明不一致，上传可能已损坏，请重试', {
      declared: declaredMd5,
      actual: digest,
    });
  }

  const me = currentUser(req);
  const indexKey = fileIndexKey(me?.id, digest);
  // ---- 账号内去重：同 MD5 已存在，直接丢弃刚写入的临时文件 ----
  const existing = db.files[db.md5Index[indexKey]];
  if (await blobExists(existing)) {
    await fsp.rm(tmpPath, { force: true });
    existing.names = [...new Set([...(existing.names || [existing.name]), rawName])].slice(0, 20);
    existing.lastSeenAt = new Date().toISOString();
    existing.hits = (existing.hits || 1) + 1;
    existing.expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
    saveDb();
    console.log(
      `[dedupe] ${digest} 已存在（${existing.id}），复用服务器文件，本次未占用新空间 ${formatBytes(received)}`,
    );
    syncUserAssets(me.id);
    return sendJson(res, 200, {
      file: serializeFile(existing),
      deduped: true,
      savedBytes: received,
      md5: digest,
    });
  }

  // 物理层仍允许复用其它账号已上传的相同 blob，但为当前账号创建独立记录。
  // 这样不会暴露对方文件名/用户 ID，也不会共享过期时间和删除权限。
  let sharedBlob = null;
  for (const candidate of Object.values(db.files)) {
    if (candidate.md5 === digest && !isFileExpired(candidate) && await blobExists(candidate)) {
      sharedBlob = candidate;
      break;
    }
  }
  if (sharedBlob) {
    await fsp.rm(tmpPath, { force: true });
    const fileId = id('vf');
    const file = {
      id: fileId,
      md5: digest,
      name: rawName,
      names: [rawName],
      ext: sharedBlob.ext,
      size: sharedBlob.size,
      mime: sharedBlob.mime,
      storedPath: sharedBlob.storedPath,
      sha256: sharedBlob.sha256,
      userId: me?.id || null,
      hits: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(),
    };
    db.files[fileId] = file;
    db.md5Index[indexKey] = fileId;
    saveDb();
    console.log(`[dedupe] ${digest} 复用物理 blob，为账号创建独立文件记录 ${fileId}`);
    syncUserAssets(me.id);
    return sendJson(res, 200, { file: serializeFile(file), deduped: true, savedBytes: received, md5: digest });
  }

  // ---- 落盘：文件名就是 MD5，扩展名沿用本次上传 ----
  const storedPath = path.join(UPLOAD_DIR, `${digest}${ext}`);
  await fsp.rm(storedPath, { force: true });
  await fsp.rename(tmpPath, storedPath);

  const fileId = id('vf');
  const file = {
    id: fileId,
    md5: digest,
    name: rawName,
    names: [rawName],
    ext,
    size: received,
    mime: MIME[ext] || req.headers['content-type'] || 'video/mp4',
    storedPath: path.relative(DATA_DIR, storedPath),
    sha256: sha256.digest('hex'),
    userId: me?.id || null,
    hits: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(), // 到期时间（UPLOAD_TTL_HOURS 可配）
  };
  db.files[fileId] = file;
  db.md5Index[indexKey] = fileId;
  saveDb();

  console.log(
    `[upload] ${fileId} ${rawName} ${formatBytes(received)} in ${Date.now() - t0}ms` +
      ` md5=${digest}${declaredMd5 ? '（与客户端一致）' : ''} -> uploads/${digest}${ext}`,
  );
  syncUserAssets(me.id);
  sendJson(res, 200, { file: serializeFile(file), deduped: false, md5: digest });
}

function serializeReference(reference) {
  return {
    id: reference.id,
    name: reference.name,
    ext: reference.ext,
    mime: reference.mime,
    size: reference.size,
    kind: reference.kind,
    url: publicReferenceUrl(reference.id),
    localUrl: `/r/${reference.id}`,
    createdAt: reference.createdAt,
    expiresAt: reference.expiresAt,
  };
}

async function handleReferenceUpload(req, res) {
  const diskCheck = diskGuard();
  if (!diskCheck.ok) return sendError(res, 507, diskLowMessage(diskCheck.free));
  const rawHeader = String(req.headers['x-file-name'] || 'reference.bin');
  let decodedName = rawHeader;
  try { decodedName = decodeURIComponent(rawHeader); } catch { decodedName = rawHeader; }
  const name = sanitizeName(decodedName);
  const ext = path.extname(name).toLowerCase();
  if (!REFERENCE_EXT.has(ext)) {
    return sendError(res, 415, `不支持的参考文件类型 ${ext || '(无扩展名)'}`, { allowed: [...REFERENCE_EXT] });
  }
  const referenceId = id('ref');
  const storedPath = path.join(REFERENCE_DIR, `${referenceId}${ext}`);
  let received = 0;
  const guard = async function* (source) {
    for await (const chunk of source) {
      received += chunk.length;
      if (received > REFERENCE_MAX_UPLOAD_BYTES) {
        throw Object.assign(new Error('参考文件超过大小限制'), { status: 413 });
      }
      yield chunk;
    }
  };
  try {
    await pipeline(req, guard, fs.createWriteStream(storedPath, { flags: 'wx' }));
  } catch (err) {
    await fsp.rm(storedPath, { force: true });
    if (err.status) return sendError(res, err.status, err.message, { maxBytes: REFERENCE_MAX_UPLOAD_BYTES });
    if (err.code === 'EEXIST') return sendError(res, 409, '参考文件 ID 冲突，请重试');
    return;
  }
  if (!received) {
    await fsp.rm(storedPath, { force: true });
    return sendError(res, 400, '上传内容为空');
  }
  const kind = IMAGE_REFERENCE_EXT.has(ext) ? 'image' : ['.mp4', '.mov', '.m4v', '.webm'].includes(ext) ? 'video' : 'audio';
  const now = new Date();
  const reference = {
    id: referenceId,
    userId: currentUser(req)?.id || null,
    name,
    ext,
    mime: MIME[ext] || String(req.headers['content-type'] || 'application/octet-stream'),
    kind,
    size: received,
    storedPath: path.relative(DATA_DIR, storedPath),
    createdAt: now.toISOString(),
    expiresAt: null,
    persistent: true,
  };
  db.references[referenceId] = reference;
  registerReferenceAsset(reference);
  saveDb();
  console.log(`[reference] ${referenceId} ${kind} ${name} ${formatBytes(received)}`);
  sendJson(res, 201, { reference: serializeReference(reference) });
}

// ---------------------------------------------------------------- 任务队列
const queue = [];
let running = 0;
const executing = new Set();

/**
 * 启动时处理中断的任务。
 * 进程重启后，之前标记为「处理中」的任务已经没有 worker 在跑了：如果不处理，
 * 前端就会永远停在「正在处理中……」。
 *   · 已经提交到去字幕接口的（有 remoteTaskId）→ 重新接管，继续等待并回传结果
 *   · 还没提交成功的 → 标记失败，让用户重新提交
 */
function recoverInterruptedTasks() {
  let resumed = 0;
  let requeued = 0;
  let idle = 0;
  for (const task of Object.values(db.tasks)) {
    if (task.status !== 'processing' && task.status !== 'pending') continue;
    if (task.remoteTaskId) {
      task.status = 'pending';
      task.resume = true;
      task.wasResumed = true;      // 耗时里含重启空档，不能作为 RTF 样本
      task.stage = '服务重启，等待接管';
      resumed += 1;
      enqueue(task.id);
    } else if (!task.started) {
      /* 用户建好了任务但还没点「开始任务」：保持"待开始"，绝不能自动跑起来 */
      task.status = 'pending';
      task.progress = 0;
      task.stage = '等待开始';
      task.etaSeconds = task.estimatedSeconds ?? null;
      idle += 1;
    } else {
      /*
       * 用户点过开始、但还没拿到接口 task_id（在本地队列里等着，或提交请求发出后没收到响应）：
       * 直接判失败要用户重来，体验很差。这里改成**自动重新排队**。
       * 安全性：去字幕接口按输入地址去重（同一个 video_url 会返回同一个 task_id），
       * 所以即使上一次提交其实已经到达云端，重排也不会重复处理。
       */
      task.status = 'pending';
      task.progress = 0;
      task.stage = '服务重启，自动重新排队';
      task.error = null;
      task.canceled = false;
      task.startedAt = null;
      task.etaSeconds = task.estimatedSeconds ?? null;
      task.wasResumed = true;      // 用于"不把重启导致的耗时算进 RTF 样本"
      requeued += 1;
      enqueue(task.id);
    }
  }
  if (resumed || requeued || idle) {
    saveDb();
    console.log(`  重启接管    ${resumed} 个已提交到接口的任务`);
    if (requeued) console.log(`  自动重排    ${requeued} 个已开始但未提交的任务（不判失败）`);
    if (idle) console.log(`  保持待开始  ${idle} 个用户还没点开始的任务`);
  }
}

function enqueue(taskId) {
  const task = db.tasks[taskId];
  if (task && !task.started) {
    task.started = true;     // 落库：重启后据此判断"这个任务本来就在跑"
    saveDb();
  }
  if (!queue.includes(taskId)) queue.push(taskId);
  pump();
}

function pump() {
  while (running < MAX_ACTIVE_TASKS && queue.length) {
    const taskId = queue.shift();
    const task = db.tasks[taskId];
    if (!task || task.status !== 'pending') continue;
    running += 1;
    executing.add(taskId);
    execute(task)
      .catch((err) => console.error('[worker] 未捕获异常', err))
      .finally(() => {
        executing.delete(taskId);
        running -= 1;
        saveDb();
        pump();
      });
  }
}

async function execute(task) {
  // 用户取消过（可能取消时它还在本地队列里）→ 直接落地为已取消，绝不翻回"处理中"
  if (task.canceled) {
    task.status = 'canceled';
    task.stage = '已取消';
    task.stageKey = 'canceled';
    task.finishedAt = task.finishedAt || new Date().toISOString();
    saveDb();
    console.log(`[worker] ${task.id} 已取消，跳过执行`);
    return;
  }
  const file = db.files[task.fileId];
  // 接管模式：接口那边已经提交过，重启后只需要继续等待并回传结果
  const resume = task.resume === true && Boolean(task.remoteTaskId);
  task.status = 'processing';
  if (!resume) {
    // 接管时保留原有的开始时间与已用时长，进度与剩余时间跨重启保持连续
    task.startedAt = new Date().toISOString();
    task.elapsedSeconds = 0;
    task.etaSeconds = task.estimatedSeconds ?? null;
  }
  task.progress = resume ? Math.max(Number(task.progress) || 0, 10) : 1;
  task.stage = resume ? '服务重启，正在接管任务' : '任务已进入去字幕队列';
  saveDb();

  try {
    if (!file && !resume && !task.sourceUrl) throw new Error('源文件不存在或已被清理');
    if (file && isFileExpired(file) && !resume) throw new Error(`源文件已过期（超过 ${ttlHours()} 小时）并被删除，请重新上传`);
    const srcPath = file ? path.join(DATA_DIR, file.storedPath) : null;
    const outDir = path.join(OUTPUT_DIR, task.id);
    await fsp.mkdir(outDir, { recursive: true });

    if (task.sourcePlatform === 'douyin') {
      task.stage = '正在保存中等码率视频'; task.stageKey = 'fetch'; task.progress = 60; saveDb();
      await fsp.copyFile(srcPath, path.join(outDir, 'output.mp4'));
      if (task.canceled) return;
      const stat = await fsp.stat(path.join(outDir, 'output.mp4'));
      finishTaskResult(task, { name: `${path.basename(task.fileName, '.mp4')}-标准版.mp4`, size: stat.size, hasVideo: true, remote: false });
      return;
    }

    // ---- 区域遮挡 / 消物（本地 ffmpeg，不依赖云端接口） ----
    if (task.operation === 'region-blur') {
      const optsR = task.options || {};
      const baseNameR = path.basename(file?.name || task.fileName, file?.ext || path.extname(task.fileName));
      task.stage = '正在读取分辨率';
      task.stageKey = 'fetch';
      task.progress = Math.max(Number(task.progress) || 0, 10);
      saveDb();
      await fsp.mkdir(outDir, { recursive: true });
      const size = await probeVideoSize(srcPath);
      const px = (v, total) => Math.max(2, Math.min(total - 2, Math.round((Number(v) / 100) * total)));
      const x = px(optsR.x, size.width);
      const y = px(optsR.y, size.height);
      const w = Math.max(2, Math.min(size.width - x, Math.round((Number(optsR.w) / 100) * size.width)));
      const h = Math.max(2, Math.min(size.height - y, Math.round((Number(optsR.h) / 100) * size.height)));
      const filter = optsR.mode === 'box'
        ? `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1:t=fill`
        : optsR.mode === 'blur'
          ? `split[a][b];[b]crop=${w}:${h}:${x}:${y},boxblur=25:2[c];[a][c]overlay=${x}:${y}`
          : `delogo=x=${x}:y=${y}:w=${w}:h=${h}`;
      task.stage = '正在处理画面区域';
      task.progress = Math.max(Number(task.progress) || 0, 30);
      saveDb();
      console.log(`[region] 任务 ${task.id} ${optsR.mode || 'delogo'} 区域 ${x},${y} ${w}x${h}（${size.width}x${size.height}）`);
      await runFfmpegFilter(srcPath, path.join(outDir, 'output.mp4'), filter, (pct) => {
        if (task.canceled) return;
        task.progress = Math.max(Number(task.progress) || 0, 30 + Math.round(pct * 0.6));
        saveDb();
      }, () => { if (task.canceled) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' }); }, task.durationSec);
      const statR = await fsp.stat(path.join(outDir, 'output.mp4'));
      finishTaskResult(task, { name: `${baseNameR}-区域处理.mp4`, size: statR.size, hasVideo: true, remote: false });
      console.log(`[region] 任务 ${task.id} 完成，产物 ${formatBytes(statR.size)}`);
      return;
    }

    // ---- 更多工具：字幕文稿 / 人脸打码 / 人像抠图 ----
    if (task.operation === 'ocr-extract' || task.operation === 'face-blur' || task.operation === 'portrait-matte') {
      const assertAlive3 = () => { if (task.canceled) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' }); };
      const opts3 = task.options || {};
      const baseName3 = path.basename(file?.name || task.fileName, file?.ext || path.extname(task.fileName));
      const srcUrl3 = publicFileUrl(file.id);
      if (task.operation === 'ocr-extract') {
        task.stage = '正在识别画面文字'; task.stageKey = 'cloud'; task.progress = Math.max(Number(task.progress) || 0, 10); saveDb();
        console.log(`[ocr] 任务 ${task.id} 开始识别（${opts3.mode || 'Subtitle'}）`);
        const ocr = await runOcr(srcUrl3, { mode: opts3.mode || 'Subtitle', taskId: task.remoteTaskId, assertAlive: assertAlive3,
          onSubmitted: (id) => { task.remoteTaskId = id; saveDb(); } });
        assertAlive3();
        const srt3 = toSrt(ocr.subtitles);
        await fsp.mkdir(outDir, { recursive: true });
        await fsp.writeFile(path.join(outDir, 'subtitle.srt'), srt3, 'utf8');
        finishTaskResult(task, { name: `${baseName3}-文稿.srt`, size: Buffer.byteLength(srt3), hasVideo: false, remote: false, srt: true });
        console.log(`[ocr] 任务 ${task.id} 生成文稿（${ocr.subtitles.length} 条）`);
        return;
      }
      const tool = task.operation === 'face-blur' ? 'face-blur-video' : 'matte-portrait-video';
      const extra = task.operation === 'face-blur'
        ? { mask_mode: opts3.maskMode || 'mosaic', mask_strength: opts3.strength || 'medium', upright_face_only: true }
        : { format: 'MP4', background_color: opts3.background || 'green' };
      task.stage = task.operation === 'face-blur' ? '正在识别人脸并打码' : '正在抠出人物';
      task.stageKey = 'cloud';
      task.progress = Math.max(Number(task.progress) || 0, 10);
      saveDb();
      console.log(`[${tool}] 任务 ${task.id} 开始（${JSON.stringify(extra)}，已扣 ${task.chargedCredits} 积分）`);
      const out3 = await runToolVideo(tool, srcUrl3, extra, { taskId: task.remoteTaskId, assertAlive: assertAlive3,
        onSubmitted: (id) => { task.remoteTaskId = id; saveDb(); } });
      assertAlive3();
      const kept3 = KEEP_ARTIFACT;
      let size3 = out3.size || 0;
      if (kept3) {
        await fetchPool.run(async () => {
          assertAlive3();
          const response = await fetch(out3.url, { signal: AbortSignal.timeout(900000) });
          if (!response.ok) throw new Error(`下载结果失败：HTTP ${response.status}`);
          const dest = path.join(outDir, 'output.mp4');
          await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
          assertAlive3();
          size3 = (await fsp.stat(dest)).size;
        });
      }
      const suffix = task.operation === 'face-blur' ? '打码' : '抠像';
      finishTaskResult(task, { name: `${baseName3}-${suffix}.mp4`, size: size3, hasVideo: true, remote: !kept3, remoteUrl: out3.url });
      console.log(`[${tool}] 任务 ${task.id} 完成，用时 ${out3.elapsedSeconds}s，产物 ${formatBytes(size3)}`);
      return;
    }

    // ---- 语音转字幕 / 压缩转码（独立功能，同样直接用云端接口处理源文件） ----
    if (task.operation === 'asr-subtitles' || task.operation === 'transcode') {
      const assertAlive2 = () => { if (task.canceled) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' }); };
      const opts = task.options || {};
      const baseName2 = path.basename(file?.name || task.fileName, file?.ext || path.extname(task.fileName));
      const srcUrl = publicFileUrl(file.id);
      if (task.operation === 'asr-subtitles') {
        task.stage = '正在识别语音';
        task.stageKey = 'cloud';
        task.progress = Math.max(Number(task.progress) || 0, 10);
        saveDb();
        console.log(`[asr] 任务 ${task.id} 开始识别（语种 ${opts.language || '自动'}，已扣 ${task.chargedCredits} 积分）`);
        const asr = await runAsr(srcUrl, {
          language: opts.language && opts.language !== 'auto' ? opts.language : null,
          taskId: task.remoteTaskId, assertAlive: assertAlive2,
          onSubmitted: (id) => { task.remoteTaskId = id; saveDb(); },
        });
        assertAlive2();
        const srt = toSrt(asr.subtitles);
        await fsp.mkdir(outDir, { recursive: true });
        const srtPath = path.join(outDir, 'subtitle.srt');
        await fsp.writeFile(srtPath, srt, 'utf8');
        if (opts.burn) {
          task.stage = '正在烧录字幕';
          task.stageKey = 'fetch';
          task.progress = Math.max(Number(task.progress) || 0, 70);
          saveDb();
          const burnPath = path.join(outDir, 'output.mp4');
          await burnSubtitles(srcPath, srtPath, burnPath);
          assertAlive2();
          const st = await fsp.stat(burnPath);
          finishTaskResult(task, { name: `${baseName2}-字幕.mp4`, size: st.size, hasVideo: true, remote: false });
          console.log(`[asr] 任务 ${task.id} 字幕烧录完成（${asr.subtitles.length} 条），产物 ${formatBytes(st.size)}`);
        } else {
          finishTaskResult(task, { name: `${baseName2}-字幕.srt`, size: Buffer.byteLength(srt), hasVideo: false, remote: false, srt: true });
          console.log(`[asr] 任务 ${task.id} 生成 SRT（${asr.subtitles.length} 条）`);
        }
        return;
      }
      // 压缩 / 转码
      task.stage = '正在压缩转码';
      task.stageKey = 'cloud';
      task.progress = Math.max(Number(task.progress) || 0, 10);
      saveDb();
      console.log(`[transcode] 任务 ${task.id} 开始转码（${opts.profile || '1080p'}，已扣 ${task.chargedCredits} 积分）`);
      const tr = await runTranscode(srcUrl, {
        profile: opts.profile || '1080p', taskId: task.remoteTaskId, assertAlive: assertAlive2,
        onSubmitted: (id) => { task.remoteTaskId = id; saveDb(); },
      });
      assertAlive2();
      const keptTr = KEEP_ARTIFACT;
      let sizeTr = tr.size || 0;
      if (keptTr) {
        await fetchPool.run(async () => {
          assertAlive2();
          const response = await fetch(tr.url, { signal: AbortSignal.timeout(900000) });
          if (!response.ok) throw new Error(`下载转码结果失败：HTTP ${response.status}`);
          const dest = path.join(outDir, 'output.mp4');
          await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
          assertAlive2();
          sizeTr = (await fsp.stat(dest)).size;
        });
      }
      finishTaskResult(task, { name: `${baseName2}-${opts.profile || '1080p'}.mp4`, size: sizeTr, hasVideo: true, remote: !keptTr, remoteUrl: tr.url });
      console.log(`[transcode] 任务 ${task.id} 转码完成（${tr.resolution || opts.profile}），用时 ${tr.elapsedSeconds}s，产物 ${formatBytes(sizeTr)}`);
      return;
    }

    // ---- 超清画质（独立功能）：直接把源文件交给云端画质增强接口，不经过擦除 ----
    if (task.operation === 'enhance') {
      task.stage = '正在增强画质';
      task.stageKey = 'enhance';
      task.progress = Math.max(Number(task.progress) || 0, 5);
      saveDb();
      const assertAlive = () => { if (task.canceled) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' }); };
      console.log(`[enhance] 任务 ${task.id} 开始超清（${task.resolution || '自动'}，原片 ${task.durationSec || '?'}s，已扣 ${task.chargedCredits} 积分）`);
      const enh = await enhanceVideo(publicFileUrl(file.id), {
        taskId: task.remoteTaskId, assertAlive, resolution: task.resolution || null, toolVersion: task.toolVersion || null,
        onSubmitted: (id) => { task.remoteTaskId = id; saveDb(); },
      });
      assertAlive();
      const keptEnh = KEEP_ARTIFACT;
      let size = enh.size || 0;
      if (keptEnh) {
        await fetchPool.run(async () => {
          assertAlive();
          const response = await fetch(enh.url, { signal: AbortSignal.timeout(900000) });
          if (!response.ok) throw new Error(`下载超清结果失败：HTTP ${response.status}`);
          const dest = path.join(outDir, 'output.mp4');
          await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
          assertAlive();
          size = (await fsp.stat(dest)).size;
        });
      }
      if (task.canceled) return;
      task.result = {
        name: `${path.basename(file?.name || task.fileName, file?.ext || path.extname(task.fileName))}-超清.mp4`,
        size, hasVideo: true, poster: false, remote: !keptEnh,
      };
      task.remoteResultUrl = keptEnh ? null : enh.url;
      task.remoteExpiresAt = keptEnh ? null : urlExpiry(enh.url);
      task.enhanceDone = true;
      task.status = 'succeeded';
      task.progress = 100;
      task.stage = '超清完成';
      task.stageKey = 'done';
      task.finishedAt = new Date().toISOString();
      task.elapsedSeconds = Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000);
      task.etaSeconds = 0;
      saveDb();
      rememberResult(task);
      console.log(`[worker] ${task.id} 超清完成，用时 ${enh.elapsedSeconds}s，产物 ${formatBytes(size)}${keptEnh ? '' : '（云端保存）'}`);
      return;
    }

    const outcome = await runPipeline(
      task,
      {
        srcPath,
        outDir,
        operation: task.operation,
        mode: task.mode || OPERATIONS[task.operation]?.mode || 'Subtitle',
        // 擦除区域（可选）：null 表示不传，走接口默认区域
        eraseRatioLocation: task.eraseRatioLocation || null,
        keepArtifact: KEEP_ARTIFACT,
        modelVersion: task.modelVersion || null,
        // 接管时源文件可能已被清理，用任务里保存的元信息兜底（只用于产物命名与封面）
        file: file || { name: task.fileName || 'video.mp4', ext: path.extname(task.fileName || '.mp4'), size: task.fileSize || 0 },
        // 云端引擎需要「云端能拉到的地址」；/f/<id> 是不可猜测的能力 URL，可匿名访问
        videoUrl: file ? publicFileUrl(file.id) : (task.sourceUrl || null),
        resume,
        // 两阶段闸门：提交可并发、回传限流
        gate: {
          submit: (fn) => submitPool.run(fn),
          fetch: (fn) => fetchPool.run(async () => {
            // 回传限流生效时打一条日志（排队说明并发上限起了作用）
            if (fetchPool.waiting > 0) {
              console.log(`[gate] 回传限流：进行中 ${fetchPool.active}/${FETCH_CONCURRENCY}，排队 ${fetchPool.waiting}`);
            }
            return fn();
          }),
        },
        // 提交成功后立刻把接口任务 ID 落库，重启后才能凭它接管
        setRemoteTaskId: (id) => { task.remoteTaskId = id; saveDb(); },
      },
      ({ progress, stage, stageKey, etaSeconds, elapsedSeconds }) => {
        if (task.canceled) return;
        progress = Math.min(99, Number(progress) || 0);
        // 进度只增不减：接管任务时避免进度条回退
        task.progress = Math.max(Number(task.progress) || 0, Number(progress) || 0);
        task.stage = stage;
        task.stageKey = stageKey;
        if (Number.isFinite(elapsedSeconds)) task.elapsedSeconds = elapsedSeconds;
        if (Number.isFinite(etaSeconds)) task.etaSeconds = etaSeconds;
        if (task.canceled) return; // 已取消：不再覆盖状态
        saveDb();
      },
    );

    if (task.canceled) return;
    const kept = outcome.kept !== false;
    const stat = kept ? await fsp.stat(outcome.outputs.video) : null;
    const op = OPERATIONS[task.operation];
    task.remoteTaskId = outcome.remoteTaskId || task.remoteTaskId || null;
    delete task.resume;
    let finalRemoteUrl = outcome.remoteUrl || null;
    let finalSize = kept ? stat.size : (outcome.size || 0);
    const assertAlive = () => { if (task.canceled) throw Object.assign(new Error('任务已取消'), { code: 'CANCELED' }); };
    assertAlive();
    task.result = {
      name: `${path.basename(file?.name || task.fileName, file?.ext || path.extname(task.fileName))}-无字幕${op.outputExt}`,
      size: finalSize,
      hasVideo: true,
      poster: true,
      remote: !kept,
    };
    if (!kept) {
      task.remoteResultUrl = finalRemoteUrl;
      task.remoteExpiresAt = urlExpiry(finalRemoteUrl);
    }
    task.status = 'succeeded';
    task.progress = 100;
    task.stage = '去字幕完成';
    task.stageKey = 'done';
    task.finishedAt = new Date().toISOString();
    task.elapsedSeconds = Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000);
    task.etaSeconds = 0;
    recordRtf(task);
    saveDb();
    syncUserAssets(task.userId);
    rememberResult(task);        // 登记"内容 → 产物"（必须在 result 赋值之后），供之后的同内容复用
    console.log(
      `[worker] ${task.id} 去字幕完成，用时 ${outcome.durationMs}ms，产物 ${formatBytes(kept ? stat.size : (outcome.size || 0))}${kept ? '' : '（云端保存，未落盘）'}`,
    );
  } catch (err) {
    if (task.canceled) return;
    refundTaskCredits(task, 'refund:failed');
    task.status = err.code === 'CANCELED' ? 'canceled' : 'failed';
    task.stage = err.code === 'CANCELED' ? '已取消' : '处理失败';
    task.error = err.code === 'CANCELED' ? null : err.message || '未知错误';
    task.finishedAt = new Date().toISOString();
    console.warn(`[worker] ${task.id} ${task.status}: ${err.message}`);
  }
}

/**
 * 取消任务：本地立即撤销排队并退款；云端终止在后台尽力尝试。
 */
function cancelTask(task) {
  if (!task || !['pending', 'processing'].includes(task.status)) return false;
  const remoteId = task.enhanceTaskId || task.remoteTaskId;
  task.canceled = true;
  task.started = false;
  task.status = 'canceled';
  task.stage = '已取消';
  task.stageKey = 'canceled';
  task.finishedAt = new Date().toISOString();
  for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i] === task.id) queue.splice(i, 1);
  refundTaskCredits(task, 'refund:cancel');
  if (remoteId) {
    const canceledAt = task.finishedAt;
    cancelPool.run(() => cancelRemoteTask(remoteId)).then((result) => {
      if (task.canceled && task.finishedAt === canceledAt) { task.remoteCancel = result; saveDb(); }
    }).catch((err) => console.warn('[cancel]', err.message));
  }
  saveDb();
  return true;
}

/**
 * 彻底清理一份内容（「移除任务」用）：
 *   源文件 + 去字幕产物 + db.files + db.md5Index + db.results + 产物目录
 * 只要还有**任何批次行或任务**在引用它，就保留（否则会打断别人正在用的预览/下载）。
 */
async function purgeContent({ fileId, taskId } = {}) {
  const file = fileId ? db.files[fileId] : null;
  const task = taskId ? db.tasks[taskId] : null;
  const out = { removedFile: false, removedTask: false, removedMd5: false, freedBytes: 0, keptFile: null, keptTask: null };

  const itemRefs = (pred) => Object.values(db.batches || {}).some((b) => (b.items || []).some(pred));
  const taskRefs = (tid) => itemRefs((it) => it.taskId === tid);
  const fileRefs = (fid) => itemRefs((it) => it.fileId === fid)
    || Object.values(db.tasks || {}).some((t) => t.fileId === fid && t.id !== taskId);

  // ① 产物 + 任务记录 + 产物目录
  if (task && !taskRefs(task.id)) {
    if (executing.has(task.id)) { out.keptTask = '任务正在停止，请稍后清理'; out.keptFile = out.keptTask; return out; }
    cancelTask(task);
    out.freedBytes += task.result?.size || 0;
    delete db.tasks[task.id];
    await fsp.rm(path.join(OUTPUT_DIR, task.id), { recursive: true, force: true }).catch(() => {});
    for (const md5 of Object.keys(db.results || {})) {
      if (db.results[md5].taskId === task.id) delete db.results[md5];
    }
    out.removedTask = true;
  } else if (task) {
    out.keptTask = '产物仍被其它行复用';
  }

  // ② 源文件 + MD5 索引 + 内容索引
  if (file && !fileRefs(file.id)) {
    delete db.files[file.id];
    const indexKey = fileIndexKey(file.userId, file.md5);
    if (file.md5 && db.md5Index[indexKey] === file.id) { delete db.md5Index[indexKey]; out.removedMd5 = true; }
    const blobStillUsed = Object.values(db.files).some((other) => other.storedPath === file.storedPath);
    if (!blobStillUsed) {
      out.freedBytes += file.size || 0;
      await fsp.rm(path.join(DATA_DIR, file.storedPath), { force: true }).catch(() => {});
    }
    for (const [key, rec] of Object.entries(db.results)) if (rec.fileId === file.id) delete db.results[key];
    out.removedFile = true;
  } else if (file) {
    out.keptFile = '源文件仍被其它行使用';
  }
  return out;
}

/** 可用磁盘空间（字节） */
function freeDiskBytes(dir = DATA_DIR) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/**
 * 建一条任务记录（不排队）。批次里的每个「唯一内容」都走这里，
 * 单文件接口也复用，保证两种入口的字段一致。
 */
const probePool = createPool(2, 'probe');
const probingFiles = new Map();
async function fileDuration(file) {
  if (!file || isFileExpired(file)) throw Object.assign(new Error('源文件已过期或不存在'), { status: 410 });
  if (file.durationVerified && Number.isFinite(file.durationSec) && file.durationSec > 0) return file.durationSec;
  if (!probingFiles.has(file.id)) {
    const pending = probePool.run(async () => {
      const duration = await probeVideoDuration(path.join(DATA_DIR, file.storedPath));
      file.durationSec = duration;
      file.durationVerified = true;
      saveDb();
      return duration;
    }).finally(() => probingFiles.delete(file.id));
    probingFiles.set(file.id, pending);
  }
  return probingFiles.get(file.id);
}

function assertTaskOwner(task, user) {
  if (!user) throw Object.assign(new Error('请重新登录'), { status: 401 });
  if (!task || !task.userId || task.userId !== user.id) throw Object.assign(new Error('任务不存在'), { status: 404 });
}

/** 统一的成功收尾：写结果、算耗时、登记复用索引 */
function finishTaskResult(task, { name, size, hasVideo, remote, remoteUrl = null, srt = false, poster = false }) {
  task.result = { name, size, hasVideo, poster, remote, ...(srt ? { srt: true } : {}) };
  if (remote && remoteUrl) {
    task.remoteResultUrl = remoteUrl;
    task.remoteExpiresAt = urlExpiry(remoteUrl);
  }
  task.status = 'succeeded';
  task.progress = 100;
  task.stage = '处理完成';
  task.stageKey = 'done';
  task.finishedAt = new Date().toISOString();
  task.elapsedSeconds = Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000);
  task.etaSeconds = 0;
  saveDb();
  if (task.sourcePlatform !== 'douyin') rememberResult(task);
  syncUserAssets(task.userId);
}

/** 用本地 ffmpeg 把 SRT 烧进视频（2 核机器较慢，仅建议短片） */
async function burnSubtitles(srcPath, srtPath, destPath) {
  const { execFile } = await import('node:child_process');
  const ffmpeg = process.env.FFMPEG_PATH
    || (process.env.FFPROBE_PATH ? path.join(path.dirname(process.env.FFPROBE_PATH), 'ffmpeg') : 'ffmpeg');
  const escaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  await new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-y', '-i', srcPath, '-vf', `subtitles=${escaped}`, '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '23', '-c:a', 'copy', destPath], { timeout: 2 * 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
    (err, _so, se) => (err ? reject(new Error(`烧录字幕失败：${String(se || err.message).slice(-300)}`)) : resolve()));
  });
}

/** 本地 ffmpeg 按滤镜处理视频（带进度回调，可取消） */
async function runFfmpegFilter(srcPath, destPath, filter, onProgress = () => {}, assertAlive = () => {}, durationSec = 0) {
  const { execFile } = await import('node:child_process');
  const ffmpeg = process.env.FFMPEG_PATH
    || (process.env.FFPROBE_PATH ? path.join(path.dirname(process.env.FFPROBE_PATH), 'ffmpeg') : 'ffmpeg');
  await new Promise((resolve, reject) => {
    const child = execFile(ffmpeg, ['-y', '-i', srcPath, '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '23', '-c:a', 'copy', '-progress', 'pipe:1', '-nostats', destPath],
    { timeout: 2 * 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, _so, se) => {
      if (err) reject(new Error(`本地处理失败：${String(se || err.message).slice(-300)}`));
      else resolve();
    });
    let progressBuffer = '';
    child.stdout?.on('data', (chunk) => {
      try {
        assertAlive();
        progressBuffer = (progressBuffer + String(chunk)).slice(-4096);
        const matches = [...progressBuffer.matchAll(/out_time_ms=(\d+)/g)];
        const micros = Number(matches.at(-1)?.[1]);
        if (durationSec > 0 && Number.isFinite(micros)) onProgress(Math.min(99, (micros / 1_000_000 / durationSec) * 100));
      } catch (e) { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } reject(e); }
    });
  });
}

/** 源视频缩略图（首次请求时用 ffmpeg 截一帧，之后走缓存） */
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
async function ensureThumb(file) {
  if (!file) return null;
  const dest = path.join(THUMB_DIR, `${file.id}.jpg`);
  try { await fsp.access(dest); return dest; } catch { /* 先生成 */ }
  const src = path.join(DATA_DIR, file.storedPath);
  const ffmpeg = process.env.FFMPEG_PATH
    || (process.env.FFPROBE_PATH ? path.join(path.dirname(process.env.FFPROBE_PATH), 'ffmpeg') : 'ffmpeg');
  try {
    await fsp.mkdir(THUMB_DIR, { recursive: true });
    const { execFile } = await import('node:child_process');
    await new Promise((resolve, reject) => {
      execFile(ffmpeg, ['-y', '-ss', '0.6', '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '6', dest],
        { timeout: 30000 }, (err, _o, se) => (err ? reject(new Error(String(se || err.message).slice(-160))) : resolve()));
    });
    return dest;
  } catch (err) {
    console.warn('[thumb]', file.id, err.message);
    return null;
  }
}

/** 源文件的直接操作只允许上传者本人；无主记录默认拒绝访问。 */
function assertFileAccess(file, user) {
  if (!user) throw Object.assign(new Error('请重新登录'), { status: 401 });
  if (!file || !file.userId || file.userId !== user.id) throw Object.assign(new Error('文件不存在'), { status: 404 });
}

/** All launch routes use the same validation, charge and queue transition. */
async function startTask(task, user, { force = false } = {}) {
  assertTaskOwner(task, user);
  const initialStatus = task.status;
  const duration = task.fileId
    ? await fileDuration(db.files[task.fileId])
    : Math.max(0, Number(task.durationSec) || 0);
  if (!duration) throw Object.assign(new Error('无法确定视频时长，请改用上传处理'), { status: 422 });
  assertTaskOwner(task, user);
  if (db.tasks[task.id] !== task || task.status !== initialStatus) throw Object.assign(new Error('任务状态已变化，请重试'), { status: 409 });
  if (executing.has(task.id) || task.status === 'processing') throw Object.assign(new Error('任务正在处理或停止中'), { status: 409 });
  if (queue.includes(task.id)) return false;
  if (task.status === 'succeeded' && !force) throw Object.assign(new Error('任务已完成；重新处理需 force: true'), { status: 409 });
  const dg = diskGuard();
  if (!dg.ok) throw Object.assign(new Error(diskLowMessage(dg.free)), { status: 507 });
  task.durationSec = duration;
  // A completed run has consumed its charge. A forced new run pays again.
  if (task.status === 'succeeded' || !task.chargedCredits) {
    const cr = chargeSeconds(db, user, Math.ceil(duration), task.id);
    if (!cr.ok) throw Object.assign(new Error(`积分不足：需要 ${cr.need}，当前 ${cr.have}`), { status: 402, need: cr.need, have: cr.have });
    task.chargedCredits = cr.cost;
    task.chargedUserId = user.id;
  }
  Object.assign(task, { status: 'pending', progress: 0, stage: '等待调度', stageKey: 'queued', error: null,
    canceled: false, elapsedSeconds: 0, etaSeconds: task.estimatedSeconds ?? null, startedAt: null, finishedAt: null });
  for (const key of ['resume', 'remoteTaskId', 'enhanceTaskId', 'remoteResultUrl', 'remoteExpiresAt', 'result', 'remoteCancel']) delete task[key];
  saveDb();
  enqueue(task.id);
  return true;
}

function createTaskForFile(file, { operation = DEFAULT_OPERATION, userId, enhance = false, eraseRegion, eraseMode, modelVersion, resolution = null, toolVersion = null, options = null } = {}) {
  const dur = file.durationVerified ? Number(file.durationSec) : NaN;
  const hasDuration = Number.isFinite(dur) && dur > 0.5 && dur < 6 * 3600;
  const mode = resolveEraseMode(eraseMode || OPERATIONS[operation]?.mode || 'Subtitle');
  // 优先用同模式的历史速度；该模式还没有样本时，用整体中位数（全屏模式再 ×3 兜底）
  const hasModeSamples = modeSamples(mode).length > 0;
  const modeFactor = hasModeSamples ? 1 : (mode === 'Text' ? 3 : 1);
  const estimatedSeconds = hasDuration
    ? Math.max(MIN_ESTIMATE_SEC, Math.round(dur * currentRtf(mode) * modeFactor))
    : null;
  // 强力模式自动用最新模型（v5.6）
  const model = resolveModelVersion(modelVersion) || (mode === 'Text' ? 'v5.6' : null);
  const task = {
    id: id('task'),
    fileId: file.id,
    fileName: file.name,
    fileSize: file.size,
    userId: userId || null,
    enhance: !!enhance,
    resolution: resolution || null,
    toolVersion: toolVersion || null,
    options: options || null,
    operation,
    operationLabel: OPERATIONS[operation].label,
    mode,                                        // Subtitle | Text
    modelVersion: model,                         // v4 | v5 | v5.6（null = 接口默认）
    eraseRatioLocation: resolveEraseRegion(eraseRegion),   // null = 不传，用接口默认区域
    stages: STAGES.map(({ key, label, weight }) => ({ key, label, weight })),
    status: 'pending',
    started: false,          // 用户是否点过「开始任务」；没点过的重启后必须保持"待开始"，绝不自动跑
    progress: 0,
    stage: '等待开始',
    createdAt: new Date().toISOString(),
    sourceExpiresAt: new Date(fileExpiresAt(file)).toISOString(),
    durationSec: Number.isFinite(dur) && dur > 0 ? dur : null,
    estimatedSeconds,
    elapsedSeconds: 0,
    etaSeconds: estimatedSeconds,
  };
  db.tasks[task.id] = task;
  saveDb();
  return task;
}

/**
 * 建批次：一次提交的一批文件。
 * 批内按 MD5 去重 —— 内容相同的文件只建一个任务，其余条目共享它的结果（秒传）。
 */
/* ============================================================
 * 内容级产物索引：源文件 MD5 → 已完成产物
 * 目的：同一个视频（哪怕改了文件名、隔了几个批次）再上传时，
 *       直接把服务器上已经去好字幕的那份拿出来复用，不重复调接口。
 * ========================================================== */
/** Content storage is shared; mutable tasks and results are scoped to account + processing settings. */
function resultKey(file, task) {
  const regions = (task.eraseRatioLocation || []).map((r) =>
    ['top_left_x', 'top_left_y', 'bottom_right_x', 'bottom_right_y'].map((k) => r[k])).sort();
  return JSON.stringify([file.md5, task.userId, task.operation, task.mode,
    task.modelVersion || null, regions, !!task.enhance, task.resolution || null, task.toolVersion || null,
    task.options ? JSON.stringify(task.options) : null]);
}

function resultOfKey(key) {
  const rec = db.results?.[key];
  const task = rec && db.tasks[rec.taskId];
  const file = task && db.files[task.fileId];
  if (!task || !file || resultKey(file, task) !== key || task.status !== 'succeeded' || !task.result
    || (task.result.remote && !remoteAlive(task)) || Date.parse(rec.expiresAt) <= Date.now()) {
    delete db.results[key];
    return null;
  }
  return { rec, task };
}

function rememberResult(task) {
  const file = db.files[task.fileId];
  if (!file?.md5 || !task.userId || task.status !== 'succeeded' || !task.result) return;
  // Do not cache a fallback as a successful enhancement.
  if (task.enhance && !task.enhanceDone) return;
  const key = resultKey(file, task);
  db.results[key] = { taskId: task.id, fileId: file.id, expiresAt: file.expiresAt, reused: 0 };
}

function renewForReuse(file, task) {
  const until = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
  file.expiresAt = until;
  task.sourceExpiresAt = until;
  const rec = db.results[resultKey(file, task)];
  if (rec) rec.expiresAt = until;
  return until;
}

function appendFilesToBatch(batch, fileIds, durations = {}, overrides = {}) {
  const eff = applyErasePreset({ preset: overrides.erasePreset || batch.erasePreset,
    region: overrides.eraseRegion, mode: overrides.eraseMode, model: overrides.modelVersion });
  const settings = { userId: batch.userId, operation: batch.operation, mode: eff.mode, resolution: overrides.resolution || batch.resolution || null, toolVersion: overrides.toolVersion || batch.toolVersion || null, options: overrides.options || batch.options || null,
    modelVersion: eff.model || (eff.mode === 'Text' ? 'v5.6' : null),
    eraseRatioLocation: eff.region, enhance: overrides.enhance ?? batch.enhance };
  const added = [];
  for (const fid of fileIds) {
    const file = db.files[fid];
    const key = resultKey(file, settings);
    const hit = resultOfKey(key);
    const active = Object.values(db.tasks).find((t) => {
      const f = db.files[t.fileId];
      return f && ['pending', 'processing'].includes(t.status) && !t.canceled && resultKey(f, t) === key;
    });
    let task = hit?.task || active;
    const shared = !!task;
    if (hit) { renewForReuse(file, task); hit.rec.reused += 1; }
    if (!task) {
      task = createTaskForFile(file, { operation: batch.operation, userId: batch.userId, enhance: settings.enhance,
        eraseRegion: eff.region, eraseMode: eff.mode, modelVersion: settings.modelVersion, resolution: settings.resolution, toolVersion: settings.toolVersion, options: settings.options });
      task.erasePreset = eff.preset;
    }
    const item = { fileId: fid, taskId: task.id, shared, reused: !!hit,
      attached: !!active && !hit, sharedWithFileId: shared ? task.fileId : null };
    if (!batch.taskIds.includes(task.id)) batch.taskIds.push(task.id);
    batch.items.push(item);
    added.push(item);
  }
  return added;
}

function createBatch({ fileIds, operation = DEFAULT_OPERATION, durations = {}, userId, enhance = false, erasePreset = 'standard', eraseRegion, eraseMode, modelVersion, resolution = null, toolVersion = null, options = null } = {}) {
  db.batches ||= {};
  const eff = applyErasePreset({ preset: erasePreset, region: eraseRegion, mode: eraseMode, model: modelVersion });
  const batch = {
    id: id('batch'),
    createdAt: new Date().toISOString(),
    operation,
    erasePreset: eff.preset,
    eraseRegion: eff.region,
    eraseMode: eff.mode,
    modelVersion: eff.model,
    enhance: !!enhance,
    resolution: resolution || null,
    toolVersion: toolVersion || null,
    options: options || null,
    userId: userId || null,
    taskIds: [],
    items: [],
  };
  appendFilesToBatch(batch, fileIds, durations, {
    erasePreset: batch.erasePreset,
    eraseRegion: batch.eraseRegion,
    eraseMode: batch.eraseMode,
    modelVersion: batch.modelVersion,
    resolution: batch.resolution,
    toolVersion: batch.toolVersion,
    options: batch.options,
  });
  db.batches[batch.id] = batch;
  saveDb();
  const reusedN = batch.items.filter((i) => i.reused).length;
  const attachedN = batch.items.filter((i) => i.attached).length;
  console.log(
    `[batch] ${batch.id} 新建：${fileIds.length} 个文件 / 新建任务 ${batch.taskIds.length} 个` +
    (reusedN ? `，复用已有产物 ${reusedN} 个（未重复去字幕）` : '') +
    (attachedN ? `，合并进行中 ${attachedN} 个` : ''),
  );
  return batch;
}

/** 把任务状态映射成界面行状态 */
function itemStatus(task) {
  if (!task) return 'idle';
  if (task.status === 'pending') return task.started ? 'queued' : 'idle';
  if (task.status === 'processing') return task.stageKey === 'cloud' || task.stageKey === 'fetch' || task.stageKey === 'enhance' ? 'running' : 'queued';
  return task.status;                                       // succeeded / failed / canceled / expired
}

/** 磁盘是否已低于保护线（低于则暂停接收新任务） */
function diskGuard() {
  const free = freeDiskBytes();
  if (free === null) return { ok: true, free: null, minFree: DISK_MIN_FREE_BYTES };
  return { ok: free >= DISK_MIN_FREE_BYTES, free, minFree: DISK_MIN_FREE_BYTES };
}
const diskLowMessage = (free) =>
  `服务器磁盘空间不足（剩余 ${formatBytes(free)}，低于 ${formatBytes(DISK_MIN_FREE_BYTES)} 保护线），已暂停接收新任务，请联系管理员清理`;

/**
 * 取出本次要操作的行号：
 *   · body.indexes 或 ?indexes=0,2   → 只操作这些行（对应界面里勾选的任务）
 *   · 都不给                          → 整批
 */
function pickedIndexes(req, body, total) {
  const raw = body?.indexes ?? new URL(req.url, 'http://x').searchParams.get('indexes');
  const all = [...Array(total).keys()];
  if (raw === undefined || raw === null || raw === '') return all;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = [...new Set(list.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0 && n < total))];
  return out.length ? out : all;
}

/** 批次 → 前端一次性拿全的载荷（列表 + 计数 + 总体进度 + ETA） */
function serializeBatch(batch) {
  const items = batch.items.map((it) => {
    const file = db.files[it.fileId];
    const task = it.taskId ? db.tasks[it.taskId] : null;
    const st = itemStatus(task);
    return {
      fileId: it.fileId,
      fileName: task?.fileName || file?.name || '（已过期）',
      size: task?.fileSize || file?.size || 0,
      sizeText: formatBytes(task?.fileSize || file?.size || 0),
      durationSec: task?.durationSec ?? null,
      md5: file?.md5 || null,
      taskId: it.taskId,
      shared: Boolean(it.shared),
      reused: Boolean(it.reused),        // 复用了已完成的历史产物（没重复去字幕）
      attached: Boolean(it.attached),    // 合并到正在处理的任务（没重复提交）
      sharedWithFileId: it.sharedWithFileId || null,
      sourceExpiresAt: task?.sourceExpiresAt || (file ? new Date(fileExpiresAt(file)).toISOString() : null),
      // 行状态与进度
      status: st,
      progress: task?.progress ?? 0,
      stage: task?.stage || '',
      stageKey: task?.stageKey || null,
      error: task?.error || null,
      elapsedSeconds: task?.elapsedSeconds ?? null,
      etaSeconds: task?.etaSeconds ?? null,
      // 产物（仅成功任务）
      result: task?.result ? {
        name: task.result.name,
        size: task.result.size,
        sizeText: formatBytes(task.result.size),
        hasVideo: task.result.hasVideo !== false,
        srt: !!task.result.srt,
      } : null,
      operation: task?.operation || batch.operation,
      operationLabel: task?.operationLabel || OPERATIONS[task?.operation || batch.operation]?.label || batch.operation,
      sourceUrl: task?.sourceUrl || null,
      downloadUrl: task && task.status === 'succeeded' ? `/api/download/${task.id}` : null,
      previewUrl: task && task.status === 'succeeded' && task.result?.hasVideo ? `/api/artifacts/${task.id}/video` : null,
      productRemote: !!task?.result?.remote,
      productExpiresAt: task?.remoteExpiresAt || null,
      remoteCancel: task?.remoteCancel || null,
    };
  });
  const count = (st) => items.filter((x) => x.status === st).length;
  const counts = {
    total: items.length,
    idle: count('idle'),
    queued: count('queued'),
    running: count('running'),
    done: count('done') + count('succeeded') + count('skip'),
    failed: count('failed'),
    canceled: count('canceled'),
    expired: count('expired'),
    shared: items.filter((x) => x.shared).length,
    tasks: [...new Set(batch.items.map((i) => i.taskId).filter(Boolean))].length,
  };
  // 总进度：已完成算满，进行中按各自进度折算
  const refTaskIds = [...new Set(batch.items.map((i) => i.taskId).filter(Boolean))];   // 含复用/合并进来的任务
  const taskPct = refTaskIds.reduce((a, tid) => {
    const t = db.tasks[tid];
    if (!t) return a;
    if (t.status === 'succeeded') return a + 100;
    if (t.status === 'processing') return a + (Number(t.progress) || 0);
    return a;
  }, 0);
  const progressPct = refTaskIds.length ? Math.round(taskPct / refTaskIds.length) : 0;
  // 整批 ETA：并发执行，所以取"还未完成任务的剩余时间"的最大值
  const etas = refTaskIds
    .map((tid) => db.tasks[tid])
    .filter((t) => t && (t.status === 'pending' || t.status === 'processing'))
    .map((t) => (Number.isFinite(Number(t.etaSeconds)) ? Number(t.etaSeconds) : (t.estimatedSeconds || 0)));
  const etaSeconds = etas.length ? Math.max(...etas) : 0;
  return {
    batch: {
      id: batch.id,
      createdAt: batch.createdAt,
      operation: batch.operation,
      erasePreset: batch.erasePreset || 'standard',
      // 显示"生效的"参数（由预设解析而来），而不是 null
      eraseRegion: (() => {
        const e = applyErasePreset({ preset: batch.erasePreset, region: batch.eraseRegion ?? undefined, mode: batch.eraseMode ?? undefined, model: batch.modelVersion ?? undefined });
        return e.region ? 'custom' : 'auto';
      })(),
      eraseMode: applyErasePreset({ preset: batch.erasePreset, region: batch.eraseRegion ?? undefined, mode: batch.eraseMode ?? undefined, model: batch.modelVersion ?? undefined }).mode,
      modelVersion: applyErasePreset({ preset: batch.erasePreset, region: batch.eraseRegion ?? undefined, mode: batch.eraseMode ?? undefined, model: batch.modelVersion ?? undefined }).model,
      enhance: !!batch.enhance,
      operation: batch.operation,
      resolution: batch.resolution || null,
      toolVersion: batch.toolVersion || null,
      options: batch.options || null,
      counts,
      progressPct,
      etaSeconds,
      disk: { free: freeDiskBytes() },
    },
    items,
  };
}

// ---------------------------------------------------------------- 路由
/** 去字幕引擎：显式指定 > auto（有密钥且配了公网入口才走云端）> 离线模拟 */
/** 去字幕接口配置（未配置时任务会被拒绝，不会有任何替代实现） */
const eraseApi = eraseApiConfig();

/** 解析并校验一个「视频直链」，返回 { url, name, ext } 或抛出带 status 的错误 */
function parseVideoUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw Object.assign(new Error('链接格式不正确，请粘贴完整的 http/https 地址'), { status: 400 }); }
  if (!/^https?:$/.test(parsed.protocol)) throw Object.assign(new Error('只支持 http:// 或 https:// 的视频直链'), { status: 400 });
  if (['v.douyin.com', 'www.iesdouyin.com', 'www.douyin.com', 'douyin.com'].includes(parsed.hostname.toLowerCase())) {
    return { url: raw, name: '抖音视频.mp4', ext: '.mp4', platform: 'douyin' };
  }
  if (/^(?:v\.kuaishou\.com|www\.kuaishou\.com|xiaohongshu\.com|www\.xiaohongshu\.com|bilibili\.com|b23\.tv)$/i.test(parsed.hostname)) {
    throw Object.assign(new Error('暂不支持该平台的分享链接：抖音/快手/小红书等页面的视频地址由浏览器动态生成，服务端无法直接获取。请先在 App 里「保存到本地」，再到「去字幕」上传视频。'), { status: 400 });
  }
  let base = 'video.mp4';
  try { base = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'video.mp4'); } catch { /* 保持默认 */ }
  const name = sanitizeName(base) || 'video.mp4';
  const ext = (path.extname(name) || '').toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    throw Object.assign(new Error(`链接文件类型 ${ext || '(无扩展名)'} 不受支持；请使用直链（.mp4/.mov/.mkv/.avi/.flv/.ts/.wmv）`), { status: 415 });
  }
  return { url: raw, name, ext };
}

function extractVideoLinks(input) {
  const values = Array.isArray(input) ? input : [input];
  return [...new Set(values.flatMap((value) => String(value || '').match(/https?:\/\/[^\s<>"']+/gi) || [])
    .map((value) => value.replace(/[，。；！）\]),;!]+$/, '')))];
}

const douyinPool = createPool(1, 'douyin');
async function importDouyinVideo(info, user) {
  return douyinPool.run(async () => {
    await assertPublicRemoteUrl(info.url);
    const python = process.env.DOUYIN_PYTHON_PATH || path.join(__dirname, 'venv-douyin/bin/python');
    const stdout = await new Promise((resolve, reject) => {
      execFile(python, [path.join(__dirname, 'scripts/douyin_resolver.py'), info.url], {
        timeout: 65000, maxBuffer: 1024 * 1024,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(__dirname, 'pw-browsers') },
      }, (err, output) => err ? reject(Object.assign(new Error(err.code === 'ENOENT'
        ? '抖音解析环境尚未安装，请联系管理员' : '抖音解析失败，请确认作品公开可访问后重试'), { status: 502 })) : resolve(output));
    });
    let resolved;
    try { resolved = JSON.parse(stdout); } catch { throw new Error('抖音解析响应无效，请稍后重试'); }
    if (!resolved.url) throw new Error(resolved.error || '没有找到可下载的视频');
    await assertPublicRemoteUrl(resolved.url);
    let downloadUrl = resolved.url;
    let response;
    for (let redirects = 0; redirects < 5; redirects += 1) {
      await assertPublicRemoteUrl(downloadUrl);
      response = await fetch(downloadUrl, { redirect: 'manual', signal: AbortSignal.timeout(180000),
        headers: { Referer: 'https://www.douyin.com/',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('视频下载跳转地址无效');
      downloadUrl = new URL(location, downloadUrl).href;
    }
    if (!response?.ok || !response.body) throw new Error(`下载抖音视频失败：HTTP ${response?.status || 0}`);
    if (Number(response.headers.get('content-length')) > MAX_UPLOAD_BYTES) {
      await response.body.cancel();
      throw new Error(`视频超过 ${formatBytes(MAX_UPLOAD_BYTES)} 大小限制`);
    }
    const tmp = path.join(UPLOAD_DIR, `.incoming-douyin-${crypto.randomUUID()}`);
    const md5 = crypto.createHash('md5');
    const sha = crypto.createHash('sha256');
    let size = 0;
    try {
      await pipeline(Readable.fromWeb(response.body), async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > MAX_UPLOAD_BYTES) throw new Error('视频超过文件大小限制');
          md5.update(chunk); sha.update(chunk); yield chunk;
        }
      }, fs.createWriteStream(tmp, { flags: 'wx' }));
      if (!size) throw new Error('下载的视频为空');
      const duration = await probeVideoDuration(tmp);
      const digest = md5.digest('hex');
      const indexKey = fileIndexKey(user.id, digest);
      const quality = { label: '中等码率', bitrate: resolved.bitrate, variants: resolved.variants, rank: resolved.rank };
      const existing = db.files[db.md5Index[indexKey]];
      if (await blobExists(existing)) {
        await fsp.rm(tmp, { force: true });
        existing.expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
        existing.durationSec = duration; existing.durationVerified = true;
        existing.sourceQuality = quality;
        return existing;
      }
      const stored = path.join(UPLOAD_DIR, `${digest}.mp4`);
      await fsp.rename(tmp, stored);
      const file = { id: id('vf'), md5: digest, sha256: sha.digest('hex'), name: `抖音-${resolved.id}.mp4`,
        names: [`抖音-${resolved.id}.mp4`], ext: '.mp4', size, mime: 'video/mp4',
        storedPath: path.relative(DATA_DIR, stored), userId: user.id, hits: 1,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(),
        durationSec: duration, durationVerified: true, sourceQuality: quality };
      db.files[file.id] = file; db.md5Index[indexKey] = file.id; saveDb();
      console.log(`[douyin] 中等码率 ${resolved.bitrate} bps，第 ${resolved.rank}/${resolved.variants} 档，${formatBytes(size)}`);
      return file;
    } catch (err) { await fsp.rm(tmp, { force: true }); throw err; }
  });
}

function isPrivateAddress(rawAddress) {
  const address = String(rawAddress || '').split('%')[0].toLowerCase();
  if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice(7));
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIP(address) === 6) {
    return address === '::' || address === '::1'
      || address.startsWith('fc') || address.startsWith('fd')
      || /^fe[89ab]/.test(address);
  }
  return true;
}

/** 链接探测会由服务器发起，必须拒绝本机、局域网和云元数据网段，避免 SSRF。 */
async function assertPublicRemoteUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('视频链接不能包含用户名或密码'), { status: 400 });
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isPrivateAddress(host))) {
    throw Object.assign(new Error('视频链接不能指向本机或内网地址'), { status: 400 });
  }
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw Object.assign(new Error('无法解析视频链接的域名'), { status: 422 }); }
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw Object.assign(new Error('视频链接解析到了本机或内网地址，已拒绝访问'), { status: 400 });
  }
}

/** 用链接建一个任务（源文件不上传，云端直接拉取该地址） */
function createUrlTask(urlInfo, user, eff) {
  const task = createTaskForFile(
    { id: null, name: urlInfo.name, size: 0, ext: urlInfo.ext, durationSec: null, durationVerified: false,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString() },
    { operation: DEFAULT_OPERATION, userId: user.id, eraseRegion: eff.region, eraseMode: eff.mode, modelVersion: eff.model },
  );
  task.fileId = null;
  task.sourceUrl = urlInfo.url;
  task.erasePreset = eff.preset;
  db.tasks[task.id] = task;
  return task;
}

/**
 * AutoDL ComfyUI 服务端代理。
 * Token 只存在于 Node 进程环境变量中，绝不下发给浏览器或写入任务数据。
 */
async function autodlRequest(pathname, { method = 'GET', body } = {}) {
  if (!AUTODL_READY) throw Object.assign(new Error('视频生成服务尚未配置'), { status: 503 });
  const response = await fetch(`${AUTODL_API_BASE}${pathname}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: AUTODL_API_TOKEN,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const upstreamMessage = String(data?.error?.message || data?.message || data?.msg || `AutoDL HTTP ${response.status}`);
    let message = upstreamMessage;
    let errorCode = 'PROVIDER_REQUEST_FAILED';
    let retryable = response.status >= 500;
    if (/insufficient account balance/i.test(upstreamMessage)) {
      message = '云端视频生成服务余额不足，任务未创建。请联系管理员充值服务商账户后重试。';
      errorCode = 'PROVIDER_BALANCE_INSUFFICIENT';
      retryable = false;
    } else if (response.status === 401 || /unauthori[sz]ed|invalid.*token|token.*invalid/i.test(upstreamMessage)) {
      message = '云端视频生成服务鉴权失败，任务未创建。请联系管理员检查接口 Token。';
      errorCode = 'PROVIDER_AUTH_FAILED';
      retryable = false;
    } else if (response.status === 429 || /rate limit|too many requests/i.test(upstreamMessage)) {
      message = '云端视频生成服务当前请求过多，任务未创建。请稍后再试。';
      errorCode = 'PROVIDER_RATE_LIMITED';
      retryable = true;
    }
    throw Object.assign(new Error(message), {
      status: response.status === 401 ? 502 : response.status,
      errorCode,
      stage: method === 'POST' ? 'submission' : 'polling',
      retryable,
    });
  }
  return data;
}

function safeWorkflowId(input) {
  const value = String(input || AUTODL_VIDEO_WORKFLOW).trim();
  const allowed = new Set([AUTODL_VIDEO_WORKFLOW, AUTODL_IMAGE_VIDEO_WORKFLOW, AUTODL_KEYFRAME_VIDEO_WORKFLOW]);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(value) || !allowed.has(value)) {
    throw Object.assign(new Error('不支持的视频工作流'), { status: 400 });
  }
  return value;
}

const VIDEO_GENERATION_ACTIVE = new Set(['SUBMITTING', 'QUEUED', 'RUNNING']);
const VIDEO_GENERATION_TERMINAL = new Set(['SUCCESS', 'FAILED', 'ERROR', 'CANCELED', 'CANCELLED']);
const videoGenerationSubmissionLocks = new Set();

function normalizeVideoGenerationStatus(value) {
  const status = String(value || 'QUEUED').toUpperCase();
  if (status === 'COMPLETED' || status === 'SUCCEEDED') return 'SUCCESS';
  if (status === 'FAILURE') return 'FAILED';
  if (status === 'PROCESSING') return 'RUNNING';
  return status;
}

function videoGenerationForUser(userId, activeOnly = false) {
  return Object.values(db.videoGenerations)
    .filter((item) => item.userId === userId && !item.dismissedAt && (!activeOnly || VIDEO_GENERATION_ACTIVE.has(item.status)))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0] || null;
}

function serializeVideoGeneration(item) {
  if (!item) return null;
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(item.createdAt || Date.now())) / 1000));
  let estimatedProgress = 0;
  if (item.status === 'QUEUED' || item.status === 'SUBMITTING') estimatedProgress = Math.min(18, 5 + Math.floor(elapsed / 8));
  else if (item.status === 'RUNNING') estimatedProgress = Math.min(94, 22 + Math.floor(elapsed / 3));
  else if (item.status === 'SUCCESS') estimatedProgress = 100;
  else if (VIDEO_GENERATION_TERMINAL.has(item.status)) estimatedProgress = null;
  return {
    taskId: item.taskId,
    status: item.status,
    prompt: item.prompt,
    workflow: item.workflow,
    mode: item.mode || (item.referenceIds?.length ? 'multi_image' : 'text'),
    parameters: item.parameters,
    createdAt: item.createdAt,
    startedAt: item.startedAt || null,
    duration: item.duration ?? null,
    results: (() => {
      return [...new Set(resultVideoUrls(item.results))].flatMap((url, index) => {
        const assetId = `generation:${item.taskId}:${index}`;
        if (db.assetTombstones[assetId]) return [];
        return [{ url: db.assets[assetId]?.state === 'ready' ? `/api/assets/${encodeURIComponent(assetId)}/content` : url }];
      });
    })(),
    error: item.error || null,
    errorCode: item.errorCode || null,
    failureStage: item.failureStage || null,
    estimatedProgress,
  };
}

async function refreshVideoGeneration(item) {
  if (!item || !item.taskId || VIDEO_GENERATION_TERMINAL.has(item.status)) return item;
  const upstream = await autodlRequest(`/comfyui_workflow/result/${encodeURIComponent(item.taskId)}`);
  if (upstream?.code !== 'Success' || !upstream?.data) {
    throw Object.assign(new Error(upstream?.msg || '查询生成任务失败'), { status: 502 });
  }
  const data = upstream.data;
  const before = JSON.stringify([item.status, item.duration, item.startedAt, item.results]);
  item.status = normalizeVideoGenerationStatus(data.status || item.status);
  item.duration = data.duration ?? item.duration ?? null;
  item.startedAt = data.started_at || item.startedAt || null;
  item.results = Array.isArray(data.results) ? data.results : [];
  if (VIDEO_GENERATION_TERMINAL.has(item.status) && item.status !== 'SUCCESS') {
    const failure = String(data?.error?.message || data?.error_message || data?.message || data?.msg || data?.failure_reason || data?.reason || '').trim();
    item.error = failure || item.error || '云端任务已终止，但接口没有返回具体原因。';
    item.errorCode = item.errorCode || 'PROVIDER_TASK_FAILED';
    item.failureStage = 'generation';
  }
  item.updatedAt = new Date().toISOString();
  if (item.status === 'SUCCESS') registerGenerationAssets(item);
  if (before !== JSON.stringify([item.status, item.duration, item.startedAt, item.results])) saveDb();
  return item;
}

const assetSaves = new Map();
const assetSavePool = createPool(2, 'asset-save');
const assetKindForExt = (ext) => IMAGE_REFERENCE_EXT.has(ext) ? 'image'
  : ['.mp3', '.wav', '.m4a', '.flac', '.aac'].includes(ext) ? 'audio'
    : ['.txt', '.srt', '.vtt'].includes(ext) ? 'text' : 'video';

function serializeAsset(asset) {
  const url = `/api/assets/${encodeURIComponent(asset.id)}/content`;
  return { id: asset.id, name: asset.name, kind: asset.kind, ext: asset.ext, source: asset.source,
    size: asset.size || 0, sizeText: formatBytes(asset.size || 0), createdAt: asset.createdAt,
    state: asset.state, error: asset.error || null, url, downloadUrl: `${url}?dl=1`,
    thumbUrl: asset.kind === 'image' && asset.state === 'ready' ? url : null,
    canReference: asset.state === 'ready', text: asset.kind === 'text' ? asset.text : undefined };
}

function registerReferenceAsset(reference) {
  const assetId = reference.assetId || `reference:${reference.id}`;
  if (db.assetTombstones[assetId]) return;
  reference.persistent = true; reference.expiresAt = null; reference.assetId = assetId;
  db.assets[assetId] ||= { id: assetId, userId: reference.userId, name: reference.name,
    ext: reference.ext, kind: reference.kind, mime: reference.mime, size: reference.size,
    storedPath: reference.storedPath, referenceId: reference.id, source: 'upload', state: 'ready', createdAt: reference.createdAt };
}

function scheduleAssetSave(asset, sourcePath = null) {
  if (asset.state === 'ready' || assetSaves.has(asset.id)) return;
  if (asset.failedAt && Date.now() - Date.parse(asset.failedAt) < 60000) return;
  asset.state = 'saving'; asset.error = null;
  const promise = assetSavePool.run(async () => {
    const basename = crypto.createHash('sha256').update(asset.id).digest('hex');
    const dest = path.join(ASSET_DIR, `${basename}${asset.ext}`);
    const tmp = `${dest}.incoming`;
    try {
      const guard = diskGuard();
      if (!guard.ok) throw new Error(diskLowMessage(guard.free));
      if (sourcePath) await fsp.copyFile(sourcePath, tmp);
      else {
        let url = asset.remoteUrl;
        let response;
        for (let n = 0; n < 5; n += 1) {
          await assertPublicRemoteUrl(url);
          response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(180000) });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location'); await response.body?.cancel();
          if (!location) throw new Error('下载地址跳转无效');
          url = new URL(location, url).href;
        }
        if (!response?.ok || !response.body) throw new Error(`下载生成结果失败（HTTP ${response?.status || 0}）`);
        const max = Math.max(MAX_UPLOAD_BYTES, 500 * 1024 ** 2);
        let received = 0;
        await pipeline(Readable.fromWeb(response.body), async function* (source) {
          for await (const chunk of source) {
            received += chunk.length;
            if (received > max) throw new Error('资产文件超过保存大小限制');
            yield chunk;
          }
        }, fs.createWriteStream(tmp));
      }
      if (!db.assets[asset.id]) { await fsp.rm(tmp, { force: true }); return; }
      const stat = await fsp.stat(tmp);
      if (!stat.size) throw new Error('资产文件为空');
      await fsp.rename(tmp, dest);
      Object.assign(asset, { storedPath: path.relative(DATA_DIR, dest), size: stat.size, state: 'ready', error: null });
      delete asset.remoteUrl;
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      asset.state = 'failed'; asset.error = err.message; asset.failedAt = new Date().toISOString();
    } finally { saveDb(); }
  }).finally(() => assetSaves.delete(asset.id));
  assetSaves.set(asset.id, promise);
}

function resultVideoUrls(value) {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) && !/\.(?:png|jpg|jpeg|webp|gif)(?:\?|$)/i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(resultVideoUrls);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).filter(([key]) => !/cover|thumb|poster/i.test(key)).flatMap(([, item]) => resultVideoUrls(item));
}

function registerGenerationAssets(generation) {
  const promptId = generation.promptAssetId || `prompt:${generation.taskId}`;
  if (generation.prompt && !db.assetTombstones[promptId]) {
    db.assets[promptId] ||= { id: promptId, userId: generation.userId, kind: 'text', ext: '.txt',
      mime: 'text/plain; charset=utf-8', name: `提示词-${generation.prompt.slice(0, 24)}.txt`,
      text: generation.prompt, size: Buffer.byteLength(generation.prompt), state: 'ready',
      source: 'prompt', createdAt: generation.createdAt };
  }
  if (generation.status !== 'SUCCESS') return;
  [...new Set(resultVideoUrls(generation.results))].slice(0, 20).forEach((url, index) => {
    const assetId = `generation:${generation.taskId}:${index}`;
    if (db.assetTombstones[assetId]) return;
    const asset = db.assets[assetId] ||= { id: assetId, userId: generation.userId, kind: 'video', ext: '.mp4',
      mime: 'video/mp4', name: `生成视频-${generation.taskId}-${index + 1}.mp4`, source: 'generation',
      remoteUrl: url, state: 'saving', createdAt: generation.updatedAt || generation.createdAt };
    scheduleAssetSave(asset);
  });
  saveDb();
}

function syncUserAssets(userId) {
  for (const reference of Object.values(db.references)) if (reference.userId === userId) registerReferenceAsset(reference);
  for (const generation of Object.values(db.videoGenerations)) if (generation.userId === userId) registerGenerationAssets(generation);
  for (const file of Object.values(db.files)) {
    const assetId = `file:${file.id}`;
    if (file.userId !== userId || isFileExpired(file) || db.assetTombstones[assetId]) continue;
    const asset = db.assets[assetId] ||= { id: assetId, userId, name: file.name, kind: assetKindForExt(file.ext),
      ext: file.ext, mime: file.mime, source: 'upload', state: 'saving', createdAt: file.createdAt };
    scheduleAssetSave(asset, path.join(DATA_DIR, file.storedPath));
  }
  for (const task of Object.values(db.tasks)) {
    const assetId = `task:${task.id}`;
    if (task.userId !== userId || task.status !== 'succeeded' || !task.result || db.assetTombstones[assetId]) continue;
    const ext = task.result.srt ? '.srt' : '.mp4';
    const asset = db.assets[assetId] ||= { id: assetId, userId, name: task.result.name || task.fileName,
      kind: assetKindForExt(ext), ext, mime: MIME[ext], source: 'process', state: 'saving',
      createdAt: task.finishedAt || task.createdAt, ...(task.result.remote ? { remoteUrl: task.remoteResultUrl } : {}) };
    scheduleAssetSave(asset, task.result.remote ? null : path.join(OUTPUT_DIR, task.id, task.result.srt ? 'subtitle.srt' : 'output.mp4'));
  }
  saveDb();
}

function ownedAsset(req, assetId) {
  const asset = db.assets[assetId];
  if (!asset || asset.userId !== currentUser(req)?.id) throw Object.assign(new Error('资产不存在'), { status: 404 });
  return asset;
}

const ROUTES = {
  'GET /api/assets/:assetId/content': async (req, res, { params, url }) => {
    const asset = ownedAsset(req, params.assetId);
    if (asset.state !== 'ready') return sendError(res, 409, asset.error || '资产正在保存，请稍后重试');
    if (asset.text !== undefined) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
        ...(url.searchParams.has('dl') ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}` } : {}) });
      return res.end(req.method === 'HEAD' ? undefined : asset.text);
    }
    serveFile(req, res, path.join(DATA_DIR, asset.storedPath), { mime: asset.mime,
      downloadName: url.searchParams.has('dl') ? asset.name : undefined });
  },
  'POST /api/assets/:assetId/reference': async (req, res, { params }) => {
    const asset = ownedAsset(req, params.assetId);
    if (asset.state !== 'ready') return sendError(res, 409, '资产尚未保存完成');
    if (asset.kind === 'text') {
      const text = asset.text ?? await fsp.readFile(path.join(DATA_DIR, asset.storedPath), 'utf8');
      return sendJson(res, 200, { text });
    }
    if (!REFERENCE_EXT.has(asset.ext)) return sendError(res, 415, '此格式暂不能添加到参考区');
    const referenceId = id('ref');
    const dest = path.join(REFERENCE_DIR, `${referenceId}${asset.ext}`);
    await fsp.copyFile(path.join(DATA_DIR, asset.storedPath), dest);
    const reference = { id: referenceId, userId: asset.userId, name: asset.name, ext: asset.ext,
      kind: asset.kind, mime: asset.mime, size: asset.size, assetId: asset.id, persistent: true,
      expiresAt: null, createdAt: new Date().toISOString(), storedPath: path.relative(DATA_DIR, dest) };
    db.references[reference.id] = reference; saveDb();
    sendJson(res, 201, { reference: serializeReference(reference) });
  },
  'DELETE /api/assets/:assetId': async (req, res, { params }) => {
    const asset = ownedAsset(req, params.assetId);
    const refs = Object.values(db.references).filter((ref) => ref.assetId === asset.id);
    if (Object.values(db.videoGenerations).some((g) => VIDEO_GENERATION_ACTIVE.has(g.status)
      && refs.some((ref) => g.referenceIds?.includes(ref.id)))) return sendError(res, 409, '素材正在用于生成，请等待任务完成后删除');
    if (assetSaves.has(asset.id)) return sendError(res, 409, '资产正在保存，请稍后删除');
    for (const ref of refs) {
      delete db.references[ref.id];
      await fsp.rm(path.join(DATA_DIR, ref.storedPath), { force: true });
    }
    if (asset.storedPath) await fsp.rm(path.join(DATA_DIR, asset.storedPath), { force: true });
    delete db.assets[asset.id]; db.assetTombstones[asset.id] = new Date().toISOString(); saveDb();
    sendJson(res, 200, { deleted: true });
  },
  'GET /api/config': async (req, res) => {
    sendJson(res, 200, {
      service: 'ClipFlow AI',
      baseUrl: baseUrl(),
      lanIp: LAN_IP,
      port: PORT,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      allowedExtensions: [...VIDEO_EXT],
      concurrency: { active: MAX_ACTIVE_TASKS, submit: SUBMIT_CONCURRENCY, fetch: FETCH_CONCURRENCY },
      maxBatchSize: MAX_BATCH_SIZE,
      uploadConcurrency: UPLOAD_CONCURRENCY,
      uploadTtlHours: UPLOAD_TTL_MS / 3600000,
      disk: { free: freeDiskBytes(), minFree: DISK_MIN_FREE_BYTES, outputFactor: DISK_OUTPUT_FACTOR },
      ttl: {
        hours: UPLOAD_TTL_MS / 3600000,
        note: '源文件与派生产物到期后自动删除，同时移除 MD5 索引',
        sweepIntervalMs: SWEEP_INTERVAL_MS,
      },
      session: {
        ttlMs: SESSION_TTL_MS,
        note: '持续操作会自动续期；闲置 1 小时后需要重新登录',
      },
      // 版本号：页面底部展示，便于确认线上跑的是哪次部署
      build: BUILD_ID,
      // 去字幕服务是否可用：只给布尔量与缺失项的中文说明，不含任何密钥
      probeReady: await probeAvailable(),
      eraseReady: eraseApi.ready,
      eraseMissing: eraseApi.missing.map((m) => (m === 'AMK_API_KEY' ? '去字幕接口密钥' : '公网访问入口')),
      videoGeneration: {
        ready: AUTODL_READY,
        provider: 'AutoDL ComfyUI',
        workflow: AUTODL_VIDEO_WORKFLOW,
        imageWorkflow: AUTODL_IMAGE_VIDEO_WORKFLOW,
        keyframeWorkflow: AUTODL_KEYFRAME_VIDEO_WORKFLOW,
        workflows: {
          text: AUTODL_VIDEO_WORKFLOW,
          multi_image: AUTODL_IMAGE_VIDEO_WORKFLOW,
          keyframes: AUTODL_KEYFRAME_VIDEO_WORKFLOW,
        },
        referenceUpload: '/api/video-references',
        referenceTtlHours: UPLOAD_TTL_MS / 3600000,
      },
      dedupe: { key: 'md5', storage: 'content-addressed', precheck: '/api/uploads/precheck' },
      stages: STAGES.map(({ key, label, weight }) => ({ key, label, weight })),
      operations: Object.values(OPERATIONS).map(({ id: opId, label, desc, accent }) => ({ id: opId, label, desc, accent })),
    });
  },

  'POST /api/video-generations': async (req, res) => {
    if (!AUTODL_READY) return sendError(res, 503, '视频生成服务尚未配置');
    const user = currentUser(req);
    let active = videoGenerationForUser(user.id, true);
    if (active) {
      try { active = await refreshVideoGeneration(active); } catch { /* 保守锁定，避免重复计费 */ }
      if (VIDEO_GENERATION_ACTIVE.has(active.status)) {
        return sendError(res, 409, '当前视频仍在生成，请等待任务完成后再提交', { generation: serializeVideoGeneration(active) });
      }
    }
    if (videoGenerationSubmissionLocks.has(user.id)) {
      return sendError(res, 409, '当前视频正在提交，请勿重复点击');
    }
    const body = await readJsonBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return sendError(res, 400, '请输入视频描述');
    if (prompt.length > 1000) return sendError(res, 400, '视频描述不能超过 1000 字');
    const mode = String(body.mode || '').trim();
    if (!VIDEO_GENERATION_MODES.has(mode)) return sendError(res, 400, '请选择有效的生成方式');
    const referenceIds = Array.isArray(body.referenceIds) ? [...new Set(body.referenceIds.map(String))] : [];
    if (referenceIds.length > 9) return sendError(res, 400, '多图生视频最多支持 9 张参考图片');
    const references = referenceIds.map((referenceId) => db.references[referenceId]);
    if (references.some((reference) => !reference || reference.userId !== user.id)) {
      return sendError(res, 404, '参考素材不存在或不属于当前账号');
    }
    if (references.some((reference) => reference.expiresAt && Date.parse(reference.expiresAt) <= Date.now())) {
      return sendError(res, 410, '参考素材已过期，请重新上传');
    }
    if (references.some((reference) => reference.kind !== 'image' || !IMAGE_REFERENCE_EXT.has(reference.ext))) {
      return sendError(res, 415, '视频生成参考文件仅支持 JPG、PNG、WebP 图片');
    }
    if (mode === 'text' && references.length) return sendError(res, 400, '文生视频不接受参考图片');
    if (mode === 'multi_image' && (references.length < 1 || references.length > 9)) {
      return sendError(res, 400, '多图生视频需要 1–9 张参考图片');
    }
    if (mode === 'keyframes' && references.length !== 2) {
      return sendError(res, 400, '首尾帧生视频需要正好 2 张图片：第一张为首帧，第二张为尾帧');
    }
    const expectedWorkflow = mode === 'text'
      ? AUTODL_VIDEO_WORKFLOW
      : mode === 'multi_image' ? AUTODL_IMAGE_VIDEO_WORKFLOW : AUTODL_KEYFRAME_VIDEO_WORKFLOW;
    const workflow = safeWorkflowId(body.workflow || expectedWorkflow);
    if (workflow !== expectedWorkflow) return sendError(res, 400, '生成方式与视频工作流不匹配');
    const parameters = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters)
      ? { ...body.parameters } : {};
    for (const key of Object.keys(parameters)) {
      if (/^ref_(?:image|audio|video)_\d+$/.test(key) || key === 'first_frame' || key === 'last_frame') delete parameters[key];
    }
    if (mode === 'multi_image') {
      references.forEach((reference, index) => { parameters[`ref_image_${index}`] = publicReferenceUrl(reference.id); });
    } else if (mode === 'keyframes') {
      parameters.first_frame = publicReferenceUrl(references[0].id);
      parameters.last_frame = publicReferenceUrl(references[1].id);
    }
    if (Object.keys(parameters).length > 30) return sendError(res, 400, '工作流参数过多');
    if (parameters.resolution != null && !AUTODL_VIDEO_RESOLUTIONS.has(String(parameters.resolution))) {
      return sendError(res, 400, '当前视频生成仅支持 9:16 竖屏', { allowed: [...AUTODL_VIDEO_RESOLUTIONS] });
    }
    if (parameters.duration != null) {
      const duration = Number(parameters.duration);
      if (!AUTODL_VIDEO_DURATIONS.has(duration)) {
        return sendError(res, 400, '当前视频生成仅支持 5 秒、10 秒或 15 秒', { allowed: [...AUTODL_VIDEO_DURATIONS] });
      }
    }
    if (videoGenerationSubmissionLocks.has(user.id)) {
      return sendError(res, 409, '当前视频正在提交，请勿重复点击');
    }
    videoGenerationSubmissionLocks.add(user.id);
    const promptAssetId = `prompt:${id('text')}`;
    db.assets[promptAssetId] = { id: promptAssetId, userId: user.id, kind: 'text', ext: '.txt',
      mime: 'text/plain; charset=utf-8', name: `提示词-${prompt.slice(0, 24)}.txt`, text: prompt,
      size: Buffer.byteLength(prompt), state: 'ready', source: 'prompt', createdAt: new Date().toISOString() };
    saveDb();
    let upstream;
    const saveSubmissionFailure = (err) => {
      const failed = { taskId: id('submission'), userId: user.id, status: 'FAILED', prompt, promptAssetId,
        workflow, mode, parameters, referenceIds, results: [], createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), failureStage: 'submission', error: err.message,
        errorCode: err.errorCode || 'PROVIDER_REQUEST_FAILED' };
      db.videoGenerations[failed.taskId] = failed;
      db.videoGenerationCurrent[user.id] = failed.taskId; saveDb();
      return serializeVideoGeneration(failed);
    };
    try {
      upstream = await autodlRequest(`/comfyui_workflow/${encodeURIComponent(workflow)}`, {
        method: 'POST',
        body: { ...parameters, prompt },
      });
    } catch (err) {
      const generation = saveSubmissionFailure(err);
      return sendError(res, err.status || 502, err.message, { generation, errorCode: err.errorCode, stage: 'submission' });
    } finally {
      videoGenerationSubmissionLocks.delete(user.id);
    }
    if (upstream?.code !== 'Success' || !upstream?.data?.task_id) {
      const err = new Error(upstream?.msg || 'AutoDL 未返回任务 ID');
      return sendError(res, 502, err.message, { generation: saveSubmissionFailure(err), stage: 'submission' });
    }
    const record = {
      taskId: upstream.data.task_id,
      userId: user.id,
      status: normalizeVideoGenerationStatus(upstream.data.status || 'QUEUED'),
      prompt,
      promptAssetId,
      workflow,
      mode,
      parameters,
      referenceIds,
      createdAt: upstream.data.created_at || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      duration: null,
      results: [],
    };
    db.videoGenerations[record.taskId] = record;
    db.videoGenerationCurrent[user.id] = record.taskId;
    registerGenerationAssets(record);
    saveDb();
    sendJson(res, 202, {
      ...serializeVideoGeneration(record),
    });
  },

  'GET /api/video-generations/current': async (req, res) => {
    const user = currentUser(req);
    if (!Object.hasOwn(db.videoGenerationCurrent, user.id)) {
      const latest = Object.values(db.videoGenerations).filter((item) => item.userId === user.id)
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0];
      db.videoGenerationCurrent[user.id] = latest && !latest.dismissedAt ? latest.taskId : null; saveDb();
    }
    let generation = videoGenerationForUser(user.id, true) || db.videoGenerations[db.videoGenerationCurrent[user.id]] || null;
    if (generation?.dismissedAt) generation = null;
    if (generation && VIDEO_GENERATION_ACTIVE.has(generation.status)) {
      try { await refreshVideoGeneration(generation); } catch { /* 前端继续轮询原状态 */ }
    }
    sendJson(res, 200, { generation: serializeVideoGeneration(generation) });
  },

  'DELETE /api/video-generations/:taskId': async (req, res, { params }) => {
    const generation = db.videoGenerations[params.taskId];
    if (!generation || generation.userId !== currentUser(req).id) return sendError(res, 404, '生成任务不存在');
    if (VIDEO_GENERATION_ACTIVE.has(generation.status)) return sendError(res, 409, '生成中的任务暂不能删除');
    registerGenerationAssets(generation);
    generation.dismissedAt = new Date().toISOString(); saveDb();
    if (db.videoGenerationCurrent[generation.userId] === generation.taskId) db.videoGenerationCurrent[generation.userId] = null;
    sendJson(res, 200, { deleted: true, assetsRetained: true });
  },

  'GET /api/video-generations/:taskId': async (req, res, { params }) => {
    const taskId = String(params.taskId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(taskId)) return sendError(res, 400, '任务 ID 无效');
    const generation = db.videoGenerations[taskId];
    if (!generation || generation.userId !== currentUser(req).id) return sendError(res, 404, '生成任务不存在');
    await refreshVideoGeneration(generation);
    sendJson(res, 200, serializeVideoGeneration(generation));
  },

  /* ---------------- 鉴权（无需登录即可访问的两个端点） ---------------- */
  'GET /api/auth/captcha': async (req, res) => {
    const ip = clientIp(req);
    const need = loginBlocked(ip) > 0 || (loginFails.get(ip)?.count || 0) >= 3;
    sendJson(res, 200, { required: need, ...(need ? issueCaptcha() : {}) });
  },

  'POST /api/auth/register': async (req, res) => {
    const ip = clientIp(req);
    const body = await readJsonBody(req);
    const needCaptcha = (loginFails.get(ip)?.count || 0) >= 3;
    if (needCaptcha && !checkCaptcha(body.captchaId, body.captchaAnswer)) {
      return sendError(res, 428, '请输入验证码', { captchaRequired: true, captcha: issueCaptcha() });
    }
    const phone = normalizePhone(body.phone);
    const password = String(body.password ?? '');
    if (!phone) return sendError(res, 400, '请输入正确的 11 位手机号');
    if (password.length < 6) return sendError(res, 400, '密码至少 6 位');
    if (findUserByPhone(db, phone)) return sendError(res, 409, '该手机号已注册，请直接登录');
    const user = createUser(db, { phone, password, welcomeCredits: Math.max(0, Number(process.env.WELCOME_CREDITS ?? 0)) });
    const { sid, expiresAt } = createUserSession(db, user.id);
    setSessionCookie(req, res, sid, (expiresAt - Date.now()) / 1000);
    saveDb();
    console.log('[auth] 注册 ' + phone.slice(0,3) + '****' + phone.slice(-4));
    sendJson(res, 201, { authenticated: true, user: publicUser(user), expiresAt: new Date(expiresAt).toISOString() });
  },

  'POST /api/auth/login': async (req, res) => {
    const ip = clientIp(req);
    const wait = loginBlocked(ip);
    if (wait) return sendError(res, 429, '尝试过于频繁，请 ' + wait + 's 后再试', { retryAfter: wait });
    const body = await readJsonBody(req);
    const needCaptcha = (loginFails.get(ip)?.count || 0) >= 3;
    if (needCaptcha && !checkCaptcha(body.captchaId, body.captchaAnswer)) {
      return sendError(res, 428, '请输入验证码', { captchaRequired: true, captcha: issueCaptcha() });
    }
    const phone = normalizePhone(body.phone);
    const password = String(body.password ?? '');
    if (!phone || !password) return sendError(res, 400, '请输入手机号和密码');
    const user = findUserByPhone(db, phone);
    if (!user || !checkPassword(user, password)) { noteLoginFail(ip); return sendError(res, 401, '手机号或密码不正确'); }
    if (user.status !== 'active') return sendError(res, 403, '账号已被停用');
    loginFails.delete(ip);
    user.lastLoginAt = new Date().toISOString();
    const { sid, expiresAt } = createUserSession(db, user.id);
    setSessionCookie(req, res, sid, (expiresAt - Date.now()) / 1000);
    saveDb();
    console.log('[auth] 登录 ' + phone.slice(0,3) + '****' + phone.slice(-4) + '，积分 ' + user.credits);
    sendJson(res, 200, { authenticated: true, user: publicUser(user), expiresAt: new Date(expiresAt).toISOString() });
  },

  'GET /api/me': async (req, res) => {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '未登录');
    sendJson(res, 200, { user: publicUser(user) });
  },

  'POST /api/credits/redeem': async (req, res) => {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '未登录');
    const body = await readJsonBody(req);
    const r = redeemCode(db, user, body.code);
    if (!r.ok) return sendError(res, 400, r.error);
    saveDb();
    sendJson(res, 200, { credits: r.credits, balance: r.balance, user: publicUser(user) });
  },

  /** 修改自己的密码（需旧密码） */
  'POST /api/me/password': async (req, res) => {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '未登录');
    const body = await readJsonBody(req);
    const oldPw = String(body.oldPassword ?? '');
    const newPw = String(body.newPassword ?? '');
    if (!checkPassword(user, oldPw)) return sendError(res, 400, '当前密码不正确');
    if (newPw.length < 6) return sendError(res, 400, '新密码至少 6 位');
    if (newPw === oldPw) return sendError(res, 400, '新密码不能与当前密码相同');
    setPassword(user, newPw);
    // 清掉其它会话，保留当前这个
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    for (const [k, v] of Object.entries(db.sessions)) if (k !== sid && v.userId === user.id) delete db.sessions[k];
    saveDb();
    console.log(`[auth] ${user.phone.slice(0,3)}****${user.phone.slice(-4)} 修改了密码`);
    sendJson(res, 200, { ok: true });
  },

  /** 管理员重置他人密码（无需旧密码） */
  'POST /api/admin/reset-password': async (req, res) => {
    const admin = currentUser(req);
    if (!admin || admin.role !== 'admin') return sendError(res, 403, '需要管理员权限');
    const body = await readJsonBody(req);
    const phone = normalizePhone(body.phone);
    const newPw = String(body.newPassword ?? '');
    if (!phone) return sendError(res, 400, '请输入正确的手机号');
    if (newPw.length < 6) return sendError(res, 400, '新密码至少 6 位');
    const target = findUserByPhone(db, phone);
    if (!target) return sendError(res, 404, '该手机号还没有注册');
    setPassword(target, newPw);
    for (const [k, v] of Object.entries(db.sessions)) if (v.userId === target.id) delete db.sessions[k];
    saveDb();
    console.log(`[admin] 重置了 ${phone.slice(0,3)}****${phone.slice(-4)} 的密码`);
    sendJson(res, 200, { ok: true });
  },

  /** 管理员：用户列表（含注册时间、最后登录、积分汇总） */
  'GET /api/admin/users': async (req, res) => {
    const admin = currentUser(req);
    if (!admin || admin.role !== 'admin') return sendError(res, 403, '需要管理员权限');
    const ledger = db.creditLedger || [];
    const summarize = (uid) => {
      let charged = 0, refunded = 0, redeemed = 0;
      for (const e of ledger) {
        if (e.userId !== uid) continue;
        if (e.delta < 0) charged += -e.delta;
        else if (String(e.reason).startsWith('refund')) refunded += e.delta;
        else if (e.reason === 'redeem') redeemed += e.delta;
      }
      return { charged, refunded, redeemed, entries: ledger.filter((e) => e.userId === uid).length };
    };
    const users = Object.values(db.users).map((u) => ({
      id: u.id, phone: u.phone, phoneMasked: publicUser(u).phone, credits: u.credits,
      role: u.role, whitelisted: !!u.whitelisted, suspended: u.suspended || null,
      rateHits: u.rateHits || 0, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
      ...summarize(u.id),
    })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    sendJson(res, 200, { users, total: users.length });
  },

  /** 管理员：某个用户的积分流水（最近 100 条） */
  'GET /api/admin/users/:id/ledger': async (req, res, { params }) => {
    const admin = currentUser(req);
    if (!admin || admin.role !== 'admin') return sendError(res, 403, '需要管理员权限');
    const user = db.users[params.id];
    if (!user) return sendError(res, 404, '用户不存在');
    const entries = (db.creditLedger || []).filter((e) => e.userId === user.id).slice(-100).reverse();
    sendJson(res, 200, { user: { id: user.id, phone: publicUser(user).phone, credits: user.credits }, entries });
  },

  /** 管理员：反作弊事件与用户风险状态 */
  'GET /api/admin/abuse': async (req, res) => {
    const admin = currentUser(req);
    if (!admin || admin.role !== 'admin') return sendError(res, 403, '需要管理员权限');
    const events = db.abuseEvents.slice(-200).reverse();
    const users = Object.values(db.users).map((u) => ({
      id: u.id, phone: u.phone, credits: u.credits, role: u.role,
      whitelisted: !!u.whitelisted, suspended: u.suspended || null, rateHits: u.rateHits || 0,
      createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
      charged: (db.creditLedger || []).filter((e) => e.userId === u.id && e.delta < 0)
        .reduce((sum, e) => sum - e.delta, 0),
    }));
    sendJson(res, 200, { events, users });
  },

  /** 管理员：白名单 / 解除 / 暂停 */
  'POST /api/admin/abuse/action': async (req, res) => {
    const admin = currentUser(req);
    if (!admin || admin.role !== 'admin') return sendError(res, 403, '需要管理员权限');
    const body = await readJsonBody(req);
    const target = db.users[body.userId] || findUserByPhone(db, normalizePhone(body.phone));
    if (!target) return sendError(res, 404, '用户不存在');
    const action = String(body.action || '');
    if (action === 'whitelist') { target.whitelisted = true; target.rateHits = 0; }
    else if (action === 'unwhitelist') { target.whitelisted = false; }
    else if (action === 'resume') { target.suspended = null; target.rateHits = 0; }
    else if (action === 'suspend') { target.suspended = { at: new Date().toISOString(), reason: String(body.reason || '管理员手动暂停') }; }
    else return sendError(res, 400, '未知操作');
    db.abuseEvents.push({ id: `ab_${Date.now().toString(36)}`, type: `admin:${action}`, userId: target.id, by: admin.id, at: new Date().toISOString() });
    saveDb();
    sendJson(res, 200, { ok: true, user: { id: target.id, phone: target.phone, whitelisted: !!target.whitelisted, suspended: target.suspended || null } });
  },
  /** 管理员：删除卡密（已兑换的不可删，保兑换记录） */
  'DELETE /api/admin/codes/:code': async (req, res, { params }) => {
    const admin = currentUser(req);
    if (!admin || admin.role !== 'admin') return sendError(res, 403, '需要管理员权限');
    const code = String(params.code || '').toUpperCase();
    const rec = db.redemptionCodes?.[code];
    if (!rec) return sendError(res, 404, '卡密不存在或已删除');
    if (rec.usedBy) return sendError(res, 409, '该卡密已被兑换，删除会丢失兑换记录，已拒绝');
    delete db.redemptionCodes[code];
    db.abuseEvents.push({ id: `ab_${Date.now().toString(36)}`, type: 'admin:delete-code', code, by: admin.id, at: new Date().toISOString() });
    saveDb();
    console.log(`[admin] 删除卡密 ${code}`);
    sendJson(res, 200, { ok: true, code });
  },

  /** 管理员：卡密列表（含兑换记录，可按状态筛选） */
  'GET /api/admin/codes': async (req, res) => {
    const admin = currentUser(req);
    if (!admin || admin.role !== 'admin') return sendError(res, 403, '需要管理员权限');
    const status = String(new URL(req.url, 'http://x').searchParams.get('status') || 'all');
    const all = Object.values(db.redemptionCodes || {});
    const phoneOf = (uid) => (uid && db.users[uid] ? db.users[uid].phone : null);
    const rows = all.map((c) => ({
      code: c.code, credits: c.credits, createdAt: c.createdAt, createdBy: phoneOf(c.createdBy),
      usedById: c.usedBy || null, usedBy: phoneOf(c.usedBy), usedAt: c.usedAt || null,
    }))
      .filter((r) => (status === 'used' ? r.usedAt : status === 'unused' ? !r.usedAt : true))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    sendJson(res, 200, { codes: rows, total: all.length, used: all.filter((c) => c.usedAt).length,
      unused: all.filter((c) => !c.usedAt).length,
      creditsIssued: all.reduce((n, c) => n + (c.credits || 0), 0),
      creditsRedeemed: all.filter((c) => c.usedAt).reduce((n, c) => n + (c.credits || 0), 0) });
  },


  'POST /api/admin/codes': async (req, res) => {
    const user = currentUser(req);
    if (!user || user.role !== 'admin') return sendError(res, 403, '需要管理员权限');
    const body = await readJsonBody(req);
    const codes = createCodes(db, { count: body.count, credits: body.credits, createdBy: user.id });
    saveDb();
    sendJson(res, 201, { codes });
  },


  'GET /api/auth/session': async (req, res) => {
    const session = currentSession(req);
    if (!session) {
      setSessionCookie(req, res, '', 0);
      return sendJson(res, 200, {
        authenticated: false,
        expiresAt: null,
        sessionTtlMs: SESSION_TTL_MS,
      });
    }
    sendJson(res, 200, {
      authenticated: true,
      user: publicUser(session.userId ? db.users[session.userId] : null),
      expiresAt: new Date(session.expiresAt).toISOString(),
      sessionTtlMs: SESSION_TTL_MS,
      createdAt: session.createdAt,
    });
  },

  'POST /api/auth/logout': async (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid && db.sessions[sid]) {
      delete db.sessions[sid];
      saveDb();
    }
    setSessionCookie(req, res, '', 0);
    console.log('[auth] 已退出登录');
    sendJson(res, 200, { authenticated: false });
  },

  /* ---------------- 维护：手动触发过期清理（便于联调） ---------------- */
  'POST /api/maintenance/sweep': async (req, res) => {
    const result = await sweepExpired('manual');
    sendJson(res, 200, { swept: result, ttlHours: UPLOAD_TTL_MS / 3600000 });
  },

  'POST /api/uploads': handleUpload,
  'POST /api/video-references': handleReferenceUpload,

  /** 秒传预检：先问「这个 MD5 你有没有」，有就不传了 */
  'POST /api/uploads/precheck': handlePrecheck,

  /** 发起处理：返回 taskId */
  'POST /api/files/:id/process': async (req, res, { params }) => {
    const file = db.files[params.id];
    if (!file) return sendError(res, 404, '文件不存在');
    assertFileAccess(file, currentUser(req));
    if (isFileExpired(file)) {
      return sendError(res, 410, `源文件已过期（超过 ${ttlHours()} 小时）并被删除，请重新上传`, { expiresAt: new Date(fileExpiresAt(file)).toISOString() });
    }
    const body = await readJsonBody(req);
    const operation = body.operation || DEFAULT_OPERATION;
    if (!OPERATIONS[operation]) return sendError(res, 400, `未知的处理类型 ${operation}`, { allowed: Object.keys(OPERATIONS) });
    if (operationNeedsCloud(operation) && !eraseApi.ready) {
      return sendError(res, 503, '云端处理服务尚未就绪，请联系管理员开通后再试', {
        endpoint: eraseApi.endpoint, missing: eraseApi.missing,
      });
    }
    if (operation === 'enhance' && body.resolution !== undefined && !ENHANCE_RESOLUTIONS.includes(String(body.resolution))) {
      return sendError(res, 400, `未知的超清分辨率 ${body.resolution}`, { allowed: ENHANCE_RESOLUTIONS });
    }
    if (body.toolVersion != null && !ENHANCE_VERSIONS.includes(String(body.toolVersion))) {
      return sendError(res, 400, `未知的超清版本 ${body.toolVersion}`, { allowed: ENHANCE_VERSIONS });
    }
    if (body.options != null && (typeof body.options !== 'object' || Array.isArray(body.options))) {
      return sendError(res, 400, 'options 必须是对象');
    }

    // 计费只使用服务端核实的视频时长。
    await fileDuration(file);
    const eff = applyErasePreset({ preset: body.erasePreset, region: body.eraseRegion, mode: body.eraseMode, model: body.modelVersion });
    const task = createTaskForFile(file, {
      operation,
      userId: currentUser(req)?.id,
      enhance: body.enhance === true,
      eraseRegion: eff.region,
      eraseMode: eff.mode,
      modelVersion: eff.model,
      resolution: body.resolution || null,
      toolVersion: body.toolVersion || null,
      options: body.options && typeof body.options === 'object' ? body.options : null,
    });
    try { await startTask(task, currentUser(req)); }
    catch (err) { refundTaskCredits(task, 'refund:failed'); delete db.tasks[task.id]; saveDb(); throw err; }
    console.log(`[task] ${task.id} 去字幕 <- ${file.id}`);
    sendJson(res, 202, { task: serializeTask(task), poll: `/api/tasks/${task.id}` });
  },

  /**
   * 建批次：一次提交一批文件（≤ MAX_BATCH_SIZE）。
   * 只建任务记录，不立刻开始 —— 具体哪些任务开始，由「全部开始」或单行「开始任务」决定。
   */
  'POST /api/batches': async (req, res) => {
    const diskCheck = diskGuard();
    if (!diskCheck.ok) {
      return sendError(res, 507, diskLowMessage(diskCheck.free), { freeBytes: diskCheck.free, minFreeBytes: diskCheck.minFree });
    }
    const body = await readJsonBody(req);
    // 注意：这里不去重 —— 用户选了 4 个文件就要有 4 行。
    // 「内容相同的行」由 createBatch 按 MD5 合并成同一个任务，并在该行标记 shared（界面显示"已跳过·复用"）。
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((x) => typeof x === 'string') : [];
    if (!fileIds.length) return sendError(res, 400, '请至少选择一个文件');
    if (fileIds.length > MAX_BATCH_SIZE) {
      return sendError(res, 400, `一批最多 ${MAX_BATCH_SIZE} 个文件（当前 ${fileIds.length} 个）`, { maxBatchSize: MAX_BATCH_SIZE });
    }
    const operation = body.operation || DEFAULT_OPERATION;
    if (!OPERATIONS[operation]) return sendError(res, 400, `未知的处理类型 ${operation}`, { allowed: Object.keys(OPERATIONS) });
    if (operationNeedsCloud(operation) && !eraseApi.ready) {
      return sendError(res, 503, '云端处理服务尚未就绪，请联系管理员开通后再试', {
        endpoint: eraseApi.endpoint, missing: eraseApi.missing,
      });
    }
    if (body.resolution != null && !ENHANCE_RESOLUTIONS.includes(String(body.resolution))) {
      return sendError(res, 400, `未知的超清分辨率 ${body.resolution}`, { allowed: ENHANCE_RESOLUTIONS });
    }
    if (body.toolVersion != null && !ENHANCE_VERSIONS.includes(String(body.toolVersion))) {
      return sendError(res, 400, `未知的超清版本 ${body.toolVersion}`, { allowed: ENHANCE_VERSIONS });
    }
    // 各功能的选项（语音转字幕：语种/是否烧录；压缩转码：预设）
    let options = body.options && typeof body.options === 'object' ? body.options : null;
    if (operation === 'asr-subtitles') {
      options = { language: String(options?.language || 'auto'), burn: options?.burn === true };
      if (!ASR_LANGUAGES.includes(options.language)) return sendError(res, 400, `未知的识别语种 ${options.language}`, { allowed: ASR_LANGUAGES });
    } else if (operation === 'transcode') {
      options = { profile: String(options?.profile || '1080p') };
      if (!TRANSCODE_PROFILES.includes(options.profile)) return sendError(res, 400, `未知的压缩预设 ${options.profile}`, { allowed: TRANSCODE_PROFILES });
    } else if (operation === 'ocr-extract') {
      options = { mode: String(options?.mode || 'Subtitle') };
      if (!OCR_MODES.includes(options.mode)) return sendError(res, 400, `未知的识别模式 ${options.mode}`, { allowed: OCR_MODES });
    } else if (operation === 'face-blur') {
      options = { maskMode: String(options?.maskMode || 'mosaic'), strength: String(options?.strength || 'medium') };
      if (!FACE_MASK_MODES.includes(options.maskMode)) return sendError(res, 400, `未知的打码方式 ${options.maskMode}`, { allowed: FACE_MASK_MODES });
      if (!FACE_STRENGTHS.includes(options.strength)) return sendError(res, 400, `未知的打码强度 ${options.strength}`, { allowed: FACE_STRENGTHS });
    } else if (operation === 'portrait-matte') {
      options = { background: String(options?.background || 'green') };
      if (!MATTE_BACKGROUNDS.includes(options.background)) return sendError(res, 400, `未知的底色 ${options.background}`, { allowed: MATTE_BACKGROUNDS });
    } else if (operation === 'region-blur') {
      const pct = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : d; };
      options = { mode: String(options?.mode || 'delogo'), x: pct(options?.x, 70), y: pct(options?.y, 5), w: pct(options?.w, 25), h: pct(options?.h, 15) };
      if (!REGION_MODES.includes(options.mode)) return sendError(res, 400, `未知的区域处理方式 ${options.mode}`, { allowed: REGION_MODES });
      if (options.w <= 0 || options.h <= 0) return sendError(res, 400, '区域宽高必须大于 0（按百分比填写）');
    } else {
      options = null;
    }

    const files = [];
    for (const fid of fileIds) {
      const file = db.files[fid];
      if (!file) return sendError(res, 404, `文件不存在或已被清理：${fid}`);
      assertFileAccess(file, currentUser(req));
      if (isFileExpired(file)) return sendError(res, 410, `源文件已过期：${file.name}`, { fileId: fid });
      files.push(file);
    }
    await Promise.all(files.map(fileDuration));
    if (files.some((f) => db.files[f.id] !== f || isFileExpired(f))) return sendError(res, 410, '源文件已过期或被删除');

    // 磁盘预判：产物约为源文件的 DISK_OUTPUT_FACTOR 倍，留出安全余量
    // 磁盘预估按"唯一内容"算（同一个文件被选多次不该重复占用）
    const inputBytes = [...new Map(files.map((f) => [f.md5, f])).values()].reduce((a, f) => a + (f.size || 0), 0);
    const needBytes = Math.round(inputBytes * DISK_OUTPUT_FACTOR);
    const free = freeDiskBytes();
    if (free !== null && free < needBytes + DISK_RESERVE_BYTES) {
      return sendError(res, 507, '服务器磁盘空间不足，无法接收这批任务', {
        needBytes, freeBytes: free, reserveBytes: DISK_RESERVE_BYTES,
      });
    }

    const batch = createBatch({
    userId: currentUser(req)?.id || null, enhance: body.enhance === true, fileIds, operation, durations: body.durations || {}, erasePreset: body.erasePreset, eraseRegion: body.eraseRegion, eraseMode: body.eraseMode, modelVersion: body.modelVersion, resolution: body.resolution || null, toolVersion: body.toolVersion || null, options });
    sendJson(res, 202, { ...serializeBatch(batch), poll: `/api/batches/${batch.id}` });
  },

  'GET /api/batches/:id': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    sendJson(res, 200, { ...serializeBatch(batch), poll: `/api/batches/${batch.id}` });
  },

  /** 分批添加：往已有批次里追加文件（内容相同的行会复用批次内已有的任务） */
  'POST /api/batches/:id/items': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    if (operationNeedsCloud(batch.operation) && !eraseApi.ready) {
      return sendError(res, 503, '云端处理服务尚未就绪，请联系管理员开通后再试', {
        endpoint: eraseApi.endpoint, missing: eraseApi.missing,
      });
    }
    const diskCheck = diskGuard();
    if (!diskCheck.ok) {
      return sendError(res, 507, diskLowMessage(diskCheck.free), { freeBytes: diskCheck.free, minFreeBytes: diskCheck.minFree });
    }
    const body = await readJsonBody(req);
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((x) => typeof x === 'string') : [];
    if (!fileIds.length) return sendError(res, 400, '没有要追加的文件');
    if (batch.items.length + fileIds.length > MAX_BATCH_SIZE) {
      return sendError(res, 400, `一批最多 ${MAX_BATCH_SIZE} 个文件（已有 ${batch.items.length} 个，本次 ${fileIds.length} 个）`, { maxBatchSize: MAX_BATCH_SIZE });
    }
    const files = [];
    for (const fid of fileIds) {
      const file = db.files[fid];
      if (!file) return sendError(res, 404, `文件不存在或已被清理：${fid}`);
      assertFileAccess(file, currentUser(req));
      if (isFileExpired(file)) return sendError(res, 410, `源文件已过期：${file.name}`, { fileId: fid });
      files.push(file);
    }
    await Promise.all(files.map(fileDuration));
    if (files.some((f) => db.files[f.id] !== f || isFileExpired(f))) return sendError(res, 410, '源文件已过期或被删除');
    const inputBytes = [...new Map(files.map((f) => [f.md5, f])).values()].reduce((a, f) => a + (f.size || 0), 0);
    const needBytes = Math.round(inputBytes * DISK_OUTPUT_FACTOR);
    const free = freeDiskBytes();
    if (free !== null && free < needBytes + DISK_RESERVE_BYTES) {
      return sendError(res, 507, '服务器磁盘空间不足，无法接收这批任务', { needBytes, freeBytes: free, reserveBytes: DISK_RESERVE_BYTES });
    }
    if (batch.items.length + fileIds.length > MAX_BATCH_SIZE) return sendError(res, 400, `一批最多 ${MAX_BATCH_SIZE} 个文件`);
    const added = appendFilesToBatch(batch, fileIds, body.durations || {}, {
      erasePreset: batch.erasePreset,
      enhance: batch.enhance,
      eraseRegion: batch.eraseRegion,
      eraseMode: batch.eraseMode,
      modelVersion: batch.modelVersion,
      resolution: batch.resolution,
      toolVersion: batch.toolVersion,
      options: batch.options,
    });
    saveDb();
    console.log(`[batch] ${batch.id} 追加 ${added.length} 个文件（其中 ${added.filter((a) => a.shared).length} 个复用已有任务），现共 ${batch.items.length} 个`);
    sendJson(res, 202, { added: added.length, ...serializeBatch(batch), poll: `/api/batches/${batch.id}` });
  },

  /** 修改这一批的擦除区域：只影响还没开始（pending）的任务；已在跑的不动 */
  'PATCH /api/batches/:id': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    const body = await readJsonBody(req).catch(() => ({}));
    const presetGiven = body.erasePreset !== undefined;
    if (presetGiven && !ERASE_PRESET_KEYS.includes(String(body.erasePreset))) {
      return sendError(res, 400, `未知的处理模式 ${body.erasePreset}`, { allowed: ERASE_PRESET_KEYS });
    }
    const key = String(body.eraseRegion || 'auto');
    if (body.eraseRegion !== undefined && !Object.prototype.hasOwnProperty.call(ERASE_REGIONS, key)) {
      return sendError(res, 400, `未知的擦除区域 ${key}`, { allowed: Object.keys(ERASE_REGIONS) });
    }
    const mode = body.eraseMode === undefined ? null : resolveEraseMode(body.eraseMode);
    const model = body.modelVersion === undefined ? null : resolveModelVersion(body.modelVersion);
    if (body.eraseMode !== undefined && !ERASE_MODES.includes(String(body.eraseMode))) {
      return sendError(res, 400, `未知的擦除模式 ${body.eraseMode}`, { allowed: ERASE_MODES });
    }
    const nextPreset = presetGiven ? resolveErasePreset(body.erasePreset) : resolveErasePreset(batch.erasePreset);
    const eff = applyErasePreset({
      preset: nextPreset,
      region: body.eraseRegion === undefined ? undefined : key,
      mode: body.eraseMode === undefined ? undefined : body.eraseMode,
      model: body.modelVersion === undefined ? undefined : body.modelVersion,
    });
    batch.erasePreset = eff.preset;
    // 批次是「追加文件」时的参数来源：必须保存解析后的完整设置，
    // 否则改预设后追加的任务仍是旧 mode/model（实测出现过 f1=Text/v5.6、f2=Subtitle/null）
    batch.eraseRegion = eff.region;
    batch.eraseMode = eff.mode;
    batch.modelVersion = eff.model;
    let updated = 0;
    let running = 0;
    const updatedTasks = new Set();
    const replacements = new Map();
    for (const item of batch.items) {
      let t = db.tasks[item.taskId];
      if (!t) continue;
      if (t.status === 'processing' || executing.has(t.id) || queue.includes(t.id)) { running += 1; continue; }
      if (t.status === 'succeeded' || t.status === 'expired') continue;
      const sharedOutside = Object.entries(db.batches || {}).some(([bid, other]) =>
        bid !== batch.id && (other.items || []).some((otherItem) => otherItem.taskId === t.id));
      if (sharedOutside) {
        let replacement = replacements.get(t.id);
        if (!replacement) {
          const file = db.files[t.fileId];
          if (!file) continue;
          replacement = createTaskForFile(file, {
            operation: t.operation,
            userId: t.userId,
            enhance: t.enhance,
            eraseRegion: eff.region,
            eraseMode: eff.mode,
            modelVersion: eff.model,
            resolution: t.resolution,
            toolVersion: t.toolVersion,
            options: t.options,
          });
          replacement.erasePreset = eff.preset;
          replacements.set(t.id, replacement);
          updated += 1;
        }
        item.taskId = replacement.id;
        item.shared = false;
        item.reused = false;
        item.attached = false;
        item.sharedWithFileId = null;
        continue;
      }
      if (updatedTasks.has(t.id)) continue;
      updatedTasks.add(t.id);
      t.eraseRatioLocation = eff.region;
      t.mode = eff.mode;
      t.modelVersion = eff.model;
      t.erasePreset = eff.preset;
      if (t.status === 'pending') updated += 1;
    }
    batch.taskIds = [...new Set(batch.items.map((item) => item.taskId).filter(Boolean))];
    saveDb();
    console.log(`[batch] ${batch.id} 擦除区域改为 ${key}（更新 ${updated} 个待开始任务${running ? `，${running} 个进行中不变` : ''}）`);
    sendJson(res, 200, { updated, running, ...serializeBatch(batch) });
  },

  /** 全部开始：把这一批里"未开始 / 失败 / 已取消"的任务一起排队 */
  'POST /api/batches/:id/start': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    if (operationNeedsCloud(batch.operation) && !eraseApi.ready
      && batch.taskIds.some((tid) => db.tasks[tid]?.sourcePlatform !== 'douyin')) {
      return sendError(res, 503, '云端处理服务尚未就绪，请联系管理员开通后再试', {
        endpoint: eraseApi.endpoint, missing: eraseApi.missing,
      });
    }
    const body = await readJsonBody(req).catch(() => ({}));
    const diskCheck = diskGuard();
    if (!diskCheck.ok) {
      return sendError(res, 507, diskLowMessage(diskCheck.free), { freeBytes: diskCheck.free, minFreeBytes: diskCheck.minFree });
    }
    const picked = pickedIndexes(req, body, batch.items.length);
    const insufficient = [];
    const errors = [];
    let started = 0;
    const user = currentUser(req);
    for (const tid of new Set(picked.map((idx) => batch.items[idx]?.taskId))) {
      const task = db.tasks[tid];
      if (!task || task.status === 'processing' || task.status === 'succeeded') continue;
      try { if (await startTask(task, user)) started += 1; }
      catch (err) {
        if (err.status === 402) insufficient.push(task.fileName || task.id);
        else errors.push({ taskId: tid, error: err.message });
      }
    }
    saveDb();
    console.log(`[batch] ${batch.id} 批量开始：勾选 ${picked.length} 行 → 排队 ${started} 个任务`);
    sendJson(res, 202, {
      started, insufficient, errors, poll: `/api/batches/${batch.id}`,
      ...(insufficient.length ? { error: `积分不足，${insufficient.length} 个未开始，请充值后重试` } : {}),
      ...serializeBatch(batch),
    });
  },

/**
   * 清理一个上传文件（用于"还没建批次就移除"的行）：
   * 只有没有任何批次行/任务引用它时才允许，免得删掉别人正在用的源文件。
   */
  /**
   * 链接去水印：粘贴公网视频直链 → 服务端探测时长 → 建任务（全屏文字模式）→ 立即开始
   *   源文件不上传到本服务器；云端直接从该地址拉取
   */
  'POST /api/tasks/from-url': async (req, res) => {
    const body = await readJsonBody(req);
    const raw = extractVideoLinks(body.url)[0];
    if (!raw) return sendError(res, 400, '请粘贴视频链接或抖音分享文案');
    const me = currentUser(req);
    if (!me) return sendError(res, 401, '请重新登录');
    const dg = diskGuard();
    if (!dg.ok) return sendError(res, 507, diskLowMessage(dg.free));
    const info = parseVideoUrl(raw);
    await assertPublicRemoteUrl(info.url);
    const eff = applyErasePreset({ preset: 'fullscreen' });
    let task;
    if (info.platform === 'douyin') {
      const file = await importDouyinVideo(info, me);
      task = createTaskForFile(file, { userId: me.id, eraseRegion: eff.region, eraseMode: eff.mode, modelVersion: eff.model });
      task.sourcePlatform = 'douyin'; task.sourceQuality = file.sourceQuality; task.operationLabel = '抖音视频去水印';
    } else {
      if (!eraseApi.ready) return sendError(res, 503, '云端处理服务尚未就绪，请联系管理员');
      const duration = await probeVideoDuration(info.url);
      task = createUrlTask(info, me, eff);
      task.durationSec = duration; task.durationVerified = true;
    }
    task.erasePreset = eff.preset;
    try { await startTask(task, me); }
    catch (err) { refundTaskCredits(task, 'refund:failed'); delete db.tasks[task.id]; saveDb(); throw err; }
    sendJson(res, 202, { task: serializeTask(task), poll: `/api/tasks/${task.id}` });
  },

  /** 分享文案和直链共用批次列表；抖音选择中等码率并保存到本地。 */
  'POST /api/batches/from-urls': async (req, res) => {
    const body = await readJsonBody(req);
    const urls = extractVideoLinks(body.urls);
    if (!urls.length) return sendError(res, 400, '请粘贴视频链接或抖音分享文案');
    if (urls.length > MAX_BATCH_SIZE) return sendError(res, 400, `一批最多 ${MAX_BATCH_SIZE} 个链接`);
    const dg = diskGuard();
    if (!dg.ok) return sendError(res, 507, diskLowMessage(dg.free));
    const me = currentUser(req);
    if (!me) return sendError(res, 401, '请重新登录');
    const eff = applyErasePreset({ preset: 'fullscreen' });
    const batch = { id: id('batch'), createdAt: new Date().toISOString(), operation: DEFAULT_OPERATION,
      erasePreset: eff.preset, enhance: false, resolution: null, userId: me.id, taskIds: [], items: [] };
    const skipped = [];
    for (const raw of urls) {
      try {
        const info = parseVideoUrl(raw);
        await assertPublicRemoteUrl(info.url);
        let task;
        let fileId = null;
        if (info.platform === 'douyin') {
          const file = await importDouyinVideo(info, me);
          fileId = file.id;
          task = createTaskForFile(file, { userId: me.id, eraseRegion: eff.region, eraseMode: eff.mode, modelVersion: eff.model });
          task.sourcePlatform = 'douyin'; task.sourceQuality = file.sourceQuality;
          task.operationLabel = '抖音视频去水印'; task.estimatedSeconds = 5; task.etaSeconds = 5;
        } else {
          if (!eraseApi.ready) throw new Error('云端处理服务尚未就绪，请联系管理员');
          const duration = await probePool.run(() => probeVideoDuration(info.url));
          task = createUrlTask(info, me, eff);
          task.durationSec = duration; task.durationVerified = true;
          task.estimatedSeconds = Math.max(MIN_ESTIMATE_SEC, Math.round(duration * currentRtf(task.mode)));
          task.etaSeconds = task.estimatedSeconds;
        }
        task.erasePreset = eff.preset;
        batch.items.push({ fileId, taskId: task.id, shared: false, reused: false, attached: false, sharedWithFileId: null });
        batch.taskIds.push(task.id);
      } catch (err) { skipped.push({ url: raw, reason: err.message }); }
    }
    if (!batch.items.length) return sendError(res, 422, skipped[0]?.reason || '没有可处理的链接', { skipped });
    db.batches[batch.id] = batch; saveDb();
    sendJson(res, 202, { ...serializeBatch(batch), skipped, poll: `/api/batches/${batch.id}` });
  },

  /** 把一个批次里「已完成」的产物打成一个 zip 流式下载（不落盘，边下边打） */
  'GET /api/batches/:id/zip': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    const done = (batch.items || [])
      .map((it) => db.tasks[it.taskId])
      .filter((t) => t && t.status === 'succeeded' && t.result);
    if (!done.length) return sendError(res, 409, '这个批次还没有已完成的产物');
    if (done.length > MAX_BATCH_SIZE) return sendError(res, 400, `一次最多打包 ${MAX_BATCH_SIZE} 个`);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const zipName = `clipflow-${stamp}.zip`;
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="clipflow-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      'cache-control': 'no-store',
    });
    const zip = new ZipStream(res);
    const used = new Set();
    let added = 0;
    try {
      for (const task of done) {
        let name = sanitizeName(task.result.name || `${task.fileName || task.id}.mp4`) || `${task.id}.mp4`;
        if (used.has(name)) {
          const dot = name.lastIndexOf('.');
          const base = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : '';
          let i = 2;
          while (used.has(`${base} (${i})${ext}`)) i += 1;
          name = `${base} (${i})${ext}`;
        }
        used.add(name);
        const localPath = path.join(OUTPUT_DIR, task.id, task.result.srt ? 'subtitle.srt' : 'output.mp4');
        const useLocal = !task.result.remote && await fsp.stat(localPath).then((s) => s.isFile()).catch(() => false);
        if (useLocal) {
          const { createReadStream } = await import('node:fs');
          await zip.addStream(name, task.result.size || 0, () => createReadStream(localPath));
        } else if (task.remoteResultUrl) {
          await zip.addStream(name, task.result.size || 0, () => streamRemote(task.remoteResultUrl));
        } else {
          continue; // 既没有本地也没有云端地址：跳过
        }
        added += 1;
      }
      await zip.finish();
      res.end();
      console.log(`[zip] ${batch.id} 打包 ${added}/${done.length} 个产物`);
    } catch (err) {
      console.error('[zip]', err.message);
      if (!res.headersSent) sendError(res, 500, '打包失败，请稍后重试');
      else res.destroy(err);
    }
  },

  /** 任务中心：当前用户的所有处理任务（含进行中/失败） */
  'GET /api/tasks': async (req, res) => {
    const me = currentUser(req);
    if (!me) return sendError(res, 401, '请重新登录');
    const list = Object.values(db.tasks || {})
      .filter((t) => t.userId === me.id)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, 200)
      .map((t) => ({
        id: t.id, operation: t.operation, operationLabel: OPERATIONS[t.operation]?.label || t.operation,
        status: t.status, started: !!t.started, progress: t.progress || 0, stage: t.stage || '', stageKey: t.stageKey || null,
        fileName: t.fileName || '', durationSec: t.durationSec || null,
        chargedCredits: t.chargedCredits || 0, error: t.error || null,
        createdAt: t.createdAt, finishedAt: t.finishedAt || null,
        result: t.result ? { name: t.result.name, size: t.result.size || 0, remote: !!t.result.remote, srt: !!t.result.srt } : null,
        downloadUrl: t.status === 'succeeded' ? `/api/download/${t.id}` : null,
        previewUrl: t.status === 'succeeded' && t.result?.hasVideo ? `/api/artifacts/${t.id}/video` : null,
      }));
    sendJson(res, 200, { tasks: list, total: list.length });
  },

  /** 资产与任务独立保存；删除任务展示不会删除素材。 */
  'GET /api/assets': async (req, res) => {
    const user = currentUser(req);
    syncUserAssets(user.id);
    const assets = Object.values(db.assets).filter((asset) => asset.userId === user.id)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(serializeAsset);
    const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
    sendJson(res, 200, { assets, total: assets.length, totalBytes, totalText: formatBytes(totalBytes) });
  },

  /** 源文件缩略图（懒生成 + 磁盘缓存） */
  'GET /api/thumb/file/:id': async (req, res, { params }) => {
    const file = db.files[params.id];
    if (!file) return sendError(res, 404, '文件不存在');
    assertFileAccess(file, currentUser(req));
    const dest = await ensureThumb(file);
    if (!dest) return sendError(res, 422, '缩略图生成失败');
    serveFile(req, res, dest, { mime: 'image/jpeg', cache: 'private, no-store' });
  },

  'DELETE /api/files/:id': async (req, res, { params }) => {
    const file = db.files[params.id];
    if (!file) return sendError(res, 404, '文件不存在');
    assertFileAccess(file, currentUser(req));
    const purge = await purgeContent({ fileId: file.id });
    if (!purge.removedFile) return sendError(res, 409, purge.keptFile || '该文件仍被使用，暂不能清理');
    saveDb();
    console.log(`[file] ${file.name} (${file.id}) 已清理${purge.removedMd5 ? '（含 MD5 索引）' : ''}，释放 ${formatBytes(purge.freedBytes)}`);
    sendJson(res, 200, purge);
  },

/**
   * 批量删除批次里的若干行（勾选后一次删掉）：与单行「移除任务」同样**彻底清理**
   *   —— 源文件 + 产物 + db.files + db.md5Index + db.results + 产物目录 + 行引用
   * 只要勾选的行里有正在处理的任务，就整体拒绝（避免删掉云端正在读取的源文件）。
   */
  'DELETE /api/batches/:id/items': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    const body = await readJsonBody(req).catch(() => ({}));
    const indexes = pickedIndexes(req, body, batch.items.length);
    const picked = indexes.filter((i) => batch.items[i]);
    if (!picked.length) return sendError(res, 400, '没有要删除的任务');

    const blocked = picked.filter((i) => {
      const t = db.tasks[batch.items[i].taskId];
      return t && t.status === 'processing';
    });
    if (blocked.length) {
      return sendError(res, 409, `勾选的任务里有 ${blocked.length} 个正在处理中，请先停止后再删除`, {
        blocked: blocked.map((i) => i + 1),
      });
    }

    const done = { removed: 0, removedFiles: 0, removedTasks: 0, removedMd5: 0, freedBytes: 0, kept: [] };
    // 倒序删除：行号不会因为前面的行被删掉而错位
    for (const idx of [...picked].sort((a, b) => b - a)) {
      const item = batch.items[idx];
      if (!item) continue;
      batch.items.splice(idx, 1);
      const purge = await purgeContent({ fileId: item.fileId, taskId: item.taskId });
      if (item.taskId) batch.taskIds = (batch.taskIds || []).filter((t) => t !== item.taskId);
      done.removed += 1;
      if (purge.removedFile) done.removedFiles += 1;
      if (purge.removedTask) done.removedTasks += 1;
      if (purge.removedMd5) done.removedMd5 += 1;
      done.freedBytes += purge.freedBytes;
      if (purge.keptFile || purge.keptTask) {
        done.kept.push({ row: idx + 1, reason: [purge.keptFile, purge.keptTask].filter(Boolean).join('；') });
      }
    }
    saveDb();
    console.log(
      `[batch] ${batch.id} 批量删除 ${done.removed} 行 → 源文件 ${done.removedFiles} 个、产物 ${done.removedTasks} 个、` +
      `MD5 索引 ${done.removedMd5} 条，释放 ${formatBytes(done.freedBytes)}` +
      (done.kept.length ? `；${done.kept.length} 行因仍被引用而保留` : ''),
    );
    sendJson(res, 200, { ...done, ...serializeBatch(batch) });
  },

      /**
   * 移除批次里的一行（按行号定位，避免同一文件被选多次时歧义）。
   * 规则：处理中的任务不能移除；未开始 / 已完成 / 失败 都可以移除。
   * 若该行引用的任务不再被其它行复用，则连带删除任务记录与产出的产物文件（释放磁盘）。
   */
  'DELETE /api/batches/:batchId/items/:index': async (req, res, { params }) => {
    const batch = db.batches?.[params.batchId];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    const idx = Number(params.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= batch.items.length) {
      return sendError(res, 400, '行号无效');
    }
    const item = batch.items[idx];
    const task = item.taskId ? db.tasks[item.taskId] : null;
    if (task && task.status === 'processing') {
      return sendError(res, 409, '任务正在处理中，不能移除（可先停止任务）');
    }
batch.items.splice(idx, 1);
      // 彻底清理：源文件 + 产物 + MD5 索引 + 内容索引（若仍被其它行引用则保留）
      const purge = await purgeContent({ fileId: item.fileId, taskId: item.taskId });
      if (task) batch.taskIds = (batch.taskIds || []).filter((t) => t !== task.id);
      saveDb();
      console.log(
        `[batch] ${batch.id} 移除第 ${idx + 1} 行 → 源文件${purge.removedFile ? '已删' : '保留'}` +
        `、产物${purge.removedTask ? '已删' : '保留'}${purge.removedMd5 ? '、MD5 索引已删' : ''}，释放 ${formatBytes(purge.freedBytes)}`,
      );
      sendJson(res, 200, { ...purge, ...serializeBatch(batch) });
  },

  /** 全部取消：停掉这一批里进行中的任务；未提交到接口的直接回到"待开始" */
  'DELETE /api/batches/:id': async (req, res, { params }) => {
    const batch = db.batches?.[params.id];
    if (!batch) return sendError(res, 404, '批次不存在或已被清理');
    const body = await readJsonBody(req).catch(() => ({}));
    const picked = pickedIndexes(req, body, batch.items.length);
    let canceled = 0;
    for (const tid of new Set(picked.map((idx) => batch.items[idx]?.taskId))) {
      const task = db.tasks[tid];
      if (task) assertTaskOwner(task, currentUser(req));
      if (cancelTask(task)) canceled += 1;
    }
    sendJson(res, 200, { canceled, cancel: { background: canceled > 0 }, ...serializeBatch(batch) });
  },

  /** 单任务「开始任务」：把失败/已取消/未开始的任务重新排队（已完成需 force） */
  'POST /api/tasks/:id/start': async (req, res, { params }) => {
    const task = db.tasks[params.id];
    if (!task) return sendError(res, 404, '任务不存在');
    if (task.sourcePlatform !== 'douyin' && operationNeedsCloud(task.operation) && !eraseApi.ready) {
      return sendError(res, 503, '云端处理服务尚未就绪，请联系管理员开通后再试', {
        endpoint: eraseApi.endpoint, missing: eraseApi.missing,
      });
    }
    const diskCheck = diskGuard();
    if (!diskCheck.ok) {
      return sendError(res, 507, diskLowMessage(diskCheck.free), { freeBytes: diskCheck.free, minFreeBytes: diskCheck.minFree });
    }
    const body = await readJsonBody(req);
    await startTask(task, currentUser(req), { force: body.force === true });
    console.log(`[task] ${task.id} 手动开始`);
    sendJson(res, 202, { task: serializeTask(task) });
  },

  'GET /api/tasks/:id': async (req, res, { params }) => {
    const task = db.tasks[params.id];
    if (!task) return sendError(res, 404, '任务不存在');
    sendJson(res, 200, { task: serializeTask(task), poll: `/api/tasks/${task.id}` });
  },

  'DELETE /api/tasks/:id': async (req, res, { params }) => {
    const task = db.tasks[params.id];
    if (!task) return sendError(res, 404, '任务不存在');
    const canceled = cancelTask(task);
    sendJson(res, 200, { task: serializeTask(task), cancel: canceled ? { background: !!task.remoteTaskId } : null });
  },

  'GET /api/download/:id': async (req, res, { params }) => {
    const task = db.tasks[params.id];
    if (!task) return sendError(res, 404, '任务不存在');
    if (task.status === 'expired' && !(task.result?.remote && remoteAlive(task))) {
      return sendError(res, 410, '源文件已过期，产物已删除，请重新上传处理');
    }
    if (task.status !== 'succeeded' && task.status !== 'expired') {
      return sendError(res, 409, '任务尚未完成', { status: task.status });
    }

    if (task.result.hasVideo && task.result.remote && remoteAlive(task)) {
      res.writeHead(302, { Location: task.remoteResultUrl, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (task.result.srt) {
      return serveFile(req, res, path.join(OUTPUT_DIR, task.id, 'subtitle.srt'), {
        downloadName: task.result.name,
        mime: 'application/x-subrip; charset=utf-8',
      });
    }
    const target = task.result.hasVideo
      ? path.join(OUTPUT_DIR, task.id, 'output.mp4')
      : path.join(OUTPUT_DIR, task.id, 'poster.svg');
    serveFile(req, res, target, {
      downloadName: task.result.name,
      mime: task.result.hasVideo ? 'video/mp4' : 'image/svg+xml',
    });
  },

  'GET /api/artifacts/:id/:name': async (req, res, { params }) => {
    const task = db.tasks[params.id];
    if (task && task.status === 'expired' && !(task.result?.remote && remoteAlive(task))) {
      return sendError(res, 410, '源文件已过期，产物已删除');
    }
    if (!task || task.status !== 'succeeded') return sendError(res, 404, '产物不存在');
    const map = { 'poster.svg': 'poster.svg', video: 'output.mp4' };
    const key = params.name === 'video' ? 'video' : params.name;
    const fileName = map[key];
    if (!fileName) return sendError(res, 404, '产物不存在');
    if (key === 'video' && task.result?.remote && remoteAlive(task)) {
      res.writeHead(302, { Location: task.remoteResultUrl, 'Cache-Control': 'no-store' });
      return res.end();
    }
    serveFile(req, res, path.join(OUTPUT_DIR, task.id, fileName), { cache: 'private, no-store' });
  },

  /** 公开访问 URL：/f/:id —— 按文件的唯一 ID 访问，去字幕接口就是拉这里 */
  'GET /f/:id': async (req, res, { params }) => {
    const file = findFileByKey(params.id);
    if (!file) return sendError(res, 404, '文件不存在或已过期');
    const me = currentUser(req);
    if (me) assertFileAccess(file, me);
    if (isFileExpired(file)) {
      return sendError(res, 410, `文件已过期（超过 ${ttlHours()} 小时）并被删除，请重新上传`, { expiresAt: new Date(fileExpiresAt(file)).toISOString() });
    }
    // 内联返回，供页面预览（支持 Range）；产物下载走 /api/download/:taskId
    // ?dl=1 → 当下载处理（带真实文件名），用于"浏览器放不了这个格式"时的兜底
    const asDownload = new URL(req.url, 'http://x').searchParams.get('dl') === '1';
    serveFile(req, res, path.join(DATA_DIR, file.storedPath), {
      mime: MIME[file.ext] || file.mime,
      downloadName: asDownload ? file.name : undefined,
      cache: 'private, no-store',
    });
  },

  /** 视频生成参考素材能力 URL：随机 ID，不暴露原始文件名或账号信息。 */
  'GET /r/:id': async (req, res, { params }) => {
    const reference = db.references[params.id];
    if (!reference) return sendError(res, 404, '参考素材不存在或已过期');
    const me = currentUser(req);
    if (me && (!reference.userId || reference.userId !== me.id)) return sendError(res, 404, '参考素材不存在或已过期');
    if (reference.expiresAt && Date.parse(reference.expiresAt) <= Date.now()) {
      return sendError(res, 410, '参考素材已过期，请重新上传');
    }
    serveFile(req, res, path.join(DATA_DIR, reference.storedPath), {
      mime: reference.mime || MIME[reference.ext] || 'application/octet-stream',
      cache: 'private, no-store',
    });
  },
};

const STATIC_ROUTES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/md5.js': ['md5.js', 'text/javascript; charset=utf-8'],
  '/local-eraser.js': ['local-eraser.js', 'text/javascript; charset=utf-8'],
  '/md5-worker.js': ['md5-worker.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function matchRoute(method, pathname) {
  // HEAD 与 GET 同路由：探测可达性、取元信息都靠它（返回头但不返回 body）
  const verb = method === 'HEAD' ? 'GET' : method;
  const direct = ROUTES[`${verb} ${pathname}`];
  if (direct) return { handler: direct, params: {} };
  for (const key of Object.keys(ROUTES)) {
    const [m, pattern] = key.split(' ');
    if (m !== verb) continue;
    const pk = pattern.split('/');
    const ak = pathname.split('/');
    if (pk.length !== ak.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pk.length; i += 1) {
      if (pk[i].startsWith(':')) params[pk[i].slice(1)] = decodeURIComponent(ak[i]);
      else if (pk[i] !== ak[i]) { ok = false; break; }
    }
    if (ok) return { handler: ROUTES[key], params };
  }
  return null;
}

/** 无需登录即可访问的接口（登录本身，以及让未登录页面判断会话状态） */
const PUBLIC_ROUTES = new Set([
  'GET /api/auth/captcha',
  'POST /api/auth/login',
  'POST /api/auth/register',
  'GET /api/auth/session',
  'POST /api/auth/logout',
]);

// ---------------------------------------------------------------- 服务器
const server = http.createServer(async (req, res) => {
  req.sessionResponse = res;
  try {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.on('finish', () => {
      if (!url.pathname.startsWith('/api/tasks/') || res.statusCode >= 400) {
        console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,x-file-name,x-file-md5,range',
        'access-control-max-age': '86400',
      });
      return res.end();
    }

    // 静态资源
    const staticEntry = STATIC_ROUTES[url.pathname];
    if (staticEntry && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveFile(req, res, path.join(PUBLIC_DIR, staticEntry[0]), { mime: staticEntry[1], cache: 'no-cache' });
    }

    const route = matchRoute(req.method, url.pathname);
    if (!route) return sendError(res, 404, `无此接口: ${req.method} ${url.pathname}`);

    // 云端处理只可通过有效期 6 小时的签名 URL 匿名读取文件；随机 ID 本身不再视作公开权限。
    const capabilityUrl = (req.method === 'GET' || req.method === 'HEAD') &&
      (/^\/f\/(?:vf_[A-Za-z0-9_-]+|[a-f0-9]{32})$/.test(url.pathname) || /^\/r\/ref_[A-Za-z0-9_-]+$/.test(url.pathname)) && validCapabilityUrl(url);
    const authless = PUBLIC_ROUTES.has(`${req.method} ${url.pathname}`) || capabilityUrl;

    // 限流：全局并发 + 每用户 + 每 IP（白名单/管理员豁免）
    const meUser = currentUser(req);
    const isPrivileged = !!meUser && (meUser.role === 'admin' || meUser.whitelisted === true);
    if (!authless && !isPrivileged) {
      const ip = clientIp(req);
      const limit = (key, opt) => {
        const r = takeToken(key, opt);
        if (!r.ok) {
          db.abuseEvents.push({ id: `ab_${Date.now().toString(36)}`, type: 'rate_limit', key, userId: meUser?.id || null, ip, path: url.pathname, at: new Date().toISOString() });
          if (db.abuseEvents.length > 5000) db.abuseEvents = db.abuseEvents.slice(-5000);
          // 限流事件用于审计；不要因累计五次瞬时拥塞永久停号，多标签页也可能自然触发。
          if (meUser) meUser.rateHits = (meUser.rateHits || 0) + 1;
          saveDb();
          sendError(res, 429, `请求过于频繁，请 ${r.retryAfter} 秒后重试`, { retryAfter: r.retryAfter });
          return true;
        }
        return false;
      };
      if (limit(`user:${meUser?.id || ip}`, { rate: 2, burst: 60 })) return;
      if (limit(`ip:${ip}`, { rate: 5, burst: 150 })) return;
      if (meUser?.suspended) return sendError(res, 403, `账号已被暂停：${meUser.suspended.reason}，请联系管理员`);
    }

    // 归属校验：所有账号（管理员也包括在内）只可访问自己的任务和批次。
    if (!authless) {
      const me = currentUser(req);
      if (me) {
        const mB = /^\/api\/batches\/([^/]+)/.exec(url.pathname);
        const mT = /^\/api\/(?:tasks|download|artifacts)\/([^/]+)/.exec(url.pathname);
        const owner = mB ? db.batches[route.params.id || route.params.batchId] : mT ? db.tasks[route.params.id] : null;
        if (owner && (!owner.userId || owner.userId !== me.id)) {
          return sendError(res, 404, '资源不存在');
        }
        // 批次及其行引用的文件和任务都必须属于该用户，旧数据异常时整体拒绝。
        if (mB && owner && (owner.items || []).some((it) => {
          const task = db.tasks[it.taskId];
          const file = db.files[it.fileId];
          return (task && task.userId !== me.id) || (file && file.userId !== me.id);
        })) {
          return sendError(res, 404, '资源不存在');
        }
      }
    }

    if (!authless && !currentUser(req)) {
      // 便于排查「莫名掉登录」：记录是否携带了 Cookie
      console.warn(`[auth] 401 ${req.method} ${url.pathname} cookie=${req.headers.cookie ? '已携带' : '未携带'}`);
      if (req.method === 'HEAD') {
        res.writeHead(401, { 'www-authenticate': 'Cookie', 'cache-control': 'no-store' });
        return res.end();
      }
      return sendError(res, 401, '未登录或会话已过期，请重新登录', {
        login: '/api/auth/login',
        sessionTtlMs: SESSION_TTL_MS,
      });
    }

    res.isHead = req.method === 'HEAD';
    await route.handler(req, res, { params: route.params, url });
  } catch (err) {
    console.error('[request]', err.message);
    if (!res.headersSent) sendError(
      res,
      err instanceof URIError || err.code === 'ERR_INVALID_URL' ? 400 : (err.status || 500),
      err.status ? err.message : '请求无效或服务暂时不可用',
      err.errorCode ? { errorCode: err.errorCode, stage: err.stage || null, retryable: err.retryable === true } : {},
    );
    else res.destroy();
  }
});

try {
  const admin = ensureAdmin(db, { phone: normalizePhone(process.env.ADMIN_PHONE), password: process.env.ADMIN_PASSWORD });
  // 内部白名单：环境变量 INTERNAL_PHONES（逗号分隔）里的号码启动时自动加白名单
  const internalPhones = String(process.env.INTERNAL_PHONES || '')
    .split(',').map((x) => normalizePhone(x)).filter(Boolean);
  if (internalPhones.length) {
    let n = 0;
    for (const p of internalPhones) {
      const u = findUserByPhone(db, p);
      if (u && !u.whitelisted) { u.whitelisted = true; n += 1; }
    }
    if (n) { saveDb(); console.log(`[accounts] 已按 INTERNAL_PHONES 加入白名单 ${n} 个账号`); }
  }
  if (admin && process.env.ADMIN_PASSWORD_FORCE === '1' && process.env.ADMIN_PASSWORD) {
    setPassword(admin, process.env.ADMIN_PASSWORD);
    db.sessions = {};
    console.log('[accounts] ADMIN_PASSWORD_FORCE=1：已把管理员密码重置为环境变量里的值，并清空所有会话');
  }
  if (admin) saveDb();
} catch (err) { console.warn('[accounts]', err.message); }

server.listen(PORT, HOST, async () => {
  for (const reference of Object.values(db.references)) registerReferenceAsset(reference);
  for (const generation of Object.values(db.videoGenerations)) registerGenerationAssets(generation);
  for (const userId of new Set([...Object.values(db.files), ...Object.values(db.tasks)].map((item) => item.userId).filter(Boolean))) syncUserAssets(userId);
  saveDb();
  // 先接管/清理上次运行遗留的「处理中」任务，再开始服务
  recoverInterruptedTasks();
  const swept = await sweepExpired('startup').catch((err) => {
    console.error('[ttl] 启动清理失败:', err.message);
    return { removed: 0 };
  });
  pruneSessions();
  console.log(`\n  ClipFlow AI · 一站式 AI 视频创作平台`);
  console.log(`  本机       http://127.0.0.1:${PORT}`);
  console.log(`  外部       ${baseUrl()}   (能力 URL ${baseUrl()}/f/vf_<id>)`);
  console.log(`  数据       ${DATA_DIR}`);
  console.log(`  登录       手机号 + 密码；持续操作自动续期，闲置 1 小时失效`);
  console.log(`  去字幕接口 ${eraseApi.endpoint}`);
  console.log(
    eraseApi.ready
      ? `             密钥与公网入口均已配置，可以提交任务`
      : `             ⚠ 未配置完成，缺少：${eraseApi.missing.join('、')}（提交任务会被拒绝）`,
  );
  console.log(`  视频生成   ${AUTODL_READY ? `AutoDL 已配置 · 工作流 ${AUTODL_VIDEO_WORKFLOW}` : '⚠ 未配置 AUTODL_API_TOKEN'}`);
  console.log(`  过期策略   源文件 ${UPLOAD_TTL_MS / 3600000} 小时后删除（含 MD5 索引），每 ${SWEEP_INTERVAL_MS / 1000}s 扫描一次`);
  if (swept.removed) console.log(`             启动时清理了 ${swept.removed} 个过期文件`);
  console.log(`  并发       同时在场 ${MAX_ACTIVE_TASKS} · 提交 ${SUBMIT_CONCURRENCY} · 回传 ${FETCH_CONCURRENCY}`);
  console.log(`  单文件上限 ${formatBytes(MAX_UPLOAD_BYTES)}`);
  console.log(`  版本       ${BUILD_ID}\n`);
});

// 定时清理过期文件（同时兜住跨天的会话失效）
setInterval(() => {
  sweepExpired('timer').catch((err) => console.error('[ttl] 定时清理失败:', err.message));
  pruneSessions();
}, SWEEP_INTERVAL_MS).unref?.();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，保存状态并退出`);
    saveDbSync();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}
