# 通知推送渠道调研（2026-06-12）

> 场景：自托管 Node/Next 后端（用户本机 Mac），向大陆用户推送"今天更新了哪些剧的哪些集"日报。
> 量级 1–10 条/天，免费额度基本不构成约束。决定性指标 = **终端用户配置步骤 × 大陆可达性**。
> 产品决策：多渠道并存、用户自选；选型待用户拍板后实现。

## 推荐实现顺序

| # | 渠道 | 一句话理由 |
|---|------|-----------|
| 1 | **Bark**（iOS） | 3 步（装 App→复制 key→粘贴），无需注册，APNs 大陆稳定，免费，服务端一行 `fetch` |
| 2 | **Server酱 Turbo** | 直达个人微信、**零 App 安装**（微信扫码登录→复制 SendKey）；免费 5 条/天对日报刚好够 |
| 3 | **企业微信群机器人** | 免费、20 条/分、真 markdown、国内直达；一次性 5 步配置，适合要富文本的用户 |
| 4 | **邮件 SMTP + 通用 webhook** | 邮件是万能兜底（QQ 邮箱提醒本身会进微信）；webhook ~20 行代码就把 ntfy/Gotify/TG-走代理 留给高级用户自己接 |

第二梯队：Telegram（须显式代理配置，api.telegram.org 大陆被墙）、钉钉/飞书（HMAC 加签）、Server酱³（App 端原生推送，方糖现旗舰线）。

## 关键淘汰/注意

- **PushDeer 淘汰**：仓库 2025-12-06 已归档，作者本人导流到 Server酱。
- **ntfy.sh 不适合中国优先场景**：大陆可达性不稳定，且 iOS 即时送达即使自托管也必须 upstream 回连 ntfy.sh（GFW 依赖甩不掉）。
- **Gotify 跳过**：仅安卓官方端 + websocket 常驻易被国产 ROM 杀，配置摩擦最高。
- **WxPusher** 值得备选：公众号推个人微信，"极简推送"扫码拿 SPT 约 2 步，免费；Server酱 限额吃紧时的替补。
- 企业微信注意：消息落在企微 App；若靠微信插件镜像到微信，markdown 不渲染——该路径下用 `text` msgtype。

## 统一抽象（已确认）

10 个候选里 8 个都是"HTTPS GET/POST 带 token 的 URL + title/body"：

```ts
interface NotifyChannel {
  id: string; // 'bark' | 'serverchan' | 'wecom' | 'email' | 'webhook' | ...
  send(msg: { title: string; text: string; markdown?: string; url?: string }): Promise<void>;
}
```

- digest 同时携带纯文本 `text` 和可选 `markdown`，各 adapter 取自己支持的最富格式（Bark 纯文本；Server酱/企微/钉钉渲染 markdown；邮件取 HTML）。
- 仅有的两个偏离：邮件（nodemailer/SMTP）、Telegram（需 ProxyAgent）。钉钉/飞书加签只是 POST-JSON 上加 ~10 行 HMAC。
- 现成轮子 [`push-all-in-one`](https://github.com/CaoMeiYouRen/push-all-in-one)（v4.5.2，2026-04 仍活跃）已实现 Server酱/钉钉/企微/飞书/TG/ntfy/邮件，接口正是这个形状——可直接用或抄其 adapter；Bark 裸 `fetch` 5 行。

## 各渠道 API 速查

- Bark：`POST https://api.day.app/{key}` JSON `{title, body, group, url, level}`；可自托管。
- Server酱 Turbo：`POST https://sctapi.ftqq.com/{SENDKEY}.send`（`title`+`desp` markdown 子集）；同内容 5 分钟内防重。
- Server酱³：`POST https://{uid}.push.ft07.com/send/{sendkey}.send`，App 内渲染 markdown，走厂商原生推送通道。
- 企业微信机器人：`POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=KEY`，`{msgtype:"markdown", markdown:{content}}`，20 条/分。
- 钉钉：webhook + `timestamp\n+secret` HmacSHA256 加签，markdown msgtype，20 条/分。飞书：100 条/分，无 markdown msgtype（text/post/卡片）。
- Telegram：`POST https://api.telegram.org/bot{token}/sendMessage`（MarkdownV2/HTML），服务端与手机端都需代理。
- 通用 webhook：`POST {title, body, items[]}` 到用户 URL。

## 来源

Bark: github.com/finb/bark · bark-server API_V2 · bark.day.app
Server酱: sct.ftqq.com · sc3.ft07.com · doc.sc3.ft07.com
PushDeer(archived): github.com/easychen/pushdeer
企微机器人: developer.work.weixin.qq.com/document/path/91770
钉钉: open.dingtalk.com/document/group/custom-robot-access · 飞书: open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
ntfy: ntfy.sh/docs/config (upstream-base-url) · ntfy.sh/docs/known-issues
Telegram proxy: telegrambots.github.io/book/4/proxy.html
Gotify: gotify.net · github.com/androidseb25/iGotify-Notification-Assistent
push-all-in-one: github.com/CaoMeiYouRen/push-all-in-one
