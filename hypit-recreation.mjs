import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const execute=promisify(execFile);
const fail=(message,code='HYPIT_NOT_CONFIGURED')=>Object.assign(new Error(message),{status:503,errorCode:code});

export function hypitConfiguration(env=process.env) {
  const bin=env.HYPIT_BIN || '', adapter=env.HYPIT_VIDEO_ADAPTER || '', profile=env.HYPIT_RUNTIME_PROFILE || '';
  const missing=[];
  for(const [name,file] of [['Hypit 运行环境',bin],['视频模型适配器',adapter],['模型 Provider 配置',profile]]) {
    if(!path.isAbsolute(file)||!fs.existsSync(file))missing.push(name);
  }
  if(env.HYPIT_RECREATION_ENABLED!=='true')missing.push('视频模型启用配置');
  return {bin,adapter,profile,ready:missing.length===0,missing,
    reason:missing.length ? 'Hypit 视频模型接口尚未配置，暂时无法开始复刻' : ''};
}
const inside=(root,file)=>{const resolved=path.resolve(root,file);if(!resolved.startsWith(path.resolve(root)+path.sep))throw fail('模型适配器输出路径不属于当前任务','HYPIT_INVALID_PROJECT');return resolved;};
async function writeJson(file,value){const temp=file+'.incoming';await fsp.writeFile(temp,JSON.stringify(value),{mode:0o600});await fsp.rename(temp,file);}
async function cli(config,project,args,{allowFailure=false}={}) {
  let stdout;
  try {({stdout}=await execute(config.bin,[...args,'--project',project,'--runtime',config.profile,'--json'],{cwd:project,timeout:120000,maxBuffer:2*1024**2,env:{...process.env,HYPIT_VIDEO_ADAPTER:undefined}}));}
  catch(error){
    if(error.killed||error.signal)throw fail('Hypit 响应超时，任务状态可能已提交，请核查后再创建新任务','HYPIT_OUTCOME_UNKNOWN');
    stdout=error.stdout;
    if(!allowFailure){let message;try{message=JSON.parse(stdout).error?.message;}catch{}throw fail(message || 'Hypit 执行失败，请检查运行环境和模型配置','HYPIT_EXECUTION_FAILED');}
  }
  let value;try{value=JSON.parse(stdout);}catch{throw fail('Hypit 未返回有效的任务信息','HYPIT_INVALID_RESPONSE');}
  if(value.ok===false)throw fail(value.error?.message||'Hypit 请求失败','HYPIT_EXECUTION_FAILED');
  return value;
}

export async function submitHypitRecreation({prompt,parameters,references,dataDir,config=hypitConfiguration()}) {
  if(!config.ready)throw fail(config.reason);
  const taskId='hypit_'+crypto.randomUUID().replaceAll('-','');
  const project=path.join(dataDir,'hypit',taskId);
  await fsp.mkdir(path.join(project,'assets'),{recursive:true,mode:0o700});
  await writeJson(path.join(project,'package.json'),{name:taskId,private:true,type:'module',hypit:{project:true}});
  const media=[];
  for(const [i,ref] of references.entries()) {
    const relative=`assets/reference-${i}${ref.ext}`;
    await fsp.copyFile(inside(dataDir,ref.storedPath),inside(project,relative));
    media.push({path:relative,kind:ref.kind,durationSec:ref.durationSec||null});
  }
  const brief={prompt,parameters,referenceVideo:media.find(r=>r.kind==='video'),replacementImages:media.filter(r=>r.kind==='image'),
    preserve:['原视频动作','镜头运动','节奏'],change:parameters.replacementTarget,output:{duration:parameters.duration,ratio:'9:16',resolution:parameters.resolution}};
  await writeJson(path.join(project,'brief.json'),brief);
  await fsp.writeFile(path.join(project,'Brief.md'),`# 视频复刻\n\n${prompt}\n\n保留原视频动作、镜头和节奏。只按用户要求替换${parameters.replacementTarget==='background'?'背景':'主体'}。\n`);
  const adapter=await import(pathToFileURL(config.adapter).href);
  if(typeof adapter.prepareRecreation!=='function')throw fail('视频模型适配器缺少 prepareRecreation 接口');
  const prepared=await adapter.prepareRecreation({project,brief});
  if(typeof prepared?.run!=='string'||typeof prepared?.output!=='string')throw fail('视频模型适配器必须返回 run 和 output');
  const run=inside(project,prepared.run);
  await cli(config,project,['check',run]);
  await cli(config,project,['plan',run]);
  // Checkpoint before the only command that can create paid work. Never automatically resubmit it.
  const record={taskId,config:{bin:config.bin,profile:config.profile},run,output:prepared.output,phase:'submitting',createdAt:new Date().toISOString()};
  await writeJson(path.join(project,'job.json'),record);
  const result=await cli(config,project,['build',run,'--title','视频复刻']);
  if(!result.build?.id)throw fail('Hypit 未返回 Build ID，请核查运行记录后再提交','HYPIT_OUTCOME_UNKNOWN');
  record.buildId=result.build.id;record.phase='submitted';await writeJson(path.join(project,'job.json'),record);
  return {code:'Success',data:{task_id:taskId,status:'QUEUED'}};
}

export async function queryHypitRecreation(taskId,{dataDir}) {
  if(!/^hypit_[a-f0-9]{32}$/.test(taskId))throw fail('Hypit 任务号无效','HYPIT_INVALID_TASK');
  const project=path.join(dataDir,'hypit',taskId);
  const record=JSON.parse(await fsp.readFile(path.join(project,'job.json'),'utf8'));
  if(!record.buildId)throw fail('Hypit 提交回执缺失，暂停自动提交，请核查运行记录','HYPIT_OUTCOME_UNKNOWN');
  const state=await cli(record.config,project,['status',record.buildId],{allowFailure:true});
  const build=state.build;if(!build)throw fail('Hypit 暂未返回任务状态','HYPIT_INVALID_RESPONSE');
  const outcome=build.work?.outcome||build.result?.state;
  if(outcome==='complete') {
    const outputPath=path.join(project,'output.mp4');
    if(!fs.existsSync(outputPath)) {
      const temporary=path.join(project,'export-'+crypto.randomUUID()+'.mp4');
      await cli(record.config,project,['get',record.buildId,'--output',record.output,'--to',temporary]);
      if(!(await fsp.stat(temporary)).size)throw fail('Hypit 返回的视频文件为空','HYPIT_INVALID_RESULT');
      await fsp.rename(temporary,outputPath);
    }
    if(!(await fsp.stat(outputPath)).size)throw fail('Hypit 返回的视频文件为空','HYPIT_INVALID_RESULT');
    return {code:'Success',data:{status:'SUCCESS',outputPath,results:[]}};
  }
  if(['failed','cancelled'].includes(outcome))return {code:'Success',data:{status:outcome==='failed'?'FAILED':'CANCELED',error_message:build.failure||build.attention?.message||'Hypit 复刻任务已结束',results:[]}};
  if(build.work?.state==='unknown')throw fail('Hypit 运行状态未知，请检查 Worker','HYPIT_INVALID_RESPONSE');
  return {code:'Success',data:{status:'RUNNING',results:[]}};
}
