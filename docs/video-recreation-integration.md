# MiniMax H3 视频复刻（2026-10-29）

视频复刻使用 AutoDL **模型广场**的 MiniMax-H3 V2，不使用仅接受图片的 ComfyUI 工作流，也不抽帧代替视频参考。文生视频、多图、首尾帧继续走现有 ComfyUI；所有方式只提供 5/10/15 秒和 9:16。

## 协议和配置

- 默认地址 `https://www.autodl.art/api/v1/minimax`，可用 `AUTODL_H3_API_BASE` 覆盖。
- 服务端令牌 `AUTODL_H3_API_TOKEN`，缺省沿用现有 `AUTODL_API_TOKEN`，不发给前端。
- 创建：`POST /v2/video_generation`；模型 `MiniMax-H3`，768P，ratio `9:16`。
- `content` 同时携带 text、`video_url: {url}` / `role:reference_video`、`image_url:{url}` / `role:reference_image`。URL 为现有的限时签名公网链接。
- 查询：`GET /v2/query/video_generation/{task_id}`；读取 `task.status`、`task.content.url` 和失败原因。输出视频时长不作为处理耗时。
- 参考视频 1 个、MP4/MOV、2–15 秒、最多 50 MB；替换图片 1–9 张、JPG/PNG/WebP、每张最多 30 MB。实际时长由 FFprobe 检查。
- 替换主体时要求保留背景；替换背景时要求保留主体。两者都要求保留动作、节奏和镜头。模型是生成式参考，实际动作还原程度需验收输出，不能承诺逐帧相同。
- 批量复刻沿用逐条排队；不同版本只在允许替换的区域变化灯光、材质细节，不添加新的运镜。V2 未声明 seed，不向该接口发送种子。
- 任务、资产按账号隔离；进行中禁止删除和再次提交。结果和素材留在资产，删除任务仅清理创作页展示。

## 验证范围

AutoDL 模型详情公开元数据确认模型 ID 80 与上述创建地址。服务器使用现有令牌查询不存在的测试任务，返回 task not found，而非鉴权失败。自动化测试使用本地模拟服务验证字段、原视频传递、排队、状态、失败、资产以及账号隔离；没有发起付费生成，真实生成效果仍需实际任务验收。

协议依据：[MiniMax H3 创建](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)、[任务查询](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)。
