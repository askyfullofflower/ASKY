function pickTipByStatus(status) {
  if (status === "humidity_alert") {
    return "当前湿度偏高，建议开启除湿以保护档案材料。";
  }
  if (status === "humidity_low_alert") {
    return "当前湿度偏低，建议启动加湿设备保护纸质档案。";
  }
  if (status === "temp_alert") {
    return "当前温度偏高，建议启动降温模式避免材料劣化。";
  }
  if (status === "temp_low_alert") {
    return "当前温度偏低，建议适度升温以防结露。";
  }
  if (status === "cooling_active") {
    return "系统正在自动调控中，请持续观察环境趋势。";
  }
  return "温湿度处于目标区间，可保持当前控制策略。";
}

function powerToLevel(power) {
  var p = Number(power || 0);
  if (p <= 0) {
    return "off";
  }
  if (p <= 35) {
    return "low";
  }
  if (p <= 70) {
    return "medium";
  }
  return "high";
}

function formatTrendClock(raw) {
  var text = String(raw || "");
  if (text.length >= 19) {
    return text.slice(11, 19);
  }
  var dt = new Date(raw);
  if (isNaN(dt.getTime())) {
    return "--:--:--";
  }
  var h = dt.getHours();
  var m = dt.getMinutes();
  var s = dt.getSeconds();
  return (h < 10 ? "0" + h : h)
    + ":"
    + (m < 10 ? "0" + m : m)
    + ":"
    + (s < 10 ? "0" + s : s);
}

function toFiniteNumber(value) {
  var n = Number(value);
  return isNaN(n) ? null : n;
}

function clampRange(minV, maxV, floorPad) {
  var minValue = Number(minV);
  var maxValue = Number(maxV);
  if (isNaN(minValue) || isNaN(maxValue)) {
    return { min: 0, max: 1 };
  }
  if (minValue === maxValue) {
    minValue -= floorPad;
    maxValue += floorPad;
  }
  var span = maxValue - minValue;
  var pad = Math.max(floorPad, span * 0.15);
  return {
    min: minValue - pad,
    max: maxValue + pad
  };
}

function niceNum(range, round) {
  if (range <= 0) { return 1; }
  var exp = Math.floor(Math.log(range) / Math.LN10);
  var frac = range / Math.pow(10, exp);
  var nf;
  if (round) {
    if (frac < 1.5) { nf = 1; }
    else if (frac < 3) { nf = 2; }
    else if (frac < 7) { nf = 5; }
    else { nf = 10; }
  } else {
    if (frac <= 1) { nf = 1; }
    else if (frac <= 2) { nf = 2; }
    else if (frac <= 5) { nf = 5; }
    else { nf = 10; }
  }
  return nf * Math.pow(10, exp);
}

Page({
  data: {
    activeRoomId: "",
    roomTitle: "库房详情",
    roomStatusLabel: "正常",
    roomStatusClass: "acs-chip-normal",
    envTip: "等待实时数据...",

    trendCanvasWidth: 660,
    trendCanvasHeight: 300,

    temperature: "--.-",
    humidity: "--.-",
    tempTrendText: "--",
    humTrendText: "--",

    trendStartTime: "--:--:--",
    trendEndTime: "--:--:--",

    equipmentCards: []
  },

  onLoad: function (options) {
    this.activeRoomId = String(options && options.roomId || "");
    this.lastHistoryKey = "";
    this.lastHistoryAttemptAt = 0;
    this.roomLiveTrendMap = {};

    this.store = getApp().getRealtimeStore();
    this.unsubscribe = this.store.subscribe(this.handleStoreUpdate.bind(this));
    this.store.ensureConnected();
  },

  onReady: function () {
    var that = this;
    wx.createSelectorQuery()
      .in(this)
      .select('.trend-canvas')
      .boundingClientRect(function (rect) {
        if (rect && rect.width > 0 && rect.height > 0) {
          var w = Math.round(rect.width);
          var h = Math.round(rect.height);
          that.setData({ trendCanvasWidth: w, trendCanvasHeight: h }, function () {
            if (that.lastTrendPoints && that.lastTrendPoints.length) {
              that.drawTrend(that.lastTrendPoints);
            }
          });
        }
      })
      .exec();
  },

  onUnload: function () {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.clearDrawTimer();
  },

  onPullDownRefresh: function () {
    var that = this;
    this.store.ensureConnected();

    var tasks = [this.store.fetchAlarmRecords(120)];
    if (this.activeRoomId) {
      tasks.push(this.store.requestHistory(this.activeRoomId));
    }

    Promise.all(tasks)
      .catch(function () {
        return null;
      })
      .then(function () {
        wx.stopPullDownRefresh();
      });
  },

  handleStoreUpdate: function (state) {
    if (!this.roomLiveTrendMap) {
      this.roomLiveTrendMap = {};
    }

    var rooms = state.rooms || [];
    var selected = null;

    if (!this.activeRoomId && rooms.length) {
      this.activeRoomId = rooms[0].id;
    }

    for (var i = 0; i < rooms.length; i += 1) {
      if (rooms[i].id === this.activeRoomId || rooms[i].historyId === this.activeRoomId) {
        selected = rooms[i];
        break;
      }
    }

    if (!selected && rooms.length) {
      selected = rooms[0];
      this.activeRoomId = selected.id;
    }

    if (!selected) {
      return;
    }

    var historyKey = selected.historyId || selected.id;
    var roomHistoryMap = state.roomHistoryMap || {};
    var hasHistory = Array.isArray(roomHistoryMap[historyKey]) && roomHistoryMap[historyKey].length > 0;
    var now = Date.now();
    var needFetch = historyKey && (!hasHistory || historyKey !== this.lastHistoryKey);
    var canRetry = (now - this.lastHistoryAttemptAt) > 1800;

    if (needFetch && canRetry) {
      this.lastHistoryAttemptAt = now;
      this.lastHistoryKey = historyKey;
      this.store.requestHistory(historyKey)
        .then(function () {
          return null;
        })
        .catch(function () {
          return null;
        });
    }

    var historyTrend = roomHistoryMap[historyKey] || roomHistoryMap[selected.id] || [];
    var roomLiveTrend = this.roomLiveTrendMap[selected.id] || [];
    if (!roomLiveTrend.length && Array.isArray(historyTrend) && historyTrend.length) {
      roomLiveTrend = historyTrend.slice(-30).map(function (item) {
        return {
          temperature: item.temperature,
          humidity: item.humidity,
          timestamp: item.timestamp
        };
      });
    }

    var sampleStamp = String(state.lastTimestamp || "");
    if (sampleStamp && sampleStamp !== "--") {
      var lastPoint = roomLiveTrend.length ? roomLiveTrend[roomLiveTrend.length - 1] : null;
      if (!lastPoint || String(lastPoint.timestamp) !== sampleStamp) {
        roomLiveTrend.push({
          temperature: selected.temperature,
          humidity: selected.humidity,
          timestamp: sampleStamp
        });
        if (roomLiveTrend.length > 120) {
          roomLiveTrend = roomLiveTrend.slice(-120);
        }
      }
    }

    this.roomLiveTrendMap[selected.id] = roomLiveTrend;

    var trendData = roomLiveTrend;
    if (!trendData.length && Array.isArray(state.recentTrend)) {
      trendData = state.recentTrend.map(function (item) {
        return {
          temperature: item.t,
          humidity: item.h,
          timestamp: item.ts
        };
      });
    }

    var trendSlice = trendData.slice(-60);
    var tempTrendText = "--";
    var humTrendText = "--";
    var tempTrendClass = "";
    var humTrendClass = "";
    var startTime = "--:--:--";
    var endTime = "--:--:--";
    if (trendSlice.length >= 2) {
      var first = trendSlice[0] || {};
      var last = trendSlice[trendSlice.length - 1] || {};
      var tDelta = Number(last.temperature) - Number(first.temperature);
      var hDelta = Number(last.humidity) - Number(first.humidity);
      if (!isNaN(tDelta)) {
        tempTrendText = (tDelta > 0 ? "+" : "") + tDelta.toFixed(1) + "°C";
        tempTrendClass = tDelta > 0 ? "trend-up" : (tDelta < 0 ? "trend-down" : "");
      }
      if (!isNaN(hDelta)) {
        humTrendText = (hDelta > 0 ? "+" : "") + hDelta.toFixed(1) + "%";
        humTrendClass = hDelta > 0 ? "trend-up" : (hDelta < 0 ? "trend-down" : "");
      }

      startTime = formatTrendClock(first.timestamp);
      endTime = formatTrendClock(last.timestamp);
    }

    var statusClass = "acs-chip-normal";
    if (selected.tone === "danger") {
      statusClass = "acs-chip-danger";
    } else if (selected.tone === "warning") {
      statusClass = "acs-chip-warning";
    }

    var equipmentCards = (state.equipmentItems || []).map(function (item) {
      var level = powerToLevel(item.power);
      return {
        key: item.key,
        name: item.name,
        modeText: item.modeLabel,
        active: item.active,
        activeText: item.active ? "正在运行" : "待机",
        power: item.power,
        powerText: item.powerText,
        levelOptions: [
          { key: "low", label: "低", on: level === "low" },
          { key: "medium", label: "中", on: level === "medium" },
          { key: "high", label: "高", on: level === "high" },
          { key: "off", label: "关", on: level === "off" }
        ]
      };
    });

    this.setData({
      activeRoomId: selected.id,
      roomTitle: selected.name + " 详情",
      roomStatusLabel: selected.statusLabel,
      roomStatusClass: statusClass,
      envTip: pickTipByStatus(selected.status),

      temperature: selected.temperature,
      humidity: selected.humidity,
      tempTrendText: tempTrendText,
      humTrendText: humTrendText,
      tempTrendClass: tempTrendClass,
      humTrendClass: humTrendClass,
      trendStartTime: startTime,
      trendEndTime: endTime,
      equipmentCards: equipmentCards
    });

    this.scheduleDrawTrend(trendSlice);
  },

  clearDrawTimer: function () {
    if (this.drawTimer) {
      clearTimeout(this.drawTimer);
      this.drawTimer = null;
    }
  },

  scheduleDrawTrend: function (points) {
    this.lastTrendPoints = points || [];
    var that = this;
    this.clearDrawTimer();
    this.drawTimer = setTimeout(function () {
      that.drawTrend(points || []);
      that.drawTimer = null;
    }, 8);
  },

  drawTrend: function (points) {
    var ctx = wx.createCanvasContext("trendCanvas", this);
    var W = Number(this.data.trendCanvasWidth || 320);
    var H = Number(this.data.trendCanvasHeight || 260);
    var left = 42;
    var right = 36;
    var top = 14;
    var bottom = 36;
    var plotW = W - left - right;
    var plotH = H - top - bottom;

    ctx.setFillStyle("#f0f3fa");
    ctx.fillRect(0, 0, W, H);
    ctx.setFillStyle("#ffffff");
    ctx.fillRect(left, top, plotW, plotH);

    if (!points || points.length < 2) {
      ctx.setFillStyle("#9098b0");
      ctx.setFontSize(12);
      ctx.setTextAlign("center");
      ctx.fillText("暂无趋势数据", left + plotW / 2, top + plotH / 2 + 4);
      ctx.setTextAlign("left");
      ctx.draw();
      return;
    }

    var normalized = points.map(function (p) {
      return {
        t: toFiniteNumber(p.temperature),
        h: toFiniteNumber(p.humidity),
        ts: String(p.timestamp || "")
      };
    });

    var tempVals = normalized.map(function (p) { return p.t; }).filter(function (n) { return n !== null; });
    var humVals  = normalized.map(function (p) { return p.h; }).filter(function (n) { return n !== null; });

    if (tempVals.length < 2 && humVals.length < 2) {
      ctx.setFillStyle("#9098b0");
      ctx.setFontSize(12);
      ctx.setTextAlign("center");
      ctx.fillText("暂无趋势数据", left + plotW / 2, top + plotH / 2 + 4);
      ctx.setTextAlign("left");
      ctx.draw();
      return;
    }

    function makeAxis(vals, pad) {
      if (!vals.length) { return { min: 0, max: 1, step: 1 }; }
      var lo = Math.min.apply(null, vals);
      var hi = Math.max.apply(null, vals);
      var span = hi - lo || pad;
      var step = niceNum(span / 4, true);
      var mn = Math.floor((lo - step * 0.2) / step) * step;
      var mx = Math.ceil((hi + step * 0.2) / step) * step;
      if (mx <= mn) { mx = mn + step * 4; }
      return { min: mn, max: mx, step: step };
    }

    var tAxis = makeAxis(tempVals, 2);
    var hAxis = makeAxis(humVals, 5);

    function yAtT(v) {
      var r = (v - tAxis.min) / (tAxis.max - tAxis.min);
      return top + plotH * (1 - Math.max(0, Math.min(1, r)));
    }
    function yAtH(v) {
      var r = (v - hAxis.min) / (hAxis.max - hAxis.min);
      return top + plotH * (1 - Math.max(0, Math.min(1, r)));
    }
    function xAt(i) {
      return left + (plotW * i) / Math.max(1, normalized.length - 1);
    }

    /* ---- gridlines (temp axis ticks) ---- */
    var tTicks = Math.max(2, Math.min(6, Math.round((tAxis.max - tAxis.min) / tAxis.step)));
    for (var ti = 0; ti <= tTicks; ti++) {
      var ty = top + plotH * (1 - ti / tTicks);
      ctx.setStrokeStyle("#e8eaf2");
      ctx.setLineWidth(0.8);
      ctx.beginPath();
      ctx.moveTo(left, ty);
      ctx.lineTo(left + plotW, ty);
      ctx.stroke();
    }

    /* ---- left axis labels (temp °C) ---- */
    ctx.setFontSize(11);
    ctx.setFillStyle("#3b7ddd");
    ctx.setTextAlign("right");
    for (var li = 0; li <= tTicks; li++) {
      var tv = tAxis.min + (tAxis.max - tAxis.min) * li / tTicks;
      var ty2 = yAtT(tv);
      var tLabel = (tv % 1 === 0) ? String(Math.round(tv)) : tv.toFixed(1);
      ctx.fillText(tLabel, left - 5, ty2 + 4);
    }

    /* ---- right axis labels (humidity %) ---- */
    var hTicks = Math.max(2, Math.min(6, Math.round((hAxis.max - hAxis.min) / hAxis.step)));
    ctx.setFontSize(11);
    ctx.setFillStyle("#27a36a");
    ctx.setTextAlign("right");
    for (var hi2 = 0; hi2 <= hTicks; hi2++) {
      var hv = hAxis.min + (hAxis.max - hAxis.min) * hi2 / hTicks;
      var hy = yAtH(hv);
      var hLabel = (hv % 1 === 0) ? String(Math.round(hv)) : hv.toFixed(1);
      ctx.fillText(hLabel, W - 2, hy + 4);
    }
    ctx.setTextAlign("left");

    /* ---- x-axis time labels ---- */
    var xLabelN = Math.min(5, normalized.length);
    ctx.setFontSize(10);
    ctx.setFillStyle("#9098b0");
    ctx.setTextAlign("center");
    for (var xi = 0; xi < xLabelN; xi++) {
      var di = Math.round(xi * (normalized.length - 1) / Math.max(1, xLabelN - 1));
      var xt = xAt(di);
      var tsClock = formatTrendClock(normalized[di].ts);
      ctx.fillText(tsClock.slice(0, 5), xt, top + plotH + 16);
    }
    ctx.setTextAlign("left");

    /* ---- helper: build bezier cmd list ---- */
    function makePath(pts) {
      var cmds = [];
      for (var k = 0; k < pts.length; k++) {
        if (k === 0) {
          cmds.push({ m: true, x: pts[0].x, y: pts[0].y });
        } else {
          var p0 = pts[k - 1];
          var p1 = pts[k];
          var cpx = (p0.x + p1.x) / 2;
          cmds.push({ m: false, cp1x: cpx, cp1y: p0.y, cp2x: cpx, cp2y: p1.y, x: p1.x, y: p1.y });
        }
      }
      return cmds;
    }
    function applyPath(c2, cmds) {
      cmds.forEach(function (c) {
        if (c.m) { c2.moveTo(c.x, c.y); }
        else { c2.bezierCurveTo(c.cp1x, c.cp1y, c.cp2x, c.cp2y, c.x, c.y); }
      });
    }

    /* ---- draw one series ---- */
    function drawArea(getValue, getY, lineColor, fillColor, dashed) {
      var pts = [];
      normalized.forEach(function (p, idx) {
        var v = getValue(p);
        if (v !== null) { pts.push({ x: xAt(idx), y: getY(v) }); }
      });
      if (pts.length < 2) { return; }
      var cmds = makePath(pts);

      /* fill */
      ctx.beginPath();
      ctx.moveTo(pts[0].x, top + plotH);
      ctx.lineTo(pts[0].x, pts[0].y);
      for (var ci = 1; ci < cmds.length; ci++) {
        var c = cmds[ci];
        ctx.bezierCurveTo(c.cp1x, c.cp1y, c.cp2x, c.cp2y, c.x, c.y);
      }
      ctx.lineTo(pts[pts.length - 1].x, top + plotH);
      ctx.closePath();
      ctx.setFillStyle(fillColor);
      ctx.fill();

      /* line */
      if (dashed && ctx.setLineDash) { ctx.setLineDash([7, 5]); }
      ctx.setStrokeStyle(lineColor);
      ctx.setLineWidth(2);
      ctx.beginPath();
      applyPath(ctx, cmds);
      ctx.stroke();
      if (dashed && ctx.setLineDash) { ctx.setLineDash([]); }
    }

    drawArea(function (p) { return p.t; }, yAtT, "#3b7ddd", "rgba(59,125,221,0.12)", false);
    drawArea(function (p) { return p.h; }, yAtH, "#27a36a", "rgba(39,163,106,0.12)", true);

    /* ---- border ---- */
    ctx.setStrokeStyle("#dde2ef");
    ctx.setLineWidth(0.8);
    ctx.strokeRect(left, top, plotW, plotH);

    ctx.draw();
  },

  onToggleDevice: function (event) {
    var key = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.key || "");
    if (!key) {
      return;
    }
    this.store.toggleEquipment(key);
  },

  onSetDeviceLevel: function (event) {
    var dataset = event && event.currentTarget && event.currentTarget.dataset;
    var key = String(dataset && dataset.key || "");
    var level = String(dataset && dataset.level || "");
    if (!key || !level) {
      return;
    }
    this.store.setEquipmentLevel(key, level);
  },

  onBack: function () {
    wx.navigateBack({
      fail: function () {
        wx.redirectTo({ url: "/pages/overview/index" });
      }
    });
  }
});