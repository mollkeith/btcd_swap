# BTCD 批量工具链

在 Elastos PGP 链上批量管理钱包：**创建地址 → 注资 PGA/BTCD → 兑换 USDT → 跨链 BSC → 注 BNB → 归集**。

## 目录结构

```
btcd-swap/
├── scripts/
│   ├── 01-createWallets.js          # 生成 n 个 EVM 地址（双 CSV）
│   ├── 02-transferPGAFee.js         # 主钱包转 PGA（native gas）
│   ├── 03-transferBTCDToWallets.js  # 主钱包随机分发 BTCD
│   ├── 04-swapBTCDToUSDT.js         # 子钱包 BTCD → USDT
│   ├── 05-bridgeUSDTToBSC.js        # 子钱包 USDT 跨链到 BSC
│   ├── 06-transferBNBFee.js         # 主钱包转 BNB gas
│   ├── 07-collectUSDT.js            # BSC 归集 USDT/BNB 到主钱包
│   └── legacy/
│       ├── swap.js                  # 旧版：从 .env 读钱包批量 swap
│       └── bridge.js                # 旧版：从 .env 读钱包批量 bridge
├── lib/                             # 共享模块
├── data/                            # CSV 输出（gitignore）
├── logs/                            # 执行日志（gitignore）
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

参考交易：

- PGA 转账：[0xbb401471...](https://pgp.elastos.io/tx/0xbb401471a4a20d989b2af55a9d41feb55218618d3ae6d0d69d8e44360db63197)（2 PGA，native）
- BTCD 分发：[0xabd189ce...](https://pgp.elastos.io/tx/0xabd189ced70c6c6ca786f2d240f3a792d4b92370bc1503cab4afc5c5f092d017)（5 BTCD，ERC20 transfer）
- 兑换：[0x1940908b...](https://pgp.elastos.io/tx/0x1940908b2f65dc8e13de95f74149d394f5ce3f16458b3a07863c1b174fa81e8e)
- 跨链：[0x487d643d...](https://pgp.elastos.io/tx/0x487d643dd6c238261c9fc595d1c9102e30215f389f313db65fb872636d506329)

---

## 1. 环境准备

```bash
cp .env.example .env
npm install
```

`.env` 必填：

```bash
WALLET_PRIVATE_KEY=0x...   # 主钱包（注资、归集）
```

可选：

```bash
PGP_RPC_URL=https://api.elastos.io/pg
GAS_PRICE_GWEI=25
BSC_RPC_URL=https://bsc-dataseed.binance.org
BSC_GAS_PRICE_GWEI=3
PGA_FEE_AMOUNT=2
BNB_FEE_AMOUNT=0.002
# COLLECT_ADDRESS=0x...    # 归集目标，默认主钱包地址
```

---

## 2. npm 快捷命令（按序号执行）

| 步骤 | npm 命令 | 说明 |
|------|----------|------|
| 1 | `npm run 01:create-wallets -- --count 10` | 生成 10 个钱包 → `data/wallets.csv` + `data/wallets-private.csv` |
| 2 | `npm run 02:transfer-pga` | 主钱包向 CSV 地址转 PGA（默认 2 PGA/地址） |
| 3 | `npm run 03:transfer-btcd -- --min-btcd 1 --max-btcd 1000` | 随机 BTCD 分发（**必须**指定 min/max） |
| 4 | `npm run 04:swap-btcd` | 子钱包全部 BTCD 兑 USDT |
| 5 | `npm run 05:bridge-usdt` | USDT 跨链到 BSC（含到账轮询） |
| 6 | `npm run 06:transfer-bnb` | 主钱包向 CSV 地址转 BNB gas |
| 7 | `npm run 07:collect-usdt` | BSC 归集 USDT + BNB 到主钱包 |

### 完整流程示例

```bash
npm run 01:create-wallets -- --count 5
npm run 02:transfer-pga
npm run 03:transfer-btcd -- --min-btcd 1 --max-btcd 100
npm run 04:swap-btcd
npm run 05:bridge-usdt
npm run 06:transfer-bnb
npm run 07:collect-usdt
```

### Dry-run / 预览

```bash
# 仅查余额，不 swap
node scripts/04-swapBTCDToUSDT.js --no-swap --csv data/wallets-private.csv

# PGA 预览
node scripts/02-transferPGAFee.js --dry-run --yes --csv data/wallets.csv

# BTCD 预览
node scripts/03-transferBTCDToWallets.js --dry-run --yes --csv data/wallets.csv --min-btcd 1 --max-btcd 5
```

### 通用参数

所有流水线脚本均支持：

| 参数 | 说明 |
|------|------|
| `--csv PATH` | 输入 CSV（地址-only 或含私钥） |
| `--delay-min` / `--delay-max` | 随机延迟（秒） |
| `--dry-run` | 模拟，不发交易 |
| `--yes` | 跳过确认（npm 脚本已默认加 `--yes`） |
| `--gas-price-gwei` | Gas 价格 |

---

## 3. 日志

每处理一个地址，追加一行 JSON 到 `logs/<script>-<timestamp>.log`，结束时写 summary JSON。

```bash
ls logs/
tail -f logs/04-swapBTCDToUSDT-*.log
```

---

## 4. Legacy 脚本（从 .env 读钱包）

适用于直接在 `.env` 配置 `WALLET_PRIVATE_KEY_1/2/...` 的场景，无需 CSV：

```bash
npm run swap-legacy              # BTCD → USDT
npm run swap-legacy-dry-run
npm run bridge-legacy            # USDT → BSC
npm run bridge-legacy-dry-run
```

---

## 5. 故障排查

| 现象 | 处理 |
|------|------|
| `WALLET_PRIVATE_KEY not set` | 检查 `.env` 主钱包私钥 |
| `insufficient PGA for gas` | 主/子钱包 PGA 不足，运行步骤 2 或从 [swap.pgpgas.org](https://swap.pgpgas.org) 获取 |
| `master BTCD insufficient` | 主钱包 BTCD 不足 |
| `BTCD balance below min` | 步骤 3 分发数量太少，或调低 `--min-btcd` |
| BSC 未到账 | 跨链延迟，步骤 5 已含 `--check-bridge` 轮询 |
| `Unknown argument` | 检查 CLI 参数格式 |

---

## 6. 安全提示

- `data/wallets-private.csv` 含私钥，已加入 `.gitignore`
- 切勿将 `.env` 或私钥 CSV 提交到 git
