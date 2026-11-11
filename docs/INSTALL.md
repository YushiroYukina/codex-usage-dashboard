# 安装与使用

## 单设备版

Windows 默认程序目录为 `%LOCALAPPDATA%\Programs\UsageLedgerV2\0.5.0-rc.2-single`，数据目录为 `%LOCALAPPDATA%\UsageLedgerSingle\state`。安装器创建“Codex 用量看板 单设备版”快捷方式。

Mac 程序目录后缀为 `app-0.5.0-rc.2-single`，数据目录为 `~/Library/Application Support/UsageLedgerSingle/state`，应用名为“Codex 用量看板单设备版.app”。有命令行开发工具时编译原生窗口，否则使用浏览器入口。

打开应用后点击刷新用量。设置窗口提供原生 Token 和原生周期导入。Token 图表和历史明细均使用本机账号账本。实时额度和原生用量读取需要联网。

## 同步版

Windows 数据沿用 `%LOCALAPPDATA%\UsageLedgerV2\state`。Mac 安装器读取已知旧开发版的安装配置，沿用其数据目录。安装前检查所选路径，退出旧账本窗口与采集后台，保留 Codex 登录。

先在 Windows 创建连接码，再在 Mac 连接。连接码由 Windows 本机生成并包含加密密钥。地址改变时使用“连接 / 更新地址”。连接断开期间本机继续记账，恢复后交换账本。

## Mac 安装条件

安装包提供源码，在 Mac 本机生成应用。同步版使用钥匙串助手，需要 Xcode 命令行工具。原生窗口编译依赖 Cocoa、WebKit 和 UserNotifications。构建采用本机临时签名，Apple 公证状态为待完成。

如果旧应用已存在，先退出并将旧 `.app` 另存，再运行安装器。备份位于数据目录 `backups`。恢复数据库时退出相关进程，并保留恢复前的数据库及 WAL/SHM 文件。

## Codex 工具注册

桌面程序可直接使用。需要在 Codex 中调用查询工具时，Windows 安装器支持 `-RegisterPlugin`，Mac 支持 `--register-plugin`。升级既有注册时应核对来源和同名入口。已驻留的工具进程需要重新连接才能加载新代码。
