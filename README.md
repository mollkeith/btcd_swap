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
│   └── legacy/
├── lib/
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

```bash
# 假设生成 data/01-wallets.csv
npm run 01:create-wallets -- --count 5
# 转pga作为gas fee，默认0.01 可以在.env文件中配置
npm run 02:transfer-pga -- --csv data/01-wallets.csv
npm run 03:transfer-btcd -- --csv data/01-wallets.csv --min-btcd 1 --max-btcd 100
npm run 04:swap-btcd -- --csv data/01-wallets-private.csv
npm run 05:bridge-usdt -- --csv data/01-wallets-private.csv
# 转bnb作为gas fee，默认0.0001 可以在.env文件中配置
npm run 06:transfer-bnb -- --csv data/01-wallets.csv
npm run 07:collect-usdt -- --csv data/01-wallets-private.csv
```

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

步骤 3 会先读取主钱包 BTCD 余额及各地址链上 BTCD，**将全部 BTCD 分完**（主钱包零剩余），确认分配计划后再逐笔转账：

| 模式 | 条件 | 行为 |
|------|------|------|
| normal | 余额 ≥ N×min 且 ≤ N×max | `[min, max]` 随机分配，末位拿剩余 |
| exceed | 余额 > N×max | 前 N-1 各给 max，末位吸收全部剩余 |
| topup | 余额 < N×min，且有地址已持有 BTCD | 只补发给已有 BTCD 的地址 |
| fallback | 余额 < N×min，且无地址持有 BTCD | 放宽 min，分给全部地址 |

`amount=0` 的地址会跳过，不发送交易。

步骤 5 跨链成功后 `--check-bridge` 会轮询 BSC USDT 到账（默认 600s）。BSC RPC 不稳定时可设置 `.env` 中的 `BSC_RPC_URL`（脚本会自动尝试多个 fallback）；桥接 tx 成功但 BSC 检查超时不会记为 failed。

### Dry-run

```bash
npm run 02:transfer-pga -- --csv data/01-wallets.csv --dry-run
npm run 04:swap-btcd -- --csv data/01-wallets-private.csv --no-swap
```

### 通用参数

| 参数 | 说明 |
|------|------|
| `--csv PATH` | 钱包 CSV 路径（步骤 2–7 必填） |
| `--delay-min` / `--delay-max` | 随机延迟（秒） |
| `--dry-run` | 模拟，不发交易 |
| `--yes` | 跳过确认 |

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
