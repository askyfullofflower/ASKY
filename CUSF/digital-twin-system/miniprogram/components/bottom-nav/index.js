Component({
  properties: {
    current: {
      type: String,
      value: "overview"
    },
    detailRoomId: {
      type: String,
      value: ""
    }
  },

  data: {
    tabs: [
      {
        key: "overview",
        label: "概览",
        icon: "/images/dilan/screen_2.png",
        iconActive: "/images/dilan/screen_1.png"
      },
      {
        key: "detail",
        label: "详情",
       icon: "/images/dilan/screen.png",
        iconActive: "/images/dilan/screen_4.png"
      },
      {
        key: "control",
        label: "调控",
        icon: "/images/dilan/screen_6.png",
        iconActive: "/images/dilan/screen_7.png"
      },
      {
        key: "ai-hub",
        label: "AI中枢",
        icon: "/images/dilan/screen_8.png",
        iconActive: "/images/dilan/screen_9.png"
      },
      {
        key: "alerts",
        label: "告警",
        icon: "/images/dilan/screen_5.png",
        iconActive: "/images/dilan/screen_3.png"
      }
    ]
  },


  methods: {
    onTapTab: function (event) {
      var key = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.key || "");
      if (!key || key === this.data.current) {
        return;
      }

      var url = this.resolveUrl(key);
      if (!url) {
        return;
      }

      wx.redirectTo({
        url: url,
        fail: function () {
          wx.reLaunch({ url: url });
        }
      });
    },

    resolveUrl: function (key) {
      if (key === "overview") {
        return "/pages/overview/index";
      }
      if (key === "detail") {
        var roomId = String(this.data.detailRoomId || "").trim();
        return roomId
          ? "/pages/detail/index?roomId=" + encodeURIComponent(roomId)
          : "/pages/detail/index";
      }
      if (key === "control") {
        return "/pages/control/index";
      }
      if (key === "ai-hub") {
        return "/pages/ai-hub/index";
      }
      if (key === "alerts") {
        return "/pages/alerts/index";
      }
      return "";
    }
  }
});
