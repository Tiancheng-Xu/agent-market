import { useMemo } from "react";
import { Localized } from "../i18n/LanguageProvider";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";

export type GraphNode = {
  nodeId: string;
  title: string;
  type: string;
  dependencies: string[];
  required: boolean;
  contract?: {
    milestone: string;
    timeoutSeconds: number;
    failureRoute: string;
  };
};

export type GraphEdge = {
  from: string;
  to: string;
  condition?: string;
};

export type GraphLike = {
  graphRevision: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type QueenGraphValidationError = {
  code: "SELF_LOOP" | "DUPLICATE_EDGE" | "UNKNOWN_NODE" | "UNKNOWN_EDGE";
  message: string;
};

export type QueenNodePositions = Readonly<Record<string, Readonly<{ x: number; y: number }>>>;

export type QueenReactFlowProps = {
  graph: GraphLike | null | undefined;
  activeNodeId: string | undefined;
  status: string;
  editMode?: boolean;
  locked?: boolean;
  nodePositions?: QueenNodePositions;
  onNodesChange?: (changes: NodeChange[]) => void;
  onNodePositionsChange?: (positions: QueenNodePositions) => void;
  onEdgesChange?: (changes: EdgeChange[]) => void;
  onConnect?: (edge: GraphEdge) => void;
  onValidationError?: (error: QueenGraphValidationError) => void;
};

const EDITABLE_STATUSES = new Set(["draft", "idle", "proposed", "ready", "awaiting_confirmation"]);

export function canEditQueenGraph({
  editMode,
  locked,
  status,
}: Pick<QueenReactFlowProps, "editMode" | "locked" | "status">): boolean {
  return editMode === true && locked !== true && EDITABLE_STATUSES.has(status.trim().toLowerCase());
}

export function validateQueenConnection(
  graph: Pick<GraphLike, "nodes" | "edges">,
  connection: Pick<Connection, "source" | "target">,
): QueenGraphValidationError | undefined {
  const { source, target } = connection;
  const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
  if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
    return { code: "UNKNOWN_NODE", message: "The workflow edge references an unknown node." };
  }
  if (source === target) {
    return { code: "SELF_LOOP", message: "A workflow node cannot connect to itself." };
  }
  if (graph.edges.some((edge) => edge.from === source && edge.to === target)) {
    return { code: "DUPLICATE_EDGE", message: "This workflow edge already exists." };
  }
  return undefined;
}

const fallbackNodes: GraphNode[] = [
  { nodeId: "requirement", title: "Requirement", type: "requirement", dependencies: [], required: true },
  { nodeId: "plan", title: "Queen plan", type: "plan", dependencies: ["requirement"], required: true },
  { nodeId: "execute", title: "Agent execution", type: "execute", dependencies: ["plan"], required: true },
  { nodeId: "judge", title: "Independent Judge", type: "judge", dependencies: ["execute"], required: true },
  { nodeId: "red-team", title: "Red Team", type: "red_team", dependencies: ["judge"], required: false },
  { nodeId: "repair", title: "Repair", type: "repair", dependencies: ["red-team"], required: false },
  { nodeId: "arbiter", title: "Final arbiter", type: "synthesize", dependencies: ["judge", "repair"], required: true },
  { nodeId: "deliver", title: "Evidence delivery", type: "deliver", dependencies: ["arbiter"], required: true },
];

const fallbackEdges: GraphEdge[] = [
  { from: "requirement", to: "plan" },
  { from: "plan", to: "execute" },
  { from: "execute", to: "judge" },
  { from: "judge", to: "red-team", condition: "needs_revision" },
  { from: "red-team", to: "repair" },
  { from: "repair", to: "arbiter", condition: "approved" },
  { from: "judge", to: "arbiter", condition: "approved" },
  { from: "arbiter", to: "deliver" },
];

function buildLevels(nodes: GraphNode[]): Map<string, number> {
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const levels = new Map<string, number>();
  const levelFor = (node: GraphNode, path: Set<string>): number => {
    const cached = levels.get(node.nodeId);
    if (cached !== undefined) return cached;
    if (path.has(node.nodeId)) return 0;
    const nextPath = new Set(path).add(node.nodeId);
    const dependencies = node.dependencies
      .filter((id) => nodeIds.has(id))
      .map((id) => nodes.find((candidate) => candidate.nodeId === id))
      .filter((candidate): candidate is GraphNode => candidate !== undefined);
    const level = dependencies.length === 0
      ? 0
      : Math.max(...dependencies.map((dependency) => levelFor(dependency, nextPath))) + 1;
    levels.set(node.nodeId, level);
    return level;
  };
  nodes.forEach((node) => levelFor(node, new Set()));
  return levels;
}

function buildPositions(nodes: GraphNode[], levels: Map<string, number>): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const rowsByLevel = new Map<number, number>();
  [...nodes]
    .sort((left, right) => {
      const levelDelta = (levels.get(left.nodeId) ?? 0) - (levels.get(right.nodeId) ?? 0);
      return levelDelta || left.nodeId.localeCompare(right.nodeId);
    })
    .forEach((node) => {
      const level = levels.get(node.nodeId) ?? 0;
      const row = rowsByLevel.get(level) ?? 0;
      rowsByLevel.set(level, row + 1);
      positions.set(node.nodeId, { x: level * 250, y: row * 148 });
    });
  return positions;
}

function edgeId(edge: GraphEdge): string {
  return `${edge.from}-${edge.to}-${edge.condition ?? "always"}`;
}

export function QueenReactFlow({
  graph,
  activeNodeId,
  status,
  editMode = false,
  locked = false,
  nodePositions,
  onNodesChange,
  onNodePositionsChange,
  onEdgesChange,
  onConnect,
  onValidationError,
}: QueenReactFlowProps) {
  const editable = canEditQueenGraph({ editMode, locked, status });
  const { nodes, edges } = useMemo(() => {
    const sourceNodes = graph?.nodes ?? fallbackNodes;
    const sourceEdges: GraphEdge[] = graph?.edges ?? fallbackEdges;
    const levels = buildLevels(sourceNodes);
    const positions = buildPositions(sourceNodes, levels);
    const flowNodes: Node[] = sourceNodes.map((node) => {
      const state = node.nodeId === activeNodeId
        ? "active"
        : status === "succeeded"
          ? "completed"
          : "pending";
      return {
        id: node.nodeId,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        position: nodePositions?.[node.nodeId] ?? positions.get(node.nodeId) ?? { x: 0, y: 0 },
        data: {
          label: (
            <article className={`queen-rf-card queen-rf-${state}`}>
              <span>{node.type}</span>
              <strong>{node.title}</strong>
              <small>{node.contract?.milestone ?? (node.required ? "Required Gate" : "Repair route")}</small>
              {node.contract ? <em>{node.contract.timeoutSeconds}s / {node.contract.failureRoute}</em> : null}
            </article>
          ),
        },
        draggable: editable,
        selectable: true,
        className: `queen-rf-node queen-rf-node-${state}`,
      };
    });
    const flowEdges: Edge[] = sourceEdges.map((edge) => ({
      id: edgeId(edge),
      source: edge.from,
      target: edge.to,
      label: edge.condition && edge.condition !== "always" ? edge.condition : undefined,
      animated: edge.to === activeNodeId,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#4cdbf7" },
      style: { stroke: edge.condition === "needs_revision" ? "#ffb454" : "#4cdbf7" },
      labelStyle: { fill: "#ffb454", fontSize: 10 },
    }));
    return { nodes: flowNodes, edges: flowEdges };
  }, [activeNodeId, editable, graph, nodePositions, status]);

  const emitValidationError = (error: QueenGraphValidationError) => {
    onValidationError?.(error);
  };

  const handleNodesChange = editable && onNodesChange
    ? (changes: NodeChange[]) => {
      const nodeIds = new Set(nodes.map((node) => node.id));
      const unknown = changes.find((change) => "id" in change && !nodeIds.has(change.id));
      if (unknown && "id" in unknown) {
        emitValidationError({ code: "UNKNOWN_NODE", message: `Unknown workflow node: ${unknown.id}.` });
        return;
      }
      if (onNodePositionsChange) {
        const nextPositions: Record<string, { x: number; y: number }> = Object.fromEntries(
          nodes.map((node) => [node.id, node.position]),
        );
        for (const change of changes) {
          if (change.type === "position" && change.position) {
            nextPositions[change.id] = change.position;
          } else if (change.type === "remove") {
            delete nextPositions[change.id];
          }
        }
        onNodePositionsChange(nextPositions);
      }
      onNodesChange(changes);
    }
    : undefined;

  const handleEdgesChange = editable && onEdgesChange
    ? (changes: EdgeChange[]) => {
      const edgeIds = new Set(edges.map((edge) => edge.id));
      const unknown = changes.find((change) => "id" in change && !edgeIds.has(change.id));
      if (unknown && "id" in unknown) {
        emitValidationError({ code: "UNKNOWN_EDGE", message: `Unknown workflow edge: ${unknown.id}.` });
        return;
      }
      onEdgesChange(changes);
    }
    : undefined;

  const handleConnect = editable
    ? (connection: Connection) => {
      const sourceGraph = graph ?? { graphRevision: 0, nodes: fallbackNodes, edges: fallbackEdges };
      const error = validateQueenConnection(sourceGraph, connection);
      if (error) {
        emitValidationError(error);
        return;
      }
      onConnect?.({ from: connection.source!, to: connection.target!, condition: "always" });
    }
    : undefined;

  return (
    <section
      className="queen-react-flow"
      aria-label="Queen workflow diagram"
      data-edit-mode={editable ? "editable" : "readonly"}
      data-reduced-motion="respected"
    >
      <header>
        <span>LIVE DAG</span>
        <strong>{graph ? `Revision ${graph.graphRevision}` : "Preview contract"}</strong>
        <small><Localized>{editable ? "Edit the draft, then validate and save it from the workflow page" : "Zoom, pan, inspect dependencies and failure routes"}</Localized></small>
      </header>
      <div className="queen-react-flow-canvas" style={{ minHeight: 440 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.35}
          maxZoom={1.5}
          nodesDraggable={editable}
          nodesConnectable={editable}
          edgesReconnectable={editable}
          deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
          {...(handleNodesChange ? { onNodesChange: handleNodesChange } : {})}
          {...(handleEdgesChange ? { onEdgesChange: handleEdgesChange } : {})}
          {...(handleConnect ? { onConnect: handleConnect } : {})}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#243655" gap={22} size={1} variant={BackgroundVariant.Dots} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <ul className="queen-react-flow-edges" aria-label="Graph edges">
        {edges.map((edge) => (
          <li key={edge.id}>
            <span>{edge.source}</span><b aria-hidden="true">→</b><span>{edge.target}</span>
            {edge.label ? <em>{String(edge.label)}</em> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
