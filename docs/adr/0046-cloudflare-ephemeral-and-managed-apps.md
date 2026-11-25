# ADR 0046：Cloudflare 承载面的临时应用和受管应用

状态：接受。2026-11-25。实现 [ADR 0041](0041-cloudflare-m1-plane.md) 第 6 条，修订它的“顺序”：这一步先于自述与授权。语义是 [ADR 0038](0038-ephemeral-apps.md) 和 [ADR 0039](0039-managed-apps.md) 的，本文只记它们在这个承载面上怎样落地、哪里与 Node 网关不同、为什么。

## 背景

Cloudflare 承载面的形状与网关不同：先建应用，再领上传票据，再发布；应用按 id 寻址；生命周期动作是 `/apps/:id/actions` 上的类型化动作；AppCell 是生命周期真相，D1 只是目录投影；没有访问级别，也没有全局策略。

## 决定

临时应用：

1. **建应用时声明。** 网关在首次发布时建出 App，这里建应用是单独一步，所以 `ephemeral: {"ttlSeconds"?: n}` 放在建应用的请求体里。`expires_at` 写进 D1 的应用行和 AppCell 状态，之后不变。
2. **每次发布声明种类。** 上传票据和发布的请求体带布尔值 `ephemeral`，缺省为 false。网关只在发布这一步检查，这里两步都查，种类不符时不发票据、不预留字节、不写 Release。
3. **TTL 在 Worker 变量里。** 没有全局策略存储，缺省值和上限是 `wrangler.jsonc` 里的 `PNEUMA_SPACE_EPHEMERAL_TTL_SECONDS`（600）和 `PNEUMA_SPACE_EPHEMERAL_MAX_TTL_SECONDS`（3600），与 `PNEUMA_SPACE_MAX_ACCOUNTS` 同处。两个值不合法时建临时应用答 503。
4. **丢弃是动作 `discard`。** 令牌要 `remove` 范围。动作按 id 寻址，id 不会落到同名的后一个应用上，网关的 `?app=<id>` 在这里是寻址本身，不另设；命令行的 `discard NAME --app ID` 直接用这个 id。
5. **到期靠应用自己的闹钟。** AppCell 建立时就把闹钟设在 `expires_at`，未发布的应用也会到期，没有领导者和 10 s 清扫。审计行写进 D1，actor 是 `platform`：`started`，结束时 `ok`，等待过或失败过的带 `resumed`；同一个错误只写一行 `error`，30 s 后由闹钟重试。只有到期开始的结束写 `app.expire`；被丢弃后仍在 `purging` 的应用由闹钟清完，不写 `app.expire`。
6. **配额。** 租户多一列 `ephemeral_limit`，默认 3，与其他配额一起在 `/admin/tenants/:id` 修改。这里没有不限额的 `default` 租户，也没有 `null`，取值范围同 `apps`。存储额度按持久应用的方式推导（`min(10 MiB, storage_limit / apps_limit)`），照常计入存储配额。进入 `purging` 的临时应用不再占临时配额，存储预留和名字留到清除完成，所以预留总量仍在存储配额之内。
7. **不排日程。** AppCell 不为临时应用计算 schedule；按需的 job 照常。
8. **可见。** 列表和详情有 `expiresAt`；两个命令行发布时打印应用 id 和结束时刻；控制台在卡片和详情上显示标记和结束时刻，用量多一项临时项目，项目菜单多一项丢弃；审计 `app.create`（details 带 `expiresAt`）、`app.discard`、`app.expire`。
9. **没有访问级别。** ADR 0038 第 6 条在这里没有对应：应用本来就只对租户管理员和 owner 开放。

受管应用：

1. **manager 在 AppCell 里。** 它和其他平台元数据一样存在 AppCell 的隐藏 KV，点名的检查和写在同一个串行队列里；D1 的 `manager_name`、`manager_url` 是给列表的投影，随每次操作更新。
2. **要点名的写。** 上传票据、发布、`rollback`、`remove`、`resume`、`purge`、`discard`、`policy`、清除 manager。网关没有 `rollback` 和 `resume`，它们改变线上的版本，正是管理方记录的东西；网关的 access、owner、tenant 在这里没有对应的写。上传票据由 Worker 按 AppCell 当时的状态检查，之后 manager 变了，发布时 AppCell 再查一次。
3. **清除。** `DELETE /api/v1/apps/:id/manager`，`publish` 范围，审计 `app.manager`。控制台不设置也不清除 manager，同 ADR 0039。
4. **没有相同 release_key 的空操作。** 这个承载面每次发布都写新 Release，带 manager 的发布总会生效。用同一 Idempotency-Key 重试返回第一次的结果，manager 已在第一次写入；重试换了 manager 答 409。
5. **拒绝不审计。** 这个承载面只审计成功的写，被拒绝的写不记 `refused`。上传票据本来不审计，带请求头也不记，之后的发布会记 `namedManager`。
6. **卡片上是文字。** 项目卡片本身是指向项目的链接，链接不能嵌套，所以卡片上 manager 是文字、url 在提示里，详情页里是链接。

## 后果

- 丢弃和到期走清除的路径，要等这个应用最后一个签名上传地址到期（领票据后 180 s，再加 2 s）才能删完（CF-11）。在此之前应用停在 `purging`、不应答请求，名字和存储预留不释放，丢弃答 `{"pending": true, "retryAt": …}`。网关的丢弃没有这段等待。
- 临时配额和名字按 D1 投影放出，所以进入 `purging` 和 `purged` 都要写到 D1：AppCell 记下目录尚未确认，在答复前或闹钟返回前写投影，写失败由闹钟每 30 s 重试，直到写成。D1 的计数只在写失败时落后，最多落后到 D1 恢复后 30 s。
- 新租户的默认存储是 80 MiB，按每个应用 10 MiB 正好放下 5 个持久应用和 3 个临时应用。已有租户的存储配额不随升级改变，默认 50 MiB 的租户在 5 个持久应用之后建不了临时应用，要在 `/admin` 提高。
- 已有部署：重新运行安装命令时，安装器比较 `schema.sql` 和库里的列，缺的列用 `ALTER TABLE ADD COLUMN` 补上，已有租户的 `ephemeral_limit` 取列的缺省值 3；已有应用的 AppCell 状态在下次加载时补上空的 `expiresAt` 和 `manager`。以后加的列也要能这样补：允许 NULL 或有缺省值。
- 回滚到没有本决定的 Worker：旧代码忽略新列和状态字段，临时应用变成不会到期、计入 `apps` 的普通应用，受管应用变成普通应用。
- 这些行为只经本地测试验证，见 [CF 验证记录](../../cf/docs/verification.md)。按 ADR 0041 的顺序，这一步以真实账户上的验证收尾，之后才称这个承载面完整。
