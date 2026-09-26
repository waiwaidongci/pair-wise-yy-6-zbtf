# 墨锭试磨室

运行：

```bash
npm start
```

访问`http://localhost:3037`。墨锭档案保存在`data/ink-stick-testing.json`。

## 压模放行台

压模登记、补料、复验、放行单独走一套接口，分三个业务文件：

- `press-handler.js`：请求处理。`POST /api/press` 登记、`POST /api/press/:id/refill` 补料、`POST /api/press/:id/inspection` 复验、`GET /api/press?status=待补料` 列表筛选、`GET /api/press/:id` 查单。
- `press-rules.js`：判定规则。缺项、克重偏离目标超3克、压力低于18兆帕转待补料；另一位检查员隔20分钟量两次厚度，差值不超过0.2毫米且边角完整才放行；改模具、压力或加料量让旧放行失效。
- `press-archive.js`：档案存储。数据在`data/press-molding.json`，旧单（含已失效）都留档可查。

约束：一块墨锭同时只能挂一条没完成（待补料/待复验）的压模记录；有未完成记录时该墨锭不能试磨。
