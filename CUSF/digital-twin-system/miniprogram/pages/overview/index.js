Page({
  data: {
    wsStatusText: "未连接",
    wsClass: "disconnected",
    wsDotClass: "acs-status-dot-danger",
    wsEndpoint: "--",

    statusText: "等待数据",
    statusToneClass: "acs-chip-normal",
    temperature: "--.-",
    humidity: "--.-",
    tempDeltaText: "--",
    humDeltaText: "--",
    tempDeltaClass: "",
    humDeltaClass: "",

    pm25: "--",
    nox: "--",
    waterLeakDetected: false,
    waterLeakLocation: "--",

    summaryChips: [],
    roomCards: [],
    activeRoomId: "",

    latestAlert: null,
    hideAlertBanner: false
  },

  onLoad: function () {
    this.store = getApp().getRealtimeStore();
    this.prevRoomMetricsMap = {};
    this.unsubscribe = this.store.subscribe(this.handleStoreUpdate.bind(this));
    this.store.ensureConnected();
  },

  onUnload: function () {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.prevRoomMetricsMap = null;
  },

  onPullDownRefresh: function () {
    var that = this;
    this.store.ensureConnected();
    this.store.fetchAlarmRecords(120)
      .catch(function () {
        return null;
      })
      .then(function () {
        wx.stopPullDownRefresh();
      });
  },

  handleStoreUpdate: function (state) {
    var normalCount = 0;
    var alertCount = 0;
    var runningCount = 0;
    var roomCards = [];
    var previousRoomMap = this.prevRoomMetricsMap || {};
    var nextRoomMap = {};

    (state.equipmentItems || []).forEach(function (item) {
      if (item.active) {
        runningCount += 1;
      }
    });

    (state.rooms || []).forEach(function (room) {
      var toneClass = "tone-normal";
      var chipClass = "acs-chip-normal";
      if (room.tone === "danger") {
        toneClass = "tone-danger";
        chipClass = "acs-chip-danger";
      } else if (room.tone === "warning") {
        toneClass = "tone-warning";
        chipClass = "acs-chip-warning";
      }

      if (room.tone === "normal") {
        normalCount += 1;
      } else {
        alertCount += 1;
      }

      var tempTrendText = "";
      var humTrendText = "";
      var tempTrendClass = "";
      var humTrendClass = "";
      var roomKey = String(room.id || room.historyId || "");
      var tempValue = Number(room.temperature);
      var humValue = Number(room.humidity);
      var prevMetric = roomKey ? previousRoomMap[roomKey] : null;

      if (prevMetric && !isNaN(tempValue) && !isNaN(humValue)) {
        var tDelta = tempValue - Number(prevMetric.temperature);
        var hDelta = humValue - Number(prevMetric.humidity);
        if (!isNaN(tDelta) && Math.abs(tDelta) > 0.05) {
          tempTrendText = (tDelta > 0 ? "+" : "") + tDelta.toFixed(1) + "°C";
          tempTrendClass = tDelta > 0 ? "trend-up" : "trend-down";
        }
        if (!isNaN(hDelta) && Math.abs(hDelta) > 0.05) {
          humTrendText = (hDelta > 0 ? "+" : "") + hDelta.toFixed(1) + "%";
          humTrendClass = hDelta > 0 ? "trend-up" : "trend-down";
        }
      } else {
        var historyKey = room.historyId || room.id;
        var historyTrend = state.roomHistoryMap ? (state.roomHistoryMap[historyKey] || state.roomHistoryMap[room.id] || []) : [];
        if (historyTrend.length >= 2) {
          var first = historyTrend[0] || {};
          var last = historyTrend[historyTrend.length - 1] || {};
          var histTDelta = Number(last.temperature) - Number(first.temperature);
          var histHDelta = Number(last.humidity) - Number(first.humidity);
          if (!isNaN(histTDelta) && Math.abs(histTDelta) > 0.05) {
            tempTrendText = (histTDelta > 0 ? "+" : "") + histTDelta.toFixed(1) + "°C";
            tempTrendClass = histTDelta > 0 ? "trend-up" : "trend-down";
          }
          if (!isNaN(histHDelta) && Math.abs(histHDelta) > 0.05) {
            humTrendText = (histHDelta > 0 ? "+" : "") + histHDelta.toFixed(1) + "%";
            humTrendClass = histHDelta > 0 ? "trend-up" : "trend-down";
          }
        }
      }

      if (roomKey) {
        nextRoomMap[roomKey] = {
          temperature: tempValue,
          humidity: humValue
        };
      }

      roomCards.push({
        id: room.id,
        historyId: room.historyId,
        name: room.name,
        temperature: room.temperature,
        humidity: room.humidity,
        tempTrendText: tempTrendText,
        humTrendText: humTrendText,
        tempTrendClass: tempTrendClass,
        humTrendClass: humTrendClass,
        statusLabel: room.statusLabel,
        toneClass: toneClass,
        chipClass: chipClass
      });
    });

    this.prevRoomMetricsMap = nextRoomMap;

    var latest = null;
    var records = state.alarmRecords || [];
    for (var i = 0; i < records.length; i += 1) {
      var item = records[i];
      if (String(item.status || "").toLowerCase() !== "resolved") {
        latest = {
          id: item.id,
          reason: item.reason,
          location: item.location,
          level: item.level
        };
        break;
      }
    }

    var statusToneClass = "acs-chip-normal";
    if (state.statusTone === "danger") {
      statusToneClass = "acs-chip-danger";
    } else if (state.statusTone === "warning") {
      statusToneClass = "acs-chip-warning";
    }

    var wsDotClass = "acs-status-dot-danger";
    if (state.wsClass === "connected") {
      wsDotClass = "acs-status-dot-normal";
    } else if (state.wsClass === "connecting") {
      wsDotClass = "acs-status-dot-warning";
    }

    var trend = state.recentTrend || [];
    var tempDeltaText = "--";
    var humDeltaText = "--";
    var tempDeltaClass = "";
    var humDeltaClass = "";
    if (trend.length >= 2) {
      var first = trend[0] || {};
      var last = trend[trend.length - 1] || {};
      var tDelta = Number(last.t) - Number(first.t);
      var hDelta = Number(last.h) - Number(first.h);
      if (!isNaN(tDelta)) {
        tempDeltaText = (tDelta >= 0 ? "+" : "") + tDelta.toFixed(1) + "°C";
        tempDeltaClass = tDelta > 0 ? "trend-up" : (tDelta < 0 ? "trend-down" : "");
      }
      if (!isNaN(hDelta)) {
        humDeltaText = (hDelta >= 0 ? "+" : "") + hDelta.toFixed(1) + "%";
        humDeltaClass = hDelta > 0 ? "trend-up" : (hDelta < 0 ? "trend-down" : "");
      }
    }

    var prevLatestId = this.data.latestAlert && this.data.latestAlert.id ? this.data.latestAlert.id : "";
    var hideAlertBanner = this.data.hideAlertBanner;
    if (latest && latest.id && latest.id !== prevLatestId) {
      hideAlertBanner = false;
    }

    this.setData({
      wsStatusText: state.wsStatusText,
      wsClass: state.wsClass,
      wsDotClass: wsDotClass,
      wsEndpoint: state.wsEndpoint,

      statusText: state.statusText,
      statusToneClass: statusToneClass,
      temperature: state.temperature,
      humidity: state.humidity,
      tempDeltaText: tempDeltaText,
      humDeltaText: humDeltaText,
      tempDeltaClass: tempDeltaClass,
      humDeltaClass: humDeltaClass,

      summaryChips: [
        {
          key: "running",
          label: "运行中: " + runningCount + " 设备",
          className: "acs-chip acs-chip-normal"
        },
        {
          key: "normal",
          label: "正常: " + normalCount + " 区域",
          className: "acs-chip acs-chip-normal"
        },
        {
          key: "alert",
          label: "告警: " + alertCount + " 区域",
          className: alertCount > 0 ? "acs-chip acs-chip-danger" : "acs-chip"
        }
      ],
      roomCards: roomCards,
      activeRoomId: roomCards.length ? roomCards[0].id : "",
      latestAlert: latest,
      hideAlertBanner: hideAlertBanner,

      pm25: state.pm25 !== undefined ? String(state.pm25) : "--",
      nox: state.nox !== undefined ? String(state.nox) : "--",
      waterLeakDetected: !!(state.waterLeak && state.waterLeak.detected),
      waterLeakLocation: (state.waterLeak && state.waterLeak.location) || "--"
    });
  },

  onCloseAlertBanner: function () {
    this.setData({ hideAlertBanner: true });
  },

  onOpenRoomDetail: function (event) {
    var roomId = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id || "");
    if (!roomId) {
      return;
    }
    wx.navigateTo({
      url: "/pages/detail/index?roomId=" + encodeURIComponent(roomId)
    });
  }
});