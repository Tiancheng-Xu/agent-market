System.register([], function (_export) {
  "use strict";

  var snapshot;
  var textures = {};
  var DESIGN_WIDTH = 1440;
  var DESIGN_HEIGHT = 900;
  var ATLAS_COLUMNS = 8;
  var ATLAS_ROWS = 4;
  var DESK_SLOTS = [
    { x: -270, y: 118 },
    { x: 150, y: 118 },
    { x: -270, y: -185 },
    { x: 150, y: -185 }
  ];
  var DEFAULT_SNAPSHOT = {
    version: 2,
    locale: "zh-CN",
    statusFilter: "all",
    desks: [
      {
        taskId: "task-office-build",
        title: "Agent Market 工作流",
        category: "Code",
        tags: ["langgraph", "gates"],
        status: "in_progress",
        isOwner: true,
        agents: [
          { agentId: "code", displayName: "Code", role: "executor", score: 30, activity: "working" },
          { agentId: "judge", displayName: "Judge", role: "judge", score: 91, activity: "reviewing" },
          { agentId: "arbiter", displayName: "Arbiter", role: "arbiter", score: 90, activity: "thinking" }
        ]
      },
      {
        taskId: "task-research-brief",
        title: "市场架构研究",
        category: "Research",
        tags: ["research", "citations"],
        status: "completed",
        isOwner: false,
        agents: [
          { agentId: "kimi", displayName: "Kimi", role: "researcher", score: 91, activity: "done" }
        ]
      }
    ]
  };

  function isSnapshot(value) {
    var activities = ["idle", "walking", "thinking", "working", "reviewing", "waiting", "done", "failed", "offline"];
    return Boolean(value && typeof value === "object" && value.version === 2
      && Array.isArray(value.desks)
      && value.desks.every(function (desk) {
        return Boolean(desk && typeof desk.taskId === "string"
          && typeof desk.title === "string"
          && Array.isArray(desk.agents)
          && desk.agents.every(function (agent) { return activities.indexOf(agent.activity) >= 0; })
          && (desk.status === "in_progress" || desk.status === "completed"));
      }));
  }

  function setLayer(node, cc) {
    node.layer = cc.Layers.Enum.UI_2D;
    return node;
  }

  function addLabel(cc, parent, text, fontSize, color, x, y, width, align) {
    var node = setLayer(new cc.Node("label:" + text.slice(0, 16)), cc);
    node.setParent(parent);
    node.setPosition(x, y, 4);
    node.addComponent(cc.UITransform).setContentSize(width || 300, Math.max(28, fontSize * 1.6));
    var label = node.addComponent(cc.Label);
    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = Math.ceil(fontSize * 1.25);
    label.color = color;
    label.horizontalAlign = align === "left" ? cc.Label.HorizontalAlign.LEFT : cc.Label.HorizontalAlign.CENTER;
    label.verticalAlign = cc.Label.VerticalAlign.CENTER;
    label.overflow = cc.Label.Overflow.SHRINK;
    label.useSystemFont = true;
    return node;
  }

  function addPanel(cc, parent, width, height, fill, x, y, radius, stroke, z) {
    var node = setLayer(new cc.Node("panel"), cc);
    node.setParent(parent);
    node.setPosition(x, y, z || 1);
    node.addComponent(cc.UITransform).setContentSize(width, height);
    var graphics = node.addComponent(cc.Graphics);
    graphics.fillColor = fill;
    graphics.roundRect(-width / 2, -height / 2, width, height, radius);
    graphics.fill();
    if (stroke) {
      graphics.strokeColor = stroke;
      graphics.lineWidth = 2;
      graphics.roundRect(-width / 2, -height / 2, width, height, radius);
      graphics.stroke();
    }
    return node;
  }

  function loadTexture(cc, url) {
    return new Promise(function (resolve, reject) {
      cc.assetManager.loadRemote(url, { ext: ".png" }, function (error, imageAsset) {
        if (error) return reject(error);
        var texture = new cc.Texture2D();
        texture.image = imageAsset;
        resolve(texture);
      });
    });
  }

  function fullFrame(cc, texture) {
    var frame = new cc.SpriteFrame();
    frame.texture = texture;
    return frame;
  }

  function atlasFrame(cc, texture, row, column) {
    var cellWidth = texture.width / ATLAS_COLUMNS;
    var cellHeight = texture.height / ATLAS_ROWS;
    var frame = new cc.SpriteFrame();
    frame.texture = texture;
    frame.rect = new cc.Rect(column * cellWidth, (ATLAS_ROWS - row - 1) * cellHeight, cellWidth, cellHeight);
    frame.originalSize = new cc.Size(cellWidth, cellHeight);
    frame.offset = new cc.Vec2(0, 0);
    return frame;
  }

  function roleRow(agent) {
    var value = (agent.role + " " + agent.agentId).toLowerCase();
    if (/arbiter|synth|final/.test(value)) return 2;
    if (/judge|review|research/.test(value)) return 1;
    if (/image|visual|asset/.test(value)) return 3;
    return 0;
  }

  function activityColumn(activity) {
    return {
      idle: 0,
      walking: 2,
      thinking: 3,
      working: 4,
      reviewing: 5,
      waiting: 0,
      done: 6,
      failed: 7,
      offline: 7
    }[activity] || 0;
  }

  function activityText(activity, zh) {
    var zhText = { idle: "休息中", walking: "前往任务桌", thinking: "思考中", working: "执行中", reviewing: "验收中", waiting: "等待中", done: "已完成", failed: "需要处理", offline: "离线" };
    var enText = { idle: "Idle", walking: "Going to desk", thinking: "Thinking", working: "Working", reviewing: "Reviewing", waiting: "Waiting", done: "Done", failed: "Needs help", offline: "Offline" };
    return (zh ? zhText : enText)[activity] || activity;
  }

  function createBackground(cc, root) {
    if (!textures.background) {
      addPanel(cc, root, DESIGN_WIDTH, DESIGN_HEIGHT, new cc.Color(255, 247, 230), 0, 0, 0, null, 0);
      return;
    }
    var node = setLayer(new cc.Node("CozyOfficeBackground"), cc);
    node.setParent(root);
    node.setPosition(0, 0, 0);
    node.addComponent(cc.UITransform).setContentSize(DESIGN_WIDTH, DESIGN_HEIGHT);
    var sprite = node.addComponent(cc.Sprite);
    sprite.spriteFrame = fullFrame(cc, textures.background);
    sprite.sizeMode = cc.Sprite.SizeMode.CUSTOM;
  }

  function animateAgent(cc, node, activity, targetX, targetY, index) {
    var opacity = node.addComponent(cc.UIOpacity);
    opacity.opacity = activity === "offline" ? 100 : 255;
    if (activity === "walking") {
      node.setPosition(-545, 30 - index * 18, 8);
      cc.tween(node).to(1.4 + index * 0.18, { position: new cc.Vec3(targetX, targetY, 8) }, { easing: "sineInOut" }).start();
      return;
    }
    node.setPosition(targetX, targetY, 8);
    if (activity === "thinking" || activity === "working" || activity === "reviewing") {
      cc.tween(node).repeatForever(
        cc.tween().to(0.85 + index * 0.08, { scale: new cc.Vec3(1.03, 0.98, 1) })
          .to(0.85, { scale: new cc.Vec3(1, 1, 1) })
      ).start();
    } else if (activity === "done") {
      cc.tween(node).repeatForever(
        cc.tween().to(0.55, { position: new cc.Vec3(targetX, targetY + 10, 8) }, { easing: "quadOut" })
          .to(0.55, { position: new cc.Vec3(targetX, targetY, 8) }, { easing: "quadIn" })
          .delay(1.2)
      ).start();
    } else {
      cc.tween(node).repeatForever(
        cc.tween().to(1.4, { position: new cc.Vec3(targetX, targetY + 4, 8) })
          .to(1.4, { position: new cc.Vec3(targetX, targetY, 8) })
      ).start();
    }
  }

  function createAgent(cc, parent, agent, x, y, zh, index) {
    var node = setLayer(new cc.Node("agent:" + agent.agentId), cc);
    node.setParent(parent);
    node.addComponent(cc.UITransform).setContentSize(76, 76);
    if (textures.atlas) {
      var sprite = node.addComponent(cc.Sprite);
      sprite.spriteFrame = atlasFrame(cc, textures.atlas, roleRow(agent), activityColumn(agent.activity));
      sprite.sizeMode = cc.Sprite.SizeMode.CUSTOM;
      node.getComponent(cc.UITransform).setContentSize(76, 76);
    } else {
      addPanel(cc, node, 30, 30, new cc.Color(246, 196, 83), 0, 0, 12, new cc.Color(23, 58, 75), 1);
      addLabel(cc, node, "★", 16, new cc.Color(23, 58, 75), 0, 0, 28);
    }
    var bubble = addPanel(cc, node, 68, 20, new cc.Color(255, 250, 240, 238), 0, 38, 10, new cc.Color(23, 58, 75, 170), 7);
    addLabel(cc, bubble, agent.displayName + " · " + activityText(agent.activity, zh), 7, new cc.Color(23, 58, 75), 0, 0, 64);
    animateAgent(cc, node, agent.activity, x, y, index);
  }

  function createDesk(cc, root, desk, slot, index, zh) {
    var statusColor = desk.status === "completed" ? new cc.Color(85, 158, 111) : new cc.Color(219, 141, 64);
    var hit = addPanel(cc, root, 350, 235, new cc.Color(255, 255, 255, 5), slot.x, slot.y, 24, desk.isOwner ? new cc.Color(246, 196, 83, 150) : new cc.Color(127, 166, 139, 110), 2);
    hit.on(cc.Node.EventType.TOUCH_END, function () {
      window.parent.postMessage({ type: "agent-market.office.select-desk.v2", taskId: desk.taskId }, window.location.origin);
    });
    var title = addPanel(cc, root, 290, 48, new cc.Color(255, 250, 240, 244), slot.x, slot.y + 126, 18, statusColor, 12);
    addLabel(cc, title, desk.title, 15, new cc.Color(23, 58, 75), 0, 8, 270);
    addLabel(cc, title, (desk.isOwner ? (zh ? "我的任务桌" : "MY DESK") : (zh ? "公开任务桌" : "PUBLIC DESK")) + " · " + (desk.status === "completed" ? (zh ? "已完成" : "DONE") : (zh ? "进行中" : "ACTIVE")), 9, statusColor, 0, -12, 270);
    var seats = desk.agents.slice(0, 3);
    seats.forEach(function (agent, agentIndex) {
      createAgent(cc, root, agent, slot.x + (agentIndex - (seats.length - 1) / 2) * 76, slot.y - 54, zh, index * 3 + agentIndex);
    });
  }

  function render(cc, root) {
    cc.view.setDesignResolutionSize(DESIGN_WIDTH, DESIGN_HEIGHT, cc.ResolutionPolicy.SHOW_ALL);
    var transform = root.getComponent(cc.UITransform) || root.addComponent(cc.UITransform);
    transform.setContentSize(DESIGN_WIDTH, DESIGN_HEIGHT);
    root.removeAllChildren();
    createBackground(cc, root);
    var zh = snapshot.locale !== "en";
    var heading = addPanel(cc, root, 620, 68, new cc.Color(255, 250, 240, 242), 0, 395, 24, new cc.Color(246, 196, 83, 180), 20);
    addLabel(cc, heading, zh ? "星宝 Agent 动态办公室" : "StarBuddy Agent Office", 24, new cc.Color(23, 58, 75), 0, 10, 580);
    addLabel(cc, heading, zh ? "任务状态驱动动画 · 动画不替代任务与链上证据" : "Task state drives animation · visuals never replace evidence", 10, new cc.Color(89, 118, 112), 0, -18, 580);
    if (snapshot.desks.length === 0) {
      var empty = addPanel(cc, root, 520, 96, new cc.Color(255, 250, 240, 240), 0, 0, 24, new cc.Color(127, 166, 139), 20);
      addLabel(cc, empty, zh ? "当前筛选下没有任务桌" : "No task desks in this filter", 20, new cc.Color(23, 58, 75), 0, 0, 480);
      return;
    }
    snapshot.desks.slice(0, DESK_SLOTS.length).forEach(function (desk, index) {
      createDesk(cc, root, desk, DESK_SLOTS[index], index, zh);
    });
    addLabel(cc, root, zh ? "休息区" : "LOUNGE", 11, new cc.Color(121, 92, 57), -540, 78, 120);
    addLabel(cc, root, zh ? "终审角" : "FINAL REVIEW", 11, new cc.Color(255, 247, 230), 520, -235, 150);
  }

  function startOffice(cc) {
    console.info("agent-market.office.runtime.start");
    document.documentElement.dataset.officeRuntime = "starting";
    snapshot = DEFAULT_SNAPSHOT;
    var scene = new cc.Scene("AgentMarketOffice");
    var cameraNode = new cc.Node("Camera");
    cameraNode.setParent(scene);
    cameraNode.setPosition(0, 0, 1000);
    var camera = cameraNode.addComponent(cc.Camera);
    camera.projection = cc.Camera.ProjectionType.ORTHO;
    camera.orthoHeight = DESIGN_HEIGHT / 2;
    camera.visibility = cc.Layers.Enum.UI_2D;
    var canvasNode = setLayer(new cc.Node("Canvas"), cc);
    canvasNode.setParent(scene);
    canvasNode.addComponent(cc.UITransform).setContentSize(DESIGN_WIDTH, DESIGN_HEIGHT);
    var canvas = canvasNode.addComponent(cc.Canvas);
    canvas.cameraComponent = camera;
    var root = setLayer(new cc.Node("OfficeRoot"), cc);
    root.setParent(canvasNode);
    root.addComponent(cc.UITransform).setContentSize(DESIGN_WIDTH, DESIGN_HEIGHT);

    window.addEventListener("message", function (event) {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      var message = event.data || {};
      if (message.type !== "agent-market.office.snapshot.v2" || !isSnapshot(message.payload)) return;
      snapshot = message.payload;
      render(cc, root);
    });
    window.addEventListener("resize", function () { render(cc, root); });
    cc.director.runSceneImmediate(scene);
    Promise.all([
      loadTexture(cc, "/office-cocos/art/starbuddy-office-background.png"),
      loadTexture(cc, "/office-cocos/art/starbuddy-agent-atlas.png")
    ]).then(function (loaded) {
      console.info("agent-market.office.assets.ready");
      document.documentElement.dataset.officeRuntime = "ready";
      textures.background = loaded[0];
      textures.atlas = loaded[1];
      render(cc, root);
    }).catch(function () {
      console.warn("agent-market.office.assets.degraded");
      document.documentElement.dataset.officeRuntime = "degraded";
      render(cc, root);
    }).finally(function () {
      window.parent.postMessage({ type: "agent-market.office.ready.v2" }, window.location.origin);
    });
    render(cc, root);
  }

  return {
    setters: [],
    execute: function () { _export("startOffice", startOffice); }
  };
});
