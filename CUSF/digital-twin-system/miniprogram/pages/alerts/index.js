function mapLevelStyle(level) {
  if (level === "严重") {
    return {
      barClass: "level-bar-danger",
      chipClass: "acs-chip acs-chip-danger"
    };
  }
  if (level === "较高") {
    return {
      barClass: "level-bar-warning",
      chipClass: "acs-chip acs-chip-warning"
    };
  }
  return {
    barClass: "level-bar-normal",
    chipClass: "acs-chip"
  };
}

Page({
  data: {
    activeRoomId: "",
    totalCount: 0,

    selectedLevel: "all",
    selectedStatus: "all",

    levelFilters: [
      { key: "all", label: "全部" },
      { key: "严重", label: "严重" },
      { key: "较高", label: "较高" },
      { key: "一般", label: "一般" }
    ],
    statusFilters: [
      { key: "all", label: "全部状态" },
      { key: "active", label: "未处理" },
      { key: "resolved", label: "已处理" }
    ],

    displayRecords: []
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
    this.store.fetchAlarmRecords(180)
      .catch(function () {
        return null;
      })
      .then(function () {
        wx.stopPullDownRefresh();
      });
  },

  handleStoreUpdate: function (state) {
    var rooms = state.rooms || [];
    this.latestState = state;

    this.setData({
      activeRoomId: rooms.length ? rooms[0].id : "",
      totalCount: state.alarmTotal || (state.alarmRecords || []).length
    });

    this.applyFilter(state);
  },

  applyFilter: function (state) {
    var source = state || this.latestState || { alarmRecords: [] };
    var level = this.data.selectedLevel;
    var status = this.data.selectedStatus;

    var filtered = (source.alarmRecords || []).filter(function (item) {
      var levelPass = level === "all" || item.level === level;
      var statusPass = false;
      if (status === "all") {
        statusPass = true;
      } else if (status === "resolved") {
        statusPass = String(item.status || "").toLowerCase() === "resolved";
      } else {
        statusPass = String(item.status || "").toLowerCase() !== "resolved";
      }
      return levelPass && statusPass;
    }).map(function (item) {
      var tone = mapLevelStyle(item.level);
      var resolved = String(item.status || "").toLowerCase() === "resolved";
      return {
        id: item.id,
        level: item.level,
        alarmTime: item.alarmTime,
        location: item.location,
        reason: item.reason,
        source: item.source,
        disposalResult: item.disposalResult,
        resolvedTime: item.resolvedTime,
        statusText: resolved ? "已处理" : "未处理",
        statusClass: resolved ? "status-ok" : "status-pending",
        barClass: tone.barClass,
        levelClass: tone.chipClass,
        resolved: resolved
      };
    });

    this.setData({
      displayRecords: filtered
    });
  },

  onSelectLevel: function (event) {
    var level = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.level || "all");
    this.setData({ selectedLevel: level });
    this.applyFilter();
  },

  onSelectStatus: function (event) {
    var status = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.status || "all");
    this.setData({ selectedStatus: status });
    this.applyFilter();
  },

  onExport: function () {
    var that = this;
    wx.showLoading({ title: "导出中...", mask: true });
    this.store.exportAlarmRecordsLocal()
      .then(function (data) {
        wx.hideLoading();
        wx.showToast({
          title: "导出成功",
          icon: "success"
        });
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({
          title: "导出失败",
          icon: "none"
        });
      });
  },

  onProcessAlarm: function (event) {
    var id = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id || "");
    if (!id) {
      return;
    }

    var that = this;
    this.store.updateAlarmStatus(id, "resolved", "移动端已确认处理")
      .then(function () {
        wx.showToast({
          title: "已更新为已处理",
          icon: "none"
        });
        return that.store.fetchAlarmRecords(180);
      })
      .catch(function () {
        wx.showToast({
          title: "处理失败，请稍后再试",
          icon: "none"
        });
      });
  }
});