import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import vm from 'node:vm';
import { enhanceVideo, runTranscode, runToolVideo, runAsr, runOcr } from '../pipeline.mjs';
import { probeVideoDuration } from '../media.mjs';
import { createGenerationVariants } from '../video-variants.mjs';

const EXPECTED_GENERATION_CONSTRAINTS = '产品外形不变，轮廓、花纹、产品材质、外形保持和参考图完全一致；画面无闪烁、光线没有过度曝光、无物体形变、无水印、无内嵌文字字幕、无多余杂物；手部正常，无多指、融指畸形；镜头不剧烈抖动，不要卡通、手绘、CG塑料质感，真实的实拍质感、生活感觉，不要有AI味， 光线明亮、光影有层次感，';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(550); }
  throw new Error('Timed out waiting for condition');
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((r) => server.close(r)); return port;
}

// Test-only executable substitutes deterministic media metadata for ffprobe.
async function mockProbe(dir) {
  const file = path.join(dir, 'ffprobe');
  await fs.writeFile(file, `#!${process.execPath}\nconst fs = require('node:fs');\nconst input = process.argv.at(-1); const duration = input.startsWith('https://8.8.8.8/') ? 5 : Number(fs.readFileSync(input, 'utf8'));\nconsole.log(JSON.stringify({streams: [{codec_type:'video',duration}],format:{duration}}));\n`, { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'ffmpeg'), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.argv.at(-1), Buffer.alloc(2048));\n`, { mode: 0o755 });
  return file;
}

test('real HTTP routes: billing, ownership, queue cancellation, enhancement and sessions', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipflow-test-'));
  const upstreamTasks = new Map();
  const videoWorkflowCalls = [];
  const generationJobs = new Map();
  const videoSubmissionAttempts = [];
  let serial = 0;
  let h3Serial = 0;
  const upstream = http.createServer(async (req, res) => {
    const json = (body) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/h3/v2/video_generation') {
      assert.equal(req.headers.authorization,'Bearer test-token');
      let raw=''; for await (const chunk of req) raw+=chunk;
      const input=JSON.parse(raw);
      assert.ok(input.content.find(item=>item.type==='text').text.endsWith(EXPECTED_GENERATION_CONSTRAINTS));
      const taskId='h3_video_'+(++h3Serial);
      generationJobs.set(taskId,{status:'queued',input});
      return json({task_id:taskId});
    }
    if (req.method === 'GET' && req.url.startsWith('/h3/v2/query/video_generation/')) {
      const id=req.url.split('/').at(-1);const job=generationJobs.get(id);
      return json({task:{id,status:job.status,content:job.content,error:job.error}});
    }
    if (req.method === 'GET' && req.url === '/comfy/comfyui_workflow/result/video_background') {
      return json({code:'Success',data:{status:'SUCCESS',results:[]}});
    }
    if (req.method === 'GET' && req.url === '/comfy/comfyui_workflow/result/video_poll_error') {
      res.statusCode=401; return json({message:'invalid token'});
    }
    if (req.method === 'GET' && req.url.startsWith('/comfy/comfyui_workflow/result/')) {
      const job=generationJobs.get(decodeURIComponent(req.url.split('/').at(-1)));
      if (job) return json({code:'Success',data:job});
    }
    if (req.url.startsWith('/asset')) { res.setHeader('Content-Length','2048'); res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(2048)); return; }
    if (req.method === 'POST' && req.url.startsWith('/comfy/comfyui_workflow/')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const workflow = decodeURIComponent(req.url.slice('/comfy/comfyui_workflow/'.length));
      const input = JSON.parse(raw);
      assert.ok(input.prompt.endsWith(EXPECTED_GENERATION_CONSTRAINTS));
      videoSubmissionAttempts.push(input);
      if (input.prompt.startsWith('force safety refusal')) { res.statusCode=400; return json({error:{message:'Your input contains content restricted by our safety guidelines.'}}); }
      if (input.prompt.startsWith('force submission failure')) {
        res.statusCode = 402;
        return json({ message:'Insufficient account balance' });
      }
      const taskId = `video_${videoWorkflowCalls.length + 1}`;
      videoWorkflowCalls.push({ workflow, input, taskId });
      generationJobs.set(taskId,{status:'QUEUED',results:[]});
      return json({ code:'Success', data:{ task_id:taskId, status:'QUEUED', created_at:new Date().toISOString() }, msg:'' });
    }
    if (req.method === 'POST' && req.url.startsWith('/tools/')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const id = `remote_${++serial}`;
      const type = req.url.includes('enhance') ? 'enhance' : req.url.includes('asr-subtitles') ? 'asr' : 'erase';
      upstreamTasks.set(id, { type, state: 'processing', input: JSON.parse(raw) });
      return json({ task_id: id });
    }
    if (req.method === 'GET' && req.url.startsWith('/tasks/')) {
      const task = upstreamTasks.get(req.url.slice('/tasks/'.length));
      if (!task) { res.statusCode = 404; return json({}); }
      const result = task.type === 'asr'
        ? { subtitles: [{ start_time: 0, end_time: 1, subtitle_text: 'hello' }] }
        : { video_url: `http://127.0.0.1:${upstream.address().port}/asset/${task.type}`, duration: 3.2 };
      return json({ status: task.state, result });
    }
    res.statusCode = 404; json({});
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const seed = { users: {}, sessions: {} };
  for (const id of ['a','b','poor','admin','background','isolated','poll_error','serial','bulk','recreation','variants','duplicates','batch_failure','ten_variants','bad_count','uncertain_batch']) {
    seed.users[id] = { id, status:'active', role: id === 'admin' ? 'admin' : 'user', credits: id === 'poor' ? 0 : 100 };
    seed.sessions[id] = { userId:id, createdAt:new Date().toISOString(), expiresAt:Date.now()+30*60*1000 };
  }
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'assets', 'saved-video.mp4'), Buffer.alloc(2048, 7));
  seed.videoGenerationCurrent = {isolated:'video_finished'};
  seed.videoGenerations = { video_background: {taskId:'video_background',userId:'background',status:'RUNNING',results:[],createdAt:new Date().toISOString()},
    interrupted_batch: {taskId:'interrupted_batch',userId:'uncertain_batch',isBatch:true,count:2,status:'RUNNING',
      prompt:'interrupted',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),referenceIds:[],
      variants:[{index:0,status:'SUBMITTING',taskId:null},{index:1,status:'PENDING',taskId:null}]},
    video_poll_error: {taskId:'video_poll_error',userId:'poll_error',status:'RUNNING',results:[],createdAt:new Date().toISOString()},
    video_finished: { taskId:'video_finished', userId:'a', status:'SUCCESS',
    prompt:'保留在资产中的提示词', results:[], createdAt:new Date().toISOString() },
    older_success: { taskId:'older_success', userId:'poor', status:'SUCCESS', prompt:'older', results:[],
      createdAt:'2020-01-01T00:00:00Z', updatedAt:'2099-01-01T00:00:00Z' },
    newest_failed: { taskId:'newest_failed', userId:'poor', status:'FAILED', prompt:'failed', results:[], createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:05Z' } };
  seed.assets = { 'generation:video_finished:0': { id:'generation:video_finished:0', userId:'a',
    name:'saved-video.mp4', kind:'video', ext:'.mp4', mime:'video/mp4', size:2048,
    source:'generation', state:'ready', storedPath:'assets/saved-video.mp4', createdAt:new Date().toISOString() } };
  await fs.writeFile(path.join(dir,'db.json'),JSON.stringify(seed));
  const childOptions = { cwd: path.resolve('.'), env: { ...process.env,
    DATA_DIR: dir, HOST:'127.0.0.1', PORT:String(port), AMK_API_KEY:'test-key',
    AMK_API_BASE:`http://127.0.0.1:${upstream.address().port}`, PUBLIC_BASE_URL:base,
    AUTODL_H3_API_BASE:`http://127.0.0.1:${upstream.address().port}/h3`, AUTODL_API_TOKEN:'test-token', AUTODL_API_BASE:`http://127.0.0.1:${upstream.address().port}/comfy`,
    AUTODL_VIDEO_WORKFLOW:'minimax_h3_lightx2v_no_pic', AUTODL_IMAGE_VIDEO_WORKFLOW:'minimax_h3_lightx2v_v5_15s',
    AUTODL_KEYFRAME_VIDEO_WORKFLOW:'minimax_h3_lightx2v',
    AMK_POLL_MS:'1000', MAX_ACTIVE_TASKS:'1', DISK_MIN_FREE_BYTES:'0', DISK_RESERVE_BYTES:'0',
    FFPROBE_PATH:await mockProbe(dir), PATH:`${dir}:${process.env.PATH}`, KEEP_ARTIFACT:'false', ADMIN_PHONE:'', ADMIN_PASSWORD:'',
  }, stdio:['ignore','pipe','pipe'] };
  let logs = '';
  const launch = () => {
    const child = spawn(process.execPath, ['server.mjs'], childOptions);
    child.stdout.on('data',(b)=>logs+=b); child.stderr.on('data',(b)=>logs+=b);
    return child;
  };
  let child = launch();
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child,'exit'); }
    upstream.closeAllConnections(); await new Promise((r)=>upstream.close(r));
    await fs.rm(dir,{recursive:true,force:true});
  });
  await until(async()=>{try{return (await fetch(base+'/api/auth/session')).ok;}catch{return false;}}).catch((e)=>{throw new Error(e.message+'\n'+logs);});
  async function api(route, { user='a', method='GET', body, raw, headers={} }={}) {
    const response = await fetch(base+route,{method,headers:{Cookie:`clp_sid=${user}`, ...(body ? {'Content-Type':'application/json'} : {}),...headers},body:raw ?? (body ? JSON.stringify(body):undefined),redirect:'manual'});
    const data = await response.json().catch(()=>({}));
    return { status:response.status, data, headers:response.headers };
  }
  const credits = async(user='a') => (await api('/api/me',{user})).data.user.credits;
  const upload = async(value, user='a') => {
    const r=await api('/api/uploads',{user,method:'POST',raw:String(value),headers:{'X-File-Name':'test.mp4'}});
    assert.equal(r.status,200,JSON.stringify(r.data)); return r.data.file.id;
  };
  const uploadReference = async(name, user='a') => {
    const r=await api('/api/video-references',{user,method:'POST',raw:'image-bytes',headers:{'X-File-Name':name,'Content-Type':'image/jpeg'}});
    assert.equal(r.status,201,JSON.stringify(r.data)); return r.data.reference;
  };
  const batch = async(file, opts={}) => {
    const r=await api('/api/batches',{method:'POST',user:opts.user,body:{fileIds:[file],durations:{[file]:1},...opts}});
    assert.equal(r.status,202,JSON.stringify(r.data));return r.data;
  };
  const start = async(id, user='a')=>api(`/api/tasks/${id}/start`,{method:'POST',user,body:{}});
  const cancel = async(id, user='a')=>api(`/api/tasks/${id}`,{method:'DELETE',user});
  const task = async(id,user='a')=>(await api(`/api/tasks/${id}`,{user})).data.task;

  await t.test('background polling completes persisted generations without a browser and rejects foreign current pointers',async()=>{
    await until(async()=>JSON.parse(await fs.readFile(path.join(dir,'db.json'),'utf8')).videoGenerations.video_background.status==='SUCCESS');
    assert.equal((await api('/api/video-generations/current',{user:'isolated'})).data.generation,null);
    assert.equal((await api('/api/maintenance/sweep',{method:'POST'})).status,403);
    const polling = (await api('/api/video-generations/current',{user:'poll_error'})).data.generation;
    assert.equal(polling.status,'RUNNING');
    assert.match(polling.pollingError,/暂时无法查询任务状态/);
    assert.doesNotMatch(polling.pollingError,/任务未创建/);
    const uncertain=(await api('/api/video-generations/current',{user:'uncertain_batch'})).data.generation;
    assert.equal(uncertain.status,'FAILED');assert.match(uncertain.error,/避免重复计费/);
    assert.equal(uncertain.variants[1].status,'SKIPPED');assert.equal(videoSubmissionAttempts.length,0);
  });

  await t.test('malformed cookies and path escapes do not terminate the server; session cookie renews',async()=>{
    const bad=await api('/api/me',{headers:{Cookie:'clp_sid=%'}});assert.equal(bad.status,401);
    assert.equal((await api('/api/tasks/%')).status,400);
    const r=await api('/api/auth/session');assert.equal(r.status,200);
    const maxAge = Number(/Max-Age=(\d+)/.exec(r.headers.get('set-cookie'))?.[1]);
    assert.ok(maxAge >= 3540 && maxAge <= 3600);
    assert.ok(Date.parse(r.data.expiresAt)>Date.now()+59*60000);
  });
  await t.test('one complete share per addition appends to the same owner batch',async()=>{
    const first=await api('/api/batches/from-urls',{method:'POST',body:{content:'产品标题 #厨房好物\nhttps://8.8.8.8/first.mp4\n复制此链接查看视频'}});
    assert.equal(first.status,202,JSON.stringify(first.data));assert.equal(first.data.items.length,1);
    const batchId=first.data.batch.id;const taskId=first.data.items[0].taskId;
    const multiple=await api('/api/batches/from-urls',{method:'POST',body:{content:'https://8.8.8.8/a.mp4 https://8.8.8.8/b.mp4',batchId}});
    assert.equal(multiple.status,400);assert.match(multiple.data.error,/每次只能添加一个/);
    assert.equal((await api('/api/tasks/from-url',{method:'POST',body:{url:'https://8.8.8.8/a.mp4 https://8.8.8.8/b.mp4'}})).status,400);
    const foreign=await api('/api/batches/from-urls',{user:'b',method:'POST',body:{content:'https://8.8.8.8/second.mp4',batchId}});
    assert.equal(foreign.status,404);
    const second=await api('/api/batches/from-urls',{method:'POST',body:{content:'另一个产品\n#话题 https://8.8.8.8/second.mp4 复制查看',batchId}});
    assert.equal(second.status,202,JSON.stringify(second.data));assert.equal(second.data.batch.id,batchId);
    assert.equal(second.data.items.length,2);assert.equal(second.data.items[0].taskId,taskId);
    const bad=await api('/api/batches/from-urls',{method:'POST',body:{content:'https://8.8.8.8/unsupported.html',batchId}});
    assert.equal(bad.status,422);
    assert.equal((await api('/api/batches/'+batchId)).data.items.length,2);
  });
  await t.test('video generation maps text, multi-image and keyframe modes to exact AutoDL workflows', async () => {
    const config = await api('/api/config');
    assert.deepEqual(config.data.videoGeneration.workflows, {
      recreation:'MiniMax-H3', text:'minimax_h3_lightx2v_no_pic', multi_image:'minimax_h3_lightx2v_v5_15s', keyframes:'minimax_h3_lightx2v',
    });
    const horizontal = await api('/api/video-generations',{user:'admin',method:'POST',body:{
      mode:'text', workflow:'minimax_h3_lightx2v_no_pic', prompt:'invalid ratio', parameters:{duration:5,resolution:'768p横'}, referenceIds:[],
    }});
    assert.equal(horizontal.status,400); assert.match(horizontal.data.error,/9:16/);
    const invalidDuration = await api('/api/video-generations',{user:'admin',method:'POST',body:{
      mode:'text', workflow:'minimax_h3_lightx2v_no_pic', prompt:'invalid duration', parameters:{duration:7,resolution:'768p竖'}, referenceIds:[],
    }});
    assert.equal(invalidDuration.status,400); assert.match(invalidDuration.data.error,/5 秒、10 秒或 15 秒/);
    const removedDuration=await api('/api/video-generations',{user:'admin',method:'POST',body:{mode:'text',prompt:'reject 3 seconds',parameters:{duration:3}}});
    assert.equal(removedDuration.status,400);
    const text = await api('/api/video-generations',{user:'admin',method:'POST',body:{
      mode:'text', workflow:'minimax_h3_lightx2v_no_pic', prompt:'text prompt', referenceIds:[],
    }});
    assert.equal(text.data.prompt,'text prompt');
    assert.equal(JSON.stringify(text.data).includes(EXPECTED_GENERATION_CONSTRAINTS),false);
    assert.equal(text.status,202,JSON.stringify(text.data));
    const adminVideoId = text.data.taskId;
    assert.equal((await api(`/api/video-generations/${adminVideoId}`,{user:'a',method:'DELETE'})).status,404);
    assert.equal((await api(`/api/video-generations/${adminVideoId}`,{user:'admin',method:'DELETE'})).status,409);
    const a1=await uploadReference('a1.jpg'), a2=await uploadReference('a2.jpg');
    assert.equal((await api(`/r/${a1.id}`,{user:'admin'})).status,404);
    const multi = await api('/api/video-generations',{user:'a',method:'POST',body:{
      mode:'multi_image', workflow:'minimax_h3_lightx2v_v5_15s', prompt:'multi prompt', parameters:{duration:10,resolution:'768p竖'}, referenceIds:[a1.id,a2.id],
    }});
    assert.equal(multi.status,202,JSON.stringify(multi.data));
    const b1=await uploadReference('b1.jpg','b'), b2=await uploadReference('b2.jpg','b');
    assert.equal((await api(`/r/${b1.id}`,{user:'admin'})).status,404);
    const frames = await api('/api/video-generations',{user:'b',method:'POST',body:{
      mode:'keyframes', workflow:'minimax_h3_lightx2v', prompt:'transition prompt', parameters:{duration:5,resolution:'480p竖'}, referenceIds:[b1.id,b2.id],
    }});
    assert.equal(frames.status,202,JSON.stringify(frames.data));
    assert.equal(videoWorkflowCalls[0].workflow,'minimax_h3_lightx2v_no_pic');
    assert.equal(videoWorkflowCalls[0].input.duration,5);
    assert.equal(videoWorkflowCalls[0].input.resolution,'768p竖');
    assert.equal(videoWorkflowCalls[0].input.ref_image_0,undefined);
    assert.equal(videoWorkflowCalls[1].workflow,'minimax_h3_lightx2v_v5_15s');
    assert.match(videoWorkflowCalls[1].input.ref_image_0,/\/r\/ref_/);
    assert.match(videoWorkflowCalls[1].input.ref_image_1,/\/r\/ref_/);
    assert.equal(videoWorkflowCalls[2].workflow,'minimax_h3_lightx2v');
    assert.match(videoWorkflowCalls[2].input.first_frame,/\/r\/ref_/);
    assert.match(videoWorkflowCalls[2].input.last_frame,/\/r\/ref_/);
    assert.equal(videoWorkflowCalls[2].input.ref_image_0,undefined);
  });
  await t.test('assets survive task dismissal and support owner-only download, reuse and independent deletion', async () => {
    const image = await uploadReference('library.jpg');
    assert.equal(image.expiresAt, null);
    const imageAssetId = `reference:${image.id}`;
    const assetRoute = `/api/assets/${encodeURIComponent(imageAssetId)}`;
    const list = await api('/api/assets');
    assert.ok(list.data.assets.some((asset) => asset.id === imageAssetId && asset.kind === 'image'));
    assert.ok(list.data.assets.some((asset) => asset.id === 'prompt:video_finished' && asset.text.includes('提示词')));
    assert.equal((await api(`${assetRoute}/content`, {user:'b'})).status, 404);
    assert.equal((await api(assetRoute, {user:'b',method:'DELETE'})).status, 404);
    const reuse = await api(`${assetRoute}/reference`, {method:'POST',body:{}});
    assert.equal(reuse.status,201); assert.notEqual(reuse.data.reference.id,image.id);
    assert.equal(reuse.data.reference.kind,'image');
    assert.equal((await api('/api/video-generations/video_2',{user:'a',method:'DELETE'})).status,409);
    assert.equal((await api('/api/video-generations/video_2',{user:'admin',method:'DELETE'})).status,404);
    const inUseAsset = list.data.assets.find((asset) => asset.name === 'a1.jpg');
    const inUse = await api(`/api/assets/${encodeURIComponent(inUseAsset.id)}`, {method:'DELETE'});
    assert.equal(inUse.status,409);
    assert.equal((await api('/api/video-generations/video_finished',{user:'admin'})).status,404);
    assert.equal((await api('/api/assets',{user:'admin'})).data.assets.some((asset) => asset.id === 'prompt:video_finished'), false);
    assert.equal((await api('/api/video-generations/video_finished',{method:'DELETE'})).status,200);
    const saved = '/api/assets/'+encodeURIComponent('generation:video_finished:0');
    const media = await fetch(base+saved+'/content?dl=1',{headers:{Cookie:'clp_sid=a',Range:'bytes=0-31'}});
    assert.equal(media.status,206); assert.equal((await media.arrayBuffer()).byteLength,32);
    assert.match(media.headers.get('content-disposition'),/attachment/);
    assert.equal((await api(saved,{method:'DELETE'})).status,200);
    assert.equal((await api(saved+'/content')).status,404);
    assert.equal((await api(assetRoute,{method:'DELETE'})).status,200);
    assert.equal((await api(`/r/${reuse.data.reference.id}`)).status,404);
    const after = await api('/api/assets');
    assert.ok(!after.data.assets.some(asset=>asset.id===imageAssetId || asset.id==='generation:video_finished:0'));
    assert.ok(after.data.assets.some(asset=>asset.id==='prompt:video_finished'));
  });
  await t.test('failed tasks can be dismissed and the current panel never falls back to older tasks', async () => {
    const current = await api('/api/video-generations/current',{user:'poor'});
    assert.equal(current.data.generation.taskId,'newest_failed');
    assert.equal(current.data.generation.duration,5);
    assert.equal(current.data.generation.finishedAt,'2026-01-01T00:00:05Z');
    assert.equal((await api('/api/video-generations/newest_failed',{user:'poor',method:'DELETE'})).status,200);
    assert.equal((await api('/api/video-generations/current',{user:'poor'})).data.generation,null);
    const rejected = await api('/api/video-generations',{user:'poor',method:'POST',body:{
      mode:'text', workflow:'minimax_h3_lightx2v_no_pic', prompt:'force submission failure',
      parameters:{duration:5,resolution:'768p竖'}, referenceIds:[],
    }});
    assert.equal(rejected.status,402);
    const failure = rejected.data.generation;
    assert.equal(failure.status,'FAILED'); assert.equal(failure.failureStage,'submission');
    assert.equal((await api('/api/video-generations/current',{user:'poor'})).data.generation.taskId,failure.taskId);
    assert.equal((await api(`/api/video-generations/${failure.taskId}`,{user:'a',method:'DELETE'})).status,404);
    assert.equal((await api(`/api/video-generations/${failure.taskId}`,{user:'poor',method:'DELETE'})).status,200);
    assert.equal((await api('/api/video-generations/current',{user:'poor'})).data.generation,null);
    assert.ok((await api('/api/assets',{user:'poor'})).data.assets.some(asset=>asset.text==='force submission failure'));
    const refused=await api('/api/video-generations',{user:'poor',method:'POST',body:{mode:'text',prompt:'force safety refusal'}});
    assert.equal(refused.status,400);assert.equal(refused.data.errorCode,'PROVIDER_CONTENT_REJECTED');
    assert.match(refused.data.error,/内容审核/);assert.match(refused.data.error,/未说明具体/);
    assert.equal(refused.data.generation.failureStage,'submission');assert.equal(refused.data.generation.duration,0);
  });
  await t.test('asset batch deletion and clear-all are scoped to the owner and retain active references',async()=>{
    const first=await uploadReference('bulk-one.jpg','bulk');
    const second=await uploadReference('bulk-two.jpg','bulk');
    const third=await uploadReference('bulk-three.jpg','bulk');
    const foreign=await uploadReference('foreign.jpg','b');
    const firstId=`reference:${first.id}`, secondId=`reference:${second.id}`;
    assert.equal((await api('/api/assets/delete',{user:'bulk',method:'POST',body:{assetIds:[firstId,`reference:${foreign.id}`]}})).status,404);
    assert.equal((await api(`/r/${first.id}`,{user:'bulk'})).status,200);
    const selected=await api('/api/assets/delete',{user:'bulk',method:'POST',body:{assetIds:[firstId,secondId]}});
    assert.equal(selected.status,200); assert.equal(selected.data.deletedIds.length,2);
    assert.ok(selected.data.deletedReferenceIds.includes(first.id));
    const clear=await api('/api/assets/delete',{user:'bulk',method:'POST',body:{all:true}});
    assert.deepEqual(clear.data.deletedIds,[`reference:${third.id}`]);
    assert.equal((await api('/api/assets',{user:'bulk'})).data.assets.length,0);
    assert.equal((await api(`/r/${foreign.id}`,{user:'b'})).status,200);
    const activeAsset=(await api('/api/assets')).data.assets.find((asset)=>asset.name==='a1.jpg');
    const protectedResult=await api('/api/assets/delete',{method:'POST',body:{assetIds:[activeAsset.id]}});
    assert.equal(protectedResult.data.deletedIds.length,0); assert.equal(protectedResult.data.skipped.length,1);
  });
  await t.test('a slow concurrent submission cannot create a second generation and active tasks cannot be deleted',async()=>{
    const payload=JSON.stringify({mode:'text',prompt:'single task, five seconds',parameters:{duration:5,resolution:'768p竖'},referenceIds:[]});
    const before=videoWorkflowCalls.length;
    const slow=http.request(base+'/api/video-generations',{method:'POST',headers:{Cookie:'clp_sid=serial','Content-Type':'application/json'}});
    const slowResult=new Promise((resolve,reject)=>{slow.on('response',async(res)=>{for await(const chunk of res) {} resolve(res.statusCode);});slow.on('error',reject);});
    slow.write(payload.slice(0,10)); await sleep(100);
    const first=await api('/api/video-generations',{user:'serial',method:'POST',body:JSON.parse(payload)});
    assert.equal(first.status,202); slow.end(payload.slice(10));
    assert.equal(await slowResult,409);
    assert.equal(videoWorkflowCalls.length,before+1); assert.equal(videoWorkflowCalls.at(-1).input.duration,5);
    assert.equal((await api(`/api/video-generations/${first.data.taskId}`,{user:'serial',method:'DELETE'})).status,409);
    assert.equal((await api('/api/video-generations',{user:'serial',method:'POST',body:JSON.parse(payload)})).status,409);
  });
  await t.test('recreation requires one real video of at most 15 seconds and replacement images without falling back to image generation',async()=>{
    const uploadVideo=async(duration,purpose='recreation')=>api('/api/video-references',{user:'recreation',method:'POST',raw:String(duration),
      headers:{'X-File-Name':'reference.mp4','Content-Type':'video/mp4','x-reference-purpose':purpose}});
    const before=videoWorkflowCalls.length;
    const longUpload=await uploadVideo(15.01);
    assert.equal(longUpload.status,400); assert.match(longUpload.data.error,/15 秒/);
    const genericLong=await uploadVideo(16,'asset'); assert.equal(genericLong.status,201);
    const video=await uploadVideo(15); assert.equal(video.status,201);
    assert.equal(video.data.reference.durationSec,15);
    const image=await uploadReference('replacement.jpg','recreation');
    const post=(refs,target='subject')=>api('/api/video-generations',{user:'recreation',method:'POST',body:{
      mode:'recreation',prompt:'保留动作，替换主体',replacementTarget:target,referenceIds:refs}});
    assert.equal((await post([image.id])).status,400);
    assert.equal((await post([video.data.reference.id])).status,400);
    assert.equal((await post([genericLong.data.reference.id,image.id])).status,400);
    assert.equal((await post([video.data.reference.id,image.id],'invalid')).status,400);
    const result=await post([video.data.reference.id,image.id],'background');
    assert.equal(result.status,202,JSON.stringify(result.data));
    assert.equal(result.data.prompt,'保留动作，替换主体');
    assert.equal(JSON.stringify(result.data).includes(EXPECTED_GENERATION_CONSTRAINTS),false);
    const job=generationJobs.get(result.data.taskId);
    assert.equal(job.input.model,'MiniMax-H3'); assert.equal(job.input.resolution,'768P');
    assert.equal(job.input.ratio,'9:16'); assert.equal(job.input.duration,5);
    assert.equal(job.input.content[1].role,'reference_video');
    assert.equal(job.input.content[2].role,'reference_image');
    assert.match(job.input.content[1].video_url.url,/signature|sig|token/);
    assert.match(job.input.content[0].text,/保持原视频主体/);
    assert.equal((await api('/api/video-generations/'+result.data.taskId,{user:'a'})).status,404);
    assert.equal((await api('/api/video-generations/'+result.data.taskId,{user:'recreation',method:'DELETE'})).status,409);
    job.status='succeeded';job.content={url:'https://example.com/recreated.mp4'};
    const complete=await api('/api/video-generations/'+result.data.taskId,{user:'recreation'});
    assert.equal(complete.data.status,'SUCCESS');
    assert.ok(JSON.stringify(complete.data.results).includes('recreated.mp4'));
    assert.equal((await api('/api/video-generations/'+result.data.taskId,{user:'recreation',method:'DELETE'})).status,200);
    assert.equal(videoWorkflowCalls.length,before);
    assert.equal((await api('/api/video-generations/current',{user:'recreation'})).data.generation,null);
    const reuse=await api(`/api/assets/${encodeURIComponent('reference:'+genericLong.data.reference.id)}/reference`,{
      user:'recreation',method:'POST',body:{purpose:'recreation'}});
    assert.equal(reuse.status,400);
    const config=await api('/api/config'); assert.equal(config.data.videoGeneration.recreation.ready,true);
    assert.deepEqual(config.data.videoGeneration.durations,[5,10,15]);
    const batchRequest={mode:'recreation',prompt:'替换主体，保留动作',replacementTarget:'subject',count:2,
      referenceIds:[video.data.reference.id,image.id],parameters:{duration:10,resolution:'768p竖'}};
    const batch=await api('/api/video-generations',{user:'recreation',method:'POST',body:batchRequest});
    assert.equal(batch.status,202,JSON.stringify(batch.data));
    const firstId=[...generationJobs.keys()].filter(id=>id.startsWith('h3_video_')).at(-1);
    assert.ok(firstId);assert.equal(batch.data.variants[1].status,'PENDING');
    const firstJob=generationJobs.get(firstId);
    assert.equal(firstJob.input.duration,10);assert.match(firstJob.input.content[0].text,/保持原视频背景/);
    assert.equal(Object.hasOwn(firstJob.input,'seed'),false);
    firstJob.status='succeeded';firstJob.content={url:'https://example.com/variant-one.mp4'};
    const next=await api('/api/video-generations/'+batch.data.taskId,{user:'recreation'});
    const secondId=[...generationJobs.keys()].filter(id=>id.startsWith('h3_video_')).at(-1);assert.notEqual(secondId,firstId);
    const secondJob=generationJobs.get(secondId);
    assert.notEqual(firstJob.input.content[0].text,secondJob.input.content[0].text);
    assert.match(secondJob.input.content[0].text,/严格保留原视频的动作/);
    secondJob.status='failed';secondJob.error={message:'reference validation failed'};
    const partial=await api('/api/video-generations/'+batch.data.taskId,{user:'recreation'});
    assert.equal(partial.data.status,'PARTIAL');
    assert.equal((await api('/api/video-generations/'+batch.data.taskId,{user:'recreation',method:'DELETE'})).status,200);

  });
  await t.test('a variant batch submits sequentially, survives restart and retains independent results',async()=>{
    const image=await uploadReference('batch-subject.jpg','variants');
    const before=videoWorkflowCalls.length;
    const request={mode:'multi_image',prompt:'同一商品的三种展示',count:3,referenceIds:[image.id],parameters:{duration:5,resolution:'768p竖'}};
    const created=await api('/api/video-generations',{user:'variants',method:'POST',body:request});
    assert.equal(created.status,202); assert.equal(created.data.isBatch,true); assert.equal(created.data.count,3);
    const parentId=created.data.taskId;
    assert.equal(videoWorkflowCalls.length,before+1);
    assert.equal((await api('/api/video-generations',{user:'variants',method:'POST',body:request})).status,409);
    assert.equal((await api(`/api/video-generations/${parentId}`,{user:'variants',method:'DELETE'})).status,409);
    await Promise.all(Array.from({length:4},()=>api('/api/video-generations/current',{user:'variants'})));
    assert.equal(videoWorkflowCalls.length,before+1);
    const finish=(offset,url)=>generationJobs.set(videoWorkflowCalls[before+offset].taskId,{status:'SUCCESS',results:[{url,type:'video'}]});
    finish(0,`http://127.0.0.1:${upstream.address().port}/asset/variation-1`);
    let current=(await api('/api/video-generations/current',{user:'variants'})).data.generation;
    assert.equal(current.successCount,1); assert.equal(videoWorkflowCalls.length,before+2);
    assert.equal((await api(`/api/video-generations/${videoWorkflowCalls[before].taskId}`,{user:'variants',method:'DELETE'})).status,409);
    child.kill('SIGTERM'); await once(child,'exit'); child=launch();
    await until(async()=>{try{return (await fetch(base+'/api/auth/session')).ok;}catch{return false;}});
    await api('/api/video-generations/current',{user:'variants'});
    assert.equal(videoWorkflowCalls.length,before+2);
    finish(1,`http://127.0.0.1:${upstream.address().port}/asset/variation-2`);
    await api('/api/video-generations/current',{user:'variants'});
    assert.equal(videoWorkflowCalls.length,before+3);
    finish(2,`http://127.0.0.1:${upstream.address().port}/asset/variation-3`);
    current=(await api('/api/video-generations/current',{user:'variants'})).data.generation;
    assert.equal(current.status,'SUCCESS'); assert.equal(current.successCount,3); assert.equal(current.results.length,3);
    const calls=videoWorkflowCalls.slice(before,before+3);
    assert.equal(new Set(calls.map((call)=>call.input.prompt)).size,3);
    assert.equal(new Set(calls.map((call)=>call.input.seed)).size,3);
    assert.ok(calls.every((call)=>call.input.ref_image_0.includes(`/r/${image.id}`)));
    assert.equal((await api(`/api/video-generations/${parentId}`,{user:'admin'})).status,404);
    const assets=(await api('/api/assets',{user:'variants'})).data.assets;
    assert.ok(calls.every((call)=>assets.some((asset)=>asset.id===`generation:${call.taskId}:0`)));
    assert.equal((await api(`/api/video-generations/${parentId}`,{user:'variants',method:'DELETE'})).status,200);
    assert.equal((await api('/api/video-generations/current',{user:'variants'})).data.generation,null);
  });
  await t.test('batch submissions stop on rejection, report duplicate results and validate count',async()=>{
    const beforeAttempts=videoSubmissionAttempts.length;
    const failure=await api('/api/video-generations',{user:'batch_failure',method:'POST',body:{mode:'text',prompt:'force submission failure',count:5}});
    assert.equal(failure.status,202);assert.equal(failure.data.status,'FAILED');
    assert.equal(videoSubmissionAttempts.length,beforeAttempts+1);
    assert.equal(failure.data.variants.filter((variant)=>variant.status==='SKIPPED').length,4);
    const invalid=await api('/api/video-generations',{user:'bad_count',method:'POST',body:{mode:'text',prompt:'test',count:4}});
    assert.equal(invalid.status,400);
    const before=videoWorkflowCalls.length;
    const created=await api('/api/video-generations',{user:'duplicates',method:'POST',body:{mode:'text',prompt:'same result defense',count:2}});
    assert.equal(created.status,202);
    const url=`http://127.0.0.1:${upstream.address().port}/asset/same-result`;
    generationJobs.set(videoWorkflowCalls[before].taskId,{status:'SUCCESS',results:[{url}]});
    await api('/api/video-generations/current',{user:'duplicates'});
    generationJobs.set(videoWorkflowCalls[before+1].taskId,{status:'SUCCESS',results:[{url}]});
    const current=(await api('/api/video-generations/current',{user:'duplicates'})).data.generation;
    assert.equal(current.status,'PARTIAL');assert.equal(current.successCount,1);assert.equal(current.results.length,1);
    assert.equal(current.variants[1].status,'DUPLICATE');
    const ten=await api('/api/video-generations',{user:'ten_variants',method:'POST',body:{mode:'text',prompt:'ten variants',count:10}});
    assert.equal(ten.status,202);assert.equal(ten.data.variants.length,10);
  });
  const file=await upload(3.2);
  await t.test('raw media IDs require login and signed provider URLs are short-lived and owner-bound', async () => {
    const uploaded = await api('/api/uploads', { method:'POST', raw:'signed-media', headers:{'X-File-Name':'private.mp4'} });
    assert.equal(uploaded.status,200);
    const fileUrl = new URL(uploaded.data.file.url);
    assert.ok(fileUrl.searchParams.has('signature'));
    assert.equal((await fetch(base + fileUrl.pathname)).status,401);
    assert.equal((await fetch(fileUrl)).status,200);
    assert.equal((await api(fileUrl.pathname,{user:'b'})).status,404);
    assert.equal((await api(fileUrl.pathname,{user:'admin'})).status,404);
    const tampered = new URL(fileUrl); tampered.searchParams.set('signature','bad');
    assert.equal((await fetch(tampered)).status,401);
    const expired = new URL(fileUrl); expired.searchParams.set('expires',String(Math.floor(Date.now()/1000)-1));
    assert.equal((await fetch(expired)).status,401);
    assert.equal((await api(fileUrl.pathname)).status,200);

    const ref = await uploadReference('private.jpg');
    const referenceUrl = new URL(ref.url);
    assert.equal((await fetch(base + referenceUrl.pathname)).status,401);
    assert.equal((await fetch(referenceUrl)).status,200);
    assert.equal((await api(referenceUrl.pathname,{user:'admin'})).status,404);
    assert.equal((await api(referenceUrl.pathname,{user:'b'})).status,404);
    assert.equal((await api(referenceUrl.pathname)).status,200);
  });
  await t.test('legacy process route requires credits and rejects invalid media',async()=>{
    const poorFile=await upload(3.2,'poor');
    const r=await api(`/api/files/${poorFile}/process`,{user:'poor',method:'POST',body:{durationSec:1}});
    assert.equal(r.status,402);assert.equal(upstreamTasks.size,0);
    const invalid=await upload('not a video');
    assert.equal((await api('/api/batches',{method:'POST',body:{fileIds:[invalid],durations:{[invalid]:1}}})).status,422);
  });
  const bFile=await upload(3.2,'b');
  const a=await batch(file), b=await batch(bFile,{user:'b'});
  const aId=a.items[0].taskId, bId=b.items[0].taskId;
  await t.test('same bytes are not shared between users or different processing settings',async()=>{
    assert.notEqual(aId,bId);
    const strong=await batch(file,{erasePreset:'fullscreen'});
    const enhanced=await batch(file,{operation:'enhance',resolution:'1080p'});
    assert.notEqual(aId,strong.items[0].taskId);assert.notEqual(aId,enhanced.items[0].taskId);
    assert.equal((await batch(file)).items[0].taskId,aId);
    assert.equal((await cancel(aId,'b')).status,404);
    const encoded = '%74' + aId.slice(1);
    assert.equal((await api(`/api/tasks/${encoded}`,{user:'b'})).status,404);
    assert.equal((await api(`/api/tasks/${encoded}`,{user:'b',method:'DELETE'})).status,404);
    assert.equal((await api('/api/batches',{method:'POST',user:'b',body:{fileIds:[file]}})).status,404);
    assert.equal((await api(`/api/files/${file}`,{method:'DELETE',user:'b'})).status,404);
  });
  await t.test('batch preserves tool options and enhancement version', async () => {
    const face = await batch(file, { operation: 'face-blur', options: { maskMode: 'blur', strength: 'high' } });
    const faceTask = await task(face.items[0].taskId);
    assert.deepEqual(faceTask.options, { maskMode: 'blur', strength: 'high' });
    const enhance = await batch(file, { operation: 'enhance', resolution: '2k', toolVersion: 'professional' });
    const enhanceTask = await task(enhance.items[0].taskId);
    assert.equal(enhanceTask.resolution, '2k');
    assert.equal(enhanceTask.toolVersion, 'professional');

    const custom = await batch(file, { eraseRegion: 'top', eraseMode: 'Text', modelVersion: 'v5' });
    const extraFile = await upload(4.2);
    const appended = await api(`/api/batches/${custom.batch.id}/items`, {
      method: 'POST', body: { fileIds: [extraFile] },
    });
    assert.equal(appended.status, 202, JSON.stringify(appended.data));
    const appendedTask = await task(appended.data.items.at(-1).taskId);
    assert.equal(appendedTask.mode, 'Text');
    assert.equal(appendedTask.modelVersion, 'v5');
    assert.equal(appendedTask.eraseRatioLocation[0].bottom_right_y, 0.5);
  });
  await t.test('admins cannot read or control another user task; its owner receives any refund',async()=>{
    assert.equal((await api(`/api/tasks/${aId}` ,{user:'admin'})).status,404);
    assert.equal((await start(aId,'admin')).status,404);
    assert.equal((await api(`/api/batches/${a.batch.id}`,{user:'admin'})).status,404);
    assert.equal((await api(`/api/download/${aId}`,{user:'admin'})).status,404);
    assert.equal((await api(`/f/${file}`,{user:'admin'})).status,404);
    assert.equal((await api('/api/tasks',{user:'admin'})).data.tasks.some((entry)=>entry.id===aId),false);
    assert.equal(await credits('admin'),100);assert.equal(await credits(),100);
    assert.equal((await start(aId)).status,202);
    assert.equal(await credits(),96);
    await until(()=>upstreamTasks.size===1);
    assert.equal((await cancel(aId,'admin')).status,404);
    assert.equal((await cancel(aId)).status,200);
    assert.equal(await credits('admin'),100);assert.equal(await credits(),100);
    await sleep(1200);
  });
  await t.test('queued single and batch cancellation refund once and never launch later',async()=>{
    assert.equal((await start(bId,'b')).status,202);
    await until(()=>upstreamTasks.size===2);
    assert.equal((await start(aId)).status,202);assert.equal(await credits(),96);
    assert.equal((await task(aId)).status,'pending');
    await cancel(aId);await cancel(aId);assert.equal(await credits(),100);
    assert.equal((await start(aId)).status,202);
    assert.equal((await api(`/api/batches/${a.batch.id}`,{method:'DELETE',body:{indexes:[0]}})).status,200);
    assert.equal(await credits(),100);
    await cancel(bId,'b');await sleep(1200);
    assert.equal(upstreamTasks.size,2);assert.equal((await task(aId)).status,'canceled');
  });
  await t.test('enhancement is its own operation: single pass, 1x charge, resumes after restart',async()=>{
    const e=await batch(file,{operation:'enhance',resolution:'1080p'});const id=e.items[0].taskId;
    assert.equal((await start(id)).status,202);assert.equal(await credits(),96);   // 3.2 秒 → 4 积分（1 倍）
    await until(()=>upstreamTasks.size===3);
    const mid=await task(id);assert.equal(mid.status,'processing');assert.equal(mid.stageKey,'enhance');assert.equal(mid.result,undefined);
    assert.equal((await api(`/api/download/${id}`)).status,409);
    // 重启后凭已保存的云端任务号接管，不重复提交
    await sleep(150);
    child.kill('SIGTERM'); await once(child, 'exit');
    child = launch();
    await until(async()=>{try{return (await fetch(base+'/api/auth/session')).ok;}catch{return false;}});
    assert.equal((await task(id)).status, 'processing');
    upstreamTasks.get('remote_3').state='completed';
    await until(async()=>(await task(id)).status==='succeeded').catch(err=>{throw new Error(err.message+'\n'+logs);});
    assert.equal(upstreamTasks.size,3);
    const result=await api(`/api/download/${id}`);assert.equal(result.status,302);assert.match(result.headers.get('location'),/\/asset\/enhance$/);
    // 同参数复用；不同分辨率 / 去字幕不复用
    assert.equal((await batch(file,{operation:'enhance',resolution:'1080p'})).items[0].taskId,id);
    assert.notEqual((await batch(file,{operation:'enhance',resolution:'720p'})).items[0].taskId,id);
    assert.notEqual((await batch(file)).items[0].taskId,id);
  });
  await t.test('batch start charges each unique task once and reports insufficient balance', async () => {
    const f = await upload(2.6);
    // 建批次现在要求文件属于当前账号：poor 用自己的文件测试余额不足
    const poorFile = await upload(2.6, 'poor');
    const poor = await batch(poorFile, { user: 'poor' });
    const rejected = await api(`/api/batches/${poor.batch.id}/start`, { user: 'poor', method: 'POST', body: {} });
    assert.equal(rejected.data.started, 0); assert.equal(rejected.data.insufficient.length, 1);
    const r = await api('/api/batches', { method: 'POST', body: { fileIds: [f, f], durations: { [f]: 0.01 } } });
    assert.equal(r.status, 202); assert.equal(r.data.items[0].taskId, r.data.items[1].taskId);
    const before = await credits();
    const launch = await api(`/api/batches/${r.data.batch.id}/start`, { method: 'POST', body: {} });
    assert.equal(launch.data.started, 1); assert.equal(await credits(), before - 3);
    await api(`/api/batches/${r.data.batch.id}/start`, { method: 'POST', body: {} });
    assert.equal(await credits(), before - 3);
    await api(`/api/batches/${r.data.batch.id}`, { method: 'DELETE', body: {} });
    assert.equal(await credits(), before);
  });
  await t.test('single-file route charges the verified duration and assigns owner',async()=>{
    const before=await credits();
    const r=await api(`/api/files/${file}/process`,{method:'POST',body:{durationSec:0.01}});
    assert.equal(r.status,202);assert.equal(r.data.task.userId,'a');assert.equal(r.data.task.chargedCredits,4);
    assert.equal(await credits(),before-4);
    await cancel(r.data.task.id);
    assert.equal(await credits(),before);   // 取消立即退款
  });
  await t.test('ASR burn keeps options and downloads the generated MP4 path', async () => {
    const r = await batch(file, { operation: 'asr-subtitles', options: { language: 'eng-US', burn: true } });
    const tid = r.items[0].taskId;
    assert.equal((await start(tid)).status, 202);
    await until(() => [...upstreamTasks.values()].some((x) => x.type === 'asr'));
    const remote = [...upstreamTasks.values()].find((x) => x.type === 'asr');
    assert.equal(remote.input.language, 'eng-US');
    remote.state = 'completed';
    await until(async () => (await task(tid)).status === 'succeeded').catch(err=>{throw new Error(err.message+'\n'+logs);});
    const completed = await task(tid);
    assert.match(completed.result.name, /\.mp4$/);
    const downloaded = await api(`/api/download/${tid}`);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-type'), /video\/mp4/);
  });
  await t.test('provider constraints never enter prompt assets or task records',async()=>{
    const assets=(await api('/api/assets',{user:'admin'})).data;
    assert.equal(JSON.stringify(assets).includes(EXPECTED_GENERATION_CONSTRAINTS),false);
    const records=await api('/api/video-generations/current',{user:'recreation'});
    assert.equal(JSON.stringify(records.data).includes(EXPECTED_GENERATION_CONSTRAINTS),false);
    await until(async()=>{const saved=JSON.parse(await fs.readFile(path.join(dir,'db.json'),'utf8'));return Object.values(saved.videoGenerations||{}).length>0;});
    const saved=await fs.readFile(path.join(dir,'db.json'),'utf8');
    assert.equal(saved.includes(EXPECTED_GENERATION_CONSTRAINTS),false);
  });
  await t.test('watermark click starts only the newly appended task and retains insufficient-credit entries',async()=>{
    const first=await api('/api/batches/from-urls',{method:'POST',body:{content:'https://8.8.8.8/queued.mp4'}});
    assert.equal(first.status,202);
    const second=await api('/api/batches/from-urls',{method:'POST',body:{content:'完整分享文案\nhttps://8.8.8.8/start-now.mp4 #产品',batchId:first.data.batch.id,autoStart:true}});
    assert.equal(second.status,202);assert.equal(second.data.startError,null);assert.equal(second.data.items.length,2);
    const old=await task(first.data.items[0].taskId);assert.equal(old.status,'pending');assert.ok(!old.chargedCredits);
    const newId=second.data.items[1].taskId;const started=await task(newId);
    assert.ok(['pending','processing'].includes(started.status));assert.equal(started.chargedCredits,5);
    await cancel(newId);
    const poor=await api('/api/batches/from-urls',{user:'poor',method:'POST',body:{content:'https://8.8.8.8/no-credit.mp4',autoStart:true}});
    assert.equal(poor.status,202);assert.match(poor.data.startError,/积分/);assert.equal(poor.data.items.length,1);
  });
});

test('enhancement response envelopes resolve to string URLs and numeric duration', async()=>{
  const original=globalThis.fetch, key=process.env.AMK_API_KEY;
  process.env.AMK_API_KEY='unit-test';
  try {
    for(const envelope of [false,true]) {
      globalThis.fetch=async(url,opts)=>{
        if(opts?.method==='HEAD') return new Response(null,{headers:{'content-length':'2048'}});
        const payload={status:'completed',result:{video_url:'https://example.invalid/output.mp4',duration:12}};
        return Response.json(envelope?{data:payload}:payload);
      };
      const r=await enhanceVideo('https://example.invalid/source.mp4',{taskId:'existing',pollMs:1});
      assert.equal(r.url,'https://example.invalid/output.mp4');assert.equal(r.duration,12);
    }
  } finally { globalThis.fetch=original;if(key===undefined)delete process.env.AMK_API_KEY;else process.env.AMK_API_KEY=key; }
});

test('new cloud tools unwrap nested result payloads', async () => {
  const original = globalThis.fetch, key = process.env.AMK_API_KEY, base = process.env.AMK_API_BASE;
  process.env.AMK_API_KEY = 'unit-test'; process.env.AMK_API_BASE = 'https://example.invalid/api';
  try {
    const videoResult = { video_url: 'https://example.invalid/output.mp4', duration: 12, resolution: '1080p' };
    for (const envelope of [false, true]) {
      const wrap = (payload) => envelope ? { data: payload } : payload;
      globalThis.fetch = async (_url, opts = {}) => {
        if (opts.method === 'POST') return Response.json(wrap({ task_id: 'remote-1' }));
        if (opts.method === 'HEAD') return new Response(null, { headers: { 'content-length': '2048' } });
        return Response.json(wrap({ status: 'completed', result: videoResult }));
      };
      const tr = await runTranscode('https://example.invalid/source.mp4', { pollMs: 1, timeoutMs: 100 });
      assert.equal(tr.url, videoResult.video_url); assert.equal(tr.duration, 12);
      const tool = await runToolVideo('face-blur-video', 'https://example.invalid/source.mp4', {}, { pollMs: 1, timeoutMs: 100 });
      assert.equal(tool.url, videoResult.video_url); assert.equal(tool.duration, 12);

      const subtitleResult = { subtitles: [{ start_time: 0, end_time: 1, subtitle_text: 'hello' }] };
      globalThis.fetch = async (_url, opts = {}) => opts.method === 'POST'
        ? Response.json(wrap({ task_id: 'remote-2' }))
        : Response.json(wrap({ status: 'completed', result: subtitleResult }));
      assert.equal((await runAsr('https://example.invalid/source.mp4', { pollMs: 1, timeoutMs: 100 })).subtitles[0].text, 'hello');
      assert.equal((await runOcr('https://example.invalid/source.mp4', { pollMs: 1, timeoutMs: 100 })).subtitles[0].text, 'hello');
    }
  } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.AMK_API_KEY; else process.env.AMK_API_KEY = key;
    if (base === undefined) delete process.env.AMK_API_BASE; else process.env.AMK_API_BASE = base;
  }
});

test('upload abort settles its promise and prevents a canceled upload from being sent',async()=>{
  const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function uploadFile('),source.indexOf('/** 上传都落定后'));
  let sent=0;
  class XHR { upload={};open(){}setRequestHeader(){}send(){sent++;}abort(){this.onabort?.();} }
  const context=vm.createContext({XMLHttpRequest:XHR,render(){}});vm.runInContext(code,context);
  const item={name:'test.mp4',file:{}};const p=context.uploadFile(item,'md5');item.xhr.abort();
  await assert.rejects(p,{name:'AbortError'});
  await assert.rejects(context.uploadFile({...item,canceled:true},'md5'),{name:'AbortError'});assert.equal(sent,1);
});

test('missing probe fails closed instead of accepting a client duration',async()=>{
  const previous=process.env.FFPROBE_PATH;process.env.FFPROBE_PATH='/missing/ffprobe';
  try {await assert.rejects(probeVideoDuration('/tmp/video.mp4'),{status:503});}
  finally {if(previous===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=previous;}
});


test('session refresh updates countdown and handles expiry', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function refreshHeader()');
  const code = source.slice(start, source.indexOf('\nrefreshHeader();', start));
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  let loginShown = false;
  const context = vm.createContext({ state: { session: { authenticated: true } }, sessionEndsAt: 1, workspaceEpoch: 0,
    el: { adminBtn: {}, sessionLeft: {} }, document: { getElementById: () => ({}) },
    fetch: async () => ({ json: async () => ({ authenticated: true, expiresAt, user: { credits: 5 } }) }),
    fmtCountdown: String, syncEnhance() {}, showLogin() { loginShown = true; } });
  vm.runInContext(code, context);
  await context.refreshHeader();
  assert.equal(context.sessionEndsAt, Date.parse(expiresAt));
  context.fetch = async () => ({ json: async () => ({ authenticated: false }) });
  await context.refreshHeader();
  assert.equal(context.sessionEndsAt, null); assert.equal(loginShown, true);
});

test('a late generation poll cannot replace the current preview', async () => {
  const source = await fs.readFile('public/app.js','utf8');
  const start = source.indexOf('async function monitorGeneration(initial)');
  const end = source.indexOf("document.getElementById('generationDelete')",start);
  let resolvePoll;
  const rendered = [];
  const context = vm.createContext({ generationMonitorToken:0,
    ACTIVE_GENERATION_STATES:new Set(['RUNNING','QUEUED']),
    updateCreationWorkspace:()=>{},syncGenerationMode:()=>{},
    setGenerationLocked:()=>{}, renderGenerationPreview:(generation)=>rendered.push(generation.taskId),
    setTimeout:(callback)=>callback(), jsonApi:()=>new Promise(resolve=>{resolvePoll=resolve;}),
    generationStageDetail:{}, toast:()=>{}, generationStatusText:()=>'',
  });
  vm.runInContext(source.slice(start,end),context);
  const pending = vm.runInContext("monitorGeneration({taskId:'older-task',status:'RUNNING'})",context);
  await until(()=>Boolean(resolvePoll));
  context.generationMonitorToken += 1;
  resolvePoll({taskId:'older-task',status:'SUCCESS'});
  await pending;
  assert.deepEqual(rendered,['older-task']);
});

test('a reference upload from an old account cannot mutate the new workspace', async () => {
  const source = await fs.readFile('public/app.js','utf8');
  const start = source.indexOf('async function uploadVideoReference(');
  const end = source.indexOf('async function runHomeCommand()',start);
  let finish;
  const context = vm.createContext({workspaceEpoch:1,
    currentGenerationMode:()=> 'multi_image',fetch:()=>new Promise(resolve=>{finish=resolve;}), showLogin:()=>{throw new Error('old response must not log out new user');},
  });
  vm.runInContext(source.slice(start,end),context);
  const item = {file:{name:'reference.jpg',type:'image/jpeg'}};
  const pending = context.uploadVideoReference(item,0,1,{silent:true});
  context.workspaceEpoch = 2;
  finish({status:201,ok:true,json:async()=>({reference:{id:'foreign_reference'}})});
  await assert.rejects(pending,{code:'STALE_ACCOUNT'});
  assert.equal(item.referenceId,undefined);
});

test('account reset clears recent assets and invalidates the cached task rendering',async()=>{
  const source = await fs.readFile('public/app.js','utf8');
  const start = source.indexOf('function resetWorkspace()');
  const end = source.indexOf("window.addEventListener('storage'",start);
  const cleared = [];
  let aborted = false;
  const upload = {xhr:{abort(){aborted=true;}}};
  const context = vm.createContext({workspaceEpoch:1,workspaceUserId:'a',lastSig:'old-task-signature',
    state:{items:[upload],downloading:new Set(),selected:new Set()},assetRefreshTimer:null,taskPollTimer:null,
    generationMonitorToken:0,generationBusy:false,el:{},homeCmd:{value:'private prompt'},referenceInput:{value:''},
    document:{getElementById:()=>null,querySelector:(selector)=>({querySelectorAll:()=>[],replaceChildren:()=>cleared.push(selector)})},
    clearTimeout(){},clearInterval(){},stopPolling(){},clearReferenceFiles(){},clearGenerationPreview(){},updateCreationWorkspace(){},
  });
  vm.runInContext(source.slice(start,end),context);
  context.resetWorkspace();
  assert.ok(cleared.includes('#homeAssets')); assert.ok(cleared.includes('#toolsRecent'));
  assert.equal(context.lastSig,''); assert.equal(context.homeCmd.value,'');
  assert.equal(context.workspaceUserId,null); assert.equal(context.workspaceEpoch,2);
  assert.equal(upload.canceled,true); assert.equal(aborted,true);
});

test('the comparison divider moves correctly from either endpoint using the keyboard',async()=>{
  const source = await fs.readFile('public/app.js','utf8');
  const start = source.indexOf('function bindVideoCompare(');
  const end = source.indexOf('\nfunction renderSummary(',start);
  const handlers = new Map();
  const node = () => ({addEventListener(){},setAttribute(){},style:{},textContent:''});
  const stage = {dataset:{},style:{setProperty(){}},getBoundingClientRect:()=>({left:0,width:100})};
  const divider = {...node(),addEventListener:(name,fn)=>handlers.set(name,fn)};
  const nodes = {'.video-compare':stage,'.compare-divider':divider,
    '.compare-source':node(),'.compare-result':node(),'.compare-play':node(),'.compare-seek':node(),
    '.compare-time':node(),'.compare-duration':node()};
  const context = vm.createContext({});
  vm.runInContext(source.slice(start,end),context);
  context.bindVideoCompare({querySelector:(selector)=>nodes[selector]});
  const key = (value)=>handlers.get('keydown')({key:value,preventDefault(){}});
  key('Home'); assert.equal(stage.dataset.split,'0');
  key('ArrowRight'); assert.equal(stage.dataset.split,'2');
  key('End'); assert.equal(stage.dataset.split,'100');
  key('ArrowLeft'); assert.equal(stage.dataset.split,'98');
});

test('ten variants use distinct directions and seeds while preserving keyframe constraints',()=>{
  const variants=createGenerationVariants({prompt:'保留人物与产品，固定原场景',parameters:{duration:5},count:10,mode:'keyframes'});
  assert.equal(new Set(variants.map((variant)=>variant.prompt)).size,10);
  assert.equal(new Set(variants.map((variant)=>variant.parameters.seed)).size,10);
  assert.equal(new Set(variants.map((variant)=>variant.camera)).size,10);
  assert.ok(variants.every((variant)=>variant.prompt.includes('首帧与尾帧图片是固定约束') && variant.prompt.startsWith('保留人物与产品')));
  assert.throws(()=>createGenerationVariants({prompt:'test',parameters:{},count:4,mode:'text'}),/生成条数/);
});

test('identical generated file hashes are marked duplicate even when result URLs differ',async()=>{
  const source=await fs.readFile('server.mjs','utf8');
  const start=source.indexOf('function deduplicateBatchVariants(');
  const end=source.indexOf('\nfunction finishVideoBatch(',start);
  const context=vm.createContext({db:{videoGenerations:{first:{taskId:'first',results:[{url:'https://one.example/video.mp4'}]},
    second:{taskId:'second',results:[{url:'https://two.example/video.mp4'}]}},
    assets:{'generation:first:0':{sha256:'same-file-hash'},'generation:second:0':{sha256:'same-file-hash'}}},
    resultVideoUrls:(results)=>(results||[]).map((result)=>result.url)});
  vm.runInContext(source.slice(start,end),context);
  const batch={variants:[{taskId:'first',status:'SUCCESS'},{taskId:'second',status:'SUCCESS'}]};
  assert.equal(context.deduplicateBatchVariants(batch),true);
  assert.equal(batch.variants[0].status,'SUCCESS');assert.equal(batch.variants[1].status,'DUPLICATE');
});

test('H3 protocol rejects malformed status and recreation variants retain source motion', async()=>{
  const {normalizeH3Response}=await import('../minimax-h3.mjs');
  assert.throws(()=>normalizeH3Response({task:{id:'x',status:'unknown'}},'GET'),/状态无效/);
  assert.throws(()=>normalizeH3Response({task:{id:'x',status:'succeeded',content:{}}},'GET'),/未返回视频/);
  assert.equal(normalizeH3Response({task:{id:'x',status:'failed',error:{message:'failure'}}},'GET').data.error.message,'failure');
  const variants=createGenerationVariants({mode:'recreation',prompt:'替换产品',parameters:{duration:5,replacementTarget:'subject'},count:10});
  assert.equal(new Set(variants.map(v=>v.prompt)).size,10);
  for (const variant of variants) {
    assert.match(variant.prompt,/严格保留原视频的动作/);
    assert.doesNotMatch(variant.prompt,/镜头：/);
  }
});

test('watermark task switcher keeps one panel and does not restart it on other task updates',async()=>{
  const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('function renderWatermarkTasks('),source.indexOf('function renderNow()'));
  let builds=0,pauses=0;
  class Node {
    constructor(className=''){this.className=className;this.children=[];this.dataset={};}
    setAttribute(){}
    appendChild(node){node.parent=this;this.children.push(node);return node;}
    replaceChildren(...nodes){this.children=[];nodes.forEach(n=>this.appendChild(n));}
    querySelector(selector){return this.children.find(n=>n.className===selector.slice(1))||null;}
    querySelectorAll(){return this.className==='panel'?[{pause(){pauses++;}}]:[];}
    remove(){this.parent.children=this.parent.children.filter(n=>n!==this);}
  }
  const list=new Node();const state={openKey:null};
  const context={state,el:{list},document:{createElement:()=>new Node()},
    structureSig:rows=>JSON.stringify([rows.map(r=>[r.key,r.status]),state.openKey]),
    rowNode:()=>new Node('row'),panelNode:()=>{builds++;return new Node('panel');},patchRows(){}};
  vm.runInNewContext(fn,context);
  const rows=[{key:'one',status:'running'},{key:'two',status:'done',previewUrl:'/two.mp4'}];
  context.renderWatermarkTasks(rows);assert.equal(state.openKey,'two');assert.equal(builds,1);
  rows[0].status='done';context.renderWatermarkTasks(rows);assert.equal(builds,1);assert.equal(pauses,0);
  state.openKey='one';context.renderWatermarkTasks(rows);assert.equal(builds,2);assert.equal(pauses,1);
  assert.equal(list.children.filter(n=>n.className==='panel').length,1);
  context.renderWatermarkTasks(rows.slice(1));assert.equal(state.openKey,'two');assert.equal(builds,3);
  context.renderWatermarkTasks([]);assert.equal(state.openKey,null);assert.equal(list.children.filter(n=>n.className==='panel').length,0);
});

test('legacy safety errors are translated without guessing which input caused the rejection',async()=>{
  const source=await fs.readFile('public/app.js','utf8');
  const code=source.slice(source.indexOf('function generationStatusText('),source.indexOf('function renderGenerationPreview('));
  const context=vm.createContext({currentGenerationMode:()=> 'recreation'});vm.runInContext(code,context);
  assert.equal(context.generationStatusText('FAILED'),'视频复刻失败');
  const message=context.generationFailureMessage({error:'Your input contains content restricted by our safety guidelines.',failureStage:'submission'});
  assert.match(message,/内容审核/);assert.match(message,/未说明具体/);assert.doesNotMatch(message,/政治|违法/);
});

test('a completed recreation cannot appear in the ordinary generation workspace',async()=>{
  const source=await fs.readFile('public/app.js','utf8');
  const code=source.slice(source.indexOf('function renderGenerationPreview('),source.indexOf('async function monitorGeneration('));
  let paused=false;
  const context=vm.createContext({generationPreview:{hidden:false},recreationWorkspace:false,
    generationVideo:{pause(){paused=true;}},document:{getElementById:()=>null}});
  vm.runInContext(code,context);
  context.renderGenerationPreview({taskId:'old-recreation',mode:'recreation',status:'FAILED'});
  assert.equal(context.generationPreview.hidden,true);assert.equal(paused,true);
});
