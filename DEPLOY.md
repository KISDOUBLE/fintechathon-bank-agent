# 部署说明

本项目零第三方依赖，只需要 Node.js ≥ 24。

## 1 本地启动

```bash
# 1. 准备配置（可选，不配也能跑：规则模式）
cp .env.example .env

# 2. 初始化账本（首次会建库并写入种子数据）
node scripts/reset.mjs

# 3. 启动 Web 服务
node src/server.mjs
# → http://127.0.0.1:8787

# 4. 另开一个终端，启动渠道（可选）
node src/channels/webhook.mjs
# → POST http://127.0.0.1:8788/webhook
```

演示账号：`13800000001` / `123456`；也可在页面注册新用户。

## 2 配置项

| 变量 | 必填 | 默认 | 说明 |
| :--- | :--- | :--- | :--- |
| `DEEPSEEK_API_KEY` | 否 | 空 | 不填则走纯规则模式，功能不降级 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-flash` | DeepSeek-V4.1-Flash-1017 |
| `DB_PATH` | 否 | `data/bank.db` | 账本路径 |
| `SESSION_SECRET` | 否 | 每次启动随机 | 不填则重启后令牌全部失效 |
| `WEBHOOK_SECRET` | 否 | 空 | 配置后 webhook 必须带 `x-webhook-secret` |
| `PORT` / `WEBHOOK_PORT` | 否 | 8787 / 8788 | 监听端口 |

## 3 验证部署

```bash
node scripts/ci.mjs        # 密钥扫描 + 单测 + 冒烟 + 50 条评测
node scripts/key-check.mjs # 检查模型密钥是否可用（不打印密钥）
```

`ci.mjs` 返回码 0 才算部署成功。

## 4 常见问题

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| 页面一直转圈 | 未登录或令牌过期 | 刷新页面重新登录 |
| `SQLITE_BUSY` / 文件被占用 | 多个进程写同一账本 | 停掉多余进程，或换 `DB_PATH` |
| 重置账本报 EPERM | 服务仍在运行占用文件 | 先停服务，再 `node scripts/reset.mjs` |
| 模型不生效 | 未设置密钥或 `.env` 未保存 | `node scripts/key-check.mjs` 确认 |
| 端口被占用 | 已有实例在跑 | 换 `PORT` 环境变量 |

## 5 Docker（未验证）

本项目未附 Dockerfile：开发机未安装 Docker，无法实测，按"不做假验证"原则不提供未跑通的部署文件。

若需要容器化，Node 官方镜像即可：

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY . .
ENV DB_PATH=/data/bank.db
EXPOSE 8787 8788
CMD ["node", "src/server.mjs"]
```

该片段**未经本机验证**，使用时请自行跑一遍 `node scripts/ci.mjs`。
