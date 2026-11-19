# ADR 0027：副本凭内存能断定什么

状态：**M2 决定**。修订 ADR 0020 第 4 条的 acquire 快路径、实例自己结束和孤儿清理三处。2026-11-11 审查的 R1、R2、R3。

决定：

1. **快路径只信已提交的 tally。** ADR 0020 第 4 条"本副本对当前 epoch 最近一次已提交或已排队的 tally 大于 0"改为：本副本对当前 epoch 最近一次已提交的 tally 大于 0，且队列里没有一笔把它降到 0 或写到别的 epoch。把计数从 0 抬到大于 0 的只有慢路径和唤醒的那笔写，它们在事务里看到行醒着；release 的批量写只能维持已提交的正数。这样一笔写排队未提交时，本副本对同一 epoch 的其他 acquire 等它，不另开事务，也不从内存发租约，然后重判：它提交了就走快路径；它失败了，等待者得到同一个错误；它的事务发现行已不醒，等待者重新走慢路径或唤醒。排队中的 0 写仍让下一个 acquire 走慢路径，入队时记账不变。
2. **isolate worker 归谁，只看库里的行。** worker 有主，当且仅当它的 App 的 `instance` 行（在 runner 列出之后从库里读）`runtime` 是 `isolate`，并且 `handle` 是它而行不是 `asleep`，或者行是 `waking`（唤醒者可能还在创建它）。这是 ADR 0020 第 4 条孤儿清理的规则加上"不是 `asleep`"：isolate 不跨休眠保留 worker，`asleep` 行上留下的 handle 只是一次没停成的 worker。判定只在 recovery 一处：领导者每 5 s 对每个答话的 runner 做一次，任一副本在自己对某个 runner 的调用失败后、该 runner 再答话时做一次。列出后，镜像认为有主的直接留下，其余逐个读库，确认无主才停。停是有条件的 `DELETE /instances/<app>?worker=<id>`：runner 只在该 App 当前的 worker 正是这个 id 时停它、清它的代码目录和日志。按 handle 删 worker 的其他路径（唤醒失败、接管、退役、收养）也带 id。领导者启动时的收养（ADR 0019 第 5 条）只比对库里的行指名且不是 `asleep` 的 worker，其余留给 recovery。recovery 可以重复做，两个副本同时做，结果相同。
3. **每个副本跟随每个醒着的 isolate worker 的结束，不论谁起的。** 跟随的集合由镜像推导：`awake` 的 isolate 行，home 是这个 runner，handle 是这个 worker。runner 的事件流按游标读；游标读到过一个 worker 的 `ready` 事件，它之后的结束就一定读得到。否则（刚开始跟随、游标有断档、runner 换过进程）先清点一次 runner 的 `/instances`：worker 在列，就算接上了；不在了，用 runner 还留着的终止事件归类，没有就记为 `crashed` 并写明原因。然后照常 CAS `awake→asleep WHERE epoch AND handle`，只有赢家记 Guard 失败、发事件。runner 连续 15 s 不答时，副本只把自己起的或收养的 worker 标为 unavailable：答不答是这个副本的视角，不是 worker 结束了。

理由：快路径发出的租约要被库里的计数保护，回收器的 `FOR UPDATE` 只看得到已提交的行，排队中的正数挡不住在它提交前抢到行锁的回收器；R1 实测第二个请求在首个 tally 提交前已被转发。等待者共用那一笔写，热应用的冷边沿仍只写一次。本地集合缺项只说明这个副本没起那个 worker；R2 里副本 B 的恢复停掉了副本 A 持有租约的 worker。行是唯一跨副本一致的归属，container 的孤儿清理早已按它判。起 worker 的副本会死；R3 里领导者接任后没有副本看见 worker 退出，行一直 `awake`，请求 502。ADR 0020 第 4 条本来就要求每个副本轮询它看得到的 runner，用 `ready` 事件判断游标是否覆盖，平时不必清点。

拒绝：每个 worker 一个属主副本（ADR 0020 已拒绝）；recovery 凭镜像判无主（镜像可能落后于刚完成的唤醒）；把 isolate 接到 `Driver.list` 和领导者 60 s 的 sweep（孤儿要等到 60 s，而 sweep 留下 `asleep` 行指名的实例，Pod 靠这一点留住崩溃日志，isolate 不该留）；每个 acquire 各等各的事务（同一 epoch 的并发请求各开一个事务）；runner 不答时每个副本把它上面所有 worker 都标为 unavailable（一个副本的网络故障会让别的副本持有租约的应用休眠）。

后果：DESIGN 2.3 的快路径和结束观测指向本 ADR。领导者对每个 runner 每 5 s 多一次 `/instances`；副本接上一个游标没覆盖的 worker 时多一次 `/instances`。孤儿 worker 在 5 s 加一次停止（排空至多 10 s）内消失。runner 会复用同一 release 和 spec 的 worker（重试的启动加入正在跑的那个），所以按 id 的条件删除挡得住新 epoch 起的新 worker，挡不住在同一毫秒级窗口里被新唤醒复用的孤儿：那次唤醒表现为一次 `stopped` 结束和下一个请求的重新唤醒，不计失败。runner 只对一个副本不答时，别的副本起的 worker 由它们自己标 unavailable；起它的副本已死而 runner 又不答时，行要到闲置回收才休眠。
