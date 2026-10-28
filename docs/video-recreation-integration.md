# 视频复刻接入记录（2026-10-28）

## 已确定的产品要求

- 沿用现有 MiniMax H3 模型和服务选择，不连接 HypiHub，不切换 Wan 模型。
- 必须保留参考视频的动作，不接受抽取关键帧后重新生成作为替代。
- 参考视频必填、只能 1 个、真实时长不超过 15 秒；至少添加 1 张替换图片，最多 9 张。
- 可选择替换主体或替换背景。现有账号隔离、单生成任务、进度、结果资产规则继续适用。

## 本地已实现

- 创作方式增加“视频复刻 · 待开通”，显示替换内容选择、视频/图片参考上传及数量提示。
- 视频缩略图显示参考视频及其时长，图片显示主体/背景用途。
- 前端预检查时长，服务器使用 FFprobe 验证实际视频流与真实时长；资产中的视频加入复刻参考时同样检查。
- 超时长上传不落入参考库；提交接口验证参考类型、数量、归属及替换目标。
- 接口没有配置时返回 `503 / RECREATION_WORKFLOW_NOT_CONFIGURED`，不提交付费任务、不降级为图片生成。
- 配置接口公开 `videoGeneration.recreation.ready=false` 及当前能力限制，前端阻止生成提交。
- 28 项测试通过，包括 15 秒边界、15.01 秒拒绝、资产复用超时长拒绝、必填素材及不触发图片工作流。

## 实际服务能力核对

依据 AutoDL 官方网页实际使用的公开元数据接口查询：

- 工作流列表：`POST https://www.autodl.art/api/v1/comfyui/workflows`，请求 `{page_index:1,page_size:100}`。
- 单工作流规则：`GET https://www.autodl.art/api/v1/comfyui/workflows/{workflowId}`。
- 当次返回 24 个工作流，逐个读取全部输入规则。
- 当前的 `minimax_h3_lightx2v_v5_15s` 只接受 `ref_image_0` 至 `ref_image_8`、提示词、时长、分辨率、种子，不接受视频输入。
- 此次目录里唯一声明视频输入的工作流为 `wan2.2animate-v4-motion_retargeting`，字段为 `ref_video`、`ref_image`、分辨率、种子。该模型不符合用户指定的 MiniMax H3，未采用。

官方入口：[AutoDL 工作流目录](https://www.autodl.art/large-model/comfyui)、[当前 H3 多图工作流](https://www.autodl.art/large-model/comfyui/minimax_h3_lightx2v_v5_15s)。

## 尚需接入

需要能同时接收参考视频与替换图片的 MiniMax H3 接口文档或工作流 ID，并明确视频/图片字段、时长与画幅限制、任务查询方式和原动作保留能力。不能从“模型名称相同”推断某个工作流支持这些输入，也不能向当前图片工作流添加未声明的字段。

Hypit 技能用于检查素材角色、动作保留要求和模型能力边界；它本身不提供推理模型或账户额度。已阅读技能和模型/Provider 指南，但没有安装 Hypit Runtime、连接新服务、发起付费生成或升级生产 Node。实际服务调用等待上述 API 契约确认。

发布时仅包含上述素材准备和校验能力，复刻生成仍保持 `ready=false`。没有接入新服务，没有将图片工作流当成保留原动作的视频复刻。
