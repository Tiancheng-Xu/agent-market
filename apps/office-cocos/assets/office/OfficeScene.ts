import {
  _decorator,
  Color,
  Component,
  Graphics,
  Label,
  Node,
  ResolutionPolicy,
  UITransform,
  Vec3,
  tween,
  view,
} from "cc";

const { ccclass } = _decorator;

type AgentSeat = { agentId: string; displayName: string; role: string; score: number };
type OfficeDesk = {
  taskId: string;
  title: string;
  category: string;
  tags: string[];
  status: "in_progress" | "completed";
  agents: AgentSeat[];
  isOwner: boolean;
};
type OfficeSnapshot = {
  version: 1;
  locale?: "zh-CN" | "en";
  statusFilter: "all" | "in_progress" | "completed";
  desks: OfficeDesk[];
};

const DEFAULT_SNAPSHOT: OfficeSnapshot = {
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
        { agentId: "arbiter", displayName: "Arbiter", role: "arbiter", score: 90 },
      ],
    },
    {
      taskId: "task-research-brief",
      title: "市场架构研究",
      category: "Research",
      tags: ["research", "citations"],
      status: "completed",
      isOwner: false,
      agents: [{ agentId: "kimi", displayName: "Kimi", role: "researcher", score: 91 }],
    },
  ],
};

function isSnapshot(value: unknown): value is OfficeSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<OfficeSnapshot>;
  return snapshot.version === 1 && Array.isArray(snapshot.desks)
    && snapshot.desks.every((desk) => desk && typeof desk.taskId === "string"
      && typeof desk.title === "string" && Array.isArray(desk.agents)
      && (desk.status === "in_progress" || desk.status === "completed"));
}

@ccclass("OfficeScene")
export class OfficeScene extends Component {
  private snapshot: OfficeSnapshot = DEFAULT_SNAPSHOT;
  private readonly onResize = () => this.render();
  private readonly onHostMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const message = event.data as { type?: string; payload?: unknown };
    if (message?.type !== "agent-market.office.snapshot.v1" || !isSnapshot(message.payload)) return;
    this.snapshot = message.payload;
    this.render();
  };

  start() {
    window.addEventListener("message", this.onHostMessage);
    window.addEventListener("resize", this.onResize);
    this.render();
    window.parent.postMessage({ type: "agent-market.office.ready.v1" }, window.location.origin);
  }

  onDestroy() {
    window.removeEventListener("message", this.onHostMessage);
    window.removeEventListener("resize", this.onResize);
  }

  private render() {
    const width = Math.max(360, window.innerWidth || 1440);
    const height = Math.max(620, Math.min(980, window.innerHeight || 900));
    view.setDesignResolutionSize(width, height, ResolutionPolicy.EXACT_FIT);
    const transform = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
    transform.setContentSize(width, height);
    this.node.setPosition(width / 2, height / 2, 0);
    this.node.removeAllChildren();

    this.drawPanel(this.node, width, height, new Color(7, 16, 31, 255), 0, 0, 0);
    this.drawPanel(this.node, width - 28, height - 28, new Color(11, 29, 51, 245), 0, 0, 22);

    const zh = this.snapshot.locale !== "en";
    this.addLabel(this.node, zh ? "星宝任务办公室" : "Star Agent Task Office", 28, new Color(231, 247, 255), 0, height / 2 - 54);
    this.addLabel(
      this.node,
      zh ? "一张桌子代表一个任务 · 动画不是任务权威状态" : "One desk per task · animation is not authoritative state",
      13,
      new Color(125, 219, 235),
      0,
      height / 2 - 88,
    );

    if (this.snapshot.desks.length === 0) {
      this.addLabel(this.node, zh ? "当前筛选下没有任务桌" : "No task desks in this filter", 20, new Color(167, 181, 207), 0, 0);
      return;
    }

    const columns = width < 760 ? 1 : Math.min(2, this.snapshot.desks.length);
    const gap = 24;
    const deskWidth = Math.min(620, (width - 56 - gap * (columns - 1)) / columns);
    const deskHeight = width < 760 ? 210 : 250;
    const startY = height / 2 - 145;
    this.snapshot.desks.slice(0, 6).forEach((desk, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const totalWidth = columns * deskWidth + (columns - 1) * gap;
      const x = -totalWidth / 2 + deskWidth / 2 + col * (deskWidth + gap);
      const y = startY - row * (deskHeight + gap) - deskHeight / 2;
      this.createDesk(desk, x, y, deskWidth, deskHeight, zh);
    });
  }

  private createDesk(desk: OfficeDesk, x: number, y: number, width: number, height: number, zh: boolean) {
    const node = new Node(`desk:${desk.taskId}`);
    node.setParent(this.node);
    node.setPosition(x, y, 0);
    node.addComponent(UITransform).setContentSize(width, height);
    const border = desk.status === "completed" ? new Color(57, 211, 139) : new Color(255, 180, 84);
    this.drawPanel(node, width, height, new Color(15, 35, 61, 252), 0, 0, 18, border);
    node.on(Node.EventType.TOUCH_END, () => {
      window.parent.postMessage({ type: "agent-market.office.select-desk.v1", taskId: desk.taskId }, window.location.origin);
    });

    this.addLabel(node, desk.title, 20, new Color(236, 244, 255), 0, height / 2 - 36, width - 36);
    this.addLabel(
      node,
      `${desk.category} · ${desk.status === "completed" ? (zh ? "已完成" : "COMPLETED") : (zh ? "进行中" : "IN PROGRESS")} · ${desk.isOwner ? (zh ? "我的桌子" : "MY DESK") : (zh ? "可串门" : "VISIT")}`,
      11,
      border,
      0,
      height / 2 - 67,
      width - 36,
    );
    this.addLabel(node, desk.tags.slice(0, 4).map((tag) => `#${tag}`).join("  "), 10, new Color(139, 172, 201), 0, height / 2 - 92, width - 36);

    const seats = desk.agents.slice(0, 4);
    const spacing = Math.min(92, (width - 54) / Math.max(1, seats.length));
    seats.forEach((agent, index) => {
      const agentNode = new Node(`agent:${agent.agentId}`);
      agentNode.setParent(node);
      agentNode.setPosition((index - (seats.length - 1) / 2) * spacing, -34, 0);
      agentNode.addComponent(UITransform).setContentSize(62, 88);
      const body = new Node("body");
      body.setParent(agentNode);
      body.addComponent(UITransform).setContentSize(50, 54);
      this.drawPanel(body, 50, 54, new Color(64, 199, 224), 0, 0, 16, new Color(163, 244, 255));
      this.addLabel(body, agent.displayName.slice(0, 2).toUpperCase(), 12, new Color(5, 29, 43), 0, 2);
      this.addLabel(agentNode, agent.role, 9, new Color(170, 190, 217), 0, -39, 86);
      tween(agentNode)
        .repeatForever(tween().to(1.15 + index * 0.08, { position: new Vec3(agentNode.position.x, -27, 0) }).to(1.15, { position: new Vec3(agentNode.position.x, -34, 0) }))
        .start();
    });
  }

  private addLabel(parent: Node, text: string, fontSize: number, color: Color, x: number, y: number, width = 900) {
    const node = new Node(`label:${text.slice(0, 16)}`);
    node.setParent(parent);
    node.setPosition(x, y, 1);
    node.addComponent(UITransform).setContentSize(width, Math.max(28, fontSize * 1.5));
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = Math.ceil(fontSize * 1.25);
    label.color = color;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.overflow = Label.Overflow.SHRINK;
    label.useSystemFont = true;
    return node;
  }

  private drawPanel(parent: Node, width: number, height: number, fill: Color, x: number, y: number, radius: number, stroke?: Color) {
    const graphics = parent.getComponent(Graphics) ?? parent.addComponent(Graphics);
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
}
