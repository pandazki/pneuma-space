# ADR 0021：可信上游身份

状态：**M2 决定**。用户 2026-11-08："SSO 我还没想好……可以先不用……只要有个抽象的多用户就行"。取代 ADR 0008 里"M2 换 OIDC"。设计探索稿 M2-D3 第 1、2 节。

决定：

1. **两个提供者，`PNEUMA_SPACE_IDENTITY` 选一个**：`local`（默认，M1 本地桩原样）和 `upstream`。`IdentityProvider` 接口不变。`upstream` 不实现任何登录协议：组织在平台前面放自己的认证代理或 API 网关，它把签过名的 JWT 放在请求头里，平台验签。

   | 键 | 默认 | 含义 |
   | --- | --- | --- |
   | `PNEUMA_SPACE_IDENTITY_HEADER` | 无，`upstream` 必填 | 上游放 JWT 的请求头，大小写不敏感，值可带 `Bearer ` |
   | `PNEUMA_SPACE_IDENTITY_JWKS_URL` / `_KEYS_FILE` | 无，二选一 | JWKS 地址，或静态公钥文件（JWKS JSON 或 PEM） |
   | `PNEUMA_SPACE_IDENTITY_ISSUER` | 无，必填 | `iss` 精确相等 |
   | `PNEUMA_SPACE_IDENTITY_AUDIENCE` | 无，必填 | 逗号列表，`aud` 与之有交集；应用主机用它 |
   | `PNEUMA_SPACE_CONSOLE_AUDIENCE` | 同上 | 控制台和管理 API 的受众；配成不同值后，从应用请求泄出的 JWT 不能在控制台重放 |
   | `PNEUMA_SPACE_IDENTITY_USER_CLAIM` | `sub` | 映射为 `user:<值>` |
   | `PNEUMA_SPACE_IDENTITY_NAME_CLAIMS` | `name,email` | 第一个非空的作显示名，都空时用 id |
   | `PNEUMA_SPACE_IDENTITY_GROUPS_CLAIM` | `groups` | 只用于显示和平台管理员判定（ADR 0022） |
   | `PNEUMA_SPACE_IDENTITY_LOGIN_URL` | 无 | 模板，`{url}` 替换为编码后的绝对返回地址 |
   | `PNEUMA_SPACE_IDENTITY_LOGOUT_URL` | 无 | `/_pneuma-space/logout` 303 到这里 |
   | `PNEUMA_SPACE_IDENTITY_STRIP_COOKIES` | 空 | 逗号列表，上游会话 cookie 名，转发给应用前从 `Cookie` 删掉 |

   算法集合 `RS256`、`ES256`、`EdDSA`，时钟偏差 60 s，JWKS 刷新参数，都是常量。
2. **验签在 `gateway/src/jwt.ts`，只用 `node:crypto` 和全局 `fetch`。** 取头值去掉 `Bearer `，必须恰好三段 base64url（头名配成 `authorization` 时，不是三段的值视为平台令牌）；`alg` 在集合内且与密钥的 `kty`、`crv` 匹配，`none` 和 `HS*` 一律拒绝，ES256 用 `ieee-p1363`；按 `kid` 找钥，无 `kid` 且只有一把钥时用它；`exp` 必须有，`exp`、`nbf`、`iat` 各留 60 s；`iss`、`aud` 按配置；用户 id 必须满足主体文法（文法加 `+`，邮箱常带它），否则 401 并记事件 `identity-rejected`（带声明名，不带值）。结果按 `sha256(JWT)` 缓存到 `exp`，LRU 一万条。JWKS 启动时取、不阻塞启动，按 `Cache-Control: max-age` 刷新，夹在 60 s 到 1 h，缺省 10 min；未知 `kid` 立即重取，每 30 s 至多一次；取失败保留旧钥；一把钥都没有时答 503 `identity keys unavailable`，不发 Challenge。
3. **缺头或验签失败**：需要用户的请求，浏览器（`GET` 且 `Accept` 含 `text/html`）303 到 `LOGIN_URL`，`{url}` 是 `X-Forwarded-Proto` 加 `Host` 加原路径；没配 `LOGIN_URL` 或其他客户端 401。`/_pneuma-space/login?next=<path>` 保留：已认证 303 到 `next`，否则 303 到 `LOGIN_URL`；`next` 只接受以 `/` 开头的本主机路径。
4. **`upstream` 模式无状态，平台没有自己的会话 cookie。** `/data/pneuma-space.secret` 和签名 cookie 只留给 `local`。多副本之间因此没有共享会话。
5. **三类主机都经上游**：控制台主机（到 8081）、`*.<apps-domain>`（到 8080）、API 主机（到 8081，上游放行，只认平台令牌，给 `appctl` 和外部触发调用者用）。网关不按主机区分认证方式：有合法 JWT 用 JWT，否则看 `Authorization: Bearer` 平台令牌。
6. **转发给应用时**：INV-5 不变，丢弃全部入站 `X-Pneuma-Space-*`；新增丢弃 `PNEUMA_SPACE_IDENTITY_HEADER`（值是 JWT 时）和 `STRIP_COOKIES` 列出的 cookie，应用拿不到能在控制台重放的凭据；应用响应里 `Set-Cookie` 的 `Domain` 属性被删掉，cookie 只落在应用自己的主机；`X-Pneuma-Space-Name` 改为 UTF-8 百分号编码（上游的显示名会有中文，M1 的名字编码后不变，对 M1 应用是加法）。
7. **控制台跨站写防护**：管理 API 上以 JWT 认证、方法不是 `GET`/`HEAD` 的请求必须带 `Sec-Fetch-Site: same-origin`，否则 403。控制台和应用同属一个可注册域名，`SameSite` 挡不住应用页面向控制台发的表单。平台令牌请求不受影响，它没有环境凭据。

理由：上游每个请求都带签名 JWT，网关每次验签，缓存后近乎零成本，所以不需要自己的会话。平台 cookie 只有两种放法：放父域，任何应用都能用 `document.cookie` 覆盖它；每主机各放一份，就要每主机一次跳转握手，等于重写上游已经做的事。只信明文头（如 `X-Forwarded-Email`）的唯一保证是网络位置，多副本、侧车和误配都会让它被伪造，已定取舍要求签名。平台代码里没有任何一家上游的名字，oauth2-proxy、Cloudflare Access、公司网关的配置各是运营者文档里的一段。

拒绝：平台签发自己的会话 cookie；只信明文头；`HS256` 共享密钥（要防密钥混淆，多一套密钥分发，目前没有上游只能发它）；通用 OIDC 客户端（需要时作为第二个提供者加，不改接口）；按分组自动同步成员（已定取舍 2 推迟）。

后果：`public` 应用要上游放行匿名访问，而上游的放行规则是静态的，所以 ADR 0019 给出可选的 `PNEUMA_SPACE_PUBLIC_APPS_ORIGIN` 让上游整域放行；`appctl` 和外部触发调用者要上游放行 API 主机和应用主机上的 `POST /_pneuma-space/trigger/`；M1 允许程序带平台令牌调用应用的任意路径，在上游后面一般走不通，运营者文档写明。路径地址（单机）下所有应用同源，US-O-8 不成立。只转发解码后载荷的网关模式（如 Envoy `forward_payload_header`）不可用，必须是带签名的原 JWT。`document.cookie` 写父域 cookie、上游 cookie 放父域被应用覆盖、应用之间的 CSRF 都在"成员不恶意"的信任边界内，M2 不防。按分组判定平台管理员依赖上游把分组放进 JWT，很多 IdP 默认不放。默认 `sub` 在换 IdP 时会变，US-O-7 要求运营者把用户声明配成稳定的那个（如 `email`）。
