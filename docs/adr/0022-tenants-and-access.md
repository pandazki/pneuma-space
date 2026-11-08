# ADR 0022：租户、成员、令牌与访问范围

状态：**M2 决定**。用户 2026-11-08："未来其实是要直接支持多租户的……这个离多租户很近了其实，你可以一起考虑"。设计探索稿 M2-D3 第 3 到 7 节。

决定：

1. **模型。**

   | 实体 | 键 | 字段 | 唯一写者 |
   | --- | --- | --- | --- |
   | Tenant | `name`，文法同应用名 | `display`, `quota`（ADR 0023）, `created_at` | Registry |
   | User | `id`（主体去掉 `user:`） | `name`, `groups`（最近一次所见，只显示）, `first_seen`, `last_seen`（每用户每 5 min 至多写一次，名字或分组变了立即写） | Registry（认证路径经 `registry.sighted()`） |
   | Membership | `(tenant, user)` | `role: admin / member` | Registry |
   | Token | `id` | `tenant`, `subject`, `label`, `hash`, `created_by`, `created_at`, `revoked_at` | Registry |
   | App | 不变 | 加 `tenant`, `access: tenant / org / public`（默认 `org`） | Registry |

   加成员按 id，id 可以还没出现过，页面标"未登录过"，不预建 User 行。每个租户至少保留一个 `admin`，移除最后一个返回 409，平台管理员除外。平台管理员不落库：`PNEUMA_SPACE_PLATFORM_ADMINS` 是逗号列表，项为 `user:<id>` 或 `group:<name>`，每个请求按它判定。
2. **令牌两种，一张表，都属于一个租户，权限封顶 `member`。** 服务令牌主体 `service:<tenant>.<name>`（`name` 匹配 `^[a-z][a-z0-9-]{0,22}$`），该租户 `admin` 签发，给自动化和程序开发者。个人令牌主体是签发人的 `user:<id>`，任一成员给自己签，`appctl` 用它，发布的应用 owner 就是本人，浏览器里 `X-Pneuma-Space-Owner: 1` 照旧成立；每次使用都要求签发人仍是 `token.tenant` 的成员，否则 401，所以移除成员即作废他的令牌。只有在 `PLATFORM_ADMINS` 里按 `user:<id>` 列出的人，个人令牌才有平台管理员权限，按 `group:` 指定的管理员只在浏览器里有。签发、吊销令牌、改成员、建租户只接受 JWT 主体，令牌不能再生令牌。只存 `sha256`，明文只在签发响应里出现一次。触发端点语义不变：先过访问范围，再要求 `service:` 主体或 owner。M1 的令牌迁到 `default` 租户，主体保留 `service:<name>`。
3. **首次发布的租户**：令牌取 `token.tenant`；浏览器取请求体 `tenant`，调用者只在一个租户时可省略。之后只有平台管理员能 `PUT .../tenant` 移动。owner 默认取调用主体，`--owner` 仍可覆盖。
4. **单机**：迁移建租户 `default`，现存应用和令牌归它。`local` 模式下一切写入都落 `default`，管理 API 和 M1 一样不认证，调用者视为平台管理员，Ingress 不做访问范围检查。`access` 字段照存，切到 `upstream` 后生效。
5. **调用者是一个值，认证一次构造，下游不再查身份**：`Caller = { actor, platformAdmin, roles: Map<TenantName, 'admin' | 'member'>, viaToken }`，令牌的 `roles` 已收窄到 `token.tenant` 且封顶 `member`。管理 API 是一张表 `ACTIONS`（端点到所需级别），检查是纯函数 `can(caller, action, tenant)`。平台管理员通过每一行。拒绝答 403 并写明缺哪个角色；目标应用不在调用者租户里答 404，不暴露别的租户有什么。`T` 指目标应用或租户。

   | 端点 | 所需 | 令牌可用 |
   | --- | --- | --- |
   | `GET /api/me`（新）：主体、显示名、各租户角色、`platformAdmin` | 已认证 | 是 |
   | `GET /api/health` | 已认证 | 是 |
   | `GET /api/apps` | 已认证；只返回调用者所在租户的应用；平台管理员可加 `?tenant=`，不加时返回全部并带 `tenant` 列 | 是 |
   | `GET /api/apps/<name>`、`/logs`、`/state` | member(T) | 是 |
   | `GET /api/metrics`、`/api/requests`、`/api/nodes` | 平台管理员 | id 列出者 |
   | `POST /api/bundles` | 至少一个租户的 member | 是 |
   | `PUT /api/apps/<name>/release` | member(T)；首次发布时 T 是目标租户 | 是 |
   | `PUT /api/apps/<name>/policy` | member(T)；`cpu_millis`、`memory_mb` 受租户配额约束 | 是 |
   | `PUT /api/apps/<name>/access`（新） | member(T) | 是 |
   | `PUT /api/apps/<name>/owner` | admin(T) 或当前 owner | 是 |
   | `POST .../remove`、`.../unquarantine` | member(T) | 是 |
   | `POST .../purge` | admin(T)，不可逆 | 否 |
   | `PUT /api/apps/<name>/tenant`（新） | 平台管理员 | 否 |
   | `PUT /api/policy` | 平台管理员 | id 列出者 |
   | `GET`、`POST /api/tenants`（新，建租户带首批 admin） | 平台管理员 | 否 |
   | `PUT /api/tenants/<t>/quota`（新） | 平台管理员 | id 列出者 |
   | `GET /api/tenants/<t>/quota`、`/members` | member(T) | 是 |
   | `GET /api/audit`、`/api/usage`、`/api/usage/apps`、`/api/state`（ADR 0024） | member(T)，`T` 是查询参数 `tenant`；不带 `tenant` 时要平台管理员 | 是 |
   | `PUT`、`DELETE /api/tenants/<t>/members/<user>`（新） | admin(T) | 否 |
   | `GET /api/tenants/<t>/tokens`（新） | admin(T) 看全部；member 只看自己的 | 否 |
   | `POST /api/tenants/<t>/tokens`（取代 `POST /api/tokens`，`kind: service / personal`） | service 要 admin(T)，personal 要 member(T) | 否 |
   | `DELETE /api/tenants/<t>/tokens/<id>`（新） | admin(T) 或签发人 | 否 |

   `local` 模式保留 `POST /api/tokens`，行为同 M1。
6. **访问范围在 Ingress 前奏里**，插在保留路径之后、静态之前，所以 `tenant` 应用的静态文件也受保护。`identity` 与 `access` 正交：`identity` 只决定注入不注入头，`required: false` 只在 `public` 应用上有可见效果。

   | `access` | 需要 | 未认证 | 已认证但不够 |
   | --- | --- | --- | --- |
   | `public` | 无；声明了 `identity` 时照旧认证以注入头 | 放行 | 不适用 |
   | `org`（默认） | 任一合法 JWT 用户或任一有效令牌 | Challenge | 不适用 |
   | `tenant` | 用户是 `App.tenant` 的成员，或令牌的 `tenant` 等于它，或平台管理员 | Challenge | 403 |

   认证每请求至多一次，结果复用给访问检查、身份头和触发端点。缓存每副本一份：JWT 到主体按 `exp`；用户到成员关系 30 s；令牌哈希到令牌行 30 s；本副本写入立即失效。移除成员、吊销令牌 30 s 内全集群生效。Owner 头不变。
7. **审计的 actor**（ADR 0024 写入）由管理边界构造：`{ via: 'upstream', subject, name }`、`{ via: 'token', subject, token, createdBy }` 或 `{ via: 'local' }`。`name` 是当时的快照。服务令牌靠 `createdBy` 追到人，所以 US-O-6 的"谁"总能落到一个人。审计行里的租户是被操作对象的租户。
8. **控制台最小改动**：启动调 `GET /api/me`；顶栏显示名字和退出；属于多个租户或是平台管理员时出现租户切换器（平台管理员多一项"全部租户"），选择存 `localStorage`；项目页按所选租户列，"全部租户"时多一列租户；发布表单 owner 可选，默认本人；详情页加访问范围三值和所属租户，平台管理员多一个"移到租户"；新增"团队"页：成员（按 id 添加、改角色、移除）和令牌（签服务或个人令牌、吊销、明文只显示一次），"全部租户"时列租户并有建租户表单；总览、实时、拓扑只对平台管理员显示。`local` 模式 `/api/me` 返回 `{local: true, platformAdmin: true}`，切换器和团队页不出现。`appctl`：`PNEUMA_SPACE_TOKEN` 作 Bearer，`whoami`、`access <name> <tenant|org|public>`、`publish --tenant`。

理由：租户是配额、统计和审计的边界，组织里的团队和 M3 的客户是同一个实体，M3 只加计量和计费。个人令牌和服务令牌同一张表、同一条规则，多出的只是 `subject` 一列；只有服务令牌时 `appctl` 发布的应用 owner 会是 `service:`，开发者在浏览器里就不是 owner，审计也落不到人。令牌封顶 `member`，泄露一个令牌的伤害就不等于泄露这个人。平台管理员放配置而不是库，省掉"第一个管理员谁来设"的引导流程。授权做成一张表加一个纯函数，而不是散在处理函数里。

拒绝：令牌继承签发人的全部角色；平台管理员存库；只有服务令牌；成员按上游分组自动同步（已定取舍 2）；用 `Origin` 等于控制台主机防跨站写（要配置控制台源，上游改写 `Host` 时出错；`Sec-Fetch-Site` 不用配置，ADR 0021）；令牌的 `last_used_at`（没有故事需要，写放大）。

后果：主体文法上限 64 字符，超长邮箱被拒。每副本 30 s 的授权缓存让吊销有延迟，接上 ADR 0025 的变更通知后可以按事件失效。`purge` 要 `admin`，`REQUIREMENTS-M2.md` 里 member 的"管理"不含它。
