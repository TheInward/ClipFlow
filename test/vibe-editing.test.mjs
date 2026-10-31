import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEditingRequest,editingRequest} from '../vibe-editing.mjs';

test('Vibe request uses documented nested content, output and idempotency; preserves original speech and supplied product facts',()=>{
  const job={id:'edit_example',mode:'talk',duration:30,ratio:'9:16',subtitles:true,prompt:'保留结尾',product:''};
  const body=buildEditingRequest(job,[{id:'v1',kind:'video'},{id:'a1',kind:'audio'}],id=>`https://example.com/${id}`);
  assert.deepEqual(body.content[1],{type:'video_url',video_url:{url:'https://example.com/v1'}});
  assert.deepEqual(body.content[2],{type:'audio_url',audio_url:{url:'https://example.com/a1'}});
  assert.equal(body.output.resolution,'1080x1920');assert.equal(body.client_token,job.id);
  assert.match(body.content[0].text,/保持原声和原意/);
  const commerce=buildEditingRequest({...job,mode:'commerce',product:'500ml'},[],()=>{});
  assert.match(commerce.content[0].text,/不编造价格/);assert.match(commerce.content[0].text,/500ml/);
});

test('provider rejection is distinguished from uncertain server errors to prevent paid duplicate submission',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>({ok:false,status:403,json:async()=>({error:{message:'Permission denied'}})});
    await assert.rejects(editingRequest('/tools/vibe-editing',{}),e=>e.rejected===true&&e.message==='Permission denied');
    globalThis.fetch=async()=>({ok:false,status:503,json:async()=>({})});
    await assert.rejects(editingRequest('/tools/vibe-editing',{}),e=>e.rejected===false);
  }finally{globalThis.fetch=original;}
});
