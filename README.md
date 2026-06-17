# BTCD 批量工具链

在 Elastos PGP 链上批量管理钱包：**创建地址 → 注资 PGA/BTCD → 兑换 USDT → 跨链 BSC → 注 BNB → 归集**。

## 目录结构

```
btcd-swap/
├── scripts/
│   ├── 01-createWallets.js
│   ├── 02-transferPGAFee.js
│   ├── 03-transferBTCDToWallets.js
│   ├── 04-swapBTCDToUSDT.js
│   ├── 05-bridgeUSDTToBSC.js
│   ├── 06-transferBNBFee.js
│   ├── 07-collectUSDT.js
│   ├── 08-transferPGChainUSDT.js
│   ├── 09-collectBNB.js
│   ├── fist/              # BTCD -> FIST -> Pancake USDT 流程
│   │   ├── 01-createWallets.js
│   │   ├── 04-approveBTCD.js
│   │   ├── 05-swapBTCDToFIST.js
│   │   ├── 06-approveFIST.js
│   │   ├── 07-bridgeFISTToBSC.js
│   │   ├── 09-approveFISTBSC.js
│   │   └── 10-swapFISTToUSDT.js
│   ├── pga/               # BTCD -> USDT (PGP) -> BSC 流程
│   │   ├── 01-createWallets.js
│   │   ├── 04-approveBTCD.js
│   │   ├── 05-swapBTCDToUSDT.js
│   │   ├── 06-approveUSDT.js
│   │   └── 07-bridgeUSDTToBSC.js
│   └── legacy/
├── lib/
│   ├── fist/              # FIST 流程共享库
│   └── pga/               # PGA 流程共享库（PGP 链 BTCD→USDT→跨链）
├── data/                  # 钱包 CSV（gitignore）
│   ├── 01-wallets.csv
│   ├── 01-wallets-private.csv
│   ├── 02-wallets.csv
│   └── ...
├── logs/
├── .env.example
└── package.json
```

## 合约地址

| 项目 | 地址 |
|------|------|
| BTCD 兑换合约 | `0xFF60725F03531DCeE7f91d731cd002Fc78aB497F` |
| BTCD (PGP) | `0xF9BF836FEd97a9c9Bfe4D4c28316b9400C59Cc6B` |
| USDT (PGP) | `0xdF72788af68E7902F61377D246Dd502b0b383385` |
| 跨链桥合约 | `0xDBB35259372B2f0cB6b85dD31761C0fB3652Fd11` |
| USDT (BSC) | `0x55d398326f99059fF775485246999027B3197955` |
| 目标链 | BSC (chainId = 56) |

---

## 1. 环境准备

```bash
cp .env.example .env
npm install
```

`.env` 必填：`WALLET_PRIVATE_KEY=0x...`（主钱包，注资/归集用）

---

## 2. 钱包 CSV 命名规则

每次执行步骤 1 自动递增序号，**不会覆盖**已有文件：

| 文件 | 说明 |
|------|------|
| `data/01-wallets.csv` | 地址（步骤 2、3、6 使用） |
| `data/01-wallets-private.csv` | 含私钥（步骤 4、5、7 使用） |
| `data/02-wallets.csv` | 下一批… |

步骤 2–7 **必须**通过 `--csv` 指定要操作的文件。

---

## 3. npm 快捷命令

### 创建钱包

```bash
npm run 01:create-wallets -- --count 3
```

输出示例：

```
Created 3 wallets -> 01-wallets
  public:  data/01-wallets.csv
  private: data/01-wallets-private.csv

Next steps:
  npm run 02:transfer-pga -- --csv data/01-wallets.csv
  npm run 03:transfer-btcd -- --csv data/01-wallets.csv --min-btcd 1 --max-btcd 100
  npm run 04:swap-btcd -- --csv data/01-wallets-private.csv
```

### 完整流程

以 `data/01-wallets.csv` 为例，按顺序执行（步骤 2–7 的 `--csv` 需与步骤 1 生成的批次一致）：

```bash
# 1. 创建 5 个钱包 → data/01-wallets.csv / data/01-wallets-private.csv
npm run 01:create-wallets -- --count 10

# 2. 主钱包向各地址转 PGA 作 gas（默认 0.01，.env 中 PGA_FEE_AMOUNT 可改）
npm run 02:transfer-pga -- --csv data/01-wallets.csv

# 3. 主钱包向各地址分 BTCD（先查余额再分配，全部分完）
npm run 03:transfer-btcd -- --csv data/01-wallets.csv --min-btcd 1 --max-btcd 100

# 4. 各钱包将 BTCD 兑换为 USDT（需 private CSV）
npm run 04:swap-btcd -- --csv data/01-wallets-private.csv 

# 5. 各钱包将 PGP USDT 跨链到 BSC（发完即继续，不等 BSC 到账）
npm run 05:bridge-usdt -- --csv data/01-wallets-private.csv --delay-min 600 --delay-max 700

# 6. 主钱包向各 BSC 地址转 BNB 作 gas（默认 0.0002，.env 中 BNB_FEE_AMOUNT 可改）
npm run 06:transfer-bnb -- --csv data/01-wallets.csv

# 7. 将 BSC 上的 USDT 归集到主钱包（只收 USDT，BNB 留在子钱包）
npm run 07:collect-usdt -- --csv data/01-wallets-private.csv

# 9. 将子钱包剩余 BNB 归集到 COLLECT_ADDRESS / 主钱包（USDT 收完后执行）
npm run 09:collect-bnb -- --csv data/01-wallets-private.csv
```

**钱包间交易间隔**：步骤 2–7 默认每处理完一个钱包后随机等待 **1～3 秒**（`--delay-min` / `--delay-max`）。可调长，例如 bridge 间隔 5～10 秒：

```bash
npm run 05:bridge-usdt -- --csv data/01-wallets-private.csv --delay-min 5 --delay-max 10
```

设为 `--delay-min 0 --delay-max 0` 则不等待。

**可选参数示例**：

```bash
# 步骤 5：轮询 BSC 到账（默认不开启）
npm run 05:bridge-usdt -- --csv data/01-wallets-private.csv --check-bridge

# 步骤 4：只检查余额，不实际 swap
npm run 04:swap-btcd -- --csv data/01-wallets-private.csv --no-swap

# 任意步骤：模拟运行
npm run 03:transfer-btcd -- --csv data/01-wallets.csv --min-btcd 1 --max-btcd 5 --dry-run
```

### FIST 流程（BTCD → FIST → BSC → Pancake USDT）

脚本在 `scripts/fist/`，npm 命令前缀 `fist:`。授权与 swap/bridge 分步执行：

| 步骤 | 命令 | CSV |
|------|------|-----|
| 1 | `fist:01:create-wallets` | — |
| 2 | `fist:02:transfer-pga` | public |
| 3 | `fist:03:transfer-btcd` | public |
| 4 | `fist:04:approve-btcd` | private |
| 5 | `fist:05:swap-btcd-fist` | private |
| 6 | `fist:06:approve-fist` | private |
| 7 | `fist:07:bridge-fist` | private |
| 8 | `fist:08:transfer-bnb` | public |
| 9 | `fist:09:approve-fist-bsc` | private |
| 10 | `fist:10:swap-fist-usdt` | private |
| 11 | `fist:11:collect-usdt` | private |
| 12 | `fist:12:collect-bnb` | private |

```bash
npm run fist:01:create-wallets -- --count 5
npm run fist:02:transfer-pga -- --csv data/01-wallets.csv
npm run fist:03:transfer-btcd -- --csv data/01-wallets.csv --min-btcd 1 --max-btcd 100
npm run fist:04:approve-btcd -- --csv data/01-wallets-private.csv
npm run fist:05:swap-btcd-fist -- --csv data/01-wallets-private.csv --slippage 1
npm run fist:06:approve-fist -- --csv data/01-wallets-private.csv
npm run fist:07:bridge-fist -- --csv data/01-wallets-private.csv --delay-min 600 --delay-max 700
# 等待 BSC FIST 到账后
npm run fist:08:transfer-bnb -- --csv data/01-wallets.csv
npm run fist:09:approve-fist-bsc -- --csv data/01-wallets-private.csv
npm run fist:10:swap-fist-usdt -- --csv data/01-wallets-private.csv --slippage 1
npm run fist:11:collect-usdt -- --csv data/01-wallets-private.csv
npm run fist:12:collect-bnb -- --csv data/01-wallets-private.csv
```

合约：PG BTCD `0xF9BF…Cc6B` → PG FIST `0x800E…4B11`（PGARouterV2 `0x3F67…7bA8`）→ 跨链桥 → BSC FIST `0xc988…bc6a`（6 位小数）→ Pancake V2 USDT。

步骤 4/6/9 仅 approve；若 allowance 已足够会自动 skip。步骤 5/7/10 会在需要时自动 approve。

### PGA 流程（BTCD → USDT on PGP → 跨链 BSC）

与 FIST 类似，授权与 swap/bridge **分步执行**；在 PGP 链上用**兑换合约**直接 BTCD→USDT，再跨链到 BSC（无需 Pancake swap）。npm 命令前缀 `pga:`。

| 步骤 | 命令 | CSV |
|------|------|-----|
| 1 | `pga:01:create-wallets` | — |
| 2 | `pga:02:transfer-pga` | public |
| 3 | `pga:03:transfer-btcd` | public |
| 4 | `pga:04:approve-btcd` | private |
| 5 | `pga:05:swap-btcd-usdt` | private |
| 6 | `pga:06:approve-usdt` | private |
| 7 | `pga:07:bridge-usdt` | private |
| 8 | `pga:08:transfer-bnb` | public |
| 9 | `pga:09:collect-usdt` | private |
| 10 | `pga:10:collect-bnb` | private |

```bash
npm run pga:01:create-wallets -- --count 5
npm run pga:02:transfer-pga -- --csv data/01-wallets.csv
npm run pga:03:transfer-btcd -- --csv data/01-wallets.csv --min-btcd 1 --max-btcd 100
npm run pga:04:approve-btcd -- --csv data/01-wallets-private.csv
npm run pga:05:swap-btcd-usdt -- --csv data/01-wallets-private.csv
npm run pga:06:approve-usdt -- --csv data/01-wallets-private.csv
npm run pga:07:bridge-usdt -- --csv data/01-wallets-private.csv --delay-min 600 --delay-max 700
# 等待 BSC USDT 到账后
npm run pga:08:transfer-bnb -- --csv data/01-wallets.csv
npm run pga:09:collect-usdt -- --csv data/01-wallets-private.csv
npm run pga:10:collect-bnb -- --csv data/01-wallets-private.csv
```

合约：PG BTCD `0xF9BF…Cc6B` → PG USDT `0xdF72…3385`（swap `0xFF60…497F`）→ 跨链桥 → BSC USDT。

步骤 5 会读取合约 fee bps 并显示预估 USDT，执行前需确认。步骤 4/6 仅 approve；步骤 5/7 会在需要时自动 approve。

### 命令一览

| 步骤 | npm 命令 |
|------|----------|
| 1 | `npm run 01:create-wallets -- --count N` |
| 2 | `npm run 02:transfer-pga -- --csv data/NN-wallets.csv` |
| 3 | `npm run 03:transfer-btcd -- --csv data/NN-wallets.csv --min-btcd X --max-btcd Y` |
| 4 | `npm run 04:swap-btcd -- --csv data/NN-wallets-private.csv` |
| 5 | `npm run 05:bridge-usdt -- --csv data/NN-wallets-private.csv` |
| 6 | `npm run 06:transfer-bnb -- --csv data/NN-wallets.csv` |
| 7 | `npm run 07:collect-usdt -- --csv data/NN-wallets-private.csv` |
| 8 | `npm run 08:transfer-pg-usdt -- --csv data/NN-wallets.csv --min-usdt X --max-usdt Y` |
| 9 | `npm run 09:collect-bnb -- --csv data/NN-wallets-private.csv` |

步骤 8 从 `.env` 中 `WALLET_PRIVATE_KEY` 主钱包向 CSV 地址分发 **PGP USDT**：每个钱包在 `[min, max]` 内随机金额；`min === max` 时每人相同。转账前打印分配计划并校验 USDT / PGA 余额。

步骤 9 将各 BSC 子钱包剩余 **BNB** 归集到 `COLLECT_ADDRESS`（未设置则用主钱包地址）。每笔发送 `余额 - gas`，gas 按 21000 预留；可归集金额低于 `--min-bnb`（默认 0.00001）时跳过。建议在步骤 7 收完 USDT 后再执行。

| 模式 | 条件 | 行为 |
|------|------|------|
| normal | 余额 ≥ N×min 且 ≤ N×max | `[min, max]` 随机分配，末位拿剩余 |
| exceed | 余额 > N×max | 前 N-1 各给 max，末位吸收全部剩余 |
| topup | 余额 < N×min，且有地址已持有 BTCD | 只补发给已有 BTCD 的地址 |
| fallback | 余额 < N×min，且无地址持有 BTCD | 放宽 min，分给全部地址 |

`amount=0` 的地址会跳过，不发送交易。

步骤 5 默认与 legacy `bridge.js` 相同：**发完桥接 tx 即继续**，不等待 BSC 到账。如需轮询 BSC 余额，手动加 `--check-bridge`（每钱包最多等 600s，BSC RPC 不通时自动跳过检查）。`.env` 中可设置 `BSC_RPC_URL`。

步骤 6 的 `BNB_FEE_AMOUNT` 是留给各钱包付 gas 的，步骤 7 **只归集 USDT**，BNB 留在钱包里不动。USDT 归集约需 0.0002 BNB（3 gwei × 65000），建议 `BNB_FEE_AMOUNT=0.0002` 以上。步骤 7 会在转账前检测 BNB 是否够 gas，不足时 skip 并提示。收完 USDT 后可用步骤 9 把剩余 BNB 扫回主钱包。

### Dry-run

```bash
npm run 02:transfer-pga -- --csv data/01-wallets.csv --dry-run
npm run 04:swap-btcd -- --csv data/01-wallets-private.csv --no-swap
```

### 通用参数

| 参数 | 说明 | 默认 |
|------|------|------|
| `--csv PATH` | 钱包 CSV 路径（步骤 2–9 必填） | — |
| `--delay-min` / `--delay-max` | 钱包间随机延迟（秒） | 1 / 3 |
| `--dry-run` | 模拟，不发交易 | — |
| `--yes` | 跳过确认（npm 脚本已内置） | — |

---

## 4. Legacy 脚本（从 .env 读钱包）

```bash
npm run swap-legacy
npm run bridge-legacy
```

---

## 5. 安全提示

- `*-private.csv` 含私钥，已加入 `.gitignore`
- 切勿将 `.env` 或私钥 CSV 提交到 git
