import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
	addEdge,
	applyEdgeChanges,
	applyNodeChanges,
	Background,
	Connection,
	ConnectionLineType,
	Controls,
	Edge,
	EdgeChange,
	Handle,
	Node,
	NodeChange,
	Panel,
	Position,
	ReactFlow,
	ReactFlowProvider,
	SelectionMode,
	Viewport,
	ViewportPortal,
	XYPosition,
	useReactFlow,
	useStore,
} from '@xyflow/react';
import reactFlowStyles from '@xyflow/react/dist/style.css';
import { v4 as uuidv4 } from 'uuid';

type CanvasDirection = 'parent' | 'child' | 'info' | 'knowledge';
type CanvasTool = 'select' | 'draw' | 'rect' | 'eraser' | 'lasso';

interface CanvasStrokeBase {
	id: string;
	type: 'freehand' | 'rect';
}

interface CanvasStrokeFreehand extends CanvasStrokeBase {
	type: 'freehand';
	points: XYPosition[];
}

interface CanvasStrokeRect extends CanvasStrokeBase {
	type: 'rect';
	start: XYPosition;
	end: XYPosition;
}

type CanvasStroke = CanvasStrokeFreehand | CanvasStrokeRect;

interface CanvasSnapshot {
	nodes: CanvasNode[];
	edges: Edge[];
	strokes: CanvasStroke[];
	viewport: Viewport;
}

interface ContextMenuState {
	x: number;
	y: number;
	context: 'pane' | 'node' | 'edge';
	nodeId?: string;
	edgeId?: string;
}

type CanvasNode = Node<CanvasNodeData>;

interface CanvasNodeLookupEntry {
	id: string;
	positionAbsolute: XYPosition;
	measured?: { width?: number; height?: number };
	width?: number;
	height?: number;
}

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
	[key: string]: unknown;
}

const CANVAS_WIDTH_STORAGE_KEY = 'local-vault-canvas-node-width';
const CANVAS_WIDTHS_STORAGE_KEY = 'local-vault-canvas-node-widths';
const CANVAS_POSITIONS_STORAGE_KEY = 'local-vault-canvas-node-positions';
const CANVAS_STROKES_STORAGE_KEY = 'local-vault-canvas-strokes';
const CANVAS_VIEWPORT_STORAGE_KEY = 'local-vault-canvas-viewport';
const CANVAS_SNAPSHOT_STORAGE_KEY = 'local-vault-canvas-snapshot';
const STYLE_ID = 'local-vault-reactflow-style';

const CANVAS_CUSTOM_STYLES = `
.local-vault-canvas-toolbar {
	background: rgba(30, 32, 36, 0.82);
	border: 1px solid rgba(255, 255, 255, 0.08);
	border-radius: 10px;
	padding: 6px;
	display: flex;
	gap: 6px;
	align-items: center;
	backdrop-filter: blur(8px);
	color: #f4f6f8;
}

.local-vault-canvas-toolbar button {
	background: rgba(255, 255, 255, 0.08);
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 8px;
	color: inherit;
	font-size: 12px;
	padding: 4px 8px;
	cursor: pointer;
}

.local-vault-canvas-toolbar button.is-active {
	background: #2f9ff8;
	border-color: #2f9ff8;
	color: #08121f;
}

.local-vault-canvas-context {
	position: absolute;
	background: rgba(25, 28, 31, 0.95);
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 10px;
	padding: 6px;
	color: #f4f6f8;
	box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
	z-index: 40;
}

.local-vault-canvas-context button {
	display: block;
	width: 100%;
	background: transparent;
	border: none;
	color: inherit;
	text-align: left;
	padding: 6px 10px;
	font-size: 12px;
	cursor: pointer;
}

.local-vault-canvas-context button:hover {
	background: rgba(255, 255, 255, 0.08);
}

.local-vault-canvas-handle {
	width: 10px;
	height: 10px;
	border-radius: 50%;
	background: #94b4ff;
	border: 1px solid #10213d;
}

.local-vault-canvas-helper-line {
	stroke: rgba(46, 204, 113, 0.7);
	stroke-width: 2;
	stroke-dasharray: 6 6;
}
`;

const ensureReactFlowStyles = () => {
	if (document.getElementById(STYLE_ID)) {
		return;
	}
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = reactFlowStyles + '\n' + CANVAS_CUSTOM_STYLES;
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

const distanceBetween = (a: XYPosition, b: XYPosition) => {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
};

const pointInPolygon = (point: XYPosition, polygon: XYPosition[]) => {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;
		const intersect = yi > point.y !== yj > point.y &&
			point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
		if (intersect) {
			inside = !inside;
		}
	}
	return inside;
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
			<Handle type="target" position={Position.Top} className="local-vault-canvas-handle" />
			<Handle type="target" position={Position.Left} className="local-vault-canvas-handle" />
			<Handle type="source" position={Position.Bottom} className="local-vault-canvas-handle" />
			<Handle type="source" position={Position.Right} className="local-vault-canvas-handle" />
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
	const [viewportSize, setViewportSize] = useState({ width: window.innerWidth, height: window.innerHeight });
	const [nodes, setNodes] = useState<Node<CanvasNodeData>[]>([]);
	const [edges, setEdges] = useState<Edge[]>([]);
	const [strokes, setStrokes] = useState<CanvasStroke[]>([]);
	const [draftStroke, setDraftStroke] = useState<CanvasStroke | null>(null);
	const [lassoPoints, setLassoPoints] = useState<XYPosition[]>([]);
	const [activeTool, setActiveTool] = useState<CanvasTool>('select');
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [helperLines, setHelperLines] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
	const [historyIndex, setHistoryIndex] = useState(0);
	const [restoredViewport, setRestoredViewport] = useState<Viewport | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const clipboardRef = useRef<{ nodes: Node<CanvasNodeData>[]; edges: Edge[] } | null>(null);
	const historyRef = useRef<CanvasSnapshot[]>([]);
	const historyTimerRef = useRef<number | null>(null);
	const isRestoringRef = useRef(false);
	const isPointerDownRef = useRef(false);
	const multiSelectionKey = useMemo(
		() => (navigator.platform.includes('Mac') ? 'Meta' : 'Control'),
		[]
	);
	const {
		fitView,
		screenToFlowPosition,
		setViewport: applyViewport,
		getViewport,
		getNodes: getCurrentNodes,
		getEdges: getCurrentEdges,
	} = useReactFlow();
	const nodeLookup = useStore((state) => state.nodeLookup) as unknown as Map<string, CanvasNodeLookupEntry>;
	const storageScope = config.path || '';
	const widthsStorageKey = scopedStorageKey(CANVAS_WIDTHS_STORAGE_KEY, storageScope);
	const positionsStorageKey = scopedStorageKey(CANVAS_POSITIONS_STORAGE_KEY, storageScope);
	const strokesStorageKey = scopedStorageKey(CANVAS_STROKES_STORAGE_KEY, storageScope);
	const viewportStorageKey = scopedStorageKey(CANVAS_VIEWPORT_STORAGE_KEY, storageScope);
	const snapshotStorageKey = scopedStorageKey(CANVAS_SNAPSHOT_STORAGE_KEY, storageScope);

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
		const storedStrokes = localStorage.getItem(strokesStorageKey);
		if (storedStrokes) {
			try {
				const parsed = JSON.parse(storedStrokes) as CanvasStroke[];
				setStrokes(parsed || []);
			} catch {
				setStrokes([]);
			}
		} else {
			setStrokes([]);
		}
		const storedViewport = localStorage.getItem(viewportStorageKey);
		if (storedViewport) {
			try {
				const parsed = JSON.parse(storedViewport) as Viewport;
				setRestoredViewport(parsed || null);
			} catch {
				setRestoredViewport(null);
			}
		} else {
			setRestoredViewport(null);
		}
	}, [positionsStorageKey, strokesStorageKey, viewportStorageKey, widthsStorageKey]);

	useEffect(() => {
		const handleResize = () => {
			setViewportSize({ width: window.innerWidth, height: window.innerHeight });
		};
		window.addEventListener('resize', handleResize);
		return () => window.removeEventListener('resize', handleResize);
	}, []);

	useEffect(() => {
		if (restoredViewport) {
			applyViewport(restoredViewport, { duration: 0 });
		}
	}, [applyViewport, restoredViewport]);

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
	}, [widthsStorageKey]);

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

	const pushHistory = useCallback((snapshot: CanvasSnapshot) => {
		if (isRestoringRef.current) {
			return;
		}
		setHistoryIndex((current) => {
			const trimmed = historyRef.current.slice(0, current + 1);
			trimmed.push(snapshot);
			historyRef.current = trimmed;
			return trimmed.length - 1;
		});
	}, []);

	const buildSnapshot = useCallback((): CanvasSnapshot => {
		return {
			nodes,
			edges,
			strokes,
			viewport: getViewport(),
		};
	}, [nodes, edges, strokes, getViewport]);

	const restoreSnapshot = useCallback((snapshot: CanvasSnapshot) => {
		isRestoringRef.current = true;
		setNodes(snapshot.nodes);
		setEdges(snapshot.edges);
		setStrokes(snapshot.strokes);
		applyViewport(snapshot.viewport, { duration: 0 });
		localStorage.setItem(snapshotStorageKey, JSON.stringify(snapshot));
		localStorage.setItem(strokesStorageKey, JSON.stringify(snapshot.strokes));
		localStorage.setItem(viewportStorageKey, JSON.stringify(snapshot.viewport));
		setTimeout(() => {
			isRestoringRef.current = false;
		}, 0);
	}, [applyViewport, snapshotStorageKey, strokesStorageKey, viewportStorageKey]);

	const scheduleHistoryPush = useCallback(() => {
		if (historyTimerRef.current) {
			window.clearTimeout(historyTimerRef.current);
		}
		historyTimerRef.current = window.setTimeout(() => {
			const snapshot = buildSnapshot();
			localStorage.setItem(snapshotStorageKey, JSON.stringify(snapshot));
			pushHistory(snapshot);
		}, 200);
	}, [buildSnapshot, pushHistory, snapshotStorageKey]);

	const handleUndo = useCallback(() => {
		setHistoryIndex((current) => {
			const nextIndex = Math.max(0, current - 1);
			const snapshot = historyRef.current[nextIndex];
			if (snapshot) {
				restoreSnapshot(snapshot);
			}
			return nextIndex;
		});
	}, [restoreSnapshot]);

	const handleRedo = useCallback(() => {
		setHistoryIndex((current) => {
			const nextIndex = Math.min(historyRef.current.length - 1, current + 1);
			const snapshot = historyRef.current[nextIndex];
			if (snapshot) {
				restoreSnapshot(snapshot);
			}
			return nextIndex;
		});
	}, [restoreSnapshot]);

	const handleCopy = useCallback(() => {
		const selectedNodes = (getCurrentNodes() as Node<CanvasNodeData>[]).filter((node) => node.selected);
		if (selectedNodes.length === 0) {
			return;
		}
		const selectedIds = new Set(selectedNodes.map((node: Node<CanvasNodeData>) => node.id));
		const selectedEdges = (getCurrentEdges() as Edge[]).filter(
			(edge: Edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)
		);
		clipboardRef.current = { nodes: selectedNodes, edges: selectedEdges };
	}, [getCurrentEdges, getCurrentNodes]);

	const handlePaste = useCallback(() => {
		const clipboard = clipboardRef.current;
		if (!clipboard) {
			return;
		}
		const offset = 30;
		const idMap = new Map<string, string>();
		const nextNodes = clipboard.nodes.map((node) => {
			const nextId = uuidv4();
			idMap.set(node.id, nextId);
			return {
				...node,
				id: nextId,
				position: { x: node.position.x + offset, y: node.position.y + offset },
				data: { ...node.data, nodeId: nextId },
			};
		});
		const nextEdges = clipboard.edges.map((edge) => ({
			...edge,
			id: uuidv4(),
			source: idMap.get(edge.source) ?? edge.source,
			target: idMap.get(edge.target) ?? edge.target,
		}));
		setNodes((current) => [...current, ...nextNodes]);
		setEdges((current) => [...current, ...nextEdges]);
		setNodePositions((prev) => {
			const next = { ...prev };
			nextNodes.forEach((node) => {
				next[node.id] = { x: node.position.x, y: node.position.y };
			});
			localStorage.setItem(positionsStorageKey, JSON.stringify(next));
			return next;
		});
		scheduleHistoryPush();
	}, [positionsStorageKey, scheduleHistoryPush]);

	const handleViewportSave = useCallback(() => {
		const snapshot = buildSnapshot();
		localStorage.setItem(snapshotStorageKey, JSON.stringify(snapshot));
		pushHistory(snapshot);
	}, [buildSnapshot, pushHistory, snapshotStorageKey]);

	const handleViewportRestore = useCallback(() => {
		const stored = localStorage.getItem(snapshotStorageKey);
		if (!stored) {
			return;
		}
		try {
			const parsed = JSON.parse(stored) as CanvasSnapshot;
			restoreSnapshot(parsed);
		} catch {
			// ignore
		}
	}, [restoreSnapshot, snapshotStorageKey]);

	const handleClearDrawings = useCallback(() => {
		setStrokes([]);
		localStorage.setItem(strokesStorageKey, JSON.stringify([]));
		scheduleHistoryPush();
	}, [scheduleHistoryPush, strokesStorageKey]);

	const handleMoveEnd = useCallback((_: unknown, viewport: Viewport) => {
		localStorage.setItem(viewportStorageKey, JSON.stringify(viewport));
		scheduleHistoryPush();
	}, [scheduleHistoryPush, viewportStorageKey]);

	const handleNodeDrag = useCallback((_: React.MouseEvent, node: Node) => {
		const threshold = 6;
		let helperX: number | null = null;
		let helperY: number | null = null;
		const current = nodeLookup.get(node.id);
		if (!current) {
			return;
		}
		const currentWidth = current.measured?.width ?? current.width ?? 0;
		const currentHeight = current.measured?.height ?? current.height ?? 0;
		const currentCenter = {
			x: current.positionAbsolute.x + currentWidth / 2,
			y: current.positionAbsolute.y + currentHeight / 2,
		};
		for (const [otherId, other] of nodeLookup.entries()) {
			if (otherId === node.id) {
				continue;
			}
			const otherWidth = other.measured?.width ?? other.width ?? 0;
			const otherHeight = other.measured?.height ?? other.height ?? 0;
			const otherCenter = {
				x: other.positionAbsolute.x + otherWidth / 2,
				y: other.positionAbsolute.y + otherHeight / 2,
			};
			if (Math.abs(otherCenter.x - currentCenter.x) <= threshold) {
				helperX = otherCenter.x;
			}
			if (Math.abs(otherCenter.y - currentCenter.y) <= threshold) {
				helperY = otherCenter.y;
			}
		}
		setHelperLines({ x: helperX, y: helperY });
	}, [nodeLookup]);

	const handleNodeDragStop = useCallback(() => {
		setHelperLines({ x: null, y: null });
		scheduleHistoryPush();
	}, [scheduleHistoryPush]);

	const eraseAtPoint = useCallback((point: XYPosition) => {
		setStrokes((current) =>
			current.filter((stroke) => {
				if (stroke.type === 'freehand') {
					return stroke.points.every((p) => distanceBetween(p, point) > 16);
				}
				const rectX = Math.min(stroke.start.x, stroke.end.x);
				const rectY = Math.min(stroke.start.y, stroke.end.y);
				const rectW = Math.abs(stroke.start.x - stroke.end.x);
				const rectH = Math.abs(stroke.start.y - stroke.end.y);
				const rectCenter = { x: rectX + rectW / 2, y: rectY + rectH / 2 };
				return distanceBetween(rectCenter, point) > 20;
			})
		);
	}, []);

	const handlePaneMouseDown = useCallback((event: React.MouseEvent) => {
		setContextMenu(null);
		if (activeTool === 'select') {
			return;
		}
		if (event.button !== 0) {
			return;
		}
		isPointerDownRef.current = true;
		event.preventDefault();
		const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
		if (activeTool === 'draw') {
			setDraftStroke({ id: uuidv4(), type: 'freehand', points: [point] });
		} else if (activeTool === 'rect') {
			setDraftStroke({ id: uuidv4(), type: 'rect', start: point, end: point });
		} else if (activeTool === 'lasso') {
			setLassoPoints([point]);
		} else if (activeTool === 'eraser') {
			eraseAtPoint(point);
		}
	}, [activeTool, eraseAtPoint, screenToFlowPosition]);

	const handlePaneMouseMove = useCallback((event: React.MouseEvent) => {
		if (!isPointerDownRef.current) {
			return;
		}
		if (activeTool === 'select') {
			return;
		}
		const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
		if (activeTool === 'draw') {
			setDraftStroke((current) => {
				if (!current || current.type !== 'freehand') {
					return current;
				}
				return { ...current, points: [...current.points, point] };
			});
		} else if (activeTool === 'rect') {
			setDraftStroke((current) => {
				if (!current || current.type !== 'rect') {
					return current;
				}
				return { ...current, end: point };
			});
		} else if (activeTool === 'lasso') {
			setLassoPoints((current) => [...current, point]);
		} else if (activeTool === 'eraser') {
			eraseAtPoint(point);
		}
	}, [activeTool, eraseAtPoint, screenToFlowPosition]);

	const handlePaneMouseUp = useCallback(() => {
		if (!isPointerDownRef.current) {
			return;
		}
		isPointerDownRef.current = false;
		if (activeTool === 'draw' || activeTool === 'rect') {
			setDraftStroke((current) => {
				if (!current) {
					return null;
				}
				setStrokes((prev) => [...prev, current]);
				scheduleHistoryPush();
				return null;
			});
		}
		if (activeTool === 'lasso') {
			setNodes((current) => {
				if (lassoPoints.length < 3) {
					return current;
				}
				const selectedIds = new Set<string>();
			nodeLookup.forEach((node: CanvasNodeLookupEntry, nodeId) => {
				const width = node.measured?.width ?? node.width ?? 0;
				const height = node.measured?.height ?? node.height ?? 0;
				const center = {
					x: node.positionAbsolute.x + width / 2,
					y: node.positionAbsolute.y + height / 2,
				};
				if (pointInPolygon(center, lassoPoints)) {
					selectedIds.add(nodeId);
				}
			});
				return current.map((node) => ({ ...node, selected: selectedIds.has(node.id) }));
			});
			setLassoPoints([]);
		}
		if (activeTool === 'eraser') {
			scheduleHistoryPush();
		}
	}, [activeTool, lassoPoints, nodeLookup, scheduleHistoryPush]);

	const handlePaneContextMenu = useCallback((event: React.MouseEvent) => {
		event.preventDefault();
		setContextMenu({ x: event.clientX, y: event.clientY, context: 'pane' });
	}, []);

	const handleNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
		event.preventDefault();
		setContextMenu({ x: event.clientX, y: event.clientY, context: 'node', nodeId: node.id });
	}, []);

	const handleEdgeContextMenu = useCallback((event: React.MouseEvent, edge: Edge) => {
		event.preventDefault();
		setContextMenu({ x: event.clientX, y: event.clientY, context: 'edge', edgeId: edge.id });
	}, []);

	const addNodeAt = useCallback((point: XYPosition) => {
		const maxWidth = Math.max(900, Math.floor(window.innerWidth - 80));
		const resolvedWidth = clampNumber(nodeWidth, 900, maxWidth);
		const nextId = uuidv4();
		const nextNode: Node<CanvasNodeData> = {
			id: nextId,
			type: 'note',
			position: point,
			data: {
				title: 'New note',
				contentHtml: '<p>New note</p>',
				width: resolvedWidth,
				isRoot: false,
				nodeId: nextId,
				onResize: updateNodeWidth,
				maxWidth,
			},
		};
		setNodes((current) => [...current, nextNode]);
		setNodePositions((prev) => {
			const next = { ...prev, [nextId]: { x: point.x, y: point.y } };
			localStorage.setItem(positionsStorageKey, JSON.stringify(next));
			return next;
		});
		scheduleHistoryPush();
	}, [nodeWidth, positionsStorageKey, scheduleHistoryPush, updateNodeWidth]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) {
				return;
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
				event.preventDefault();
				handleCopy();
				return;
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
				event.preventDefault();
				handlePaste();
				return;
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
				event.preventDefault();
				if (event.shiftKey) {
					handleRedo();
				} else {
					handleUndo();
				}
				return;
			}
			if (event.key === 'Delete' || event.key === 'Backspace') {
				const selectedIds = new Set(
					(getCurrentNodes() as Node<CanvasNodeData>[])
						.filter((node) => node.selected)
						.map((node) => node.id)
				);
				setNodes((current) => current.filter((node) => !selectedIds.has(node.id)));
				setEdges((current) =>
					current.filter((edge) => !edge.selected && !selectedIds.has(edge.source) && !selectedIds.has(edge.target))
				);
				setNodePositions((prev) => {
					const next = { ...prev };
					selectedIds.forEach((id) => {
						delete next[id];
					});
					localStorage.setItem(positionsStorageKey, JSON.stringify(next));
					return next;
				});
				scheduleHistoryPush();
			}
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [getCurrentNodes, handleCopy, handlePaste, handleRedo, handleUndo, positionsStorageKey, scheduleHistoryPush]);

	useEffect(() => {
		localStorage.setItem(strokesStorageKey, JSON.stringify(strokes));
	}, [strokes, strokesStorageKey]);

	const nodeTypes = useMemo<Record<string, React.FC<{ data: CanvasNodeData }>>>(() => ({
		note: NoteNode,
	}), []);

	const getEdgeStyle = (direction: CanvasDirection) => {
		switch (direction) {
			case 'parent':
				return { stroke: '#e74c3c', strokeWidth: 3, opacity: 1 };
			case 'child':
				return { stroke: '#3498db', strokeWidth: 3, opacity: 1 };
			case 'info':
				return { stroke: '#2ecc71', strokeWidth: 3, opacity: 1 };
			case 'knowledge':
				return { stroke: '#f39c12', strokeWidth: 3, opacity: 1 };
			default:
				return { stroke: '#666', strokeWidth: 3, opacity: 1 };
		}
	};

	useEffect(() => {
		if (!graph) {
			setNodes([]);
			setEdges([]);
			return;
		}
		const storedSnapshot = localStorage.getItem(snapshotStorageKey);
		if (storedSnapshot) {
			try {
				const parsed = JSON.parse(storedSnapshot) as CanvasSnapshot;
				setNodes(parsed.nodes || []);
				setEdges(parsed.edges || []);
				setStrokes(parsed.strokes || []);
				applyViewport(parsed.viewport || { x: 0, y: 0, zoom: 1 }, { duration: 0 });
				pushHistory(parsed);
				return;
			} catch {
				// fall through to server payload
			}
		}
		const maxWidth = Math.max(900, Math.floor(viewportSize.width - 80));
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
		pushHistory({ nodes: nextNodes, edges: nextEdges, strokes, viewport: getViewport() });
		setTimeout(() => {
			fitView({ padding: 0.2, duration: 800 });
		}, 100);
	}, [applyViewport, fitView, getViewport, graph, nodeWidth, nodePositions, nodeWidths, pushHistory, snapshotStorageKey, strokes, updateNodeWidth, viewportSize.width]);

	const handleNodesChange = useCallback((changes: NodeChange[]) => {
		setNodes((current) => applyNodeChanges(changes, current) as CanvasNode[]);
		const positionChanges = changes.filter((change): change is NodeChange & { id: string; position: { x: number; y: number } } => {
			return change.type === 'position' && 'position' in change;
		});
		if (positionChanges.length > 0) {
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
		}
		if (changes.some((change) => change.type !== 'position')) {
			scheduleHistoryPush();
		}
	}, [positionsStorageKey, scheduleHistoryPush]);

	const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
		setEdges((current) => applyEdgeChanges(changes, current));
		if (changes.length > 0) {
			scheduleHistoryPush();
		}
	}, [scheduleHistoryPush]);

	const handleConnect = useCallback((connection: Connection) => {
		setEdges((current) => addEdge({ ...connection, type: 'smoothstep' }, current));
		scheduleHistoryPush();
	}, [scheduleHistoryPush]);

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
	}, [graph, nodeWidth, nodeWidths, nodePositions, positionsStorageKey, viewportSize.width, viewportSize.height]);

	const renderStroke = (stroke: CanvasStroke) => {
		if (stroke.type === 'freehand') {
			const path = stroke.points
				.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
				.join(' ');
			return (
				<path
					key={stroke.id}
					d={path}
					fill="none"
					stroke="#f5f5f5"
					strokeWidth={3}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			);
		}
		const x = Math.min(stroke.start.x, stroke.end.x);
		const y = Math.min(stroke.start.y, stroke.end.y);
		const width = Math.abs(stroke.start.x - stroke.end.x);
		const height = Math.abs(stroke.start.y - stroke.end.y);
		return (
			<rect
				key={stroke.id}
				x={x}
				y={y}
				width={width}
				height={height}
				fill="rgba(255, 255, 255, 0.08)"
				stroke="#f5f5f5"
				strokeWidth={2}
			/>
		);
	};

	const renderDraft = () => {
		if (!draftStroke) {
			return null;
		}
		return renderStroke(draftStroke);
	};

	const lassoPath = lassoPoints.length
		? lassoPoints.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ') + ' Z'
		: null;

	return (
		<div
			className="local-vault-canvas-app"
			ref={containerRef}
			style={{ position: 'relative' }}
			onMouseDown={handlePaneMouseDown}
			onMouseMove={handlePaneMouseMove}
			onMouseUp={handlePaneMouseUp}
		>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				onNodesChange={handleNodesChange}
				onEdgesChange={handleEdgesChange}
				onConnect={handleConnect}
				onNodeDrag={handleNodeDrag}
				onNodeDragStop={handleNodeDragStop}
				onMoveEnd={handleMoveEnd}
				onPaneContextMenu={handlePaneContextMenu}
				onNodeContextMenu={handleNodeContextMenu}
				onEdgeContextMenu={handleEdgeContextMenu}
				onPaneClick={() => setContextMenu(null)}
				defaultEdgeOptions={{
					type: 'smoothstep',
					animated: false,
					style: {
						strokeWidth: 3,
						stroke: '#666',
						opacity: 1,
					},
				}}
				connectionLineType={ConnectionLineType.SmoothStep}
				connectionLineStyle={{ stroke: '#8b9cff', strokeWidth: 2 }}
				selectionMode={SelectionMode.Partial}
				selectionKeyCode="Shift"
				multiSelectionKeyCode={multiSelectionKey}
				panOnDrag={activeTool === 'select'}
				panOnScroll
				zoomOnScroll
				zoomOnPinch
				selectionOnDrag={activeTool === 'select'}
				nodesDraggable={activeTool === 'select'}
				nodesConnectable={activeTool === 'select'}
				minZoom={0.1}
				maxZoom={2}
				proOptions={{ hideAttribution: true }}
			>
				<Background gap={24} size={1} />
				<Controls showInteractive={false} />
				<Panel position="top-left">
					<div className="local-vault-canvas-toolbar">
						<button className={activeTool === 'select' ? 'is-active' : ''} onClick={() => setActiveTool('select')}>Select</button>
						<button className={activeTool === 'draw' ? 'is-active' : ''} onClick={() => setActiveTool('draw')}>Draw</button>
						<button className={activeTool === 'rect' ? 'is-active' : ''} onClick={() => setActiveTool('rect')}>Rect</button>
						<button className={activeTool === 'eraser' ? 'is-active' : ''} onClick={() => setActiveTool('eraser')}>Eraser</button>
						<button className={activeTool === 'lasso' ? 'is-active' : ''} onClick={() => setActiveTool('lasso')}>Lasso</button>
						<button onClick={handleUndo}>Undo</button>
						<button onClick={handleRedo}>Redo</button>
						<button onClick={() => fitView({ padding: 0.2, duration: 400 })}>Fit</button>
						<button onClick={handleViewportSave}>Save</button>
						<button onClick={handleViewportRestore}>Restore</button>
					</div>
				</Panel>
				<ViewportPortal>
					<svg
						width={10000}
						height={10000}
						viewBox="-5000 -5000 10000 10000"
						style={{ overflow: 'visible', pointerEvents: 'none' }}
					>
						{strokes.map(renderStroke)}
						{renderDraft()}
						{lassoPath ? (
							<path d={lassoPath} fill="rgba(61, 166, 255, 0.12)" stroke="#3da6ff" strokeWidth={2} />
						) : null}
						{helperLines.x !== null ? (
							<line className="local-vault-canvas-helper-line" x1={helperLines.x} y1={-5000} x2={helperLines.x} y2={5000} />
						) : null}
						{helperLines.y !== null ? (
							<line className="local-vault-canvas-helper-line" x1={-5000} y1={helperLines.y} x2={5000} y2={helperLines.y} />
						) : null}
					</svg>
				</ViewportPortal>
			</ReactFlow>
			{contextMenu ? (
				<div className="local-vault-canvas-context" style={{ left: contextMenu.x, top: contextMenu.y }}>
					{contextMenu.context === 'pane' ? (
						<>
							<button onClick={() => {
								addNodeAt(screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y }));
								setContextMenu(null);
							}}>Add note</button>
							<button onClick={() => {
								handlePaste();
								setContextMenu(null);
							}}>Paste</button>
							<button onClick={() => {
								handleViewportSave();
								setContextMenu(null);
							}}>Save view</button>
							<button onClick={() => {
								handleViewportRestore();
								setContextMenu(null);
							}}>Restore view</button>
							<button onClick={() => {
								handleClearDrawings();
								setContextMenu(null);
							}}>Clear drawings</button>
						</>
					) : null}
					{contextMenu.context === 'node' ? (
						<>
							<button onClick={() => {
								handleCopy();
								setContextMenu(null);
							}}>Copy</button>
							<button onClick={() => {
								setNodes((current) => current.filter((node) => node.id !== contextMenu.nodeId));
								setEdges((current) => current.filter((edge) => edge.source !== contextMenu.nodeId && edge.target !== contextMenu.nodeId));
								scheduleHistoryPush();
								setContextMenu(null);
							}}>Delete</button>
						</>
					) : null}
					{contextMenu.context === 'edge' ? (
						<>
							<button onClick={() => {
								setEdges((current) => current.filter((edge) => edge.id !== contextMenu.edgeId));
								scheduleHistoryPush();
								setContextMenu(null);
							}}>Delete</button>
						</>
					) : null}
				</div>
			) : null}
			<div className="local-vault-canvas-status">{status}</div>
		</div>
	);
};

let canvasRoot: Root | null = null;

const renderCanvas = (container: HTMLElement, config: CanvasConfig) => {
	if (!canvasRoot) {
		canvasRoot = createRoot(container);
	}
	canvasRoot.render(
		<ReactFlowProvider>
			<CanvasApp config={config} />
		</ReactFlowProvider>
	);
};

declare global {
	interface Window {
		__localVaultCanvasRender?: (container: HTMLElement, config: CanvasConfig) => void;
	}
}

window.__localVaultCanvasRender = renderCanvas;
