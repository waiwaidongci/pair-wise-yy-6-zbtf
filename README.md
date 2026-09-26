# 墨锭车间

运行：

```bash
npm start
```

- 墨锭试磨室：`http://localhost:3037`，数据保存在 `data/ink-stick-testing.json`
- 压模放行台：`http://localhost:3037/press`，档案保存在 `data/press-records.json`

## 压模放行台业务文件

| 文件 | 职责 |
| --- | --- |
| `press/handlers.js` | 请求处理：HTTP 路由、登记/补料/量厚/改参提交、放行台页面，列表可筛待补料、待复验、已放行（另含已失效留档） |
| `press/rules.js` | 判定规则：缺项、加料偏离目标超过 3g、压力低于 18MPa 转待补料；另一位检查员隔二十分钟量两次厚度，差值 ≤ 0.2mm 且边角完整才放行；改模具/压力/加料量判为关键变更 |
| `press/archive.js` | 档案存储：压模单只追加不删除，一块墨锭只允许一条未完成单，旧放行失效后置为「已失效」留档可查 |

未取得有效放行单的墨锭，试磨记录接口（`POST /api/items/:id/action`）会拒绝（409）。
