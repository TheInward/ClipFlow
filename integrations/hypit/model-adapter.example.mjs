/** Example only. Copy to a private configured path and select a compatible Model/Provider. */
import fs from 'node:fs/promises';
import path from 'node:path';
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export async function prepareRecreation({project,brief}) {
  // This sample authors Hypit's H3 reference-video capability. It does NOT call AutoDL.
  // Another model must use its own installed Surface and map every required reference.
  const prompt=`${brief.prompt}\n保留原视频动作、节奏和镜头运动。只改变用户指定的${brief.change==='background'?'背景':'主体'}。`;
  const refs=[brief.referenceVideo,...brief.replacementImages];
  const source=`<?svml using="@hypit/markup@1"?>
<svml>
  <import as="copy" from="@hypit/text@1"/>
  <import as="media" from="@hypit/media@1"/>
  <import as="model" from="@hypit/minimax-h3@1"/>
  <copy:Value id="direction">${xml(prompt)}</copy:Value>
  ${refs.map((ref,i)=>`<media:${ref.kind==='video'?'Video':'Image'} id="ref${i}" src="./${xml(ref.path)}"/>`).join('\n  ')}
  <model:ReferenceVideo id="recreation" prompt={direction} duration="${Number(brief.output.duration)}" resolution="768P" aspect-ratio="9:16">
    ${refs.map((ref,i)=>`<model:Reference ${ref.kind==='video'?'video':'image'}={ref${i}}/>`).join('\n    ')}
  </model:ReferenceVideo>
</svml>`;
  await fs.writeFile(path.join(project,'production.svml'),source);
  await fs.writeFile(path.join(project,'production.svrun'),'<?svml using="@hypit/markup/run@1"?>\n<svrun version="1"><author source="./production.svml"/><target output="recreation.video"/></svrun>\n');
  await fs.writeFile(path.join(project,'Treatment.md'),'# 复刻处理\n\n通过 Hypit 的 ReferenceVideo 图传递真实视频与图片，保留原动作及镜头。\n模型选择及能力限制由适配器与 Runtime Profile 明确声明，不能静默丢弃视频。\n');
  return {run:'production.svrun',output:'recreation.video'};
}
