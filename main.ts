// Path: main.ts
// Role: Obsidian 内でローカルファイル配信サーバーを管理するプラグイン本体
// Why: Vault 内のファイルを安全に配信し、設定 UI とログ表示を提供するため
// Related: manifest.json, README.md, styles.css, main.js
import { App, Plugin, PluginSettingTab, Setting, Modal, Notice, DataAdapter, FileSystemAdapter, TextComponent, TFile } from 'obsidian';
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

                 this.handleRequest(req, res, serverInfo.entry, serverInfo.servedRealPath);
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


	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse, entry: ServerEntrySettings, servedRealPath: string) {
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

			let pathname: string;
			try {
				const parsedUrl = new URL(req.url, baseUrl);
				pathname = decodeURIComponent(parsedUrl.pathname);
			} catch (e) {
				statusCode = 400;
				this.sendResponse(res, statusCode, 'Bad Request: Invalid URL encoding.', startTime, entry.name, req.method, req.url);
				return;
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
					new URL(req.url, baseUrl).searchParams,
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
						if (enforceVaultFiles && vaultBasePath && !this.isVaultFile(vaultBasePath, resolvedPath)) {
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
