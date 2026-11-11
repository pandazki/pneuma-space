# ADR 0028：发布、策略和清除在检查与提交之间对资源的假定

状态：**M2 决定**。取代 ADR 0023 后果里的两句："存储准入在租户锁下判定而 Binding 行在 Provider 的 IO 之后才写，同一租户并发发布可能一起通过"和"把 `db_backend` 切到 sqlite 新建的 SQLite Binding 不经存储准入"。对应 issue #11、#12、#13、#14。

决定：

1. **files 和 SQLite 的 Binding 行就是 `storage_gb` 的占用（INV-12）。** 不加预留表、计数器列或 Binding 状态；用量仍是 `quotaUsed` 算的 `volume`、`sqlite` 两个 Provider 的 Binding 行数乘以供应容量。变的是行出现的时刻：凡是将要为这两个 Provider 新建 Binding 行的命令（发布、把 `db_backend` 切到 sqlite）都经 Registry 的同一个入口，在一个事务里锁租户行、`admits` 判定，再把缺的行插成占位：`state` 为 `suspended`，`resource` 为空对象。首次发布的 App 行也在这个事务里插，`apps` 和 `storage_gb` 一起判。`provider.ensure` 照旧在事务外运行，返回后把行写成 `active` 和它的 `resource`；发布最后的提交事务不变。
   - 占位从它的事务提交起就计入用量，同一租户的准入由租户行锁串行，跨副本的并发发布不会超额。
   - 行是真相，后端向行收敛：准入之后崩溃或 `ensure` 失败，留下一条计入用量、后端还没有资源的行。下一次发布看到行已在，不再申请配额，`ensure` 采纳它；启动收敛照常按期望状态处理，当前 Release 要它 `active` 就 `ensure`，否则留着；`purge` 照常 `destroy`，存储 Provider 由 App id 推出卷名，删不存在的卷或目录是成功。空的 `resource` 不需要特判：注入只取 `active` 的行，存储 Provider 的四个动作都不读 `resource`，状态清单里它的 `location` 为空。
   - 切到 sqlite 超额时抛 `QuotaExceeded`，和发布一样答 409 带 `quota` 字段，发 `quota-refused`（`action` 为 `policy`）；App 的 override 和 Binding 行原样不动。已有 SQLite Binding 的来回切换不申请。
   - INV-2 不变：Binding 行只由发布和 `db_backend` 变更创建，只由 purge 删除。
2. **提交引用某个 bundle 的 Release 与删除这个 bundle，按 bundle 互斥。** 不加表。`Store.exclusiveBundle(bundle, fn)` 是 `exclusive` 的兄弟：SQLite 上是同样的进程内队列；PostgreSQL 上在当前命令的会话上取 `pg_advisory_lock(3, hashtext(bundle))`，跨副本互斥，会话断开即释放，命令里的事务也跑在这个会话上。锁序总是先应用名、后 bundle，一次至多持有一个 bundle。
   - 发布在 `ensure` 之后进入该 bundle 的互斥，从对象存储重读索引，再跑提交事务；副本内的索引缓存不作数，`S3BundleStore` 不再缓存索引。bundle 已不在时什么也不提交，答 409，提示重新上传再发布。
   - purge 对本应用 Release 引用的每个 bundle 依次进入它的互斥，用一条走 `release(bundle)` 索引的查询问别的应用的 Release 是否引用它，没有才删。判定引用的 SQL 条数与应用总数无关。`purging` 照旧持久化，重跑时删已删的 bundle 是成功；启动时加载已删 bundle 的索引不再让网关起不来，该 App 的视图没有静态文件。
   - `S3BundleStore.delete` 先删 `index.json` 再删其余对象。`put` 最后写索引，所以"索引在"等于"bundle 完整"：删到一半崩溃的 bundle 对发布而言已经不在，重新上传会补齐。
   - 上传在 `put` 算出 id 之后的判断和写入也在该 bundle 的互斥里（`S3BundleStore` 不认识 Store，`main.ts` 把 `store.exclusiveBundle` 作为函数交给它；上传不在命令里，PostgreSQL 上自取一个命令会话），否则 purge 列出对象之后写入的文件会被它删掉而新索引留下。
3. **有持久目录的应用不能被一次发布换运行时。** 同一个 StorageBinding 在 container 下是命名卷（K8s 上是 PVC），在 isolate 下是 runner 卷里的目录（ADR 0017 第 4 条），换运行时后应用看到的是空目录。发布的运行时非空、不同于该应用最近一个有运行时的 Release 的运行时、且应用有 `volume` 或 `sqlite` 的 Binding 行（任何状态，`suspended` 的行仍持有数据）时，答 409（`Conflict`），消息写明应用、数据所在的运行时、要的运行时和两条出路：换个名字发布，或先 remove 再 purge。判定在任何写之前（首次发布插行、准入事务、`ensure` 之前），两个方向、两个平面相同，只读 Release 和 Binding 行，Provider 仍不知道运行时。只有 PostgreSQL、kv、object 的应用可以换运行时，它们的数据不在目录里；中间的纯静态 Release 不重置这条规则。

理由：占位行让"用量取自计数，不存计数器"（ADR 0023）字面成立：计的就是行，行在任何后端 IO 之前就在，判定和占用在同一个租户锁事务里；预留表和计数器列都是第二个真相源，崩溃后要核对。占位用 `suspended` 而不是新状态，因为它和 remove 之后的行一样有归属、计入用量、不注入，状态机、注入和收敛都不用改；ADR 0005 拒绝的 `pending` 是要在提交后核对的状态，这里没有核对，启动收敛本来就逐条按 `state` 重跑（DESIGN 2.3）。按 bundle 的互斥让"提交引用"和"判定无引用再删"不重叠，检查和删除之间没有别人能提交；advisory lock 跟着命令会话，崩溃语义和应用名锁相同，不另开会话，所以不占命令槽，也不会和命令槽互等。引用判定交给库里一条带索引的查询，替掉"读出全部应用再逐个读 Release"的循环。运行时切换时迁移要停机、拷贝、校验，还要有一方知道另一方的落地位置，破坏 ADR 0017 的中立；拒绝只是发布路径上的一次判定和契约里的一句话，发布前写入的数据发布后可读（AC-P-2、INV-6）对发布者照旧成立。

拒绝：预留表或租户上的预留计数列；Binding 新增 `pending` 状态；在每个入口各补一次准入；bundle 删除的宽限期（只缩小窗口）；可撤销的删除标记加最终复核（多一张表和一个清扫）；Release 引用计数列（崩溃下漂移）；运行时切换时迁移数据；让 StorageBinding 在两个运行时落到同一位置（runner 和应用容器不共享卷，K8s 上 PVC 是 ReadWriteOnce）。

后果：每次发布多一个小事务（准入和占位；没有新行时只读不锁）。`ensure` 一直失败的应用留着一条计入配额的行，直到它发布成功或被 purge：后端可能已经有一半资源，这正是要计的。PostgreSQL 上同一租户的大量并发准入在租户行锁前取的快照会过期，靠 SERIALIZABLE 的重跑收敛：两个副本 50 个并发首次发布实测每次约 15 到 25 次重跑，没有一个事务用完 5 次；更高的并发要看 `retries` 指标。发布和 purge 在同一 bundle 上互相等待，等待时长是一次提交事务或一次对象删除。一个应用一旦用 files 或 SQLite 发布过，换运行时就要换名字或先清除数据。
