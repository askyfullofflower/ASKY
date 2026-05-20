# ============================================================
# 基于数字孪生的档案馆温湿度实时监测与智能调控系统 - 后端服务
# 技术栈: Python + FastAPI + WebSocket
# 功能: 多库房传感器模拟、设备联动、异常注入、AI预测、历史趋势
# ============================================================

import asyncio
import csv
import io
import json
import math
import os
import random
import re
import sys
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional
from urllib import error as urlerror
from urllib import request as urlrequest

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

try:
    from sqlalchemy import create_engine, text
except Exception:
    create_engine = None
    text = None

app = FastAPI(title="档案馆温湿度实时监测与智能调控系统")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# 1. 国标阈值（纸质档案库房 DA/T 15—2023）
# ============================================================
TEMP_MIN, TEMP_MAX = 14.0, 24.0          # °C
HUMIDITY_MIN, HUMIDITY_MAX = 45.0, 60.0   # %RH
TARGET_TEMP = 20.0                        # PID-Fuzzy 靶向温度
TARGET_HUM = 50.0                         # PID-Fuzzy 靶向湿度

# 多参数融合监测阈值（室内档案保存环境建议值）
PM25_MAX = 35.0      # ug/m3
NOX_MAX = 0.10       # mg/m3

# ============================================================
# 1.5 飞书机器人预警配置
# ============================================================
FEISHU_WEBHOOK_URL = os.getenv(
    "FEISHU_WEBHOOK_URL",
    "https://www.feishu.cn/flow/api/trigger-webhook/6625e4b46de55c437c2c88bc89c53386",
)
FEISHU_ALERT_RETRY_SECONDS = 120

LONGCAT_API_URL = os.getenv("LONGCAT_API_URL", "https://api.longcat.chat/openai/v1/chat/completions")
LONGCAT_API_KEY = (
    os.getenv("LONGCAT_API_KEY")
    or os.getenv("LC_KEY")
    or "ak_2FG93y2hl1yw5IX9KY4po0Bn83K5I"
).strip()
LONGCAT_MODEL = os.getenv("LONGCAT_MODEL", "LongCat-Flash-Chat")
LONGCAT_TIMEOUT_SECONDS = 25

feishu_alert_state = {
    "last_signature": None,
    "last_attempt_ts": 0.0,
    "last_success": False,
}

feishu_env_alert_state = {
    "last_signature": None,
    "last_attempt_ts": 0.0,
    "last_success": False,
}

runtime_alert_state = {
    "gas_active": False,
    "leak_active": False,
}

# ============================================================
# 2. 档案库房定义（7 间库房，分布于 F1-F4）
# ============================================================
ARCHIVE_ROOMS: List[dict] = [
    {"id": "档案库房A", "name": "档案库房A", "floor": "F1", "t_off": 0.0,  "h_off": 0.0},
    {"id": "档案库房B", "name": "档案库房B", "floor": "F1", "t_off": 0.3,  "h_off": -1.5},
    {"id": "档案库房C", "name": "档案库房C", "floor": "F2", "t_off": -0.5, "h_off": 2.0},
    {"id": "档案库房D", "name": "档案库房D", "floor": "F2", "t_off": 0.8,  "h_off": -0.8},
    {"id": "档案库房E", "name": "档案库房E", "floor": "F3", "t_off": -0.2, "h_off": 1.5},
    {"id": "档案库房F", "name": "档案库房F", "floor": "F4", "t_off": 0.6,  "h_off": -2.0},
    {"id": "档案库房G", "name": "档案库房G", "floor": "F4", "t_off": -0.4, "h_off": 3.0},
]


def init_archive_room_meta():
    """为档案库房生成随机编号与面积（与其他房间风格接近）。"""
    used_codes = set()
    for room in ARCHIVE_ROOMS:
        while True:
            code = f"{room['floor']}-{random.randint(1, 999):03d}"
            if code not in used_codes:
                used_codes.add(code)
                break
        room["code"] = code
        room["area"] = round(random.uniform(12.0, 30.0), 1)


init_archive_room_meta()

# ============================================================
# 3. 设备状态
# ============================================================
equipment: Dict[str, dict] = {
    "ac":           {"active": False, "mode": "standby", "name": "空调系统",  "power": 0},
    "dehumidifier": {"active": False, "mode": "standby", "name": "除湿机",    "power": 0},
    "humidifier":   {"active": False, "mode": "standby", "name": "加湿器",    "power": 0},
    "ventilation":  {"active": False, "mode": "standby", "name": "通风系统",  "power": 0},
}

POWER_LEVELS: Dict[str, int] = {
    "off": 0,
    "low": 30,
    "medium": 65,
    "high": 100,
}

POWER_LEVEL_ALIASES: Dict[str, str] = {
    "off": "off",
    "close": "off",
    "low": "low",
    "medium": "medium",
    "mid": "medium",
    "midhigh": "medium",
    "medium_high": "medium",
    "high": "high",
}


def pick_discrete_power(err: float, low_th: float, medium_th: float) -> int:
    """按误差阈值离散成三档功率（低/中/高），0 代表关。"""
    if err <= 0:
        return POWER_LEVELS["off"]
    if err <= low_th:
        return POWER_LEVELS["low"]
    if err <= medium_th:
        return POWER_LEVELS["medium"]
    return POWER_LEVELS["high"]

# ============================================================
# 4. 系统状态
# ============================================================
system_state: dict = {
    "control_active": False,
    "action": None,
    "cooling_start_temp": None,
    "cooling_ticks": 0,
    "anomaly": None,            # "high_temp"|"high_humidity"|"fire"|"rain"|"dry"|"cold"|"outlier"|"gas"|"leak"|None
    "anomaly_ticks": 0,
    "anomaly_base_t": None,
    "anomaly_base_h": None,
    "fire_target_room": None,   # 火灾模拟时随机选中的单个库房（room id）
    "leak_target_room": None,   # 漏水模拟时随机选中的单个库房（room id）
    "active_anomaly_alarm_key": None,
}

# ============================================================
# 5. 历史记录缓存（每条 2 min，720 条 ≈ 24 h）
# ============================================================
room_history: Dict[str, deque] = {
    r["id"]: deque(maxlen=720) for r in ARCHIVE_ROOMS
}
global_history: deque = deque(maxlen=720)
recent_trend: deque = deque(maxlen=120)   # 最近 120 tick，用于实时波动曲线

# 报警追溯记录（自动记录时间、地点、原因、处置结果）
ALARM_RECORD_CACHE_MAXLEN = 2000
alarm_records: deque = deque(maxlen=ALARM_RECORD_CACHE_MAXLEN)
active_alarm_index: Dict[str, str] = {}
alarm_seq = 0

ALARM_LEVEL_PRIORITY = {"一般": 1, "较高": 2, "严重": 3}
ALARM_LEVEL_ORDER = ("一般", "较高", "严重")
ALARM_STATUS_ALLOWED = {"active", "processing", "review", "resolved"}
ALARM_ESCALATE_SECONDS = max(60, int(os.getenv("ALARM_ESCALATE_SECONDS", "180")))

MYSQL_ENABLE = os.getenv("MYSQL_ENABLE", "1").strip().lower() not in {"0", "false", "no", "off"}
MYSQL_URL = os.getenv("MYSQL_URL", "").strip()
ALARM_EXPORT_DIR = os.getenv("ALARM_EXPORT_DIR", "").strip()
alarm_db_engine = None
alarm_db_ready = False


def _mask_mysql_url(url: str) -> str:
    return re.sub(r"(://[^:/?#]+:)([^@/]+)(@)", r"\1***\3", url)


def _safe_console_print(message: str):
    try:
        print(message)
    except UnicodeEncodeError:
        encoding = getattr(getattr(sys, "stdout", None), "encoding", None) or "utf-8"
        try:
            safe_message = message.encode(encoding, errors="replace").decode(encoding, errors="replace")
        except Exception:
            safe_message = message.encode("utf-8", errors="replace").decode("utf-8", errors="replace")
        print(safe_message)


def _resolve_alarm_export_dir() -> str:
    # 默认导出到用户指定目录。
    default_dir = r"C:\Users\HP\OneDrive\文档\Archive alarm records export"
    target = ALARM_EXPORT_DIR or default_dir
    return os.path.abspath(os.path.expandvars(os.path.expanduser(target)))


def _db_insert_alarm_record(record: dict) -> bool:
    if not alarm_db_ready or alarm_db_engine is None or text is None:
        return False
    try:
        stmt = text(
            """
            INSERT INTO alarm_records (
                id, alarm_time, location, reason, source,
                level, status, disposal_result, resolved_time, updated_time
            ) VALUES (
                :id, :alarm_time, :location, :reason, :source,
                :level, :status, :disposal_result, :resolved_time, :updated_time
            )
            ON DUPLICATE KEY UPDATE
                alarm_time=VALUES(alarm_time),
                location=VALUES(location),
                reason=VALUES(reason),
                source=VALUES(source),
                level=VALUES(level),
                status=VALUES(status),
                disposal_result=VALUES(disposal_result),
                resolved_time=VALUES(resolved_time),
                updated_time=VALUES(updated_time)
            """
        )
        with alarm_db_engine.begin() as conn:
            conn.execute(stmt, record)
        return True
    except Exception as exc:
        print(f"[MySQL] 报警写入失败: {exc}")
        return False


def _db_update_alarm_record_resolved(record_id: str, dispose_result: str, resolved_time: str) -> Optional[bool]:
    if not alarm_db_ready or alarm_db_engine is None or text is None:
        return None
    try:
        stmt = text(
            """
            UPDATE alarm_records
            SET status='resolved', disposal_result=:disposal_result,
                resolved_time=:resolved_time, updated_time=:updated_time
            WHERE id=:id
            """
        )
        with alarm_db_engine.begin() as conn:
            result = conn.execute(stmt, {
                "id": record_id,
                "disposal_result": dispose_result,
                "resolved_time": resolved_time,
                "updated_time": resolved_time,
            })
        return bool(result.rowcount)
    except Exception as exc:
        print(f"[MySQL] 报警更新失败: {exc}")
        return None


def _db_fetch_recent_alarm_records(limit: int) -> Optional[List[dict]]:
    if not alarm_db_ready or alarm_db_engine is None or text is None:
        return None
    try:
        safe_limit = max(1, int(limit))
        stmt = text(
            """
            SELECT id, alarm_time, location, reason, source,
                   level, status, disposal_result, resolved_time, updated_time
            FROM alarm_records
            ORDER BY alarm_time DESC, id DESC
            LIMIT :limit
            """
        )
        with alarm_db_engine.connect() as conn:
            rows = conn.execute(stmt, {"limit": safe_limit}).mappings().all()
        return [dict(row) for row in rows]
    except Exception as exc:
        print(f"[MySQL] 报警查询失败: {exc}")
        return None


def _db_fetch_alarm_records_for_export() -> Optional[List[dict]]:
    if not alarm_db_ready or alarm_db_engine is None or text is None:
        return None
    try:
        stmt = text(
            """
            SELECT id, alarm_time, location, reason, source,
                   level, status, disposal_result, resolved_time, updated_time
            FROM alarm_records
            ORDER BY alarm_time ASC, id ASC
            """
        )
        with alarm_db_engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        return [dict(row) for row in rows]
    except Exception as exc:
        print(f"[MySQL] 导出数据查询失败: {exc}")
        return None


def _db_count_alarm_records() -> Optional[int]:
    if not alarm_db_ready or alarm_db_engine is None or text is None:
        return None
    try:
        stmt = text("SELECT COUNT(1) AS cnt FROM alarm_records")
        with alarm_db_engine.connect() as conn:
            row = conn.execute(stmt).mappings().first()
        return int((row or {}).get("cnt", 0))
    except Exception as exc:
        print(f"[MySQL] 报警总数查询失败: {exc}")
        return None


def _db_upsert_global_history_record(record: dict) -> bool:
    if not alarm_db_ready or alarm_db_engine is None or text is None:
        return False
    try:
        stmt = text(
            """
            INSERT INTO global_history_records (
                sample_time, temperature, humidity, updated_time
            ) VALUES (
                :sample_time, :temperature, :humidity, :updated_time
            )
            ON DUPLICATE KEY UPDATE
                temperature=VALUES(temperature),
                humidity=VALUES(humidity),
                updated_time=VALUES(updated_time)
            """
        )
        payload = {
            "sample_time": str(record.get("timestamp", "")),
            "temperature": float(record.get("temperature", 0.0)),
            "humidity": float(record.get("humidity", 0.0)),
            "updated_time": str(record.get("timestamp", "")),
        }
        with alarm_db_engine.begin() as conn:
            conn.execute(stmt, payload)
        return True
    except Exception as exc:
        print(f"[MySQL] 全馆历史写入失败: {exc}")
        return False


def _db_upsert_room_history_records(records: List[dict]) -> bool:
    if not alarm_db_ready or alarm_db_engine is None or text is None:
        return False
    if not records:
        return True
    try:
        stmt = text(
            """
            INSERT INTO room_history_records (
                sample_time, room_history_id, room_code,
                temperature, humidity, updated_time
            ) VALUES (
                :sample_time, :room_history_id, :room_code,
                :temperature, :humidity, :updated_time
            )
            ON DUPLICATE KEY UPDATE
                room_code=VALUES(room_code),
                temperature=VALUES(temperature),
                humidity=VALUES(humidity),
                updated_time=VALUES(updated_time)
            """
        )
        with alarm_db_engine.begin() as conn:
            conn.execute(stmt, records)
        return True
    except Exception as exc:
        print(f"[MySQL] 库房历史写入失败: {exc}")
        return False


def _db_fetch_recent_global_history(limit: int) -> Optional[List[dict]]:
    if not alarm_db_ready or alarm_db_engine is None or text is None:
        return None
    try:
        safe_limit = max(1, int(limit))
        stmt = text(
            """
            SELECT sample_time, temperature, humidity
            FROM global_history_records
            ORDER BY sample_time DESC
            LIMIT :limit
            """
        )
        with alarm_db_engine.connect() as conn:
            rows = conn.execute(stmt, {"limit": safe_limit}).mappings().all()

        result = []
        for row in reversed(rows):
            result.append({
                "timestamp": str(row.get("sample_time", "")),
                "temperature": round(float(row.get("temperature", 0.0)), 1),
                "humidity": round(float(row.get("humidity", 0.0)), 1),
            })
        return result
    except Exception as exc:
        print(f"[MySQL] 全馆历史查询失败: {exc}")
        return None


def _db_fetch_recent_room_history(room_history_id: str, limit: int) -> Optional[List[dict]]:
    if not alarm_db_ready or alarm_db_engine is None or text is None:
        return None
    try:
        safe_limit = max(1, int(limit))
        stmt = text(
            """
            SELECT sample_time, temperature, humidity
            FROM room_history_records
            WHERE room_history_id=:room_history_id
            ORDER BY sample_time DESC
            LIMIT :limit
            """
        )
        with alarm_db_engine.connect() as conn:
            rows = conn.execute(stmt, {
                "room_history_id": room_history_id,
                "limit": safe_limit,
            }).mappings().all()

        result = []
        for row in reversed(rows):
            result.append({
                "timestamp": str(row.get("sample_time", "")),
                "temperature": round(float(row.get("temperature", 0.0)), 1),
                "humidity": round(float(row.get("humidity", 0.0)), 1),
            })
        return result
    except Exception as exc:
        print(f"[MySQL] 库房历史查询失败: {exc}")
        return None


def _load_history_cache_from_db(limit: int = 720) -> bool:
    global_rows = _db_fetch_recent_global_history(limit)
    if not global_rows:
        return False

    global_history.clear()
    for item in global_rows:
        global_history.append(item)

    for room in ARCHIVE_ROOMS:
        rid = room["id"]
        rows = _db_fetch_recent_room_history(rid, limit)
        room_history[rid].clear()
        if rows:
            for item in rows:
                room_history[rid].append(item)

    recent_trend.clear()
    for item in global_rows[-60:]:
        recent_trend.append({
            "ts": item["timestamp"],
            "t": item["temperature"],
            "h": item["humidity"],
        })
    return True


def _sync_history_cache_to_db():
    if not alarm_db_ready:
        return

    for item in list(global_history):
        _db_upsert_global_history_record(item)

    room_records = []
    for room in ARCHIVE_ROOMS:
        rid = room["id"]
        room_code = room.get("code", rid)
        for item in list(room_history[rid]):
            room_records.append({
                "sample_time": str(item.get("timestamp", "")),
                "room_history_id": rid,
                "room_code": str(room_code),
                "temperature": float(item.get("temperature", 0.0)),
                "humidity": float(item.get("humidity", 0.0)),
                "updated_time": str(item.get("timestamp", "")),
            })
    _db_upsert_room_history_records(room_records)


def _sync_alarm_seq_from_db():
    global alarm_seq
    rows = _db_fetch_recent_alarm_records(1)
    if not rows:
        return
    latest_id = str(rows[0].get("id", ""))
    m = re.search(r"-(\d+)$", latest_id)
    if not m:
        return
    alarm_seq = max(alarm_seq, int(m.group(1)))


def _reload_alarm_cache_from_db(limit: int = ALARM_RECORD_CACHE_MAXLEN):
    rows = _db_fetch_recent_alarm_records(limit)
    if rows is None:
        return
    alarm_records.clear()
    for item in rows:
        alarm_records.append(dict(item))


def init_alarm_record_store() -> bool:
    global alarm_db_engine, alarm_db_ready
    if not MYSQL_ENABLE:
        print("[MySQL] 已禁用，报警记录使用内存存储")
        return False
    if not MYSQL_URL:
        print("[MySQL] 未配置 MYSQL_URL，报警记录使用内存存储")
        return False
    if create_engine is None or text is None:
        print("[MySQL] 缺少 SQLAlchemy/PyMySQL 依赖，报警记录使用内存存储")
        return False

    try:
        alarm_db_engine = create_engine(
            MYSQL_URL,
            pool_pre_ping=True,
            pool_recycle=1800,
        )
        create_alarm_stmt = text(
            """
            CREATE TABLE IF NOT EXISTS alarm_records (
                id VARCHAR(64) NOT NULL PRIMARY KEY,
                alarm_time VARCHAR(32) NOT NULL,
                location VARCHAR(128) NOT NULL,
                reason VARCHAR(512) NOT NULL,
                source VARCHAR(64) NOT NULL,
                level VARCHAR(32) NOT NULL,
                status VARCHAR(32) NOT NULL,
                disposal_result VARCHAR(512) NOT NULL,
                resolved_time VARCHAR(32) NOT NULL DEFAULT '',
                updated_time VARCHAR(32) NOT NULL,
                INDEX idx_alarm_time (alarm_time),
                INDEX idx_updated_time (updated_time),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """
        )
        create_global_history_stmt = text(
            """
            CREATE TABLE IF NOT EXISTS global_history_records (
                sample_time VARCHAR(32) NOT NULL PRIMARY KEY,
                temperature DOUBLE NOT NULL,
                humidity DOUBLE NOT NULL,
                updated_time VARCHAR(32) NOT NULL,
                INDEX idx_global_updated_time (updated_time)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """
        )
        create_room_history_stmt = text(
            """
            CREATE TABLE IF NOT EXISTS room_history_records (
                sample_time VARCHAR(32) NOT NULL,
                room_history_id VARCHAR(64) NOT NULL,
                room_code VARCHAR(64) NOT NULL,
                temperature DOUBLE NOT NULL,
                humidity DOUBLE NOT NULL,
                updated_time VARCHAR(32) NOT NULL,
                PRIMARY KEY (sample_time, room_history_id),
                INDEX idx_room_history_id_time (room_history_id, sample_time),
                INDEX idx_room_updated_time (updated_time)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """
        )
        with alarm_db_engine.begin() as conn:
            conn.execute(create_alarm_stmt)
            conn.execute(create_global_history_stmt)
            conn.execute(create_room_history_stmt)
        alarm_db_ready = True
        _reload_alarm_cache_from_db(ALARM_RECORD_CACHE_MAXLEN)
        _sync_alarm_seq_from_db()
        print(f"[MySQL] 报警记录存储已启用: {_mask_mysql_url(MYSQL_URL)}")
        return True
    except Exception as exc:
        alarm_db_engine = None
        alarm_db_ready = False
        print(f"[MySQL] 初始化失败，回退到内存存储: {exc}")
        err_msg = str(exc).lower()
        if "cryptography" in err_msg and ("caching_sha2_password" in err_msg or "sha256_password" in err_msg):
            print("[MySQL] 认证插件需要 cryptography，请执行: pip install cryptography")
        return False

# 实时环境多参数监测状态（PM2.5 + 氮氧化物）
AIR_PARAM_META = {
    "pm25": {"label": "PM2.5", "limit": PM25_MAX, "unit": "ug/m3", "digits": 1, "min": 3.0, "cap": 220.0},
    "nox": {"label": "氮氧化物", "limit": NOX_MAX, "unit": "mg/m3", "digits": 3, "min": 0.005, "cap": 1.0},
}

AIR_BASE_TARGETS = {
    "pm25": (12.0, 24.0),
    "nox": (0.02, 0.05),
}

AIR_STEP_LIMITS = {
    "pm25": 2.8,
    "nox": 0.007,
}

air_quality_state = {
    "pm25": 18.0,
    "nox": 0.03,
}

# ============================================================
# 6. 模拟数据源（默认国标内波动；异常数据注入时出现越界样本）
# ============================================================
NORMAL_SIMULATED_DATA: List[dict] = [
    # ---- 正常样本（14~24°C, 45~60%RH）----
    {"temperature": 22.3, "humidity": 55.0},
    {"temperature": 23.1, "humidity": 58.5},
    {"temperature": 23.8, "humidity": 52.0},
    {"temperature": 21.2, "humidity": 54.3},
    {"temperature": 20.8, "humidity": 56.0},
    {"temperature": 22.5, "humidity": 48.2},
    {"temperature": 23.5, "humidity": 51.0},
    {"temperature": 21.5, "humidity": 57.8},
    {"temperature": 22.0, "humidity": 49.8},
    {"temperature": 20.5, "humidity": 52.3},
    {"temperature": 21.8, "humidity": 50.1},
    {"temperature": 23.0, "humidity": 46.8},
    {"temperature": 22.5, "humidity": 50.1},
    {"temperature": 23.0, "humidity": 56.8},
    {"temperature": 21.6, "humidity": 53.5},
    {"temperature": 19.8, "humidity": 47.2},
    {"temperature": 18.9, "humidity": 51.7},
    {"temperature": 20.1, "humidity": 59.2},
    {"temperature": 22.7, "humidity": 45.6},
    {"temperature": 16.4, "humidity": 49.5},
    {"temperature": 17.8, "humidity": 57.1},
    {"temperature": 14.6, "humidity": 46.3},
    {"temperature": 23.4, "humidity": 59.6},
    {"temperature": 18.3, "humidity": 54.8},
    {"temperature": 19.1, "humidity": 45.4},
    {"temperature": 22.2, "humidity": 58.9},
    {"temperature": 16.9, "humidity": 52.0},
    {"temperature": 20.7, "humidity": 47.8},
    {"temperature": 21.4, "humidity": 55.6},
    {"temperature": 15.5, "humidity": 50.3},
    {"temperature": 23.6, "humidity": 48.9},
]

ALERT_SIMULATED_DATA: List[dict] = [
    # ---- 超标样本（用于验证告警链路）----
    {"temperature": 24.8, "humidity": 57.0},
    {"temperature": 25.6, "humidity": 61.5},
    {"temperature": 23.2, "humidity": 62.8},
    {"temperature": 13.6, "humidity": 48.5},
    {"temperature": 14.2, "humidity": 43.8},
    {"temperature": 12.9, "humidity": 41.0},
    {"temperature": 26.3, "humidity": 64.2},
    {"temperature": 15.0, "humidity": 61.2},
    {"temperature": 24.4, "humidity": 44.2},
    {"temperature": 13.3, "humidity": 59.4},
]

# 兼容历史逻辑保留统一池（例如历史索引引用）
SIMULATED_DATA: List[dict] = NORMAL_SIMULATED_DATA + ALERT_SIMULATED_DATA

# 异常数据注入开启后：每 10 条样本中固定 2 条越界（20%）
ALERT_RATIO = 0.20
RATIO_CYCLE = 10
ALERT_SLOT_INDEXES = {2, 7}

# 正常模式下限制每个 tick 的最大变化，避免曲线抖动过大
NORMAL_TEMP_MAX_STEP = 0.4
NORMAL_HUM_MAX_STEP = 1.0
NORMAL_TEMP_JITTER = 0.15
NORMAL_HUM_JITTER = 0.5

data_index = 0
normal_data_index = 0
alert_data_index = 0
sample_tick = 0
latest_base_sample = {"temperature": 22.0, "humidity": 50.0}


def _should_emit_alert_sample(tick: int) -> bool:
    return (tick % RATIO_CYCLE) in ALERT_SLOT_INDEXES


def _limit_step(prev: float, target: float, max_step: float) -> float:
    delta = target - prev
    if delta > max_step:
        return prev + max_step
    if delta < -max_step:
        return prev - max_step
    return target


def _clamp(value: float, lower: float, upper: float) -> float:
    return min(max(value, lower), upper)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _room_name_by_id(room_id: Optional[str]) -> Optional[str]:
    if not room_id:
        return None
    for room in ARCHIVE_ROOMS:
        if room["id"] == room_id:
            return room["name"]
    return None


def simulate_water_leak(anomaly: Optional[str], tick: int) -> dict:
    if anomaly != "leak":
        return {
            "detected": False,
            "risk": int(random.uniform(2, 18)),
            "location": None,
            "status": "normal",
        }

    leak_room_name = _room_name_by_id(system_state.get("leak_target_room")) or "未知区域"
    risk = int(_clamp(45 + tick * 8 + random.uniform(-5, 8), 35, 100))
    detected = risk >= 60
    return {
        "detected": detected,
        "risk": risk,
        "location": leak_room_name,
        "status": "alarm" if detected else "warning",
    }


def simulate_air_quality(anomaly: Optional[str], tick: int, leak_detected: bool) -> dict:
    # 正常态下 PM2.5/NOx 在目标区间平滑波动
    for key, (low, high) in AIR_BASE_TARGETS.items():
        target = random.uniform(low, high)
        jitter = random.uniform(-0.9, 0.9) if key == "pm25" else random.uniform(-0.003, 0.003)
        air_quality_state[key] = _limit_step(air_quality_state[key], target + jitter, AIR_STEP_LIMITS[key])

    if anomaly == "fire":
        air_quality_state["pm25"] += 3.8 + tick * 0.9
        air_quality_state["nox"] += 0.018 + tick * 0.003
    elif anomaly == "dry":
        air_quality_state["pm25"] += 0.8
    elif anomaly == "outlier" and _should_emit_alert_sample(sample_tick):
        air_quality_state["pm25"] += random.uniform(10, 24)
        air_quality_state["nox"] += random.uniform(0.02, 0.06)
    elif anomaly == "gas":
        air_quality_state["pm25"] += 12.0 + tick * 1.1
        air_quality_state["nox"] += 0.03 + tick * 0.006
    elif anomaly == "leak":
        air_quality_state["nox"] += 0.002 + tick * 0.0006

    if leak_detected:
        air_quality_state["pm25"] += 0.5

    rounded = {}
    for key, meta in AIR_PARAM_META.items():
        air_quality_state[key] = _clamp(air_quality_state[key], meta["min"], meta["cap"])
        rounded[key] = round(air_quality_state[key], meta["digits"])

    alerts = []
    for key, meta in AIR_PARAM_META.items():
        val = float(rounded[key])
        if val > float(meta["limit"]):
            alerts.append(f"{meta['label']} {val}{meta['unit']} 超过 {meta['limit']}{meta['unit']}")

    return {
        **rounded,
        "status": "alert" if alerts else "normal",
        "alerts": alerts,
    }


def get_next_sensor_data() -> dict:
    global data_index, normal_data_index, alert_data_index, sample_tick
    global latest_base_sample

    use_alert = system_state.get("anomaly") == "outlier" and _should_emit_alert_sample(sample_tick)

    if use_alert:
        d = ALERT_SIMULATED_DATA[alert_data_index % len(ALERT_SIMULATED_DATA)].copy()
        alert_data_index += 1
        d["temperature"] += random.uniform(-0.2, 0.2)
        d["humidity"] += random.uniform(-0.6, 0.6)
    else:
        d = NORMAL_SIMULATED_DATA[normal_data_index % len(NORMAL_SIMULATED_DATA)].copy()
        normal_data_index += 1
        target_t = d["temperature"] + random.uniform(-NORMAL_TEMP_JITTER, NORMAL_TEMP_JITTER)
        target_h = d["humidity"] + random.uniform(-NORMAL_HUM_JITTER, NORMAL_HUM_JITTER)

        # 正常模式采用平滑限速，防止相邻采样点突跳
        prev_t = float(latest_base_sample["temperature"])
        prev_h = float(latest_base_sample["humidity"])
        d["temperature"] = _limit_step(prev_t, target_t, NORMAL_TEMP_MAX_STEP)
        d["humidity"] = _limit_step(prev_h, target_h, NORMAL_HUM_MAX_STEP)

        # 正常样本强制回到国标范围内，避免随机扰动破坏 80/20 比例
        d["temperature"] = min(max(d["temperature"], TEMP_MIN + 0.1), TEMP_MAX - 0.1)
        d["humidity"] = min(max(d["humidity"], HUMIDITY_MIN + 0.3), HUMIDITY_MAX - 0.3)

    d["temperature"] = round(d["temperature"], 1)
    d["humidity"] = round(d["humidity"], 1)
    latest_base_sample = {"temperature": d["temperature"], "humidity": d["humidity"]}

    sample_tick += 1
    data_index += 1
    return d


# ============================================================
# 7. 状态判断
# ============================================================
def evaluate_status(temp: float, hum: float) -> str:
    if system_state["control_active"]:
        return "cooling_active"
    if temp > TEMP_MAX:
        return "temp_alert"
    if temp < TEMP_MIN:
        return "temp_low_alert"
    if hum > HUMIDITY_MAX:
        return "humidity_alert"
    if hum < HUMIDITY_MIN:
        return "humidity_low_alert"
    return "normal"


def evaluate_room_status(temp: float, hum: float) -> str:
    if temp > TEMP_MAX:
        return "temp_alert"
    if temp < TEMP_MIN:
        return "temp_low_alert"
    if hum > HUMIDITY_MAX:
        return "humidity_alert"
    if hum < HUMIDITY_MIN:
        return "humidity_low_alert"
    return "normal"


def _format_local_time(utc_ts: str) -> str:
    try:
        dt = datetime.strptime(utc_ts, "%Y-%m-%dT%H:%M:%SZ")
        return dt.replace(tzinfo=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _parse_local_time(value: str) -> Optional[datetime]:
    try:
        return datetime.strptime(str(value), "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def _normalize_alarm_status(status: str) -> str:
    val = str(status or "").strip().lower()
    return val if val in ALARM_STATUS_ALLOWED else "active"


def _alarm_level_value(level: str) -> int:
    return ALARM_LEVEL_PRIORITY.get(str(level or ""), 1)


def _is_higher_alarm_level(candidate: str, current: str) -> bool:
    return _alarm_level_value(candidate) > _alarm_level_value(current)


def _next_alarm_level(level: str) -> str:
    value = _alarm_level_value(level)
    for name in ALARM_LEVEL_ORDER:
        if ALARM_LEVEL_PRIORITY[name] > value:
            return name
    return str(level or "严重") if str(level or "").strip() else "严重"


def _threshold_issue_level(item: dict, issue: str) -> str:
    temp = float(item.get("temperature", 0.0))
    hum = float(item.get("humidity", 0.0))

    if issue == "温度偏高":
        delta = max(0.0, temp - TEMP_MAX)
        if delta >= 6:
            return "严重"
        if delta >= 2:
            return "较高"
        return "一般"

    if issue == "温度偏低":
        delta = max(0.0, TEMP_MIN - temp)
        if delta >= 6:
            return "严重"
        if delta >= 2:
            return "较高"
        return "一般"

    if issue == "湿度偏高":
        delta = max(0.0, hum - HUMIDITY_MAX)
        if delta >= 15:
            return "严重"
        if delta >= 8:
            return "较高"
        return "一般"

    if issue == "湿度偏低":
        delta = max(0.0, HUMIDITY_MIN - hum)
        if delta >= 15:
            return "严重"
        if delta >= 8:
            return "较高"
        return "一般"

    return "较高"


def collect_threshold_alert_rooms(rooms_data: List[dict]) -> List[dict]:
    alerts = []
    for room in rooms_data:
        rt = room.get("temperature")
        rh = room.get("humidity")
        if rt is None or rh is None:
            continue

        issues = []
        if rt > TEMP_MAX:
            issues.append("温度偏高")
        elif rt < TEMP_MIN:
            issues.append("温度偏低")

        if rh > HUMIDITY_MAX:
            issues.append("湿度偏高")
        elif rh < HUMIDITY_MIN:
            issues.append("湿度偏低")

        if not issues:
            continue

        alerts.append({
            "name": room.get("name", "未知库房"),
            "id": room.get("id", "--"),
            "temperature": round(float(rt), 1),
            "humidity": round(float(rh), 1),
            "issues": issues,
        })
    return alerts


def _build_alert_signature(alerts: List[dict]) -> str:
    parts = []
    for item in sorted(alerts, key=lambda x: x["name"]):
        parts.append(f"{item['name']}:{'/'.join(item['issues'])}")
    return "|".join(parts)


def _status_text(value: float, low: float, high: float, unit: str) -> str:
    if value > high:
        return f"偏高 +{value - high:.1f}{unit}"
    if value < low:
        return f"偏低 -{low - value:.1f}{unit}"
    return "正常"


def _room_issue_brief(item: dict) -> str:
    parts = []
    temp = float(item["temperature"])
    hum = float(item["humidity"])

    if "温度偏高" in item["issues"]:
        parts.append(f"温+{temp - TEMP_MAX:.1f}°C")
    if "温度偏低" in item["issues"]:
        parts.append(f"温-{TEMP_MIN - temp:.1f}°C")
    if "湿度偏高" in item["issues"]:
        parts.append(f"湿+{hum - HUMIDITY_MAX:.1f}%")
    if "湿度偏低" in item["issues"]:
        parts.append(f"湿-{HUMIDITY_MIN - hum:.1f}%")

    if not parts:
        return "异常"
    return " / ".join(parts)


def _room_severity(item: dict) -> float:
    temp = float(item["temperature"])
    hum = float(item["humidity"])
    return max(
        max(0.0, temp - TEMP_MAX),
        max(0.0, TEMP_MIN - temp),
        max(0.0, hum - HUMIDITY_MAX),
        max(0.0, HUMIDITY_MIN - hum),
    )


def _next_alarm_id() -> str:
    global alarm_seq
    alarm_seq += 1
    return f"ALM-{datetime.now().strftime('%Y%m%d%H%M%S')}-{alarm_seq:04d}"


def _find_alarm_record(record_id: str) -> Optional[dict]:
    for item in alarm_records:
        if item.get("id") == record_id:
            return item
    return None


def _remove_alarm_index_by_record_id(record_id: str):
    stale_keys = [k for k, v in active_alarm_index.items() if v == record_id]
    for key in stale_keys:
        active_alarm_index.pop(key, None)


def _load_alarm_record_from_db(record_id: str) -> Optional[dict]:
    if not alarm_db_ready:
        return None
    rows = _db_fetch_recent_alarm_records(ALARM_RECORD_CACHE_MAXLEN)
    if rows is None:
        return None
    for row in rows:
        if row.get("id") == record_id:
            alarm_records.appendleft(row)
            return row
    return None


def update_alarm_record_status(
    record_id: str,
    status: str,
    alarm_time_utc: str,
    dispose_result: Optional[str] = None,
) -> Optional[dict]:
    record = _find_alarm_record(record_id)
    if record is None:
        record = _load_alarm_record_from_db(record_id)
    if record is None:
        return None

    normalized_status = _normalize_alarm_status(status)
    local_time = _format_local_time(alarm_time_utc)

    if dispose_result:
        record["disposal_result"] = str(dispose_result).strip()
    elif normalized_status == "processing":
        record["disposal_result"] = "人工已受理，处理中"
    elif normalized_status == "review":
        record["disposal_result"] = "已转入复盘"
    elif normalized_status == "resolved":
        record["disposal_result"] = "人工确认已恢复"

    record["status"] = normalized_status
    record["updated_time"] = local_time

    if normalized_status in {"resolved", "review"}:
        if not record.get("resolved_time"):
            record["resolved_time"] = local_time
        _remove_alarm_index_by_record_id(record_id)
    else:
        record["resolved_time"] = ""

    if alarm_db_ready:
        _db_insert_alarm_record(record)

    return dict(record)


def maybe_escalate_unresolved_alarms(alarm_time_utc: str) -> List[dict]:
    now_local = _format_local_time(alarm_time_utc)
    now_dt = _parse_local_time(now_local)
    if now_dt is None:
        return []

    escalated = []
    for alarm_key, record_id in list(active_alarm_index.items()):
        record = _find_alarm_record(record_id)
        if record is None:
            continue

        status = _normalize_alarm_status(record.get("status", "active"))
        if status in {"resolved", "review"}:
            continue

        start_dt = _parse_local_time(record.get("alarm_time", ""))
        if start_dt is None:
            continue

        timeout_seconds = ALARM_ESCALATE_SECONDS if status == "active" else ALARM_ESCALATE_SECONDS * 2
        elapsed = (now_dt - start_dt).total_seconds()
        if elapsed < timeout_seconds:
            continue

        current_level = str(record.get("level") or "一般")
        next_level = _next_alarm_level(current_level)
        if next_level == current_level:
            continue

        record["level"] = next_level
        record["updated_time"] = now_local
        history = str(record.get("disposal_result") or "待处置")
        if f"自动升级为{next_level}" not in history:
            record["disposal_result"] = f"{history} | 持续未恢复，自动升级为{next_level}"

        if alarm_db_ready:
            _db_insert_alarm_record(record)

        escalated.append({
            "id": record.get("id"),
            "key": alarm_key,
            "location": record.get("location", "未知区域"),
            "level": next_level,
        })

    return escalated


def get_recent_alarm_records(limit: int = 120) -> List[dict]:
    safe_limit = max(1, limit)
    if alarm_db_ready:
        rows = _db_fetch_recent_alarm_records(safe_limit)
        if rows is not None:
            return rows
    return [dict(item) for item in list(alarm_records)[:safe_limit]]


def get_alarm_record_total() -> int:
    if alarm_db_ready:
        total = _db_count_alarm_records()
        if total is not None:
            return total
    return len(alarm_records)


def get_recent_global_history_records(limit: int = 360) -> List[dict]:
    safe_limit = max(1, limit)
    if alarm_db_ready:
        rows = _db_fetch_recent_global_history(safe_limit)
        if rows:
            return rows
    return list(global_history)[-safe_limit:]


def get_recent_room_history_records(room_history_id: str, limit: int = 360) -> List[dict]:
    safe_limit = max(1, limit)
    if alarm_db_ready:
        rows = _db_fetch_recent_room_history(room_history_id, safe_limit)
        if rows:
            return rows
    if room_history_id in room_history:
        return list(room_history[room_history_id])[-safe_limit:]
    return []


def open_alarm_record(
    *,
    location: str,
    reason: str,
    source: str,
    alarm_time_utc: str,
    level: str = "一般",
    dispose_result: str = "待处置",
    status: str = "active",
    alarm_key: Optional[str] = None,
) -> dict:
    local_time = _format_local_time(alarm_time_utc)
    record = {
        "id": _next_alarm_id(),
        "alarm_time": local_time,
        "location": location,
        "reason": reason,
        "source": source,
        "level": level,
        "status": status,
        "disposal_result": dispose_result,
        "resolved_time": "",
        "updated_time": local_time,
    }
    alarm_records.appendleft(record)
    if alarm_db_ready:
        _db_insert_alarm_record(record)
    if alarm_key:
        active_alarm_index[alarm_key] = record["id"]
    return record


def resolve_alarm_by_key(alarm_key: str, alarm_time_utc: str, dispose_result: str) -> bool:
    record_id = active_alarm_index.pop(alarm_key, None)
    if not record_id:
        return False

    local_time = _format_local_time(alarm_time_utc)
    updated = False

    record = _find_alarm_record(record_id)
    if not record:
        updated = False
    else:
        record["status"] = "resolved"
        record["disposal_result"] = dispose_result
        record["resolved_time"] = local_time
        record["updated_time"] = local_time
        updated = True

    db_updated = _db_update_alarm_record_resolved(record_id, dispose_result, local_time)
    if db_updated is True:
        updated = True

    return updated


def resolve_active_anomaly_alarm(alarm_time_utc: str, dispose_result: str):
    active_key = system_state.get("active_anomaly_alarm_key")
    if not active_key:
        return
    resolve_alarm_by_key(active_key, alarm_time_utc, dispose_result)
    system_state["active_anomaly_alarm_key"] = None


def raise_anomaly_alarm(
    action: str,
    location: str,
    reason: str,
    alarm_time_utc: str,
    level: str = "较高",
):
    resolve_active_anomaly_alarm(alarm_time_utc, "异常场景切换，已结束上一异常并进入新处置")
    key = f"anomaly:{action}:{int(datetime.now(timezone.utc).timestamp() * 1000)}"
    open_alarm_record(
        location=location,
        reason=reason,
        source="异常注入",
        alarm_time_utc=alarm_time_utc,
        level=level,
        dispose_result="处置中",
        alarm_key=key,
    )
    system_state["active_anomaly_alarm_key"] = key


def _threshold_issue_reason(item: dict, issue: str) -> str:
    temp = float(item["temperature"])
    hum = float(item["humidity"])
    if issue == "温度偏高":
        return f"温度 {temp:.1f}°C 超过上限 {TEMP_MAX:.1f}°C"
    if issue == "温度偏低":
        return f"温度 {temp:.1f}°C 低于下限 {TEMP_MIN:.1f}°C"
    if issue == "湿度偏高":
        return f"湿度 {hum:.1f}%RH 超过上限 {HUMIDITY_MAX:.1f}%RH"
    if issue == "湿度偏低":
        return f"湿度 {hum:.1f}%RH 低于下限 {HUMIDITY_MIN:.1f}%RH"
    return f"参数异常：{issue}"


def sync_threshold_alarm_records(alerts: List[dict], alarm_time_utc: str):
    current_keys = set()
    local_time = _format_local_time(alarm_time_utc)
    for item in alerts:
        location = f"{item.get('name', '未知库房')}({item.get('id', '--')})"
        for issue in item.get("issues", []):
            key = f"threshold:{item.get('name')}:{issue}"
            current_keys.add(key)
            level = _threshold_issue_level(item, issue)
            if key not in active_alarm_index:
                open_alarm_record(
                    location=location,
                    reason=_threshold_issue_reason(item, issue),
                    source="阈值监测",
                    alarm_time_utc=alarm_time_utc,
                    level=level,
                    dispose_result="待处置",
                    alarm_key=key,
                )
            else:
                record_id = active_alarm_index.get(key)
                record = _find_alarm_record(record_id) if record_id else None
                if record and _is_higher_alarm_level(level, record.get("level", "一般")):
                    record["level"] = level
                    record["updated_time"] = local_time
                    record["disposal_result"] = "超限幅度扩大，已自动升级处置等级"
                    if alarm_db_ready:
                        _db_insert_alarm_record(record)

    threshold_keys = [k for k in list(active_alarm_index.keys()) if k.startswith("threshold:")]
    for key in threshold_keys:
        if key not in current_keys:
            resolve_alarm_by_key(key, alarm_time_utc, "智能调控系统已自动处置，指数已恢复至正常范围")


def sync_air_quality_alarm_records(air_quality: dict, alarm_time_utc: str):
    for key, meta in AIR_PARAM_META.items():
        alarm_key = f"air:{key}"
        val = float(air_quality.get(key, 0.0))
        limit = float(meta["limit"])
        if val > limit:
            level = "严重" if val >= limit * 1.5 else "较高"
            if alarm_key not in active_alarm_index:
                open_alarm_record(
                    location="全馆环境监测",
                    reason=f"{meta['label']} {val}{meta['unit']} 超标（阈值 {limit}{meta['unit']}）",
                    source="实时环境多参数监测",
                    alarm_time_utc=alarm_time_utc,
                    level=level,
                    dispose_result="待处置",
                    alarm_key=alarm_key,
                )
            else:
                record_id = active_alarm_index.get(alarm_key)
                record = _find_alarm_record(record_id) if record_id else None
                if record and _is_higher_alarm_level(level, record.get("level", "一般")):
                    record["level"] = level
                    record["updated_time"] = _format_local_time(alarm_time_utc)
                    record["disposal_result"] = "超标持续恶化，已自动升级处置等级"
                    if alarm_db_ready:
                        _db_insert_alarm_record(record)
        else:
            resolve_alarm_by_key(alarm_key, alarm_time_utc, f"{meta['label']} 已恢复正常")


def sync_leak_alarm_record(water_leak: dict, alarm_time_utc: str):
    alarm_key = "leak:detected"
    if water_leak.get("detected"):
        if alarm_key not in active_alarm_index:
            location = water_leak.get("location") or "未知区域"
            risk = int(water_leak.get("risk") or 0)
            open_alarm_record(
                location=location,
                reason=f"漏水检测触发，风险指数 {risk}%",
                source="漏水检测",
                alarm_time_utc=alarm_time_utc,
                level="严重",
                dispose_result="待处置",
                alarm_key=alarm_key,
            )
    else:
        resolve_alarm_by_key(alarm_key, alarm_time_utc, "漏水风险解除，已完成排查")


# Emoji source:
# https://unicode.org/emoji/charts/full-emoji-list.html
ALERT_LEVEL_EMOJI = {
    "严重": "🚨",
    "较高": "⚠️",
    "一般": "🔔",
}
EMOJI_TIME = "🕒"
EMOJI_OVERVIEW = "🌡️"
EMOJI_STATS = "📊"
EMOJI_FOCUS = "🏠"
EMOJI_MORE = "📌"
EMOJI_ADVICE = "🛠️"


def _alert_level(alerts: List[dict]) -> str:
    if not alerts:
        return "一般"
    worst = max(_room_severity(item) for item in alerts)
    if worst >= 8:
        return "严重"
    if worst >= 3 or len(alerts) >= 4:
        return "较高"
    return "一般"


def _alert_level_emoji(level: str) -> str:
    return ALERT_LEVEL_EMOJI.get(level, ALERT_LEVEL_EMOJI["一般"])


def build_feishu_alert_payload(
    avg_temp: float,
    avg_hum: float,
    alerts: List[dict],
    timestamp: str,
) -> dict:
    local_time = _format_local_time(timestamp)
    level = _alert_level(alerts)
    title = f"{_alert_level_emoji(level)} [{level}] 档案馆环境告警 | {len(alerts)}库房超标"

    temp_high = sum(1 for item in alerts if "温度偏高" in item["issues"])
    temp_low = sum(1 for item in alerts if "温度偏低" in item["issues"])
    hum_high = sum(1 for item in alerts if "湿度偏高" in item["issues"])
    hum_low = sum(1 for item in alerts if "湿度偏低" in item["issues"])

    sorted_alerts = sorted(alerts, key=_room_severity, reverse=True)
    focus_count = 4
    focus_items = sorted_alerts[:focus_count]
    remain_items = sorted_alerts[focus_count:]

    lines = [
        f"{EMOJI_TIME} 【告警时间】{local_time}",
        (
            f"{EMOJI_OVERVIEW} 【全馆概览】温度 {avg_temp:.1f}°C({_status_text(avg_temp, TEMP_MIN, TEMP_MAX, '°C')})"
            f" | 湿度 {avg_hum:.1f}%RH({_status_text(avg_hum, HUMIDITY_MIN, HUMIDITY_MAX, '%')})"
        ),
        (
            f"{EMOJI_STATS} 【异常统计】温高 {temp_high} | 温低 {temp_low} | "
            f"湿高 {hum_high} | 湿低 {hum_low}"
        ),
        f"{EMOJI_FOCUS} 【重点库房】",
    ]

    for idx, item in enumerate(focus_items, start=1):
        lines.append(
            f"{idx}. {item['name']}({item['id']}) "
            f"温度：{item['temperature']:.1f}°C 湿度：{item['humidity']:.1f}%RH "
            f"[{_room_issue_brief(item)}]"
        )

    if remain_items:
        remain_names = "、".join(item["name"] for item in remain_items[:6])
        suffix = "" if len(remain_items) <= 6 else " 等"
        lines.append(f"{EMOJI_MORE} 其余 {len(remain_items)} 个：{remain_names}{suffix}")

    lines.append(f"{EMOJI_ADVICE} 【建议】优先处理重点库房，检查空调/除湿设备与门窗密闭状态。")

    content = "\n".join(lines)

    return {
        "msg_type": "text",
        "title": title,
        "content": content,
        "message_title": title,
        "message_content": content,
        "trigger_time": local_time,
        "alert_count": len(alerts),
        "avg_temperature": round(avg_temp, 1),
        "avg_humidity": round(avg_hum, 1),
        "rooms": alerts,
    }


async def trigger_feishu_webhook(payload: dict) -> tuple:
    if not FEISHU_WEBHOOK_URL:
        return False, "Webhook 未配置"

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urlrequest.Request(
        FEISHU_WEBHOOK_URL,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )

    def _do_post():
        with urlrequest.urlopen(req, timeout=8) as resp:
            resp_body = resp.read().decode("utf-8", errors="ignore")
            return resp.getcode(), resp_body

    try:
        code, resp_body = await asyncio.to_thread(_do_post)
        if 200 <= code < 300:
            try:
                parsed = json.loads(resp_body) if resp_body else {}
                # 飞书 flow webhook 常见格式: {"code":0,"msg":"success"}
                if isinstance(parsed, dict) and parsed.get("code", 0) not in (0, "0", None):
                    return False, f"HTTP {code}: {resp_body[:200]}"
            except json.JSONDecodeError:
                pass
            return True, f"HTTP {code}"
        return False, f"HTTP {code}: {resp_body[:200]}"
    except urlerror.HTTPError as exc:
        try:
            err_body = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            err_body = str(exc)
        return False, f"HTTP {exc.code}: {err_body[:200]}"
    except Exception as exc:
        return False, str(exc)


async def notify_feishu_threshold_alerts(
    avg_temp: float,
    avg_hum: float,
    rooms_data: List[dict],
    timestamp: str,
    alerts: Optional[List[dict]] = None,
):
    if alerts is None:
        alerts = collect_threshold_alert_rooms(rooms_data)
    if not alerts:
        feishu_alert_state.update(
            last_signature=None,
            last_attempt_ts=0.0,
            last_success=False,
        )
        return

    signature = _build_alert_signature(alerts)
    now_ts = datetime.now(timezone.utc).timestamp()

    if signature == feishu_alert_state["last_signature"]:
        if feishu_alert_state["last_success"]:
            return
        if now_ts - float(feishu_alert_state["last_attempt_ts"]) < FEISHU_ALERT_RETRY_SECONDS:
            return

    feishu_alert_state["last_signature"] = signature
    feishu_alert_state["last_attempt_ts"] = now_ts

    payload = build_feishu_alert_payload(avg_temp, avg_hum, alerts, timestamp)
    ok, result = await trigger_feishu_webhook(payload)
    feishu_alert_state["last_success"] = ok

    title = payload["title"]
    if ok:
        action = "feishu_alert"
        system_msg = f"{title}，飞书Webhook已触发"
    else:
        action = "feishu_alert_failed"
        short_result = result if len(result) <= 120 else result[:117] + "..."
        system_msg = f"{title}，飞书Webhook触发失败：{short_result}"

    _safe_console_print(f"[飞书告警] {system_msg}")
    await manager.broadcast(json.dumps({
        "type": "system_status",
        "control_active": system_state["control_active"],
        "action": action,
        "message": system_msg,
    }, ensure_ascii=False))


def get_air_alert_labels(air_quality: dict) -> List[str]:
    labels = []
    if not isinstance(air_quality, dict):
        return labels
    for key, meta in AIR_PARAM_META.items():
        try:
            val = float(air_quality.get(key, 0.0))
        except (TypeError, ValueError):
            continue
        if val > float(meta["limit"]):
            labels.append(meta["label"])
    return labels


def build_environment_alert_signature(air_quality: dict, water_leak: dict) -> str:
    gas_labels = sorted(get_air_alert_labels(air_quality))
    leak_detected = bool((water_leak or {}).get("detected"))
    leak_location = (water_leak or {}).get("location") or "未知区域"

    parts = []
    if gas_labels:
        parts.append("gas:" + ",".join(gas_labels))
    if leak_detected:
        parts.append(f"leak:{leak_location}")
    return "|".join(parts)


def build_feishu_environment_alert_payload(
    air_quality: dict,
    water_leak: dict,
    timestamp: str,
) -> dict:
    local_time = _format_local_time(timestamp)
    gas_labels = get_air_alert_labels(air_quality)
    leak_detected = bool((water_leak or {}).get("detected"))
    leak_location = (water_leak or {}).get("location") or "未知区域"
    leak_risk = int((water_leak or {}).get("risk") or 0)

    level = "严重" if leak_detected else "较高"
    modules = []
    if gas_labels:
        modules.append("有害气体")
    if leak_detected:
        modules.append("漏水")
    if not modules:
        modules.append("环境异常")

    title = f"{_alert_level_emoji(level)} [{level}] 档案馆环境安全告警 | {'+'.join(modules)}"

    pm25 = float(air_quality.get("pm25", 0.0)) if isinstance(air_quality, dict) else 0.0
    nox = float(air_quality.get("nox", 0.0)) if isinstance(air_quality, dict) else 0.0

    lines = [
        f"{EMOJI_TIME} 【告警时间】{local_time}",
        (
            f"{EMOJI_OVERVIEW} 【参数概览】PM2.5 {pm25:.1f}ug/m3(阈值 {PM25_MAX:.1f})"
            f" | 氮氧化物 {nox:.3f}mg/m3(阈值 {NOX_MAX:.3f})"
        ),
    ]

    if gas_labels:
        lines.append(f"{EMOJI_STATS} 【有害气体异常】{', '.join(gas_labels)} 超标")
    if leak_detected:
        lines.append(f"{EMOJI_FOCUS} 【漏水异常】{leak_location}，风险指数 {leak_risk}%")

    lines.append(f"{EMOJI_ADVICE} 【建议】立即执行应急处置流程并复核现场传感器状态。")
    content = "\n".join(lines)

    return {
        "msg_type": "text",
        "title": title,
        "content": content,
        "message_title": title,
        "message_content": content,
        "trigger_time": local_time,
        "alert_modules": modules,
    }


async def notify_feishu_environment_alerts(
    air_quality: dict,
    water_leak: dict,
    timestamp: str,
):
    signature = build_environment_alert_signature(air_quality, water_leak)
    if not signature:
        feishu_env_alert_state.update(
            last_signature=None,
            last_attempt_ts=0.0,
            last_success=False,
        )
        return

    now_ts = datetime.now(timezone.utc).timestamp()
    if signature == feishu_env_alert_state["last_signature"]:
        if feishu_env_alert_state["last_success"]:
            return
        if now_ts - float(feishu_env_alert_state["last_attempt_ts"]) < FEISHU_ALERT_RETRY_SECONDS:
            return

    feishu_env_alert_state["last_signature"] = signature
    feishu_env_alert_state["last_attempt_ts"] = now_ts

    payload = build_feishu_environment_alert_payload(air_quality, water_leak, timestamp)
    ok, result = await trigger_feishu_webhook(payload)
    feishu_env_alert_state["last_success"] = ok

    title = payload["title"]
    if ok:
        action = "feishu_env_alert"
        system_msg = f"{title}，飞书Webhook已触发"
    else:
        action = "feishu_env_alert_failed"
        short_result = result if len(result) <= 120 else result[:117] + "..."
        system_msg = f"{title}，飞书Webhook触发失败：{short_result}"

    _safe_console_print(f"[飞书告警] {system_msg}")
    await manager.broadcast(json.dumps({
        "type": "system_status",
        "control_active": system_state["control_active"],
        "action": action,
        "message": system_msg,
    }, ensure_ascii=False))


async def sync_environment_system_logs(air_quality: dict, water_leak: dict):
    gas_labels = get_air_alert_labels(air_quality)
    gas_active = bool(gas_labels)
    leak_active = bool((water_leak or {}).get("detected"))

    if gas_active and not runtime_alert_state["gas_active"]:
        await manager.broadcast(json.dumps({
            "type": "system_status",
            "control_active": system_state["control_active"],
            "action": "gas_alert",
            "message": f"☣ 有害气体异常告警：{', '.join(gas_labels)} 超标",
        }, ensure_ascii=False))
    elif (not gas_active) and runtime_alert_state["gas_active"]:
        await manager.broadcast(json.dumps({
            "type": "system_status",
            "control_active": system_state["control_active"],
            "action": "gas_alert_resolved",
            "message": "有害气体告警已解除，PM2.5/氮氧化物恢复正常",
        }, ensure_ascii=False))

    if leak_active and not runtime_alert_state["leak_active"]:
        leak_loc = (water_leak or {}).get("location") or "未知区域"
        leak_risk = int((water_leak or {}).get("risk") or 0)
        await manager.broadcast(json.dumps({
            "type": "system_status",
            "control_active": system_state["control_active"],
            "action": "leak_alert",
            "message": f"💧 漏水检测告警：{leak_loc}，风险指数 {leak_risk}%",
        }, ensure_ascii=False))
    elif (not leak_active) and runtime_alert_state["leak_active"]:
        await manager.broadcast(json.dumps({
            "type": "system_status",
            "control_active": system_state["control_active"],
            "action": "leak_alert_resolved",
            "message": "漏水告警已解除，系统已完成恢复确认",
        }, ensure_ascii=False))

    runtime_alert_state["gas_active"] = gas_active
    runtime_alert_state["leak_active"] = leak_active


# ============================================================
# 8. 设备自动联动
# ============================================================
def auto_equipment(avg_t: float, avg_h: float) -> bool:
    """PID-Fuzzy 智能调控算法 — 根据偏差自适应调节设备功率。"""
    changed = False
    eq = equipment
    t_error = avg_t - TARGET_TEMP          # 温度偏差
    h_error = avg_h - TARGET_HUM           # 湿度偏差

    # ---- 空调 PID-Fuzzy ----
    if eq["ac"]["mode"] != "manual":
        if abs(t_error) > 0.5:
            kp = 25 if abs(t_error) > 3 else 15  # 模糊 Kp
            power = min(100, max(0, int(abs(t_error) * kp)))
            mode_new = "cooling" if t_error > 0 else "heating"
            eq["ac"].update(active=True, mode=mode_new, power=power)
            changed = True
        elif eq["ac"]["active"]:
            eq["ac"].update(active=False, mode="standby", power=0)
            changed = True

    # ---- 除湿机 PID-Fuzzy ----
    if eq["dehumidifier"]["mode"] != "manual":
        if h_error > 2.0:
            kp = 10 if h_error > 10 else 5
            power = min(100, max(0, int(h_error * kp)))
            eq["dehumidifier"].update(
                active=True, mode="dehumidifying", power=power)
            changed = True
        elif eq["dehumidifier"]["active"]:
            eq["dehumidifier"].update(active=False, mode="standby", power=0)
            changed = True

    # ---- 加湿器 PID-Fuzzy ----
    if eq["humidifier"]["mode"] != "manual":
        if h_error < -2.0:
            kp = 10 if abs(h_error) > 10 else 5
            power = min(100, max(0, int(abs(h_error) * kp)))
            eq["humidifier"].update(
                active=True, mode="humidifying", power=power)
            changed = True
        elif eq["humidifier"]["active"]:
            eq["humidifier"].update(active=False, mode="standby", power=0)
            changed = True

    # ---- 通风系统：协同调控 ----
    if eq["ventilation"]["mode"] != "manual":
        main_power = max(eq["ac"]["power"],
                         eq["dehumidifier"]["power"],
                         eq["humidifier"]["power"])
        if main_power > 50:
            vent_power = 80
        elif abs(t_error) > 0.3 or abs(h_error) > 1.0:
            vent_power = 30
        else:
            vent_power = 0
        if vent_power > 0:
            eq["ventilation"].update(
                active=True, mode="ventilating", power=vent_power)
        else:
            eq["ventilation"].update(active=False, mode="standby", power=0)
        changed = True

    return changed


def apply_equipment_effect(temp: float, hum: float) -> tuple:
    """根据设备功率对温湿度施加渐进调节效果（PID 连续输出）。"""
    eq = equipment
    # 空调：最大 0.8°C/tick
    if eq["ac"]["active"] and eq["ac"]["mode"] in ("cooling", "manual"):
        rate = eq["ac"]["power"] / 100.0 * 0.8
        temp = max(round(temp - rate, 1), TARGET_TEMP - 2)
    elif eq["ac"]["active"] and eq["ac"]["mode"] == "heating":
        rate = eq["ac"]["power"] / 100.0 * 0.8
        temp = min(round(temp + rate, 1), TARGET_TEMP + 2)
    # 除湿：最大 1.5%RH/tick
    if eq["dehumidifier"]["active"] and eq["dehumidifier"]["mode"] in ("dehumidifying", "manual"):
        rate = eq["dehumidifier"]["power"] / 100.0 * 1.5
        hum = max(round(hum - rate, 1), TARGET_HUM)
    # 加湿：最大 1.5%RH/tick
    if eq["humidifier"]["active"] and eq["humidifier"]["mode"] in ("humidifying", "manual"):
        rate = eq["humidifier"]["power"] / 100.0 * 1.5
        hum = min(round(hum + rate, 1), TARGET_HUM)
    # 通风：轻微纠偏
    if eq["ventilation"]["active"] and eq["ventilation"]["mode"] in ("ventilating", "manual"):
        r = eq["ventilation"]["power"] / 100.0
        if temp > TARGET_TEMP:
            temp = round(temp - 0.05 * r, 1)
        elif temp < TARGET_TEMP:
            temp = round(temp + 0.05 * r, 1)
        if hum > TARGET_HUM:
            hum = round(hum - 0.1 * r, 1)
        elif hum < TARGET_HUM:
            hum = round(hum + 0.1 * r, 1)
    return temp, hum


# ============================================================
# 9. AI 预测（模拟）
# ============================================================
def make_prediction(temp: float, hum: float) -> dict:
    tn = random.uniform(-0.3, 0.3)
    hn = random.uniform(-1.0, 1.0)
    if system_state["anomaly"] == "high_temp":
        tt, nt = "rising", min(temp + 1.2 + tn, 30.0)
    elif system_state["control_active"]:
        tt, nt = "falling", max(temp - 0.8 + tn, 18.0)
    else:
        tt, nt = "stable", temp + tn
    if system_state["anomaly"] == "high_humidity":
        ht, nh = "rising", min(hum + 2.5 + hn, 80.0)
    elif system_state["anomaly"] == "dry":
        ht, nh = "falling", max(hum - 2.5 + hn, 20.0)
    elif equipment["dehumidifier"]["active"]:
        ht, nh = "falling", max(hum - 1.5 + hn, 40.0)
    else:
        ht, nh = "stable", hum + hn
    return {
        "temp_trend": tt,
        "humidity_trend": ht,
        "next_hour_temp": round(nt, 1),
        "next_hour_humidity": round(nh, 1),
        "confidence": round(random.uniform(0.78, 0.95), 2),
    }


# ============================================================
# 10. 预填充 24 小时历史数据
# ============================================================
def prefill_history():
    now = datetime.now(timezone.utc)
    for i in range(720, 0, -1):
        ts = now - timedelta(minutes=i * 2)
        t = 21.5 + 2.0 * math.sin(i * 0.02) + random.uniform(-0.5, 0.5)
        h = 52.0 + 5.0 * math.sin(i * 0.015 + 1.0) + random.uniform(-1.5, 1.5)
        entry = {
            "timestamp": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "temperature": round(t, 1),
            "humidity": round(h, 1),
        }
        global_history.append(entry)
        for room in ARCHIVE_ROOMS:
            rt = round(t + room["t_off"] + random.uniform(-0.2, 0.2), 1)
            rh = round(h + room["h_off"] + random.uniform(-0.5, 0.5), 1)
            room_history[room["id"]].append({
                "timestamp": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "temperature": rt,
                "humidity": rh,
            })


# ============================================================
# 11. WebSocket 连接管理器
# ============================================================
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active_connections.append(ws)
        print(f"[连接] 新客户端，当前连接数: {len(self.active_connections)}")

    def disconnect(self, ws: WebSocket):
        if ws in self.active_connections:
            self.active_connections.remove(ws)
        print(f"[断开] 当前连接数: {len(self.active_connections)}")

    async def broadcast(self, msg: str):
        dead = []
        for c in self.active_connections:
            try:
                await c.send_text(msg)
            except Exception:
                dead.append(c)
        for c in dead:
            self.disconnect(c)


manager = ConnectionManager()


# ============================================================
# 12. 数据广播协程（每 1 秒）
# ============================================================
async def broadcast_sensor_data():
    if not manager.active_connections:
        return
    raw = get_next_sensor_data()
    temp, hum = raw["temperature"], raw["humidity"]

    # ---- 异常注入（fire / rain / dry / cold / high_temp / high_humidity / outlier / gas / leak）----
    anomaly = system_state["anomaly"]
    if anomaly:
        system_state["anomaly_ticks"] += 1
        tk = system_state["anomaly_ticks"]
        if anomaly == "high_temp" and system_state["anomaly_base_t"] is not None:
            temp = min(system_state["anomaly_base_t"] + tk * 0.5, 28.0)
        elif anomaly == "high_humidity" and system_state["anomaly_base_h"] is not None:
            hum = min(system_state["anomaly_base_h"] + tk * 1.5, 75.0)
        elif anomaly == "fire":
            # 全馆仅轻微扰动，显著升温在目标库房中处理
            temp = min(temp + tk * 0.1, 24.0)
            hum = max(hum - tk * 0.2, 35.0)
        elif anomaly == "rain":
            hum += tk * 1.8       # 梅雨：湿度急升
            hum = min(hum, 90.0)
        elif anomaly == "dry":
            hum -= tk * 1.8       # 干燥：湿度急降
            hum = max(hum, 10.0)
        elif anomaly == "cold":
            temp -= tk * 1.0      # 寒潮：温度急降
            temp = max(temp, 2.0)
        elif anomaly == "outlier":
            # 越界样本在 get_next_sensor_data 中按比例产生
            pass
        elif anomaly == "gas":
            # 有害气体注入：PM2.5/NOx 同步升高
            temp = min(temp + tk * 0.06, 26.0)
            hum = max(hum - tk * 0.12, 30.0)
        elif anomaly == "leak":
            # 漏水：局部渗漏导致湿度快速上升，并伴随轻微降温
            hum = min(hum + tk * 2.2, 95.0)
            temp = max(temp - tk * 0.15, 8.0)

    # ---- 降温模拟 ----
    if system_state["control_active"] \
            and system_state["action"] == "cool_down":
        system_state["cooling_ticks"] += 1
        if system_state["cooling_start_temp"] is not None:
            temp = system_state["cooling_start_temp"] \
                - system_state["cooling_ticks"] * 0.5
        if temp <= 22.0:
            temp = 22.0
            system_state.update(
                control_active=False, action=None,
                cooling_start_temp=None, cooling_ticks=0)
            done = json.dumps({
                "type": "system_status",
                "control_active": False,
                "action": "cool_down",
                "message": "降温完成，系统已恢复正常",
            }, ensure_ascii=False)
            await manager.broadcast(done)

    # ---- PID-Fuzzy 智能调控 ----
    auto_equipment(temp, hum)
    temp, hum = apply_equipment_effect(temp, hum)

    temp = round(temp, 1)
    hum = round(hum, 1)
    status = evaluate_status(temp, hum)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tick = int(system_state.get("anomaly_ticks") or 0) if anomaly else 0
    water_leak = simulate_water_leak(anomaly, tick)
    air_quality = simulate_air_quality(anomaly, tick, bool(water_leak.get("detected")))

    # 各库房数据（火灾局部差异化）
    rooms_data = []
    floor_stats = {}   # {F1: {t_sum, h_sum, cnt}, ...}
    for room in ARCHIVE_ROOMS:
        room_t_jitter = random.uniform(-0.2, 0.2)
        room_h_jitter = random.uniform(-0.5, 0.5)
        if anomaly is None:
            room_t_jitter = random.uniform(-0.1, 0.1)
            room_h_jitter = random.uniform(-0.3, 0.3)

        rt = round(temp + room["t_off"] + room_t_jitter, 1)
        rh = round(hum + room["h_off"] + room_h_jitter, 1)
        # 火灾局部加热：仅随机一个目标库房显著升温
        if anomaly == "fire":
            if room["id"] == system_state.get("fire_target_room"):
                rt = round(rt + system_state["anomaly_ticks"] * 1.2 + random.uniform(0.6, 1.2), 1)
            else:
                # 非目标库房保持在国标上限以下，体现“局部高温”
                rt = min(rt, TEMP_MAX - 0.2)
        elif anomaly == "leak":
            if room["id"] == system_state.get("leak_target_room"):
                rh = min(rh + system_state["anomaly_ticks"] * 2.4 + random.uniform(0.8, 1.8), 98.0)
                rt = max(rt - random.uniform(0.2, 0.6), TEMP_MIN - 5.0)
            else:
                rh = min(rh + random.uniform(0.2, 0.8), 90.0)

        # 无异常注入时，库房数据强制保持在国标范围内波动
        # 这样系统启动默认稳定，且“清除所有异常”后可立即回归正常区间
        if anomaly is None:
            rt = min(max(rt, TEMP_MIN + 0.1), TEMP_MAX - 0.1)
            rh = min(max(rh, HUMIDITY_MIN + 0.3), HUMIDITY_MAX - 0.3)

        rt = round(rt, 1)
        rh = round(rh, 1)
        rs = evaluate_room_status(rt, rh)
        rooms_data.append({
            "id": room.get("code", room["id"]),
            "history_id": room["id"],
            "name": room["name"],
            "floor": room["floor"],
            "area": room.get("area"),
            "temperature": rt, "humidity": rh, "status": rs,
        })
        room_history[room["id"]].append({
            "timestamp": ts,
            "temperature": rt,
            "humidity": rh,
        })
        # 楼层统计累加
        fl = room["floor"]
        if fl not in floor_stats:
            floor_stats[fl] = {"t_sum": 0, "h_sum": 0, "cnt": 0,
                               "alerts": 0}
        floor_stats[fl]["t_sum"] += rt
        floor_stats[fl]["h_sum"] += rh
        floor_stats[fl]["cnt"] += 1
        if rs != "normal":
            floor_stats[fl]["alerts"] += 1

    # 楼层统计
    floor_summary = {}
    for fl, s in floor_stats.items():
        floor_summary[fl] = {
            "avg_temp": round(s["t_sum"] / s["cnt"], 1),
            "avg_hum": round(s["h_sum"] / s["cnt"], 1),
            "room_count": s["cnt"],
            "alert_count": s["alerts"],
        }

    threshold_alerts = collect_threshold_alert_rooms(rooms_data)
    sync_threshold_alarm_records(threshold_alerts, ts)
    sync_air_quality_alarm_records(air_quality, ts)
    sync_leak_alarm_record(water_leak, ts)
    escalated_records = maybe_escalate_unresolved_alarms(ts)
    if escalated_records:
        preview = "、".join(
            [f"{item.get('location', '未知区域')}({item.get('level', '较高')})" for item in escalated_records[:3]]
        )
        await manager.broadcast(json.dumps({
            "type": "system_status",
            "status": "threshold_alarm",
            "time": _format_local_time(ts),
            "message": f"告警处置超时，已自动升级：{preview}",
            "severity": "high",
        }, ensure_ascii=False))
    await sync_environment_system_logs(air_quality, water_leak)

    # 温湿度超标时触发飞书Webhook，并同步写入系统日志
    await notify_feishu_threshold_alerts(temp, hum, rooms_data, ts, threshold_alerts)
    await notify_feishu_environment_alerts(air_quality, water_leak, ts)

    global_history.append({
        "timestamp": ts,
        "temperature": temp,
        "humidity": hum,
    })

    if alarm_db_ready:
        _db_upsert_global_history_record({
            "timestamp": ts,
            "temperature": temp,
            "humidity": hum,
        })
        _db_upsert_room_history_records([
            {
                "sample_time": ts,
                "room_history_id": room.get("history_id", ""),
                "room_code": str(room.get("id", "")),
                "temperature": float(room.get("temperature", 0.0)),
                "humidity": float(room.get("humidity", 0.0)),
                "updated_time": ts,
            }
            for room in rooms_data
        ])

    # 实时波动趋势
    recent_trend.append({
        "ts": ts,
        "t": temp,
        "h": hum,
    })

    pred = make_prediction(temp, hum)

    msg = json.dumps({
        "type": "sensor_data",
        "temperature": temp,
        "humidity": hum,
        "status": status,
        "timestamp": ts,
        "rooms": rooms_data,
        "equipment": equipment,
        "air_quality": air_quality,
        "water_leak": water_leak,
        "alarm_records": get_recent_alarm_records(120),
        "prediction": pred,
        "floor_stats": floor_summary,
        "recent_trend": list(recent_trend),
    }, ensure_ascii=False)
    await manager.broadcast(msg)

async def broadcast_loop():
    while True:
        await asyncio.sleep(1)
        await broadcast_sensor_data()


# ============================================================
# 13. WebSocket 端点
# ============================================================
@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # 连接后发送初始历史 + 设备状态
        init = json.dumps({
            "type": "init_history",
            "global_history": get_recent_global_history_records(360),
            "equipment": equipment,
            "alarm_records": get_recent_alarm_records(120),
        }, ensure_ascii=False)
        await websocket.send_text(init)

        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if data.get("type") != "control_command":
                continue

            action = data.get("action", "")
            event_ts = _utc_now_iso()

            if action == "cool_down":
                resolve_active_anomaly_alarm(event_ts, "异常场景已终止，系统切换为降温处置")
                system_state.update(
                    control_active=True, action="cool_down",
                    cooling_ticks=0, anomaly=None,
                    anomaly_ticks=0, anomaly_base_t=None,
                    anomaly_base_h=None, fire_target_room=None,
                    leak_target_room=None)
                cur = latest_base_sample
                system_state["cooling_start_temp"] = cur["temperature"]
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": True,
                    "action": "cool_down",
                    "message": "降温指令已激活，系统正在降温",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "inject_high_temp":
                system_state.update(
                    anomaly="high_temp", anomaly_ticks=0,
                    control_active=False, action=None,
                    fire_target_room=None, leak_target_room=None)
                cur = latest_base_sample
                system_state["anomaly_base_t"] = cur["temperature"]
                raise_anomaly_alarm(
                    action="inject_high_temp",
                    location="全馆",
                    reason="高温异常注入，模拟夏季极端高温工况",
                    alarm_time_utc=event_ts,
                    level="较高",
                )
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": False,
                    "action": "inject_high_temp",
                    "message": "⚠ 高温异常注入已启动 — 模拟夏季极端高温",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "inject_high_humidity":
                system_state.update(
                    anomaly="high_humidity", anomaly_ticks=0,
                    control_active=False, action=None,
                    fire_target_room=None, leak_target_room=None)
                cur = latest_base_sample
                system_state["anomaly_base_h"] = cur["humidity"]
                raise_anomaly_alarm(
                    action="inject_high_humidity",
                    location="全馆",
                    reason="高湿异常注入，模拟梅雨季持续高湿工况",
                    alarm_time_utc=event_ts,
                    level="较高",
                )
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": False,
                    "action": "inject_high_humidity",
                    "message": "⚠ 高湿异常注入已启动 — 模拟梅雨季节",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "stop_anomaly":
                resolve_active_anomaly_alarm(event_ts, "已人工清除异常并完成初步处置")
                system_state.update(
                    anomaly=None, anomaly_ticks=0,
                    anomaly_base_t=None, anomaly_base_h=None,
                    fire_target_room=None, leak_target_room=None)
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": False,
                    "action": "stop_anomaly",
                    "message": "异常注入已停止，恢复正常模式",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "inject_fire":
                fire_target = random.choice(ARCHIVE_ROOMS)
                system_state.update(
                    anomaly="fire", anomaly_ticks=0,
                    control_active=False, action=None,
                    anomaly_base_t=None, anomaly_base_h=None,
                    fire_target_room=fire_target["id"],
                    leak_target_room=None)
                raise_anomaly_alarm(
                    action="inject_fire",
                    location=fire_target["name"],
                    reason=f"火灾模拟触发，{fire_target['name']} 出现局部高温风险",
                    alarm_time_utc=event_ts,
                    level="严重",
                )
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": False,
                    "action": "inject_fire",
                    "message": f"🔥 火灾模拟已启动 — {fire_target['name']} 局部高温",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "inject_rain":
                system_state.update(
                    anomaly="rain", anomaly_ticks=0,
                    control_active=False, action=None,
                    anomaly_base_t=None, anomaly_base_h=None,
                    fire_target_room=None, leak_target_room=None)
                raise_anomaly_alarm(
                    action="inject_rain",
                    location="全馆",
                    reason="梅雨异常注入，预计全馆湿度快速升高",
                    alarm_time_utc=event_ts,
                    level="较高",
                )
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": False,
                    "action": "inject_rain",
                    "message": "🌧 梅雨模拟已启动 — 全馆湿度急升",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "inject_dry":
                system_state.update(
                    anomaly="dry", anomaly_ticks=0,
                    control_active=False, action=None,
                    anomaly_base_t=None, anomaly_base_h=None,
                    fire_target_room=None, leak_target_room=None)
                raise_anomaly_alarm(
                    action="inject_dry",
                    location="全馆",
                    reason="空气干燥异常注入，预计全馆湿度快速降低",
                    alarm_time_utc=event_ts,
                    level="较高",
                )
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": False,
                    "action": "inject_dry",
                    "message": "💨 空气干燥模拟已启动 — 全馆湿度急降",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "inject_cold":
                system_state.update(
                    anomaly="cold", anomaly_ticks=0,
                    control_active=False, action=None,
                    anomaly_base_t=None, anomaly_base_h=None,
                    fire_target_room=None, leak_target_room=None)
                raise_anomaly_alarm(
                    action="inject_cold",
                    location="全馆",
                    reason="寒潮异常注入，预计全馆温度快速下降",
                    alarm_time_utc=event_ts,
                    level="较高",
                )
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": False,
                    "action": "inject_cold",
                    "message": "❄ 寒潮模拟已启动 — 全馆温度急降",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "inject_outlier":
                system_state.update(
                    anomaly="outlier", anomaly_ticks=0,
                    control_active=False, action=None,
                    anomaly_base_t=None, anomaly_base_h=None,
                    fire_target_room=None, leak_target_room=None)
                raise_anomaly_alarm(
                    action="inject_outlier",
                    location="全馆",
                    reason="异常数据注入，系统将出现越界样本以测试鲁棒性",
                    alarm_time_utc=event_ts,
                    level="一般",
                )
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": False,
                    "action": "inject_outlier",
                    "message": "⚠ 异常数据注入已启动 — 数据将按比例出现越界样本",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "inject_gas":
                system_state.update(
                    anomaly="gas", anomaly_ticks=0,
                    control_active=False, action=None,
                    anomaly_base_t=None, anomaly_base_h=None,
                    fire_target_room=None, leak_target_room=None)
                raise_anomaly_alarm(
                    action="inject_gas",
                    location="全馆",
                    reason="有害气体异常注入，PM2.5 与氮氧化物快速升高",
                    alarm_time_utc=event_ts,
                    level="严重",
                )
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": False,
                    "action": "inject_gas",
                    "message": "☣ 有害气体异常已启动 — PM2.5/氮氧化物升高",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "inject_leak":
                leak_target = random.choice(ARCHIVE_ROOMS)
                system_state.update(
                    anomaly="leak", anomaly_ticks=0,
                    control_active=False, action=None,
                    anomaly_base_t=None, anomaly_base_h=None,
                    fire_target_room=None,
                    leak_target_room=leak_target["id"])
                raise_anomaly_alarm(
                    action="inject_leak",
                    location=leak_target["name"],
                    reason=f"漏水异常注入，{leak_target['name']} 出现局部渗漏风险",
                    alarm_time_utc=event_ts,
                    level="严重",
                )
                msg = json.dumps({
                    "type": "system_status",
                    "control_active": False,
                    "action": "inject_leak",
                    "message": f"💧 漏水异常已启动 — {leak_target['name']} 疑似渗漏",
                }, ensure_ascii=False)
                await manager.broadcast(msg)
                await broadcast_sensor_data()

            elif action == "toggle_equipment":
                device = data.get("device")
                if device in equipment:
                    eq = equipment[device]
                    if eq["active"]:
                        eq.update(active=False, mode="standby", power=0)
                    else:
                        eq.update(active=True, mode="manual",
                                  power=POWER_LEVELS["medium"])
                    msg = json.dumps({
                        "type": "equipment_status",
                        "equipment": equipment,
                    }, ensure_ascii=False)
                    await manager.broadcast(msg)

            elif action == "set_equipment_level":
                device = data.get("device")
                raw_level = str(data.get("level", "")).lower()
                level = POWER_LEVEL_ALIASES.get(raw_level)
                if device in equipment and level in POWER_LEVELS:
                    power = POWER_LEVELS[level]
                    eq = equipment[device]
                    if power == 0:
                        eq.update(active=False, mode="manual", power=0)
                    else:
                        eq.update(active=True, mode="manual", power=power)
                    msg = json.dumps({
                        "type": "equipment_status",
                        "equipment": equipment,
                    }, ensure_ascii=False)
                    await manager.broadcast(msg)

            elif action == "set_equipment_mode":
                device = data.get("device")
                mode = str(data.get("mode", "")).lower()
                if device in equipment and mode in ("auto", "manual"):
                    eq = equipment[device]
                    if mode == "auto":
                        # 退出手动控制，下一 tick 由 auto_equipment 接管
                        eq.update(active=False, mode="standby", power=0)
                    else:
                        # 进入手动控制，默认中档
                        default_power = max(eq.get("power", 0), POWER_LEVELS["medium"])
                        eq.update(active=True, mode="manual", power=default_power)
                    msg = json.dumps({
                        "type": "equipment_status",
                        "equipment": equipment,
                    }, ensure_ascii=False)
                    await manager.broadcast(msg)

            elif action == "request_history":
                room_id = data.get("room_id")
                if room_id and room_id in room_history:
                    hist = get_recent_room_history_records(room_id, 360)
                elif room_id:
                    matched = next((r for r in ARCHIVE_ROOMS
                                    if r.get("code") == room_id), None)
                    if matched:
                        hist = get_recent_room_history_records(matched["id"], 360)
                    else:
                        hist = get_recent_global_history_records(360)
                else:
                    hist = get_recent_global_history_records(360)
                resp = json.dumps({
                    "type": "history_data",
                    "room_id": room_id or "global",
                    "data": hist,
                }, ensure_ascii=False)
                await websocket.send_text(resp)

    except WebSocketDisconnect:
        manager.disconnect(websocket)


# ============================================================
# 14. 启动
# ============================================================
@app.on_event("startup")
async def startup():
    init_alarm_record_store()

    history_loaded = False
    if alarm_db_ready:
        history_loaded = _load_history_cache_from_db(720)

    if not history_loaded:
        prefill_history()
        if alarm_db_ready:
            _sync_history_cache_to_db()

    asyncio.create_task(broadcast_loop())
    print("=" * 60)
    print("  档案馆温湿度实时监测与智能调控系统 - 后端服务已启动")
    print("  WebSocket 端点: ws://localhost:8000/ws")
    print("  前端页面:   http://localhost:8000/")
    print("  报警导出:   http://localhost:8000/api/alarm-records/export")
    print("  本地导出:   http://localhost:8000/api/alarm-records/export-local")
    print(f"  报警存储:   {'MySQL' if alarm_db_ready else '内存'}")
    print(f"  导出目录:   {_resolve_alarm_export_dir()}")
    print(f"  飞书Webhook: {'已配置' if FEISHU_WEBHOOK_URL else '未配置'}")
    print(f"  国标范围: 温度 {TEMP_MIN}-{TEMP_MAX}°C"
          f" / 湿度 {HUMIDITY_MIN}-{HUMIDITY_MAX}%RH")
    print("=" * 60)


@app.get("/api/alarm-records")
async def get_alarm_records_api(limit: int = 200):
    safe_limit = max(1, min(limit, 2000))
    return {
        "total": get_alarm_record_total(),
        "records": get_recent_alarm_records(safe_limit),
    }


@app.post("/api/alarm-records/{record_id}/status")
async def update_alarm_record_status_api(record_id: str, payload: dict):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")

    status = str(payload.get("status") or "").strip().lower()
    if status not in ALARM_STATUS_ALLOWED:
        raise HTTPException(status_code=400, detail="status 参数不合法")

    dispose_result = str(payload.get("disposal_result") or "").strip()
    if len(dispose_result) > 240:
        raise HTTPException(status_code=400, detail="disposal_result 长度不能超过 240")

    updated = update_alarm_record_status(
        record_id=record_id,
        status=status,
        dispose_result=dispose_result or None,
        alarm_time_utc=_utc_now_iso(),
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="未找到指定报警记录")

    return {
        "ok": True,
        "record": updated,
    }


@app.post("/api/ai/chat")
async def ai_chat_proxy(payload: dict):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")

    model = str(payload.get("model") or LONGCAT_MODEL).strip() or "LongCat-Flash-Chat"
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="messages 不能为空")

    api_key = (os.getenv("LONGCAT_API_KEY") or LONGCAT_API_KEY or "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="服务端未配置 LONGCAT_API_KEY")

    def _do_post(body: bytes):
        req = urlrequest.Request(
            LONGCAT_API_URL,
            data=body,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        with urlrequest.urlopen(req, timeout=LONGCAT_TIMEOUT_SECONDS) as resp:
            resp_body = resp.read().decode("utf-8", errors="ignore")
            return resp.getcode(), resp_body

    base = {
        "messages": messages,
        "temperature": payload.get("temperature", 0.2),
        "max_tokens": payload.get("max_tokens", 800),
    }

    model_candidates: List[str] = []
    for m in [model, LONGCAT_MODEL, "LongCat-Flash-Chat"]:
        mm = str(m or "").strip()
        if mm and mm not in model_candidates:
            model_candidates.append(mm)

    variants: List[dict] = []
    for model_name in model_candidates:
        if "response_format" in payload:
            row_with_format = dict(base)
            row_with_format["model"] = model_name
            row_with_format["response_format"] = payload.get("response_format")
            variants.append(row_with_format)

        row_plain = dict(base)
        row_plain["model"] = model_name
        variants.append(row_plain)

    last_error: Optional[HTTPException] = None

    for req_payload in variants:
        body = json.dumps(req_payload, ensure_ascii=False).encode("utf-8")

        try:
            code, resp_body = await asyncio.to_thread(_do_post, body)
        except urlerror.HTTPError as exc:
            try:
                err_body = exc.read().decode("utf-8", errors="ignore")
            except Exception:
                err_body = str(exc)
            short_err = err_body[:280] if err_body else str(exc)
            last_error = HTTPException(status_code=502, detail=f"Longcat 上游错误 HTTP {exc.code}: {short_err}")
            continue
        except Exception as exc:
            last_error = HTTPException(status_code=502, detail=f"Longcat 请求失败: {exc}")
            continue

        if not (200 <= code < 300):
            short_body = resp_body[:280] if resp_body else ""
            last_error = HTTPException(status_code=502, detail=f"Longcat 上游错误 HTTP {code}: {short_body}")
            continue

        try:
            return json.loads(resp_body) if resp_body else {}
        except json.JSONDecodeError as exc:
            short_body = resp_body[:280] if resp_body else ""
            last_error = HTTPException(status_code=502, detail=f"Longcat 返回了非 JSON 数据: {short_body}")
            print(f"[AI Proxy] 上游返回非 JSON，payload model={req_payload.get('model')}: {exc}")
            continue

    if last_error:
        raise last_error
    raise HTTPException(status_code=502, detail="Longcat 请求失败")


def _alarm_csv_header() -> List[str]:
    return ["报警时间", "地点", "原因", "来源", "级别", "状态", "处置结果", "解除时间", "记录ID"]


def _alarm_csv_rows() -> List[List[str]]:
    records: List[dict]
    if alarm_db_ready:
        db_rows = _db_fetch_alarm_records_for_export()
        records = db_rows if db_rows is not None else [dict(item) for item in reversed(list(alarm_records))]
    else:
        records = [dict(item) for item in reversed(list(alarm_records))]

    rows = []
    for item in records:
        rows.append([
            item.get("alarm_time", ""),
            item.get("location", ""),
            item.get("reason", ""),
            item.get("source", ""),
            item.get("level", ""),
            item.get("status", ""),
            item.get("disposal_result", ""),
            item.get("resolved_time", ""),
            item.get("id", ""),
        ])
    return rows


def _write_alarm_csv(file_obj):
    writer = csv.writer(file_obj)
    writer.writerow(_alarm_csv_header())
    for row in _alarm_csv_rows():
        writer.writerow(row)


@app.get("/api/alarm-records/export")
async def export_alarm_records_api():
    output = io.StringIO()
    _write_alarm_csv(output)

    data = output.getvalue().encode("utf-8-sig")
    filename = f"alarm_records_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        io.BytesIO(data),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.post("/api/alarm-records/export-local")
@app.get("/api/alarm-records/export-local")
async def export_alarm_records_local_api():
    export_dir = _resolve_alarm_export_dir()
    os.makedirs(export_dir, exist_ok=True)

    filename = f"alarm_records_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    file_path = os.path.join(export_dir, filename)

    with open(file_path, "w", encoding="utf-8-sig", newline="") as f:
        _write_alarm_csv(f)

    return {
        "ok": True,
        "file_name": filename,
        "file_path": file_path,
        "record_count": get_alarm_record_total(),
    }


# ---- 托管前端静态文件 ----
_FRONTEND = os.path.join(os.path.dirname(__file__), "..", "pc-client", "index.html")


@app.get("/")
async def serve_frontend():
    return FileResponse(os.path.abspath(_FRONTEND), media_type="text/html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
