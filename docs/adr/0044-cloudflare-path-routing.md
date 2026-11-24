# ADR 0044：Cloudflare 承载面按路径寻址应用

状态：接受。2026-11-24。用户决定“改成 path 吧，M1 不存在多租户”。修订 [ADR 0042](0042-cloudflare-edition.md) 的“每个应用使用独立的 Custom Domain、独立应用会话和一次性交换”，以及 [ADR 0041](0041-cloudflare-m1-plane.md) 后果中“每个应用一个精确域名，首次发布要等证书”一句。

## 背景

ADR 0042 为邀请制多租户站点设计：每个应用一个精确的 Custom Domain，浏览器把它当作独立的源，再用一次性交换给每个应用发自己的会话，应用代码拿不到控制台凭据。ADR 0041 把这个承载面归入 M1：一个可信的拥有者，可信的应用代码。按 M1 的信任边界，独立源保护的对象并不存在。

实际使用中这套机制有两项代价：

- 新建的应用要等自己的证书签发才能访问，实测 15 秒到 10 分钟以上。命令行因此要等 HTTPS，等不到就失败。
- Worker 运行时要持有账户 API 令牌，只为给应用挂接和摘除域名。

本机 Docker 承载面已经把应用放在同一个源的 `/apps/<name>/` 下（`REQUIREMENTS.md` ROUTE 行，契约 1 的 `X-Forwarded-Prefix`）。

## 决定

1. **地址。** 应用的地址是 `<控制源>/apps/<name>/`。没有尾斜杠的 `/apps/<name>` 以 308 重定向到带斜杠的形式，保留查询串。只有这一种寻址方式，不保留按应用域名的选项。
2. **应用名全局唯一。** 路径只带名字，所以活着（`purged_at` 为空）的应用名在整个部署内唯一，不再只在租户内唯一。D1 用 `apps(name) WHERE purged_at IS NULL` 唯一索引保证，建应用撞名返回 409。
3. **应用看到的请求。** 路径去掉 `/apps/<name>` 前缀，另带 `X-Forwarded-Prefix: /apps/<name>`，含义同契约 1。静态文件照旧在前缀下直接从 R2 返回，不启动容器。浏览器原生订阅端点在 `/apps/<name>/_pneuma-space/realtime/<channel>`。触发器和定时投递不经过前缀，不变。
4. **认证。** 同一个源，控制台会话 cookie 直接授权应用请求。删除应用会话 cookie、一次性交换（`/_pneuma-space/authorize`、`/_pneuma-space/callback`、`/_pneuma-space/login`）和 `grants`、`app_sessions` 两张表的使用。未登录的 HTML 导航重定向到 `/login?next=<原路径>`，其他未认证请求返回 401。发布令牌（`invoke` 权限）继续以 Bearer 调用应用。平台 cookie、Bearer 凭据和保留的身份头仍在到达应用代码前剥除；应用响应仍不能设置平台 cookie。
5. **写请求的来源检查。** 控制 API 的规则不变：写操作要求精确的控制源 `Origin` 和会话 CSRF 头。凭 cookie 认证的应用写请求和 WebSocket 升级要求 `Origin` 等于控制源，与此前要求等于应用源是同一条规则，只是源变了；不要求 CSRF 头。Bearer 请求不检查 `Origin`。
6. **删掉域名机制。** 应用不再挂接或摘除 Custom Domain，清除不再处理域名。Worker 不再有 `PNEUMA_SPACE_APPS_DOMAIN`、`PNEUMA_SPACE_ZONE_ID`、`PNEUMA_SPACE_WORKER_NAME` 和 `PNEUMA_SPACE_CF_API_TOKEN`。`PNEUMA_SPACE_ACCOUNT_ID` 保留，R2 签名地址的主机名要用它。安装命令仍在安装时使用运营者的令牌：检查资源、创建资源、挂接控制域名、派生 R2 签名凭据；它删除旧部署 Worker 上遗留的 API 令牌 secret。
7. **已有部署。** D1 迁移只有附加语句：新的全局名字索引。旧的租户内名字索引、`origin`、`domain_state`、`domain_error` 列和 `grants`、`app_sessions` 表留在旧库里，代码不再读取；`origin` 列是 `NOT NULL UNIQUE`，SQLite 删不掉，新应用在这一列写入自己的 AppId。两个租户各有一个同名且未清除的应用时，索引建不起来，安装停在应用 schema 一步，要先下线并清除其中一个。升级前建的应用改由名字寻址，从 `<控制源>/apps/<name>/` 访问，数据不变。按根路径引用页面资源或接口的应用（包括此前的 Little Shelf 起步应用和 notebook 示例）要改用相对地址并重新发布；已生成的起步项目目录里的命令行副本仍按旧域名访问，要换成新版。它们原来的域名不再提供应用：Worker 对控制源以外的主机一律返回 404。这些 Custom Domain 绑定和证书留在账户里，由运营者在 Cloudflare 控制台或 API 里删除。

## 被拒绝的方案

- **保留按应用域名作为选项。** 两种寻址各要一套认证、命令行等待和验收，M1 用不上独立源。
- **把旧域名重定向到新路径。** 要继续信任存下来的 `origin`，还要给已退出的寻址方式留代码。
- **给应用 cookie 改写 `Path`。** 同源下 `Path` 不是安全边界，改写只会让应用的 cookie 行为和契约 1 不一致。

## 后果

- 所有应用和控制台共用一个浏览器源。应用的页面脚本能读写其他应用的 cookie（HttpOnly 的除外）、`localStorage` 和 IndexedDB，能读取控制台页面，也能带着已登录拥有者的会话调用控制 API：先读 `/api/v1/me` 拿到 CSRF 令牌，再做拥有者能做的任何写操作，包括清除。这只在 M1 的信任边界（应用代码可信）下可以接受，不是租户隔离。租户、邀请和分角色控制台照 ADR 0041 保留，不构成对不可信应用代码的隔离。
- 应用响应里的 `Service-Worker-Allowed` 头被去掉，应用注册的 Service Worker 只能控制自己的前缀，下线或清除之后不能接管控制台和其他应用。这限制的是残留，不是隔离：页面打开期间脚本已经拥有整个源。
- 新应用发布后立即可访问，命令行不再等待证书。
- Worker 运行时不再持有账户 API 令牌。R2 签名凭据仍由安装时的令牌派生，令牌过期后签名地址失效：发布无法上传应用包，应用无法发出对象上传和下载地址。
- 应用名成为部署级资源，一个租户占用的名字其他租户不能用。
