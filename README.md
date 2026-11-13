# Songloft Last.fm

听歌时自动把播放记录同步到 [Last.fm](https://www.last.fm/)。

## 功能

- 自动记录正在播放，以及已经听完或中途切走、且达到记录门槛的歌曲
- 记录门槛可以自己改。默认是歌曲长于 30 秒，并且播放过半或已满 4 分钟
- 可以按内容（本地音乐、网络音乐）和播放方式（小爱音箱、Songloft 客户端）选择要记录的范围，两边都勾上才会同步。默认全部勾选。网络音乐指由插件引入的三方音乐源等网上来源
- 可以把 Last.fm 的红心同步到 Songloft 的「收藏」，也可以同步到自定义歌单。支持手动同步，也可以打开定时，定时默认关闭
- 可以把 Songloft 内置「收藏」的增减写回 Last.fm（默认关闭；打开后先记起点，不立刻追平历史差量）
- 可以把 Last.fm 的最近听歌写入官方「播放统计」插件
- 使用自己的 Last.fm API Key，在设置页授权后连接账号

同步红心时，只会写入本地曲库里已经有的歌，没有的不会下载。覆盖同步在 Loved 为空、截断或目的地列表不完整时，不会挖空目的地（只补缺失、跳过删除）。打开「收藏写回」且目的地为「收藏」时，立即/定时同步改为按起点三路合并，不再覆盖「收藏」。

## 保活说明

Songloft 在空闲大约 10 分钟后会卸载插件，播放时也不会自动唤醒，因此可能漏记。本插件启动时会尽量把自己加入宿主的保活白名单。如果没有加上，请在 Songloft 设置里把 `lastfm` 加入 `plugin-keep-alive`。

## 安装

### 从 Songloft「GitHub 发现」

1. 打开 Songloft → **插件** → 选源 / GitHub 发现
2. 搜索 **Last.fm**
3. 安装并启用

### 手动上传

1. 从 [Releases](https://github.com/viazure/songloft-plugin-lastfm/releases) 下载 `lastfm.jsplugin.zip`
2. 打开 Songloft → **插件** → 上传该 ZIP → **启用**「Last.fm」

## 配置

密钥只存在本机的插件存储里，不会写入仓库，也不会在日志里明文出现。

1. 打开 https://www.last.fm/api/account/create 创建应用，拿到 API Key 和 Shared Secret
2. 在插件设置页的「应用凭证（高级）」中填入并保存
3. 点击「连接账号」，在浏览器中允许授权
4. 也可以使用用户名和密码授权，或粘贴已有的 Session Key
5. 按需勾选要记录的内容和播放方式，并调整记录门槛
6. 按需将 Last.fm 红心同步到「收藏」或自定义歌单，按需打开「收藏写回」，或同步到「播放统计」

设置页可以查看最近的成功或失败记录。需要做手动测试时，可打开「诊断」。

## 开发

```bash
npm install
npm test
npm run build
# 产物：dist/lastfm.jsplugin.zip
```

需要 Songloft 2.8.0 或更高版本，以及 `@songloft/plugin-builder` 和 `@songloft/plugin-sdk`。

## 发现与更新

- 公开仓：https://github.com/viazure/songloft-plugin-lastfm
- `updateUrl`：根目录 `plugin.json`
- `download_url`：对应 Release 中的 `lastfm.jsplugin.zip`

## 图标说明

插件图标取自 Last.fm 站点常见的 favicon 风格素材。Last.fm 是第三方商标，本插件与 Last.fm 没有官方隶属关系。

## License

[Apache-2.0](./LICENSE)
