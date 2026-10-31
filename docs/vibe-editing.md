# 视频剪辑：口播与带货

## 结论与边界

AI MediaKit Vibe Editing 支持通过自然语言和素材 URL 完成视频理解、多轨编排、渲染和导出，适合作为口播粗剪与带货素材混剪的第一版后端。精简停顿、识别口误、字幕和目标时长由指令驱动，官方未提供这些功能的独立确定性参数，也没有承诺口播剪辑准确率；必须用实际素材验收。当前界面将时长标注为目标时长。

口播：保留原声、原意和完整语句，要求去除明显停顿与重复。
带货：商品信息、展示、卖点、购买引导；商品信息由用户提供。
背景音乐只使用上传的音频，不承诺自动生成音乐或配音。

## 配置

- `AMK_API_KEY`：现有 MediaKit 密钥。
- `PUBLIC_BASE_URL`：云端可访问的素材入口；沿用服务端六小时签名 URL。
- `AMK_EDITING_ENDPOINTS`：火山方舟视觉理解模型的自定义推理接入点 ID，多个用逗号分隔；官方文档注明不支持预置推理接入点。
- `AMK_API_BASE`：默认 `https://mediakit.cn-beijing.volces.com/api/v1`。

控制台首次需授予 MediaKit 访问 IMP 智能处理资源权限；内容理解还需开通方舟视觉模型并授予 AMK 火山方舟资源访问权限。配置检查只能确认本地字段，不能证明云端授权已完成。

## 接口与任务

前端 `POST /api/editing` 提交模式、指令、商品信息、目标时长、画幅、字幕开关和账号内素材 ID。服务端生成 `content` 多模态数组、`output` 和 `extensions.multimodal_understanding.prefer_endpoints`，提交 `POST /tools/vibe-editing`，并以本地任务 ID 作为 `client_token`。不接受浏览器提供任意云端素材 URL、模型或回调参数。

`GET /api/editing` 返回当前账号的配置状态和任务列表。后台每 15 秒查询 `GET /tasks/{task_id}`；网页关闭后仍继续。成功结果取 `result.artifacts` 中的视频，复用资产下载池及时保存本地副本，因为服务商 URL 仅有效 24 小时。保存失败沿用资产池冷却与重试机制。

每个账号只允许一个未结束任务。提交异常或提交时重启标记为 unknown，不自动重提，避免不确定结果造成重复计费；管理员需根据任务 client_token 核查。已有远端编号的运行任务可在重启后继续轮询。

当前网站积分扣费尚未接入本功能；云端仍按实际服务规则计费。当前素材接入沿用现有参考上传接口，单文件大小沿用服务器限制，总数最多 12 个，至少包含一个视频。字幕文件输入、资产直接选取、时间线人工编辑留作后续功能。

## 官方依据

- https://docs.volcengine.com/docs/intelligent-processing/vibe-editing?lang=zh
- https://docs.volcengine.com/docs/intelligent-processing/query-task?lang=zh
- https://docs.volcengine.com/docs/intelligent-processing/vibe-editing-guide?lang=zh

## 验收建议

用同一份口播素材检查语义、音画同步、去停顿与字幕；用商品展示、使用场景及配乐检查带货版的真实卖点、字幕位置、混音、画幅及目标时长。完成本地协议与任务验证后，仍需配置云端凭证和授权进行真实素材验收。
