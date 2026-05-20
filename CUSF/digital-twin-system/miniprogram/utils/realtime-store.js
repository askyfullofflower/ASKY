var STATUS_META = {
  normal: { label: "正常", tone: "normal" },
  temp_alert: { label: "温度偏高", tone: "danger" },
  temp_low_alert: { label: "温度偏低", tone: "warning" },
  humidity_alert: { label: "湿度偏高", tone: "danger" },
  humidity_low_alert: { label: "湿度偏低", tone: "warning" },
  cooling_active: { label: "调控中", tone: "warning" }
};

var STATUS_ALERT_TEXT = {
  temp_alert: "温度超出上限",
  temp_low_alert: "温度低于下限",
  humidity_alert: "湿度超出上限",
  humidity_low_alert: "湿度低于下限"
};

var ANOMALY_ACTION_ALIAS = {
  cold: "inject_cold",
  rain: "inject_rain",
  dry: "inject_dry",
  fire: "inject_fire",
  gas: "inject_gas",
  leak: "inject_leak",
  outlier: "inject_outlier",
  high_temp: "inject_high_temp",
  high_humidity: "inject_high_humidity"
};

var EQUIPMENT_ORDER = ["ac", "dehumidifier", "humidifier", "ventilation"];
var EQUIPMENT_NAME = {
  ac: "精密空调",
  dehumidifier: "工业除湿机",
  humidifier: "加湿器",
  ventilation: "通风系统"
};

function cloneJSON(data) {
  return JSON.parse(JSON.stringify(data));
}

function pickToneByRoom(status) {
  var info = STATUS_META[String(status || "").toLowerCase()] || STATUS_META.normal;
  return info.tone;
}

function toNumber(value, fallback) {
  var n = Number(value);
  if (isNaN(n)) {
    return fallback;
  }
  return n;
}

function formatTimestamp(raw) {
  if (!raw) {
    return "--";
  }
  var dt = new Date(raw);
  if (isNaN(dt.getTime())) {
    return String(raw);
  }
  var m = dt.getMonth() + 1;
  var d = dt.getDate();
  var h = dt.getHours();
  var mm = dt.getMinutes();
  var s = dt.getSeconds();
  return dt.getFullYear() + "-"
    + (m < 10 ? "0" + m : m) + "-"
    + (d < 10 ? "0" + d : d) + " "
    + (h < 10 ? "0" + h : h) + ":"
    + (mm < 10 ? "0" + mm : mm) + ":"
    + (s < 10 ? "0" + s : s);
}

function pad2(value) {
  var n = Number(value);
  if (isNaN(n)) {
    return "00";
  }
  return n < 10 ? "0" + n : String(n);
}

function formatClock(raw) {
  var dt = raw instanceof Date ? raw : new Date(raw);
  if (isNaN(dt.getTime())) {
    dt = new Date();
  }
  return pad2(dt.getHours()) + ":" + pad2(dt.getMinutes()) + ":" + pad2(dt.getSeconds());
}

function normalizeAnomalyAction(action) {
  var key = String(action || "").toLowerCase().trim();
  if (!key) {
    return "";
  }
  if (key === "stop_anomaly" || key.indexOf("inject_") === 0) {
    return key;
  }
  return ANOMALY_ACTION_ALIAS[key] || "";
}

function normalizeAlarmLevel(level) {
  var text = String(level || "一般");
  if (text === "严重") {
    return "严重";
  }
  if (text === "较高") {
    return "较高";
  }
  return "一般";
}

function defaultState() {
  return {
    wsStatusText: "未连接",
    wsClass: "disconnected",
    wsEndpoint: "--",
    socketReady: false,
    lastMessage: "",

    temperature: "--.-",
    humidity: "--.-",
    pm25: "--",
    nox: "--",
    statusText: "等待数据",
    statusTone: "normal",
    lastTimestamp: "--",

    rooms: [],
    floorStats: {},
    recentTrend: [],
    prediction: null,
    globalHistory: [],
    roomHistoryMap: {},

    equipment: {},
    equipmentItems: [],
    controlMode: "auto",

    waterLeak: {
      detected: false,
      risk: 0,
      location: "--",
      status: "normal"
    },

    alarmRecords: [],
    alarmTotal: 0,

    systemNotice: "",
    systemLogs: []
  };
}

function normalizeRooms(rooms) {
  if (!Array.isArray(rooms)) {
    return [];
  }
  return rooms.map(function (room, index) {
    var status = String(room && room.status || "normal");
    var statusInfo = STATUS_META[status] || STATUS_META.normal;
    var t = toNumber(room && room.temperature, NaN);
    var h = toNumber(room && room.humidity, NaN);
    return {
      key: String(room && room.id || "room-" + index),
      id: String(room && room.id || "room-" + index),
      historyId: String(room && room.history_id || room && room.id || "room-" + index),
      name: room && room.name || "未命名库房",
      floor: room && room.floor || "--",
      area: room && room.area !== undefined ? String(room.area) : "--",
      temperature: isNaN(t) ? "--.-" : t.toFixed(1),
      humidity: isNaN(h) ? "--.-" : h.toFixed(1),
      status: status,
      statusLabel: statusInfo.label,
      tone: statusInfo.tone
    };
  });
}

function normalizeEquipment(equipmentMap) {
  var src = equipmentMap || {};
  var manualCount = 0;
  var items = EQUIPMENT_ORDER.map(function (key) {
    var row = src[key] || {};
    var power = toNumber(row.power, 0);
    if (power < 0) {
      power = 0;
    }
    if (power > 100) {
      power = 100;
    }
    var mode = String(row.mode || "standby").toLowerCase();
    var isManual = mode === "manual";
    if (isManual) {
      manualCount += 1;
    }
    return {
      key: key,
      name: row.name || EQUIPMENT_NAME[key],
      mode: mode,
      modeLabel: isManual ? "手动控制" : (mode === "standby" ? "自动待机" : "自动运行"),
      active: !!row.active,
      activeLabel: row.active ? "运行中" : "待机",
      power: power,
      powerText: power + "%"
    };
  });

  var mode = "mixed";
  if (manualCount === 0) {
    mode = "auto";
  }
  if (manualCount === items.length) {
    mode = "manual";
  }

  return {
    mode: mode,
    items: items
  };
}

function normalizeAlarms(records) {
  if (!Array.isArray(records)) {
    return [];
  }

  return records.slice(0, 200).map(function (item, idx) {
    var rawStatus = String(item && item.status || "active").toLowerCase();
    var resolved = rawStatus === "resolved";
    return {
      key: String(item && item.id || "alarm-" + idx),
      id: String(item && item.id || "alarm-" + idx),
      alarmTime: item && item.alarm_time || "--",
      location: item && item.location || "未知区域",
      source: item && item.source || "系统",
      level: normalizeAlarmLevel(item && item.level),
      reason: item && item.reason || "--",
      disposalResult: item && item.disposal_result || "待处置",
      status: rawStatus,
      statusText: resolved ? "已处理" : "未处理",
      resolvedTime: item && item.resolved_time || ""
    };
  });
}

function buildWsCandidates() {
  var candidates = [];
  var savedUrl = wx.getStorageSync("wsUrl");
  var savedHost = wx.getStorageSync("backendHost");

  if (savedUrl && typeof savedUrl === "string") {
    candidates.push(savedUrl.trim());
  }

  if (savedHost && typeof savedHost === "string") {
    var host = savedHost.trim();
    if (host) {
      if (host.indexOf("ws://") === 0 || host.indexOf("wss://") === 0) {
        if (host.lastIndexOf("/ws") !== host.length - 3) {
          host = host.replace(/\/+$/, "") + "/ws";
        }
        candidates.push(host);
      } else {
        candidates.push("ws://" + host + ":8000/ws");
      }
    }
  }

  candidates.push("ws://10.202.8.236:8000/ws");
  candidates.push("ws://127.0.0.1:8000/ws");
  candidates.push("ws://localhost:8000/ws");

  return candidates.filter(function (item, idx) {
    return item && candidates.indexOf(item) === idx;
  });
}

function wsToApiBase(wsUrl) {
  var url = String(wsUrl || "").trim();
  if (!url) {
    return "";
  }
  url = url.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
  return url.replace(/\/ws(\?.*)?$/i, "").replace(/\/+$/, "");
}

function RealtimeStore() {
  this.state = defaultState();

  this.listeners = [];
  this.socketOpen = false;
  this.connecting = false;
  this.wsCandidates = buildWsCandidates();
  this.wsIndex = 0;
  this.currentWsUrl = "";
  this.currentApiBase = "";

  this.reconnectTimer = null;
  this.connectTimeoutTimer = null;
  this.connectAttemptToken = 0;
  this.logSeed = 0;

  this.lastThresholdAlertSignature = "";
  this.lastAirAlertSignature = "";
  this.lastLeakAlertSignature = "";

  this.historyResolvers = {};
}

RealtimeStore.prototype.getState = function () {
  return cloneJSON(this.state);
};

RealtimeStore.prototype.subscribe = function (listener) {
  if (typeof listener !== "function") {
    return function () {};
  }
  this.listeners.push(listener);
  listener(this.getState());

  var that = this;
  return function () {
    that.listeners = that.listeners.filter(function (item) {
      return item !== listener;
    });
  };
};

RealtimeStore.prototype.notify = function () {
  var snapshot = this.getState();
  this.listeners.forEach(function (listener) {
    try {
      listener(snapshot);
    } catch (e) {
      console.warn("listener error", e);
    }
  });
};

RealtimeStore.prototype.setState = function (patch) {
  this.state = Object.assign({}, this.state, patch || {});
  this.notify();
};

RealtimeStore.prototype.pushSystemLog = function (message, tone) {
  var text = String(message || "").trim();
  if (!text) {
    return;
  }

  var logs = Array.isArray(this.state.systemLogs) ? this.state.systemLogs.slice() : [];
  this.logSeed += 1;
  logs.unshift({
    key: "log-" + Date.now() + "-" + this.logSeed,
    time: formatClock(new Date()),
    text: text,
    tone: tone || "info"
  });

  if (logs.length > 80) {
    logs = logs.slice(0, 80);
  }

  this.setState({ systemLogs: logs });
};

RealtimeStore.prototype.safeRemoveSocketListeners = function () {
  if (typeof wx.offSocketOpen === "function") {
    wx.offSocketOpen();
  }
  if (typeof wx.offSocketMessage === "function") {
    wx.offSocketMessage();
  }
  if (typeof wx.offSocketClose === "function") {
    wx.offSocketClose();
  }
  if (typeof wx.offSocketError === "function") {
    wx.offSocketError();
  }
};

RealtimeStore.prototype.markSocketState = function (text, cls, ready, endpoint) {
  var patch = {
    wsStatusText: text,
    wsClass: cls,
    socketReady: !!ready
  };
  if (endpoint !== undefined) {
    patch.wsEndpoint = endpoint;
  }
  this.setState(patch);
};

RealtimeStore.prototype.tryNextWsEndpoint = function (reason, token) {
  if (token && token !== this.connectAttemptToken) {
    return;
  }

  if (this.connectTimeoutTimer) {
    clearTimeout(this.connectTimeoutTimer);
    this.connectTimeoutTimer = null;
  }

  if (this.wsIndex < this.wsCandidates.length - 1) {
    this.wsIndex += 1;
    if (reason) {
      this.pushSystemLog(reason + "，切换备用地址重试", "alert");
    }
    this.connect();
    return;
  }

  this.connecting = false;
  this.markSocketState("连接失败", "disconnected", false);
  this.setState({
    lastMessage: reason || "所有地址连接失败",
    systemNotice: "连接失败，请检查后端服务与网络"
  });
  this.pushSystemLog(reason || "所有地址连接失败", "alert");
};

RealtimeStore.prototype.connect = function () {
  var that = this;
  this.connectAttemptToken += 1;
  var token = this.connectAttemptToken;

  if (!this.wsCandidates || this.wsCandidates.length === 0) {
    this.wsCandidates = buildWsCandidates();
    this.wsIndex = 0;
  }

  var wsUrl = this.wsCandidates[this.wsIndex] || "ws://127.0.0.1:8000/ws";
  this.currentWsUrl = wsUrl;

  this.connecting = true;
  this.markSocketState("连接中...", "connecting", false, wsUrl);
  this.pushSystemLog("正在连接 " + wsUrl, "info");

  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  if (this.connectTimeoutTimer) {
    clearTimeout(this.connectTimeoutTimer);
    this.connectTimeoutTimer = null;
  }

  wx.closeSocket();
  this.safeRemoveSocketListeners();

  wx.connectSocket({
    url: wsUrl,
    header: { "content-type": "application/json" },
    fail: function () {
      that.tryNextWsEndpoint("connectSocket 调用失败", token);
    }
  });

  this.connectTimeoutTimer = setTimeout(function () {
    if (token !== that.connectAttemptToken || that.socketOpen) {
      return;
    }
    that.socketOpen = false;
    wx.closeSocket();
    that.tryNextWsEndpoint("连接超时", token);
  }, 5000);

  wx.onSocketOpen(function () {
    if (token !== that.connectAttemptToken) {
      return;
    }

    that.connecting = false;
    that.socketOpen = true;
    that.currentApiBase = wsToApiBase(wsUrl);
    wx.setStorageSync("wsUrl", wsUrl);

    if (that.connectTimeoutTimer) {
      clearTimeout(that.connectTimeoutTimer);
      that.connectTimeoutTimer = null;
    }

    that.markSocketState("已连接", "connected", true, wsUrl);
    that.pushSystemLog("WebSocket 已连接", "info");
    that.fetchAlarmRecords(120);
  });

  wx.onSocketMessage(function (res) {
    if (token !== that.connectAttemptToken) {
      return;
    }

    var data;
    try {
      data = JSON.parse(res.data);
    } catch (e) {
      return;
    }

    that.handleSocketMessage(data);
  });

  wx.onSocketClose(function () {
    if (token !== that.connectAttemptToken) {
      return;
    }

    var wasOpen = that.socketOpen;
    that.socketOpen = false;
    that.connecting = false;

    if (that.connectTimeoutTimer) {
      clearTimeout(that.connectTimeoutTimer);
      that.connectTimeoutTimer = null;
    }

    that.markSocketState("已断开", "disconnected", false);
    if (wasOpen) {
      that.pushSystemLog("连接已断开，正在尝试自动重连", "alert");
    }

    if (wasOpen) {
      that.reconnectTimer = setTimeout(function () {
        that.connect();
      }, 4000);
    }
  });

  wx.onSocketError(function () {
    if (token !== that.connectAttemptToken) {
      return;
    }
    that.socketOpen = false;
    that.connecting = false;
    that.pushSystemLog("连接错误，正在切换地址", "alert");
    that.tryNextWsEndpoint("连接错误", token);
  });
};

RealtimeStore.prototype.ensureConnected = function () {
  if (this.socketOpen || this.connecting) {
    return;
  }
  this.connect();
};

RealtimeStore.prototype.handleSocketMessage = function (data) {
  var type = String(data && data.type || "");

  if (type === "init_history") {
    var equipmentInfo = normalizeEquipment(data.equipment || {});
    this.setState({
      equipment: data.equipment || {},
      equipmentItems: equipmentInfo.items,
      controlMode: equipmentInfo.mode === "mixed" ? this.state.controlMode : equipmentInfo.mode,
      globalHistory: Array.isArray(data.global_history) ? data.global_history : [],
      alarmRecords: normalizeAlarms(data.alarm_records || []),
      alarmTotal: Array.isArray(data.alarm_records) ? data.alarm_records.length : this.state.alarmTotal
    });
    this.pushSystemLog("初始化数据已同步", "info");
    return;
  }

  if (type === "sensor_data") {
    this.updateFromSensorData(data);
    return;
  }

  if (type === "equipment_status") {
    var equipmentInfoStatus = normalizeEquipment(data.equipment || {});
    this.setState({
      equipment: data.equipment || {},
      equipmentItems: equipmentInfoStatus.items,
      controlMode: equipmentInfoStatus.mode === "mixed" ? this.state.controlMode : equipmentInfoStatus.mode
    });
    return;
  }

  if (type === "system_status") {
    var message = data.message || "";
    var action = String(data.action || "");
    var tone = action.indexOf("inject_") === 0 ? "alert" : "info";
    this.setState({
      systemNotice: message,
      lastMessage: message
    });
    if (message) {
      this.pushSystemLog(message, tone);
    }
    return;
  }

  if (type === "history_data") {
    var roomId = String(data.room_id || "global");
    var map = Object.assign({}, this.state.roomHistoryMap);
    map[roomId] = Array.isArray(data.data) ? data.data : [];
    this.setState({ roomHistoryMap: map });

    if (this.historyResolvers[roomId]) {
      this.historyResolvers[roomId].resolve(map[roomId]);
      delete this.historyResolvers[roomId];
    }
  }
};

RealtimeStore.prototype.updateFromSensorData = function (data) {
  var rooms = normalizeRooms(data.rooms || []);
  var statusCode = String(data.status || "normal").toLowerCase();
  var statusInfo = STATUS_META[statusCode] || STATUS_META.normal;
  var air = data.air_quality || {};
  var leak = data.water_leak || {};
  var equipmentInfo = normalizeEquipment(data.equipment || {});
  var tempNum = toNumber(data.temperature, NaN);
  var humNum = toNumber(data.humidity, NaN);
  var pmNum = toNumber(air.pm25, NaN);
  var noxNum = toNumber(air.nox, NaN);
  var prediction = data && typeof data.prediction === "object" ? data.prediction : null;

  var alarms = this.state.alarmRecords;
  if (Array.isArray(data.alarm_records)) {
    alarms = normalizeAlarms(data.alarm_records);
  }

  this.setState({
    temperature: isNaN(tempNum) ? "--.-" : tempNum.toFixed(1),
    humidity: isNaN(humNum) ? "--.-" : humNum.toFixed(1),
    pm25: isNaN(pmNum) ? "--" : pmNum.toFixed(1),
    nox: isNaN(noxNum) ? "--" : noxNum.toFixed(3),
    statusText: statusInfo.label,
    statusTone: statusInfo.tone,
    lastTimestamp: formatTimestamp(data.timestamp),

    rooms: rooms,
    floorStats: data.floor_stats || {},
    recentTrend: Array.isArray(data.recent_trend) ? data.recent_trend : this.state.recentTrend,
    prediction: prediction,

    equipment: data.equipment || {},
    equipmentItems: equipmentInfo.items,
    controlMode: equipmentInfo.mode === "mixed" ? this.state.controlMode : equipmentInfo.mode,

    waterLeak: {
      detected: !!leak.detected,
      risk: toNumber(leak.risk, 0),
      location: leak.location || "--",
      status: leak.status || "normal"
    },

    alarmRecords: alarms,
    alarmTotal: Array.isArray(data.alarm_records) ? data.alarm_records.length : this.state.alarmTotal
  });

  var roomAlerts = rooms.filter(function (room) {
    return room && room.status && room.status !== "normal";
  }).map(function (room) {
    return room.name;
  });

  if (STATUS_ALERT_TEXT[statusCode]) {
    var thresholdSignature = statusCode + "|" + roomAlerts.join("|");
    if (thresholdSignature !== this.lastThresholdAlertSignature) {
      var roomText = roomAlerts.length ? "（" + roomAlerts.join("、") + "）" : "";
      this.pushSystemLog("阈值告警: " + STATUS_ALERT_TEXT[statusCode] + roomText, "alert");
      this.lastThresholdAlertSignature = thresholdSignature;
    }
  } else if (this.lastThresholdAlertSignature && statusCode === "normal") {
    this.pushSystemLog("阈值告警已恢复到正常区间", "info");
    this.lastThresholdAlertSignature = "";
  }

  var airAlerts = Array.isArray(air.alerts) ? air.alerts : [];
  var airSignature = airAlerts.join("|");
  if (airSignature && airSignature !== this.lastAirAlertSignature) {
    this.pushSystemLog("有害气体告警: " + airAlerts.join("；"), "alert");
  }
  if (!airSignature && this.lastAirAlertSignature) {
    this.pushSystemLog("有害气体告警已解除", "info");
  }
  this.lastAirAlertSignature = airSignature;

  var leakSignature = leak && leak.detected ? String(leak.location || "未知区域") : "";
  if (leakSignature && leakSignature !== this.lastLeakAlertSignature) {
    this.pushSystemLog("漏水告警: " + leakSignature + "，风险 " + toNumber(leak.risk, 0) + "%", "alert");
  }
  if (!leakSignature && this.lastLeakAlertSignature) {
    this.pushSystemLog("漏水告警已解除", "info");
  }
  this.lastLeakAlertSignature = leakSignature;
};

RealtimeStore.prototype.sendControlCommand = function (action, extraPayload) {
  if (!this.socketOpen) {
    this.ensureConnected();
    return false;
  }

  var payload = Object.assign({
    type: "control_command",
    action: action
  }, extraPayload || {});

  wx.sendSocketMessage({
    data: JSON.stringify(payload)
  });

  return true;
};

RealtimeStore.prototype.setControlMode = function (mode) {
  var targetMode = mode === "manual" ? "manual" : "auto";
  var sent = false;
  for (var i = 0; i < EQUIPMENT_ORDER.length; i += 1) {
    if (this.sendControlCommand("set_equipment_mode", {
      device: EQUIPMENT_ORDER[i],
      mode: targetMode
    })) {
      sent = true;
    }
  }
  return sent;
};

RealtimeStore.prototype.toggleEquipment = function (device) {
  return this.sendControlCommand("toggle_equipment", { device: device });
};

RealtimeStore.prototype.setEquipmentLevel = function (device, level) {
  return this.sendControlCommand("set_equipment_level", {
    device: device,
    level: level
  });
};

RealtimeStore.prototype.runScene = function (scene) {
  var sent = false;

  if (scene === "dehumidify") {
    sent = this.sendControlCommand("set_equipment_mode", { device: "dehumidifier", mode: "manual" }) || sent;
    sent = this.sendControlCommand("set_equipment_level", { device: "dehumidifier", level: "high" }) || sent;
    sent = this.sendControlCommand("set_equipment_level", { device: "humidifier", level: "off" }) || sent;
    return sent;
  }

  if (scene === "constant") {
    return this.setControlMode("auto");
  }

  if (scene === "ventilate") {
    sent = this.sendControlCommand("set_equipment_mode", { device: "ventilation", mode: "manual" }) || sent;
    sent = this.sendControlCommand("set_equipment_level", { device: "ventilation", level: "high" }) || sent;
    return sent;
  }

  if (scene === "shutdown") {
    for (var i = 0; i < EQUIPMENT_ORDER.length; i += 1) {
      if (this.sendControlCommand("set_equipment_level", {
        device: EQUIPMENT_ORDER[i],
        level: "off"
      })) {
        sent = true;
      }
    }
    return sent;
  }

  return false;
};

RealtimeStore.prototype.injectAnomaly = function (action) {
  var normalized = normalizeAnomalyAction(action);
  if (!normalized || normalized === "stop_anomaly") {
    return false;
  }
  return this.sendControlCommand(normalized);
};

RealtimeStore.prototype.stopAnomaly = function () {
  return this.sendControlCommand("stop_anomaly");
};

RealtimeStore.prototype.getApiCandidates = function () {
  var result = [];

  function add(base) {
    var value = String(base || "").trim().replace(/\/+$/, "");
    if (value && result.indexOf(value) === -1) {
      result.push(value);
    }
  }

  add(this.currentApiBase);
  add(wsToApiBase(this.currentWsUrl));
  add(wx.getStorageSync("apiBase"));
  add(wx.getStorageSync("backendApiBase"));

  (this.wsCandidates || []).forEach(function (wsUrl) {
    add(wsToApiBase(wsUrl));
  });

  add("http://127.0.0.1:8000");
  add("http://localhost:8000");

  return result;
};

RealtimeStore.prototype.requestApi = function (path, method, payload) {
  var that = this;
  var candidates = this.getApiCandidates();

  return new Promise(function (resolve, reject) {
    var idx = 0;

    function next(lastError) {
      if (idx >= candidates.length) {
        reject(lastError || new Error("接口不可用"));
        return;
      }

      var base = candidates[idx];
      idx += 1;

      wx.request({
        url: base + path,
        method: method || "GET",
        timeout: 8000,
        data: payload || {},
        success: function (res) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            that.currentApiBase = base;
            wx.setStorageSync("apiBase", base);
            resolve(res.data);
          } else {
            var detail = "";
            if (res && typeof res.data === "string") {
              detail = res.data;
            } else if (res && res.data && typeof res.data.detail === "string") {
              detail = res.data.detail;
            } else if (res && res.data) {
              try {
                detail = JSON.stringify(res.data);
              } catch (e) {
                detail = "";
              }
            }
            var suffix = detail ? (": " + detail.slice(0, 220)) : "";
            next(new Error("HTTP " + res.statusCode + suffix));
          }
        },
        fail: function (err) {
          var msg = err && (err.message || err.errMsg);
          next(new Error(msg || "request failed"));
        }
      });
    }

    next();
  });
};

RealtimeStore.prototype.fetchAlarmRecords = function (limit) {
  var that = this;
  var max = limit || 120;
  return this.requestApi("/api/alarm-records?limit=" + max, "GET")
    .then(function (data) {
      var rows = normalizeAlarms(data && data.records || []);
      that.setState({
        alarmRecords: rows,
        alarmTotal: toNumber(data && data.total, rows.length)
      });
      return rows;
    });
};

RealtimeStore.prototype.exportAlarmRecordsLocal = function () {
  var that = this;
  return this.requestApi("/api/alarm-records/export-local?t=" + Date.now(), "POST")
    .then(function (data) {
      if (!data || !data.ok || !data.file_path) {
        throw new Error("导出接口返回异常");
      }
      that.pushSystemLog("告警记录已导出: " + data.file_path, "info");
      return data;
    })
    .catch(function (err) {
      that.pushSystemLog("告警导出失败: " + ((err && err.message) || "未知错误"), "alert");
      throw err;
    });
};

RealtimeStore.prototype.updateAlarmStatus = function (recordId, status, disposalResult) {
  return this.requestApi("/api/alarm-records/" + encodeURIComponent(recordId) + "/status", "POST", {
    status: status,
    disposal_result: disposalResult || ""
  });
};

RealtimeStore.prototype.chatWithAI = function (payload) {
  var that = this;
  var candidates = this.getApiCandidates();
  var path = "/api/ai/chat";

  return new Promise(function (resolve, reject) {
    var idx = 0;

    function next(lastError) {
      if (idx >= candidates.length) {
        reject(lastError || new Error("AI 接口不可用"));
        return;
      }
      var base = candidates[idx];
      idx += 1;

      wx.request({
        url: base + path,
        method: "POST",
        timeout: 30000,
        data: payload || {},
        success: function (res) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            that.currentApiBase = base;
            wx.setStorageSync("apiBase", base);
            resolve(res.data);
          } else {
            var detail = "";
            if (res && res.data && typeof res.data.detail === "string") {
              detail = res.data.detail;
            } else if (res && res.data) {
              try { detail = JSON.stringify(res.data); } catch (e) { detail = ""; }
            }
            next(new Error("HTTP " + res.statusCode + (detail ? ": " + detail.slice(0, 200) : "")));
          }
        },
        fail: function (err) {
          var msg = err && (err.message || err.errMsg);
          next(new Error(msg || "request failed"));
        }
      });
    }

    next();
  });
};

RealtimeStore.prototype.requestHistory = function (roomId) {
  var that = this;
  var key = String(roomId || "global");

  if (!this.socketOpen) {
    this.ensureConnected();
    return Promise.reject(new Error("socket not ready"));
  }

  this.sendControlCommand("request_history", {
    room_id: key
  });

  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      delete that.historyResolvers[key];
      reject(new Error("history timeout"));
    }, 5000);

    that.historyResolvers[key] = {
      resolve: function (data) {
        clearTimeout(timer);
        resolve(data);
      },
      reject: function (err) {
        clearTimeout(timer);
        reject(err || new Error("history failed"));
      }
    };
  });
};

RealtimeStore.prototype.destroy = function () {
  this.safeRemoveSocketListeners();
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  if (this.connectTimeoutTimer) {
    clearTimeout(this.connectTimeoutTimer);
    this.connectTimeoutTimer = null;
  }
  wx.closeSocket();
};

var singleton = null;

function getRealtimeStore() {
  if (!singleton) {
    singleton = new RealtimeStore();
  }
  return singleton;
}

module.exports = {
  getRealtimeStore: getRealtimeStore,
  STATUS_META: STATUS_META,
  pickToneByRoom: pickToneByRoom
};
