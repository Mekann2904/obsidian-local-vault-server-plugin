import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import ReactFlow, { Background, Controls, Edge, Node } from 'reactflow';
import reactFlowStyles from 'reactflow/dist/style.css';

type CanvasDirection = 'parent' | 'child' | 'info' | 'knowledge';

interface CanvasNodePayload {
	id: string;
	path: string;
	title: string;
	contentHtml: string;
	direction: CanvasDirection | 'root';
}

interface CanvasEdgePayload {
	from: string;
	to: string;
	direction: CanvasDirection;
}

interface CanvasGraphPayload {
	rootId: string;
	nodes: CanvasNodePayload[];
	edges: CanvasEdgePayload[];
}

interface CanvasConfig {
	endpoint: string;
	token: string | null;
	path: string;
	depth: number;
	maxDepth: number;
	nodeWidth: number;
}

interface CanvasNodeData {
	title: string;
	contentHtml: string;
	width: number;
	isRoot: boolean;
	onResize: (width: number) => void;
	maxWidth: number;
}

const CANVAS_WIDTH_STORAGE_KEY = 'local-vault-canvas-node-width';
const STYLE_ID = 'local-vault-reactflow-style';

const ensureReactFlowStyles = () => {
	if (document.getElementById(STYLE_ID)) {
		return;
	}
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = reactFlowStyles;
	document.head.appendChild(style);
};

const clampNumber = (value: number, min: number, max: number) => {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(Math.max(value, min), max);
};

const buildCanvasUrl = (config: CanvasConfig) => {
	const params = new URLSearchParams();
	if (config.token) {
		params.set('token', config.token);
	} else {
		params.set('path', config.path);
	}
	params.set('depth', String(config.depth));
	return config.endpoint + '?' + params.toString();
};

const NoteNode: React.FC<{ data: CanvasNodeData }> = ({ data }: { data: CanvasNodeData }) => {
	const onPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			event.stopPropagation();
			const startX = event.clientX;
			const startWidth = data.width;
			const handlePointerMove = (moveEvent: PointerEvent) => {
				const delta = moveEvent.clientX - startX;
				const nextWidth = clampNumber(startWidth + delta, 900, data.maxWidth);
				data.onResize(nextWidth);
			};
			const handlePointerUp = () => {
				window.removeEventListener('pointermove', handlePointerMove);
				window.removeEventListener('pointerup', handlePointerUp);
			};
			window.addEventListener('pointermove', handlePointerMove);
			window.addEventListener('pointerup', handlePointerUp);
		},
		[data]
	);

	return (
		<div
			className={data.isRoot ? 'local-vault-canvas-node is-root' : 'local-vault-canvas-node'}
			style={{ width: data.width }}
		>
			<div className="local-vault-canvas-node-title">{data.title}</div>
			<div className="local-vault-canvas-node-body" dangerouslySetInnerHTML={{ __html: data.contentHtml }} />
			<div className="local-vault-canvas-node-resize" onPointerDown={onPointerDown} />
		</div>
	);
};

const CanvasApp: React.FC<{ config: CanvasConfig }> = ({ config }: { config: CanvasConfig }) => {
	const [graph, setGraph] = useState<CanvasGraphPayload | null>(null);
	const [status, setStatus] = useState<string>('');
	const [nodeWidth, setNodeWidth] = useState<number>(config.nodeWidth);
	const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
	const [nodes, setNodes] = useState<Node<CanvasNodeData>[]>([]);
	const [edges, setEdges] = useState<Edge[]>([]);
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		ensureReactFlowStyles();
	}, []);

	useEffect(() => {
		const stored = localStorage.getItem(CANVAS_WIDTH_STORAGE_KEY);
		if (!stored) {
			return;
		}
		const parsed = Number.parseInt(stored, 10);
		if (Number.isFinite(parsed)) {
			setNodeWidth(parsed);
		}
	}, []);

	useEffect(() => {
		const handleResize = () => {
			setViewport({ width: window.innerWidth, height: window.innerHeight });
		};
		window.addEventListener('resize', handleResize);
		return () => window.removeEventListener('resize', handleResize);
	}, []);

	const updateNodeWidth = useCallback(
		(width: number) => {
			const maxWidth = Math.max(900, Math.floor(window.innerWidth - 80));
			const clamped = clampNumber(width, 900, maxWidth);
			setNodeWidth(clamped);
			localStorage.setItem(CANVAS_WIDTH_STORAGE_KEY, String(clamped));
		},
		[]
	);

	useEffect(() => {
		const depth = clampNumber(config.depth, 1, config.maxDepth);
		const targetUrl = buildCanvasUrl({ ...config, depth });
		let cancelled = false;
		setStatus('Loading canvas...');
		fetch(targetUrl, { cache: 'no-store' })
			.then((response) => {
				if (!response.ok) {
					throw new Error('HTTP ' + response.status);
				}
				return response.json();
			})
			.then((payload: CanvasGraphPayload) => {
				if (cancelled) {
					return;
				}
				setGraph(payload);
				setStatus('Depth ' + depth + ' · ' + payload.nodes.length + ' notes');
			})
			.catch(() => {
				if (!cancelled) {
					setStatus('Canvas load failed.');
				}
			});
		return () => {
			cancelled = true;
		};
	}, [config]);

	const nodeTypes = useMemo<Record<string, React.FC<{ data: CanvasNodeData }>>>(() => ({
		note: NoteNode,
	}), []);

	useEffect(() => {
		if (!graph) {
			setNodes([]);
			setEdges([]);
			return;
		}
		const maxWidth = Math.max(900, Math.floor(viewport.width - 80));
		const clampedWidth = clampNumber(nodeWidth, 900, maxWidth);
		const nextNodes: Node<CanvasNodeData>[] = graph.nodes.map((node: CanvasNodePayload) => ({
			id: node.id,
			type: 'note',
			position: { x: 0, y: 0 },
			data: {
				title: node.title,
				contentHtml: node.contentHtml,
				width: clampedWidth,
				isRoot: node.id === graph.rootId,
				onResize: updateNodeWidth,
				maxWidth,
			},
		}));
		const nextEdges: Edge[] = graph.edges.map((edge: CanvasEdgePayload, index: number) => ({
			id: edge.from + '-' + edge.to + '-' + index,
			source: edge.from,
			target: edge.to,
			className: 'local-vault-canvas-edge local-vault-canvas-edge-' + edge.direction,
		}));
		setNodes(nextNodes);
		setEdges(nextEdges);
	}, [graph, nodeWidth, viewport.width, updateNodeWidth]);

	useEffect(() => {
		if (!graph || nodes.length === 0) {
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const stageRect = container.getBoundingClientRect();
		if (!stageRect.width || !stageRect.height) {
			return;
		}
		const center = { x: stageRect.width / 2, y: stageRect.height / 2 };
		const margin = 18;
		const baseRadius = 320;
		const nodeElements = container.querySelectorAll<HTMLDivElement>('.react-flow__node');
		const sizeMap = new Map<string, { width: number; height: number }>();
		nodeElements.forEach((element: HTMLDivElement) => {
			const nodeId = element.getAttribute('data-id');
			if (!nodeId) {
				return;
			}
			const rect = element.getBoundingClientRect();
			sizeMap.set(nodeId, { width: rect.width, height: rect.height });
		});

		const overlap = (a: DOMRect, b: DOMRect) => {
			return !(
				a.right + margin < b.left ||
				a.left - margin > b.right ||
				a.bottom + margin < b.top ||
				a.top - margin > b.bottom
			);
		};

		const placeNode = (nodeId: string, angleRad: number, radiusStart: number, placed: Map<string, DOMRect>) => {
			const size = sizeMap.get(nodeId) || { width: nodeWidth, height: 260 };
			let radius = radiusStart;
			let rect: DOMRect | null = null;
			while (true) {
				const x = center.x + Math.cos(angleRad) * radius;
				const y = center.y + Math.sin(angleRad) * radius;
				const left = x - size.width / 2;
				const top = y - size.height / 2;
				rect = new DOMRect(left, top, size.width, size.height);
				let collides = false;
				for (const placedRect of placed.values()) {
					if (overlap(rect, placedRect)) {
						collides = true;
						break;
					}
				}
				if (!collides) {
					break;
				}
				radius += 80;
			}
			return rect;
		};

		const groups: Record<CanvasDirection, CanvasNodePayload[]> = {
			parent: [],
			child: [],
			info: [],
			knowledge: [],
		};
		graph.nodes.forEach((node: CanvasNodePayload) => {
			if (node.id === graph.rootId) {
				return;
			}
			if (node.direction !== 'root') {
				groups[node.direction].push(node);
			}
		});

		const sectorAngles: Record<CanvasDirection, { start: number; end: number }> = {
			parent: { start: 225, end: 315 },
			child: { start: 45, end: 135 },
			info: { start: 135, end: 225 },
			knowledge: { start: 315, end: 45 },
		};

		const buildAngles = (count: number, start: number, end: number) => {
			let adjustedEnd = end;
			if (adjustedEnd < start) {
				adjustedEnd += 360;
			}
			const range = adjustedEnd - start;
			if (count <= 0) {
				return [];
			}
			if (count === 1) {
				return [start + range / 2];
			}
			const step = range / (count + 1);
			return Array.from({ length: count }, (_, index) => start + step * (index + 1));
		};

		const placed = new Map<string, DOMRect>();
		const rootSize = sizeMap.get(graph.rootId) || { width: nodeWidth, height: 260 };
		const rootRect = new DOMRect(
			center.x - rootSize.width / 2,
			center.y - rootSize.height / 2,
			rootSize.width,
			rootSize.height
		);
		placed.set(graph.rootId, rootRect);

		Object.entries(groups).forEach(([key, items]: [string, CanvasNodePayload[]]) => {
			if (!items.length) {
				return;
			}
			const sector = sectorAngles[key as CanvasDirection];
			const angles = buildAngles(items.length, sector.start, sector.end);
			items.forEach((node: CanvasNodePayload, index: number) => {
				const angleDeg = angles[index] ?? sector.start;
				const angleRad = (angleDeg * Math.PI) / 180;
				const rect = placeNode(node.id, angleRad, baseRadius, placed);
				if (rect) {
					placed.set(node.id, rect);
				}
			});
		});

		setNodes((current: Node<CanvasNodeData>[]) =>
			current.map((node: Node<CanvasNodeData>) => {
				const rect = placed.get(node.id);
				if (!rect) {
					return node;
				}
				return { ...node, position: { x: rect.x, y: rect.y } };
			})
		);
	}, [graph, nodeWidth, viewport.width, viewport.height]);

	return (
		<div className="local-vault-canvas-app" ref={containerRef}>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				fitView
				panOnDrag
				panOnScroll
				zoomOnScroll
				zoomOnPinch
				nodesDraggable
				nodesConnectable={false}
				minZoom={0.1}
				maxZoom={2}
				proOptions={{ hideAttribution: true }}
			>
				<Background gap={24} size={1} />
				<Controls showInteractive={false} />
			</ReactFlow>
			<div className="local-vault-canvas-status">{status}</div>
		</div>
	);
};

let canvasRoot: Root | null = null;

const renderCanvas = (container: HTMLElement, config: CanvasConfig) => {
	if (!canvasRoot) {
		canvasRoot = createRoot(container);
	}
	canvasRoot.render(<CanvasApp config={config} />);
};

declare global {
	interface Window {
		__localVaultCanvasRender?: (container: HTMLElement, config: CanvasConfig) => void;
	}
}

window.__localVaultCanvasRender = renderCanvas;
