/* Vibe Editing workspace. Shared authentication and asset uploads with the studio. */
export function setupEditing({jsonApi,toast,fmtBytes,state,getWorkspaceEpoch}) {
  const byId=id=>document.getElementById(id);
  let mode='talk', files=[], busy=false, timer=null, epoch=0;
  const defaults={talk:'精简明显停顿、口误和重复表达，保留完整观点，让口播自然流畅，字幕简洁清晰。',commerce:'开头突出商品亮点，接着展示细节与使用场景，围绕真实卖点剪辑，结尾引导查看商品详情。'};
  function renderFiles(){
    byId('editFileList').replaceChildren();
    files.forEach((entry,index)=>{
      const row=document.createElement('div');row.className='edit-file';
      const name=document.createElement('span');name.textContent=`${index+1}. ${entry.file.name} · ${fmtBytes(entry.file.size)}`;
      const remove=document.createElement('button');remove.type='button';remove.textContent='移除';remove.disabled=busy;
      remove.onclick=()=>{files.splice(index,1);renderFiles();};row.append(name,remove);byId('editFileList').append(row);
    });
  }
  byId('editModes').onclick=event=>{
    const button=event.target.closest('[data-edit-mode]');if(!button||busy)return;
    const previous=mode;mode=button.dataset.editMode;
    if(byId('editPrompt').value===defaults[previous])byId('editPrompt').value=defaults[mode];
    byId('editProductField').hidden=mode!=='commerce';
    document.querySelectorAll('[data-edit-mode]').forEach(b=>{b.classList.toggle('is-active',b.dataset.editMode===mode);b.setAttribute('aria-pressed',String(b.dataset.editMode===mode));});
  };
  byId('editFiles').onchange=event=>{
    for(const file of event.target.files){
      if(files.length>=12){toast('最多添加 12 个素材');break;}
      if(!/\.(mp4|mov|webm|jpe?g|png|webp|mp3|wav|m4a)$/i.test(file.name)){toast('该素材格式暂不支持');continue;}
      if(file.size>(state.config?.maxUploadBytes||100*1024**2)){toast('素材超过上传大小限制');continue;}
      if(!files.some(e=>e.file.name===file.name&&e.file.size===file.size))files.push({file,referenceId:null});
    }event.target.value='';renderFiles();
  };
  function setBusy(value){busy=value;byId('editSubmit').disabled=value;byId('editSubmit').textContent=value?'正在提交…':'开始剪辑 →';
    byId('editingComposer').querySelectorAll('textarea,select,input,[data-edit-mode]').forEach(n=>n.disabled=value);renderFiles();}
  function renderJobs(jobs){
    const box=byId('editJobs');box.replaceChildren();
    for(const job of jobs){
      const card=document.createElement('article');card.className='edit-job';
      const title=document.createElement('strong');title.textContent=`${job.mode==='talk'?'口播':'带货'} · ${job.duration} 秒 · ${job.ratio}`;
      const status=document.createElement('p');status.textContent=job.error||({submitting:'正在提交',running:'AI 正在分析素材并剪辑，关闭页面后仍会继续',unknown:'提交结果待确认，请联系管理员核查',completed:'剪辑完成',failed:'剪辑失败'})[job.status];card.append(title,status);
      for(const asset of job.assets){
        if(asset.state==='ready'){
          const video=document.createElement('video');video.src=asset.url;video.controls=true;video.playsInline=true;video.preload='metadata';
          const link=document.createElement('a');link.href=asset.downloadUrl;link.className='btn btn-ghost';link.textContent='下载成片';card.append(video,link);
        }else{const note=document.createElement('p');note.textContent=asset.state==='failed'?`成片保存失败：${asset.error}，稍后自动重试`:'正在保存成片到资产…';card.append(note);}
      }box.append(card);
    }
  }
  async function refresh(){
    const token=epoch;
    try{const data=await jsonApi('/api/editing');if(token!==epoch)return;
      byId('editServiceStatus').textContent=data.config.ready?'智能剪辑服务已配置 · 输出 1080P / 30fps':`服务待配置：${data.config.missing.join('、')}`;
      if(!busy)byId('editSubmit').disabled=!data.config.ready;
      renderJobs(data.jobs);
    }catch(err){if(token===epoch)byId('editServiceStatus').textContent=err.message;}
  }
  document.addEventListener('editing-workspace',event=>{
    clearInterval(timer);timer=null;
    if(event.detail==='editing'){refresh();timer=setInterval(refresh,5000);}
  });
  document.addEventListener('editing-reset',()=>{epoch++;files=[];clearInterval(timer);busy=false;setBusy(false);byId('editJobs').replaceChildren();byId('editPrompt').value=defaults[mode];byId('editProduct').value='';});
  byId('editSubmit').onclick=async()=>{
    if(busy)return;
    if(!files.some(e=>/\.(mp4|mov|webm)$/i.test(e.file.name))){toast('请至少添加一个视频素材');return;}
    const prompt=byId('editPrompt').value.trim();if(!prompt){toast('请填写剪辑要求');return;}
    const requestEpoch=getWorkspaceEpoch();setBusy(true);
    try{
      const referenceIds=[];
      for(const entry of files){
        if(!entry.referenceId){const response=await fetch('/api/video-references',{method:'POST',credentials:'same-origin',headers:{'content-type':entry.file.type||'application/octet-stream','x-file-name':encodeURIComponent(entry.file.name)},body:entry.file});
          const data=await response.json();if(requestEpoch!==getWorkspaceEpoch())return;if(!response.ok)throw new Error(data.error||'素材上传失败');entry.referenceId=data.reference.id;}
        referenceIds.push(entry.referenceId);
      }
      await jsonApi('/api/editing',{method:'POST',timeoutMs:35000,body:JSON.stringify({mode,prompt,product:byId('editProduct').value.trim(),duration:Number(byId('editDuration').value),ratio:byId('editRatio').value,subtitles:byId('editSubtitles').checked,referenceIds})});
      toast('剪辑任务已提交');
    }catch(err){if(requestEpoch===getWorkspaceEpoch())toast(err.code==='TIMEOUT'?'响应超时，正在恢复任务，请勿重复提交':err.message);}
    finally{if(requestEpoch===getWorkspaceEpoch()){setBusy(false);refresh();}else{files=[];setBusy(false);}}
  };
}
