
var STATUS_MAP = {
  normal: { text: '环境正常', css: 'status-normal' },
  temp_alert: { text: '温度超标', css: 'status-temp' },
  temp_low_alert: { text: '温度偏低', css: 'status-temp' },
  humidity_alert: { text: '湿度超标', css: 'status-humidity' },
  humidity_low_alert: { text: '湿度偏低', css: 'status-humidity' },
  cooling_active: { text: '自动降温中', css: 'status-cooling' }
};

Page({
  data: {
    // ----- 实时主指标 -----
    temperature: '--.-',
    humidity: '--.-',
    pm25: '--',
    nox: '--',
    leakText: '--',
    leakClass: 'sp-ok',
    lastTimestamp: '--',

    // ----- 系统状态 -----
    statusText: '等待连接...',
    statusClass: 'status-waiting',
    abnormalCount: 0,
    abnormalCountClass: 'sp-meta-val sp-ok',
    abnormalSummary: '无异常库房',
    anomalyRunning: false,
    anomalyRunningText: '关闭',
    anomalyRunningClass: 'sp-meta-val sp-ok',

    // ----- 连接状态 -----
    wsStatusText: '未连接',
    wsClass: 'conn-disconnected',
    wsEndpoint: '--',
    socketReady: false,

    // ----- 调控按钮状态 -----
    btnDisabled: true,
    coolDownDisabled: true,
    coolBtnClass: 'sp-btn-primary sp-btn-disabled',
    actionDisabled: true,

    // ----- 调控模式 -----
    controlMode: 'auto',
    controlModeText: '自动模式',
    controlModeBadgeClass: 'sp-mode-badge auto',
    modeHintText: '当前为自动模式，系统将根据温湿度自主调控设备',
    modeLoading: false,
    modeSwitchDisabled: true,
    manualBtnClass: 'sp-toggle-btn',
    autoBtnClass: 'sp-toggle-btn on',

    // ----- 设备状态可视化 -----
    equipmentItems: [
      { key: 'ac', name: '空调系统', modeText: '自动待机', modeClass: 'mode-auto', activeText: '待机', powerText: '0%', powerStyle: 'width: 0%;' },
      { key: 'dehumidifier', name: '除湿机', modeText: '自动待机', modeClass: 'mode-auto', activeText: '待机', powerText: '0%', powerStyle: 'width: 0%;' },
      { key: 'humidifier', name: '加湿器', modeText: '自动待机', modeClass: 'mode-auto', activeText: '待机', powerText: '0%', powerStyle: 'width: 0%;' },
      { key: 'ventilation', name: '通风系统', modeText: '自动待机', modeClass: 'mode-auto', activeText: '待机', powerText: '0%', powerStyle: 'width: 0%;' }
    ],

    // ----- 指标脉冲动效 -----
    tempPulseClass: '',
    humiPulseClass: '',
    pm25PulseClass: '',
    noxPulseClass: '',

    // ----- 页面通知 -----
    noticeText: '',
    noticeClass: 'sp-notice info',

    // ----- 报警记录 -----
    alarmRecords: [],
    alarmTotal: 0,
    alarmLoading: false,
    alarmEmpty: true,

    // ----- 操作日志 -----
    logs: []
  },

  // WebSocket 连接实例相关
  socketOpen: false,
  reconnectTimer: null,
  connectTimeoutTimer: null,
  connectAttemptToken: 0,
  wsCandidates: [],
  wsIndex: 0,
  currentWsUrl: '',
  currentApiBase: '',

  // 自动模式运行时
  pendingMode: '',
  previousMode: '',
  modeSwitchTimer: null,
  noticeTimer: null,
  metricPulseTimers: {
    tempPulseClass: null,
    humiPulseClass: null,
    pm25PulseClass: null,
    noxPulseClass: null
  },
  metricSnapshot: {
    temperature: null,
    humidity: null,
    pm25: null,
    nox: null
  },

  mergePayload: function (target, source) {
    var dst = target || {};
    var src = source || {};
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      dst[key] = src[key];
    }
    return dst;
  },

  safeRemoveSocketListeners: function () {
    if (typeof wx.offSocketOpen === 'function') {
      wx.offSocketOpen();
    }
    if (typeof wx.offSocketMessage === 'function') {
      wx.offSocketMessage();
    }
    if (typeof wx.offSocketClose === 'function') {
      wx.offSocketClose();
    }
    if (typeof wx.offSocketError === 'function') {
      wx.offSocketError();
    }
  },

  onLoad: function () {
    try {
      this.addLog('系统初始化...');
      this.initWsCandidates();
      this.connectWebSocket();
    } catch (err) {
      console.error('index onLoad failed:', err);
      this.applyControlState({
        wsStatusText: '初始化异常',
        wsClass: 'conn-disconnected',
        statusText: '初始化失败，请重试',
        statusClass: 'status-alert',
        socketReady: false,
        noticeText: '初始化异常，请在控制台查看日志',
        noticeClass: 'sp-notice alert'
      });
    }
  },

  onUnload: function () {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
    if (this.modeSwitchTimer) {
      clearTimeout(this.modeSwitchTimer);
      this.modeSwitchTimer = null;
    }
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }

    var pulseKeys = Object.keys(this.metricPulseTimers || {});
    for (var i = 0; i < pulseKeys.length; i += 1) {
      var pulseKey = pulseKeys[i];
      if (this.metricPulseTimers[pulseKey]) {
        clearTimeout(this.metricPulseTimers[pulseKey]);
        this.metricPulseTimers[pulseKey] = null;
      }
    }

    this.safeRemoveSocketListeners();
    wx.closeSocket();
  },

  pad2: function (value) {
    var n = Number(value);
    if (isNaN(n)) {
      return '00';
    }
    if (n < 10) {
      return '0' + n;
    }
    return String(n);
  },

  formatTimestamp: function (rawTs) {
    if (!rawTs || rawTs === '--') {
      return '--';
    }
    var dt = new Date(rawTs);
    if (isNaN(dt.getTime())) {
      return rawTs;
    }
    var y = dt.getFullYear();
    var m = this.pad2(dt.getMonth() + 1);
    var d = this.pad2(dt.getDate());
    var hh = this.pad2(dt.getHours());
    var mm = this.pad2(dt.getMinutes());
    var ss = this.pad2(dt.getSeconds());
    return y + '-' + m + '-' + d + ' ' + hh + ':' + mm + ':' + ss;
  },

  formatNumber: function (value, digits, fallback) {
    var n = Number(value);
    if (isNaN(n)) {
      return fallback;
    }
    return n.toFixed(digits);
  },

  getNoticeClass: function (type) {
    if (type === 'alert') {
      return 'sp-notice alert';
    }
    if (type === 'success' || type === 'cool') {
      return 'sp-notice success';
    }
    return 'sp-notice info';
  },

  buildModeUi: function (mode, modeLoading) {
    var m = mode === 'manual' ? 'manual' : 'auto';
    var isManual = m === 'manual';
    var manualClass = 'sp-toggle-btn' + (isManual ? ' on' : '') + (modeLoading ? ' disabled' : '');
    var autoClass = 'sp-toggle-btn' + (isManual ? '' : ' on') + (modeLoading ? ' disabled' : '');
    return {
      controlMode: m,
      controlModeText: isManual ? '手动模式' : '自动模式',
      controlModeBadgeClass: isManual ? 'sp-mode-badge manual' : 'sp-mode-badge auto',
      modeHintText: isManual
        ? '当前为手动模式，你可以直接下发调控指令'
        : '当前为自动模式，系统将根据温湿度自主调控设备',
      manualBtnClass: manualClass,
      autoBtnClass: autoClass
    };
  },

  buildAnomalyUi: function (running) {
    return {
      anomalyRunning: !!running,
      anomalyRunningText: running ? '开启' : '关闭',
      anomalyRunningClass: running ? 'sp-meta-val sp-alert' : 'sp-meta-val sp-ok'
    };
  },

  applyControlState: function (payload) {
    var draft = payload || {};
    var statusClass = draft.statusClass !== undefined ? draft.statusClass : this.data.statusClass;
    var socketReady = draft.socketReady !== undefined ? draft.socketReady : this.data.socketReady;
    var controlMode = draft.controlMode !== undefined ? draft.controlMode : this.data.controlMode;
    var modeLoading = draft.modeLoading !== undefined ? draft.modeLoading : this.data.modeLoading;

    var coolDisabled = statusClass === 'status-cooling' || controlMode === 'auto' || modeLoading || !socketReady;
    draft.btnDisabled = coolDisabled;
    draft.coolDownDisabled = coolDisabled;
    draft.coolBtnClass = coolDisabled ? 'sp-btn-primary sp-btn-disabled' : 'sp-btn-primary';
    draft.actionDisabled = !socketReady;
    draft.modeSwitchDisabled = modeLoading || !socketReady;

    this.setData(draft);
  },

  modeToText: function (mode) {
    return mode === 'manual' ? '手动模式' : '自动模式';
  },

  deviceModeToLabel: function (mode) {
    if (mode === 'manual') {
      return '手动控制';
    }
    if (mode === 'cooling') {
      return '自动制冷';
    }
    if (mode === 'heating') {
      return '自动制热';
    }
    if (mode === 'dehumidifying') {
      return '自动除湿';
    }
    if (mode === 'humidifying') {
      return '自动加湿';
    }
    if (mode === 'ventilating') {
      return '自动通风';
    }
    return '自动待机';
  },

  normalizeEquipmentItems: function (equipmentMap) {
    var order = ['ac', 'dehumidifier', 'humidifier', 'ventilation'];
    var fallbackNames = {
      ac: '空调系统',
      dehumidifier: '除湿机',
      humidifier: '加湿器',
      ventilation: '通风系统'
    };

    var src = equipmentMap || {};
    var items = [];
    var manualCount = 0;

    for (var i = 0; i < order.length; i += 1) {
      var key = order[i];
      var item = src[key] || {};
      var rawMode = String(item.mode || 'standby').toLowerCase();
      var isManual = rawMode === 'manual';
      var power = Number(item.power || 0);
      if (isNaN(power)) {
        power = 0;
      }
      if (power < 0) {
        power = 0;
      }
      if (power > 100) {
        power = 100;
      }

      if (isManual) {
        manualCount += 1;
      }

      items.push({
        key: key,
        name: item.name || fallbackNames[key],
        modeText: isManual ? '手动控制' : this.deviceModeToLabel(rawMode),
        modeClass: isManual ? 'mode-manual' : 'mode-auto',
        activeText: item.active ? '运行中' : '待机',
        powerText: power + '%',
        powerStyle: 'width: ' + power + '%;'
      });
    }

    var mode = 'mixed';
    if (manualCount === items.length) {
      mode = 'manual';
    } else if (manualCount === 0) {
      mode = 'auto';
    }

    return {
      mode: mode,
      items: items,
      manualCount: manualCount,
      total: items.length
    };
  },

  syncEquipmentState: function (equipmentMap) {
    if (!equipmentMap || typeof equipmentMap !== 'object') {
      return;
    }

    var normalized = this.normalizeEquipmentItems(equipmentMap);
    var resolvedMode = normalized.mode === 'mixed'
      ? (this.pendingMode || this.data.controlMode)
      : normalized.mode;

    var nextModeLoading = this.data.modeLoading;
    var isModeConfirmed = false;

    if (this.pendingMode === 'manual') {
      isModeConfirmed = normalized.manualCount === normalized.total;
    } else if (this.pendingMode === 'auto') {
      isModeConfirmed = normalized.manualCount === 0;
    }

    if (this.data.modeLoading && this.pendingMode && isModeConfirmed) {
      nextModeLoading = false;
      this.pendingMode = '';
      this.previousMode = '';
      if (this.modeSwitchTimer) {
        clearTimeout(this.modeSwitchTimer);
        this.modeSwitchTimer = null;
      }
      this.setNotice('调控模式切换完成', 'success', 1800);
    }

    var payload = {
      equipmentItems: normalized.items,
      modeLoading: nextModeLoading
    };
    this.mergePayload(payload, this.buildModeUi(resolvedMode, nextModeLoading));
    this.applyControlState(payload);
  },

  setNotice: function (text, type, duration) {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }

    this.setData({
      noticeText: text || '',
      noticeClass: this.getNoticeClass(type || 'info')
    });

    var ttl = Number(duration || 0);
    if (ttl > 0) {
      var that = this;
      this.noticeTimer = setTimeout(function () {
        that.setData({ noticeText: '' });
        that.noticeTimer = null;
      }, ttl);
    }
  },

  triggerMetricPulse: function (classKey, prev, next) {
    if (prev === null || prev === undefined || isNaN(prev) || isNaN(next) || prev === next) {
      return;
    }

    var cls = next > prev ? 'pulse-up' : 'pulse-down';
    var payload = {};
    payload[classKey] = cls;
    this.setData(payload);

    if (this.metricPulseTimers[classKey]) {
      clearTimeout(this.metricPulseTimers[classKey]);
    }

    var that = this;
    this.metricPulseTimers[classKey] = setTimeout(function () {
      var reset = {};
      reset[classKey] = '';
      that.setData(reset);
      that.metricPulseTimers[classKey] = null;
    }, 260);
  },

  getAbnormalRooms: function (rooms) {
    if (!Array.isArray(rooms)) {
      return [];
    }
    return rooms.filter(function (r) {
      return r && r.status && r.status !== 'normal';
    });
  },

  buildAbnormalSummary: function (rooms) {
    var abnormal = this.getAbnormalRooms(rooms);
    if (!abnormal.length) {
      return { count: 0, summary: '无异常库房' };
    }

    var labels = abnormal.slice(0, 3).map(function (r) {
      return r.name || '未知库房';
    });

    var suffix = abnormal.length > 3 ? ' 等' + abnormal.length + '个库房' : '';
    return {
      count: abnormal.length,
      summary: labels.join('、') + suffix
    };
  },

  resolveRealtimeStatus: function (baseStatus, rooms, leakDetected) {
    if (leakDetected) {
      return { text: '漏水风险告警', css: 'status-alert' };
    }

    var abnormal = this.getAbnormalRooms(rooms);
    var anchorStatus = abnormal.length ? abnormal[0].status : baseStatus;
    var info = STATUS_MAP[anchorStatus] || STATUS_MAP.normal;

    if (!abnormal.length) {
      return info;
    }

    var labels = abnormal.slice(0, 2).map(function (r) {
      return r.name || '未知库房';
    });

    var suffix = abnormal.length > 2 ? ' 等' + abnormal.length + '个库房' : '';
    return {
      text: info.text + ' | 异常库房: ' + labels.join('、') + suffix,
      css: info.css
    };
  },

  roomStatusMeta: function (status) {
    if (status === 'normal') {
      return { text: '正常', css: 'sp-room-normal' };
    }
    if (status === 'temp_alert' || status === 'humidity_alert') {
      return { text: '超标告警', css: 'sp-room-alert' };
    }
    if (status === 'temp_low_alert' || status === 'humidity_low_alert') {
      return { text: '偏低告警', css: 'sp-room-warn' };
    }
    if (status === 'cooling_active') {
      return { text: '调控中', css: 'sp-room-cooling' };
    }
    return { text: '待定', css: 'sp-room-warn' };
  },

  normalizeRooms: function (rooms) {
    if (!Array.isArray(rooms)) {
      return [];
    }

    var that = this;
    return rooms.map(function (item, idx) {
      var t = Number(item && item.temperature);
      var h = Number(item && item.humidity);
      var meta = that.roomStatusMeta(item && item.status);

      return {
        key: String((item && item.id) || (item && item.history_id) || ('room-' + idx)),
        id: String((item && item.id) || (item && item.history_id) || '--'),
        name: (item && item.name) || '未命名库房',
        floor: (item && item.floor) || '--',
        areaText: item && item.area ? String(item.area) + ' m2' : '--',
        temperatureText: isNaN(t) ? '--.-°C' : t.toFixed(1) + '°C',
        humidityText: isNaN(h) ? '--.-%RH' : h.toFixed(1) + '%RH',
        status: (item && item.status) || 'unknown',
        statusText: meta.text,
        statusClass: meta.css
      };
    });
  },

  normalizeLeak: function (waterLeak) {
    var leak = waterLeak || {};
    var risk = Number(leak.risk || 0);
    if (leak.detected) {
      return {
        detected: true,
        text: '告警 (' + risk + '% ' + (leak.location || '未知区域') + ')',
        css: 'sp-alert'
      };
    }

    return {
      detected: false,
      text: '正常 (' + risk + '%)',
      css: 'sp-ok'
    };
  },

  updateFromSensorData: function (data) {
    var rooms = this.normalizeRooms(data.rooms);
    var leak = this.normalizeLeak(data.water_leak);
    var statusInfo = this.resolveRealtimeStatus(data.status, rooms, leak.detected);
    var abnormalInfo = this.buildAbnormalSummary(rooms);

    var t = Number(data.temperature);
    var h = Number(data.humidity);
    var air = data.air_quality || {};
    var pm25 = Number(air.pm25);
    var nox = Number(air.nox);

    this.triggerMetricPulse('tempPulseClass', this.metricSnapshot.temperature, t);
    this.triggerMetricPulse('humiPulseClass', this.metricSnapshot.humidity, h);
    this.triggerMetricPulse('pm25PulseClass', this.metricSnapshot.pm25, pm25);
    this.triggerMetricPulse('noxPulseClass', this.metricSnapshot.nox, nox);

    this.metricSnapshot = {
      temperature: isNaN(t) ? this.metricSnapshot.temperature : t,
      humidity: isNaN(h) ? this.metricSnapshot.humidity : h,
      pm25: isNaN(pm25) ? this.metricSnapshot.pm25 : pm25,
      nox: isNaN(nox) ? this.metricSnapshot.nox : nox
    };

    var abnormalClass = abnormalInfo.count > 0 ? 'sp-meta-val sp-alert' : 'sp-meta-val sp-ok';
    var payload = {
      temperature: isNaN(t) ? '--.-' : t.toFixed(1),
      humidity: isNaN(h) ? '--.-' : h.toFixed(1),
      pm25: this.formatNumber(air.pm25, 1, '--'),
      nox: this.formatNumber(air.nox, 3, '--'),
      leakText: leak.text,
      leakClass: leak.css,
      lastTimestamp: this.formatTimestamp(data.timestamp),
      statusText: statusInfo.text,
      statusClass: statusInfo.css,
      abnormalCount: abnormalInfo.count,
      abnormalCountClass: abnormalClass,
      abnormalSummary: abnormalInfo.summary
    };

    this.applyControlState(payload);

    if (data.equipment) {
      this.syncEquipmentState(data.equipment);
    }
  },

  normalizeAlarmRecords: function (records) {
    if (!Array.isArray(records)) {
      return [];
    }

    return records.slice(0, 120).map(function (item, idx) {
      var resolved = item && item.status === 'resolved';
      return {
        key: String((item && item.id) || ('alarm-' + idx)),
        alarmTime: (item && item.alarm_time) || '--',
        location: (item && item.location) || '未知',
        source: (item && item.source) || '系统',
        level: (item && item.level) || '一般',
        reason: (item && item.reason) || '--',
        disposalResult: (item && item.disposal_result) || '待处置',
        resolvedTime: (item && item.resolved_time) || '',
        statusText: resolved ? '已处置' : '处理中',
        statusClass: resolved ? 'resolved' : 'active'
      };
    });
  },

  setAlarmRecords: function (records, total) {
    var normalized = this.normalizeAlarmRecords(records);
    this.setData({
      alarmRecords: normalized,
      alarmTotal: Number(total) || normalized.length,
      alarmEmpty: normalized.length === 0
    });
  },

  normalizeApiBase: function (v) {
    return String(v || '').trim().replace(/\/+$/, '');
  },

  wsToApiBase: function (wsUrl) {
    var u = String(wsUrl || '').trim();
    if (!u) {
      return '';
    }
    u = u.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    u = u.replace(/\/ws(\?.*)?$/i, '');
    return this.normalizeApiBase(u);
  },

  getApiCandidates: function () {
    var candidates = [];
    var that = this;

    function add(v) {
      var base = that.normalizeApiBase(v);
      if (base && candidates.indexOf(base) === -1) {
        candidates.push(base);
      }
    }

    add(this.currentApiBase);
    add(this.wsToApiBase(this.currentWsUrl));

    (this.wsCandidates || []).forEach(function (wsUrl) {
      add(that.wsToApiBase(wsUrl));
    });

    add('http://127.0.0.1:8000');
    add('http://localhost:8000');

    return candidates;
  },

  requestApi: function (path, method) {
    var that = this;
    var apiCandidates = this.getApiCandidates();

    return new Promise(function (resolve, reject) {
      var idx = 0;

      function next(lastError) {
        if (idx >= apiCandidates.length) {
          reject(lastError || new Error('无法连接后端接口'));
          return;
        }

        var base = apiCandidates[idx];
        idx += 1;

        wx.request({
          url: base + path,
          method: method || 'GET',
          timeout: 8000,
          success: function (res) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              that.currentApiBase = base;
              resolve(res.data);
            } else {
              next(new Error('HTTP ' + res.statusCode));
            }
          },
          fail: function (err) {
            next(err || new Error('请求失败'));
          }
        });
      }

      next();
    });
  },

  fetchAlarmRecords: function (showToast) {
    var that = this;
    this.setData({ alarmLoading: true });

    return this.requestApi('/api/alarm-records?limit=120', 'GET')
      .then(function (data) {
        var records = Array.isArray(data && data.records) ? data.records : [];
        that.setAlarmRecords(records, data && data.total);
        if (showToast) {
          that.addLog('报警记录已刷新', 'cool');
          wx.showToast({ title: '已刷新', icon: 'none' });
        }
      })
      .catch(function (err) {
        var msg = (err && err.message) || '请求失败';
        that.addLog('报警记录刷新失败: ' + msg, 'alert');
        if (showToast) {
          wx.showToast({ title: '刷新失败', icon: 'none' });
        }
      })
      .then(function () {
        that.setData({ alarmLoading: false });
      });
  },

  onRefreshAlarmRecords: function () {
    this.fetchAlarmRecords(true);
  },

  onExportAlarmRecords: function () {
    var that = this;
    this.requestApi('/api/alarm-records/export-local?t=' + Date.now(), 'POST')
      .then(function (data) {
        if (!data || !data.ok || !data.file_path) {
          throw new Error('导出接口返回异常');
        }
        that.addLog('报警记录已导出: ' + data.file_path, 'cool');
        wx.showModal({
          title: '导出成功',
          content: data.file_path,
          showCancel: false
        });
      })
      .catch(function (err) {
        var msg = (err && err.message) || '导出失败';
        that.addLog('报警记录导出失败: ' + msg, 'alert');
        wx.showToast({ title: '导出失败', icon: 'none' });
      });
  },

  initWsCandidates: function () {
    var candidates = [];
    var savedUrl = wx.getStorageSync('wsUrl');
    var savedHost = wx.getStorageSync('backendHost');

    if (savedUrl && typeof savedUrl === 'string') {
      candidates.push(savedUrl.trim());
    }

    if (savedHost && typeof savedHost === 'string') {
      var host = savedHost.trim();
      if (host) {
        if (host.indexOf('ws://') === 0 || host.indexOf('wss://') === 0) {
          if (host.lastIndexOf('/ws') !== host.length - 3) {
            host = host.replace(/\/+$/, '') + '/ws';
          }
          candidates.push(host);
        } else {
          candidates.push('ws://' + host + ':8000/ws');
        }
      }
    }

    candidates.push('ws://10.202.8.236:8000/ws');
    candidates.push('ws://127.0.0.1:8000/ws');
    candidates.push('ws://localhost:8000/ws');

    var unique = [];
    candidates.forEach(function (u) {
      if (u && unique.indexOf(u) === -1) {
        unique.push(u);
      }
    });

    this.wsCandidates = unique;
    this.wsIndex = 0;
  },

  tryNextWsEndpoint: function (reason, token) {
    if (token && token !== this.connectAttemptToken) {
      return;
    }

    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }

    var that = this;
    if (this.wsIndex < this.wsCandidates.length - 1) {
      this.wsIndex += 1;
      var nextUrl = this.wsCandidates[this.wsIndex];
      if (reason) {
        this.addLog(reason, 'alert');
      }
      this.addLog('切换地址: ' + nextUrl, 'alert');
      setTimeout(function () {
        that.connectWebSocket();
      }, 600);
      return;
    }

    this.applyControlState({
      wsStatusText: '连接失败',
      wsClass: 'conn-disconnected',
      socketReady: false
    });

    if (reason) {
      this.addLog(reason, 'alert');
    }
    this.addLog('所有地址均连接失败，请确认后端已启动且手机与电脑同网段', 'alert');
    this.addLog('可在控制台执行: wx.setStorageSync("backendHost","你的局域网IP")', 'alert');
    this.setNotice('连接失败，请检查后端服务与局域网配置', 'alert', 2600);
  },

  connectWebSocket: function () {
    var that = this;
    this.connectAttemptToken += 1;
    var token = this.connectAttemptToken;

    if (!this.wsCandidates || this.wsCandidates.length === 0) {
      this.initWsCandidates();
    }

    var wsUrl = this.wsCandidates[this.wsIndex] || 'ws://127.0.0.1:8000/ws';
    this.currentWsUrl = wsUrl;

    this.applyControlState({
      wsStatusText: '连接中...',
      wsClass: 'conn-connecting',
      socketReady: false
    });
    this.addLog('尝试连接: ' + wsUrl);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }

    wx.closeSocket();
    if (typeof wx.offSocketOpen === 'function') {
      this.safeRemoveSocketListeners();
    }

    wx.connectSocket({
      url: wsUrl,
      header: { 'content-type': 'application/json' },
      fail: function () {
        that.tryNextWsEndpoint('connectSocket 调用失败', token);
      }
    });

    this.connectTimeoutTimer = setTimeout(function () {
      if (token !== that.connectAttemptToken || that.socketOpen) {
        return;
      }
      that.socketOpen = false;
      wx.closeSocket();
      that.tryNextWsEndpoint('连接超时: ' + wsUrl, token);
    }, 5000);

    wx.onSocketOpen(function () {
      if (token !== that.connectAttemptToken) {
        return;
      }

      that.socketOpen = true;
      that.currentApiBase = that.wsToApiBase(wsUrl);

      if (that.connectTimeoutTimer) {
        clearTimeout(that.connectTimeoutTimer);
        that.connectTimeoutTimer = null;
      }

      that.wsIndex = that.wsCandidates.indexOf(wsUrl);
      wx.setStorageSync('wsUrl', wsUrl);

      that.applyControlState({
        wsStatusText: '已连接',
        wsClass: 'conn-connected',
        wsEndpoint: wsUrl,
        socketReady: true
      });

      that.addLog('WebSocket 已连接: ' + wsUrl);
      that.fetchAlarmRecords(false);
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

      if (data.type === 'init_history') {
        if (Array.isArray(data.alarm_records)) {
          that.setAlarmRecords(data.alarm_records, data.alarm_records.length);
        }
        if (data.equipment) {
          that.syncEquipmentState(data.equipment);
        }
        that.addLog('收到初始化数据');
        return;
      }

      if (data.type === 'sensor_data') {
        that.updateFromSensorData(data);

        if (Array.isArray(data.alarm_records)) {
          that.setAlarmRecords(data.alarm_records, data.alarm_records.length);
        }

        that.addLog('T:' + data.temperature + '°C H:' + data.humidity + '%RH [' + (data.status || 'normal') + ']');
        return;
      }

      if (data.type === 'equipment_status') {
        if (data.equipment) {
          that.syncEquipmentState(data.equipment);
        }
        that.addLog('设备状态已同步');
        return;
      }

      if (data.type === 'system_status') {
        if (data.control_active && data.action === 'cool_down') {
          var activePayload = {
            statusText: '自动降温中',
            statusClass: 'status-cooling'
          };
          that.mergePayload(activePayload, that.buildAnomalyUi(false));
          that.applyControlState(activePayload);
          that.addLog('降温指令已激活: ' + (data.message || ''), 'cool');
          that.setNotice('降温调控进行中', 'info', 1500);
          return;
        }

        if (!data.control_active && data.action === 'cool_down') {
          that.applyControlState({
            statusText: '环境正常',
            statusClass: 'status-normal'
          });
          that.addLog('调控完成: ' + (data.message || ''), 'cool');
          that.setNotice('降温调控已完成', 'success', 1600);
          return;
        }

        var running = data.action && data.action.indexOf('inject_') === 0;
        that.applyControlState(that.buildAnomalyUi(running));
        that.addLog(data.message || '系统状态变更', running ? 'alert' : '');
      }
    });

    wx.onSocketClose(function () {
      if (token !== that.connectAttemptToken) {
        return;
      }

      var wasOpen = that.socketOpen;
      that.socketOpen = false;

      if (that.connectTimeoutTimer) {
        clearTimeout(that.connectTimeoutTimer);
        that.connectTimeoutTimer = null;
      }

      that.applyControlState({
        wsStatusText: '已断开',
        wsClass: 'conn-disconnected',
        socketReady: false
      });

      if (wasOpen) {
        that.addLog('WebSocket 已断开，5秒后重连...', 'alert');
        that.reconnectTimer = setTimeout(function () {
          that.connectWebSocket();
        }, 5000);
      }
    });

    wx.onSocketError(function () {
      if (token !== that.connectAttemptToken) {
        return;
      }
      that.socketOpen = false;
      that.tryNextWsEndpoint('连接错误: ' + (that.currentWsUrl || 'unknown'), token);
    });
  },

  sendControlCommand: function (action, pendingLog, logType, extraPayload) {
    if (!this.socketOpen) {
      wx.showToast({ title: '未连接服务器', icon: 'none' });
      return false;
    }

    var that = this;
    var payload = {
      type: 'control_command',
      action: action
    };

    if (extraPayload && typeof extraPayload === 'object') {
      var extraKeys = Object.keys(extraPayload);
      for (var i = 0; i < extraKeys.length; i += 1) {
        var key = extraKeys[i];
        payload[key] = extraPayload[key];
      }
    }

    wx.sendSocketMessage({
      data: JSON.stringify(payload),
      success: function () {
        if (pendingLog) {
          that.addLog(pendingLog, logType || '');
        }
      },
      fail: function () {
        wx.showToast({ title: '指令发送失败', icon: 'none' });
      }
    });

    return true;
  },

  onSwitchControlMode: function (e) {
    var mode = e && e.currentTarget && e.currentTarget.dataset
      ? e.currentTarget.dataset.mode
      : '';

    if (mode !== 'manual' && mode !== 'auto') {
      return;
    }

    if (this.data.modeLoading) {
      wx.showToast({ title: '模式切换中', icon: 'none' });
      return;
    }

    if (mode === this.data.controlMode) {
      wx.showToast({ title: '当前已是该模式', icon: 'none' });
      return;
    }

    if (!this.socketOpen) {
      wx.showToast({ title: '未连接服务器', icon: 'none' });
      this.setNotice('连接中断，无法切换模式', 'alert', 2200);
      return;
    }

    var modeText = this.modeToText(mode);
    var devices = ['ac', 'dehumidifier', 'humidifier', 'ventilation'];

    if (this.modeSwitchTimer) {
      clearTimeout(this.modeSwitchTimer);
      this.modeSwitchTimer = null;
    }

    this.previousMode = this.data.controlMode;
    this.pendingMode = mode;

    var switchingPayload = {
      modeLoading: true
    };
    this.mergePayload(switchingPayload, this.buildModeUi(mode, true));
    this.applyControlState(switchingPayload);

    this.setNotice('正在切换至' + modeText + '...', 'info', 0);
    this.addLog('发起模式切换: ' + modeText, 'cool');

    for (var i = 0; i < devices.length; i += 1) {
      this.sendControlCommand('set_equipment_mode', '', '', {
        device: devices[i],
        mode: mode
      });
    }

    var that = this;
    this.modeSwitchTimer = setTimeout(function () {
      if (!that.data.modeLoading) {
        return;
      }

      var fallbackMode = that.previousMode || 'auto';
      that.pendingMode = '';
      that.previousMode = '';

      var timeoutPayload = {
        modeLoading: false
      };
      that.mergePayload(timeoutPayload, that.buildModeUi(fallbackMode, false));
      that.applyControlState(timeoutPayload);

      that.setNotice('模式切换超时，请稍后重试', 'alert', 2400);
      that.addLog('模式切换超时: ' + modeText, 'alert');
      that.modeSwitchTimer = null;
    }, 4200);
  },

  onPullDownRefresh: function () {
    var that = this;
    this.setNotice('正在刷新数据...', 'info', 1200);

    if (!this.socketOpen) {
      this.addLog('连接中断，尝试自动重连', 'alert');
      this.connectWebSocket();
    }

    this.fetchAlarmRecords(false)
      .catch(function () {
        return null;
      })
      .then(function () {
        wx.stopPullDownRefresh();
      });
  },

  onCoolDown: function () {
    this.sendControlCommand('cool_down', '降温指令已发送，等待后端响应...', 'cool');
    this.applyControlState({});
  },

  onInjectCold: function () {
    this.sendControlCommand('inject_cold', '异常注入: 寒潮模拟 (全馆低温)', 'alert');
  },

  onInjectRain: function () {
    this.sendControlCommand('inject_rain', '异常注入: 梅雨模拟 (全馆高湿)', 'alert');
  },

  onInjectDry: function () {
    this.sendControlCommand('inject_dry', '异常注入: 干燥模拟 (全馆低湿)', 'alert');
  },

  onInjectFire: function () {
    this.sendControlCommand('inject_fire', '异常注入: 火灾模拟 (局部高温)', 'alert');
  },

  onInjectGas: function () {
    this.sendControlCommand('inject_gas', '异常注入: 有害气体模拟 (PM2.5/氮氧化物升高)', 'alert');
  },

  onInjectLeak: function () {
    this.sendControlCommand('inject_leak', '异常注入: 漏水模拟 (局部渗漏)', 'alert');
  },

  onInjectOutlier: function () {
    this.sendControlCommand('inject_outlier', '异常注入: 越界样本 (鲁棒性测试)', 'alert');
  },

  onStopAnomaly: function () {
    this.sendControlCommand('stop_anomaly', '异常注入: 清除所有异常', 'cool');
  },

  addLog: function (msg, type) {
    var now = new Date();
    var timeStr = this.pad2(now.getHours()) + ':' + this.pad2(now.getMinutes()) + ':' + this.pad2(now.getSeconds());

    var logs = (this.data.logs || []).slice();
    logs.unshift({
      text: '[' + timeStr + '] ' + msg,
      type: type || ''
    });

    if (logs.length > 80) {
      logs = logs.slice(0, 80);
    }

    this.setData({ logs: logs });
  }
});
