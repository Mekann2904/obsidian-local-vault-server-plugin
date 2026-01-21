import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import ReactFlow, { Background, Controls, Edge, Node, applyNodeChanges, NodeChange } from 'reactflow';
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
	nodeId: string;
	onResize: (nodeId: string, width: number) => void;
	maxWidth: number;
}

const CANVAS_WIDTH_STORAGE_KEY = 'local-vault-canvas-node-width';
const CANVAS_WIDTHS_STORAGE_KEY = 'local-vault-canvas-node-widths';
const CANVAS_POSITIONS_STORAGE_KEY = 'local-vault-canvas-node-positions';
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

const scopedStorageKey = (base: string, scope: string) => {
	if (!scope) {
		return base;
	}
	return base + ':' + encodeURIComponent(scope);
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
				data.onResize(data.nodeId, nextWidth);
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
	const [nodeWidths, setNodeWidths] = useState<Record<string, number>>({});
	const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
	const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
	const [nodes, setNodes] = useState<Node<CanvasNodeData>[]>([]);
	const [edges, setEdges] = useState<Edge[]>([]);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const storageScope = config.path || '';
	const widthsStorageKey = scopedStorageKey(CANVAS_WIDTHS_STORAGE_KEY, storageScope);
	const positionsStorageKey = scopedStorageKey(CANVAS_POSITIONS_STORAGE_KEY, storageScope);

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
		const storedWidths = localStorage.getItem(widthsStorageKey);
		if (storedWidths) {
			try {
				const parsed = JSON.parse(storedWidths) as Record<string, number>;
				setNodeWidths(parsed || {});
			} catch {
				setNodeWidths({});
			}
		} else {
			setNodeWidths({});
		}
		const storedPositions = localStorage.getItem(positionsStorageKey);
		if (storedPositions) {
			try {
				const parsed = JSON.parse(storedPositions) as Record<string, { x: number; y: number }>;
				setNodePositions(parsed || {});
			} catch {
				setNodePositions({});
			}
		} else {
			setNodePositions({});
		}
	}, [widthsStorageKey, positionsStorageKey]);

	useEffect(() => {
		const handleResize = () => {
			setViewport({ width: window.innerWidth, height: window.innerHeight });
		};
		window.addEventListener('resize', handleResize);
		return () => window.removeEventListener('resize', handleResize);
	}, []);

	const updateNodeWidth = useCallback((nodeId: string, width: number) => {
		const maxWidth = Math.max(900, Math.floor(window.innerWidth - 80));
		const clamped = clampNumber(width, 900, maxWidth);
		setNodeWidth(clamped);
		setNodeWidths((prev) => {
			const next = { ...prev, [nodeId]: clamped };
			localStorage.setItem(widthsStorageKey, JSON.stringify(next));
			return next;
		});
		localStorage.setItem(CANVAS_WIDTH_STORAGE_KEY, String(clamped));
		setNodes((current) =>
			current.map((node) =>
				node.id === nodeId
					? { ...node, data: { ...node.data, width: clamped } }
					: node
			)
		);
	}, []);

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

	const getEdgeStyle = (direction: CanvasDirection) => {
		switch (direction) {
			case 'parent':
				return { stroke: '#e74c3c', strokeWidth: 2 };
			case 'child':
				return { stroke: '#3498db', strokeWidth: 2 };
			case 'info':
				return { stroke: '#2ecc71', strokeWidth: 2 };
			case 'knowledge':
				return { stroke: '#f39c12', strokeWidth: 2 };
			default:
				return { stroke: '#999', strokeWidth: 2 };
		}
	};

	useEffect(() => {
		if (!graph) {
			setNodes([]);
			setEdges([]);
			return;
		}
		const maxWidth = Math.max(900, Math.floor(viewport.width - 80));
		const nextNodes: Node<CanvasNodeData>[] = graph.nodes.map((node: CanvasNodePayload) => {
			const storedWidth = nodeWidths[node.id];
			const resolvedWidth = clampNumber(storedWidth ?? nodeWidth, 900, maxWidth);
			const savedPosition = nodePositions[node.id];
			return {
			id: node.id,
			type: 'note',
			position: savedPosition ? { x: savedPosition.x, y: savedPosition.y } : { x: 0, y: 0 },
			data: {
				title: node.title,
				contentHtml: node.contentHtml,
				width: resolvedWidth,
				isRoot: node.id === graph.rootId,
				nodeId: node.id,
				onResize: updateNodeWidth,
				maxWidth,
			},
		};
		});
		const nextEdges: Edge[] = graph.edges.map((edge: CanvasEdgePayload, index: number) => ({
			id: edge.from + '-' + edge.to + '-' + index,
			source: edge.from,
			target: edge.to,
			type: 'smoothstep',
			style: getEdgeStyle(edge.direction),
			className: 'local-vault-canvas-edge local-vault-canvas-edge-' + edge.direction,
		}));
		setNodes(nextNodes);
		setEdges(nextEdges);
	}, [graph, nodeWidth, viewport.width, nodeWidths, nodePositions, updateNodeWidth]);

	const handleNodesChange = useCallback((changes: NodeChange[]) => {
		setNodes((current) => applyNodeChanges(changes, current));
		const positionChanges = changes.filter((change): change is NodeChange & { id: string; position: { x: number; y: number } } => {
			return change.type === 'position' && 'position' in change;
		});
		if (positionChanges.length === 0) {
			return;
		}
		setNodePositions((prev) => {
			const next = { ...prev };
			positionChanges.forEach((change) => {
				if (!change.position) {
					return;
				}
				next[change.id] = { x: change.position.x, y: change.position.y };
			});
			localStorage.setItem(positionsStorageKey, JSON.stringify(next));
			return next;
		});
	}, [positionsStorageKey]);

	useEffect(() => {
		if (!graph || nodes.length === 0) {
			return;
		}
		const hasAllPositions = graph.nodes.every((node) => !!nodePositions[node.id]);
		if (hasAllPositions) {
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
		const baseRadius = 420;
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
			const storedWidth = nodeWidths[nodeId] ?? nodeWidth;
			const size = sizeMap.get(nodeId) || { width: storedWidth, height: 320 };
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
			parent: { start: 315, end: 45 },
			child: { start: 135, end: 225 },
			info: { start: 225, end: 315 },
			knowledge: { start: 45, end: 135 },
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
		const rootWidth = nodeWidths[graph.rootId] ?? nodeWidth;
		const rootSize = sizeMap.get(graph.rootId) || { width: rootWidth, height: 320 };
		const rootPosition = nodePositions[graph.rootId] || { x: center.x - rootSize.width / 2, y: center.y - rootSize.height / 2 };
		const rootRect = new DOMRect(rootPosition.x, rootPosition.y, rootSize.width, rootSize.height);
		placed.set(graph.rootId, rootRect);

		Object.entries(groups).forEach(([key, items]: [string, CanvasNodePayload[]]) => {
			if (!items.length) {
				return;
			}
			const sector = sectorAngles[key as CanvasDirection];
			const angles = buildAngles(items.length, sector.start, sector.end);
			items.forEach((node: CanvasNodePayload, index: number) => {
				if (nodePositions[node.id]) {
					const storedWidth = nodeWidths[node.id] ?? nodeWidth;
					const size = sizeMap.get(node.id) || { width: storedWidth, height: 320 };
					const existing = nodePositions[node.id];
					placed.set(node.id, new DOMRect(existing.x, existing.y, size.width, size.height));
					return;
				}
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
				if (nodePositions[node.id]) {
					return node;
				}
				return { ...node, position: { x: rect.x, y: rect.y } };
			})
		);
		setNodePositions((prev) => {
			const next = { ...prev };
			placed.forEach((rect, id) => {
				if (!next[id]) {
					next[id] = { x: rect.x, y: rect.y };
				}
			});
			localStorage.setItem(positionsStorageKey, JSON.stringify(next));
			return next;
		});
	}, [graph, nodeWidth, nodeWidths, nodePositions, positionsStorageKey, viewport.width, viewport.height]);

	return (
		<div className="local-vault-canvas-app" ref={containerRef}>
		<ReactFlow
			nodes={nodes}
			edges={edges}
			nodeTypes={nodeTypes}
			onNodesChange={handleNodesChange}
			defaultEdgeOptions={{
				type: 'smoothstep',
				animated: false,
				style: {
					strokeWidth: 2,
					stroke: '#999',
				},
			}}
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
