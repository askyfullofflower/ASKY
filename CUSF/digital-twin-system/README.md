# 基于数字孪生的档案馆温湿度实时监测与智能调控系统

## 项目概述
本项目由三部分组成：
- 后端服务（FastAPI + WebSocket）：负责环境数据模拟、状态判定、设备联动、异常注入、报警记录、AI 代理。
- PC 端可视化（Three.js）：展示 3D 建筑、房间状态、趋势曲线、云图、报警追溯、AI 面板。
- 微信小程序控制端：移动端查看实时数据、切换自动/手动模式、下发调控与异常测试指令。

## 已实现功能（与当前代码一致）
### 后端（backend/main.py）
- WebSocket 实时广播：默认每 2 秒推送一次传感器与设备状态。
- 环境阈值判定：温度 14-24°C、湿度 45-60%RH（DA/T 15—2023）。
- 异常注入：
  - inject_fire（局部高温）
  - inject_cold（全馆低温）
  - inject_rain（全馆高湿）
  - inject_dry（全馆低湿）
  - inject_outlier（越界样本）
  - inject_gas（PM2.5/NOx 升高）
  - inject_leak（局部渗漏）
  - stop_anomaly（清除异常）
- 设备控制：set_equipment_mode、set_equipment_level、cool_down 等。
- 报警追溯：支持状态更新、CSV 下载导出、本地文件夹导出。
- 存储：支持 MySQL 持久化（未配置则自动回退内存）。
- AI 代理：/api/ai/chat 代理 Longcat 接口。
- 飞书告警：支持通过 FEISHU_WEBHOOK_URL 发送环境告警通知。

### PC 端（pc-client/index.html）
- 3D 建筑可视化与多库房实时状态联动。
- 设备状态监控（自动/手动）与异常注入控制面板。
- 实时微气候趋势图、温湿度场云图、报警记录追溯面板。
- AI 智能中枢（调用后端 /api/ai/chat）。
- 报警记录导出到本地文件夹。

### 微信小程序（miniprogram/pages/index）
- 实时显示温度、湿度、PM2.5、氮氧化物、漏水状态。
- 自动/手动模式切换（带回执确认与超时回滚）。
- 异常注入按钮与清除异常。
- 报警记录刷新与导出。
- WebSocket 多候选地址自动重试与重连。

## 项目结构
```text
digital-twin-system/
├── 3D/                          # 3D 资源目录（如 archivo.glb）
├── backend/
│   ├── main.py                  # FastAPI 主程序
│   └── requirements.txt         # Python 依赖
├── pc-client/
│   ├── index.html               # PC 端可视化页面
│   └── config.js                # 前端 WS/API 地址配置
├── miniprogram/
│   ├── app.json
│   ├── project.config.json
│   ├── project.private.config.json
│   └── pages/index/
│       ├── index.wxml
│       ├── index.js
│       ├── index.wxss
│       └── index.json
├── start-mysql.bat              # Windows 一键启动（MySQL 模式）
└── README.md
```

## 快速启动
### 1. 启动后端
```bash
cd backend
pip install -r requirements.txt
python main.py
```

后端启动后可用地址：
- WebSocket：ws://127.0.0.1:8000/ws
- 报警记录接口：http://127.0.0.1:8000/api/alarm-records?limit=10

说明：`/` 路径会返回前端 HTML，但推荐使用静态服务器方式启动 PC 页面，以确保 `config.js` 同源加载正常。

### 2. 启动 PC 页面（推荐方式）
在项目根目录执行：
```bash
python -m http.server 3000 --directory pc-client
```
然后访问：
- http://127.0.0.1:3000

### 3. Windows 一键启动（后端 + 前端）
```powershell
.\start-mysql.bat
```
脚本行为：
- 自动读取用户环境变量 `MYSQL_URL`。
- 默认启动后端 `:8000` 与静态前端 `:3000`。
- 若端口已占用会跳过对应服务，避免重复启动。

## 运行配置
### PC 端地址配置（pc-client/config.js）
默认读取：
```javascript
window.__DT_CONFIG__ = {
  WS_URL: 'ws://127.0.0.1:8000/ws',
  API_BASE_URL: 'http://127.0.0.1:8000'
};
```
也可通过 URL 参数临时覆盖：
- `?ws=wss://xxx/ws&api=https://xxx`

### MySQL 持久化
```powershell
$env:MYSQL_URL="mysql+pymysql://root:123456@127.0.0.1:3306/digital_twin?charset=utf8mb4"
```
可选：关闭 MySQL，强制用内存
```powershell
$env:MYSQL_ENABLE="0"
```

报警记录本地导出目录（可选）：
```powershell
$env:ALARM_EXPORT_DIR="$env:USERPROFILE\Documents\digital-twin-exports\alarm-records"
```

### AI 代理（Longcat）
```powershell
$env:LONGCAT_API_KEY="你的_longcat_key"
$env:LONGCAT_MODEL="LongCat-Flash-Chat"
$env:LONGCAT_API_URL="https://api.longcat.chat/openai/v1/chat/completions"
```

### 飞书告警（可选）
```powershell
$env:FEISHU_WEBHOOK_URL="你的飞书 webhook 地址"
```

## 微信小程序接入
1. 使用微信开发者工具导入 `miniprogram/` 目录。
2. 在“详情 -> 本地设置”中关闭域名校验（`project.private.config.json` 已设置 `urlCheck=false`）。
3. 不需要手改 `index.js` 里的固定 `wsUrl` 变量（当前代码没有该变量）。
4. 如需指定局域网后端，在开发者工具控制台执行：
   ```javascript
   wx.setStorageSync('backendHost', '192.168.x.x')
   // 或直接指定完整 ws 地址
   wx.setStorageSync('wsUrl', 'ws://192.168.x.x:8000/ws')
   ```
5. 重新编译即可。

## 后端接口一览
| 接口 | 方法 | 说明 |
|---|---|---|
| `/ws` | WebSocket | 实时数据广播与控制指令入口 |
| `/api/alarm-records` | GET | 查询报警记录（支持 `limit`） |
| `/api/alarm-records/{record_id}/status` | POST | 更新报警状态 |
| `/api/alarm-records/export` | GET | 下载报警 CSV |
| `/api/alarm-records/export-local` | GET/POST | 导出报警 CSV 到本地目录 |
| `/api/ai/chat` | POST | Longcat 代理接口 |
| `/` | GET | 返回 PC 页面 HTML |

## 系统通信流程
```text
微信小程序  <----WebSocket---->  FastAPI 后端  <----WebSocket---->  PC 端 3D
   指令上行/状态下行                  状态判定/控制联动                 可视化展示
```

数据流（简化）：
1. 后端定时生成/计算环境数据并广播 `sensor_data`。
2. 前端或小程序发送 `control_command`（如降温、异常注入、设备模式）。
3. 后端更新系统状态并广播 `system_status` / `equipment_status`。
4. PC 与小程序同步刷新页面状态、报警与日志。

## 状态说明（当前实现）
| 状态 | 条件 |
|---|---|
| `normal` | 温度 14-24°C 且湿度 45-60%RH |
| `temp_alert` | 温度 > 24°C |
| `temp_low_alert` | 温度 < 14°C |
| `humidity_alert` | 湿度 > 60%RH |
| `humidity_low_alert` | 湿度 < 45%RH |
| `cooling_active` | 降温指令执行中 |

