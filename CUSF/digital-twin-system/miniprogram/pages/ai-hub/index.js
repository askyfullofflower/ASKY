function formatClock(raw) {
  var dt = raw instanceof Date ? raw : new Date(raw || Date.now());
  if (isNaN(dt.getTime())) {
    dt = new Date();
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

function toNumber(value, fallback) {
  var n = Number(value);
  return isNaN(n) ? fallback : n;
}

function buildComplianceText(t, h) {
  var tOk = t >= 14 && t <= 24;
  var hOk = h >= 45 && h <= 60;
  var tText = tOk ? "温度合规" : (t > 24 ? "温度偏高" : "温度偏低");
  var hText = hOk ? "湿度合规" : (h > 60 ? "湿度偏高" : "湿度偏低");
  return tText + " / " + hText;
}

function pickWsChipClass(wsClass) {
  if (wsClass === "connected") {
    return "acs-chip-normal";
  }
  if (wsClass === "connecting") {
    return "acs-chip-warning";
  }
  return "acs-chip-danger";
}

function extractErrorText(err) {
  var msg = "";
  if (err && typeof err === "string") {
    msg = err;
  } else if (err) {
    msg = String(err.message || err.errMsg || err.detail || "");
  }
  msg = String(msg || "").replace(/^Error:\s*/i, "").trim();
  return msg || "未知错误";
}

Page({
  data: {
    activeRoomId: "",
    wsStatusText: "未连接",
    wsClass: "disconnected",
    wsEndpoint: "ws://localhost:8000/ws",
    wsChipClass: "acs-chip-danger",

    inputText: "",
    isTyping: false,
    scrollToId: "",
    messages: [
      {
        key: "init",
        role: "assistant",
        time: formatClock(new Date()),
        content: "您好，我是 AI 智能中枢。可为你提供微气候分析、趋势预测与设备联动建议。"
      }
    ],

    quickPrompts: [
      "请基于当前微气候生成环境评估报告",
      "请分析当前异常工况并给出处置预案",
      "请预测未来1小时温湿度趋势",
      "请给出在合规前提下的节能优化建议",
      "请评估当前馆藏档案材质老化风险",
      "请生成本月环境合规性报告摘要"
    ],

    prediction: {
      tempTrend: "等待数据",
      nextTemp: "--",
      humTrend: "等待数据",
      nextHum: "--",
      confidence: "--",
      compliance: "等待数据"
    },

    matOptions: [
      "纸质档案（明清古籍、宣纸）",
      "胶片档案（历史照片、微缩胶片）",
      "磁性介质（录音带、硬盘数据）"
    ],
    matIndex: 0,
    isMatRunning: false,
    matResultText: ""
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
    var rooms = state.rooms || [];
    var prediction = state.prediction || {};
    var trendMap = {
      rising: "↑ 上升",
      falling: "↓ 下降",
      stable: "→ 平稳"
    };

    var t = toNumber(state.temperature, 20);
    var h = toNumber(state.humidity, 50);

    this.setData({
      activeRoomId: rooms.length ? rooms[0].id : "",
      wsStatusText: state.wsStatusText,
      wsClass: state.wsClass || "disconnected",
      wsEndpoint: this.store.getWsEndpoint ? this.store.getWsEndpoint() : "ws://localhost:8000/ws",
      wsChipClass: pickWsChipClass(state.wsClass),
      prediction: {
        tempTrend: trendMap[prediction.temp_trend] || "等待数据",
        nextTemp: prediction.next_hour_temp !== undefined ? (prediction.next_hour_temp + "°C") : "--",
        humTrend: trendMap[prediction.humidity_trend] || "等待数据",
        nextHum: prediction.next_hour_humidity !== undefined ? (prediction.next_hour_humidity + "%RH") : "--",
        confidence: prediction.confidence !== undefined ? ((prediction.confidence * 100).toFixed(0) + "%") : "--",
        compliance: buildComplianceText(t, h)
      }
    });
  },

  onInputText: function (event) {
    this.setData({ inputText: String(event && event.detail && event.detail.value || "") });
  },

  onTapQuickPrompt: function (event) {
    var text = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.text || "");
    if (!text) {
      return;
    }
    this.sendAI(text);
  },

  onSend: function () {
    this.sendAI(this.data.inputText || "");
  },

  appendAssistantMessage: function (content) {
    var message = {
      key: "a-" + Date.now(),
      role: "assistant",
      time: formatClock(new Date()),
      content: String(content || "")
    };
    this.setData({
      isTyping: false,
      messages: (this.data.messages || []).concat([message]),
      scrollToId: message.key
    });
  },

  onMatChange: function (event) {
    var idx = Number(event && event.detail && event.detail.value || 0);
    this.setData({ matIndex: idx, matResultText: "" });
  },

  onRunMaterial: function () {
    var that = this;
    if (this.data.isMatRunning) { return; }

    var mat = this.data.matOptions[this.data.matIndex] || this.data.matOptions[0];
    var state = this.store.getState();
    var t = toNumber(state.temperature, 20);
    var h = toNumber(state.humidity, 50);

    var matFull = [
      "纸质档案（如：明清古籍、宣纸、机制纸）",
      "胶片档案（如：历史老照片、微缩胶片、电影胶片）",
      "磁性介质（如：磁带、硬盘、软盘备份）"
    ][this.data.matIndex] || mat;

    this.setData({ isMatRunning: true, matResultText: "Longcat 正在推演材质老化模型..." });

    var sys = "你是一名国家级档案馆文物保护专家。请结合实时数据，运用档案保护学理论，进行档案存放环境健康与退化风险评估。要求：1.分析该材质在当前环境暴露下的特定物理或化学老化退化风险。2.给出1条针对HVAC的紧急调控建议。总字数控制在150字以内，使用精炼专业的客观陈述。纯文本输出，无需Markdown。";
    var usr = "【当前库房微气候实时数据】\n- 平均温度: " + t.toFixed(1) + " ℃\n- 平均湿度: " + h.toFixed(1) + " %\n\n【目标推演材质】\n" + matFull;

    that.store.chatWithAI({
      model: "LongCat-Flash-Chat",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr }
      ],
      temperature: 0.4,
      max_tokens: 400
    })
      .then(function (data) {
        var txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!txt) { throw new Error("模型安全拦截或返回为空"); }
        that.setData({ isMatRunning: false, matResultText: String(txt).trim() });
      })
      .catch(function (err) {
        that.setData({
          isMatRunning: false,
          matResultText: "推演失败：" + extractErrorText(err)
        });
      });
  },

  sendAI: function (rawText) {
    var that = this;
    var text = String(rawText || "").trim();
    if (!text || this.data.isTyping) {
      return;
    }

    var state = this.store.getState();
    var t = toNumber(state.temperature, 20);
    var h = toNumber(state.humidity, 50);
    var eqRows = (state.equipmentItems || []).map(function (item) {
      return "- " + item.name + ": " + item.modeLabel + " (" + item.powerText + ")";
    }).join("\n");
    var anomaly = state.systemNotice || "正常";

    var userMessage = {
      key: "u-" + Date.now(),
      role: "user",
      time: formatClock(new Date()),
      content: text
    };

    var nextMessages = (this.data.messages || []).concat([userMessage]);
    this.setData({
      messages: nextMessages,
      isTyping: true,
      inputText: "",
      scrollToId: userMessage.key
    });

    var sys = "你是档案馆数字孪生系统AI中枢。请基于实时数据给出专业、简明、可执行的建议。"
      + "\\n【实时数据】温度 " + t.toFixed(1) + "℃，湿度 " + h.toFixed(1) + "%RH"
      + "\\n【设备状态】\\n" + (eqRows || "- 暂无设备数据")
      + "\\n【异常状态】" + anomaly
      + "\\n优先返回 JSON：{\"thought\":\"...\",\"action_required\":true/false,\"settings\":{\"ac\":\"off|low|medium|high|unchanged\",\"dehumidifier\":\"off|low|medium|high|unchanged\",\"humidifier\":\"off|low|medium|high|unchanged\",\"ventilation\":\"off|low|medium|high|unchanged\"},\"reply\":\"...\"}。若无法严格 JSON，也至少给出简洁中文建议。";

    var history = nextMessages
      .filter(function (item) {
        return item.role === "user" || item.role === "assistant";
      })
      .map(function (item) {
        return { role: item.role, content: item.content };
      })
      .slice(-12);

    this.store.chatWithAI({
      model: "LongCat-Flash-Chat",
      messages: [{ role: "system", content: sys }].concat(history),
      temperature: 0.2,
      max_tokens: 800
    })
      .then(function (data) {
        var raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!raw) {
          throw new Error("AI 返回为空");
        }

        var cleaned = String(raw).replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
        var result = null;
        try {
          result = JSON.parse(cleaned);
        } catch (e) {
          result = { action_required: false, reply: cleaned };
        }

        if (result.action_required && result.settings) {
          ["ac", "dehumidifier", "humidifier", "ventilation"].forEach(function (device) {
            var level = result.settings[device];
            if (level && level !== "unchanged") {
              that.store.sendControlCommand("set_equipment_mode", { device: device, mode: "manual" });
              that.store.setEquipmentLevel(device, level);
            }
          });
        }

        that.appendAssistantMessage(result.reply || cleaned);
      })
      .catch(function (err) {
        that.appendAssistantMessage("AI 服务暂不可用，请稍后重试。(" + extractErrorText(err) + ")");
      });
  }
});