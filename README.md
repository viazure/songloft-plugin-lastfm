# Songloft Last.fm

Songloft 插件：把播放同步到 [Last.fm](https://www.last.fm/)（scrobble / now playing）。

- `play` → `track.updateNowPlaying`
- `finish` / 合格的 `skip` → `track.scrobble`
- 默认规则（可配置）：曲长 > 30s；播放满一半时长或满 4 分钟（以先到为准）
- 可选只同步 `source=miot`（智能音箱投播）
- 可选「提前 scrobble」：普通播放有用；音箱侧通常仍播完才记

社区插件，**未经 Songloft 官方审核**。安装前请自行确认。

## 安装

### 从 Songloft「GitHub 发现」

1. 打开 Songloft → **插件** → 选源 / GitHub 发现
2. 搜索 **Last.fm**（仓库需带 topic `songloft-plugin`）
3. 安装并启用

### 手动上传

1. 从 [Releases](https://github.com/viazure/songloft-plugin-lastfm/releases) 下载 `lastfm.jsplugin.zip`
2. Songloft → **插件** → 上传该 ZIP → **启用**「Last.fm」

## 配置（用户自备 Last.fm API）

密钥只存在 Songloft 本机插件 `storage`，**不会**写入本仓库或日志明文回显。

1. 打开 https://www.last.fm/api/account/create 创建应用，拿到 **API Key** 与 **Shared Secret**
2. 插件设置页「应用凭证（高级）」填入 Key / Secret（已保存的留空表示不改）→ **保存应用凭证**
3. 点 **连接账号**（网页授权）：本机浏览器打开 Last.fm 授权页并允许 → 回到设置页完成连接
4. 备选：用户名 + 密码授权，或粘贴已有 Session Key
5. 可选：勾选「只同步 source=miot」；按需调整最短曲长 / 比例 / 上限 / 提前 scrobble

设置页「手动探测」可测 Now Playing / Scrobble（未连接时会失败）。

## 开发

```bash
npm install
npm test
npm run build
# 产物：dist/lastfm.jsplugin.zip
```

需要 Songloft ≥ `2.8.0`，以及 `@songloft/plugin-builder` / `@songloft/plugin-sdk`。

## 发现与更新

- 公开仓：https://github.com/viazure/songloft-plugin-lastfm
- GitHub topic：`songloft-plugin`
- `updateUrl`：根目录 `plugin.json`（raw）
- `download_url`：对应 Release 资产 `lastfm.jsplugin.zip`

## 图标说明

插件图标取自 Last.fm 站点常见 favicon / apple-touch 风格素材。Last.fm 为第三方商标；本插件与 Last.fm / Audioscrobbler 无官方隶属关系。

## License

[Apache-2.0](./LICENSE)
