import crypto from 'node:crypto';

export const GENERATION_COUNTS = new Set([1, 2, 3, 5, 10]);
const DIRECTIONS = [
  ['清晨暖调', '柔和晨光与暖色侧光', '低机位缓慢推进', '清爽的背景层次'],
  ['阴天纪实', '阴天柔和漫射光', '平视侧向跟拍', '自然生活化的环境细节'],
  ['日落轮廓', '日落逆光与清晰轮廓光', '中景缓慢环绕', '温暖夕照的远景氛围'],
  ['冷调电影', '冷色环境光与局部暖光对比', '稳定的横向滑轨镜头', '冷暖分区的背景景深'],
  ['柔光特写', '柔和大面积主光与细腻高光', '从细节特写逐渐拉远', '简洁通透的浅景深背景'],
  ['通透日光', '明亮自然日光与适度反射补光', '略高机位斜向推进', '明亮通透的空间层次'],
  ['暮色氛围', '暮色蓝调与柔和点状灯光', '由远景缓慢推向中景', '低照度、有纵深的背景氛围'],
  ['质感侧光', '有方向性的侧光与柔和阴影', '侧面近景轻微环绕', '强调材质与明暗层次的背景'],
  ['轻盈视角', '清透逆光与自然补光', '缓慢升降并改变观察高度', '有前后景遮挡的空间构图'],
  ['沉静长镜', '均匀柔光与低饱和色彩', '稳定长镜头与轻微前后移动', '安静、疏朗的场景细节'],
];

export function createGenerationVariants({ prompt, parameters, count, mode }) {
  if (!GENERATION_COUNTS.has(count)) throw Object.assign(new Error('生成条数仅支持 1、2、3、5、10 条'), {status:400});
  const seeds = new Set();
  return Array.from({length:count}, (_, index) => {
    let seed;
    do { seed = crypto.randomInt(1, 281474976710655); } while (seeds.has(seed));
    seeds.add(seed);
    const [title, lighting, camera, background] = DIRECTIONS[index];
    const constraints = mode === 'keyframes'
      ? '首帧与尾帧图片是固定约束，不改变其主体、场景及起止构图；变化仅用于两帧之间允许变化的部分。'
      : '保留参考素材中的主体身份、产品外观、标识与核心动作，不新增或替换核心主体。';
    const variation = mode === 'recreation'
      ? `版本 ${index+1}：${title}。仅在用户允许的替换区域调整${lighting}和材质细节；严格保留原视频的动作、节奏、镜头运动、构图和未替换区域。不得因版本变化改变原动作或镜头。`
      : `版本 ${index + 1}：${title}。灯光：${lighting}。镜头：${camera}。环境：在符合原提示词指定地点的前提下，表现${background}。${constraints}用户明确指定的地点、背景、动作、色彩及镜头要求优先；仅在未限定的细节上实现本版本差异。`;
    return {index, title, lighting, camera:mode === 'recreation' ? '沿用参考视频镜头' : camera, background, status:'PENDING', taskId:null,
      prompt: count === 1 ? prompt : `${prompt}\n\n【本条独立创作方向】${variation}`,
      parameters: {...parameters, seed}, error:null};
  });
}
