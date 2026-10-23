# 数据访问与初始化

数据库保存配置、图片记录、副本位置和任务进度，不保存图片内容。一个文件可以有多个存储副本，也可以有多个待执行任务；这些记录共同描述工作进度，不能用文件状态替代副本或任务状态。

## 数据与配置的关系

| 数据 | 作用 |
| --- | --- |
| 插件实例 | 保存某个插件的配置，供路径、存储或处理步骤使用 |
| 流水线与步骤 | 关联处理插件实例，定义顺序与开放参数 |
| 存储组 | 关联存储实例，定义总副本数与存储选择方式 |
| 上传配置 | 关联路径实例、存储组、上传和保存后流水线，定义公开前缀 |
| 文件记录 | 保存公开路径、图片元数据和文件状态 |
| 副本记录 | 关联文件与存储实例，记录存储路径和读写状态 |
| 任务记录 | 关联文件，记录后台写入、保存后处理或删除的进度 |

访问流水线是全局配置。完整类型和数据访问方法位于 `src/persistence/port.ts`。

## 使用数据访问接口

核心服务持有 `Persistence`，通过回调取得 `Repositories`。例如，下面的函数可放在 `src/core/` 中：

```ts
import type { Persistence } from "../persistence/port";

export async function listEnabledProfiles(db: Persistence) {
  return db.read(async (r) => {
    const profiles = await r.profiles();
    return profiles.filter((profile) => profile.enabled);
  });
}
```

| 接口 | 用法 |
| --- | --- |
| `db.read(callback)` | 在一致的事务视图中读取数据 |
| `db.transaction(callback)` | 在同一事务内检查并更新多条记录 |
| `Repositories` | 提供业务数据访问方法；仅在回调期间有效 |

`read` 和 `transaction` 都使用数据库事务，`read` 是读取用途的约定，不是只读 SQL 的强制限制。不要将回调中的 `r` 缓存到其他对象，也不要在回调返回后继续使用它。

状态变更应在事务内重新读取并检查前置条件。`saveFile(value, expectedStatus)` 等方法还会检查预期状态，防止并发操作覆盖新状态。具体业务更新应调用已有核心方法，避免绕开副本和任务的联动规则。

## 事务与外部操作

PostgreSQL 遇到序列化冲突或死锁时，持久化层最多重试事务两次。因此，**事务回调可能执行多次，只能放数据库工作**。

存储写入、插件调用、发送通知和删除本地文件都应放在事务外：先在事务中登记或领取工作，执行外部操作，再用事务复查状态并记录结果。数据库回滚不能撤销已经写入的远端对象；中断后的处理见 [状态、任务与资源生命周期](./states.md)。

## 两种数据库如何共用实现

| 位置 | 职责 |
| --- | --- |
| `open.ts` | 有 `DATABASE_URL` 时使用 PostgreSQL，否则使用 `DATA_DIR/database.sqlite` |
| `port.ts` | 业务数据类型与访问接口 |
| `repositories.ts` | 基于 Kysely 的共用查询，必要处处理方言差异 |
| `store.ts` | 事务作用域、冲突转换和 PostgreSQL 事务重试 |
| `sqlite/store.ts`、`postgres/store.ts` | 建立连接、初始化并校验表结构、配置数据库行为 |

SQLite 启用外键、WAL 和忙等待；PostgreSQL 读取事务使用 `repeatable read`，写入事务使用 `serializable`。新增查询时需检查两种方言的返回值、类型转换与并发行为。

## 修改数据库结构

表结构通过 SQLite 与 PostgreSQL 的 `001_initial.sql` 维护，修改时同步 `port.ts`、查询层及相关业务逻辑。不为旧开发库追加兼容迁移；涉及已有数据时先备份，再单独制定离线处理方案。发布含结构变更的版本时，必须说明升级与恢复要求。

启动时只执行首次建库，并通过 `schema_info` 中的 SHA-256 校验值核对当前结构。已有本地数据库需要先备份、再离线单独处理，保留业务数据；不要清空数据库或绕过结构校验。插件配置升级独立于数据库初始化，继续保留。

应用启动自动初始化数据库。也可以在服务停止后、仓库 `.env` 已配置时执行：

```sh
bun run init-db
```

此命令通过 `bootstrap` 打开应用，也会加载插件并执行恢复流程，不是单独运行 SQL 文件的工具。

## 必要验证

SQLite 持久化测试：

```sh
bun test tests/persistence.test.ts
```

修改共用查询或初始表结构时，再用专用 PostgreSQL 测试库验证。将下例连接地址替换为自己的测试库，账号需要创建 schema 的权限：

```sh
TEST_POSTGRES_URL=postgresql://picloom:password@127.0.0.1:5432/picloom_test bun run test:postgres
```

测试会创建隔离 schema 并清理。`tests/persistence.contract.ts` 提供两种数据库共用的行为契约；新增通用数据访问能力时优先在这里补充测试，再运行受影响的业务测试。
