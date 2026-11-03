# 钉钉经营与决策助手

声明式插件包，为钉钉机器人补充两类团队级工作流：

- `weekly-business-review`：汇总本周经营数据、团队产出与会议结论，生成经营周会材料和下周行动项。
- `decision-memo`：把模糊决策写成可选方案、评估标准、权衡与建议，输出可评审的决策备忘录。

## 安装

控制台「声明式插件」上传本目录打包后的 zip，或填写服务器上的本目录路径；也可以调用：

```bash
curl -X POST http://127.0.0.1:8787/api/v1/admin/plugins/install \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dir":"plugins/dingtalk-productivity"}'
```

安装后技能以 `plugin:com.anthys.dingtalk-productivity:<技能名>` 暴露，可通过 `skill_search` 或 `use_skill` 使用。

## 边界

- 纯声明包：不包含 MCP 节点、不执行安装脚本、不引入任意代码。
- 所有写操作仍走机器人的确认流程；技能正文要求用户回复 `/confirm`。
- 数据只来自当前用户有权限的钉钉工具与工作区文件，涉及个人信息时只输出聚合结果。
