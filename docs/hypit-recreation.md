# Hypit 视频复刻接入

复刻的新任务使用 `hypit-recreation` 工作流。普通生成的 ComfyUI 路由不变。未完成的旧 H3 任务仍使用原查询接口；旧批次不再继续提交新的 H3 子任务。没有配置 Hypit 时，新复刻请求返回 `503 / HYPIT_NOT_CONFIGURED`，不调用 H3，不创建计费任务。

## 已实现的执行链

1. 按当前账号验证参考素材，视频必须为 2–15 秒 MP4/MOV，最多 50 MB；图片可选，最多 9 张。
2. 在 `data/hypit/<taskId>` 建立私有 Hypit 项目，复制真实视频和图片，保存 Brief 与引用角色。
3. 调用管理员指定的 `prepareRecreation` 模型适配器，生成 Author Source、Run 和目标 Output。适配器可在此阶段完成模型所需的参考分析；没有分析服务时不能声称已经理解视频内容。
4. 执行真实 Hypit `check`、`plan`，再执行一次 `build --json`；立即保存 Build ID，后续只查询同一 Build。
5. 使用 `status --json` 获取执行状态，成功后用 `get --output` 导出视频，保存到当前用户资产。批次仍逐条执行。

Hypit 的 Model、Provider、Runtime Profile 是不同层：Model 描述媒体和参数，Provider 连接服务，Profile 选择服务及凭据。Hypit 技能或 CLI 不提供免费模型额度。此接入使用 Hypit Runtime 的 Author/Run 流程，不冒充 RunningHub 网页内部的 Agent 服务。

## 独立运行环境

执行 `APP_DIR=/opt/clipflow bash integrations/hypit/install-runtime.sh`，只安装在 `hypit-runtime` 下，固定 Hypit 0.3.1 和 Node 22.23.0，不更改网站服务使用的系统 Node。

服务端配置参考 `integrations/hypit/runtime.env.example`：

- `HYPIT_BIN`：独立 Hypit 启动器绝对路径。
- `HYPIT_VIDEO_ADAPTER`：可信管理员提供的模型适配模块绝对路径。
- `HYPIT_RUNTIME_PROFILE`：包含所选视频 Provider 的 Hypit Runtime Profile 绝对路径。
- `HYPIT_RECREATION_ENABLED=true`：检查模型、凭据和计划后显式启用。

默认不开启。地址、API Key 和模型标识由 Provider/Profile 管理，按 `hypit auth` 使用凭据存储，不下发浏览器，也不自动复用 AutoDL Token。

## 预留的视频模型接口

```js
export async function prepareRecreation({project, brief}) {
  // brief.prompt：用户描述、版本方向及后台质量约束
  // brief.referenceVideo：真实视频的项目相对路径、类型、时长
  // brief.replacementImages：图片相对路径列表，可为空
  // brief.change：subject 或 background
  // brief.output：duration、ratio、resolution
  // 1. 必要时读取/分析真实视频与图片。
  // 2. 选用已安装 Model 的准确 Surface，明确映射视频和图片。
  // 3. 写入项目内的 Author Source 和 Run。
  return {run:'production.svrun', output:'recreation.video'};
}
```

`model-adapter.example.mjs` 是经过真实 `hypit check` / `plan` 校验的示例：使用 Hypit 内的 H3 ReferenceVideo 语义，并把视频、可选图片建立为图依赖；它不直接调用 AutoDL，也没有默认服务账号。未来改用其他模型时，替换该适配器的 Model Surface 和 Profile 的对应 Provider；未支持的时长、比例或视频参考必须拒绝，不能丢弃视频或静默换模型。

接入供应商 HTTP API 时，应实现/安装 Hypit Provider，按其真实协议映射上传、submit/poll/collect、错误、价格和凭据。这里只预留该接口，未虚构通用供应商请求格式。先 `check`、`plan` 和 `doctor`，再明确账号与预算后实际生成。

## 验证边界

本地模拟 CLI 覆盖项目素材、Build 回执、只提交一次、状态与导出。真实 Hypit 0.3.1 已通过参考视频模板的 check 和 plan，计划明确包含一个视频参考。未配置视频 Provider，未发起付费生成，尚无真实生成效果验收。
