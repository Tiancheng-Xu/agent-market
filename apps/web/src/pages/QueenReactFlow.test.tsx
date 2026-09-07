import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  QueenReactFlow,
  canEditQueenGraph,
  validateQueenConnection,
  type GraphLike,
  type QueenGraphValidationError,
} from "./QueenReactFlow";

type FlowProps = Record<string, unknown>;
let latestFlowProps: FlowProps | undefined;

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Controls: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
  Position: { Left: "left", Right: "right" },
  ReactFlow: (props: FlowProps) => {
    latestFlowProps = props;
    return <div data-testid="react-flow">{props.children as React.ReactNode}</div>;
  },
}));

const graph: GraphLike = {
  graphRevision: 3,
  nodes: [
    { nodeId: "plan", title: "Plan", type: "plan", dependencies: [], required: true },
    { nodeId: "execute", title: "Execute", type: "execute", dependencies: ["plan"], required: true },
    { nodeId: "deliver", title: "Deliver", type: "deliver", dependencies: ["execute"], required: true },
  ],
  edges: [
    { from: "plan", to: "execute" },
    { from: "execute", to: "deliver" },
  ],
};

describe("QueenReactFlow editing contract", () => {
  beforeEach(() => {
    latestFlowProps = undefined;
  });

  it("allows explicit draft editing but locks started workflows", () => {
    expect(canEditQueenGraph({ editMode: true, locked: false, status: "idle" })).toBe(true);
    expect(canEditQueenGraph({ editMode: true, locked: true, status: "idle" })).toBe(false);
    expect(canEditQueenGraph({ editMode: true, locked: false, status: "running" })).toBe(false);
    expect(canEditQueenGraph({ editMode: false, locked: false, status: "idle" })).toBe(false);
  });

  it("returns deterministic validation errors for self loops, duplicates, and unknown nodes", () => {
    expect(validateQueenConnection(graph, { source: "plan", target: "plan" })).toEqual({
      code: "SELF_LOOP",
      message: "A workflow node cannot connect to itself.",
    });
    expect(validateQueenConnection(graph, { source: "plan", target: "execute" })).toEqual({
      code: "DUPLICATE_EDGE",
      message: "This workflow edge already exists.",
    });
    expect(validateQueenConnection(graph, { source: "missing", target: "execute" })).toEqual({
      code: "UNKNOWN_NODE",
      message: "The workflow edge references an unknown node.",
    });
  });

  it("emits a typed edge for a valid connection and preserves the draft on validation failure", () => {
    const onConnect = vi.fn();
    const onValidationError = vi.fn<(error: QueenGraphValidationError) => void>();
    renderToStaticMarkup(
      <QueenReactFlow
        graph={graph}
        activeNodeId={undefined}
        status="idle"
        editMode
        onConnect={onConnect}
        onValidationError={onValidationError}
      />,
    );

    const connect = latestFlowProps?.onConnect as ((connection: { source: string; target: string }) => void);
    connect({ source: "plan", target: "deliver" });
    expect(onConnect).toHaveBeenCalledWith({ from: "plan", to: "deliver", condition: "always" });

    connect({ source: "plan", target: "plan" });
    expect(onValidationError).toHaveBeenCalledWith({
      code: "SELF_LOOP",
      message: "A workflow node cannot connect to itself.",
    });
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("keeps readonly defaults and exposes editable node and edge change callbacks only for drafts", () => {
    const onNodesChange = vi.fn();
    const onEdgesChange = vi.fn();
    const onNodePositionsChange = vi.fn();
    const readonlyMarkup = renderToStaticMarkup(
      <QueenReactFlow graph={graph} activeNodeId={undefined} status="idle" />,
    );

    expect(latestFlowProps?.nodesDraggable).toBe(false);
    expect(latestFlowProps?.nodesConnectable).toBe(false);
    expect(latestFlowProps?.onNodesChange).toBeUndefined();
    expect(readonlyMarkup).toContain('data-edit-mode="readonly"');
    expect(readonlyMarkup).toContain('data-reduced-motion="respected"');

    renderToStaticMarkup(
      <QueenReactFlow
        graph={graph}
        activeNodeId={undefined}
        status="idle"
        editMode
        nodePositions={{ plan: { x: 40, y: 60 } }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodePositionsChange={onNodePositionsChange}
      />,
    );

    expect(latestFlowProps?.nodesDraggable).toBe(true);
    expect(latestFlowProps?.nodesConnectable).toBe(true);
    expect((latestFlowProps?.nodes as Array<{ id: string; position: { x: number; y: number } }>).find((node) => node.id === "plan")?.position).toEqual({ x: 40, y: 60 });
    const changeNodes = latestFlowProps?.onNodesChange as (changes: Array<{ id: string; type: "position"; position: { x: number; y: number } }>) => void;
    const changeEdges = latestFlowProps?.onEdgesChange as (changes: Array<{ id: string; type: "remove" }>) => void;
    changeNodes([{ id: "plan", type: "position", position: { x: 80, y: 120 } }]);
    changeEdges([{ id: "plan-execute-always", type: "remove" }]);
    expect(onNodesChange).toHaveBeenCalledWith([{ id: "plan", type: "position", position: { x: 80, y: 120 } }]);
    expect(onNodePositionsChange).toHaveBeenCalledWith({
      deliver: { x: 500, y: 0 },
      execute: { x: 250, y: 0 },
      plan: { x: 80, y: 120 },
    });
    expect(onEdgesChange).toHaveBeenCalledWith([{ id: "plan-execute-always", type: "remove" }]);
  });
});
