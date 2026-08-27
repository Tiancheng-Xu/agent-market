import {
  _decorator,
  assetManager,
  Component,
  ImageAsset,
  Layers,
  Node,
  Rect,
  ResolutionPolicy,
  Size,
  Sprite,
  SpriteFrame,
  Texture2D,
  UITransform,
  Vec2,
  Vec3,
  tween,
  view,
} from "cc";

const { ccclass } = _decorator;

type Activity = "idle" | "walking" | "thinking" | "working" | "reviewing" | "waiting" | "done" | "failed" | "offline";
type AgentSeat = { agentId: string; displayName: string; role: string; score: number; activity: Activity };
type OfficeDesk = { taskId: string; title: string; category: string; tags: string[]; status: "in_progress" | "completed"; agents: AgentSeat[]; isOwner: boolean };
type OfficeSnapshot = { version: 2; locale?: "zh-CN" | "en"; statusFilter: "all" | "in_progress" | "completed"; desks: OfficeDesk[] };

const ACTIVITIES: Activity[] = ["idle", "walking", "thinking", "working", "reviewing", "waiting", "done", "failed", "offline"];

function isSnapshot(value: unknown): value is OfficeSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OfficeSnapshot>;
  return candidate.version === 2 && Array.isArray(candidate.desks)
    && candidate.desks.every((desk) => Boolean(desk && typeof desk.taskId === "string" && Array.isArray(desk.agents)
      && desk.agents.every((agent) => ACTIVITIES.includes(agent.activity))));
}

function loadTexture(url: string): Promise<Texture2D> {
  return new Promise((resolve, reject) => {
    assetManager.loadRemote<ImageAsset>(url, { ext: ".png" }, (error, image) => {
      if (error) return reject(error);
      const texture = new Texture2D();
      texture.image = image;
      resolve(texture);
    });
  });
}

@ccclass("OfficeScene")
export class OfficeScene extends Component {
  private snapshot: OfficeSnapshot = { version: 2, statusFilter: "all", desks: [] };
  private background?: Texture2D;
  private atlas?: Texture2D;

  async start() {
    window.addEventListener("message", this.onHostMessage);
    window.addEventListener("resize", this.render);
    try {
      [this.background, this.atlas] = await Promise.all([
        loadTexture("/office-cocos/art/starbuddy-office-background.png"),
        loadTexture("/office-cocos/art/starbuddy-agent-atlas.png"),
      ]);
    } finally {
      this.render();
      window.parent.postMessage({ type: "agent-market.office.ready.v2" }, window.location.origin);
    }
  }

  onDestroy() {
    window.removeEventListener("message", this.onHostMessage);
    window.removeEventListener("resize", this.render);
  }

  private readonly onHostMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const message = event.data as { type?: string; payload?: unknown };
    if (message.type !== "agent-market.office.snapshot.v2" || !isSnapshot(message.payload)) return;
    this.snapshot = message.payload;
    this.render();
  };

  private readonly render = () => {
    view.setDesignResolutionSize(1440, 900, ResolutionPolicy.SHOW_ALL);
    const transform = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
    transform.setContentSize(1440, 900);
    this.node.removeAllChildren();

    if (this.background) {
      const background = new Node("CozyOfficeBackground");
      background.layer = Layers.Enum.UI_2D;
      background.setParent(this.node);
      background.addComponent(UITransform).setContentSize(1440, 900);
      const sprite = background.addComponent(Sprite);
      const frame = new SpriteFrame();
      frame.texture = this.background;
      sprite.spriteFrame = frame;
      sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    }

    const slots = [new Vec2(-270, 118), new Vec2(150, 118), new Vec2(-270, -185), new Vec2(150, -185)];
    this.snapshot.desks.slice(0, 4).forEach((desk, deskIndex) => {
      const slot = slots[deskIndex];
      desk.agents.slice(0, 3).forEach((agent, agentIndex) => {
        this.createAgent(agent, slot.x + (agentIndex - 1) * 76, slot.y - 54);
      });
    });
  };

  private createAgent(agent: AgentSeat, x: number, y: number) {
    const node = new Node(`agent:${agent.agentId}`);
    node.layer = Layers.Enum.UI_2D;
    node.setParent(this.node);
    node.setPosition(x, y, 8);
    node.addComponent(UITransform).setContentSize(76, 76);

    if (this.atlas) {
      const row = /arbiter|final/i.test(agent.role) ? 2 : /judge|review|research/i.test(agent.role) ? 1 : /image|visual/i.test(agent.role) ? 3 : 0;
      const column = ({ idle: 0, walking: 2, thinking: 3, working: 4, reviewing: 5, waiting: 0, done: 6, failed: 7, offline: 7 } as const)[agent.activity];
      const cellWidth = this.atlas.width / 8;
      const cellHeight = this.atlas.height / 4;
      const frame = new SpriteFrame();
      frame.texture = this.atlas;
      frame.rect = new Rect(column * cellWidth, (3 - row) * cellHeight, cellWidth, cellHeight);
      frame.originalSize = new Size(cellWidth, cellHeight);
      frame.offset = new Vec2();
      const sprite = node.addComponent(Sprite);
      sprite.spriteFrame = frame;
      sprite.sizeMode = Sprite.SizeMode.CUSTOM;
      node.getComponent(UITransform)!.setContentSize(76, 76);
    }

    tween(node)
      .repeatForever(tween().to(1.2, { position: new Vec3(x, y + 4, 8) }).to(1.2, { position: new Vec3(x, y, 8) }))
      .start();
  }
}
