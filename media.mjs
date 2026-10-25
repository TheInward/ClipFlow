import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Only server-probed metadata may be used for billing. Never fall back to client input. */
export async function probeVideoDuration(filePath) {
  let stdout;
  try {
    ({ stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file,pipe,http,https,tcp,tls',
      '-show_entries', 'format=duration:stream=codec_type,duration',
      '-of', 'json', filePath,
    ], { timeout: 30000, maxBuffer: 1024 * 1024 }));
  } catch (err) {
    throw Object.assign(new Error(err.code === 'ENOENT'
      ? '服务器缺少 ffprobe，无法核实视频时长，请联系管理员安装'
      : '无法读取视频时长，请检查视频文件'), { status: err.code === 'ENOENT' ? 503 : 422 });
  }
  let metadata;
  try { metadata = JSON.parse(stdout); } catch { metadata = {}; }
  const videos = (metadata.streams || []).filter((s) => s.codec_type === 'video');
  const durations = [metadata.format?.duration, ...videos.map((s) => s.duration)]
    .map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!videos.length || !durations.length) {
    throw Object.assign(new Error('文件没有可确认时长的视频流'), { status: 422 });
  }
  return Math.max(...durations);
}

let _available = null;
/** ffprobe 是否可用（结果缓存）：缺它时建批次/开始任务会返回 503 */
export async function probeAvailable() {
  if (_available !== null) return _available;
  try {
    await run(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    _available = true;
  } catch { _available = false; }
  return _available;
}

/** 探测视频宽高（用于把百分比区域换算成像素） */
export async function probeVideoSize(filePath) {
  let stdout;
  try {
    ({ stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file,pipe,http,https,tcp,tls',
      '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filePath,
    ], { timeout: 30000, maxBuffer: 1024 * 1024 }));
  } catch (err) {
    throw Object.assign(new Error(err.code === 'ENOENT' ? '服务器缺少 ffprobe，请联系管理员安装' : '无法读取视频尺寸'), { status: err.code === 'ENOENT' ? 503 : 422 });
  }
  let meta; try { meta = JSON.parse(stdout); } catch { meta = {}; }
  const s = (meta.streams || [])[0] || {};
  const width = Number(s.width) || 0;
  const height = Number(s.height) || 0;
  if (!width || !height) throw Object.assign(new Error('无法确认视频分辨率'), { status: 422 });
  return { width, height };
}
