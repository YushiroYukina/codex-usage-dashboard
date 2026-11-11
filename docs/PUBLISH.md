# GitHub 发布准备

本目录作为仓库根目录。建议仓库名为 codex-usage-dashboard，所有者由维护者选择。

## 首次上传

1. 确定 GitHub 账号或组织，创建 codex-usage-dashboard 仓库。
2. 在本地仓库运行 `python tools/check-public.py` 并检查 `git status`。
3. 设置自己的 Git 提交身份，提交源码。
4. 将仓库地址配置为 origin，推送 main 分支。
5. 等待 Test 工作流在 Windows 和 macOS 完成。
6. 在 Actions 手动运行 Prepare release draft，复核四个包和 SHA256SUMS 后发布候选版本。

命令中的 OWNER 需要替换为实际所有者。

```sh
git add .
git commit -m "Prepare Codex Usage Dashboard 0.5.0-rc.2"
git remote add origin https://github.com/YushiroYukina/codex-usage-dashboard.git
git push -u origin main
```

## 发布验收

- Windows 两种包均通过全新目录安装与正常入口检查。
- 单设备版没有连接控件，服务端同步动作全部返回明确的禁用结果。
- 同步版重试去重、离线补传、账号隔离与事务回滚测试通过。
- Mac 完成安装、原生窗口、钥匙串和通知验证后补充测试环境与结果。
- 在两台实机跨网络确认合并账本总量、每日、模型与摘要一致。
- 验证同步版临时地址重启后的更新流程。
- 确认许可证与 cloudflared 固定摘要一致。
- 启用仓库私密漏洞报告功能，并确定后续安全报告联系人。

本次准备阶段生成公开候选源码与四个安装包。上传所需的仓库归属、远程地址和实际 GitHub Actions 运行结果在发布时填写。
