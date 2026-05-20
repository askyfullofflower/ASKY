Page({
  data: {
    activeRoomId: "",
    wsStatusText: "未连接",
    wsClass: "disconnected",
    mode: "auto",
    modeText: "自动模式",
    modeHint: "当前为自动模式，系统将根据阈值自动调控",

    sceneButtons: [
      { 
        key: "dehumidify", 
        title: "一键除湿", 
        circleBg: "transparent",
        icon: "/images/scenes/dehumidify.png"
      },
      { 
        key: "constant", 
        title: "恒温模式", 
        circleBg: "transparent",
        icon: "/images/scenes/constant.png"
      },
      { 
        key: "ventilate", 
        title: "强力换气", 
        circleBg: "transparent",
        icon: "/images/scenes/ventilate.png"
      },
      { 
        key: "shutdown", 
        title: "全区关闭", 
        circleBg: "transparent",
        icon: "/images/scenes/shutdown.png"
      }
    ],

    anomalyButtons: [
      { action: "inject_fire", title: "火灾模拟", subtitle: "局部高温", tone: "anomaly-fire", symbol: "🔥", textColor: "#f87171" },
      { action: "inject_cold", title: "寒潮模拟", subtitle: "全馆低温", tone: "anomaly-cold", symbol: "❄", textColor: "#3b82f6" },
      { action: "inject_rain", title: "梅雨模拟", subtitle: "全馆高湿", tone: "anomaly-rain", symbol: "🌧", textColor: "#fbbf24" },
      { action: "inject_dry", title: "空气干燥模拟", subtitle: "全馆低湿", tone: "anomaly-dry", symbol: "💨", textColor: "#1f2937" },
      { action: "inject_leak", title: "漏水模拟", subtitle: "局部渗漏", tone: "anomaly-leak", symbol: "💧", textColor: "#3b82f6" },
      { action: "inject_gas", title: "有害气体注入", subtitle: "PM2.5/氮氧化物", tone: "anomaly-gas", symbol: "☣", textColor: "#fbbf24" },
      { action: "inject_outlier", title: "异常数据注入", subtitle: "越界样本", tone: "anomaly-outlier", symbol: "⚠", textColor: "#ef4444" }
    ],

    systemLogs: []
  },

  onLoad: function () {
    this.store = getApp().getRealtimeStore();
    this.unsubscribe = this.store.subscribe(this.handleStoreUpdate.bind(this));
    this.store.ensureConnected();
  },

  onUnload: function () {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
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
    var mode = state.controlMode === "manual" ? "manual" : "auto";
    var modeText = mode === "manual" ? "手动模式" : "自动模式";
    var modeHint = mode === "manual"
      ? "当前为手动模式，你可直接控制每台设备"
      : "当前为自动模式，系统将根据阈值自动调控";

    var rooms = state.rooms || [];
    var activeRoomId = rooms.length ? rooms[0].id : "";
    var logs = (state.systemLogs || []).map(function (item, idx) {
      var toneClass = item && item.tone === "alert" ? "log-alert" : "log-info";
      return {
        key: item && item.key || ("log-" + idx),
        time: item && item.time || "--:--:--",
        text: item && item.text || "",
        toneClass: toneClass
      };
    });

    this.setData({
      activeRoomId: activeRoomId,
      wsStatusText: state.wsStatusText,
      wsClass: state.wsClass,
      mode: mode,
      modeText: modeText,
      modeHint: modeHint,
      systemLogs: logs
    });
  },

  onSwitchMode: function (event) {
    var mode = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.mode || "");
    if (mode !== "auto" && mode !== "manual") {
      return;
    }
    var ok = this.store.setControlMode(mode);
    wx.showToast({
      title: ok ? "模式切换指令已发送" : "未连接服务器，正在重连",
      icon: "none"
    });
  },

  onSceneTap: function (event) {
    var scene = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.scene || "");
    if (!scene) {
      return;
    }
    var ok = this.store.runScene(scene);
    wx.showToast({
      title: ok ? "场景指令已发送" : "未连接服务器，正在重连",
      icon: "none"
    });
  },

  onInjectAnomaly: function (event) {
    var action = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.action || "");
    if (!action) {
      return;
    }
    var ok = this.store.injectAnomaly(action);
    wx.showToast({
      title: ok ? "异常注入指令已发送" : "未连接服务器，正在重连",
      icon: "none"
    });
  },

  onStopAnomaly: function () {
    var ok = this.store.stopAnomaly();
    wx.showToast({
      title: ok ? "异常清除指令已发送" : "未连接服务器，正在重连",
      icon: "none"
    });
  }
});