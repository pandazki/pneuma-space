# 本地问卷实验

这是一个面向可信单机环境的小型应用，验证结果也记录在 [result.txt](result.txt)：创建标题与一个自由文本问题，打开问卷、提交并查看回答。SQLite 问卷数据保存在 `/data/questionnaires.sqlite3`；PostgreSQL 模式使用配置的数据库。没有身份验证、隐私隔离或多租户安全保证。每份问卷最多 50 个回答；回答最多 200 字符，问卷标题和问题分别最多 120 和 500 字符。所有来访者都能查看和回答问卷。过期的并发提交返回 409，显示未保存的回答供复制，然后需重新加载提交。

从仓库根目录构建和发布（需要已运行的可信本地网关、Docker 访问权限以及未被占用的应用名）：

```sh
docker build -t fresh-survey:local ./prototype/01-agent-app
python3 appctl.py publish fresh-survey fresh-survey:local
```

打开 `http://127.0.0.1:8080/apps/fresh-survey/`，创建问卷并提交回答。重复发布相同名字保留数据卷；移除注册也保留数据卷。请勿随意清除卷。初始镜像仅配置 SQLite；审计时已给当前 Dockerfile 补装 PostgreSQL 驱动，并保留 [Dockerfile.initial](Dockerfile.initial) 作为原始交付证据。构建时在缓存未命中时需要访问 Python 包仓库。PostgreSQL 的账户与配置仍由使用者提供。

在仓库根目录运行隔离测试：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s prototype/01-agent-app -p 'test_*.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

实验测试通过内存模拟 HTTP 连接、真实临时 SQLite 文件验证行为，不绑定端口，也不访问现有数据。重建存储对象验证数据持久化，不能替代真实进程和 Docker 重启的端到端测试。

## 开发记录和卡点

- 指南说明可以修改模板，但没有给出在独立新目录复制最小文件及构建上下文的步骤。根据导入关系，将 `records.py` 与 `store.py` 原样复制，另建 `app.py` 和 Dockerfile；没有修改模板或网关。
- 记录接口没有跨记录事务，单条记录上限 64 KiB。选择单条记录保存问卷和回答，使用 revision 拒绝旧写入，并限制回答数量；测试了最坏 JSON 控制字符转义的边界。并发失败的回答需用户重新提交。
- 指南没有给问卷领域模型或业务规则。假设每个问卷只有一个自由文本问题，问卷和回答对所有本机访问者可见，没有编辑、删除、用户身份或结果统计功能。
- 执行环境禁止监听本地端口（`PermissionError: [Errno 1] Operation not permitted`）。改为通过内存套接字驱动真实 HTTP handler 和临时 SQLite 文件；根测试的两个 HTTP 测试仍被同一限制阻塞，不能据此宣称完整套件通过。
- `docker info` 无法访问 Docker socket（permission denied）。没有启动容器或修改已有资源；镜像构建、README 的网关及空闲停止/重启 smoke test 均未执行。
- 镜像未安装 PostgreSQL 驱动，只有 SQLite 路径经过本实验验证；实际网关、PostgreSQL 和浏览器交互仍需在具备适当权限的环境中验证。

## 后续独立集成验证

原始开发记录保留了独立 Agent 当时因沙箱限制无法使用 Docker 的情况。主任务随后在获准的本地环境中，从项目根目录运行：

```sh
python3 prototype/01-agent-app/smoke.py
```

该命令构建独立 Agent 的原始问卷代码，以唯一测试名发布，实际创建问卷和回答，检查旧修订冲突，等待闲置自动停止后再次访问并确认回答仍在；随后删除本次测试注册、卷和镜像。先前手动停止容器的端到端验证已通过；以下命令还验证实际闲置停止，本次结果：`PASS: questionnaire creation, answer, stale conflict, idle-stop wake and persisted answer`。这一阶段没有验证 PostgreSQL、真实用户身份或云部署；修复当前 Dockerfile 后重跑的原始输出见 [result-idle-last.txt](result-idle-last.txt)。

## 对原始验证缺口的补测

原 Agent 的 Dockerfile 当时只支持 SQLite。最初补测保留原业务代码并临时使用含 psycopg 的派生镜像。随后已修复本目录当前 Dockerfile、保留初始版本，并直接构建当前镜像重新运行两个真实后端；两边各发出 10 个相同修订号的并发回答：1 个成功、9 个冲突；重复提交被拒绝。测试还检查后端独立数据、数据库与应用重启、往返切换。命令和输出见 [result-dual.txt](result-dual.txt)：

```sh
python3 prototype/01-agent-app/dual_backend_smoke.py
```

当前 Dockerfile 现支持这两种配置；原始版本仍保存在 Dockerfile.initial。完整离线构建尚未实现；常规构建在缓存未命中时需要可访问的包仓库。临时 PostgreSQL 使用一次性测试密码；脚本正常结束后会清理本次独有的测试容器、数据卷、镜像和临时配置。中断时可能需要核对并清理 `appbasesurvey...` 等独有资源。

独立任务的原始委派指令与其无父会话历史的设置记在 [independent-task.txt](independent-task.txt)；未保存完整工具调用轨迹，因而不能事后独立核实 Agent 的每一步阅读。
