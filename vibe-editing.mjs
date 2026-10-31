export function editingConfig() {
  const endpoints = String(process.env.AMK_EDITING_ENDPOINTS || '').split(',').map(s => s.trim()).filter(Boolean);
  return { ready: Boolean(process.env.AMK_API_KEY && process.env.PUBLIC_BASE_URL && endpoints.length), endpoints,
    missing: [!process.env.AMK_API_KEY && 'MediaKit 接口密钥', !process.env.PUBLIC_BASE_URL && '公网素材入口', !endpoints.length && '视频理解模型接入点'].filter(Boolean) };
}

export function buildEditingRequest(job, references, urlFor) {
  const preset = job.mode === 'talk'
    ? '制作口播短视频。保持原声和原意，删除冗余停顿、明显口误和重复表达，保持语句完整与音画同步，采用自然的跳剪。'
    : '制作商品带货短视频。按吸引注意、商品展示、卖点与使用场景、购买引导的顺序编排。只使用用户提供的商品信息，不编造价格、优惠或功效。';
  return { content: [{type:'text', text: `${preset}\n目标时长约 ${job.duration} 秒；画幅 ${job.ratio}。${job.subtitles ? '识别原声并添加对应中文字幕，确保可读。' : '不添加字幕。'}\n商品信息：${job.product || '以素材为准'}\n用户剪辑要求：${job.prompt}\n素材按随后输入顺序编号；仅使用提供的素材，若有音乐则降低背景音量，确保人声清楚。`},
    ...references.map(ref => { const type = `${ref.kind}_url`; return {type, [type]:{url:urlFor(ref.id)}}; })],
    output:{type:'video', resolution:job.ratio === '9:16' ? '1080x1920' : job.ratio === '1:1' ? '1080x1080' : '1920x1080',format:'mp4',fps:30},
    extensions:{multimodal_understanding:{prefer_endpoints:editingConfig().endpoints}}, client_token:job.id };
}

export async function editingRequest(route, body) {
  const base = String(process.env.AMK_API_BASE || 'https://mediakit.cn-beijing.volces.com/api/v1').replace(/\/+$/, '');
  const response = await fetch(`${base}${route}`, {method:body ? 'POST':'GET', signal:AbortSignal.timeout(30000),
    headers:{Authorization:`Bearer ${String(process.env.AMK_API_KEY || '').replace(/^Bearer\s+/i,'')}`,'Content-Type':'application/json'},
    ...(body ? {body:JSON.stringify(body)} : {})});
  const data = await response.json().catch(()=>({}));
  if (!response.ok || data.success === false) throw Object.assign(new Error(data.error?.message || `剪辑服务请求失败（${response.status}）`),{rejected:response.status<500});
  return data;
}
