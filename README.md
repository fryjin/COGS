# Dopamine Pricing Web

一个独立、纯前端的套餐售价 / 成本 / 折扣 / 利润计算工具。

## 当前功能

- 固定成本管理：普通产品、组合、规格/备注、单个成本、启用/停用
- 组合成本：维护成份及成份数量，组合单个成本自动按 `Σ(成份成本 × 数量)` 计算，并可继续用于套餐售价计算
- 多套餐：新建、复制、重命名、删除、切换
- 套餐产品：选择固定成本产品、数量、单品标价
- 自动计算：单品成本、成本小计、单品利润、标价小计、商品利润小计
- 动态折扣方案：可新增 / 删除 / 修改多个折扣
- 附加成本：固定金额或售价百分比
- 合计结果：销售总额、商品成本、固定附加成本、售价比例费用、完整成本、套餐利润、毛利率、成本率
- 本地保存：使用浏览器 localStorage；V1 数据会自动迁移到支持组合的 V2 数据结构
- JSON 备份与恢复：用于换浏览器/换设备时手动迁移数据

## 数据说明

这是一个纯静态网页版本，不连接服务器。

Cloudflare Pages 只托管网页代码，业务数据默认保存在当前浏览器的 `localStorage` 中。因此：

- 同一浏览器再次打开会保留已保存数据；
- 换电脑、换浏览器、清理浏览器数据后不会自动同步；
- 建议定期使用“导出备份”保存 JSON；
- 后续如需多设备联网同步，可以再增加 Cloudflare Workers + D1。

## 本地运行

直接打开 `index.html` 即可。

如需模拟 Cloudflare 构建：

```bash
npm run build
```

静态产物会生成到：

```text
dist/
```

## GitHub

建议单独创建仓库，例如：

```text
dopamine-pricing-web
```

将本目录全部文件提交到 `main`。

## Cloudflare Pages 部署

1. 打开 Cloudflare Dashboard → Workers & Pages。
2. Create application → Pages → Import an existing Git repository。
3. 选择对应 GitHub 仓库。
4. Production branch：`main`
5. Framework preset：None
6. Build command：`npm run build`
7. Build output directory：`dist`
8. 保存并部署。

之后每次 push 到 `main`，Cloudflare Pages 会自动重新构建和发布。

## 技术特点

- 无前端框架
- 无运行时 npm 依赖
- 无数据库
- 无服务器
- 无第三方 CDN
- 计算使用固定精度 BigInt，避免常见 JS 浮点金额误差
