# 0.5.0-rc.2 验证记录

记录日期为 2026-11-11。

## 已通过

- Windows 本机源码测试 89 项通过。
- Windows 单设备版与同步版在隔离目录安装成功，四个安装包的内部文件摘要与 ZIP 完整性通过检查。
- 单设备版界面、手动刷新、重复记账防护和同步入口禁用测试通过。
- GitHub Windows 与 macOS 托管环境的自动测试通过。
- GitHub macOS 环境完成两种版本的原生窗口编译、安装和签名验证，生成的启动程序确认为 Mach-O 格式。
- A「代码统计」图标已提供 PNG、Windows ICO 与 macOS ICNS，并接入网页、插件元数据、快捷方式、托盘和 Mac 应用资源。

可复查对应的 GitHub Actions 记录。[云端验收](https://github.com/YushiroYukina/codex-usage-dashboard/actions/runs/42975853065)

## 实机验收范围

云端 Mac 安装检查使用隔离目录和 CLI 占位程序，实际 Codex 登录、额度查询、钥匙串授权、通知展示及 Windows 与 Mac 两台实机跨网络同步，仍需在目标设备验收。

Mac 包在目标机器编译，签名使用本机临时签名，Apple 公证待完成。同步版依赖临时跨网地址，地址改变后需要更新配对连接。当前版本使用 rc 候选标记。
