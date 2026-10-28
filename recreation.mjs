import path from 'node:path';
import { probeVideoDuration } from './media.mjs';

export const RECREATION_MAX_SECONDS = 15;
const fail = (message) => Object.assign(new Error(message), { status: 400 });

export async function assertRecreationVideo(filePath) {
  const duration = await probeVideoDuration(filePath);
  if (duration > RECREATION_MAX_SECONDS) throw fail('视频复刻的参考视频时长不能超过 15 秒，请先裁剪后上传');
  return duration;
}

export async function validateRecreationReferences(references, { dataDir, replacementTarget }) {
  if (!['subject', 'background'].includes(replacementTarget)) throw fail('请选择替换主体或替换背景');
  const videos = references.filter((item) => item.kind === 'video');
  const images = references.filter((item) => item.kind === 'image');
  if (videos.length !== 1) throw fail('视频复刻必须添加且只能添加 1 个参考视频');
  if (images.length < 1 || images.length > 9) throw fail('视频复刻需要 1–9 张用于替换主体或背景的参考图片');
  if (references.length !== videos.length + images.length) throw fail('视频复刻仅支持视频和图片参考，不支持音频参考');
  if (images.some((item) => !['.jpg', '.jpeg', '.png', '.webp'].includes(item.ext))) throw fail('替换图片仅支持 JPG、PNG、WebP');
  const duration = await assertRecreationVideo(path.join(dataDir, videos[0].storedPath));
  return { video: videos[0], images, duration, replacementTarget };
}
