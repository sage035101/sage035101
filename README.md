# Sage 法硕答疑（免登录自测版）

本地网页版法硕答疑。支持深度思考、连续追问、图片题目、历史对话管理，以及后续上传资料。

## 打开

- 电脑：**http://127.0.0.1:8787**
- 手机（同一个 Wi-Fi）：**http://192.168.0.5:8787**
- 手机（流量 / 外网，临时）：**https://clinton-pending-brands-atmospheric.trycloudflare.com**

手机可直接扫 `手机访问二维码.png`：左码为局域网，右码为临时公网。

电脑重启后，双击桌面 **「Sage法硕答疑」** 或 `E:\fashuo-ai\启动Sage答疑.cmd`。停止服务双击 `停止Sage答疑.cmd`。

## 手机访问说明

- 手机和电脑必须在同一个 Wi-Fi 下，才能用 `192.168.0.5` 这个地址。
- 服务使用 DSH 自带 Node 启动，因为 Windows 防火墙已放行该程序；如果换电脑或 DSH 路径变化，手机访问可能需要放行 8787 端口。
- 公网二维码是 Cloudflare 临时隧道，电脑关机、断网或隧道进程退出后失效；链接带随机字符，请勿转发。
- 若局域网打不开，先确认手机没有开代理/VPN，再检查路由器是否开启了“AP 隔离”。

## 界面与对话

- 顶部居中：**Sage提前祝您研途顺利**
- 主界面不显示教材名称、教材页数等冗余信息。
- 每次回答默认“简洁”，可在“设置”切换“详细”；始终启用 DeepSeek 深度思考（`effort: max`）。
- 支持文字、复制粘贴、拖入/上传图片（一次最多 3 张）。
- 输入框左侧有麦克风，可语音输入（浏览器 Web Speech API；需要 HTTPS 或 localhost，手机建议用公网 HTTPS 链接）。
- 追问会承接上下文；检索时也会把上一轮问题一起带入，避免“每问都像新题”。
- 回答下方不再显示参考来源/页码列表，只给答案；如果用户追问“依据哪里”，模型会用一段原文回答。

## 历史对话

左侧栏就是 DeepSeek 式的历史记录：

- **自动归纳**：按“今天 / 昨天 / 7 天内 / 30 天内 / 更早”分组，首条提问自动生成标题。
- **查找**：顶部搜索框同时搜索标题和对话内容。
- **重命名**：每条右侧 `⋯` → 重命名。
- **归档**：`⋯` → 归档；在“已归档”标签查看，可取消归档。
- **删除**：`⋯` → 删除。
- **合并**：点“整理”，勾选两段及以上对话 → 合并；消息按时间合并到最近的一段。
- **新话题**：右上角“新对话”、左侧“新对话”，或每条回答下的“新话题”，都会新建一段独立对话，不覆盖旧记录。
- 对话保存在浏览器 localStorage，不上传服务器；清理浏览器数据会丢失历史。

## 资料库

右上角“资料库” → 选择科目 → 上传 **文字版 PDF / TXT / Markdown**。

- 上传后立即进入本地检索库。
- 扫描版 PDF 浏览器无法提取文字：直接发页面图片提问，或先 OCR 成文字版。
- 单文件限 3000 页；资料保存在 `E:\fashuo-ai\data\uploads.jsonl`。
- 删除上传资料后即从检索库移除，不影响内置知识库。

## DeepSeek 凭据

默认复用本机已登录的 DeepSeek 账号（读取 DSH 账号 token），无需填写。

若凭据失效（401），在“设置”里填自己的 DeepSeek API Key；Key 只保存在浏览器 localStorage，不写入服务器日志。也可用环境变量 `DEEPSEEK_API_KEY` 启动。

## 目录与占用

- 程序：`E:\fashuo-ai`（不占 C 盘）
- 知识库：`E:\fashuo-ai\data\kb.jsonl`（约 9 MB）
- 上传资料：`E:\fashuo-ai\data\uploads.jsonl`
- OCR 原始分页：`E:\fashuo-ai\data\ocr\`（可删，不影响已生成的知识库）
- 运行内存：Node 约 150–300 MB；模型在云端，本地不做推理。
- 公网隧道程序：`E:\fashuo-ai\tools\cloudflared.exe`

## 重新生成知识库

替换/新增 PDF 后，在 `E:\fashuo-ai` 下运行：

```powershell
# 1) 扫描版 PDF 先 OCR（Windows 自带中文 OCR）
C:\Users\39713\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe -u tools\ocr_books.py
# 2) 文字版 PDF 提取
C:\Users\39713\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe tools\extract_text.py
# 3) 合并分页、切块
C:\Users\39713\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe tools\build_kb.py
```

然后重启服务。

## 部署到云端（电脑关机后仍可用）

本项目自带 `Dockerfile`、`render.yaml`、`package.json`，可原样部署到任意支持 Node 20+ 的云主机或容器平台。

### 方式 A：自己的云服务器（最稳）

在服务器上安装 Node 20+，把 `server.mjs`、`public/`、`data/kb.jsonl`、`data/uploads.jsonl`、`package.json` 上传到 `/opt/sage-law`，然后：

```bash
cd /opt/sage-law
export HOST=0.0.0.0
export PORT=8787
export DEEPSEEK_ACCOUNT_TOKEN='你的账号 token'
node server.mjs
```

建议用 systemd 或 Docker 常驻，再配 Nginx/Caddy 反向代理和域名 HTTPS。公网链接即为你的域名。

### 方式 B：Render 免费 Web Service

1. 把本目录（不含 `runtime`、`tools`、`data/ocr`、`data/text`）推到 GitHub/GitLab 仓库。
2. Render → New → Blueprint，选择仓库，会读取 `render.yaml`。
3. 在环境变量里填 `DEEPSEEK_ACCOUNT_TOKEN`（或 `DEEPSEEK_API_KEY`）。
4. 部署完成后得到 `https://<服务名>.onrender.com`。

注意：Render 免费实例空闲会休眠，首次访问可能需要几十秒唤醒；上传资料在免费实例重启后会丢失（内置知识库不受影响）。

### 方式 C：Railway / Fly.io / 腾讯云 / 阿里云

任何支持 Docker 或 Node 20+ 的平台都可以直接使用本目录。启动命令 `node server.mjs`，端口 `8787`，环境变量同上。

### 账号 token 从哪来

本机文件 `C:\Users\39713\.dsh\.credentials.yaml` 中 `deepseek-account-platform/default` 下的 `token`。该 token 可能随登录状态过期；长期使用建议在“设置”里配置自己的 DeepSeek API Key，或把 `DEEPSEEK_API_KEY` 设为云平台环境变量。

## 说明

答案用于法硕备考，供参考，不替代正式法律意见。涉及新增司法解释、指导性案例时，以官方最新文本为准。
