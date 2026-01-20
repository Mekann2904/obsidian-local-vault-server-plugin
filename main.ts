// Path: main.ts
// Role: Obsidian 内でローカルファイル配信サーバーを管理するプラグイン本体
// Why: Vault 内のファイルを安全に配信し、設定 UI とログ表示を提供するため
// Related: manifest.json, README.md, styles.css, main.js
import { App, Plugin, PluginSettingTab, Setting, Modal, Notice, DataAdapter, FileSystemAdapter, TextComponent, TFile, MarkdownRenderer, Component } from 'obsidian';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
// @ts-ignore // uuid ライブラリが見つからない場合のエラーを無視
import { v4 as uuidv4 } from 'uuid'; // 各サーバーエントリにユニークなIDを振るために使用 (要 npm install uuid)
import { URL } from 'url';

const MAX_LOG_ENTRIES = 300; // 保持するログの最大件数
const INDEX_CACHE_TTL_MS = 8000; // インデックスの短期キャッシュ (ms)
const DEFAULT_INDEX_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'webp',
	'gif',
	'bmp',
	'svg',
	'avif',
	'tif',
	'tiff',
]);
const MARKDOWN_PREVIEW_QUERY_KEY = 'preview';
const MARKDOWN_PREVIEW_ENDPOINT = '/__markdown-preview';
const MARKDOWN_PREVIEW_ASSET_ENDPOINT = '/__markdown-asset';
const MARKDOWN_PREVIEW_TOKEN_TTL_MS = 2 * 60 * 1000;

/**
 * 個々のサーバー設定用インターフェース
 */
interface ServerEntrySettings {
    id: string; // ユニークな識別子
    name: string; // 設定画面表示用の名前
 	host: string;
	port: number;
	/** 公開するフォルダーの絶対パス */
	serveDir: string;
	/** ホワイトリストモードを有効にすると、serveDir 内のファイルのうち、チェックリストで選択したファイルのみが配信対象となります */
	enableWhitelist: boolean;
	/** ホワイトリストに登録されたファイル（serveDir からの相対パス）のリスト */
	whitelistFiles: string[];
	/** 認証トークンを設定すると、各リクエストで "Authorization: Bearer <token>" ヘッダーが必要になります */
	authToken: string;
	/** ローカルホスト（127.0.0.1）からのアクセスのみトークン認証をスキップします。セキュリティ上、信頼できる環境でのみ使用してください。 */
	allowLocalhostNoToken: boolean;
	/** HTTPS を有効にするか */
	enableHttps: boolean;
	/** SSL 証明書ファイル (.pem) のパス */
	sslCertPath: string;
	/** SSL 秘密鍵ファイル (.key または .pem) のパス */
	sslKeyPath: string;
}

const DEFAULT_SERVER_ENTRY: ServerEntrySettings = {
    id: '', // UUID will be assigned
    name: 'New Server',
    host: '127.0.0.1',
    port: 3000,
    serveDir: '',
    enableWhitelist: false,
    whitelistFiles: [],
    authToken: '',
    allowLocalhostNoToken: false,
    enableHttps: false,
    sslCertPath: '',
    sslKeyPath: '',
};


/**
 * プラグイン全体の設定用インターフェース
 */
interface LocalServerPluginSettings {
	serverEntries: ServerEntrySettings[]; // 複数のサーバー設定を保持する配列
}

/**
 * 初期設定値
 */
const DEFAULT_SETTINGS: LocalServerPluginSettings = {
	serverEntries: [], // 最初はサーバーエントリなし
};

// 起動中のサーバーインスタンスとそれに関連する情報を保持する構造
interface RunningServerInfo {
    server: http.Server | https.Server | null; // null の可能性も追加
    entry: ServerEntrySettings; // 元の設定エントリへの参照
    servedRealPath: string | null; // このエントリの解決済みパス
    // *** Error 4 Correction ***
    status: 'running' | 'error' | 'stopped'; // 'stopped' 状態を追加
    // *** End Correction ***
    errorMessage?: string; // エラーがある場合
}

/**
 * 外部連携用 API
 */
interface LocalVaultServerApi {
	apiVersion: number;
	getServerEntries: () => ServerEntrySettings[];
	getRunningServers: () => LocalVaultServerRunningInfo[];
	onSettingsChanged: (handler: (settings: LocalServerPluginSettings) => void) => () => void;
}

interface LocalVaultServerRunningInfo {
	id: string;
	status: 'running' | 'error' | 'stopped';
	baseUrl: string;
	host: string;
	port: number;
	serveDir: string;
	authToken: string;
	enableHttps: boolean;
}

interface IndexCacheEntry {
	etag: string;
	createdAt: number;
	payload: string;
}

interface IndexItem {
	relativePath: string;
	name: string;
	size: number;
	mtime: number;
}


export default class LocalServerPlugin extends Plugin {
	settings: LocalServerPluginSettings;
	/** 起動中のサーバーインスタンスを ID に紐づけて管理 */
	runningServers: Map<string, RunningServerInfo> = new Map();
	/** 設定画面で表示中のファイルリスト（ホワイトリスト用） */
	settingTabFileList: Map<string, string[]> = new Map(); // entryId -> files list
	/** ホワイトリスト用ファイル一覧の読み込み中フラグ */
	settingTabFileListLoading: Set<string> = new Set();
	/** 設定変更の通知先 */
	private settingsListeners: Set<(settings: LocalServerPluginSettings) => void> = new Set();
	/** インデックスの短期キャッシュ */
	private indexCache: Map<string, IndexCacheEntry> = new Map();
	/** Vault の実パスをキャッシュして同期 I/O を減らす */
	private vaultBasePathCache: string | null = null;
	/** 一時プレビュー用のトークン保管 */
	private previewTokens: Map<string, { filePath: string; expiresAt: number }> = new Map();

	// *** Error 2 & 5: Property 'statusBarItemEl' / 'logMessages' does not exist on type 'LocalServerPlugin'. ***
    // These properties ARE defined below. If the error persists, it's likely an environment issue.
    // No code change here, assuming the declarations below are correct.
    logMessages: { timestamp: Date, type: 'log' | 'warn' | 'error', message: string }[] = [];
    statusBarItemEl: HTMLElement | null = null;
    // *** End of Error 2 & 5 consideration ***


	async onload() {
		// uuidv4 が使用可能か確認 (ランタイムチェック)
		// @ts-ignore
		if (typeof uuidv4 === 'undefined') {
            this.log('error', 'UUID library not found. Please install it using npm install uuid');
            new Notice('Local Server: UUID library not found. Please install it to manage multiple servers.', 10000); // 長めの通知
            // uuid がないとエントリ管理が困難になるため、ここで処理を中断することも検討
            // return;
        } else {
             this.log('info', 'UUID library is available.');
        }


		this.log('info', 'LocalServerPlugin loading...');
		await this.loadSettings();
		const idsChanged = this.ensureUniqueEntryIds();
		if (idsChanged) {
			await this.saveSettings(false, false);
		}

        // 設定のマイグレーション（古い単一設定から新しい複数設定へ）
        if (!Array.isArray(this.settings.serverEntries) || this.settings.serverEntries.length === 0) {
             const oldSettings: any = await this.loadData();
             // 古い設定ファイルが存在し、かつ新しいserverEntries形式でない場合
             if (oldSettings && !Array.isArray(oldSettings.serverEntries) && oldSettings.host && oldSettings.port && oldSettings.serveDir !== undefined) {
                 this.log('info', 'Migrating old single server settings...');
                  const newEntry: ServerEntrySettings = {
                      id: typeof uuidv4 !== 'undefined' ? uuidv4() : 'migrated-server-1', // uuid がない場合は仮ID
                      name: 'Default Server (Migrated)',
                      host: oldSettings.host,
                      port: oldSettings.port,
                      serveDir: oldSettings.serveDir,
                      enableWhitelist: oldSettings.enableWhitelist ?? DEFAULT_SERVER_ENTRY.enableWhitelist,
                      whitelistFiles: oldSettings.whitelistFiles ?? DEFAULT_SERVER_ENTRY.whitelistFiles,
                      authToken: oldSettings.authToken ?? DEFAULT_SERVER_ENTRY.authToken,
                      allowLocalhostNoToken: oldSettings.allowLocalhostNoToken ?? DEFAULT_SERVER_ENTRY.allowLocalhostNoToken,
                      enableHttps: oldSettings.enableHttps ?? DEFAULT_SERVER_ENTRY.enableHttps,
                      sslCertPath: oldSettings.sslCertPath ?? DEFAULT_SERVER_ENTRY.sslCertPath,
                      sslKeyPath: oldSettings.sslKeyPath ?? DEFAULT_SERVER_ENTRY.sslKeyPath,
                  };
                 this.settings.serverEntries = [newEntry];
                 await this.saveSettings(false, false); // 保存のみ
                 this.log('info', 'Migration complete.');
                 new Notice('Local Server: Old settings migrated to a new server entry.');
             } else if (oldSettings === null) {
                 this.log('info', 'No existing settings file found. Starting fresh.');
             } else {
                 this.log('warn', 'No server entries found in settings or settings file format is unexpected. Please add a new entry in settings.');
                 new Notice('Local Server: サーバーエントリが設定されていません。プラグイン設定で新しいエントリを追加してください。');
             }
        }


		this.addSettingTab(new LocalServerSettingTab(this.app, this));
		this.addCommand({
			id: 'open-markdown-in-external-browser',
			name: '外部ブラウザで Markdown を開く（HTML）',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile || !this.isMarkdownFile(activeFile.path)) {
					return false;
				}
				if (!checking) {
					void this.openMarkdownInExternalBrowser(activeFile);
				}
				return true;
			},
		});

		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.addClass('mod-clickable');
		this.updateStatusBarIcon(); // サーバー起動前に一度更新
		this.statusBarItemEl.onclick = () => {
			new LogModal(this.app, this.logMessages).open();
		};

        // すべてのサーバーを起動
		this.startAllServers();

		this.log('info', 'LocalServerPlugin loaded.');
	}

	onunload() {
		this.log('info', 'LocalServerPlugin unloading...');
		this.stopAllServers(); // stopAllServers はマップをクリアする
		if (this.statusBarItemEl) {
			this.statusBarItemEl.remove();
		}
		// this.runningServers.clear(); // stopAllServers でクリアされる
		this.settingTabFileList.clear();
		this.settingTabFileListLoading.clear();
		this.log('info', 'LocalServerPlugin unloaded.');
	}

	/**
	 * 連携用 API を返す
	 */
	getApi(): LocalVaultServerApi {
		return {
			apiVersion: 1,
			getServerEntries: () => this.settings.serverEntries.map((entry) => ({
				...entry,
				whitelistFiles: [...entry.whitelistFiles],
			})),
			getRunningServers: () =>
				Array.from(this.runningServers.values()).map((info) => ({
					id: info.entry.id,
					status: info.status,
					baseUrl: this.buildBaseUrl(info.entry),
					host: info.entry.host,
					port: info.entry.port,
					serveDir: info.entry.serveDir,
					authToken: info.entry.authToken,
					enableHttps: info.entry.enableHttps,
				})),
			onSettingsChanged: (handler) => {
				this.settingsListeners.add(handler);
				return () => {
					this.settingsListeners.delete(handler);
				};
			},
		};
	}

	private notifySettingsChanged(): void {
		for (const handler of this.settingsListeners) {
			try {
				handler(this.settings);
			} catch (err: any) {
				this.log('warn', `Settings listener error: ${err?.message ?? err}`);
			}
		}
	}

	private buildBaseUrl(entry: ServerEntrySettings): string {
		const protocol = entry.enableHttps ? 'https' : 'http';
		const host = entry.host === '0.0.0.0' ? '127.0.0.1' : entry.host;
		return `${protocol}://${host}:${entry.port}`;
	}

	private isMarkdownFile(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		return ext === '.md' || ext === '.markdown' || ext === '.mdown';
	}

	private isImageFile(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		return [
			'.png',
			'.jpg',
			'.jpeg',
			'.gif',
			'.webp',
			'.avif',
			'.bmp',
			'.tif',
			'.tiff',
			'.svg',
		].includes(ext);
	}

	private isPdfFile(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		return ext === '.pdf';
	}

	private findRunningServerForPreview(): RunningServerInfo | null {
		const candidates = Array.from(this.runningServers.values())
			.filter((info) => info.status === 'running' && info.server);
		if (candidates.length === 0) {
			return null;
		}
		const preferred = candidates.find((info) => info.entry.host === '127.0.0.1' || info.entry.host === 'localhost');
		return preferred ?? candidates[0];
	}

	private prunePreviewTokens(): void {
		const now = Date.now();
		for (const [token, info] of this.previewTokens) {
			if (info.expiresAt <= now) {
				this.previewTokens.delete(token);
			}
		}
	}

	private issuePreviewToken(filePath: string): string {
		this.prunePreviewTokens();
		const token = crypto.randomBytes(16).toString('hex');
		this.previewTokens.set(token, { filePath, expiresAt: Date.now() + MARKDOWN_PREVIEW_TOKEN_TTL_MS });
		return token;
	}

	private resolvePreviewToken(token: string | null): string | null {
		if (!token) {
			return null;
		}
		this.prunePreviewTokens();
		const info = this.previewTokens.get(token);
		if (!info) {
			return null;
		}
		return info.filePath;
	}

	private buildMarkdownPreviewUrl(entry: ServerEntrySettings, token: string | null, sourcePath?: string): string {
		const baseUrl = this.buildBaseUrl(entry);
		if (token) {
			const cacheBust = Date.now().toString();
			return `${baseUrl}${MARKDOWN_PREVIEW_ENDPOINT}?token=${token}&ts=${cacheBust}`;
		} else if (entry.allowLocalhostNoToken && sourcePath) {
			const vaultRelative = this.getVaultRelativePath(this.getVaultBasePath()!, sourcePath);
			return `${baseUrl}${vaultRelative}`;
		}
		throw new Error('Token is required for preview URL generation.');
	}

	private buildMarkdownAssetUrl(entry: ServerEntrySettings, token: string | null, vaultPath: string): string {
		const baseUrl = this.buildBaseUrl(entry);
		const encodedPath = encodeURIComponent(vaultPath);
		if (token) {
			return `${baseUrl}${MARKDOWN_PREVIEW_ASSET_ENDPOINT}?token=${token}&path=${encodedPath}`;
		} else if (entry.allowLocalhostNoToken) {
			const vaultBasePath = this.getVaultBasePath();
			const vaultRelative = vaultBasePath ? this.getVaultRelativePath(vaultBasePath, vaultPath) : encodedPath;
			return `${baseUrl}${vaultRelative}`;
		}
		return `${baseUrl}${MARKDOWN_PREVIEW_ASSET_ENDPOINT}?token=${token ?? ''}&path=${encodedPath}`;
	}

	private isExternalUrl(url: string): boolean {
		return /^https?:\/\//i.test(url) || /^data:/i.test(url) || /^blob:/i.test(url) || /^mailto:/i.test(url);
	}

	private isLocalhostRequest(req: http.IncomingMessage): boolean {
		const remoteAddress = req.socket?.remoteAddress ?? '';
		if (remoteAddress === '127.0.0.1') {
			return true;
		}
		if (remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1') {
			return true;
		}
		return false;
	}

	private extractVaultPathFromAppUrl(url: string): string | null {
		try {
			const parsed = new URL(url);
			const decoded = decodeURIComponent(parsed.pathname);
			const normalized = decoded.replace(/^\/+/, '');
			const parts = normalized.split('/').filter(Boolean);
			const vaultBasePath = this.getVaultBasePath();

			const candidates: string[] = [];
			if (parts.length > 1) {
				candidates.push(parts.slice(1).join('/'));
			}
			if (normalized) {
				candidates.push(normalized);
			}
			if (vaultBasePath && normalized) {
				const absoluteCandidate = path.normalize(`/${normalized}`);
				if (this.isPathInside(vaultBasePath, absoluteCandidate)) {
					const relative = path.relative(vaultBasePath, absoluteCandidate);
					candidates.unshift(relative.split(path.sep).join(path.posix.sep));
				}
			}

			for (const candidate of candidates) {
				const file = this.app.vault.getAbstractFileByPath(candidate);
				if (file instanceof TFile) {
					return candidate;
				}
			}

			return candidates[0] ?? null;
		} catch {
			return null;
		}
	}

	private resolveVaultAssetPath(src: string, sourcePath: string): string | null {
		const cleaned = src.split('#')[0]?.split('?')[0] ?? '';
		let decoded = cleaned;
		if (cleaned) {
			try {
				decoded = decodeURIComponent(cleaned);
			} catch {
				decoded = cleaned;
			}
		}
		if (!decoded) {
			return null;
		}
		if (decoded.startsWith('app://') || decoded.startsWith('obsidian://')) {
			const extracted = this.extractVaultPathFromAppUrl(decoded);
			if (extracted) {
				return extracted;
			}
		}
		if (decoded.startsWith('/')) {
			return decoded.replace(/^\/+/, '');
		}
		const dest = this.app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
		if (dest instanceof TFile) {
			return dest.path;
		}
		const sourceDir = path.posix.dirname(sourcePath);
		const candidate = path.posix.normalize(path.posix.join(sourceDir, decoded));
		const file = this.app.vault.getAbstractFileByPath(candidate);
		if (file instanceof TFile) {
			return file.path;
		}
		// メタデータ解決に失敗したときは、Vault 実パスを使って存在確認する。
		const vaultBasePath = this.getVaultBasePath();
		if (vaultBasePath) {
			const absoluteCandidate = path.resolve(vaultBasePath, decoded);
			try {
				const resolved = fs.realpathSync(absoluteCandidate);
				if (this.isPathInside(vaultBasePath, resolved)) {
					const relative = path.relative(vaultBasePath, resolved);
					const vaultRelative = relative.split(path.sep).join(path.posix.sep);
					const fallbackFile = this.app.vault.getAbstractFileByPath(vaultRelative);
					if (fallbackFile instanceof TFile) {
						return fallbackFile.path;
					}
				}
			} catch {
				// ファイルが存在しない場合は無視する。
			}
		}
		return null;
	}

	private rewriteMarkdownPreviewAssets(
		container: HTMLElement,
		sourcePath: string,
		entry: ServerEntrySettings,
		token: string | null
	): void {
		const images = Array.from(container.querySelectorAll('img'));
		const useToken = !entry.allowLocalhostNoToken;
		for (const img of images) {
			const rawSrc = img.getAttribute('src') ?? '';
			const dataSrc = img.getAttribute('data-src') ?? '';
			const src = rawSrc || dataSrc;
			if (!src || this.isExternalUrl(src)) {
				continue;
			}
			const assetPath = this.resolveVaultAssetPath(src, sourcePath);
			if (!assetPath) {
				continue;
			}
			let tokenToUse: string | null = useToken ? token : null;
			if (useToken) {
				tokenToUse = token;
			}
			img.setAttribute('src', this.buildMarkdownAssetUrl(entry, tokenToUse, assetPath));
			if (dataSrc) {
				img.removeAttribute('data-src');
			}
		}
	}

	private rewriteMarkdownPreviewLinks(
		container: HTMLElement,
		sourcePath: string,
		entry: ServerEntrySettings
	): void {
		const links = Array.from(container.querySelectorAll('a'));
		const vaultBasePath = this.getVaultBasePath();
		for (const link of links) {
			const href = link.getAttribute('href');
			if (!href || this.isExternalUrl(href)) {
				continue;
			}
			const hashMatch = href.match(/^(.*?)(#.*)?$/);
			const pathPart = hashMatch ? hashMatch[1] ?? href : href;
			const hashPart = hashMatch?.[2] ?? '';
			if (!pathPart && !hashPart) {
				continue;
			}
			if (!pathPart) {
				continue;
			}
			const assetPath = this.resolveVaultAssetPath(pathPart, sourcePath);
			if (!assetPath) {
				continue;
			}
			if (!vaultBasePath) {
				continue;
			}
			const absolutePath = path.join(vaultBasePath, assetPath);
			let resolvedPath: string;
			try {
				resolvedPath = fs.realpathSync(absolutePath);
			} catch {
				continue;
			}
			if (!this.isPathInside(vaultBasePath, resolvedPath)) {
				continue;
			}
			if (this.isMarkdownFile(resolvedPath)) {
				const token = entry.allowLocalhostNoToken ? null : this.issuePreviewToken(resolvedPath);
				const newUrl = this.buildMarkdownPreviewUrl(entry, token, resolvedPath) + hashPart;
				link.setAttribute('href', newUrl);
				link.setAttribute('target', '_blank');
			} else if (this.isPdfFile(resolvedPath)) {
				const token = entry.allowLocalhostNoToken ? null : this.issuePreviewToken(resolvedPath);
				const newUrl = this.buildMarkdownAssetUrl(entry, token, assetPath) + hashPart;
				link.setAttribute('href', newUrl);
				link.setAttribute('target', '_blank');
			}
		}
	}

	private prepareMarkdownForPreview(markdown: string, sourcePath: string): {
		markdown: string;
		mathPlaceholders: Map<string, { mode: 'inline' | 'block'; content: string }>;
	} {
		const withEmbeds = this.replaceObsidianImageEmbeds(markdown, sourcePath);
		const normalizedImages = this.normalizeMarkdownImageLinks(withEmbeds);
		return this.extractMathPlaceholders(normalizedImages);
	}

	private replaceObsidianImageEmbeds(markdown: string, sourcePath: string): string {
		return markdown.replace(/!\[\[([^\]]+)\]\]/g, (_match, inner: string) => {
			const parts = inner.split('|');
			const linkPath = (parts[0] ?? '').trim();
			const altText = (parts[1] ?? path.posix.basename(linkPath)).trim();
			if (!linkPath) {
				return _match;
			}
			return `![${altText}](${linkPath})`;
		});
	}

	private normalizeMarkdownImageLinks(markdown: string): string {
		return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt: string, rawTarget: string) => {
			const trimmed = rawTarget.trim();
			if (!trimmed) {
				return match;
			}
			let urlPart = trimmed;
			let titlePart = '';
			const titleMatch = trimmed.match(/\s+(".*?"|'.*?')\s*$/);
			if (titleMatch && titleMatch.index !== undefined) {
				titlePart = titleMatch[1];
				urlPart = trimmed.slice(0, titleMatch.index).trim();
			}
			if (!urlPart || this.isExternalUrl(urlPart)) {
				return match;
			}
			const encoded = this.encodeMarkdownUrl(urlPart);
			if (encoded === urlPart) {
				return match;
			}
			return `![${alt}](${encoded}${titlePart ? ` ${titlePart}` : ''})`;
		});
	}

	private encodeMarkdownUrl(value: string): string {
		return encodeURI(value).replace(/\(/g, '%28').replace(/\)/g, '%29');
	}

	private extractMathPlaceholders(markdown: string): {
		markdown: string;
		mathPlaceholders: Map<string, { mode: 'inline' | 'block'; content: string }>;
	} {
		const mathPlaceholders = new Map<string, { mode: 'inline' | 'block'; content: string }>();
		let counter = 0;

		const replaceWithPlaceholder = (content: string, mode: 'inline' | 'block'): string => {
			const key = `@@MATH_${counter++}@@`;
			mathPlaceholders.set(key, { mode, content });
			return key;
		};

		const replaceMath = (input: string): string => {
			let output = input;
			const blockPatterns: Array<{ regex: RegExp; wrap: (value: string) => string }> = [
				{ regex: /\$\$([\s\S]+?)\$\$/g, wrap: (value) => value },
				{ regex: /\\\\\[((?:.|\n)+?)\\\\\]/g, wrap: (value) => value },
			];
			const inlinePatterns: Array<{ regex: RegExp; wrap: (value: string) => string }> = [
				{ regex: /\\\\\((.+?)\\\\\)/g, wrap: (value) => value },
				{ regex: /\$(?!\$)([^$\n]+?)\$(?!\$)/g, wrap: (value) => value },
			];

			for (const pattern of blockPatterns) {
				output = output.replace(pattern.regex, (_match, value: string) => replaceWithPlaceholder(pattern.wrap(value), 'block'));
			}
			for (const pattern of inlinePatterns) {
				output = output.replace(pattern.regex, (_match, value: string) => replaceWithPlaceholder(pattern.wrap(value), 'inline'));
			}
			return output;
		};

		const fenceRegex = /(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~)/gm;
		const parts = markdown.split(fenceRegex);
		const processed = parts
			.map((part) => {
				if (part.startsWith('```') || part.startsWith('~~~')) {
					return part;
				}
				return replaceMath(part);
			})
			.join('');

		return { markdown: processed, mathPlaceholders };
	}

	private restoreMathPlaceholders(container: HTMLElement, placeholders: Map<string, { mode: 'inline' | 'block'; content: string }>): void {
		if (placeholders.size === 0) {
			return;
		}
		const escapeMathHtml = (value: string): string =>
			value
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');

		let html = container.innerHTML;
		for (const [key, value] of placeholders) {
			const escaped = escapeMathHtml(value.content);
			const wrapped = value.mode === 'block'
				? `\\[${escaped}\\]`
				: `\\(${escaped}\\)`;
			html = html.split(key).join(wrapped);
		}
		container.innerHTML = html;
	}

	private openExternalUrl(url: string): void {
		try {
			const electron = (window as any)?.require?.('electron');
			if (electron?.shell?.openExternal) {
				electron.shell.openExternal(url);
				return;
			}
		} catch {
			// Fallback to window.open when Electron shell is unavailable.
		}
		window.open(url);
	}

	private async openMarkdownInExternalBrowser(file: TFile): Promise<void> {
		const vaultBasePath = this.getVaultBasePath();
		if (!vaultBasePath) {
			new Notice('Vault の実パスを取得できません。');
			return;
		}

		const absolutePath = path.join(vaultBasePath, file.path);
		let resolvedPath: string;
		try {
			resolvedPath = fs.realpathSync(absolutePath);
		} catch (error: any) {
			this.log('error', `Failed to resolve file path for preview: ${error?.message ?? error}`);
			new Notice('ファイルの実パスを取得できませんでした。');
			return;
		}

		if (!this.isPathInside(vaultBasePath, resolvedPath)) {
			new Notice('Vault 外のファイルは開けません。');
			return;
		}

		const serverInfo = this.findRunningServerForPreview();
		if (!serverInfo) {
			new Notice('起動中のサーバーがありません。');
			return;
		}

		const token = this.issuePreviewToken(resolvedPath);
		const previewUrl = this.buildMarkdownPreviewUrl(serverInfo.entry, token);
		this.log('info', `Opening markdown preview: ${previewUrl}`, serverInfo.entry.name);
		this.openExternalUrl(previewUrl);
	}

	log(type: 'info' | 'warn' | 'error', message: string, entryName?: string, ...optionalParams: any[]) {
		const timestamp = new Date();
        const logType: 'log' | 'warn' | 'error' = type === 'info' ? 'log' : type;
        const prefix = entryName ? `[Server:${entryName}]` : '[LocalServer]';
        const fullMessage = `${prefix} ${message}`;

		switch (type) {
			case 'info':
				console.log(fullMessage, ...optionalParams);
				break;
			case 'warn':
				console.warn(fullMessage, ...optionalParams);
				break;
			case 'error':
				console.error(fullMessage, ...optionalParams);
				break;
		}

		this.logMessages.push({ timestamp, type: logType, message: fullMessage });
		if (this.logMessages.length > MAX_LOG_ENTRIES) {
			this.logMessages.shift();
		}
	}

	updateStatusBarIcon() {
		if (!this.statusBarItemEl) return;

        const runningCount = Array.from(this.runningServers.values()).filter(info => info.status === 'running').length;
        const errorCount = Array.from(this.runningServers.values()).filter(info => info.status === 'error').length;
        const totalCount = this.settings.serverEntries.length;

        if (totalCount === 0) {
            this.statusBarItemEl.setText('🌐 Idle');
            this.statusBarItemEl.ariaLabel = 'Local server plugin is idle. Configure server entries in settings.';
        } else if (runningCount === totalCount) {
             this.statusBarItemEl.setText(`🌐 ${runningCount} Running`);
             this.statusBarItemEl.ariaLabel = `Local server plugin: ${runningCount} server(s) running. Click to view logs.`;
        } else if (runningCount > 0) {
             this.statusBarItemEl.setText(`🌐 ${runningCount}/${totalCount} Running`);
             this.statusBarItemEl.ariaLabel = `Local server plugin: ${runningCount} of ${totalCount} server(s) running (${errorCount} error(s)). Click to view logs.`;
        } else if (errorCount > 0) {
             this.statusBarItemEl.setText(`🌐 ${errorCount}/${totalCount} Errors`); // エラー数/合計数を表示
             this.statusBarItemEl.ariaLabel = `Local server plugin: ${errorCount} server(s) failed to start. Click to view logs.`;
        } else {
             // totalCount > 0 だが running も error も 0 の場合 (すべて stopped 状態など)
             this.statusBarItemEl.setText('🌐 Stopped');
             this.statusBarItemEl.ariaLabel = 'Local server plugin: All servers stopped. Click to view logs.';
        }
	}

	// ディスクから読み込んだ設定を安全に正規化する
	private normalizeSettings(raw: unknown): LocalServerPluginSettings {
		const data = (raw && typeof raw === 'object') ? (raw as any) : {};
		const entries = Array.isArray(data.serverEntries) ? data.serverEntries : [];
		return {
			serverEntries: entries.map((entry: Partial<ServerEntrySettings>) => this.normalizeServerEntry(entry)),
		};
	}

	// サーバーエントリの型と初期値を保証する
	private normalizeServerEntry(raw: Partial<ServerEntrySettings>): ServerEntrySettings {
		const entry = raw ?? {};
		const parsedPort = typeof entry.port === 'string' ? Number.parseInt(entry.port, 10) : entry.port;
		const normalizedPort = Number.isFinite(parsedPort) ? (parsedPort as number) : DEFAULT_SERVER_ENTRY.port;
		const port = (normalizedPort >= 1 && normalizedPort <= 65535) ? normalizedPort : DEFAULT_SERVER_ENTRY.port;
		const whitelistFiles = Array.isArray(entry.whitelistFiles)
			? entry.whitelistFiles.filter((value) => typeof value === 'string')
			: [];

		return {
			id: (typeof entry.id === 'string' && entry.id.trim()) ? entry.id : DEFAULT_SERVER_ENTRY.id,
			name: (typeof entry.name === 'string' && entry.name.trim()) ? entry.name.trim() : DEFAULT_SERVER_ENTRY.name,
			host: (typeof entry.host === 'string' && entry.host.trim()) ? entry.host.trim() : DEFAULT_SERVER_ENTRY.host,
			port,
			serveDir: typeof entry.serveDir === 'string' ? entry.serveDir : DEFAULT_SERVER_ENTRY.serveDir,
			enableWhitelist: typeof entry.enableWhitelist === 'boolean' ? entry.enableWhitelist : DEFAULT_SERVER_ENTRY.enableWhitelist,
			whitelistFiles,
			authToken: typeof entry.authToken === 'string' ? entry.authToken : DEFAULT_SERVER_ENTRY.authToken,
			allowLocalhostNoToken: typeof entry.allowLocalhostNoToken === 'boolean' ? entry.allowLocalhostNoToken : DEFAULT_SERVER_ENTRY.allowLocalhostNoToken,
			enableHttps: typeof entry.enableHttps === 'boolean' ? entry.enableHttps : DEFAULT_SERVER_ENTRY.enableHttps,
			sslCertPath: typeof entry.sslCertPath === 'string' ? entry.sslCertPath : DEFAULT_SERVER_ENTRY.sslCertPath,
			sslKeyPath: typeof entry.sslKeyPath === 'string' ? entry.sslKeyPath : DEFAULT_SERVER_ENTRY.sslKeyPath,
		};
	}

	// ID の欠落や重複を解消する
	private ensureUniqueEntryIds(): boolean {
		const seen = new Set<string>();
		let changed = false;

		for (const entry of this.settings.serverEntries) {
			let id = (typeof entry.id === 'string') ? entry.id.trim() : '';
			if (!id || seen.has(id)) {
				let newId = '';
				do {
					newId = (typeof uuidv4 === 'function')
						? uuidv4()
						: `temp-${Date.now()}-${Math.random()}`;
				} while (seen.has(newId));
				entry.id = newId;
				changed = true;
				if (typeof uuidv4 !== 'function') {
					this.log('warn', `UUID library not available, using temporary ID "${newId}" for entry "${entry.name}".`, entry.name);
				}
				id = newId;
			}
			seen.add(id);
		}

		return changed;
	}

	// child が parent 配下かどうかを判定する
	isPathInside(parent: string, child: string): boolean {
		const relative = path.relative(parent, child);
		if (!relative) return true;
		return !relative.startsWith('..') && !path.isAbsolute(relative);
	}

	// Vault の実パスを取得する
	private getVaultBasePath(): string | null {
		if (this.vaultBasePathCache) {
			return this.vaultBasePathCache;
		}
		const adapter = this.app.vault.adapter;
		if (adapter && typeof (adapter as any).getBasePath === 'function') {
			try {
				const resolved = fs.realpathSync((adapter as any).getBasePath());
				this.vaultBasePathCache = resolved;
				return resolved;
			} catch {
				return null;
			}
		}
		return null;
	}

	// 絶対パスを Vault 相対パスへ変換する
	private getVaultRelativePath(basePath: string, absolutePath: string): string | null {
		try {
			const realPath = fs.realpathSync(absolutePath);
			if (!this.isPathInside(basePath, realPath)) {
				return null;
			}
			const relative = path.relative(basePath, realPath);
			return relative.split(path.sep).join(path.posix.sep);
		} catch {
			return null;
		}
	}

	// Obsidian の Vault に存在するファイルかを確認する
	private isVaultFile(basePath: string, absolutePath: string): boolean {
		const vaultPath = this.getVaultRelativePath(basePath, absolutePath);
		if (!vaultPath) {
			return false;
		}
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		return file instanceof TFile;
	}

	// realpath 済みのパスから Vault ファイルかを確認する
	private isVaultFileResolvedPath(basePath: string, resolvedPath: string): boolean {
		const relative = path.relative(basePath, resolvedPath);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			return false;
		}
		const vaultPath = relative.split(path.sep).join(path.posix.sep);
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		return file instanceof TFile;
	}

	resolveServedPath(entry: ServerEntrySettings): string | null {
        if (!entry.serveDir) {
            return null;
        }
        try {
            let potentialPath = entry.serveDir;
            const isRelative = !path.isAbsolute(potentialPath);
            let baseRealPath: string | null = null;
            if (isRelative) {
                const adapter = this.app.vault.adapter;
                const basePath = adapter && typeof (adapter as any).getBasePath === 'function'
                    ? (adapter as any).getBasePath()
                    : null;

                if (basePath) {
                    // Vault ルートの実パスを取得してから結合する
                    baseRealPath = fs.realpathSync(basePath);
                    potentialPath = path.join(baseRealPath, entry.serveDir);
                } else {
                    this.log('error', `Cannot resolve relative path "${entry.serveDir}" for entry "${entry.name}". Vault adapter base path not available.`, entry.name);
                    return null;
                }
            }

            const normalizedPotentialPath = path.normalize(potentialPath);
            if (!fs.existsSync(normalizedPotentialPath)) {
                this.log('error', `Serve folder path "${normalizedPotentialPath}" does not exist for entry "${entry.name}".`, entry.name);
                return null;
            }
            const realPath = fs.realpathSync(normalizedPotentialPath);

            // 相対パスの場合は Vault 配下のみ許可する
            if (isRelative && baseRealPath && !this.isPathInside(baseRealPath, realPath)) {
                this.log('error', `Serve path "${realPath}" escapes vault root for entry "${entry.name}".`, entry.name);
                return null;
            }

            if (!fs.statSync(realPath).isDirectory()) {
                 this.log('error', `Resolved serve path "${realPath}" for entry "${entry.name}" is not a directory.`, entry.name);
                 return null;
            }

            this.log('info', `Serve folder resolved to "${realPath}" for entry "${entry.name}".`, entry.name);
            return realPath;
        } catch (err: any) {
            this.log('error', `Serve folder path resolution error for entry "${entry.name}" ("${entry.serveDir}"): ${err.message}`, entry.name, err);
            return null;
        }
    }

	async startAllServers() {
		await this.stopAllServers(); // 既存のサーバーをすべて停止
		const idsChanged = this.ensureUniqueEntryIds();
		if (idsChanged) {
			await this.saveSettings(false, false);
		}

		this.runningServers.clear(); // マップをクリア

		if (this.settings.serverEntries.length === 0) {
			this.log('info', 'No server entries configured. Skipping server start.');
			this.updateStatusBarIcon();
			return;
		}

		for (const entry of this.settings.serverEntries) {
            // ID がないエントリがあれば生成
            // @ts-ignore // uuidv4 が undefined の可能性を無視
            if (!entry.id) {
                 entry.id = typeof uuidv4 === 'function' ? uuidv4() : `temp-${Date.now()}-${Math.random()}`; // uuid なければ仮ID
                 if (typeof uuidv4 !== 'function') {
                     this.log('warn', `UUID library not available, using temporary ID "${entry.id}" for entry "${entry.name}". Install uuid for stable IDs.`, entry.name);
                 } else {
                     this.log('warn', `Assigned new ID "${entry.id}" to server entry "${entry.name}".`, entry.name);
                 }
            }


            const servedRealPath = this.resolveServedPath(entry);

            if (!servedRealPath) {
                this.log('error', `Skipping server start for entry "${entry.name}" due to invalid serve folder.`, entry.name);
                 this.runningServers.set(entry.id, { server: null, entry, servedRealPath: null, status: 'error', errorMessage: 'Invalid serve folder' }); // エラー状態を記録
                continue;
            }

			const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
                 // *** Error 8 Correction ***
                 // Access req.socket.server which might not be typed correctly
                 const receivingServer = (req.socket as any).server;
                 // *** End Correction ***

                 const entryId = (receivingServer as any)?.__entryId; // オプショナルチェイニングを追加
                 const serverInfo = this.runningServers.get(entryId);

                 if (!serverInfo || serverInfo.status === 'error' || !serverInfo.servedRealPath || !serverInfo.server) {
                      res.statusCode = 503;
                      res.end('Service Unavailable: Server configuration missing or invalid.');
                      this.log('error', `Request received on server ID ${entryId || 'unknown'}, but configuration is missing or invalid.`, entryId || 'unknown', req.method, req.url);
                      return;
                 }

                 void this.handleRequest(req, res, serverInfo.entry, serverInfo.servedRealPath);
            };

			try {
				let server: http.Server | https.Server;
                let protocol = entry.enableHttps ? 'https' : 'http';

				if (entry.enableHttps) {
					if (!entry.sslCertPath || !entry.sslKeyPath) {
						this.log('error', `Cannot start HTTPS server for entry "${entry.name}": SSL certificate or key path is not set.`, entry.name);
                        this.runningServers.set(entry.id, { server: null, entry, servedRealPath, status: 'error', errorMessage: 'SSL paths not set' });
                        continue;
					}
					let options: https.ServerOptions;
					try {
	                    const certPath = path.resolve(entry.sslCertPath);
	                    const keyPath = path.resolve(entry.sslKeyPath);
						options = {
							key: fs.readFileSync(keyPath),
							cert: fs.readFileSync(certPath)
						};
                        this.log('info', `Using SSL cert: "${certPath}", key: "${keyPath}" for entry "${entry.name}".`, entry.name);
					} catch (err: any) {
						this.log('error', `Error reading SSL files for entry "${entry.name}": ${err.message}`, entry.name, err);
                        this.runningServers.set(entry.id, { server: null, entry, servedRealPath, status: 'error', errorMessage: `SSL file error: ${err.message}` });
						continue;
					}
					server = https.createServer(options, requestHandler);
				} else {
					server = http.createServer(requestHandler);
				}

                // サーバーインスタンスにエントリIDを紐づける
                (server as any).__entryId = entry.id;
				// エラー発生前に状態を登録する
				this.runningServers.set(entry.id, { server, entry, servedRealPath, status: 'stopped' });

				server.on('error', (err: NodeJS.ErrnoException) => {
                    let errorMessage = `Server error for "${entry.name}" (${entry.host}:${entry.port}): ${err.message} (Code: ${err.code})`;
					if (err.code === 'EADDRINUSE') {
						errorMessage = `Port ${entry.port} is already in use by another process. Server "${entry.name}" failed to start.`;
					} else if (err.code === 'EACCES') {
                        errorMessage = `Permission denied to bind to ${entry.host}:${entry.port} for server "${entry.name}". Try a port number > 1024 or check permissions.`;
                    }
                    this.log('error', errorMessage, entry.name, err);
                    const info = this.runningServers.get(entry.id);
                    if (info) {
                         // *** Error 4 Correction ***
                        info.status = 'error';
                         // *** End Correction ***
                        info.errorMessage = errorMessage;
                        info.server = null; // エラー時はサーバー参照をnullにする
                    }
                    this.updateStatusBarIcon();
                    new Notice(errorMessage, 8000); // 通知時間を少し長く
				});

				server.listen(entry.port, entry.host, () => {
					const url = `${protocol}://${entry.host}:${entry.port}`;
					this.log('info', `Server "${entry.name}" started at ${url}`, entry.name);
					this.log('info', `Serving folder: "${servedRealPath}"`, entry.name);

                    // サーバー起動成功情報をマップに記録
                    // *** Error 4 Correction ***
                    this.runningServers.set(entry.id, { server, entry, servedRealPath, status: 'running' });
                    // *** End Correction ***

					this.updateStatusBarIcon();
					new Notice(`Local Server "${entry.name}" started at ${url}`);
				});

			} catch (err: any) {
				this.log('error', `Failed to create server for entry "${entry.name}": ${err.message}`, entry.name, err);
                 // *** Error 4 Correction ***
                 this.runningServers.set(entry.id, { server: null, entry, servedRealPath, status: 'error', errorMessage: `Creation error: ${err.message}` });
                 // *** End Correction ***
				this.updateStatusBarIcon();
				new Notice(`Local Server "${entry.name}": サーバーの起動に失敗しました: ${err.message}`, 8000);
			}
		}

        this.updateStatusBarIcon();
	}

	stopAllServers() {
		this.log('info', 'Stopping all local servers...');
		const stopPromises: Promise<void>[] = [];

		this.runningServers.forEach((serverInfo, entryId) => {
             if (serverInfo.server) {
                 const stopPromise = new Promise<void>((resolve) => {
                     serverInfo.server!.close((err) => {
                         if (err) {
                             this.log('error', `Error stopping server "${serverInfo.entry.name}": ${err.message}`, serverInfo.entry.name);
                              // *** Error 4 Correction ***
                             serverInfo.status = 'error'; // 停止エラーも 'error' 状態として記録（起動エラーと区別するなら別の状態も検討）
                             // *** End Correction ***
                             serverInfo.errorMessage = `Stop error: ${err.message}`;
                         } else {
                             this.log('info', `Server "${serverInfo.entry.name}" stopped.`, serverInfo.entry.name);
                             // *** Error 4 Correction ***
                             serverInfo.status = 'stopped'; // 停止成功
                             // *** End Correction ***
                             delete serverInfo.errorMessage;
                         }
                         resolve();
                     });
                      // 強制停止のタイムアウト
                      setTimeout(() => {
                           // serverInfo.server がまだ存在し、かつ close イベントが来ていない場合
                           // (serverInfo.server as any)._connections は非公式なので、より安全には socket をリストして destroy する必要があるが、複雑になるためここでは省略
                           if (serverInfo.server && serverInfo.status !== 'stopped' && serverInfo.status !== 'error') {
                                this.log('warn', `Server "${serverInfo.entry.name}" close timed out. Forcing stop state.`, serverInfo.entry.name);
                                try {
                                    // 強制的に接続を閉じる試み（非公式・不安定な可能性あり）
                                    (serverInfo.server as any).closeIdleConnections();
                                    (serverInfo.server as any).closeAllConnections();
                                    serverInfo.server.close(); // 再度試す
                                } catch (forceCloseErr: any) {
                                     this.log('error', `Error during force close attempt for "${serverInfo.entry.name}": ${forceCloseErr.message}`, serverInfo.entry.name);
                                } finally {
                                     // *** Error 4 Correction ***
                                     serverInfo.status = 'stopped'; // 停止状態にする
                                     // *** End Correction ***
                                     delete serverInfo.errorMessage;
                                     serverInfo.server = null; // 参照をクリア
                                     resolve(); // resolve を呼んで promise を完了させる
                                }
                           } else {
                                // サーバーが既に停止状態、エラー状態、または server が null
                                resolve();
                           }
                      }, 3000); // 3秒待つ
                 });
                 stopPromises.push(stopPromise);
             } else {
                  // serverインスタンスがnullの場合 (起動エラーなどで既に停止している)
                   // *** Error 4 Correction ***
                   serverInfo.status = serverInfo.status === 'error' ? 'error' : 'stopped'; // 起動エラーならそのままエラー、そうでなければ停止済み扱い
                   // *** End Correction ***
             }
		});

		return Promise.all(stopPromises).then(() => {
             this.runningServers.clear(); // すべて停止したらマップをクリア
			 this.log('info', 'All local servers stopped.');
             this.updateStatusBarIcon();
		});
	}


	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, entry: ServerEntrySettings, servedRealPath: string) {
		const startTime = Date.now();
		let statusCode = 200;

		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');

        // CORS ヘッダー (必要であれば、エントリ設定に追加するなどして制御可能にする)
        // res.setHeader('Access-Control-Allow-Origin', '*');

		try {
			if (!req.url || !req.method) {
				statusCode = 400;
				this.sendResponse(res, statusCode, 'Bad Request', startTime, entry.name, req.method, req.url);
				return;
			}
			const method = req.method.toUpperCase();
			if (method !== 'GET' && method !== 'HEAD') {
				statusCode = 405;
				res.setHeader('Allow', 'GET, HEAD');
				this.sendResponse(res, statusCode, 'Method Not Allowed', startTime, entry.name, req.method, req.url);
				return;
			}
            const hostHeader = req.headers['host'] || `${entry.host}:${entry.port}`;
			const protocol = entry.enableHttps ? 'https' : 'http';
			const baseUrl = `${protocol}://${hostHeader}`;

			let pathname: string;
			let searchParams: URLSearchParams;
			try {
				const parsedUrl = new URL(req.url, baseUrl);
				pathname = decodeURIComponent(parsedUrl.pathname);
				searchParams = parsedUrl.searchParams;
			} catch (e) {
				statusCode = 400;
				this.sendResponse(res, statusCode, 'Bad Request: Invalid URL encoding.', startTime, entry.name, req.method, req.url);
				return;
			}

			if (pathname === MARKDOWN_PREVIEW_ENDPOINT) {
				// 一時トークン経由で Vault 内の Markdown をプレビューする専用エンドポイント。
				const previewToken = searchParams?.get('token') ?? '';
				let previewPath: string | null = null;
				if (!previewToken && entry.allowLocalhostNoToken && this.isLocalhostRequest(req)) {
					const requestProtocol = entry.enableHttps ? 'https' : 'http';
					const baseUrl = `${requestProtocol}://${entry.host}:${entry.port}`;
					const urlPath = new URL(req.url ?? '/', baseUrl).pathname;
					const vaultBasePath = this.getVaultBasePath();
					if (!vaultBasePath) {
						statusCode = 503;
						this.sendResponse(res, statusCode, 'Service Unavailable', startTime, entry.name, req.method, req.url);
						return;
					}
					const normalizedPath = urlPath.replace(/^\/+/, '');
					const absolutePath = path.join(vaultBasePath, normalizedPath);
					let resolvedPath: string;
					try {
						resolvedPath = fs.realpathSync(absolutePath);
					} catch {
						statusCode = 404;
						this.sendResponse(res, statusCode, 'Not Found', startTime, entry.name, req.method, req.url);
						return;
					}
					if (!this.isPathInside(vaultBasePath, resolvedPath)) {
						statusCode = 403;
						this.sendResponse(res, statusCode, 'Forbidden: File is outside vault.', startTime, entry.name, req.method, req.url);
						return;
					}
					previewPath = resolvedPath;
				} else {
					previewPath = this.resolvePreviewToken(previewToken);
				}
				if (!previewPath) {
					statusCode = 403;
					this.sendResponse(res, statusCode, 'Forbidden: Invalid or expired preview token.', startTime, entry.name, req.method, req.url);
					return;
				}
				const vaultBasePath = this.getVaultBasePath();
				if (!vaultBasePath || !this.isPathInside(vaultBasePath, previewPath)) {
					statusCode = 403;
					this.sendResponse(res, statusCode, 'Forbidden: File is outside vault.', startTime, entry.name, req.method, req.url);
					return;
				}
				try {
					const stats = await fs.promises.stat(previewPath);
					if (!stats.isFile()) {
						statusCode = 404;
						this.sendResponse(res, statusCode, 'Not Found', startTime, entry.name, req.method, req.url);
						return;
					}
				} catch {
					statusCode = 404;
					this.sendResponse(res, statusCode, 'Not Found', startTime, entry.name, req.method, req.url);
					return;
				}
				if (!this.isMarkdownFile(previewPath)) {
					statusCode = 403;
					this.sendResponse(res, statusCode, 'Forbidden: Not a markdown file.', startTime, entry.name, req.method, req.url);
					return;
				}
				void this.serveMarkdownPreview(res, previewPath, entry, startTime, req.method, req.url, previewToken);
				return;
			}

			if (pathname === MARKDOWN_PREVIEW_ASSET_ENDPOINT) {
				// プレビュー HTML 内で参照される画像ファイルを安全に返す。
				const previewToken = searchParams?.get('token') ?? '';
				let previewPath: string | null = null;
				if (!previewToken && entry.allowLocalhostNoToken && this.isLocalhostRequest(req)) {
					const assetPathRaw = searchParams?.get('path') ?? '';
					let assetVaultPath: string;
					try {
						assetVaultPath = decodeURIComponent(assetPathRaw);
					} catch {
						statusCode = 400;
						this.sendResponse(res, statusCode, 'Bad Request: Invalid asset path.', startTime, entry.name, req.method, req.url);
						return;
					}
					const vaultBasePath = this.getVaultBasePath();
					if (!vaultBasePath) {
						statusCode = 503;
						this.sendResponse(res, statusCode, 'Service Unavailable', startTime, entry.name, req.method, req.url);
						return;
					}
					const normalizedVaultPath = assetVaultPath.replace(/^\/+/, '');
					const absoluteAssetPath = path.join(vaultBasePath, normalizedVaultPath);
					let resolvedAssetPath: string;
					try {
						resolvedAssetPath = fs.realpathSync(absoluteAssetPath);
					} catch {
						statusCode = 404;
						this.sendResponse(res, statusCode, 'Not Found', startTime, entry.name, req.method, req.url);
						return;
					}
					if (!this.isPathInside(vaultBasePath, resolvedAssetPath)) {
						statusCode = 403;
						this.sendResponse(res, statusCode, 'Forbidden', startTime, entry.name, req.method, req.url);
						return;
					}
					previewPath = resolvedAssetPath;
				} else {
					previewPath = this.resolvePreviewToken(previewToken);
				}
				if (!previewPath) {
					statusCode = 403;
					this.sendResponse(res, statusCode, 'Forbidden: Invalid or expired preview token.', startTime, entry.name, req.method, req.url);
					return;
				}
				const assetPathRaw = searchParams?.get('path') ?? '';
				let assetVaultPath: string;
				try {
					assetVaultPath = decodeURIComponent(assetPathRaw);
				} catch {
					statusCode = 400;
					this.sendResponse(res, statusCode, 'Bad Request: Invalid asset path.', startTime, entry.name, req.method, req.url);
					return;
				}
				const vaultBasePath = this.getVaultBasePath();
				if (!vaultBasePath) {
					statusCode = 503;
					this.sendResponse(res, statusCode, 'Service Unavailable', startTime, entry.name, req.method, req.url);
					return;
				}
				const normalizedVaultPath = assetVaultPath.replace(/^\/+/, '');
				const absoluteAssetPath = path.join(vaultBasePath, normalizedVaultPath);
				let resolvedAssetPath: string;
				try {
					resolvedAssetPath = fs.realpathSync(absoluteAssetPath);
				} catch {
					statusCode = 404;
					this.sendResponse(res, statusCode, 'Not Found', startTime, entry.name, req.method, req.url);
					return;
				}
				if (!this.isPathInside(vaultBasePath, resolvedAssetPath)) {
					statusCode = 403;
					this.sendResponse(res, statusCode, 'Forbidden', startTime, entry.name, req.method, req.url);
					return;
				}
				if (!this.isImageFile(resolvedAssetPath) && !this.isPdfFile(resolvedAssetPath)) {
					statusCode = 403;
					this.sendResponse(res, statusCode, 'Forbidden: Not an image or PDF.', startTime, entry.name, req.method, req.url);
					return;
				}
				let stats: fs.Stats;
				try {
					stats = fs.statSync(resolvedAssetPath);
				} catch {
					statusCode = 404;
					this.sendResponse(res, statusCode, 'Not Found', startTime, entry.name, req.method, req.url);
					return;
				}
				this.serveFile(res, resolvedAssetPath, stats, entry.name, startTime, req.method, req.url);
				return;
			}

			if (entry.authToken) {
				const authHeader = req.headers['authorization'];
				if (!authHeader || !authHeader.startsWith('Bearer ')) {
					statusCode = 401;
                    res.setHeader('WWW-Authenticate', 'Bearer realm="LocalServer"');
					this.sendResponse(res, statusCode, 'Unauthorized: Missing authentication token.', startTime, entry.name, req.method, req.url);
					return;
				}
                const token = authHeader.substring(7);
                if (token !== entry.authToken) {
                    statusCode = 403;
                    this.sendResponse(res, statusCode, 'Forbidden: Invalid authentication token.', startTime, entry.name, req.method, req.url);
                    return;
                }
			}

            if (!servedRealPath) {
                statusCode = 503;
                this.sendResponse(res, statusCode, 'Service Unavailable: Server configuration error.', startTime, entry.name, req.method, req.url);
                this.log('error', `Internal error: servedRealPath is null for running server entry "${entry.name}".`, entry.name, req.method, req.url);
                return;
            }
			const vaultBasePath = this.getVaultBasePath();
			const enforceVaultFiles = Boolean(
				vaultBasePath && this.isPathInside(vaultBasePath, servedRealPath)
			);

            const safePathname = path.posix.normalize('/' + pathname).replace(/^(\.\.[\/\\])+/, '');
            const cleanPathname = safePathname.replace(/\0/g, '');
			if (cleanPathname === '/__index.json') {
				void this.handleIndexRequest(
					res,
					entry,
					servedRealPath,
					searchParams,
					startTime,
					req.method,
					req.url,
					req.headers['if-none-match']
				);
				return;
			}
			const requestedPath = path.join(servedRealPath, cleanPathname);

			fs.realpath(requestedPath, (err, resolvedPath) => {
				if (err) {
					statusCode = 404;
					this.sendResponse(res, statusCode, 'Not Found', startTime, entry.name, req.method, req.url, cleanPathname);
					return;
				}

				if (!resolvedPath.startsWith(servedRealPath + path.sep) && resolvedPath !== servedRealPath) {
					statusCode = 403;
                    this.log('warn', `Forbidden access attempt: ${cleanPathname} resolved to ${resolvedPath}, which is outside of "${servedRealPath}" for entry "${entry.name}".`, entry.name);
					this.sendResponse(res, statusCode, 'Forbidden', startTime, entry.name, req.method, req.url, cleanPathname);
					return;
				}

				fs.stat(resolvedPath, (statErr, stats) => {
					if (statErr) {
						statusCode = (statErr.code === 'ENOENT' ? 404 : 500);
                        this.log('error', `Error stating file ${resolvedPath} for entry "${entry.name}": ${statErr.message}`, entry.name, statErr);
						this.sendResponse(res, statusCode, statusCode === 404 ? 'Not Found' : 'Internal Server Error', startTime, entry.name, req.method, req.url, cleanPathname);
						return;
					}

					if (entry.enableWhitelist) {
						const relativePath = path.relative(servedRealPath, resolvedPath);
						if (stats.isDirectory()) {
							const hasAny = entry.whitelistFiles.length > 0;
							const hasMatch = entry.whitelistFiles.some((file) =>
								file === relativePath || file.startsWith(relativePath + path.sep)
							);
							if (!(hasMatch || (relativePath === '' && hasAny))) {
								statusCode = 403;
								this.sendResponse(res, statusCode, 'Forbidden: Directory not whitelisted.', startTime, entry.name, req.method, req.url, cleanPathname);
								return;
							}
						} else if (stats.isFile()) {
							if (!entry.whitelistFiles.includes(relativePath)) {
								statusCode = 403;
								this.sendResponse(res, statusCode, 'Forbidden: File not whitelisted.', startTime, entry.name, req.method, req.url, cleanPathname);
								return;
							}
						}
					}

					if (stats.isDirectory()) {
                        if (!cleanPathname.endsWith('/')) {
                            statusCode = 301;
                            const redirectPath = cleanPathname.split('/').map(encodeURIComponent).join('/') + '/';
                            res.setHeader('Location', redirectPath);
                            this.sendResponse(res, statusCode, 'Redirecting to directory.', startTime, entry.name, req.method, req.url);
                            return;
                        }
                        this.serveDirectoryListing(res, resolvedPath, cleanPathname, entry.name, startTime, entry.enableWhitelist, entry.whitelistFiles, servedRealPath, req.method, req.url);
					} else if (stats.isFile()) {
						// preview=1 のときだけ Markdown を簡易HTMLで返す。
						const previewRequested = searchParams?.get(MARKDOWN_PREVIEW_QUERY_KEY) === '1';
						if (previewRequested && this.isMarkdownFile(resolvedPath)) {
							void this.serveMarkdownPreview(res, resolvedPath, entry, startTime, req.method, req.url);
							return;
						}
						if (enforceVaultFiles && vaultBasePath && !this.isVaultFileResolvedPath(vaultBasePath, resolvedPath)) {
							statusCode = 404;
							this.sendResponse(res, statusCode, 'Not Found', startTime, entry.name, req.method, req.url, cleanPathname);
							return;
						}
						this.serveFile(
							res,
							resolvedPath,
							stats,
							entry.name,
							startTime,
							req.method,
							req.url,
							req.headers['if-none-match'],
							req.headers['if-modified-since']
						);
					} else {
						statusCode = 403;
						this.sendResponse(res, statusCode, 'Forbidden: Not a file or directory.', startTime, entry.name, req.method, req.url, cleanPathname);
					}
				});
			});

		} catch (error: any) {
			statusCode = 500;
			this.log('error', `Internal Server Error processing ${req.method} ${req.url} for entry "${entry.name}": ${error.message}\n${error.stack}`, entry.name, error);
			if (!res.writableEnded) {
				try {
                    res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Internal Server Error');
                } catch (writeError: any) {
                    this.log('error', `Error sending 500 response for "${entry.name}": ${writeError.message}`, entry.name, writeError);
                }
			}
			this.logRequest(startTime, statusCode, entry.name, req.method, req.url);
		}
	}

	private async handleIndexRequest(
		res: http.ServerResponse,
		entry: ServerEntrySettings,
		servedRealPath: string,
		searchParams: URLSearchParams,
		startTime: number,
		method?: string,
		url?: string,
		ifNoneMatch?: string | string[]
	): Promise<void> {
		const extensions = this.parseIndexExtensions(searchParams.get('ext'));
		const recursive = searchParams.get('recursive') !== '0';
		const rawPath = searchParams.get('path') ?? '';
		const relativePath = this.normalizeIndexPath(rawPath);

		const resolvedDir = await this.resolveIndexDirectory(servedRealPath, relativePath);
		if (!resolvedDir) {
			this.sendResponse(res, 404, 'Not Found', startTime, entry.name, method, url, relativePath);
			return;
		}
		const vaultBasePath = this.getVaultBasePath();
		const enforceVaultFiles = Boolean(
			vaultBasePath && this.isPathInside(vaultBasePath, servedRealPath)
		);

		const whitelistSet = entry.enableWhitelist
			? this.normalizeWhitelist(entry.whitelistFiles)
			: null;

		const cacheKey = this.buildIndexCacheKey(entry, relativePath, extensions, recursive);
		const cached = this.indexCache.get(cacheKey);
		const now = Date.now();
		const etagHeader = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch ?? '';

		if (cached && now - cached.createdAt <= INDEX_CACHE_TTL_MS) {
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
			res.setHeader('Cache-Control', `private, max-age=${Math.floor(INDEX_CACHE_TTL_MS / 1000)}`);
			res.setHeader('ETag', cached.etag);

			if (etagHeader && etagHeader.includes(cached.etag)) {
				res.statusCode = 304;
				res.end();
				this.logRequest(startTime, 304, entry.name, method, url, relativePath);
				return;
			}

			res.statusCode = 200;
			if (method !== 'HEAD') {
				res.end(cached.payload);
			} else {
				res.end();
			}
			this.logRequest(startTime, 200, entry.name, method, url, relativePath);
			return;
		}

		const itemsResult = await this.collectIndexItems(
			resolvedDir,
			servedRealPath,
			extensions,
			recursive,
			whitelistSet,
			vaultBasePath,
			enforceVaultFiles
		);

		if (itemsResult.errorMessage) {
			this.sendResponse(res, 500, itemsResult.errorMessage, startTime, entry.name, method, url, relativePath);
			return;
		}

		const payload = JSON.stringify({
			basePath: relativePath,
			items: itemsResult.items,
			generatedAt: new Date().toISOString(),
		});

		const etag = itemsResult.etag;
		this.indexCache.set(cacheKey, { etag, createdAt: now, payload });

		res.setHeader('Content-Type', 'application/json; charset=utf-8');
		res.setHeader('Cache-Control', `private, max-age=${Math.floor(INDEX_CACHE_TTL_MS / 1000)}`);
		res.setHeader('ETag', etag);
		res.statusCode = 200;
		if (method !== 'HEAD') {
			res.end(payload);
		} else {
			res.end();
		}
		this.logRequest(startTime, 200, entry.name, method, url, relativePath);
	}

	private parseIndexExtensions(value: string | null): Set<string> {
		if (!value) {
			return new Set(DEFAULT_INDEX_EXTENSIONS);
		}
		const items = value
			.split(',')
			.map((item) => item.trim().toLowerCase().replace(/^\./, ''))
			.filter((item) => item.length > 0);
		if (items.length === 0) {
			return new Set(DEFAULT_INDEX_EXTENSIONS);
		}
		return new Set(items);
	}

	private normalizeIndexPath(value: string): string {
		const normalized = path.posix.normalize(`/${value}`).replace(/^\/+/, '');
		if (normalized === '.' || normalized === '/') {
			return '';
		}
		return normalized;
	}

	private async resolveIndexDirectory(servedRealPath: string, relativePath: string): Promise<string | null> {
		try {
			const targetPath = path.join(servedRealPath, relativePath);
			const resolved = await fs.promises.realpath(targetPath);
			if (!this.isPathInside(servedRealPath, resolved)) {
				return null;
			}
			const stats = await fs.promises.stat(resolved);
			if (!stats.isDirectory()) {
				return null;
			}
			return resolved;
		} catch {
			return null;
		}
	}

	private normalizeWhitelist(values: string[]): Set<string> {
		return new Set(values.map((value) => value.split(path.sep).join(path.posix.sep)));
	}

	private buildIndexCacheKey(
		entry: ServerEntrySettings,
		relativePath: string,
		extensions: Set<string>,
		recursive: boolean
	): string {
		const extensionKey = Array.from(extensions).sort().join(',');
		const whitelistKey = entry.enableWhitelist
			? crypto.createHash('sha1').update(entry.whitelistFiles.join('|')).digest('hex')
			: 'all';
		return `${entry.id}|${relativePath}|${recursive ? 'r' : 'n'}|${extensionKey}|${whitelistKey}`;
	}

	private async collectIndexItems(
		dirPath: string,
		servedRealPath: string,
		extensions: Set<string>,
		recursive: boolean,
		whitelistSet: Set<string> | null,
		vaultBasePath: string | null,
		enforceVaultFiles: boolean
	): Promise<{ items: IndexItem[]; etag: string; errorMessage: string }> {
		const items: IndexItem[] = [];
		const hash = crypto.createHash('sha1');
		const stack = [dirPath];

		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) {
				continue;
			}

			let dirents: fs.Dirent[];
			try {
				dirents = await fs.promises.readdir(current, { withFileTypes: true });
			} catch (err: any) {
				return { items: [], etag: '', errorMessage: `Failed to read directory: ${err?.message ?? err}` };
			}

			for (const dirent of dirents) {
				const fullPath = path.join(current, dirent.name);
				if (dirent.isDirectory()) {
					if (recursive) {
						stack.push(fullPath);
					}
					continue;
				}
				if (!dirent.isFile()) {
					continue;
				}

				const ext = path.extname(dirent.name).toLowerCase().replace('.', '');
				if (!extensions.has(ext)) {
					continue;
				}

				let stats: fs.Stats;
				try {
					stats = await fs.promises.stat(fullPath);
				} catch {
					continue;
				}

				const relativeOs = path.relative(servedRealPath, fullPath);
				const relativePath = relativeOs.split(path.sep).join(path.posix.sep);
				if (whitelistSet && !whitelistSet.has(relativePath)) {
					continue;
				}
				if (enforceVaultFiles && vaultBasePath && !this.isVaultFile(vaultBasePath, fullPath)) {
					continue;
				}

				items.push({
					relativePath,
					name: dirent.name,
					size: stats.size,
					mtime: stats.mtimeMs,
				});

				hash.update(relativePath);
				hash.update(String(stats.size));
				hash.update(String(stats.mtimeMs));
			}
		}

		items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
		return { items, etag: hash.digest('hex'), errorMessage: '' };
	}

	private sendResponse(
        res: http.ServerResponse,
        statusCode: number,
        message: string,
        startTime: number,
        entryName: string,
        method?: string,
        url?: string,
        filePath?: string
    ) {
		try {
            if (!res.writableEnded) {
                if (!res.headersSent) {
                    res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
                }
                res.end(message);
            }
        } catch (error: any) {
             this.log('error', `Error sending response (Status ${statusCode}) for "${entryName}": ${error.message}`, entryName);
        } finally {
            this.logRequest(startTime, statusCode, entryName, method, url, filePath);
        }
	}

	private buildWhitelistDirectorySet(whitelistFiles: string[]): Set<string> {
		// 1回のディレクトリ表示で O(n*m) を避けるため、親ディレクトリ集合を作る
		const directories = new Set<string>();

		for (const filePath of whitelistFiles) {
			const parts = filePath.split(path.sep).filter(Boolean);
			if (parts.length <= 1) {
				continue;
			}

			for (let i = 1; i < parts.length; i++) {
				const dirPath = parts.slice(0, i).join(path.sep);
				directories.add(dirPath);
			}
		}

		return directories;
	}

    private serveDirectoryListing(
        res: http.ServerResponse,
        dirPath: string,
        pathname: string,
        entryName: string,
        startTime: number,
        enableWhitelist: boolean,
        whitelistFiles: string[],
        servedRealPath: string,
        method?: string,
        url?: string
    ) {
		const whitelistSet = enableWhitelist ? new Set(whitelistFiles) : null;
		const whitelistDirSet = enableWhitelist ? this.buildWhitelistDirectorySet(whitelistFiles) : null;

		fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
			if (err) {
				this.sendResponse(res, 500, 'Internal Server Error: Could not read directory', startTime, entryName, method, url, pathname);
				return;
			}

			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            const escapeHtml = (unsafe: string): string => {
                return unsafe
                                     .replace(/&/g, "&amp;")
                                     .replace(/</g, "&lt;")
                                     .replace(/>/g, "&gt;")
                                     .replace(/"/g, "&quot;")
                                     .replace(/'/g, "&#39;");
            }
			const escapedPathname = escapeHtml(pathname);

			res.write(`<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Index of ${escapedPathname}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 1em; color: var(--text-normal); background-color: var(--background-primary); }
        h1 { border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 0.5em; margin-bottom: 1em; }
        ul { list-style: none; padding-left: 0; }
        li { margin-bottom: 0.5em; display: flex; align-items: center; }
        a { text-decoration: none; color: var(--text-accent); word-break: break-all; }
        a:hover { text-decoration: underline; color: var(--text-accent-hover); }
        .icon { display: inline-block; width: 1.5em; text-align: center; margin-right: 0.5em; }
        .dir::before { content: '📁'; }
        .file::before { content: '📄'; }
        .parent::before { content: '⬆️'; }
    </style>
</head>
<body>
    <h1>Index of ${escapedPathname}</h1>
    <ul>`);

            const isRoot = pathname === '/';
			if (!isRoot) {
                const parentPath = path.posix.dirname(pathname.endsWith('/') ? pathname.slice(0, -1) : pathname);
                if (parentPath !== pathname) {
                    const parentHref = (parentPath === '/' ? '/' : parentPath.split('/').map(encodeURIComponent).join('/') + '/');
                    res.write(`<li><span class="icon parent"></span><a href="${parentHref}">..</a></li>`);
                }
			}

			files.sort((a, b) => {
                // *** Error 9-12: Assuming the syntax below is correct. No changes made here.
                // If error persists, check surrounding code or simplify sort.
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                // *** End of Error 9-12 consideration ***
            }).forEach(file => {
				const isDir = file.isDirectory();
                const entryNameHtml = escapeHtml(file.name); // Use escaped name for HTML display
                let iconClass = isDir ? 'dir' : 'file';

                let allow = true;
                 if (enableWhitelist && whitelistSet && whitelistDirSet) {
                    const currentEntryPath = path.join(dirPath, file.name);
                    const relativePath = path.relative(servedRealPath, currentEntryPath);

                    if (isDir) {
                         allow = whitelistSet.has(relativePath) || whitelistDirSet.has(relativePath);
                    } else {
                         allow = whitelistSet.has(relativePath);
                    }
                 }

                 if (allow) {
                    const encodedName = encodeURIComponent(file.name);
                    const href = path.posix.join(pathname, encodedName) + (isDir ? '/' : '');
                    res.write(`<li><span class="icon ${iconClass}"></span><a href="${href}">${entryNameHtml}${isDir ? '/' : ''}</a></li>`);
                 }
			});

			res.write(`</ul>
</body>
</html>`);
			res.end();
            this.logRequest(startTime, 200, entryName, method, url, pathname);
		});
	}

	private serveFile(
        res: http.ServerResponse,
        filePath: string,
        stats: fs.Stats,
        entryName: string,
        startTime: number,
        method?: string,
        url?: string,
		ifNoneMatch?: string | string[],
		ifModifiedSince?: string | string[]
    ) {
		const contentType = this.getContentType(filePath);
		const etag = this.buildFileEtag(stats);
		const lastModified = stats.mtime.toUTCString();
		const requestMethod = (method ?? 'GET').toUpperCase();
		const ifNoneMatchHeader = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch ?? '';
		const ifModifiedSinceHeader = Array.isArray(ifModifiedSince) ? ifModifiedSince[0] : ifModifiedSince;

		// 条件付きリクエストは I/O を避けて 304 を返す
		if (ifNoneMatchHeader && ifNoneMatchHeader.includes(etag)) {
			res.writeHead(304, { 'ETag': etag, 'Last-Modified': lastModified });
			res.end();
			this.logRequest(startTime, 304, entryName, method, url, filePath);
			return;
		}

		if (ifModifiedSinceHeader) {
			const since = Date.parse(ifModifiedSinceHeader);
			if (!Number.isNaN(since) && stats.mtimeMs <= since) {
				res.writeHead(304, { 'ETag': etag, 'Last-Modified': lastModified });
				res.end();
				this.logRequest(startTime, 304, entryName, method, url, filePath);
				return;
			}
		}

		if (requestMethod === 'HEAD') {
			res.writeHead(200, {
				'Content-Type': contentType,
				'Content-Length': stats.size,
				'Last-Modified': lastModified,
				'ETag': etag,
			});
			res.end();
			this.logRequest(startTime, 200, entryName, method, url, filePath);
			return;
		}

		const stream = fs.createReadStream(filePath);
		let statusCode = 200;

		stream.on('open', () => {
			res.writeHead(statusCode, {
				'Content-Type': contentType,
				'Content-Length': stats.size,
                'Last-Modified': lastModified,
				'ETag': etag
			});
			stream.pipe(res);
            stream.on('end', () => {
                this.logRequest(startTime, statusCode, entryName, method, url, filePath);
            });
		});

		stream.on('error', (error) => {
			statusCode = 500;
			this.log('error', `Error streaming file ${filePath} for "${entryName}": ${error.message}`, entryName);
            this.sendResponse(res, statusCode, 'Internal Server Error', startTime, entryName, method, url, filePath);
		});

        res.on('error', (error) => {
            this.log('warn', `Response error for "${entryName}" (${filePath}): ${error.message}. Client may have disconnected.`, entryName);
            stream.destroy();
            this.logRequest(startTime, res.statusCode || 500, entryName, method, url, filePath);
        });

        res.on('close', () => {
             if (!res.writableEnded) {
                 this.log('warn', `Connection closed prematurely for "${entryName}" (${filePath})`, entryName);
                 stream.destroy();
                 this.logRequest(startTime, res.statusCode || 499, entryName, method, url, filePath);
             }
        });
	}

	private logRequest(startTime: number, statusCode: number, entryName: string, method?: string, url?: string, filePath?: string) {
		const duration = Date.now() - startTime;
		const message = `${method || '?'} ${url || '?'} - ${statusCode} (${duration}ms)${filePath ? ` [${path.basename(filePath)}]` : ''}`;
		if (statusCode >= 500) {
			this.log('error', message, entryName);
		} else if (statusCode >= 400) {
            this.log('warn', message, entryName);
        } else {
			this.log('info', message, entryName);
		}
	}

	private getContentType(filePath: string): string {
		const ext = path.extname(filePath).toLowerCase();
		switch (ext) {
			case '.html': case '.htm': return 'text/html; charset=utf-8';
			case '.css': return 'text/css; charset=utf-8';
			case '.js': case '.mjs': return 'application/javascript; charset=utf-8';
			case '.json': return 'application/json; charset=utf-8';
			case '.xml': return 'application/xml; charset=utf-8';
			case '.txt': case '.md': case '.log': return 'text/plain; charset=utf-8';
            case '.csv': return 'text/csv; charset=utf-8';
			case '.png': return 'image/png';
			case '.jpg': case '.jpeg': return 'image/jpeg';
			case '.gif': return 'image/gif';
			case '.svg': return 'image/svg+xml';
			case '.webp': return 'image/webp';
			case '.ico': return 'image/vnd.microsoft.icon';
            case '.avif': return 'image/avif';
            case '.bmp': return 'image/bmp';
            case '.tif': case '.tiff': return 'image/tiff';
			case '.woff': return 'font/woff';
			case '.woff2': return 'font/woff2';
			case '.ttf': return 'font/ttf';
			case '.otf': return 'font/otf';
            case '.eot': return 'application/vnd.ms-fontobject';
			case '.mp4': return 'video/mp4';
			case '.webm': return 'video/webm';
            case '.ogv': return 'video/ogg';
			case '.mp3': return 'audio/mpeg';
			case '.ogg': case '.oga': return 'audio/ogg';
			case '.wav': return 'audio/wav';
            case '.weba': return 'audio/webm';
            case '.aac': return 'audio/aac';
            case '.midi': case '.mid': return 'audio/midi';
			case '.pdf': return 'application/pdf';
			case '.zip': return 'application/zip';
            case '.gz': return 'application/gzip';
            case '.tar': return 'application/x-tar';
            case '.rar': return 'application/vnd.rar';
            case '.7z': return 'application/x-7z-compressed';
            case '.doc': return 'application/msword';
            case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            case '.xls': return 'application/vnd.ms-excel';
            case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            case '.ppt': return 'application/vnd.ms-powerpoint';
            case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
            case '.epub': return 'application/epub+zip';
            case '.wasm': return 'application/wasm';
			default: return 'application/octet-stream';
		}
	}

	private buildFileEtag(stats: fs.Stats): string {
		// ファイル更新の検出に十分な軽量 ETag
		return `W/"${stats.size}-${stats.mtimeMs}"`;
	}

	private async serveMarkdownPreview(
		res: http.ServerResponse,
		filePath: string,
		entry: ServerEntrySettings,
		startTime: number,
		method?: string,
		url?: string,
		previewToken?: string
	): Promise<void> {
		try {
			const vaultBasePath = this.getVaultBasePath();
			const vaultRelative = vaultBasePath ? this.getVaultRelativePath(vaultBasePath, filePath) : null;
			const sourcePath = vaultRelative ?? filePath;
			const markdown = await fs.promises.readFile(filePath, 'utf8');
			const token = previewToken ?? this.issuePreviewToken(filePath);
			const prepared = this.prepareMarkdownForPreview(markdown, sourcePath);
			const html = await this.buildMarkdownPreviewHtml(prepared.markdown, sourcePath, entry, token, prepared.mathPlaceholders);
			const requestMethod = (method ?? 'GET').toUpperCase();

			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.setHeader('Cache-Control', 'no-store');
			res.statusCode = 200;

			if (requestMethod !== 'HEAD') {
				res.end(html);
			} else {
				res.end();
			}
			this.logRequest(startTime, 200, entry.name, method, url, filePath);
		} catch (error: any) {
			this.log('error', `Markdown preview error for "${filePath}": ${error?.message ?? error}`, entry.name);
			this.sendResponse(res, 500, 'Internal Server Error', startTime, entry.name, method, url, filePath);
		}
	}

	private async buildMarkdownPreviewHtml(
		markdown: string,
		sourcePath: string,
		entry: ServerEntrySettings,
		token: string | null,
		mathPlaceholders: Map<string, { mode: 'inline' | 'block'; content: string }>
	): Promise<string> {
		const container = document.createElement('div');
		const tempComponent = new Component();
		await MarkdownRenderer.render(this.app, markdown, container, sourcePath, tempComponent);
		this.rewriteMarkdownPreviewAssets(container, sourcePath, entry, token);
		this.rewriteMarkdownPreviewLinks(container, sourcePath, entry);
		this.restoreMathPlaceholders(container, mathPlaceholders);
		const renderedHtml = container.innerHTML;
		// 一時コンポーネントを破棄してプレビュー用の子コンポーネントを回収する。
		tempComponent.unload();

		const escapeHtml = (value: string): string =>
			value
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');

		const title = escapeHtml(path.basename(sourcePath));

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${title}</title>
	<style>
		:root {
			--font-serif: "Noto Serif CJK JP", "Noto Serif JP", "Noto Serif", "Source Serif 4", "Times New Roman", serif;
			--font-sans: "Noto Sans CJK JP", "Noto Sans JP", "Noto Sans", "Helvetica Neue", "Segoe UI", sans-serif;
			--font-mono: "Ricty Diminished", "Ricty", "Menlo", "SFMono-Regular", "Consolas", "Liberation Mono", monospace;
			--font-math: "XITS Math", "STIX Two Math", "Cambria Math", "Latin Modern Math", serif;
			--page-max-width: 900px;
			--page-single-width: 900px;
			--page-padding-x: 40px; /* 余白を広げて論文らしく */
			--content-font-size: 16px;
			--page-bg: #ffffff; /* 純白の背景 */
			--page-text: #222222;
			--surface: #f8f8f8;
			--surface-muted: #eeeeee;
			--border: #dddddd;
			--border-strong: #cccccc;
			--shadow: 0 2px 4px rgba(0,0,0,0.05);
			--menu-shadow: 0 12px 30px rgba(0, 0, 0, 0.1);
			--text-muted: #666666;
			--text-subtle: #888888;
			--link: #0056b3;
			--code-bg: #f5f5f5;
			--code-border: #e0e0e0;
			--inline-code-bg: rgba(0,0,0,0.04);
			--blockquote-border: #cccccc;
			--blockquote-text: #555555;
			--table-border: #dddddd;
			--table-header-bg: #f9f9f9;
			--accent-border: #bfc7f1;
			--accent-text: #1d2f7a;
			--accent-bg: #eef1ff;
			--focus-ring: rgba(191, 199, 241, 0.35);
			--success-border: #9ad1b3;
			--success-text: #1f7a4f;
			--success-bg: #f0faf4;
			--pagebook-gap: 0px;
			--pagebook-page-height: 100vh;
			--pagebook-page-width: 100%;
			--pagebook-columns: 1;
		}
		:root[data-theme="dark"] {
			--page-bg: #0f1112;
			--page-text: #e7e6e3;
			--surface: #16181b;
			--surface-muted: #202326;
			--border: #2a2f33;
			--border-strong: #2f3439;
			--shadow: 0 1px 2px rgba(0,0,0,0.4);
			--menu-shadow: 0 12px 30px rgba(0,0,0,0.6);
			--text-muted: #a0a0a0;
			--text-subtle: #8b9096;
			--link: #8ab4ff;
			--code-bg: #1c1f22;
			--code-border: #2b3136;
			--inline-code-bg: rgba(255,255,255,0.08);
			--blockquote-border: #3a4147;
			--blockquote-text: #c5c8cc;
			--table-border: #2f3439;
			--table-header-bg: #1e2226;
			--accent-border: #3f4a8a;
			--accent-text: #d0d7ff;
			--accent-bg: #1b2146;
			--focus-ring: rgba(111, 123, 214, 0.45);
			--success-border: #2f7d5e;
			--success-text: #9de2c0;
			--success-bg: #123025;
		}
		body { margin: 0; font-family: var(--font-serif); background: var(--page-bg); color: var(--page-text); }
		body.is-paged { overflow: hidden; }
		.page { max-width: var(--page-max-width); margin: 0 auto; padding: 36px var(--page-padding-x) 64px; transition: max-width 0.2s ease; }
		.page.is-paged { padding-top: 0; padding-bottom: 8px; }
		.page.is-full { max-width: 100%; }
		.header { margin-bottom: 20px; }
		.header.is-paged { margin-bottom: 12px; }
		.header-hover-zone {
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			height: 16px;
			z-index: 14;
			display: none;
		}
		body.is-paged .header-hover-zone { display: block; }
		body.is-paged .header {
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			margin: 0;
			padding: 12px var(--page-padding-x) 10px;
			background: var(--page-bg);
			box-shadow: var(--shadow);
			transform: translateY(-110%);
			opacity: 0;
			pointer-events: none;
			transition: transform 0.2s ease, opacity 0.2s ease;
			z-index: 15;
		}
		body.is-paged.header-reveal .header,
		body.is-paged .header:hover {
			transform: translateY(0);
			opacity: 1;
			pointer-events: auto;
		}
		.header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
		.header-title { min-width: 0; }
		.header-actions {
			position: fixed;
			top: 20px;
			right: 20px;
			z-index: 20;
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.menu-toggle {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 6px 10px;
			border-radius: 999px;
			border: 1px solid var(--border);
			background: var(--surface);
			color: var(--page-text);
			font-family: var(--font-sans);
			font-size: 12px;
			cursor: pointer;
			transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
		}
		.menu-toggle:hover { border-color: var(--border-strong); background: var(--surface-muted); }
		.menu-toggle:focus { outline: none; border-color: var(--accent-border); box-shadow: 0 0 0 2px var(--focus-ring); }
		.menu-icon { display: inline-grid; gap: 3px; }
		.menu-icon span { display: block; width: 14px; height: 2px; background: currentColor; border-radius: 999px; }
		.menu-label { font-size: 11px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--text-muted); }
		.menu-panel {
			position: absolute;
			top: calc(100% + 8px);
			right: 0;
			min-width: 0;
			width: min(320px, calc(100vw - 32px));
			max-height: calc(100vh - 100px);
			padding: 12px;
			border-radius: 14px;
			border: 1px solid var(--border-strong);
			background: var(--surface);
			box-shadow: var(--menu-shadow);
			box-sizing: border-box;
			overflow: auto;
			--menu-shift-x: 0px;
			--menu-shift-y: 0px;
			opacity: 0;
			transform: translate(var(--menu-shift-x), calc(var(--menu-shift-y) - 6px));
			pointer-events: none;
			transition: opacity 0.15s ease, transform 0.15s ease;
			z-index: 10;
		}
		.menu-panel.is-open {
			opacity: 1;
			transform: translate(var(--menu-shift-x), var(--menu-shift-y));
			pointer-events: auto;
		}
		.menu-title {
			font-family: var(--font-sans);
			font-size: 11px;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--text-subtle);
			margin-bottom: 10px;
		}
		.menu-controls {
			display: grid;
			gap: 10px;
		}
		.title { font-size: 18px; font-weight: 600; margin: 0 0 4px; font-family: var(--font-sans); }
		.path { font-size: 12px; color: var(--text-muted); word-break: break-all; font-family: var(--font-sans); }
		.width-control {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 6px 10px;
			border-radius: 999px;
			border: 1px solid var(--border);
			background: var(--surface);
			color: var(--text-muted);
			font-family: var(--font-sans);
			font-size: 12px;
			cursor: default;
		}
		.width-input {
			width: 68px;
			padding: 2px 6px;
			border-radius: 6px;
			border: 1px solid var(--border);
			font-size: 12px;
			font-family: var(--font-sans);
			color: var(--page-text);
			background: var(--surface);
		}
		.width-input:focus { outline: none; border-color: var(--accent-border); box-shadow: 0 0 0 2px var(--focus-ring); }
		.width-control .label { letter-spacing: 0.02em; text-transform: uppercase; font-size: 10px; color: var(--text-subtle); }
		.width-control .unit { font-size: 11px; color: var(--text-subtle); }
		.width-toggle {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 6px 10px;
			border-radius: 999px;
			border: 1px solid var(--border);
			background: var(--surface);
			color: var(--text-muted);
			font-family: var(--font-sans);
			font-size: 12px;
			cursor: pointer;
			transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
		}
		.font-control {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 6px 10px;
			border-radius: 999px;
			border: 1px solid var(--border);
			background: var(--surface);
			color: var(--text-muted);
			font-family: var(--font-sans);
			font-size: 12px;
			cursor: default;
			transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
		}
		.width-toggle:hover { border-color: var(--border-strong); color: var(--page-text); background: var(--surface-muted); }
		.width-toggle[aria-pressed="true"] { border-color: var(--accent-border); color: var(--accent-text); background: var(--accent-bg); }
		.width-toggle .label { letter-spacing: 0.02em; text-transform: uppercase; font-size: 10px; color: var(--text-subtle); }
		.width-toggle .value { font-weight: 600; color: inherit; }
		.font-control:hover { border-color: var(--border-strong); color: var(--page-text); background: var(--surface-muted); }
		.font-control .label { letter-spacing: 0.02em; text-transform: uppercase; font-size: 10px; color: var(--text-subtle); }
		.font-control .unit { font-size: 11px; color: var(--text-subtle); }
		.font-input {
			width: 56px;
			padding: 2px 6px;
			border-radius: 6px;
			border: 1px solid var(--border);
			font-size: 12px;
			font-family: var(--font-sans);
			color: var(--page-text);
			background: var(--surface);
		}
		.font-input:focus { outline: none; border-color: var(--accent-border); box-shadow: 0 0 0 2px var(--focus-ring); }
		.content {
			background: transparent;
			padding: 40px;
			border-radius: 0;
			border: none;
			box-shadow: none;
			font-size: var(--content-font-size);
			line-height: 1.7; /* 論文らしい行間 */
			text-align: justify; /* 両端揃え */
		}
		.content.is-paged {
			background: transparent;
			border: none;
			box-shadow: none;
			padding: 0;
		}
		.content p { margin-bottom: 1em; text-align: justify; }
		.pagebook {
			display: grid;
			gap: 12px;
		}
		.pagebook-viewport {
			width: min(100%, calc((var(--pagebook-page-width) * var(--pagebook-columns)) + (var(--pagebook-gap) * (var(--pagebook-columns) - 1))));
			margin: 0 auto;
			overflow: hidden;
			position: relative;
			outline: none;
		}
		.pagebook-track {
			display: flex;
			gap: var(--pagebook-gap);
			transition: transform 0.25s ease;
			will-change: transform;
		}
		.pagebook-page {
			flex: 0 0 var(--pagebook-page-width);
			height: var(--pagebook-page-height);
			padding: 18px 20px;
			box-sizing: border-box;
			background: transparent;
			border: none;
			border-radius: 0;
			box-shadow: none;
			overflow: hidden;
		}
		.pagebook-page.is-overflow { overflow: auto; }
		.pagebook-controls {
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			display: flex;
			align-items: stretch;
			justify-content: space-between;
			pointer-events: none;
			z-index: 4;
		}
		.pagebook-button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 56px;
			height: 100%;
			padding: 0;
			border-radius: 0;
			border: none;
			background: transparent;
			color: var(--text-muted);
			font-family: var(--font-sans);
			font-size: 12px;
			cursor: pointer;
			opacity: 0;
			transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
			pointer-events: auto;
		}
		.pagebook-viewport:hover .pagebook-button { opacity: 1; }
		.pagebook-button:hover { background: rgba(0, 0, 0, 0.06); color: var(--page-text); }
		.pagebook-prev { border-top-left-radius: 12px; border-bottom-left-radius: 12px; }
		.pagebook-next { border-top-right-radius: 12px; border-bottom-right-radius: 12px; }
		:root[data-theme="dark"] .pagebook-button:hover { background: rgba(255, 255, 255, 0.06); }
		.pagebook-button:disabled { opacity: 0.5; cursor: default; }
		.pagebook-indicator {
			font-family: var(--font-sans);
			font-size: 12px;
			color: var(--text-muted);
			position: absolute;
			bottom: 10px;
			left: 50%;
			transform: translateX(-50%);
			background: var(--surface);
			border: 1px solid var(--border);
			border-radius: 999px;
			padding: 4px 10px;
			pointer-events: auto;
		}
		.content h1, .content h2, .content h3 { margin-top: 1.8em; margin-bottom: 0.8em; font-family: var(--font-sans); }
		.content h1 { font-size: 1.8em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
		.content h2 { font-size: 1.4em; }
		.content h3 { font-size: 1.2em; }
		/* 分割されたリストの見た目を整える */
		.content .split-list { margin: 0; padding-left: 1.8em; }
		.content .split-list > li { margin: 0.4em 0; }
		/* 分割されたコードブロックの見た目を整える */
		.content .split-code { margin: 0; }
		.content pre { background: var(--code-bg); color: var(--page-text); padding: 12px 16px; border-radius: 4px; border: 1px solid var(--code-border); overflow-x: auto; position: relative; font-size: 0.9em; }
		.content pre code { display: block; font-size: 13px; line-height: 1.5; font-family: var(--font-mono); }
		.content code { font-family: var(--font-mono); background: var(--inline-code-bg); padding: 0.1em 0.4em; border-radius: 3px; font-size: 0.9em; }
		.content blockquote { margin: 1.2em 0; padding-left: 1em; border-left: 4px solid var(--blockquote-border); color: var(--blockquote-text); font-style: italic; }
		.content img { max-width: 100%; max-height: 65vh; height: auto; display: block; margin: 1.5em auto; }
		.content a { color: var(--link); text-decoration: none; }
		.content a:hover { text-decoration: underline; }
		.content table { width: 100%; border-collapse: collapse; margin: 1.2em 0; }
		.content th, .content td { border: 1px solid var(--table-border); padding: 8px 10px; text-align: left; vertical-align: top; word-break: break-word; }
		.content th { background: var(--table-header-bg); font-weight: 600; }
		.table-wrap { width: 100%; overflow-x: auto; }
		.table-wrap table { min-width: 520px; }
		.content .copy-code-button,
		.content .code-block-flair,
		.content .codeblock-copy,
		.content .code-block-flair { display: none !important; }
		.content pre.code-block { padding-top: 12px; }
		.content .code-copy-button {
			position: absolute;
			top: 8px;
			right: 8px;
			width: 28px;
			height: 28px;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--text-muted);
			display: grid;
			place-items: center;
			cursor: pointer;
			opacity: 0;
			transform: translateY(-4px);
			transition: opacity 0.15s ease, transform 0.15s ease, background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
		}
		.content pre:hover .code-copy-button,
		.content pre:focus-within .code-copy-button { opacity: 0.9; transform: translateY(0); }
		.content .code-copy-button:hover { opacity: 1; background: var(--surface-muted); border-color: var(--border-strong); color: var(--page-text); }
		.content .code-copy-button.is-copied { border-color: var(--success-border); color: var(--success-text); background: var(--success-bg); }
		.callout {
			--callout-color: 68, 138, 255;
			--callout-bg: rgba(68, 138, 255, 0.1);
			--callout-border: rgba(68, 138, 255, 0.25);
			--callout-icon: none;
			margin: 1em 0;
			padding: 1em;
			border-left: 4px solid rgba(var(--callout-color));
			border-radius: 4px;
			background: var(--callout-bg);
			color: var(--page-text);
		}
		.callout[data-callout="note"],
		.callout[data-callout="abstract"],
		.callout[data-callout="summary"],
		.callout[data-callout="tldr"] {
			--callout-color: 94, 129, 172;
		}
		.callout[data-callout="info"],
		.callout[data-callout="todo"],
		.callout[data-callout="tip"],
		.callout[data-callout="hint"],
		.callout[data-callout="important"] {
			--callout-color: 68, 138, 255;
		}
		.callout[data-callout="success"],
		.callout[data-callout="check"],
		.callout[data-callout="done"],
		.callout[data-callout="question"],
		.callout[data-callout="help"],
		.callout[data-callout="faq"] {
			--callout-color: 46, 160, 67;
		}
		.theme-light .callout[data-callout="attention"],
		.theme-light .callout[data-callout="caution"],
		.theme-light .callout[data-callout="warning"] {
			--callout-color: 217, 119, 6;
		}
		.theme-dark .callout[data-callout="attention"],
		.theme-dark .callout[data-callout="caution"],
		.theme-dark .callout[data-callout="warning"] {
			--callout-color: 245, 121, 0;
		}
		.callout[data-callout="failure"],
		.callout[data-callout="fail"],
		.callout[data-callout="missing"] {
			--callout-color: 209, 102, 85;
		}
		.callout[data-callout="danger"],
		.callout[data-callout="error"],
		.callout[data-callout="bug"] {
			--callout-color: 219, 68, 55;
		}
		.callout[data-callout="example"] {
			--callout-color: 126, 87, 194;
		}
		.callout[data-callout="quote"],
		.callout[data-callout="cite"] {
			--callout-color: 153, 153, 153;
		}
		.callout[data-callout="quote"] {
			--callout-icon: none;
		}
		.callout-title {
			display: flex;
			align-items: center;
			gap: 8px;
			font-weight: 600;
			font-size: 1em;
			line-height: 1.5;
			margin-bottom: 0.5em;
			font-family: var(--font-sans);
			color: var(--page-text);
		}
		.callout-title .callout-icon {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 20px;
			height: 20px;
			flex-shrink: 0;
		}
		.callout-content {
			margin: 0;
			line-height: 1.6;
		}
		.callout-content > *:first-child {
			margin-top: 0;
		}
		.callout-content > *:last-child {
			margin-bottom: 0;
		}
		.callout.is-collapsed .callout-content {
			display: none;
		}
		.callout.is-collapsed {
			padding-bottom: 0;
		}
		.callout-fold {
			position: absolute;
			right: 0;
			top: 0;
			width: 24px;
			height: 24px;
			padding: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			border-radius: 4px;
			background: rgba(var(--callout-color), 0.1);
			cursor: pointer;
			transition: background 0.15s ease;
			-webkit-mask-image: var(--callout-collapse-icon);
			mask-image: var(--callout-collapse-icon);
			mask-size: 100%;
			-webkit-mask-size: 100%;
			mask-repeat: no-repeat;
			-webkit-mask-repeat: no-repeat;
		}
		.callout-fold:hover {
			background: rgba(var(--callout-color), 0.2);
		}
		.callout {
			position: relative;
		}
		:root[data-theme="dark"] .callout {
			--callout-bg: rgba(255, 255, 255, 0.1);
		}
		mjx-container { font-family: var(--font-math); }
		.math-block { overflow-x: auto; }
		@media (max-width: 720px) {
			.page { padding: 28px 16px 48px; }
			.header-row { align-items: flex-start; }
			.header-actions { top: 16px; right: 16px; }
			.menu-panel { right: 0; left: auto; width: calc(100vw - 32px); max-height: calc(100vh - 96px); }
		}
	</style>
	<script>
		window.MathJax = {
			tex: {
				inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
				displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']],
				processEscapes: true,
				processEnvironments: true
			},
			startup: { typeset: false },
			svg: { fontCache: 'global' }
		};
	</script>
	<script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
</head>
<body>
	<div class="header-hover-zone" aria-hidden="true"></div>
	<div class="page">
		<header class="header">
			<div class="header-row">
				<div class="header-title">
					<p class="title">${title}</p>
					<p class="path">${escapeHtml(sourcePath)}</p>
				</div>
				<div class="header-actions">
					<button class="menu-toggle" type="button" data-action="toggle-menu" aria-expanded="false" aria-controls="view-options" title="表示設定">
						<span class="menu-icon" aria-hidden="true">
							<span></span>
							<span></span>
							<span></span>
						</span>
						<span class="menu-label">Menu</span>
					</button>
					<div class="menu-panel" id="view-options">
						<div class="menu-title">表示設定</div>
						<div class="menu-controls">
							<label class="width-control" data-action="width-size" title="横幅(px)">
								<span class="label">WIDTH</span>
								<input class="width-input" type="number" min="480" max="2000" step="10" value="900" aria-label="横幅(px)">
								<span class="unit">px</span>
							</label>
							<button class="width-toggle" type="button" data-action="toggle-width" aria-pressed="false" title="フル幅に切り替え">
								<span class="label">FULL</span>
								<span class="value" data-width-value>OFF</span>
							</button>
							<button class="width-toggle" type="button" data-action="toggle-spread" aria-pressed="false" title="見開きモード">
								<span class="label">SPREAD</span>
								<span class="value" data-spread-value>OFF</span>
							</button>
							<button class="width-toggle" type="button" data-action="toggle-theme" aria-pressed="false" title="テーマを切り替え">
								<span class="label">THEME</span>
								<span class="value" data-theme-value>LIGHT</span>
							</button>
							<label class="font-control" data-action="font-size" title="文字サイズ(px)">
								<span class="label">TEXT</span>
								<input class="font-input" type="number" min="10" max="30" step="1" value="16" aria-label="文字サイズ(px)">
								<span class="unit">px</span>
							</label>
						</div>
					</div>
				</div>
			</div>
		</header>
		<main class="content">
			${renderedHtml}
		</main>
	</div>
	<script>
		(function() {
			const widthStorageKey = 'local-vault-preview-width';
			const pageEl = document.querySelector('.page');
			const widthToggle = document.querySelector('[data-action="toggle-width"]');
			const widthValue = widthToggle ? widthToggle.querySelector('[data-width-value]') : null;
			const widthSizeStorageKey = 'local-vault-preview-width-size';
			const widthInput = document.querySelector('.width-input');
			const fontStorageKey = 'local-vault-preview-font-size';
			const fontInput = document.querySelector('.font-input');
			const themeStorageKey = 'local-vault-preview-theme';
			const themeToggle = document.querySelector('[data-action="toggle-theme"]');
			const themeValue = themeToggle ? themeToggle.querySelector('[data-theme-value]') : null;
			const spreadStorageKey = 'local-vault-preview-spread';
			const spreadToggle = document.querySelector('[data-action="toggle-spread"]');
			const spreadValue = spreadToggle ? spreadToggle.querySelector('[data-spread-value]') : null;
			const menuToggle = document.querySelector('[data-action="toggle-menu"]');
			const menuPanel = document.querySelector('.menu-panel');
			const contentEl = document.querySelector('.content');
			const headerEl = document.querySelector('.header');
			const headerHoverZone = document.querySelector('.header-hover-zone');
			let baseContentHtml = contentEl ? contentEl.innerHTML : '';
			const pagebookState = {
				enabled: false,
				spread: false,
				currentIndex: 0,
				pageCount: 0,
				setPage: null,
			};
			// 非同期レイアウト待ちの競合を避けるためのトークン
			let pagebookBuildToken = 0;
			// 画面サイズが本当に変わったときだけ再計算する
			const getViewportSize = () => ({ width: window.innerWidth, height: window.innerHeight });
			let lastViewportSize = getViewportSize();

			const applyWidthMode = (mode) => {
				if (!pageEl || !widthToggle || !widthValue) {
					return;
				}
				const isFull = mode === 'full';
				pageEl.classList.toggle('is-full', isFull);
				widthToggle.setAttribute('aria-pressed', isFull ? 'true' : 'false');
				widthValue.textContent = isFull ? 'ON' : 'OFF';
				refreshPagebook();
			};

			const readPxVar = (name, fallback) => {
				const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
				const parsed = Number.parseFloat(raw);
				return Number.isFinite(parsed) ? parsed : fallback;
			};

			const computeLayout = (desiredSingleWidth, spreadEnabled) => {
				const columns = spreadEnabled ? 2 : 1;
				const gap = spreadEnabled ? 16 : 0;
				const paddingX = readPxVar('--page-padding-x', 20);
				const maxTotal = Math.max(320, window.innerWidth - (paddingX * 2));

				if (columns === 1) {
					const singleWidth = Math.min(desiredSingleWidth, maxTotal);
					return { columns, gap, singleWidth, totalWidth: singleWidth };
				}

				const maxSingle = Math.max(240, Math.floor((maxTotal - gap) / 2));
				const singleWidth = Math.min(desiredSingleWidth, maxSingle);
				const totalWidth = (singleWidth * 2) + gap;
				return { columns, gap, singleWidth, totalWidth };
			};

			// 見出しかどうかを判定する（H1〜H6）
			const isHeadingElement = (node) => {
				return !!(node && node.nodeType === Node.ELEMENT_NODE && /^H[1-6]$/i.test(node.tagName));
			};

			// 段落など、内容を分割できるブロックかを判定する
			const isSplittableElement = (node) => {
				if (!node || node.nodeType !== Node.ELEMENT_NODE) {
					return false;
				}
				const tag = node.tagName ? node.tagName.toUpperCase() : '';
				return tag === 'P' || tag === 'LI' || tag === 'BLOCKQUOTE';
			};

			// コードブロックかどうかを判定する
			const isCodeBlockElement = (node) => {
				if (!node || node.nodeType !== Node.ELEMENT_NODE) {
					return false;
				}
				const tag = node.tagName ? node.tagName.toUpperCase() : '';
				return tag === 'PRE';
			};

			// リストを複数ページへ分割できるよう、1アイテム単位で切り出す
			const cloneListContainer = (listEl) => {
				const clone = listEl.cloneNode(false);
				if (clone instanceof HTMLElement && clone.hasAttribute('id')) {
					clone.removeAttribute('id');
				}
				clone.classList.add('split-list');
				return clone;
			};

			const splitListIntoChunks = (listEl) => {
				if (!listEl || listEl.nodeType !== Node.ELEMENT_NODE) {
					return [];
				}
				const listTag = listEl.tagName ? listEl.tagName.toUpperCase() : '';
				if (listTag !== 'UL' && listTag !== 'OL') {
					return [listEl.cloneNode(true)];
				}

				const items = Array.from(listEl.children).filter((child) => {
					return child.nodeType === Node.ELEMENT_NODE && child.tagName.toUpperCase() === 'LI';
				});

				if (items.length === 0) {
					return [listEl.cloneNode(true)];
				}

				const isOrdered = listTag === 'OL';
				const hasStart = isOrdered && listEl.hasAttribute('start');
				const hasReversed = isOrdered && listEl.hasAttribute('reversed');
				const rawStart = hasStart ? Number.parseInt(listEl.getAttribute('start') || '', 10) : NaN;
				const baseStart = Number.isFinite(rawStart)
					? rawStart
					: (hasReversed ? items.length : 1);

				return items.map((item, index) => {
					const listClone = cloneListContainer(listEl);
					if (isOrdered) {
						const value = hasReversed ? baseStart - index : baseStart + index;
						listClone.setAttribute('start', String(value));
					}
					listClone.appendChild(item.cloneNode(true));
					return listClone;
				});
			};

			// 改ページはブロック単位で行う（子要素だけに頼らない）
			const collectPageNodes = (root) => {
				const nodes = [];
				const children = Array.from(root.childNodes);

				children.forEach((child) => {
					if (child.nodeType === Node.ELEMENT_NODE) {
						const element = child;
						const tag = element.tagName ? element.tagName.toUpperCase() : '';
						if (tag === 'UL' || tag === 'OL') {
							splitListIntoChunks(element).forEach((chunk) => nodes.push(chunk));
							return;
						}
						nodes.push(element);
						return;
					}
					if (child.nodeType === Node.TEXT_NODE) {
						const text = child.textContent || '';
						if (text.trim()) {
							const wrapper = document.createElement('p');
							wrapper.textContent = text;
							nodes.push(wrapper);
						}
					}
				});

				return nodes;
			};

			// コードブロックを行単位で分割し、ページに収まるようにする
			const cloneCodeBlockContainer = (preEl) => {
				const clone = preEl.cloneNode(false);
				if (clone instanceof HTMLElement && clone.hasAttribute('id')) {
					clone.removeAttribute('id');
				}
				clone.classList.add('split-code');
				return clone;
			};

			const buildCodeBlock = (preEl, lines, startIndex, endIndex) => {
				const preClone = cloneCodeBlockContainer(preEl);
				const codeSource = preEl.querySelector('code');
				const codeClone = codeSource ? codeSource.cloneNode(false) : document.createElement('code');
				codeClone.textContent = lines.slice(startIndex, endIndex).join('\\n');
				preClone.appendChild(codeClone);
				return preClone;
			};

			const splitCodeBlockToFit = (preEl, page, availableHeight, baseHeight, minHeadHeight) => {
				if (!preEl || !page) {
					return null;
				}
				const codeSource = preEl.querySelector('code');
				const rawText = codeSource ? codeSource.textContent || '' : preEl.textContent || '';
				const lines = rawText.split('\\n');
				if (lines.length <= 1) {
					return null;
				}

				let low = 1;
				let high = lines.length - 1;
				let best = null;

				while (low <= high) {
					const mid = Math.floor((low + high) / 2);
					const head = buildCodeBlock(preEl, lines, 0, mid);
					page.appendChild(head);
					const fits = page.scrollHeight <= availableHeight;
					const headHeight = page.scrollHeight - baseHeight;
					page.removeChild(head);

					if (fits && headHeight >= minHeadHeight) {
						best = { splitIndex: mid };
						low = mid + 1;
					} else {
						high = mid - 1;
					}
				}

				if (!best) {
					return null;
				}

				const splitIndex = best.splitIndex;
				if (splitIndex <= 0 || splitIndex >= lines.length) {
					return null;
				}

				return {
					head: buildCodeBlock(preEl, lines, 0, splitIndex),
					tail: buildCodeBlock(preEl, lines, splitIndex, lines.length),
				};
			};

			const splitNodeToFit = (node, page, availableHeight, baseHeight, minHeadHeight) => {
				if (isCodeBlockElement(node)) {
					return splitCodeBlockToFit(node, page, availableHeight, baseHeight, minHeadHeight);
				}
				if (isSplittableElement(node)) {
					return splitElementToFit(node, page, availableHeight, baseHeight, minHeadHeight);
				}
				return null;
			};

			// 見開きモードで「スクロールより改ページ」を優先したい要素
			const isHardPageElement = (node) => {
				if (!node || node.nodeType !== Node.ELEMENT_NODE) {
					return false;
				}
				const tag = node.tagName ? node.tagName.toUpperCase() : '';
				return tag === 'PRE' || tag === 'UL' || tag === 'OL';
			};

			const shouldAvoidOverflow = (node) => {
				return pagebookState.spread && isHardPageElement(node);
			};

			const getContentLineHeight = () => {
				if (!contentEl) {
					return 0;
				}
				const value = getComputedStyle(contentEl).lineHeight || '';
				const parsed = Number.parseFloat(value);
				return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
			};

			const getTextNodes = (root) => {
				const nodes = [];
				if (!root) {
					return nodes;
				}
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
				let current = walker.nextNode();
				while (current) {
					nodes.push(current);
					current = walker.nextNode();
				}
				return nodes;
			};

			const splitElementByCharOffset = (element, charOffset) => {
				if (!element || charOffset <= 0) {
					return null;
				}
				const textNodes = getTextNodes(element);
				const totalLength = textNodes.reduce((sum, node) => sum + (node.textContent || '').length, 0);
				if (totalLength === 0 || charOffset >= totalLength) {
					return null;
				}
				let remaining = charOffset;
				let targetNode = null;
				let targetOffset = 0;
				for (const node of textNodes) {
					const length = (node.textContent || '').length;
					if (remaining <= length) {
						targetNode = node;
						targetOffset = remaining;
						break;
					}
					remaining -= length;
				}
				if (!targetNode) {
					return null;
				}

				const fullRange = document.createRange();
				fullRange.selectNodeContents(element);

				const headRange = document.createRange();
				headRange.setStart(fullRange.startContainer, fullRange.startOffset);
				headRange.setEnd(targetNode, targetOffset);

				const tailRange = document.createRange();
				tailRange.setStart(targetNode, targetOffset);
				tailRange.setEnd(fullRange.endContainer, fullRange.endOffset);

				const head = element.cloneNode(false);
				const tail = element.cloneNode(false);
				head.appendChild(headRange.cloneContents());
				tail.appendChild(tailRange.cloneContents());

				if (!(head.textContent || '').trim() || !(tail.textContent || '').trim()) {
					return null;
				}
				return { head, tail };
			};

			const splitElementToFit = (element, page, availableHeight, baseHeight, minHeadHeight) => {
				if (!element || !page) {
					return null;
				}
				const textNodes = getTextNodes(element);
				const totalLength = textNodes.reduce((sum, node) => sum + (node.textContent || '').length, 0);
				if (totalLength < 20) {
					return null;
				}

				let low = 1;
				let high = totalLength - 1;
				let best = null;

				while (low <= high) {
					const mid = Math.floor((low + high) / 2);
					const split = splitElementByCharOffset(element, mid);
					if (!split) {
						high = mid - 1;
						continue;
					}
					page.appendChild(split.head);
					const fits = page.scrollHeight <= availableHeight;
					const headHeight = page.scrollHeight - baseHeight;
					page.removeChild(split.head);

					if (fits && headHeight >= minHeadHeight) {
						best = split;
						low = mid + 1;
					} else {
						high = mid - 1;
					}
				}

				return best;
			};

			const updatePageMaxWidth = (singleWidth, spreadEnabled) => {
				const layout = computeLayout(singleWidth, spreadEnabled);
				document.documentElement.style.setProperty('--page-single-width', layout.singleWidth + 'px');
				document.documentElement.style.setProperty('--page-max-width', layout.totalWidth + 'px');
			};

			const applyWidthSize = (size) => {
				if (!widthInput) {
					return;
				}
				const safeSize = Math.min(2000, Math.max(480, size));
				updatePageMaxWidth(safeSize, pagebookState.spread);
				widthInput.value = String(safeSize);
				refreshPagebook();
			};

			const applyFontSize = (size) => {
				if (!fontInput) {
					return;
				}
				// 入力値の暴走を防ぐため、最小/最大を丸める。
				const safeSize = Math.min(30, Math.max(10, size));
				document.documentElement.style.setProperty('--content-font-size', safeSize + 'px');
				fontInput.value = String(safeSize);
				refreshPagebook();
			};

			const getPreferredTheme = () => {
				if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
					return 'dark';
				}
				return 'light';
			};

			const applyTheme = (mode) => {
				const theme = mode === 'dark' ? 'dark' : 'light';
				document.documentElement.setAttribute('data-theme', theme);
				if (themeToggle && themeValue) {
					themeToggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
					themeValue.textContent = theme === 'dark' ? 'DARK' : 'LIGHT';
				}
			};

			const requestMathTypeset = (timeoutMs = 2000) => {
				return new Promise((resolve) => {
					const startedAt = Date.now();
					const waitForMathJax = () => {
						if (!window.MathJax || !window.MathJax.typesetPromise) {
							if (Date.now() - startedAt >= timeoutMs) {
								resolve();
								return;
							}
							setTimeout(waitForMathJax, 50);
							return;
						}
						window.MathJax
							.typesetPromise()
							.then(() => resolve())
							.catch(() => resolve());
					};
					waitForMathJax();
				});
			};

			const waitForImages = (root, timeoutMs = 1500) => {
				if (!root) {
					return Promise.resolve();
				}
				const images = Array.from(root.querySelectorAll('img'))
					.filter((img) => !img.complete);
				if (images.length === 0) {
					return Promise.resolve();
				}
				const imagePromises = images.map((img) => new Promise((resolve) => {
					const done = () => resolve();
					img.addEventListener('load', done, { once: true });
					img.addEventListener('error', done, { once: true });
				}));
				return Promise.race([
					Promise.all(imagePromises),
					new Promise((resolve) => setTimeout(resolve, timeoutMs)),
				]);
			};

			const waitForFonts = () => {
				if (document.fonts && document.fonts.ready) {
					return document.fonts.ready.catch(() => {});
				}
				return Promise.resolve();
			};

			// 画像/数式/フォントが落ち着くまで待ってから分割する
			const waitForStableLayout = async () => {
				if (!contentEl) {
					return;
				}
				await Promise.all([
					waitForImages(contentEl, 1800),
					waitForFonts(),
					requestMathTypeset(2000),
				]);
			};

			const enhanceContent = () => {
				if (!contentEl) {
					return;
				}
				const removeSelectors = ['.copy-code-button', '.code-block-flair', '.codeblock-copy', '.code-block-flair'];
				removeSelectors.forEach((selector) => {
					contentEl.querySelectorAll(selector).forEach((el) => el.remove());
				});

				contentEl.querySelectorAll('pre').forEach((pre) => {
					pre.classList.add('code-block');

					pre.querySelectorAll('button').forEach((button) => {
						button.remove();
					});

					const code = pre.querySelector('code');
					if (!code) {
						return;
					}

					const copyButton = document.createElement('button');
					copyButton.type = 'button';
					copyButton.className = 'code-copy-button';
					copyButton.setAttribute('aria-label', 'Copy code');
					copyButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 7a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V7zm-3 3a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-1h-2v1H5v-7h1V10H5z"/></svg>';

					copyButton.addEventListener('click', async () => {
						const text = code.innerText;
						try {
							await navigator.clipboard.writeText(text);
						} catch (error) {
							const temp = document.createElement('textarea');
							temp.value = text;
							temp.style.position = 'fixed';
							temp.style.opacity = '0';
							document.body.appendChild(temp);
							temp.select();
							document.execCommand('copy');
							temp.remove();
						}
						copyButton.classList.add('is-copied');
						setTimeout(() => copyButton.classList.remove('is-copied'), 1200);
					});

					pre.appendChild(copyButton);
				});

				contentEl.querySelectorAll('table').forEach((table) => {
					const parent = table.parentElement;
					if (parent && parent.classList.contains('table-wrap')) {
						return;
					}
					const wrapper = document.createElement('div');
					wrapper.className = 'table-wrap';
					table.parentNode?.insertBefore(wrapper, table);
					wrapper.appendChild(table);
				});

				void requestMathTypeset();
			};

			const buildPagebook = (preserveIndex) => {
				// ページ送り表示のため、現在の内容を高さベースで分割する。
				if (!contentEl) {
					return;
				}
				const savedIndex = preserveIndex ? pagebookState.currentIndex : 0;
				const buildToken = ++pagebookBuildToken;
				contentEl.classList.add('is-paged');
				contentEl.innerHTML = baseContentHtml;
				enhanceContent();

				waitForStableLayout().then(() => {
					if (!pagebookState.enabled || buildToken !== pagebookBuildToken) {
						return;
					}

					const nodes = collectPageNodes(contentEl);
					const pagebook = document.createElement('div');
					pagebook.className = 'pagebook';

					const viewport = document.createElement('div');
					viewport.className = 'pagebook-viewport';
					viewport.setAttribute('tabindex', '0');

					const track = document.createElement('div');
					track.className = 'pagebook-track';
					viewport.appendChild(track);

					const controls = document.createElement('div');
					controls.className = 'pagebook-controls';

					const prevButton = document.createElement('button');
					prevButton.type = 'button';
					prevButton.className = 'pagebook-button pagebook-prev';
					prevButton.textContent = '◀';

					const indicator = document.createElement('span');
					indicator.className = 'pagebook-indicator';

					const nextButton = document.createElement('button');
					nextButton.type = 'button';
					nextButton.className = 'pagebook-button pagebook-next';
					nextButton.textContent = '▶';

					controls.appendChild(prevButton);
					controls.appendChild(indicator);
					controls.appendChild(nextButton);

					pagebook.appendChild(viewport);
					pagebook.appendChild(controls);

					contentEl.innerHTML = '';
					contentEl.appendChild(pagebook);

					// 固定ヘッダーの高さを引かず、改ページの過剰発生を抑える。
					const reservedViewportPadding = 20;
					const availableHeight = Math.max(360, window.innerHeight - reservedViewportPadding);
					const desiredSingleWidth = widthInput instanceof HTMLInputElement
						? Math.min(2000, Math.max(480, Number.parseInt(widthInput.value || '', 10) || 900))
						: 900;
					const layout = computeLayout(desiredSingleWidth, pagebookState.spread);

					contentEl.style.setProperty('--pagebook-gap', layout.gap + 'px');
					contentEl.style.setProperty('--pagebook-columns', String(layout.columns));
					contentEl.style.setProperty('--pagebook-page-width', layout.singleWidth + 'px');
					contentEl.style.setProperty('--pagebook-page-height', availableHeight + 'px');

					updatePageMaxWidth(desiredSingleWidth, pagebookState.spread);
					const columns = layout.columns;
					const gap = layout.gap;
					const pageWidth = layout.singleWidth;

					const createPage = () => {
						const page = document.createElement('section');
						page.className = 'pagebook-page';
						page.style.height = availableHeight + 'px';
						return page;
					};

					// 1行分を目安に、段落の分割許容ラインを決める。
					const lineHeight = getContentLineHeight();
					// 分割後の断片が小さすぎると読みづらいため、最低でも2.5行分程度は確保する
					const minSplitHeight = Math.max(48, lineHeight > 0 ? lineHeight * 2.5 : 48);

					let currentPage = createPage();
					track.appendChild(currentPage);

					for (let i = 0; i < nodes.length; i++) {
						const node = nodes[i];
						if (!node) {
							continue;
						}

						const isHeading = isHeadingElement(node);
						const nextNode = i + 1 < nodes.length ? nodes[i + 1] : null;

						if (isHeading && nextNode) {
							const hadContentBefore = currentPage.childNodes.length > 0;
							// 見出しの直後には、最低でも4行分程度の本文が続かない場合は改ページする（孤立見出し対策）
							const minContinuationHeight = Math.max(80, lineHeight > 0 ? lineHeight * 4.0 : 80);

							// 見出しがページ末に孤立しないよう、次の要素と一緒に収まるかを見る。
							currentPage.appendChild(node);
							if (currentPage.scrollHeight > availableHeight) {
								currentPage.removeChild(node);
								if (!hadContentBefore) {
									currentPage.appendChild(node);
									currentPage.classList.add('is-overflow');
								} else {
									currentPage = createPage();
									track.appendChild(currentPage);
									currentPage.appendChild(node);
									if (currentPage.scrollHeight > availableHeight) {
										currentPage.classList.add('is-overflow');
									}
								}
								continue;
							}

							const remainingAfterHeading = availableHeight - currentPage.scrollHeight;

							currentPage.appendChild(nextNode);
							const fitsWithNext = currentPage.scrollHeight <= availableHeight;
							currentPage.removeChild(nextNode);

						if (!fitsWithNext) {
							const avoidOverflow = shouldAvoidOverflow(nextNode);
							if (!avoidOverflow && remainingAfterHeading >= minContinuationHeight && (isSplittableElement(nextNode) || isCodeBlockElement(nextNode))) {
								const split = splitNodeToFit(nextNode, currentPage, availableHeight, currentPage.scrollHeight, minContinuationHeight);
								if (split) {
									currentPage.appendChild(split.head);
									currentPage = createPage();
									track.appendChild(currentPage);
									currentPage.appendChild(split.tail);
									if (currentPage.scrollHeight > availableHeight) {
										currentPage.classList.add('is-overflow');
									}
									i += 1;
									continue;
								}
							}

							if (!avoidOverflow && (!hadContentBefore || remainingAfterHeading >= minContinuationHeight)) {
								// 見出し直下に最低限の本文を残すため、次の要素を同じページでオーバーフロー許可にする。
								currentPage.appendChild(nextNode);
								currentPage.classList.add('is-overflow');
								i += 1;
								continue;
							}

							if (avoidOverflow) {
								// 見開きモードではスクロールを避けて次ページに送る。
								continue;
							}

							currentPage.removeChild(node);
							currentPage = createPage();
							track.appendChild(currentPage);
							currentPage.appendChild(node);
								if (currentPage.scrollHeight > availableHeight) {
									currentPage.classList.add('is-overflow');
								}
								continue;
							}

							continue;
						}

						const baseHeight = currentPage.scrollHeight;
						const remainingHeight = availableHeight - baseHeight;
						currentPage.appendChild(node);
						if (currentPage.scrollHeight > availableHeight) {
							currentPage.removeChild(node);

							if (remainingHeight >= minSplitHeight && (isSplittableElement(node) || isCodeBlockElement(node))) {
								const split = splitNodeToFit(node, currentPage, availableHeight, baseHeight, minSplitHeight);
								if (split) {
									currentPage.appendChild(split.head);
									currentPage = createPage();
									track.appendChild(currentPage);
									currentPage.appendChild(split.tail);
									if (currentPage.scrollHeight > availableHeight) {
										currentPage.classList.add('is-overflow');
									}
									continue;
								}
							}

							// 見出しだけのページになりそうなら、同じページに残してスクロールを許可する。
							const headingOnly = currentPage.childNodes.length === 1
								&& isHeadingElement(currentPage.firstElementChild);
							if (headingOnly) {
								const avoidOverflow = shouldAvoidOverflow(node);
								if (avoidOverflow) {
									currentPage = createPage();
									track.appendChild(currentPage);
									currentPage.appendChild(node);
									if (currentPage.scrollHeight > availableHeight) {
										currentPage.classList.add('is-overflow');
									}
									continue;
								}
								currentPage.appendChild(node);
								currentPage.classList.add('is-overflow');
								continue;
							}

							// 単体で収まりきらない要素はそのページでスクロールを許可する。
							if (currentPage.childNodes.length === 0) {
								currentPage.appendChild(node);
								currentPage.classList.add('is-overflow');
							} else {
								currentPage = createPage();
								track.appendChild(currentPage);
								currentPage.appendChild(node);
								if (currentPage.scrollHeight > availableHeight) {
									currentPage.classList.add('is-overflow');
								}
							}
						}
					}

					pagebookState.pageCount = track.children.length;

					const setPage = (index) => {
						const maxIndex = Math.max(0, pagebookState.pageCount - columns);
						const clamped = Math.min(Math.max(0, index), maxIndex);
						pagebookState.currentIndex = clamped;
						const step = pageWidth + gap;
						const offset = -clamped * step;
						track.style.transform = 'translateX(' + offset + 'px)';
						const start = clamped + 1;
						const end = Math.min(clamped + columns, pagebookState.pageCount);
						indicator.textContent = start === end
							? String(start) + ' / ' + String(pagebookState.pageCount)
							: String(start) + '-' + String(end) + ' / ' + String(pagebookState.pageCount);
						prevButton.disabled = clamped <= 0;
						nextButton.disabled = clamped >= maxIndex;
					};

					pagebookState.setPage = setPage;
					prevButton.addEventListener('click', () => setPage(pagebookState.currentIndex - columns));
					nextButton.addEventListener('click', () => setPage(pagebookState.currentIndex + columns));

					setPage(savedIndex);
				});
			};

			const disablePagebook = () => {
				pagebookState.enabled = false;
				pagebookState.spread = false;
				pagebookState.setPage = null;
				document.body.classList.remove('is-paged');
				document.body.classList.remove('header-reveal');
				if (pageEl) {
					pageEl.classList.remove('is-paged');
				}
				if (headerEl) {
					headerEl.classList.remove('is-paged');
				}
				if (!contentEl) {
					return;
				}
				contentEl.classList.remove('is-paged');
				contentEl.innerHTML = baseContentHtml;
				enhanceContent();
			};

			const enablePagebook = (spreadMode) => {
				pagebookState.enabled = true;
				pagebookState.spread = spreadMode;
				document.body.classList.add('is-paged');
				document.body.classList.remove('header-reveal');
				if (pageEl) {
					pageEl.classList.add('is-paged');
				}
				if (headerEl) {
					headerEl.classList.add('is-paged');
				}
				buildPagebook(false);
			};

			let refreshPending = 0;
			const refreshPagebook = () => {
				if (!pagebookState.enabled) {
					return;
				}
				if (refreshPending) {
					cancelAnimationFrame(refreshPending);
				}
				refreshPending = requestAnimationFrame(() => {
					buildPagebook(true);
					refreshPending = 0;
				});
			};

			if (pageEl && widthToggle && widthValue) {
				const savedMode = localStorage.getItem(widthStorageKey);
				const initialMode = savedMode === 'full' ? 'full' : 'fixed';
				applyWidthMode(initialMode);

				widthToggle.addEventListener('click', () => {
					const nextMode = pageEl.classList.contains('is-full') ? 'fixed' : 'full';
					localStorage.setItem(widthStorageKey, nextMode);
					applyWidthMode(nextMode);
					if (nextMode === 'fixed') {
						const rawWidth = widthInput instanceof HTMLInputElement
							? Number.parseInt(widthInput.value || '', 10)
							: 900;
						const safeWidth = Number.isFinite(rawWidth) ? rawWidth : 900;
						applyWidthSize(safeWidth);
					}
				});
			}

			if (themeToggle) {
				const savedTheme = localStorage.getItem(themeStorageKey);
				const initialTheme = (savedTheme === 'dark' || savedTheme === 'light') ? savedTheme : getPreferredTheme();
				applyTheme(initialTheme);
				themeToggle.addEventListener('click', () => {
					const currentTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
					const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
					localStorage.setItem(themeStorageKey, nextTheme);
					applyTheme(nextTheme);
				});
			} else {
				applyTheme(getPreferredTheme());
			}

			if (menuToggle instanceof HTMLButtonElement && menuPanel instanceof HTMLElement) {
				const clampMenuPanel = () => {
					if (!menuPanel.classList.contains('is-open')) {
						return;
					}
					menuPanel.style.setProperty('--menu-shift-x', '0px');
					menuPanel.style.setProperty('--menu-shift-y', '0px');

					const rect = menuPanel.getBoundingClientRect();
					const padding = 8;
					let shiftX = 0;
					let shiftY = 0;

					if (rect.right > window.innerWidth - padding) {
						shiftX -= rect.right - (window.innerWidth - padding);
					}
					if (rect.left < padding) {
						shiftX += padding - rect.left;
					}
					if (rect.bottom > window.innerHeight - padding) {
						shiftY -= rect.bottom - (window.innerHeight - padding);
					}
					if (rect.top < padding) {
						shiftY += padding - rect.top;
					}

					menuPanel.style.setProperty('--menu-shift-x', shiftX + 'px');
					menuPanel.style.setProperty('--menu-shift-y', shiftY + 'px');
				};

				const openMenu = () => {
					menuPanel.classList.add('is-open');
					menuToggle.setAttribute('aria-expanded', 'true');
					requestAnimationFrame(clampMenuPanel);
				};
				const closeMenu = () => {
					menuPanel.classList.remove('is-open');
					menuToggle.setAttribute('aria-expanded', 'false');
				};

				menuToggle.addEventListener('click', (event) => {
					event.stopPropagation();
					if (menuPanel.classList.contains('is-open')) {
						closeMenu();
					} else {
						openMenu();
					}
				});

				menuPanel.addEventListener('click', (event) => {
					event.stopPropagation();
				});

				document.addEventListener('click', () => {
					closeMenu();
				});

				document.addEventListener('keydown', (event) => {
					if (event.key === 'Escape') {
						closeMenu();
					}
				});

				window.addEventListener('resize', () => {
					clampMenuPanel();
				});
			}

			if (headerEl && headerHoverZone) {
				const showHeader = () => {
					if (!pagebookState.enabled) {
						return;
					}
					document.body.classList.add('header-reveal');
				};
				const hideHeader = () => {
					if (!pagebookState.enabled) {
						return;
					}
					document.body.classList.remove('header-reveal');
				};

				headerHoverZone.addEventListener('mouseenter', () => {
					showHeader();
				});
				headerHoverZone.addEventListener('mouseleave', () => {
					if (headerEl.matches(':hover')) {
						return;
					}
					hideHeader();
				});
				headerEl.addEventListener('mouseenter', () => {
					showHeader();
				});
				headerEl.addEventListener('mouseleave', () => {
					if (headerHoverZone.matches(':hover')) {
						return;
					}
					hideHeader();
				});
			}

			if (widthInput instanceof HTMLInputElement) {
				const savedWidthSize = Number.parseInt(localStorage.getItem(widthSizeStorageKey) || '', 10);
				const initialWidthSize = Number.isFinite(savedWidthSize) ? savedWidthSize : 900;
				applyWidthSize(initialWidthSize);

				widthInput.addEventListener('input', () => {
					const rawValue = Number.parseInt(widthInput.value || '', 10);
					if (!Number.isFinite(rawValue)) {
						return;
					}
					localStorage.setItem(widthSizeStorageKey, String(rawValue));
					applyWidthSize(rawValue);
				});

				widthInput.addEventListener('blur', () => {
					const rawValue = Number.parseInt(widthInput.value || '', 10);
					const normalizedValue = Number.isFinite(rawValue) ? rawValue : 900;
					localStorage.setItem(widthSizeStorageKey, String(normalizedValue));
					applyWidthSize(normalizedValue);
				});
			}

			if (fontInput instanceof HTMLInputElement) {
				const savedFontSize = Number.parseInt(localStorage.getItem(fontStorageKey) || '', 10);
				const initialFontSize = Number.isFinite(savedFontSize) ? savedFontSize : 16;
				applyFontSize(initialFontSize);

				fontInput.addEventListener('input', () => {
					const rawValue = Number.parseInt(fontInput.value || '', 10);
					if (!Number.isFinite(rawValue)) {
						return;
					}
					localStorage.setItem(fontStorageKey, String(rawValue));
					applyFontSize(rawValue);
				});

				fontInput.addEventListener('blur', () => {
					const rawValue = Number.parseInt(fontInput.value || '', 10);
					const normalizedValue = Number.isFinite(rawValue) ? rawValue : 16;
					localStorage.setItem(fontStorageKey, String(normalizedValue));
					applyFontSize(normalizedValue);
				});
			}

			enhanceContent();
			if (contentEl) {
				baseContentHtml = contentEl.innerHTML;
			}

			const applySpreadState = (enabled) => {
				if (spreadToggle && spreadValue) {
					spreadToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
					spreadValue.textContent = enabled ? 'ON' : 'OFF';
				}
				if (widthInput instanceof HTMLInputElement) {
					const rawWidth = Number.parseInt(widthInput.value || '', 10);
					const safeWidth = Number.isFinite(rawWidth) ? rawWidth : 900;
					updatePageMaxWidth(safeWidth, enabled);
				}
				if (enabled) {
					enablePagebook(true);
				} else {
					disablePagebook();
				}
			};

			if (spreadToggle) {
				const savedSpread = localStorage.getItem(spreadStorageKey) === 'on';
				applySpreadState(savedSpread);
				spreadToggle.addEventListener('click', () => {
					const nextState = !pagebookState.enabled;
					localStorage.setItem(spreadStorageKey, nextState ? 'on' : 'off');
					applySpreadState(nextState);
				});
			}

			document.addEventListener('keydown', (event) => {
				if (!pagebookState.enabled || !pagebookState.setPage) {
					return;
				}
				const target = event.target;
				if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) {
					return;
				}
				if (event.key === 'ArrowRight' || event.key === 'PageDown') {
					event.preventDefault();
					pagebookState.setPage(pagebookState.currentIndex + (pagebookState.spread ? 2 : 1));
				}
				if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
					event.preventDefault();
					pagebookState.setPage(pagebookState.currentIndex - (pagebookState.spread ? 2 : 1));
				}
			});

			window.addEventListener('resize', () => {
				const next = getViewportSize();
				if (next.width === lastViewportSize.width && next.height === lastViewportSize.height) {
					return;
				}
				lastViewportSize = next;
				refreshPagebook();
			});
		})();
	</script>
</body>
</html>`;
	}

		async loadSettings() {
		const raw = await this.loadData();
		this.settings = this.normalizeSettings(raw);
	}

	async saveSettings(triggerServerReload: boolean = false, triggerWhitelistUpdate: boolean = false) {
        // 設定オブジェクト自体は参照渡しなので、直接変更されている
        // 変更をファイルに保存
		await this.saveData(this.settings);
		this.indexCache.clear();

        // サーバー設定の変更があった場合は、すべてのサーバーを再起動
		if (triggerServerReload) {
            this.log('info', 'Server settings changed, restarting all servers...');
            await this.startAllServers();
        } else if (triggerWhitelistUpdate) {
            // ホワイトリストはリロード不要なので何もしない (handleRequestが常に最新設定を読む)
             this.log('info', 'Whitelist settings updated.');
        } else {
             this.log('info', 'Settings updated (no server restart needed).');
        }

		this.notifySettingsChanged();
	}
}

class LogModal extends Modal {
	logs: { timestamp: Date, type: 'log' | 'warn' | 'error', message: string }[];

	constructor(app: App, logs: { timestamp: Date, type: 'log' | 'warn' | 'error', message: string }[]) {
		super(app);
		this.logs = [...logs].reverse();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('local-server-log-modal');

		contentEl.createEl('h2', { text: 'Local Server Logs' });

		const controlsEl = contentEl.createDiv('local-server-log-controls');
		controlsEl.createEl('button', { text: 'Close' }).onclick = () => {
			this.close();
		};

		const logContainer = contentEl.createDiv('local-server-log-container');
		if (this.logs.length === 0) {
			logContainer.createEl('p', { text: 'No logs yet.' });
		} else {
			this.logs.forEach(log => {
				const logEntry = logContainer.createDiv({ cls: `log-entry log-${log.type}` });
                // *** Error 6-7: Assuming the syntax below is correct, no changes made here.
                // If error persists, try simpler format: log.timestamp.toLocaleTimeString()
				logEntry.createSpan({ cls: 'log-timestamp', text: log.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) });
                // *** End of Error 6-7 consideration ***
                const messageSpan = logEntry.createSpan({ cls: 'log-message' });
                // HTML をそのまま挿入せず、文字列として表示する
                messageSpan.textContent = log.message;
			});
		}

        const style = contentEl.createEl('style');
        style.textContent = `
            .local-server-log-modal .modal-content { max-width: 80vw; width: 800px; max-height: 80vh; display: flex; flex-direction: column; }
            .local-server-log-modal h2 { margin-bottom: 0.5em; }
            .local-server-log-controls { margin-bottom: 1em; flex-shrink: 0; }
            .local-server-log-container { flex-grow: 1; overflow-y: auto; border: 1px solid var(--background-modifier-border); padding: 0.5em 1em; font-family: var(--font-monospace); font-size: var(--font-ui-small); line-height: 1.4; background-color: var(--background-secondary); }
            .log-entry { margin-bottom: 0.3em; display: flex; gap: 0.7em; }
            .log-timestamp { color: var(--text-muted); min-width: 65px; user-select: none; }
            .log-message { word-break: break-word; white-space: pre-wrap; }
            .log-warn .log-message { color: var(--text-warning); }
            .log-error .log-message { color: var(--text-error); font-weight: bold; }
        `;
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class LocalServerSettingTab extends PluginSettingTab {
	plugin: LocalServerPlugin;

	constructor(app: App, plugin: LocalServerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private getVaultBasePath(): string | null {
		const adapter = this.app.vault.adapter;
		if (adapter && typeof (adapter as any).getBasePath === 'function') {
			try {
				return fs.realpathSync((adapter as any).getBasePath());
			} catch {
				return null;
			}
		}
		return null;
	}

	private getVaultRelativePath(absolutePath: string): string | null {
		const basePath = this.getVaultBasePath();
		if (!basePath) {
			return null;
		}
		try {
			const realPath = fs.realpathSync(absolutePath);
			if (!this.plugin.isPathInside(basePath, realPath)) {
				return null;
			}
			const relative = path.relative(basePath, realPath);
			return relative.split(path.sep).join(path.posix.sep);
		} catch {
			return null;
		}
	}

	private getResourceUrl(absolutePath: string): string | null {
		const vaultPath = this.getVaultRelativePath(absolutePath);
		if (!vaultPath) {
			return null;
		}
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (file instanceof TFile) {
			return this.app.vault.getResourcePath(file);
		}
		return null;
	}

	private isPreviewableImage(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase();
		return [
			'.png',
			'.jpg',
			'.jpeg',
			'.gif',
			'.webp',
			'.avif',
			'.bmp',
			'.tif',
			'.tiff',
		].includes(ext);
	}

    private async listFilesRecursive(dir: string, baseDir: string): Promise<string[]> {
		const results: string[] = [];
		const stack: string[] = [dir];

		while (stack.length > 0) {
			const currentDir = stack.pop();
			if (!currentDir) continue;

			try {
				const list = await fs.promises.readdir(currentDir, { withFileTypes: true });
				for (const dirent of list) {
					if (dirent.name.startsWith('.') || dirent.name === 'node_modules' || dirent.name === '@trash') {
						continue;
					}
					const fullPath = path.join(currentDir, dirent.name);
					if (dirent.isDirectory()) {
						stack.push(fullPath);
					} else if (dirent.isFile()) {
						results.push(path.relative(baseDir, fullPath));
					} else if (dirent.isSymbolicLink()) {
						try {
							const linkRealPath = await fs.promises.realpath(fullPath);
							if (this.plugin.isPathInside(baseDir, linkRealPath)) {
								const linkStat = await fs.promises.stat(linkRealPath);
								if (linkStat.isFile()) {
									results.push(path.relative(baseDir, fullPath));
								}
							}
						} catch (linkErr: any) {
							// 無効なリンクは無視する
						}
					}
				}
			} catch (err: any) {
				if (err.code === 'EACCES' || err.code === 'EPERM') {
					this.plugin.log('warn', `Permission denied while listing files in ${currentDir}. Skipping.`);
				} else {
					this.plugin.log('error', `Error listing files in ${currentDir}: ${err.message}`);
				}
			}
		}

		return results;
	}

    private refreshDisplay() {
        this.display();
    }


	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Local Server Settings' });

        containerEl.createEl('p', {
            text: '複数のサーバーエントリを設定し、それぞれ異なるフォルダを公開できます。',
            cls: 'setting-item-description'
        });

        containerEl.createEl('h3', { text: 'Server Entries' });

        const entryListEl = containerEl.createDiv();

        if (this.plugin.settings.serverEntries.length === 0) {
            entryListEl.createEl('p', { text: 'サーバーエントリがありません。新しいエントリを追加してください。', cls: 'setting-item-description' });
        }

        this.plugin.settings.serverEntries.forEach((entry, index) => {
            const entryEl = entryListEl.createDiv({ cls: 'local-server-entry' });
            entryEl.style.border = '1px solid var(--background-modifier-border)';
            entryEl.style.padding = '15px';
            entryEl.style.marginBottom = '15px';
            entryEl.style.borderRadius = 'var(--size-2-2)';

            const entryHeader = new Setting(entryEl)
                .setName(`Server #${index + 1}: ${entry.name || 'Unnamed'}`)
                .setHeading()
                .addExtraButton(button => {
                    button.setIcon('trash');
                    button.setTooltip('Remove this server entry');
                    button.onClick(async () => {
                        if (confirm(`サーバーエントリ "${entry.name || 'Unnamed'}" を削除してもよろしいですか？`)) {
                             this.plugin.settingTabFileList.delete(entry.id);
                             this.plugin.settingTabFileListLoading.delete(entry.id);
                             this.plugin.settings.serverEntries.splice(index, 1);
                             await this.plugin.saveSettings(true);
                             this.refreshDisplay();
                        }
                    });
                });
             entryHeader.settingEl.style.borderBottom = '1px solid var(--background-modifier-border)';
             entryHeader.settingEl.style.marginBottom = '15px';

             // 表示中のエントリのステータスを表示
             const serverInfo = this.plugin.runningServers.get(entry.id);
             if (serverInfo) {
                  const statusEl = entryHeader.settingEl.createDiv({ cls: 'local-server-status' });
                   statusEl.style.marginRight = '1em';
                   statusEl.style.fontWeight = 'normal';
                   statusEl.style.color = serverInfo.status === 'running' ? 'var(--color-success)' : 'var(--color-warning)'; // Obsidian colors
                   statusEl.textContent = `Status: ${serverInfo.status}`;
                   if (serverInfo.errorMessage) {
                        statusEl.createSpan({ text: ` (Error: ${serverInfo.errorMessage})`, cls: 'local-server-error-message' }).style.color = 'var(--color-error)';
                   } else if (serverInfo.status === 'running') {
                        const protocol = serverInfo.entry.enableHttps ? 'https' : 'http';
                        statusEl.createEl('a', { text: ` (${protocol}://${serverInfo.entry.host}:${serverInfo.entry.port})`, href: `${protocol}://${serverInfo.entry.host}:${serverInfo.entry.port}` }).style.color = 'var(--text-muted)';
                   }
             }


             new Setting(entryEl)
                .setName('Entry Name')
                .setDesc('このサーバーエントリの識別名（設定画面表示用）')
                .addText(text =>
                    text
                        .setPlaceholder('e.g., My Notes Server')
                        .setValue(entry.name)
                        .onChange(async (value: string) => {
                            entry.name = value.trim();
                            await this.plugin.saveSettings(false);
                            entryHeader.setName(`Server #${index + 1}: ${entry.name || 'Unnamed'}`);
                        })
                );


            new Setting(entryEl)
                .setName('Host')
                .setDesc('サーバーがリッスンするホスト名。通常は 127.0.0.1 (ローカルのみ) または 0.0.0.0 (LAN内など) を推奨します。')
                .addText(text =>
                    text
                        .setPlaceholder('127.0.0.1')
                        .setValue(entry.host)
                        .onChange(async (value: string) => {
                            const newHost = value.trim() || DEFAULT_SERVER_ENTRY.host;
                            if (entry.host !== newHost) {
                                if (newHost !== '127.0.0.1' && newHost !== 'localhost' && newHost !== '0.0.0.0') {
                                    this.plugin.log('warn', `Entry "${entry.name}": ホストが ${newHost} に設定されています。セキュリティ上、127.0.0.1, localhost, または 0.0.0.0 の使用を推奨します。`, entry.name);
                                    new Notice(`Server "${entry.name}": ホスト設定に注意`, 5000);
                                }
                                entry.host = newHost;
                                await this.plugin.saveSettings(true);
                            }
                        })
                );

            new Setting(entryEl)
                .setName('Port')
                .setDesc('サーバーがリッスンするポート番号。')
                .addText(text =>
                    text
                        .setPlaceholder('3000')
                        .setValue(entry.port.toString())
                        .onChange(async (value: string) => {
                            const port = parseInt(value, 10);
                            if (!isNaN(port) && port > 0 && port <= 65535) {
                                if (entry.port !== port) {
                                    entry.port = port;
                                    await this.plugin.saveSettings(true);
                                }
                            } else {
                                new Notice('無効なポート番号です。1から65535の間の数値を入力してください。');
                                text.setValue(entry.port.toString());
                            }
                        })
                );

            new Setting(entryEl)
                .setName('Serve Folder')
                .setDesc('公開するフォルダのパス。Vaultルートからの相対パスまたは絶対パス。')
                .addText(text => {
                    text.setPlaceholder('e.g., public_html or /path/to/folder')
                        .setValue(entry.serveDir)
                        .onChange(async (value: string) => {
                            const newDir = value.trim();
                            if (entry.serveDir !== newDir) {
                                entry.serveDir = newDir;
                                this.plugin.settingTabFileList.delete(entry.id);
                                this.plugin.settingTabFileListLoading.delete(entry.id);
                                await this.plugin.saveSettings(true);
                                this.refreshDisplay();
                            }
                        });
                    text.inputEl.style.width = '300px';
                });

		    entryEl.createEl('h4', { text: 'Security Settings (per entry)' });

            new Setting(entryEl)
                .setName('Enable HTTPS')
                .setDesc('このエントリでHTTPSを有効にします。証明書/秘密鍵パスを指定してください。')
                .addToggle(toggle =>
                    toggle
                        .setValue(entry.enableHttps)
                        .onChange(async (value: boolean) => {
                            if (entry.enableHttps !== value) {
                                entry.enableHttps = value;
                                await this.plugin.saveSettings(true);
                                this.refreshDisplay();
                            }
                        })
                );

            if (entry.enableHttps) {
                new Setting(entryEl)
                    .setName('SSL Certificate File')
                    .setDesc('SSL証明書ファイル (.pem, .crt) の絶対パス。')
                    .addText(text =>
                        text
                            .setPlaceholder('/path/to/your/certificate.pem')
                            .setValue(entry.sslCertPath)
                            .onChange(async (value: string) => {
                                const newPath = value.trim();
                                if (entry.sslCertPath !== newPath) {
                                    entry.sslCertPath = newPath;
                                    await this.plugin.saveSettings(true);
                                }
                            })
                    );

                new Setting(entryEl)
                    .setName('SSL Key File')
                    .setDesc('SSL秘密鍵ファイル (.key, .pem) の絶対パス。')
                    .addText(text =>
                        text
                            .setPlaceholder('/path/to/your/private.key')
                            .setValue(entry.sslKeyPath)
                            .onChange(async (value: string) => {
                                const newPath = value.trim();
                                if (entry.sslKeyPath !== newPath) {
                                    entry.sslKeyPath = newPath;
                                    await this.plugin.saveSettings(true);
                                }
						})
                );
            }

            new Setting(entryEl)
                .setName('Authentication Token')
                .setDesc('オプション: このエントリへのアクセスにBearerトークン認証を要求します。空欄の場合は認証なし。')
                .addText((text: TextComponent) => {
                    text
                        .setPlaceholder('Optional: your-secure-token')
                        .setValue(entry.authToken)
                        .onChange(async (value: string) => {
                            if (entry.authToken !== value.trim()) {
                                entry.authToken = value.trim();
                                await this.plugin.saveSettings(false);
                            }
                        });
                    text.inputEl.type = 'password';
                });

            new Setting(entryEl)
                .setName('Allow localhost access without token')
                .setDesc('ローカルホスト（127.0.0.1）からのアクセスのみトークン認証をスキップします。他の環境からはトークン必須です。セキュリティ上、信頼できる環境でのみ使用してください。')
                .addToggle(toggle =>
                    toggle
                        .setValue(entry.allowLocalhostNoToken)
                        .onChange(async (value: boolean) => {
                            if (entry.allowLocalhostNoToken !== value) {
                                entry.allowLocalhostNoToken = value;
                                await this.plugin.saveSettings(false);
                            }
                        })
                );


            entryEl.createEl('h4', { text: 'Whitelist Settings (per entry)' });

            new Setting(entryEl)
                .setName('Enable Whitelist')
                .setDesc('有効にすると、公開フォルダ内のファイルのうち、以下で選択されたファイルのみアクセス可能になります。')
                .addToggle(toggle =>
                    toggle
                        .setValue(entry.enableWhitelist)
                        .onChange(async (value: boolean) => {
                            if (entry.enableWhitelist !== value) {
                                entry.enableWhitelist = value;
                                await this.plugin.saveSettings(false, true);
                                this.refreshDisplay();
                            }
                        })
                );

            const entryServedPath = this.plugin.resolveServedPath(entry);

            if (entry.enableWhitelist && entryServedPath) {
                const whitelistDesc = entryEl.createEl('p', { cls: 'setting-item-description' });
                whitelistDesc.innerHTML = `公開フォルダ "${escapeHtml(entry.serveDir)}" (解決パス: <code>${escapeHtml(entryServedPath)}</code>) 内のファイルを選択します。チェックされたファイルのみアクセスが許可されます。`;
                whitelistDesc.style.marginBottom = '1em';

                const hasCache = this.plugin.settingTabFileList.has(entry.id);
                const cachedFiles = this.plugin.settingTabFileList.get(entry.id) ?? [];

                if (!hasCache) {
                    entryEl.createEl('p', { text: 'ファイル一覧を読み込み中...', cls: 'setting-item-description' });
                    if (!this.plugin.settingTabFileListLoading.has(entry.id)) {
                        this.plugin.settingTabFileListLoading.add(entry.id);
                        void this.listFilesRecursive(entryServedPath, entryServedPath).then((files) => {
                            files.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                            this.plugin.settingTabFileList.set(entry.id, files);
                            this.plugin.settingTabFileListLoading.delete(entry.id);
                            this.refreshDisplay();
                        }).catch((err: any) => {
                            this.plugin.log('error', `Failed to list files for whitelist: ${err?.message ?? err}`);
                            this.plugin.settingTabFileListLoading.delete(entry.id);
                            this.plugin.settingTabFileList.set(entry.id, []);
                            this.refreshDisplay();
                        });
                    }
                    return;
                }

                if (cachedFiles.length === 0) {
                    entryEl.createEl('p', { text: '指定されたディレクトリにファイルが見つかりません (隠しファイルやアクセス不能ファイルを除く)。', cls: 'setting-item-description' });
                } else {
                    const fileListContainer = entryEl.createDiv({cls: 'whitelist-file-list'});
                    fileListContainer.style.maxHeight = '40vh';
                    fileListContainer.style.overflowY = 'auto';
                    fileListContainer.style.border = '1px solid var(--background-modifier-border)';
                    fileListContainer.style.padding = '10px';
                    fileListContainer.style.marginBottom = '1em';
                    fileListContainer.style.marginLeft = 'var(--size-4-8)';

                    cachedFiles.forEach((file) => {
                        const fileSetting = new Setting(fileListContainer)
                            .setName(file)
                            .addToggle(toggle =>
                                toggle
                                    .setValue(entry.whitelistFiles.includes(file))
                                    .onChange(async (value: boolean) => {
                                        const currentWhitelist = new Set(entry.whitelistFiles);
                                        let changed = false;
                                        if (value) {
                                            if (!currentWhitelist.has(file)) {
                                                currentWhitelist.add(file);
                                                changed = true;
                                            }
                                        } else {
                                            if (currentWhitelist.has(file)) {
                                                currentWhitelist.delete(file);
                                                changed = true;
                                            }
                                        }
                                        if (changed) {
                                            entry.whitelistFiles = Array.from(currentWhitelist);
                                            await this.plugin.saveSettings(false, true);
                                        }
                                    })
                            );
                        fileSetting.settingEl.addClass('whitelist-file-item');

                        const infoEl = fileSetting.settingEl.querySelector('.setting-item-info');
                        const nameEl = fileSetting.settingEl.querySelector('.setting-item-name');
                        if (infoEl && nameEl) {
                            const rowEl = document.createElement('div');
                            rowEl.className = 'whitelist-file-row';
                            nameEl.remove();
                            if (this.isPreviewableImage(file)) {
                                const imageEl = document.createElement('img');
                                imageEl.className = 'whitelist-file-preview';
                                imageEl.loading = 'lazy';
                                imageEl.alt = file;
                                const absolutePath = path.join(entryServedPath, file);
                                const resourceUrl = this.getResourceUrl(absolutePath);
                                if (resourceUrl) {
                                    imageEl.src = resourceUrl;
                                    rowEl.appendChild(imageEl);
                                }
                            }
                            rowEl.appendChild(nameEl);
                            infoEl.appendChild(rowEl);
                        }
                    });
                }
            } else if (entry.enableWhitelist && !entryServedPath) {
                 entryEl.createEl('p', { text: 'ホワイトリストを表示するには、有効な Serve Folder パスを設定してください。', cls: 'setting-item-description mod-warning' });
            }

        });

        new Setting(containerEl)
            .addButton(button => {
                button.setButtonText('Add New Server Entry');
                button.setCta();
                button.onClick(async () => {
                    // @ts-ignore // uuidv4 が undefined の可能性を無視
                    const newId = typeof uuidv4 !== 'undefined' ? uuidv4() : `temp-${Date.now()}-${Math.random()}`;
                    const newEntry: ServerEntrySettings = {
                        ...DEFAULT_SERVER_ENTRY,
                        id: newId,
                        name: `New Server ${this.plugin.settings.serverEntries.length + 1}`,
                        port: DEFAULT_SERVER_ENTRY.port + this.plugin.settings.serverEntries.length, // ポートをずらす (重複チェックはしない)
                    };
                    this.plugin.settings.serverEntries.push(newEntry);
                    await this.plugin.saveSettings(false);
                    this.refreshDisplay();
                });
            });


        function escapeHtml(unsafe: string): string {
             if (!unsafe) return '';
             return unsafe
                 .replace(/&/g, "&amp;")
                 .replace(/</g, "&lt;")
                 .replace(/>/g, "&gt;")
                 .replace(/"/g, "&quot;")
                 .replace(/'/g, "&#39;");
         }

		// 設定タブの破棄フックは環境差が大きいので、ここでは登録しない
	}
}
