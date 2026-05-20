/**
 * 小程序全局入口
 * 必须存在于 miniprogram 根目录，否则真机调试会报 app.js not found。
 */
var realtimeStoreModule = null;
var realtimeStoreLoadError = null;
var fallbackStore = null;

function cloneJSON(data) {
  try {
    return JSON.parse(JSON.stringify(data));
  } catch (e) {
    return {};
  }
}

function formatError(err) {
  if (!err) {
    return "未知异常";
  }
  if (typeof err === "string") {
    return err;
  }
  if (err && err.message) {
    return String(err.message);
  }
  try {
    return JSON.stringify(err);
  } catch (e) {
    return String(err);
  }
}

function buildFallbackState() {
  return {
    wsStatusText: "未连接",
    wsClass: "disconnected",
    wsEndpoint: "--",
    socketReady: false,

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

function createFallbackStore() {
  if (fallbackStore) {
    return fallbackStore;
  }

  var state = buildFallbackState();
  fallbackStore = {
    getState: function () {
      return cloneJSON(state);
    },
    subscribe: function (listener) {
      if (typeof listener === "function") {
        try {
          listener(cloneJSON(state));
        } catch (e) {
          console.warn("fallback listener error", e);
        }
      }
      return function () {};
    },
    ensureConnected: function () {},
    fetchAlarmRecords: function () { return Promise.resolve([]); },
    requestHistory: function () { return Promise.resolve([]); },
    chatWithAI: function () { return Promise.reject(new Error("实时服务未就绪")); },
    setControlMode: function () { return false; },
    runScene: function () { return false; },
    injectAnomaly: function () { return false; },
    stopAnomaly: function () { return false; },
    toggleEquipment: function () { return false; },
    setEquipmentLevel: function () { return false; },
    exportAlarmRecordsLocal: function () { return Promise.reject(new Error("实时服务未就绪")); },
    updateAlarmStatus: function () { return Promise.reject(new Error("实时服务未就绪")); }
  };

  return fallbackStore;
}

function loadRealtimeStoreModule() {
  if (realtimeStoreModule || realtimeStoreLoadError) {
    return realtimeStoreModule;
  }
  try {
    realtimeStoreModule = require("./utils/realtime-store");
  } catch (err) {
    realtimeStoreLoadError = err;
    console.error("load realtime-store failed:", err);
  }
  return realtimeStoreModule;
}

App({
  onLaunch() {
    this.initRealtimeStore("onLaunch");
  },

  onShow() {
    this.initRealtimeStore("onShow");
  },

  initRealtimeStore(source) {
    if (!this.realtimeStore) {
      var moduleRef = loadRealtimeStoreModule();
      if (moduleRef && typeof moduleRef.getRealtimeStore === "function") {
        try {
          this.realtimeStore = moduleRef.getRealtimeStore();
          this.globalData.startupError = "";
        } catch (err) {
          console.error("getRealtimeStore failed:", err);
          this.globalData.startupError = formatError(err);
        }
      }
    }

    if (!this.realtimeStore) {
      this.realtimeStore = createFallbackStore();
      if (!this.globalData.startupError) {
        this.globalData.startupError = formatError(realtimeStoreLoadError);
      }
    }

    // 避免在 onLaunch 首帧触发连接导致启动阶段异常；页面 onLoad/onShow 会继续确保连接。
    if (source === "onLaunch") {
      return;
    }

    if (this.realtimeStore && typeof this.realtimeStore.ensureConnected === "function") {
      try {
        this.realtimeStore.ensureConnected();
      } catch (err) {
        console.error("ensureConnected failed:", err);
        this.globalData.startupError = formatError(err);
      }
    }
  },

  getRealtimeStore() {
    if (!this.realtimeStore) {
      this.initRealtimeStore("getRealtimeStore");
    }
    if (!this.realtimeStore) {
      this.realtimeStore = createFallbackStore();
    }
    return this.realtimeStore;
  },

  getStartupError() {
    return this.globalData.startupError || "";
  },

  globalData: {
    appName: "档案馆环境监控",
    startupError: ""
  }
});
