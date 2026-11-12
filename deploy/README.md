# tw-vps 部署

入口为 https://novel.lyuy.top，使用现有 Ingressi 管理的 Caddy 提供 HTTPS 和全站 Basic Auth。页面、静态资源、API 和 SSE 均需要认证，HTTP 自动跳转 HTTPS；浏览器会弹出用户名与密码输入框。

这是单实例、共享数据的部署，应用本身没有用户账户和权限隔离。代理必须先认证，再转发请求。Caddy 只保存密码哈希，登录密码不进入仓库；可在 Ingressi 的 `Lingma password` 访问列表管理密码。

## 服务与数据

- 服务器代码：`/home/yang/services/lingma`
- Compose 项目：`/home/yang/services/lingma/deploy/compose.yaml`
- 持久数据：`/home/yang/services/lingma/deploy/data`，包含作品、模型设置、加密凭据和附件。
- Caddy 上游：`lingma:3000`，在现有 `proxy-stack_control` 网络内连接。应用不映射宿主机端口。
- 出站网络：`lingma_outbound`，设为默认网关（`gw_priority: 1`）。应用请求同机 Caddy 域名时，从独立网桥出站，避免在代理所在网桥内访问宿主机公网映射端口超时。
- 应用配置：`PUBLIC_ORIGIN=https://novel.lyuy.top`。容器以非 root 用户运行，自动重启并检查 `/ready`。

首次部署创建空实例，不会自动上传开发机的 `.data`、模型密钥或作品。

## 构建与更新

在服务器的部署目录创建 `.env`：

```dotenv
PUBLIC_ORIGIN=https://novel.lyuy.top
```

确保 `data` 已建立且 uid 1000 可写，然后运行：

```sh
cd /home/yang/services/lingma/deploy
docker compose build
docker compose up -d --wait
docker compose ps
docker compose logs --tail=100 lingma
```

上传源码时排除 `.git`、`.env`、`.data`、`node_modules`、`dist`、`deploy/data` 和 `deploy/secrets`；不要删除或覆盖服务器的数据目录。构建由 Docker 内的 pnpm 11.5.2 完成。Node 22 基础镜像与运行镜像保持一致，构建阶段使用 Python、make、g++ 编译 SQLite 原生依赖。

更新前停止应用，再将整个 `data` 目录复制到权限受限的备份目录，可获得包含数据库、密钥和附件的一致性备份。复制运行中的 SQLite 主文件不构成完整备份。数据库迁移不支持降级，回退旧镜像可能需要恢复升级前的完整数据。

## Caddy 配置

现有代理由 Ingressi 的数据库生成配置，启动用 Caddyfile 只是引导文件。站点与访问列表必须保存在 Ingressi，直接修改 Caddy 运行配置会被后续操作覆盖。

站点 `Lingma` 的配置：

- 域名 `novel.lyuy.top`；开启强制 HTTPS 与 HSTS。
- 上游 `lingma:3000`；保留原始 Host。
- 关联含登录用户的 `Lingma password` 访问列表。
- 自定义 reverse proxy JSON：

```json
{
  "flush_interval": -1,
  "headers": { "request": { "delete": ["Authorization"] } }
}
```

`flush_interval` 保证 AI 流式输出及时送达；代理验证密码后移除 Authorization，避免登录凭据传入应用。配置与哈希可在 Ingressi 管理界面查看。

上线验证应覆盖：未认证和错误密码返回 401；正确密码能访问页面、资源和 `/api/v1/ready`；从外站链接进入页面成功；同域写入成功，其他 Origin、跨站 API、嵌入和写入请求返回 403；应用容器没有公网端口。模型连接检查还需从运行中的应用容器访问实际供应商域名，并验证一次真实流式回复；宿主机连通不代表应用容器连通。
