import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hypitConfiguration,submitHypitRecreation,queryHypitRecreation} from '../hypit-recreation.mjs';

test('unconfigured Hypit never starts work or falls back to another provider',async()=>{
  const config=hypitConfiguration({});assert.equal(config.ready,false);
  await assert.rejects(submitHypitRecreation({config}),{errorCode:'HYPIT_NOT_CONFIGURED'});
});

test('Hypit project carries real video/image references, checkpoints the Build and exports without resubmitting',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hypit-bridge-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bin=path.join(root,'hypit-cli'),adapter=path.join(root,'adapter.mjs'),profile=path.join(root,'profile.json');
  await fs.writeFile(profile,'{}');
  await fs.writeFile(bin,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2),command=args[0];\nfs.appendFileSync('calls.log',command+'\\n');\nlet value={ok:true};\nif(command==='build')value={format:'hypit.cli-build@1',build:{id:'bld_123'}};\nif(command==='status'){value={format:'hypit.cli-status@1',build:{id:'bld_123',work:{state:'done',outcome:'complete'},result:{state:'complete'}}};}\nif(command==='get'){fs.writeFileSync(args[args.indexOf('--to')+1],Buffer.alloc(128));value={format:'hypit.cli-get@1'};}\nconsole.log(JSON.stringify(value));\n`,{mode:0o755});
  await fs.writeFile(adapter,`import fs from 'node:fs/promises';export async function prepareRecreation({project,brief}){await fs.writeFile(project+'/adapter-input.json',JSON.stringify(brief));await fs.writeFile(project+'/production.svrun','run');return {run:'production.svrun',output:'recreation.video'};}`);
  const config=hypitConfiguration({HYPIT_BIN:bin,HYPIT_VIDEO_ADAPTER:adapter,HYPIT_RUNTIME_PROFILE:profile,HYPIT_RECREATION_ENABLED:'true'});
  assert.equal(config.ready,true);
  await fs.mkdir(path.join(root,'references'));await fs.writeFile(path.join(root,'references/video.mp4'),'actual video bytes');await fs.writeFile(path.join(root,'references/image.jpg'),'actual image bytes');
  const result=await submitHypitRecreation({config,dataDir:root,prompt:'保留动作，更换背景',parameters:{duration:5,resolution:'768p竖',replacementTarget:'background'},references:[{kind:'video',ext:'.mp4',storedPath:'references/video.mp4',durationSec:5},{kind:'image',ext:'.jpg',storedPath:'references/image.jpg'}]});
  const id=result.data.task_id;const project=path.join(root,'hypit',id);
  const brief=JSON.parse(await fs.readFile(path.join(project,'adapter-input.json'),'utf8'));
  assert.equal(brief.referenceVideo.kind,'video');assert.equal(brief.replacementImages.length,1);assert.equal(brief.change,'background');
  assert.equal(await fs.readFile(path.join(project,brief.referenceVideo.path),'utf8'),'actual video bytes');
  const job=JSON.parse(await fs.readFile(path.join(project,'job.json'),'utf8'));assert.equal(job.buildId,'bld_123');
  const first=await queryHypitRecreation(id,{dataDir:root});assert.equal(first.data.status,'SUCCESS');assert.equal((await fs.stat(first.data.outputPath)).size,128);
  await queryHypitRecreation(id,{dataDir:root});
  const calls=(await fs.readFile(path.join(project,'calls.log'),'utf8')).trim().split('\n');
  assert.deepEqual(calls,['check','plan','build','status','get','status']);
  await assert.rejects(queryHypitRecreation('../other-user',{dataDir:root}),{errorCode:'HYPIT_INVALID_TASK'});
});
