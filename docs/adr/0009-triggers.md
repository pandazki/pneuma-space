# ADR 0009：触发至少一次

状态：**M1 决定**。

决定：定时和按需触发都先写一条持久 Delivery 再投递。投递持有 trigger Lease 唤醒应用，`POST /_pneuma/trigger/<name>`，2xx 成功，否则退避重试，5 次后 `failed`。每次重试带相同的 `X-Pneuma-Delivery`，应用据此去重。重启时 `delivering` 回到 `due`。定时槽位以 `(app, trigger, scheduled_for)` 唯一，停机补发最多一个槽位。

理由：行先于调用，崩溃不丢触发；同一个 `acquire` 路径，不另造唤醒机制；去重交给应用，平台不假装 exactly-once。

拒绝：应用内常驻 worker（T-WORKER 永远睡不了）；exactly-once（需要应用参与协议，故事没要求）；停机后补发全部错过的槽位（停一周发 168 次）。

后果：应用必须让触发处理幂等。挂住的触发在 `trigger_timeout_seconds` 后算失败并重试。
