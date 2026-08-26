System.register([], function (_export, _context) {
  "use strict";

  var snapshot;

  var DEFAULT_SNAPSHOT = {
    version: 1,
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
          { agentId: "code", displayName: "Code", role: "executor", score: 30 },
          { agentId: "judge", displayName: "Judge", role: "judge", score: 91 },
          { agentId: "arbiter", displayName: "Arbiter", role: "arbiter", score: 90 }
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
          { agentId: "kimi", displayName: "Kimi", role: "researcher", score: 91 }
        ]
      }
    ]
  };

  function isSnapshot(value) {
    return Boolean(value && typeof value === "object" && value.version === 1
      && Array.isArray(value.desks)
      && value.desks.every(function (desk) {
        return Boolean(desk && typeof desk.taskId === "string"
          && typeof desk.title === "string"
          && Array.isArray(desk.agents)
          && (desk.status === "in_progress" || desk.status === "completed"));
      }));
  }

  function setLayer(node, cc) {
    node.layer = cc.Layers.Enum.UI_2D;
    return node;
  }

  function addLabel(cc, parent, text, fontSize, color, x, y, width) {
    var node = setLayer(new cc.Node("label:" + text.slice(0, 16)), cc);
    node.setParent(parent);
    node.setPosition(x, y, 1);
    node.addComponent(cc.UITransform).setContentSize(width || 900, Math.max(28, fontSize * 1.5));
    var label = node.addComponent(cc.Label);
    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = Math.ceil(fontSize * 1.25);
    label.color = color;
    label.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
    label.verticalAlign = cc.Label.VerticalAlign.CENTER;
    label.overflow = cc.Label.Overflow.SHRINK;
    label.useSystemFont = true;
    return node;
  }

  function drawPanel(cc, parent, width, height, fill, x, y, radius, stroke) {
    var graphics = parent.getComponent(cc.Graphics) || parent.addComponent(cc.Graphics);
    graphics.clear();
    graphics.fillColor = fill;
    graphics.roundRect(x - width / 2, y - height / 2, width, height, radius);
    graphics.fill();
    if (stroke) {
      graphics.strokeColor = stroke;
      graphics.lineWidth = 2;
      graphics.roundRect(x - width / 2, y - height / 2, width, height, radius);
      graphics.stroke();
    }
  }

  function createDesk(cc, parent, desk, x, y, width, height, zh) {
    var node = setLayer(new cc.Node("desk:" + desk.taskId), cc);
    node.setParent(parent);
    node.setPosition(x, y, 0);
    node.addComponent(cc.UITransform).setContentSize(width, height);
    var border = desk.status === "completed" ? new cc.Color(57, 211, 139) : new cc.Color(255, 180, 84);
    drawPanel(cc, node, width, height, new cc.Color(15, 35, 61, 252), 0, 0, 18, border);
    node.on(cc.Node.EventType.TOUCH_END, function () {
      window.parent.postMessage({ type: "agent-market.office.select-desk.v1", taskId: desk.taskId }, window.location.origin);
    });

    addLabel(cc, node, desk.title, 20, new cc.Color(236, 244, 255), 0, height / 2 - 36, width - 36);
    addLabel(
      cc,
      node,
      desk.category + " · "
        + (desk.status === "completed" ? (zh ? "已完成" : "COMPLETED") : (zh ? "进行中" : "IN PROGRESS"))
        + " · " + (desk.isOwner ? (zh ? "我的桌子" : "MY DESK") : (zh ? "可串门" : "VISIT")),
      11,
      border,
      0,
      height / 2 - 67,
      width - 36
    );
    addLabel(cc, node, desk.tags.slice(0, 4).map(function (tag) { return "#" + tag; }).join("  "), 10, new cc.Color(139, 172, 201), 0, height / 2 - 92, width - 36);

    var seats = desk.agents.slice(0, 4);
    var spacing = Math.min(92, (width - 54) / Math.max(1, seats.length));
    seats.forEach(function (agent, index) {
      var agentNode = setLayer(new cc.Node("agent:" + agent.agentId), cc);
      agentNode.setParent(node);
      var originalX = (index - (seats.length - 1) / 2) * spacing;
      agentNode.setPosition(originalX, -34, 0);
      agentNode.addComponent(cc.UITransform).setContentSize(62, 88);
      var body = setLayer(new cc.Node("body"), cc);
      body.setParent(agentNode);
      body.addComponent(cc.UITransform).setContentSize(50, 54);
      drawPanel(cc, body, 50, 54, new cc.Color(64, 199, 224), 0, 0, 16, new cc.Color(163, 244, 255));
      addLabel(cc, body, agent.displayName.slice(0, 2).toUpperCase(), 12, new cc.Color(5, 29, 43), 0, 2, 44);
      addLabel(cc, agentNode, agent.role, 9, new cc.Color(170, 190, 217), 0, -39, 86);
      cc.tween(agentNode)
        .repeatForever(cc.tween()
          .to(1.15 + index * 0.08, { position: new cc.Vec3(originalX, -27, 0) })
          .to(1.15, { position: new cc.Vec3(originalX, -34, 0) }))
        .start();
    });
  }

  function render(cc, root) {
    var width = Math.max(360, window.innerWidth || 1440);
    var height = Math.max(620, Math.min(980, window.innerHeight || 900));
    cc.view.setDesignResolutionSize(width, height, cc.ResolutionPolicy.EXACT_FIT);
    var transform = root.getComponent(cc.UITransform) || root.addComponent(cc.UITransform);
    transform.setContentSize(width, height);
    root.removeAllChildren();

    drawPanel(cc, root, width, height, new cc.Color(7, 16, 31, 255), 0, 0, 0);
    drawPanel(cc, root, width - 28, height - 28, new cc.Color(11, 29, 51, 245), 0, 0, 22);
    var zh = snapshot.locale !== "en";
    addLabel(cc, root, zh ? "星宝任务办公室" : "Star Agent Task Office", 28, new cc.Color(231, 247, 255), 0, height / 2 - 54, width - 60);
    addLabel(cc, root, zh ? "一张桌子代表一个任务 · 动画不是任务权威状态" : "One desk per task · animation is not authoritative state", 13, new cc.Color(125, 219, 235), 0, height / 2 - 88, width - 60);

    if (snapshot.desks.length === 0) {
      addLabel(cc, root, zh ? "当前筛选下没有任务桌" : "No task desks in this filter", 20, new cc.Color(167, 181, 207), 0, 0, width - 60);
      return;
    }

    var columns = width < 760 ? 1 : Math.min(2, snapshot.desks.length);
    var gap = 24;
    var deskWidth = Math.min(620, (width - 56 - gap * (columns - 1)) / columns);
    var deskHeight = width < 760 ? 210 : 250;
    var startY = height / 2 - 145;
    snapshot.desks.slice(0, 6).forEach(function (desk, index) {
      var col = index % columns;
      var row = Math.floor(index / columns);
      var totalWidth = columns * deskWidth + (columns - 1) * gap;
      var x = -totalWidth / 2 + deskWidth / 2 + col * (deskWidth + gap);
      var y = startY - row * (deskHeight + gap) - deskHeight / 2;
      createDesk(cc, root, desk, x, y, deskWidth, deskHeight, zh);
    });
  }

  function startOffice(cc) {
    snapshot = DEFAULT_SNAPSHOT;
    var scene = new cc.Scene("AgentMarketOffice");

    var cameraNode = new cc.Node("Camera");
    cameraNode.setParent(scene);
    cameraNode.setPosition(0, 0, 1000);
    var camera = cameraNode.addComponent(cc.Camera);
    camera.projection = cc.Camera.ProjectionType.ORTHO;
    camera.orthoHeight = 450;
    camera.visibility = cc.Layers.Enum.UI_2D;

    var canvasNode = setLayer(new cc.Node("Canvas"), cc);
    canvasNode.setParent(scene);
    canvasNode.addComponent(cc.UITransform).setContentSize(1280, 900);
    var canvas = canvasNode.addComponent(cc.Canvas);
    canvas.cameraComponent = camera;

    var root = setLayer(new cc.Node("OfficeRoot"), cc);
    root.setParent(canvasNode);
    root.setPosition(0, 0, 0);
    root.addComponent(cc.UITransform).setContentSize(1280, 900);

    window.addEventListener("message", function (event) {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      var message = event.data || {};
      if (message.type !== "agent-market.office.snapshot.v1" || !isSnapshot(message.payload)) return;
      snapshot = message.payload;
      render(cc, root);
    });

    cc.director.runSceneImmediate(scene);
    render(cc, root);
    window.parent.postMessage({ type: "agent-market.office.ready.v1" }, window.location.origin);
  }

  return {
    setters: [],
    execute: function () {
      _export("startOffice", startOffice);
    }
  };
});
