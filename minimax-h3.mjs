/** AutoDL 模型广场 MiniMax H3 V2；与 ComfyUI 工作流协议分离。 */
export function buildRecreationPayload({prompt, parameters, references, referenceUrl}) {
  const subject=parameters.replacementTarget === 'subject';
  const instruction=subject
    ? '使用参考图片替换参考视频中的主体，保持原视频背景不变。'
    : '使用参考图片替换参考视频中的背景场景，保持原视频主体身份、外观不变。';
  return {model:'MiniMax-H3',resolution:'768P',duration:Number(parameters.duration),ratio:'9:16',content:[
    {type:'text',text:`${prompt}\n${instruction}参考视频是动作和镜头依据：保留动作轨迹、节奏、镜头运动及构图，不重新设计动作。参考图片仅定义替换内容。`},
    ...references.filter(r=>r.kind==='video').map(r=>({type:'video_url',video_url:{url:referenceUrl(r.id)},role:'reference_video'})),
    ...references.filter(r=>r.kind==='image').map(r=>({type:'image_url',image_url:{url:referenceUrl(r.id)},role:'reference_image'})),
  ]};
}

export function normalizeH3Response(response, method) {
  if (response?.error) throw Object.assign(new Error(response.error.message || 'MiniMax H3 接口错误'),{status:502,errorCode:'PROVIDER_REQUEST_FAILED'});
  if (method === 'POST') {
    if (!response?.task_id) throw Object.assign(new Error('MiniMax H3 未返回任务号'),{status:502});
    return {code:'Success',data:{task_id:String(response.task_id),status:'QUEUED'}};
  }
  const task=response?.task;
  if (!task?.id || !['queued','running','succeeded','failed','cancelled'].includes(task.status))
    throw Object.assign(new Error('MiniMax H3 返回的任务状态无效，暂停继续提交'),{status:502});
  if (task.status === 'succeeded' && !/^https?:\/\//.test(task.content?.url || ''))
    throw Object.assign(new Error('MiniMax H3 已完成但未返回视频地址，继续查询'),{status:502});
  return {code:'Success',data:{status:task.status,error:task.error,
    error_message:task.failure_reason || task.error_message,
    results:task.content?.url ? [task.content.url] : []}};
}
