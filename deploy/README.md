# Docker 部署

本目录提供单实例部署示例。应用没有内置用户账户与权限隔离，公网入口需由反向代理提供 HTTPS 与全站认证，覆盖页面、静态资源、API 和 SSE。

文中的 `novel.example.com` 为示例域名，请替换为自己的站点。实际域名、服务器路径、代理管理配置及凭据应保存在本地运维记录中。

## 服务与数据

- Compose 配置：`deploy/compose.yaml`。
- 持久数据：`deploy/data/`，包含作品、模型设置、加密凭据和附件；该目录不纳入版本控制。
- 代理上游：`lingma:3000`。代理与应用通过 `PROXY_NETWORK` 指定的外部 Docker 网络连接，应用不映射宿主机端口。
- 独立出站网桥设为默认网关（`gw_priority: 1`），用于访问模型服务。
- 容器以非 root 用户运行，自动重启并通过 `/ready` 检查健康状态。

首次部署创建空实例，不会自动上传开发机的数据、模型密钥或作品。

## 构建与更新

在 `deploy/` 下创建 `.env`，填入自己的站点来源和反向代理网络名称：

```dotenv
PUBLIC_ORIGIN=https://novel.example.com
PROXY_NETWORK=lingma_proxy
```

确保反向代理已连接该外部网络；网络不存在时，先创建：

```sh
docker network create lingma_proxy
```

从仓库根目录执行以下命令。`data` 目录须允许容器用户 uid 1000 写入；根据宿主机的权限管理方式设置目录所有者。

```sh
cd deploy
mkdir -p data
docker compose build
docker compose up -d --wait
docker compose ps
docker compose logs --tail=100 lingma
```

构建由 Docker 内的 pnpm 11.5.2 完成。Node 22 基础镜像与运行镜像保持一致，构建阶段使用 Python、make、g++ 编译 SQLite 原生依赖。

同步源码时排除 `.git`、`.env`、`.data`、`node_modules`、`dist`、`deploy/data` 和 `deploy/secrets`；不要删除或覆盖服务器的数据目录。

更新前停止应用，再将整个 `data` 目录复制到权限受限的备份目录，可获得包含数据库、密钥和附件的一致性备份。复制运行中的 SQLite 主文件不构成完整备份。数据库迁移不支持降级，回退旧镜像可能需要恢复升级前的完整数据。

## 反向代理

为自己的域名配置 HTTPS、HTTP 跳转 HTTPS 和全站认证。保留原始 Host，并将请求转发到 `lingma:3000`。代理验证登录凭据后，移除传入应用的 Authorization 请求头。

使用 Caddy 时，可在 `reverse_proxy` 中配置：

```caddyfile
reverse_proxy lingma:3000 {
    flush_interval -1
    header_up -Authorization
}
```

此片段仅展示上游转发，须配合站点 HTTPS 与认证配置使用。`flush_interval` 保证 AI 流式输出及时送达。代理管理工具、登录账户、密码与哈希由部署者在仓库外维护。

上线验证应覆盖：未认证和错误密码返回 401；正确密码能访问页面、资源和 `/api/v1/ready`；从外站链接进入页面成功；同域写入成功，其他 Origin、跨站 API、嵌入和写入请求返回 403；应用容器没有公网端口。模型连接检查还需从运行中的应用容器访问实际供应商域名，并验证一次真实流式回复。
